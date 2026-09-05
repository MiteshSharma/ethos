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
// directory (exclusive `wx` create, taken over only when the process it names
// is gone or belongs to an earlier boot, removed on the way out). The sentinel is mutual exclusion and nothing more — it is NOT what
// triggers recovery. Every real restore replays whatever unfinished journals it
// finds before it touches the tree, however the sentinel was resolved: absent,
// taken over as stale, or deleted by an operator following the refusal's own
// advice — see `recoverAbandonedRestores`. Nothing else consumes
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
import { classifyHolder, currentBootId } from './holder-identity';
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

/**
 * What marks a `.pre-restore/` entry as a staging tree rather than a set of
 * recovery copies. One constant because `recoverAbandonedRestores` has to
 * recognise from the name alone what the restore that made it can no longer say.
 */
const STAGING_SUFFIX = '-staging';

/** The restore-in-progress sentinel, `dataDir`-relative. */
const RESTORE_SENTINEL = '.restore-in-progress';

/** The install phase's write-ahead journal, inside its displacement directory. */
const JOURNAL_NAME = 'journal.jsonl';

/**
 * The clock fallback, used only when a sentinel carries no readable pid (a
 * truncated write, or a file some other tool put there). A sentinel that names
 * a live process from THIS boot is not stale at any age, however long it has
 * been held — see `holder-identity.ts` for why there is no outer clock any
 * more.
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
 * writing the record first is that losing THAT one costs nothing. Whether an
 * unparseable line is tolerated is `recoverFromJournal`'s call, not this one's —
 * it depends on the line's POSITION, which only the caller can see.
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
    action: `Move the files under "${dirRel}/" back over the data directory by hand, then delete "${join(dirRel, JOURNAL_NAME)}" — until that record is gone, every restore in this data directory refuses. Delete "${RESTORE_SENTINEL}" too if it is still there, then run the restore again.`,
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
  // POSITIONS ARE THE EVIDENCE, so nothing may be dropped before they are read.
  // `record()` terminates every line with `\n`, so a file whose last write
  // completed ends in one and `split` yields a trailing '' that is the
  // DELIMITER, not a line. Exactly one comes off. A second empty element is a
  // real blank line, and a blank line is not something this writer can produce
  // — it is corruption, and it has to be seen as such by the rule below.
  // Filtering empties out first computed every position over a compacted array,
  // which is how a blank line in the MIDDLE of a journal read as the tolerated
  // final one and got the rest replayed and deleted underneath it.
  const lines = readFileSync(journalPath, 'utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();

  // Where an unreadable line SITS is the whole of what makes it tolerable.
  //
  // Tornness has exactly one shape: the write that was in flight when the power
  // went out, which is the last one. A line that will not parse — empty
  // included — with lines after it was not torn: the journal is corrupt, or was
  // written by something else, and this pass cannot tell which of the moves it
  // names are missing from what it can read. Dropping it and replaying the rest
  // is a PARTIAL rollback that then deletes the only surviving record of the
  // move it left undone, so the tree keeps a file nothing will ever put back and
  // nothing on disk says so. Refuse instead: the journal stays, and
  // `unusableJournal` tells the operator where the displaced copies are.
  const records: JournalRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const record = parseJournalLine(line);
    if (record !== null) {
      records.push(record);
      continue;
    }
    if (i < lines.length - 1) {
      throw unusableJournal(
        dirRel,
        `line ${i + 1} of ${lines.length} is ${line === '' ? 'blank' : 'not a record this wrote'}, ` +
          'and it is not the last one — only the final write can be torn, so the rest of this ' +
          'file cannot be trusted either',
      );
    }
  }

  // Nothing usable, and at most one line to account for it: a zero-length
  // journal (the file is created by `openJournal`'s `wx` a moment before the
  // `begin` record is fsynced into it — it leaves no line at all once the
  // terminal delimiter is off) or one holding a single torn partial line. Every record is fsynced BEFORE the rename it describes, so a journal
  // that names no rename describes none — there is nothing to undo, and the
  // file goes. Refusing instead would brick the data directory over a record
  // that says nothing happened, which was survivable while only a stale
  // takeover read journals and is not now that every restore does.
  //
  // A journal whose `begin` names another directory still falls through to the
  // refusal below — being in the wrong place is not being incomplete.
  if (records.length === 0 && lines.length <= 1) {
    unlinkSync(journalPath);
    return;
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
 * Roll back every unfinished install this data directory has a journal for, and
 * reclaim the staging trees abandoned beside them.
 *
 * Keyed off the JOURNAL, not off the sentinel. A journal exists if and only if
 * an install phase started and did not reach its own end, so it is the evidence
 * that the tree may be half-rewritten. The sentinel is a mutual-exclusion
 * device, and `restoreInProgress` tells an operator who is sure nothing is
 * running to delete it — which is exactly what they do when a crashed restore
 * makes the next one refuse inside the stale hour. Keying recovery off the
 * sentinel meant that path skipped recovery entirely: the new restore ran on
 * top of a half-rewritten tree, and the dead restore's journal stayed on disk
 * armed, for an unrelated restore weeks later to replay over live files.
 *
 * Called once per real restore, immediately after the sentinel is claimed and
 * before a lock is taken or a byte moves. Claiming FIRST is also what tells a
 * dead restore's journal from a live one's: a running restore holds the
 * sentinel across its whole install phase, so a process that got the sentinel
 * knows every journal it can see was left by a restore that is gone. A dry run
 * claims nothing and changes nothing, so it does not recover.
 *
 * Newest directory first: the names begin with a timestamp, so they sort into
 * the order the restores ran, and undoing two crashed installs that touched the
 * same file in any other order would put back the wrong copy.
 *
 * A failure here is not something to restore on top of, so it is not swallowed:
 * `recoverFromJournal` throws, and `restoreBackup` refuses to start. The
 * journal outlives that failure — it is unlinked only once its last record has
 * been undone — so the next attempt refuses on the same evidence instead of
 * proceeding over a tree nothing has repaired.
 *
 * Staging trees go last, and only once every journal has been dealt with.
 * `<ts>-<uniq>-staging/` is a full extracted copy of an archive, conversation
 * history included, removed by a `finally` that a `SIGKILL` never runs and that
 * nothing else has ever reclaimed. By the time this runs no live restore can
 * own one (the sentinel is held) and this restore has not made its own yet, so
 * every one of them is garbage. A staging tree is skipped by the journal loop
 * above rather than merely failing to contain a `journal.jsonl`: an archive is
 * someone else's data, and one carrying an entry called `journal.jsonl` must
 * not be able to plant a journal that blocks every future restore.
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
    if (name.endsWith(STAGING_SUFFIX)) continue;
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
  for (const name of names) {
    if (!name.endsWith(STAGING_SUFFIX)) continue;
    rmSync(containedPath(root, join(PRE_RESTORE_DIR, name)), { recursive: true, force: true });
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

/**
 * The pid a sentinel body opens with, or null when there is not one to read.
 *
 * The body is `<pid> <ISO timestamp> [boot id]` — written by `claimRestore` and
 * by nothing else — so the pid is the first whitespace-delimited token.
 * Anything else (a truncated write, a foreign writer, a hand-made file) is not
 * a pid, and the caller falls back to the clock rather than guessing.
 */
