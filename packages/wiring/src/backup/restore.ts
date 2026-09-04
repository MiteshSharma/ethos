// Restore an archive into `~/.ethos/` (plan D4).
//
// Six gates, in order, and none of them is advisory:
//
//   1. `verifyArchive()` — a full streaming pre-pass that hashes every entry
//      against the manifest. A truncated, corrupt or tampered archive is
//      refused before a single byte is written anywhere. The manifest is the
//      LAST entry (D3), so nothing in an archive can be judged until the whole
//      of it has been read: that is why this is a pass of its own.
//   2. Manifest version — an archive from a newer Ethos is refused as
//      `IMPORT_NEWER_SCHEMA` rather than half-understood (D8).
//   3. Destination containment — every path this writes to, moves, or moves
//      onto is resolved and walked segment by segment, and refused if it lands
//      outside `dataDir`. The archive's own entry names are already guarded
//      (`assertSafeEntryPath`), but a symlink planted at `<dataDir>/skills`
//      makes a perfectly valid entry name write outside the data directory,
//      and that is a fact about this machine that no archive check can see.
//   4. The in-use lock — for every database about to be replaced, an EXCLUSIVE
//      lock is taken on the LIVE file and HELD until the last file has been
//      installed. A health stamp or a pid file would be a heuristic; this is
//      the actual thing that makes overwriting unsafe, and SQLite answers it
//      exactly. What it buys is narrower than it looks, and `lockDatabase`
//      says so in full: the lock belongs to the INODE, `renameSync` hands that
//      inode to `.pre-restore/`, and the staged replacement that takes its
//      name is a new inode nothing holds. So the gate stops a restore from
//      STARTING over a live database, and stops anything reopening the copy it
//      moved aside; it does not keep the restored database to itself.
//      Databases are therefore installed LAST (see `install`), which is the
//      most this package can do about that window on its own. A DRY RUN does
//      not take these locks: they are writes — they checkpoint the WAL and add
//      or remove sidecars — and a dry run changes nothing. The report says so
//      in `inUseCheck` rather than leaving `lockedDatabases: []` to be read as
//      a check that passed.
//   5. Staging — entries are extracted into a `<unique>-staging/` tree beside
//      the displacement directory first, and every staged entry is hashed AS
//      IT LANDS and checked against its manifest record from gate 1. Gate 1
//      verifies an archive; this verifies the bytes that actually get
//      installed, which are read in a second pass and are not necessarily the
//      same file any more. Nothing live is touched until every byte is on disk
//      and every hash matches. The two entries read into MEMORY instead of
//      installed — the secrets manifest and each personality's `config.yaml` —
//      are held to the same manifest record before their text is used for
//      anything, dry run included; they are consumed (as operator instructions
//      and as `fs_reach` warnings) whether or not any scope selected them.
//   6. Displacement — anything about to be replaced moves to
//      `.pre-restore/<timestamp>-<unique>/` first, and if the install phase
//      fails part-way it is moved back. Nothing is overwritten in place. The
//      directory is created with `mkdtempSync`, not named from the clock: a
//      second-resolution timestamp collides between two restores in the same
//      second, and the second one would rename its recovery copies over the
//      first one's — destroying exactly the state a rollback needs.
//      Every one of those renames is written to a `journal.jsonl` inside that
//      same directory and `fsync`ed BEFORE it happens, because a thrown error
//      is not the only way an install stops: `SIGKILL`, the OOM killer or a
//      power cut take the in-memory undo lists with them, and without a record
//      on disk the live tree is left holding an arbitrary mixture of old and
//      restored files that nothing can tell apart afterwards. See
//      `openJournal` and `recoverFromJournal`.
//
// For the duration, a `.restore-in-progress` sentinel sits in the data
// directory (exclusive `wx` create, stale after an hour, removed on the way
// out). A restore that finds a STALE sentinel rolls the dead restore back from
// its journal before taking over — see `claimRestore`. Nothing else consumes
// the sentinel yet: every Ethos entry point lives in `apps/`, outside this
// package, so a running agent is not refused by it today. It is the seam those
// entry points get wired into.
//
// Every entry is re-classified through `scopes.ts` on the way IN, not just on
// the way out. An archive that carries `secrets/`, `keys.json` or a `..` path
// is data written by someone else; the scope table refuses it here for the
// same reason it excluded it there.
//
// This is library code: the report is a returned value. Nothing prints.
//
// Raw `node:fs` here is the documented Storage carve-out (AGENTS.md).

