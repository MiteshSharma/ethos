// Cross-process mutual exclusion for the ambient channel digest.
//
// The digest is a READ-MODIFY-WRITE over one shared file: it reads every
// lane's cursor out of `channel-digest-watermarks.json`, spends a paid LLM
// pass and a delivery per lane, then writes the whole map back.
// `Storage.writeAtomic` guarantees that file is never torn — it guarantees
// nothing about two processes interleaving around it. Two gateways sharing
// one `~/.ethos` (an `ethos gateway` beside an `ethos boot`, or a restart
// overlapping its predecessor) both read the same cursors, both summarise the
// same rooms, both deliver the same digest to the same owner, and the second
// write erases whatever the first advanced. That is a duplicate digest AND a
// lost cursor, from a file whose atomicity was never the problem.
//
// The primitive is the one this repo already uses for exactly this shape: an
// advisory `wx`-flag exclusive-create sentinel with stale detection. See
// `acquireRegistryLock` in `extensions/agent-mesh/src/index.ts` and
// `acquireBackupLock` in `packages/wiring/src/backup-schedule.ts`. Raw
// `node:fs` on purpose, and for the reason those two carry the same carve-out:
// an atomic create-if-absent has no equivalent in the `Storage` contract —
// `exists()` then `write()` is the precise race the lock exists to close.
// Everything else on this path still goes through `Storage`.
//
// It does NOT wait. See `tryAcquireChannelDigestLock`.
//
// It is deliberately a copy rather than an import of either sibling.
// `packages/wiring` sits above `extensions/` in the layer model
// (ARCHITECTURE.md §II), so its version is not reachable from here, and
// `agent-mesh`'s is private to that module and blocks rather than skips.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The clock fallback, used ONLY when the lock body carries no readable pid — a
 * truncated write, or a file some other tool left at this path.
 *
 * A lock naming a live process is never expired by age, however long it has
 * been held. `acquireBackupLock` explains why at length and the reasoning is
 * the same here: an outer wall clock cures a wedge by preempting a holder that
 * is demonstrably still working, which puts two writers on the same file — the
 * exact failure this module exists to prevent, traded for a deadlock that is
 * loud (every run says it skipped, and names the pid) and that an operator can
 * clear by deleting one file.
 */
const STALE_MS = 60 * 60 * 1000;

export type ChannelDigestLockAttempt =
  | { ok: true; release: () => void }
  /** Why the run must not proceed, in a sentence fit for an operator to read. */
  | { ok: false; reason: string };

function readBody(lockPath: string): string | null {
  try {
    return readFileSync(lockPath, 'utf-8');
  } catch {
    return null;
  }
}

/** The holder's pid, or `null` when the body does not carry a usable one. */
function readPid(body: string): number | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || !('pid' in parsed)) return null;
    const pid: unknown = parsed.pid;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    /* not JSON — a truncated or foreign write */
    return null;
  }
}

/** `EPERM` means the pid exists and belongs to somebody else — still alive. */
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isStale(lockPath: string, body: string): boolean {
  const pid = readPid(body);
  if (pid !== null) return !pidIsAlive(pid);
  try {
    return Date.now() - statSync(lockPath).mtimeMs > STALE_MS;
  } catch {
    return true; // no mtime to judge by — the lock is already gone
  }
}

/**
 * Take the digest lock, or say why not. NEVER BLOCKS.
 *
 * Skipping is the right answer here, and waiting is not. A digest run is a
 * scheduled tick over a cursor that only ever moves forward: whatever this run
 * would have read, the run that is holding the lock is reading right now, and
 * anything it does not reach stays unconsumed for the next tick. Queueing
 * behind it would spend the wall time of a full pass to arrive at lanes the
 * holder has just emptied. The cadence is free — that is the whole point of an
 * ingestion cursor with no time window — so a skipped tick costs nothing but
 * latency, while a waiting tick costs a second pass for the same result.
 *
 * The skip is NOT silent: the caller records a `channel.digest_skipped`
 * observability event and puts `reason` on the report, which is what the cron
 * run-output file prints. A wedged lock therefore shows up on every run,
 * naming the process holding it.
 *
 * The lock is OWNED, not merely present: the body carries a `token` unique to
 * this call, so every comparison below distinguishes our file from a
 * successor's. Exactly one step is atomic and it is the only one that decides
 * anything — the `wx` create. The rest is confirmation:
 *
 *  1. `wx` create. Succeeding means we MAY hold it.
 *  2. Re-read and confirm the bytes are still ours. A contender that had
 *     already judged the lock we displaced stale can unlink ours and install
 *     its own in the gap after step 1; if it did, we do not hold the lock and
 *     must not hand back a release closure over its file.
 *  3. On `EEXIST`, classify the incumbent. A live pid means held — return.
 *     Otherwise reclaim it (comparing bytes first, so the loser of a race
 *     declines) and retry the create exactly once.
 *
 * What this does not do, plainly: POSIX has no atomic compare-and-delete for a
 * pathname, so the check-then-unlink in the reclaim and in `release` alike
 * leaves a microsecond window in which a successor's live lock could be
 * removed. Step 2 narrows it rather than closing it, and it is reachable only
 * when two processes classify the SAME abandoned lock as stale inside that
 * span. Stated, not cured — the same residual `acquireBackupLock` documents.
 */
export function tryAcquireChannelDigestLock(lockPath: string): ChannelDigestLockAttempt {
  mkdirSync(dirname(lockPath), { recursive: true });
  const body = JSON.stringify({
    token: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  const release = (): void => {
    try {
      // Never delete bytes that are not ours: a holder that overran the stale
      // window and was legitimately taken over must not remove its successor's
      // lock on the way out.
      if (readBody(lockPath) === body) unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  };

  // At most two passes: the second only after reclaiming a lock whose holder is
  // demonstrably gone. There is no third, because a path that keeps coming back
  // occupied has a live contender on it and the answer is to skip.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, body, { flag: 'wx' }); // step 1 — the atomic one
      // Step 2 — created, but do we still hold it?
      if (readBody(lockPath) === body) return { ok: true, release };
      return { ok: false, reason: `another digest run took ${lockPath} while it was being taken` };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    // Step 3 — classify the incumbent.
    const observed = readBody(lockPath);
    if (observed === null) continue; // vanished between create and read — retry
    if (!isStale(lockPath, observed)) {
      const pid = readPid(observed);
      return {
        ok: false,
        reason:
          `another digest run is already in progress — ${lockPath} is held` +
          `${pid === null ? '' : ` by process ${pid}`}`,
      };
    }
    try {
      // It may have been taken over and replaced with a live lock since the read.
      if (readBody(lockPath) === observed) unlinkSync(lockPath);
    } catch {
      /* another contender reclaimed it first — the retry will see its lock */
    }
  }
  return { ok: false, reason: `another digest run is already in progress — ${lockPath} is held` };
}