function readSentinelPid(body: string): number | null {
  const [first = ''] = body.trim().split(/\s+/);
  if (!/^\d+$/.test(first)) return null;
  const pid = Number(first);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * The boot the sentinel's pid belongs to — the third token — or null when the
 * body does not carry one. A sentinel written before this field existed, or on
 * a platform with no boot identity to record, lands here; `classifyHolder`
 * reads that as "cannot prove a different boot" and the live pid holds.
 */
function readSentinelBoot(body: string): string | null {
  const [, , third] = body.trim().split(/\s+/);
  return third === undefined || third === '' ? null : third;
}

/** The sentinel's exact bytes, or null when it is not there any more. */
function readSentinelBody(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Was this sentinel left behind by a restore that is gone?
 *
 * Age alone was the whole rule, and a one-hour wall clock is not one: a large
 * archive on slow storage overruns it, and taking a live restore over now
 * replays its journal underneath it. The pid the sentinel already carried and
 * nothing read answers the question directly:
 *
 * - a holder from another BOOT — abandoned, whatever its pid answers now. That
 *   pid cannot refer to the same process, so this is the recycled-pid case, and
 *   it is settled by identity rather than by a guess about elapsed time. See
 *   `holder-identity.ts`.
 * - a pid that is gone — abandoned NOW, without waiting out a clock that only
 *   ever existed because there was nothing better to ask.
 * - a pid that is alive, from this boot — HELD, at any age. There is no outer
 *   bound any more: an old sentinel naming a live process is exactly the case
 *   where taking over means replaying a running restore's journal underneath
 *   it, and no wall clock can tell that apart from a dead one. It is refused,
 *   loudly, with the pid to check and what to do about it.
 * - no readable pid — the clock, as before.
 */
function sentinelIsStale(body: string | null, ageMs: number): boolean {
  const pid = body === null ? null : readSentinelPid(body);
  if (pid !== null && body !== null) return classifyHolder(pid, readSentinelBoot(body)) !== 'live';
  return ageMs > SENTINEL_STALE_MS;
}

/**
 * The refusal an operator meets when a live restore holds the directory.
 *
 * This is now the ONLY way out of a sentinel naming a live pid — nothing
 * expires it on its own any more — so the message has to carry the whole
 * recovery: which process, how to check it is really gone, and what deleting
 * the file costs if it is not.
 */
function restoreInProgress(path: string, pid: number | null = null): EthosError {
  return new EthosError({
    code: 'IMPORT_BLOCKED',
    cause:
      pid === null
        ? 'Another restore is already running in this Ethos data directory'
        : `Another restore is already running in this Ethos data directory (process ${pid})`,
    action:
      (pid === null
        ? `Wait for it to finish. If you are certain no restore is running, delete "${RESTORE_SENTINEL}" in the Ethos data directory and retry`
        : `Wait for it to finish. Check with \`ps -p ${pid}\`: if process ${pid} is genuinely not running, delete "${RESTORE_SENTINEL}" in the Ethos data directory and retry. Deleting it while that process IS restoring lets a second restore roll the first one's renames back underneath it, so only do this once you have confirmed it is gone`) +
      ' — the next restore rolls any unfinished install back from its journal before it touches anything, so this is not a way past that.',
    details: { path, ...(pid !== null ? { pid } : {}) },
  });
}

/**
 * Claim the data directory for this restore and return the release.
 *
 * Exclusive create (`wx`), so two restores cannot both believe they own the
 * directory; a sentinel `sentinelIsStale` judges abandoned — the pid it carries
 * is gone, or it is old enough that no pid saves it — is taken over. The single
 * retry covers the two ways the create can lose a race it should win: the
 * holder finished between the create and the stat, or a stale sentinel was
 * cleaned up by someone else first.
 *
 * Mutual exclusion is ALL this does. Undoing what a dead restore half-applied
 * is `recoverAbandonedRestores`, and it runs on the caller's side of this
 * function for every restore that claims the directory — not here, in the
 * takeover branch, where an operator who deleted the sentinel on this
 * function's own advice would walk straight past it.
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
      // `<pid> <ISO timestamp> [boot id]`. The boot id is what lets a later
      // restore tell a recycled pid from the process that actually wrote this;
      // it is omitted on a platform that cannot supply one, and a body without
      // it is read as "same boot" — refused rather than taken over.
      const boot = currentBootId();
      writeFileSync(
        path,
        `${process.pid} ${new Date().toISOString()}${boot === null ? '' : ` ${boot}`}\n`,
        { flag: 'wx' },
      );
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
      const body = readSentinelBody(path);
      if (!sentinelIsStale(body, Date.now() - stat.mtimeMs)) {
        throw restoreInProgress(path, body === null ? null : readSentinelPid(body));
      }
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
  let stagingRel = `${preRestore}${STAGING_SUFFIX}`;
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
    // Gate 0 — an install that never finished is undone before this one starts.
    // Inside the claim, so no live restore's journal can be replayed out from
    // under it; before gate 4, so the databases the in-use check locks are the
    // recovered ones and not a half-rewritten mixture. Throws if it cannot,
    // and a refusal here is the point: there is no restoring on top of a tree
    // nothing has put back. A dry run changes nothing, recovery included.
    if (!opts.dryRun) recoverAbandonedRestores(root);

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
      stagingRel = `${preRestore}${STAGING_SUFFIX}`;
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
  /** Set when `rollback` failed: the journal is the only record of what moved. */
  let halfRestored = false;

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
    halfRestored = rollbackFailure !== null;
    const detail = err instanceof Error ? err.message : String(err);
    displaced.length = 0;
    throw new EthosError({
      code: 'IMPORT_BLOCKED',
      cause:
        rollbackFailure === null
          ? `Restore failed while installing files (${detail}). Every file it had already moved was put back from "${preRestore}/", so this installation is exactly as it was before the restore.`
          : `Restore failed while installing files (${detail}), and rolling back failed too (${rollbackFailure}). This installation is HALF-RESTORED: what was displaced is under "${preRestore}/" in the Ethos data directory, and the record of every move it made is in "${join(preRestore, JOURNAL_NAME)}".`,
      action:
        rollbackFailure === null
          ? 'Fix the underlying failure (disk space, permissions) and run the restore again.'
          : `Fix the underlying failure (disk space, permissions) and run the restore again — it replays "${join(preRestore, JOURNAL_NAME)}" first and puts the files under "${preRestore}/" back before it starts. Until it succeeds every restore in this data directory refuses, so move them back by hand only if that replay cannot be made to work.`,
      details: { preRestore, rolledBack: rollbackFailure === null },
    });
  } finally {
    // The journal covers a tree this process can no longer describe. Two of the
    // three ways out of the phase are not that: a finished install and a
    // successful rollback both leave the tree in a state named exactly, so
    // their record goes, and no later restore replays it.
    //
    // The third is `rollback` itself failing — the HALF-RESTORED case the throw
    // above names — and there the journal is the ONLY machine-readable account
    // of which files moved where. Deleting it on the single path that needs it
    // left the operator with a directory of copies and no ordering. It is kept,
    // which also means `recoverAbandonedRestores` refuses every later restore
    // until the replay succeeds; that is the same answer as for a crash, and
    // the replay decides each step from what is on disk, so a tree the operator
    // has already repaired by hand is left alone rather than re-clobbered.
    journal.close();
    if (!halfRestored) {
      rmSync(join(containedPath(root, preRestore), JOURNAL_NAME), { force: true });
    }
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
