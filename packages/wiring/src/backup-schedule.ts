// The scheduled half of `ethos backup` — what the `backup` system cron job
// runs, and the settings that drive it.
//
// Three things separate a scheduled backup from the CLI one:
//
//  1. It runs INSIDE a serving process, so the snapshot mode is `'backup'`
//     (async, plan D2). `VACUUM INTO` is synchronous in `@ethosagent/sqlite`
//     and would stall the event loop — every gateway turn, every HTTP request,
//     every voice frame — for as long as it takes to copy the databases.
//  2. It rotates. Run after run it points at one directory, so without a limit
//     it fills the disk it is protecting.
//  3. It shares that directory with a human who may run `ethos backup` at the
//     same moment, hence the `.lock` sentinel.
//
// Rotation deletes files, so it is deliberately narrow about which ones it
// will consider: only entries matching the exact name this module writes
// (`SCHEDULED_ARCHIVE_RE`). A `*.tar.gz` glob would sweep up a manual
// `ethos backup` archive, a pre-upgrade copy an operator parked here, or an
// unrelated tarball — the way a backup tool ends up eating something it did
// not create.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { type EthosConfig, ethosDir } from '@ethosagent/config';
import type { SecretsResolver, Storage } from '@ethosagent/types';
import { createBackup } from './backup/create';
import { DEFAULT_SCOPES, parseScopes, type ScopeName } from './backup/scopes';

/** Fired at 04:00 local by default — after the nightly pass (03:00), not with it. */
export const DEFAULT_BACKUP_CRON = '0 4 * * *';
/** How many scheduled archives survive rotation. */
export const DEFAULT_BACKUP_KEEP = 7;

/**
 * Filenames the scheduled job produces, and the ONLY filenames rotation will
 * delete. Anchored on both ends and fully literal about the timestamp shape.
 */
export const SCHEDULED_ARCHIVE_RE =
  /^ethos-scheduled-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.tar\.gz$/;

export function scheduledArchiveName(now: Date): string {
  return `ethos-scheduled-${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}Z.tar.gz`;
}

/** `backup.enabled` — on unless the operator turned it off. */
export function backupEnabled(config: EthosConfig): boolean {
  return config.backup?.enabled !== false;
}

/** `backup.cron`, defaulted. */
export function backupCron(config: EthosConfig): string {
  return config.backup?.cron ?? DEFAULT_BACKUP_CRON;
}

/**
 * Where backups are kept. `${ETHOS_HOME}` is deliberately NOT a token config
 * expands (plan D5) — the default is computed here, in code, and a relative
 * `backup.dir` resolves under the data dir rather than the process cwd, which
 * for a daemon is wherever it happened to be started.
 */
export function backupDirectory(config?: EthosConfig): string {
  const configured = config?.backup?.dir;
  if (!configured) return join(ethosDir(), 'backups');
  return isAbsolute(configured) ? configured : join(ethosDir(), configured);
}

export interface ResolvedBackupSettings {
  enabled: boolean;
  cron: string;
  scopes: ScopeName[];
  keep: number;
  dir: string;
}

/**
 * Full `backup.*` resolution. THROWS on an unusable `backup.scope` — the
 * scheduler never calls this (it reads `backupEnabled`/`backupCron`, which
 * cannot fail), so a scope typo surfaces as a failed backup run with the
 * offending name in the error, not as a config load that takes the whole CLI
 * down or as four other system jobs that silently never got seeded.
 */
export function resolveBackupSettings(config: EthosConfig): ResolvedBackupSettings {
  const scope = config.backup?.scope;
  const keep = config.backup?.keep;
  return {
    enabled: backupEnabled(config),
    cron: backupCron(config),
    scopes: scope && scope.length > 0 ? parseScopes(scope.join(',')) : [...DEFAULT_SCOPES],
    keep: keep !== undefined && keep > 0 ? Math.floor(keep) : DEFAULT_BACKUP_KEEP,
    dir: backupDirectory(config),
  };
}

// ---------------------------------------------------------------------------
// The `.lock` sentinel
// ---------------------------------------------------------------------------

const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 100;
/** Only used when the lock body carries no readable pid. */
const LOCK_STALE_MS = 60 * 60 * 1000;

export function backupLockPath(dir: string): string {
  return join(dir, '.lock');
}

function holderIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists and belongs to someone else — alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The lock file's exact bytes, or `null` when it is not there. */
function readLockBody(lockPath: string): string | null {
  try {
    return readFileSync(lockPath, 'utf-8');
  } catch {
    return null;
  }
}

/** True when `body` was left behind by a process that is gone. */
function lockIsStale(lockPath: string, body: string): boolean {
  const pid = readPid(body);
  if (pid !== null) return !holderIsAlive(pid);
  // No usable pid (truncated write, foreign writer): fall back to age.
  try {
    return Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
  } catch {
    return true;
  }
}

function readPid(body: string): number | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || !('pid' in parsed)) return null;
    const pid = (parsed as { pid: unknown }).pid;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    /* not JSON — a truncated or foreign write */
    return null;
  }
}

/**
 * Exclusive-create sentinel, the agent-mesh `wx` idiom
 * (`extensions/agent-mesh/src/index.ts`): a manual `ethos backup` and the
 * scheduled job must not stream the same databases into two archives at once.
 *
 * Raw `node:fs` on purpose. An atomic create-if-absent has no equivalent in the
 * `Storage` contract — `exists()` then `write()` is the race this exists to
 * close — the same carve-out `acquireRegistryLock` and `acquirePidFile` carry.
 * Everything else this module touches goes through `Storage`.
 *
 * The lock is OWNED, not just present: its body carries a `token` unique to the
 * acquiring call. Exactly ONE step below is atomic, and it is the only one that
 * decides anything — the `wx` create. Whoever's create returns without EEXIST
 * won; every read, compare and unlink around it is confirmation, never
 * arbitration. The protocol:
 *
 *  1. `wx` create. Succeeding means we MAY hold the lock.
 *  2. Re-read, and confirm the file still carries OUR bytes. A contender that
 *     had already classified the lock we displaced as stale can unlink ours and
 *     install its own in the gap after step 1. If it did, we do not hold the
 *     lock — so we abandon the attempt and go back to waiting rather than hand
 *     the caller a release closure for someone else's file. This is what makes
 *     "two contenders both took over the same abandoned lock" settle on one
 *     holder instead of two.
 *  3. On EEXIST, classify the incumbent. Stale (pid gone, or unreadable and
 *     past the stale window) means re-read and unlink only if the bytes are
 *     still the ones we judged. That comparison makes the losing contender
 *     decline in the common case; it is NOT the guarantee. Step 2 is.
 *
 * What this does NOT do, plainly. POSIX has no atomic compare-and-delete for a
 * pathname: `unlink` names a path, not the inode that was read, so every
 * check-then-unlink here — the takeover's and `release`'s alike — leaves a
 * window in which the file can be replaced between the compare and the unlink,
 * and the unlink then removes a successor's live lock. Step 2 answers that
 * without curing it: a contender notices the loss only if its confirmation read
 * lands after the unlink that took its lock away. Should it land before, two
 * processes both believe they hold the lock and stream the same databases into
 * the same directory at once. Both windows are a few microseconds of adjacent
 * synchronous syscalls, reachable only when two contenders classify the SAME
 * abandoned lock as stale inside that span. Narrowed and stated, not closed.
 *
 * Comparing the open descriptor's inode against a `stat` of the path just
 * before unlinking was considered and rejected: it relocates the window rather
 * than closing it, and buys nothing the `token` does not already buy — a
 * successor's body is never byte-equal to the one we read.
 *
 * `release` keeps the same comparison, for the same reason and with the same
 * residual: a holder that overran the stale window and was legitimately taken
 * over must not delete its successor's lock on the way out. Step 2 cannot help
 * there — by then the backup has already run and there is nothing left to
 * retry — so declining to unlink bytes that are not ours is the whole of what
 * release can do, and it does that much.
 *
 * The token is what makes every byte comparison sound: `pid` + `startedAt`
 * alone repeat if one process re-acquires within the same millisecond.
 */