import { createHash } from 'node:crypto';
import {
  closeSync,
  createWriteStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Database from '@ethosagent/sqlite';
import { EthosError } from '@ethosagent/types';
import { MANIFEST_PATH, MANIFEST_VERSION, verifyArchive } from './manifest';
import { ALL_SCOPES, classifyPath, isDatabasePath, type ScopeName } from './scopes';
import { SECRETS_MANIFEST_PATH } from './secrets-manifest';
import { readTarGz, type TarFileRecord } from './tar';

/** Sidecars that must travel with a database file, or the restore corrupts it. */
const DB_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

/**
 * The two entries restore reads into memory — a secrets manifest and a
 * personality's `config.yaml` — are metadata about a machine, not payloads.
 * Anything larger under those names is not one, and buffering it would be the
 * one unbounded allocation on an otherwise streaming path. Same precedent as
 * `MANIFEST_MAX_BYTES` in `manifest.ts`.
 */
const CAPTURED_MAX_BYTES = 1024 * 1024;

/** Bound on symlink hops followed while validating a single destination. */
const MAX_SYMLINK_HOPS = 32;

/** Where displaced files and the staging tree live, `dataDir`-relative. */
const PRE_RESTORE_DIR = '.pre-restore';

/** The restore-in-progress sentinel, `dataDir`-relative. */
const RESTORE_SENTINEL = '.restore-in-progress';

/** The install phase's write-ahead journal, inside its displacement directory. */
const JOURNAL_NAME = 'journal.jsonl';

/**
 * A sentinel older than this was left by a restore that died: nothing that
 * only renames staged files runs for an hour, and the alternative to a stale
 * rule is a crashed restore locking the data directory forever.
 */
const SENTINEL_STALE_MS = 60 * 60 * 1000;

export interface RestoreOptions {
  /** `~/.ethos` (or an `ETHOS_STATE_DIR` override). */
  dataDir: string;
  archivePath: string;
  /** Restrict the restore to these scopes. Defaults to whatever the archive holds. */
  scopes?: readonly ScopeName[];
  /**
   * Report what would happen and change nothing — including gate 4, which
   * takes WRITABLE SQLite locks and so cannot run here (see `inUseCheck`).
   */
  dryRun?: boolean;
  /** Skip the in-use lock gate. The operator asserts nothing is running. */
  force?: boolean;
}

export type RestoreWarningKind = 'fs_reach_absolute' | 'skipped_path' | 'unclassified_database';

/**
 * Whether gate 4 ran, and if not, why. A report has to say this outright:
 * `lockedDatabases: []` on its own reads as "the check ran and found nothing
 * open", which is a different fact from "no check was made".
 *
 * - `held`            — the gate ran; `lockedDatabases` names what it holds.
 * - `skipped_dry_run` — a dry run makes no promises about what is running,
 *   because the only way to ask is to open every database READ-WRITE, set
 *   `locking_mode = EXCLUSIVE` and run a write transaction. That checkpoints
 *   the WAL and adds or removes `-wal`/`-shm` sidecars: a dry run that did it
 *   would change the very files it claims not to touch. There is no read-only
 *   equivalent — opening a WAL database read-only needs the `-shm` index and
 *   creates it when it is absent, which is the same mutation with a smaller
 *   blast radius, and it still cannot see an idle reader. So the check is not
 *   made, and the real restore makes it.
 * - `skipped_force`   — the operator passed `force` and took responsibility.
 */
export type RestoreInUseCheck = 'held' | 'skipped_dry_run' | 'skipped_force';

export interface RestoreWarning {
  kind: RestoreWarningKind;
  /** Archive-relative path the warning is about. */
  path: string;
  message: string;
}

export interface RestoreReport {
  dryRun: boolean;
  /** Scopes actually applied. */
  scopes: ScopeName[];
  /** When the archive was created. */
  createdAt: string;
  /** `dataDir`-relative paths written (or, in a dry run, that would be). */
  restored: string[];
  /** Archive entries left alone because their scope was not requested. */
  skipped: string[];
  /** Existing files moved out of the way, `dataDir`-relative. */
  displaced: string[];
  /** `.pre-restore/<timestamp>` under `dataDir`. Absent when nothing moved. */
  displacedTo?: string;
  /** Whether the in-use gate ran at all, and why not when it did not. */
  inUseCheck: RestoreInUseCheck;
  /**
   * Live databases the lock gate is holding. Meaningful only when
   * `inUseCheck === 'held'`; empty otherwise, and empty there means the check
   * was never made, not that nothing was running.
   */
  lockedDatabases: string[];
  /**
   * `config.yaml` and `mcp.json` are read at boot. True when an identity file
   * was restored — the caller decides how to say so.
   */
  restartRequired: boolean;
  warnings: RestoreWarning[];
  /** The archive's `secrets.manifest.yaml`, if it carries one. Never written to disk. */
  secretsManifest?: string;
}

// ---------------------------------------------------------------------------
// Destination containment (gate 3)
// ---------------------------------------------------------------------------

function containmentError(rel: string, detail: string): EthosError {
  return new EthosError({
    code: 'IMPORT_BLOCKED',
    cause: `Refusing to touch "${rel}": it ${detail} the Ethos data directory`,
    action:
      'Check the Ethos data directory for symbolic links pointing outside it, or restore into a clean directory.',
    details: { path: rel },
  });
}

function isBeneath(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

/**
 * The refusal for a destination this cannot judge at all. `containmentError`
 * says a path leaves the data directory; this one says the question could not
 * be answered — an unreadable intermediate directory, a segment that is not a
 * directory — and refuses on that. The distinction is worth two error builders:
 * the operator fixes a permission, not a symbolic link.
 */
function uncheckableError(rel: string, err: unknown): EthosError {
  const detail = err instanceof Error ? err.message : String(err);
  return new EthosError({
    code: 'IMPORT_BLOCKED',
    cause: `Refusing to touch "${rel}": it could not be checked against the Ethos data directory (${detail})`,
    action:
      'Fix what stopped the check — usually a directory the current user cannot read — and run the restore again.',
    details: { path: rel, error: detail },
  });
}

/**
 * Walk `target` one segment at a time below `root`, `lstat`ing each. Returns
 * the path rewritten through the FIRST symbolic link found (that link's target
 * plus the remaining segments), or null when the walk crosses no link.
 *
 * Per-segment, not leaf-only: a symlinked PARENT escapes the data directory
 * behind a perfectly ordinary leaf, and that is the case a resolved-prefix test
 * on its own cannot see. A missing segment is not a link — `lstat` finding
 * nothing is the normal case for a file this restore has not written yet, and
 * nothing can live below a segment that is absent, so the walk stops. Only the
 * portion BELOW `root` is walked: segments above it are the operator's own
 * layout (`/var` → `/private/var` on macOS), not an escape.
 *
 * `ENOENT` — and only `ENOENT` — ends the walk: that is what
 * `throwIfNoEntry: false` reports as `undefined`. EVERY other errno propagates,
 * `ENOTDIR` included, and `containedPath` turns it into a refusal. A boundary
 * check that reads "I could not look" as "nothing to see" is fail-open: an
 * unreadable intermediate directory (`EACCES`) would otherwise be judged
 * contained. `ENOTDIR` could be argued to end the walk — nothing hides below a
 * non-directory — but the two siblings throw on it, and a third copy that
 * diverges on one errno is exactly what the must-change-together rule exists to
 * prevent.
 *
 * Deliberate mirror of `followFirstSymlink` in
 * `packages/core/src/scoped/scoped-fs.ts` and
 * `packages/storage-fs/src/scoped-storage.ts` — the same guarantee at a third
 * boundary. `packages/wiring` may not import either at runtime, and the two
 * that exist are already duplicated on purpose for that reason.
 */
function followFirstSymlink(root: string, target: string): string | null {
  const rel = relative(root, target);
  if (rel === '') return null;

  const segments = rel.split(sep);
  let cursor = root;
  for (let i = 0; i < segments.length; i++) {
    cursor = join(cursor, segments[i] ?? '');
    const stat = lstatSync(cursor, { throwIfNoEntry: false });
    if (stat === undefined) return null;
    if (!stat.isSymbolicLink()) continue;
    const linkTarget = resolve(dirname(cursor), readlinkSync(cursor));
    return resolve(join(linkTarget, ...segments.slice(i + 1)));
  }
  return null;
}

/**
 * The absolute path of `rel` under `root`, refused unless it really stays
 * inside it. Lexical containment first (a `..` that survived the archive
 * guard), then symbolic containment on the segments that exist.
 *
 * Like the boundaries it mirrors, this closes MISDIRECTION, not TOCTOU: a path
 * swapped between this walk and the write that follows still wins.
 *
 * A walk that cannot complete is a refusal, not a pass — and the callers are
 * restore gates whose failures an operator reads, so the raw errno is wrapped
 * in an `EthosError` naming the path rather than thrown as a stack.
 */
function containedPath(root: string, rel: string): string {
  const target = resolve(root, rel);
  if (!isBeneath(root, target)) throw containmentError(rel, 'resolves outside');

  let current = target;
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
    let next: string | null;
    try {
      next = followFirstSymlink(root, current);
    } catch (err) {
      throw uncheckableError(rel, err);
    }
    if (next === null) return target;
    if (!isBeneath(root, next)) {
      throw containmentError(rel, 'leaves, through a symbolic link,');
    }
    current = next;
  }
  throw containmentError(rel, 'follows too many symbolic links to place inside');
}

// ---------------------------------------------------------------------------
// The lock gate (gate 4, plan D4)
// ---------------------------------------------------------------------------

/**
 * Take an exclusive lock on a live database, or refuse.
 *
 * `locking_mode = EXCLUSIVE` followed by a write transaction is the check that
 * actually works in WAL mode: a plain `BEGIN IMMEDIATE` only conflicts with
 * another WRITER, whereas an idle reader — `ethos chat` sitting at a prompt
 * with `sessions.db` open — is exactly the process this must catch. Under
 * exclusive locking SQLite needs sole ownership of the WAL index, which any
 * open connection denies it.
 *
 * The returned connection is the LOCK, not a probe: under `locking_mode =
 * EXCLUSIVE` SQLite holds the file lock until the connection closes, and
 * `restoreBackup` closes every one of them only after the last file has been
 * displaced and installed. Probing and closing would leave a window between
 * the check and the move — one that widens with every further database checked
 * — in which the process this gate exists to catch could open the file.
 *
 * What the hold does NOT cover is the restored database. A lock belongs to the
 * open file — the inode — and `renameSync` moves that inode, lock and all,
 * into `.pre-restore/`; the staged replacement that takes its pathname is a
 * different inode that nothing holds. So this connection guarantees two
 * things: no other process had the database open when the restore began, and
 * none can open the displaced copy while the restore runs. It does not
 * guarantee that the installed replacement is private until the restore
 * finishes — from the moment it lands, any process that opens that path gets
 * it. Making that guarantee needs a restore-wide lock every Ethos entry point
 * honours, and those live in `apps/`, outside this package; the
 * `.restore-in-progress` sentinel is where such a check would look, and
 * installing databases last is what keeps the window short in the meantime.
 *
 * Returns `null` when there is no such file: nothing to displace, nothing to
 * lock.
 */
function lockDatabase(dbPath: string): Database.Database | null {
  if (!existsSync(dbPath)) return null;
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath);
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.exec('BEGIN IMMEDIATE');
    db.exec('COMMIT');
    return db;
  } catch (err) {
    db?.close();
    throw new EthosError({
      code: 'IMPORT_BLOCKED',
      cause: `${basename(dbPath)} is in use by another process`,
      action:
        'Stop anything using this Ethos home (ethos chat, serve, gateway, the desktop app) and retry.',
      details: { path: dbPath, lockError: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ---------------------------------------------------------------------------
// fs_reach warnings
// ---------------------------------------------------------------------------

/**
 * A personality's `fs_reach` may name literal absolute paths — `/Users/ada/src`
 * — that mean nothing on the machine being restored onto. Reported, never
 * rewritten: silently repointing an agent's filesystem allowlist is a worse
 * failure than an allowlist that does not resolve. Tokens (`${ETHOS_HOME}`,
 * `${self}`, `${CWD}`) and `~/` already travel, so only a leading `/` warns.
 */
function fsReachWarnings(archivePath: string, configText: string): RestoreWarning[] {
  const out: RestoreWarning[] = [];
  for (const line of configText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('fs_reach.')) continue;
    const colon = trimmed.indexOf(':');
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim();
    for (const raw of trimmed.slice(colon + 1).split(',')) {
      const value = raw.trim();
      if (!value.startsWith('/')) continue;
      out.push({
        kind: 'fs_reach_absolute',
        path: archivePath,
        message: `${key} grants "${value}", an absolute path that may not exist on this machine. Left as written — check it by hand.`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The install journal
// ---------------------------------------------------------------------------

/**
 * One line of the install journal.
 *
 * `begin` names the displacement directory the journal belongs to, so a journal
 * found somewhere else is refused rather than replayed against the wrong copies.
 * `displace` and `install` are the two renames the install phase makes, each
 * written before it happens.
 */
type JournalRecord =
  | { op: 'begin'; dir: string }
  | { op: 'displace'; rel: string }
  | { op: 'install'; rel: string };

/**
 * Open the write-ahead journal for one install phase.
 *
 * `record()` returns only once the line is on the platter — one `writeSync`
 * followed by `fsyncSync` on the same descriptor — because a journal that can
 * be lost after the rename it protects is decoration. The install phase calls
 * it BEFORE each rename, never after: the cost of a record for a rename that
 * never happened is a recovery step that finds nothing to do, while the cost of
 * a rename with no record is a moved file nothing knows about.
 *
 * `wx`, so this never appends to a journal that is already there: the
 * displacement directory came from `mkdtempSync` moments earlier, and anything
 * already sitting in it means the directory is not what it is taken for.
 *
 * The fsync covers the journal's CONTENT. Its directory entry is durable on the
 * same terms as the renames it describes, which is the guarantee this whole
 * phase already runs on.
 */
function openJournal(dir: string): { record: (entry: JournalRecord) => void; close: () => void } {
  const fd = openSync(join(dir, JOURNAL_NAME), 'wx');
  return {
    record(entry: JournalRecord): void {
      writeSync(fd, `${JSON.stringify(entry)}\n`);
      fsyncSync(fd);
    },
    close(): void {
      closeSync(fd);
    },
  };
}

/**
 * Parse one journal line, or null if it is not one this wrote.
 *
 * A torn final line is expected, not exceptional: a power cut can interrupt the
 * write of the very record that was about to be fsynced, and the whole point of
 * writing the record first is that losing THAT one costs nothing. Anything
 * unparseable is dropped for the same reason.
 */
function parseJournalLine(line: string): JournalRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || !('op' in value)) return null;
  const { op } = value;
  if (op === 'begin') {
    if (!('dir' in value) || typeof value.dir !== 'string') return null;
    return { op, dir: value.dir };
  }
  if (op !== 'displace' && op !== 'install') return null;
  if (!('rel' in value) || typeof value.rel !== 'string') return null;
  return { op, rel: value.rel };
}

function unusableJournal(dirRel: string, detail: string): EthosError {
  return new EthosError({
    code: 'IMPORT_BLOCKED',
    cause: `A previous restore in this Ethos data directory died part-way, and its record of what it moved is unusable: ${detail}. This installation may be HALF-RESTORED — the files it displaced are under "${dirRel}/".`,
    action: `Move the files under "${dirRel}/" back over the data directory by hand, delete "${RESTORE_SENTINEL}" and "${join(dirRel, JOURNAL_NAME)}", then run the restore again.`,
    details: { preRestore: dirRel },
  });
}

/**
 * Roll one abandoned install back to the state the tree was in before it
 * started, using only what is on disk.
 *
 * Rolling BACK rather than forward: completing the dead restore would mean
 * installing files out of a staging tree whose per-file hashes were checked
 * against a manifest this process has not read, from an archive that may no
 * longer exist — and the restore about to run is going to install its own
 * archive over the result anyway. Rolling back needs nothing but the journal
 * and the recovery copies beside it, and it lands on the one state the operator
 * can reason about: exactly what they had.
 *
 * Records are undone newest first, and each one on the evidence rather than on
 * a progress marker, which is what makes a second crash DURING recovery
 * harmless — every step below is a no-op the second time it runs:
 *
 * - the recovery copy is still there → the displacement happened (and the
 *   install may or may not have); remove whatever holds the live name and move
 *   the copy back. Re-running finds no copy and stops.
 * - no recovery copy, and the journal shows the file was never displaced → it
 *   did not exist before this restore, so anything at that name now is the
 *   restored file and is removed. Re-running removes nothing.
 * - no recovery copy for a file that WAS displaced → either the rename never
 *   happened (the record is written first) or a previous pass already moved it
 *   back. Both mean the original is in place. Nothing to do.
 *
 * Every path goes through `containedPath`: a journal is a file on disk like any
 * other, and gate 3 does not stop applying because the paths came from one.
 */
function recoverFromJournal(root: string, dirRel: string, journalPath: string): void {
  const records: JournalRecord[] = [];
  for (const line of readFileSync(journalPath, 'utf8').split('\n')) {
    if (line === '') continue;
    const record = parseJournalLine(line);
    if (record !== null) records.push(record);
  }

  const begin = records[0];
  if (begin === undefined || begin.op !== 'begin') {
    throw unusableJournal(dirRel, 'it does not start with the record naming its own directory');
  }
  if (begin.dir !== dirRel) {
    throw unusableJournal(dirRel, `it belongs to "${begin.dir}", not to the directory holding it`);
  }

  const wasDisplaced = new Set<string>();
  for (const record of records) {
    if (record.op === 'displace') wasDisplaced.add(record.rel);
  }

  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record === undefined || record.op === 'begin') continue;
    const live = containedPath(root, record.rel);
    const copy = containedPath(root, join(dirRel, record.rel));
    if (existsSync(copy)) {
      rmSync(live, { force: true });
      renameSync(copy, live);
    } else if (record.op === 'install' && !wasDisplaced.has(record.rel)) {
      rmSync(live, { force: true });
    }
  }

  unlinkSync(journalPath);
}

/**
 * Roll back every install this data directory has a journal for.
 *
 * Called on the one path that used to make a crashed restore permanent: taking
 * over a stale sentinel. A journal is left behind only by an install that did
 * not finish, so finding one IS the evidence — no pointer from the sentinel is
 * needed, and a stale sentinel with no journal (a restore that died before the
 * install phase, which is most of them) correctly finds nothing and leaves the
 * tree alone.
 *
 * Newest directory first: the names begin with a timestamp, so they sort into
 * the order the restores ran, and undoing two crashed installs that touched the
 * same file in any other order would put back the wrong copy.
 *
 * A failure here is not something to restore on top of, so it is not swallowed:
 * `recoverFromJournal` throws, and the caller refuses to start.
 */
function recoverAbandonedRestores(root: string): void {
  const preRestoreRoot = containedPath(root, PRE_RESTORE_DIR);
  if (!existsSync(preRestoreRoot)) return;
  const names = readdirSync(preRestoreRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const name of names) {
    const dirRel = join(PRE_RESTORE_DIR, name);
    const journalPath = join(containedPath(root, dirRel), JOURNAL_NAME);
    if (!existsSync(journalPath)) continue;
    try {
      recoverFromJournal(root, dirRel, journalPath);
    } catch (err) {
      if (err instanceof EthosError) throw err;
      throw unusableJournal(dirRel, err instanceof Error ? err.message : String(err));
    }
  }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * The human-readable half of a displacement directory's name. Second
 * resolution, and deliberately NOT unique — an operator has to recognise which
 * restore a `.pre-restore/` directory came from, and uniqueness comes from the
 * atomic create that appends to this, never from the clock.
 */
function timestampName(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function restoreInProgress(path: string): EthosError {
  return new EthosError({
    code: 'IMPORT_BLOCKED',
    cause: 'Another restore is already running in this Ethos data directory',
    action: `Wait for it to finish. If nothing is running, delete "${RESTORE_SENTINEL}" in the Ethos data directory and retry.`,
    details: { path },
  });
}

/**
 * Claim the data directory for this restore and return the release.
 *
 * Exclusive create (`wx`), so two restores cannot both believe they own the
 * directory; a sentinel past `SENTINEL_STALE_MS` was left by a restore that
 * died and is taken over. The single retry covers the two ways the create can
 * lose a race it should win: the holder finished between the create and the
 * stat, or a stale sentinel was cleaned up by someone else first.
 *
 * Taking over is a ROLLBACK, not a deletion. The dead restore may have got
 * part-way through the install phase, and unlinking its sentinel and carrying
 * on would start a fresh restore on top of a tree it had already half-rewritten,
 * with its recovery copies orphaned under `.pre-restore/` and nothing left
 * pointing at them. So the journal is replayed first and the sentinel is taken
 * only once the tree is back to what the dead restore found; if that fails,
 * this refuses rather than restoring onto an unknown state.
 *
 * NOTHING ELSE READS THIS YET. Every Ethos entry point — `chat`, `serve`,
 * `gateway`, the desktop app — lives in `apps/`, which this package may not
 * reach into, so a running agent is not refused by it today. It exists so that
 * check has a file to make, and until then it stops a second restore only.
 */
function claimRestore(root: string): () => void {
  const path = join(root, RESTORE_SENTINEL);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' });
      return () => {
        try {
          unlinkSync(path);
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (stat === undefined) continue; // vanished between the create and the stat
      if (Date.now() - stat.mtimeMs <= SENTINEL_STALE_MS) throw restoreInProgress(path);
      recoverAbandonedRestores(root);
      try {
        unlinkSync(path);
      } catch {
        /* another process cleaned the stale sentinel up first */
      }
    }
  }
  throw restoreInProgress(path);
}

/** One live file moved aside, and where it went. The rollback's undo list. */
interface Displacement {
  rel: string;
  from: string;
  to: string;
}

export async function restoreBackup(opts: RestoreOptions): Promise<RestoreReport> {
  const manifest = await verifyArchive(opts.archivePath);

  if (manifest.version > MANIFEST_VERSION) {
    throw new EthosError({
      code: 'IMPORT_NEWER_SCHEMA',
      cause: `This backup uses archive format v${manifest.version}; this Ethos understands v${MANIFEST_VERSION}`,
      action: 'Upgrade Ethos to a build that understands this archive, then retry the restore.',
      details: { archivePath: opts.archivePath, createdAt: manifest.createdAt },
    });
  }

  const root = resolve(opts.dataDir);
  const requested = opts.scopes;
  const wanted = new Set<ScopeName>();
  const restored: string[] = [];
  const skipped: string[] = [];
  const warnings: RestoreWarning[] = [];
  const selected = new Set<string>();
  /** Manifest record per selected path — `selected`'s keys, with the hashes. */
  const expected = new Map<string, TarFileRecord>();
  /**
   * Manifest record per archive path, whatever the requested scopes are.
   *
   * `expected` is a SELECTION map: it answers "what gets installed", and an
   * entry no scope selected is deliberately absent from it. That is the wrong
   * question to ask about the two entries this restore reads into MEMORY. The
   * secrets manifest is archive metadata no scope ever selects, and a
   * personality's `config.yaml` is unselected whenever `identity` was not
   * requested — yet both are consumed all the same, one as operator-facing
   * `ethos secrets set` instructions in the report and one as the source of the
   * `fs_reach` warnings. Verification is a separate question from installation,
   * so it gets a separate map: every record pass 1 hashed, by path.
   */
  const recorded = new Map<string, TarFileRecord>();
  for (const record of manifest.files) recorded.set(record.path, record);
  const databases: string[] = [];

  for (const record of manifest.files) {
    if (record.path === MANIFEST_PATH) continue;
    if (record.path === SECRETS_MANIFEST_PATH) continue;

    const { scope, unclassifiedDatabase } = classifyPath(record.path);
    if (unclassifiedDatabase) {
      warnings.push({
        kind: 'unclassified_database',
        path: record.path,
        message: `No scope owns "${record.path}" — this build does not know that store. Not restored.`,
      });
    }
    if (scope === null) {
      skipped.push(record.path);
      if (!unclassifiedDatabase) {
        warnings.push({
          kind: 'skipped_path',
          path: record.path,
          message: `"${record.path}" is excluded from backups and was not restored.`,
        });
      }
      continue;
    }
    if (requested && !requested.includes(scope)) {
      skipped.push(record.path);
      continue;
    }
    wanted.add(scope);
    selected.add(record.path);
    expected.set(record.path, record);
    restored.push(record.path);
    if (isDatabasePath(record.path)) databases.push(record.path);
  }

  // Everything a successful restore replaces: each selected file, and for a
  // database its sidecars too (`install` decides the order they move in). A stale `-wal` left beside a
  // freshly restored main file is applied on the next open and corrupts it.
  const replaceable: string[] = [];
  for (const rel of selected) {
    replaceable.push(rel);
    if (!isDatabasePath(rel)) continue;
    for (const suffix of DB_SIDECAR_SUFFIXES) replaceable.push(`${rel}${suffix}`);
  }

  // A dry run creates nothing, so it has no directory to name: it reports the
  // shape the real restore would use. Every other path here is the real one,
  // made below by `mkdtempSync` once the gates have passed.
  let preRestore = join(PRE_RESTORE_DIR, timestampName());
  let stagingRel = `${preRestore}-staging`;
  let stagingRoot: string | undefined;
  const displaced: string[] = [];
  const lockedDatabases: string[] = [];
  const held: Database.Database[] = [];
  const personalityConfigs = new Map<string, string>();
  let secretsManifest: string | undefined;

  // Gate 3 — resolve every destination this restore could touch
  // before it takes a lock or writes a byte, so a containment failure refuses
  // cleanly instead of surfacing as a rolled-back install. The same check runs
  // again at each write: this one is for the honest error, that one is the
  // guard.
  for (const rel of replaceable) containedPath(root, rel);
  // The displacement root itself, before anything is created inside it: a
  // symlinked `.pre-restore` would otherwise send `mkdtempSync` out of the data
  // directory. What goes UNDER it is checked once the unique names exist.
  containedPath(root, PRE_RESTORE_DIR);

  if (!opts.dryRun) mkdirSync(root, { recursive: true });
  const releaseRestore = opts.dryRun ? () => {} : claimRestore(root);

  try {
    // Gate 4 — every live database about to be replaced must be idle, and
    // must stay idle until the last one has been moved aside. The hold does
    // not extend to the file that replaces it; `lockDatabase` says why.
    //
    // Not in a dry run: taking the lock is a WRITE (see `RestoreInUseCheck`),
    // and a dry run that mutates the databases it inspects is a worse bug than
    // a dry run that cannot tell you whether the restore would be refused.
    // The report says which of those the caller is holding.
    if (!opts.force && !opts.dryRun) {
      for (const rel of databases) {
        const db = lockDatabase(containedPath(root, rel));
        if (db === null) continue;
        held.push(db);
        lockedDatabases.push(rel);
      }
    }

    // Created only now, so a refusal at any gate above leaves no trace. The
    // atomic create is what makes the name unique; `mkdirSync` without
    // `recursive` refuses a staging directory that somehow already exists
    // rather than restoring into it.
    if (!opts.dryRun) {
      mkdirSync(join(root, PRE_RESTORE_DIR), { recursive: true });
      const dir = mkdtempSync(join(root, PRE_RESTORE_DIR, `${timestampName()}-`));
      preRestore = join(PRE_RESTORE_DIR, basename(dir));
      stagingRel = `${preRestore}-staging`;
      stagingRoot = join(root, stagingRel);
      mkdirSync(stagingRoot);
      for (const rel of replaceable) containedPath(root, join(preRestore, rel));
      for (const rel of selected) containedPath(root, join(stagingRel, rel));
    }

    // Gate 5 — extract into staging. Two entries are also read into memory:
    // the secrets manifest (returned, never written) and each personality's
    // config.yaml (scanned for fs_reach warnings). Those two are checked
    // against the manifest by `verifyCaptured` whether or not they are being
    // installed, and in a dry run too — a dry run still returns the secrets
    // manifest and still emits fs_reach warnings, so it is reporting on those
    // bytes and has to have checked them.
    const staged = new Map<string, string>();
    await readTarGz(opts.archivePath, async (entry, body) => {
      const isPersonalityConfig = /^personalities\/[^/]+\/config\.yaml$/.test(entry.path);
      const capture = entry.path === SECRETS_MANIFEST_PATH || isPersonalityConfig;
      // The manifest record this entry has to match to be INSTALLED. Undefined
      // means "not being installed": a dry run, or an entry no scope selected.
      // It is not the answer to "was this verified" — see `recorded`.
      const wanted = opts.dryRun ? undefined : expected.get(entry.path);

      if (capture) {
        if (entry.size > CAPTURED_MAX_BYTES) {
          throw new EthosError({
            code: 'IMPORT_BLOCKED',
            cause: `Backup archive is corrupt: "${entry.path}" is ${entry.size} bytes, far past the ${CAPTURED_MAX_BYTES}-byte limit for a metadata entry`,
            action: 'Restore from a different backup — this archive cannot be trusted.',
            details: { path: entry.path, size: entry.size, limit: CAPTURED_MAX_BYTES },
          });
        }
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(chunk);
        const content = Buffer.concat(chunks);
        verifyCaptured(entry.path, content, recorded.get(entry.path));
        const text = content.toString('utf8');
        if (isPersonalityConfig) personalityConfigs.set(entry.path, text);
        else secretsManifest = text;
        if (wanted !== undefined) {
          staged.set(entry.path, await stage(root, stagingRel, entry.path, [content], wanted));
        }
        return;
      }

      if (wanted === undefined) return;
      staged.set(entry.path, await stage(root, stagingRel, entry.path, body, wanted));
    });

    // An entry the manifest listed and this pass did not carry would be
    // reported as restored while the live file stayed as it was. Same cause as
    // a hash mismatch: the archive is not the one gate 1 read.
    if (!opts.dryRun) {
      for (const rel of selected) {
        if (staged.has(rel)) continue;
        throw new EthosError({
          code: 'IMPORT_BLOCKED',
          cause: `Backup archive is corrupt: "${rel}" is listed in the manifest but missing from the archive`,
          action: 'Restore from a different backup — this archive cannot be trusted.',
          details: { path: rel },
        });
      }
    }

    if (opts.dryRun) {
      for (const rel of replaceable) {
        if (existsSync(containedPath(root, rel))) displaced.push(rel);
      }
    } else {
      // Gate 6 — displace, then install, then roll back if either half fails.
      install({ root, preRestore, replaceable, selected, staged, displaced });
    }
  } finally {
    // The lock spans the whole dangerous phase and is released in one place
    // once there is no live file left to protect. It never covered the files
    // that replaced them (see `lockDatabase`).
    for (const db of held) db.close();
    if (stagingRoot !== undefined) rmSync(stagingRoot, { recursive: true, force: true });
    releaseRestore();
  }

  for (const [path, text] of personalityConfigs) {
    if (!selected.has(path)) continue;
    warnings.push(...fsReachWarnings(path, text));
  }

  restored.sort();
  skipped.sort();
  displaced.sort();

  return {
    dryRun: opts.dryRun === true,
    scopes: ALL_SCOPES.filter((s) => wanted.has(s)),
    createdAt: manifest.createdAt,
    restored,
    skipped,
    displaced,
    ...(displaced.length > 0 ? { displacedTo: preRestore } : {}),
    inUseCheck: opts.dryRun ? 'skipped_dry_run' : opts.force ? 'skipped_force' : 'held',
    lockedDatabases,
    restartRequired: wanted.has('identity'),
    warnings,
    ...(secretsManifest !== undefined ? { secretsManifest } : {}),
  };
}

/**
 * The refusal both verification sites share: the archive read in this pass is
 * not the archive gate 1 hashed.
 */
function checksumMismatch(rel: string, expected: string, actual: string): EthosError {
  return new EthosError({
    code: 'IMPORT_BLOCKED',
    cause: `Backup archive is corrupt: "${rel}" does not match its manifest checksum — the archive changed between the verification pass and the restore`,
    action: 'Restore from a different backup — this archive cannot be trusted.',
    details: { path: rel, expected, actual },
  });
}

/**
 * Hold a captured entry to the same guarantee as a staged one.
 *
 * `stage` covers the bytes that get INSTALLED. These are the bytes that get
 * READ — the secrets manifest returned in the report as `ethos secrets set`
 * commands an operator is told to run, and the `config.yaml` the `fs_reach`
 * warnings are scanned out of. They are never installed, so no scope selects
 * them and `stage` never sees them; without this they were the one path in the
 * restore where pass 2 content was used unchecked, and swapping the archive
 * between the passes wrote attacker-chosen text straight into both.
 *
 * A missing record is the same refusal, not a lesser one: an archive carrying a
 * `secrets.manifest.yaml` that pass 1 never hashed IS the swap being defended
 * against.
 *
 * The bytes are already in memory and already bounded by `CAPTURED_MAX_BYTES`,
 * so this hashes what it has rather than reading anything a second time.
 */
function verifyCaptured(rel: string, content: Buffer, wanted: TarFileRecord | undefined): void {
  if (wanted === undefined) {
    throw new EthosError({
      code: 'IMPORT_BLOCKED',
      cause: `Backup archive is corrupt: "${rel}" is in the archive but not in the manifest, so nothing verified it`,
      action: 'Restore from a different backup — this archive cannot be trusted.',
      details: { path: rel },
    });
  }
  const sha256 = createHash('sha256').update(content).digest('hex');
  if (content.length !== wanted.size || sha256 !== wanted.sha256) {
    throw checksumMismatch(rel, wanted.sha256, sha256);
  }
}

/**
 * Write one archive entry into the staging tree, hashing the bytes as they go
 * past, and refuse it unless the result is what the manifest recorded.
 *
 * This is the hash that matters. `verifyArchive` hashed the archive it read in
 * the pre-pass; these are the bytes that will be installed, read in a second
 * pass from a file that may have been swapped or edited in between — same
 * sizes, different content, and nothing downstream would notice. The digest is
 * free here: every byte is already streaming through this function.
 *
 * Returns the staged file's absolute path.
 */
async function stage(
  root: string,
  stagingRel: string,
  rel: string,
  body: AsyncIterable<Buffer> | Iterable<Buffer>,
  wanted: TarFileRecord,
): Promise<string> {
  const dest = containedPath(root, join(stagingRel, rel));
  mkdirSync(dirname(dest), { recursive: true });

  const hash = createHash('sha256');
  let size = 0;
  async function* hashed(): AsyncGenerator<Buffer> {
    for await (const chunk of body) {
      hash.update(chunk);
      size += chunk.length;
      yield chunk;
    }
  }
  await pipeline(Readable.from(hashed()), createWriteStream(dest));

  const sha256 = hash.digest('hex');
  if (size !== wanted.size || sha256 !== wanted.sha256) {
    throw checksumMismatch(rel, wanted.sha256, sha256);
  }
  return dest;
}

/** A database file or one of its sidecars — the group installed last. */
function belongsToDatabase(rel: string): boolean {
  if (isDatabasePath(rel)) return true;
  return DB_SIDECAR_SUFFIXES.some(
    (suffix) => rel.endsWith(suffix) && isDatabasePath(rel.slice(0, -suffix.length)),
  );
}

/**
 * The only phase that touches the live installation, and the shortest one:
 * every byte is already staged and checked, so this is renames. Each live file
 * moves to `.pre-restore/<ts>-<unique>/` and its staged replacement moves into
 * place; if any step fails, every rename already made is undone in reverse
 * before the failure is reported, so the installation is either fully restored
 * or exactly as it was.
 *
 * Renames, not copies: staging lives under `dataDir`, so it is the same
 * filesystem, and the peak disk cost is the same as writing the files
 * directly would have been.
 *
 * Databases go LAST, in a pass of their own. A restored database is a new
 * inode that the gate-4 lock does not cover (see `lockDatabase`), so from the
 * moment it lands another process can open it; doing every other file first
 * means the tree it would be opened beside is already complete, and the window
 * is only as long as the remaining databases take to move. It does not close
 * the window — nothing in this package can — it makes it as small as ordering
 * can make it.
 */
function install(args: {
  root: string;
  preRestore: string;
  replaceable: readonly string[];
  selected: ReadonlySet<string>;
  staged: ReadonlyMap<string, string>;
  displaced: string[];
}): void {
  const { root, preRestore, replaceable, selected, staged, displaced } = args;
  const moved: Displacement[] = [];
  const installed: string[] = [];
  const journal = openJournal(containedPath(root, preRestore));
  journal.record({ op: 'begin', dir: preRestore });

  try {
    for (const isDatabase of [false, true]) {
      for (const rel of replaceable) {
        if (belongsToDatabase(rel) !== isDatabase) continue;
        const from = containedPath(root, rel);
        if (!existsSync(from)) continue;
        const to = containedPath(root, join(preRestore, rel));
        mkdirSync(dirname(to), { recursive: true });
        journal.record({ op: 'displace', rel });
        renameSync(from, to);
        displaced.push(rel);
        moved.push({ rel, from, to });
      }

      for (const rel of selected) {
        if (belongsToDatabase(rel) !== isDatabase) continue;
        const source = staged.get(rel);
        if (source === undefined) continue;
        const dest = containedPath(root, rel);
        mkdirSync(dirname(dest), { recursive: true });
        journal.record({ op: 'install', rel });
        renameSync(source, dest);
        installed.push(dest);
      }
    }
  } catch (err) {
    const rollbackFailure = rollback(installed, moved);
    const detail = err instanceof Error ? err.message : String(err);
    displaced.length = 0;
    throw new EthosError({
      code: 'IMPORT_BLOCKED',
      cause:
        rollbackFailure === null
          ? `Restore failed while installing files (${detail}). Every file it had already moved was put back from "${preRestore}/", so this installation is exactly as it was before the restore.`
          : `Restore failed while installing files (${detail}), and rolling back failed too (${rollbackFailure}). This installation is HALF-RESTORED: what was displaced is under "${preRestore}/" in the Ethos data directory and has to be moved back by hand.`,
      action:
        rollbackFailure === null
          ? 'Fix the underlying failure (disk space, permissions) and run the restore again.'
          : `Move the files under "${preRestore}/" back over the data directory by hand, then run the restore again.`,
      details: { preRestore, rolledBack: rollbackFailure === null },
    });
  } finally {
    // The journal covers PROCESS DEATH, and nothing here is that: whether the
    // install finished or `rollback` undid it, this process reached the end of
    // the phase and has said exactly what state the tree is in. Leaving the
    // record behind would let some later takeover replay it against a tree the
    // operator has since repaired by hand, which is worse than the automatic
    // retry it would buy on a path that already asks for intervention.
    journal.close();
    rmSync(join(containedPath(root, preRestore), JOURNAL_NAME), { force: true });
  }
}

/** Undo an install, newest action first. Returns why it could not, or null. */
function rollback(installed: readonly string[], moved: readonly Displacement[]): string | null {
  try {
    for (const path of [...installed].reverse()) rmSync(path, { force: true });
    for (const entry of [...moved].reverse()) {
      if (existsSync(entry.to)) renameSync(entry.to, entry.from);
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