export async function acquireBackupLock(
  dir: string,
  opts?: { timeoutMs?: number },
): Promise<() => void> {
  mkdirSync(dir, { recursive: true });
  const lockPath = backupLockPath(dir);
  const body = JSON.stringify({
    token: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  const release = (): void => {
    try {
      if (readLockBody(lockPath) === body) unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  };
  const deadline = Date.now() + (opts?.timeoutMs ?? LOCK_ACQUIRE_TIMEOUT_MS);
  for (;;) {
    let created = false;
    let reclaimed = false;
    try {
      // Step 1 — the atomic one. Nothing else in this loop decides a winner.
      writeFileSync(lockPath, body, { flag: 'wx' });
      created = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Step 3 — classify the incumbent, and reclaim it only if it is stale.
      const observed = readLockBody(lockPath);
      if (observed !== null && lockIsStale(lockPath, observed)) {
        try {
          // The lock we judged stale may already have been taken over and
          // replaced with a live one since the read above.
          if (readLockBody(lockPath) === observed) {
            unlinkSync(lockPath);
            reclaimed = true;
          }
        } catch {
          // Another contender reclaimed it first, or we may not remove it.
          // Either way fall through to the wait so this cannot spin.
        }
      }
    }
    // Step 2 — we created it, but do we still hold it? If a racing takeover
    // unlinked our lock and installed its own, the answer is no, and returning
    // `release` here would hand out a closure over that contender's file.
    if (created && readLockBody(lockPath) === body) return release;
    // A reclaim frees the path for us; retry the create at once rather than
    // sleeping out the retry interval first.
    if (reclaimed) continue;
    if (Date.now() >= deadline) {
      throw new Error(
        `another backup is already in progress — ${lockPath} is held. ` +
          'Wait for it to finish, or remove the lock if no backup is running.',
      );
    }
    await new Promise<void>((r) => setTimeout(r, LOCK_RETRY_MS));
  }
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

/**
 * Keep the newest `keep` scheduled archives; delete the rest, oldest first.
 *
 * Ordered by the timestamp in the NAME rather than mtime: the name is written
 * once and is lexicographically monotonic, while an mtime is whatever the last
 * `cp -p`, rsync or restore left behind. Returns what it deleted.
 */
export async function rotateBackups(
  storage: Storage,
  dir: string,
  keep: number,
): Promise<string[]> {
  if (keep < 1) return [];
  const entries = await storage.listEntries(dir);
  const mine = entries
    .filter((e) => !e.isDir && SCHEDULED_ARCHIVE_RE.test(e.name))
    .map((e) => e.name)
    .sort();
  const doomed = mine.slice(0, Math.max(0, mine.length - keep));
  for (const name of doomed) {
    await storage.remove(join(dir, name));
  }
  return doomed;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface RunScheduledBackupOptions {
  /** `~/.ethos` (or an `ETHOS_STATE_DIR` override). */
  dataDir: string;
  settings: ResolvedBackupSettings;
  storage: Storage;
  /** Vault to enumerate for the archive's secrets manifest. */
  secrets?: SecretsResolver;
  /** Injected by tests so archive names are deterministic. */
  now?: Date;
  /** How long to wait for the `.lock`. Defaults to 5s. */
  lockTimeoutMs?: number;
}

export interface ScheduledBackupResult {
  path: string;
  scopes: ScopeName[];
  fileCount: number;
  bytes: number;
  /** Archives rotation removed, oldest first. */
  rotated: string[];
}

/**
 * Create one scheduled archive, then rotate. Throws on any failure — the cron
 * tick turns a throw into a logged error plus `lastError` on the job, which is
 * what `ethos status` and `ethos cron list` read. A backup that fails quietly
 * is worse than no backup, because it looks like one.
 */
export async function runScheduledBackup(
  opts: RunScheduledBackupOptions,
): Promise<ScheduledBackupResult> {
  const { dir, scopes, keep } = opts.settings;
  const release = await acquireBackupLock(
    dir,
    opts.lockTimeoutMs !== undefined ? { timeoutMs: opts.lockTimeoutMs } : {},
  );
  try {
    const outPath = join(dir, scheduledArchiveName(opts.now ?? new Date()));
    const result = await createBackup({
      dataDir: opts.dataDir,
      outPath,
      scopes,
      // MANDATORY here (D2): this runs in a serving process.
      snapshot: 'backup',
      ...(opts.secrets ? { secrets: opts.secrets } : {}),
    });
    const rotated = await rotateBackups(opts.storage, dir, keep);
    return {
      path: result.path,
      scopes: result.scopes,
      fileCount: result.fileCount,
      bytes: result.bytes,
      rotated,
    };
  } finally {
    release();
  }
}
