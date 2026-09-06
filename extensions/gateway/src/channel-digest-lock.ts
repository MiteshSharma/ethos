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
//
// THE COPY INCLUDES THE HOLDER CHECK, and that is the point of saying so.
// `acquireBackupLock` decides a holder is gone with
// `packages/wiring/src/backup/holder-identity.ts`, not with
// `process.kill(pid, 0)` — and the difference is the whole reason that file
// exists. This module cited its reasoning while implementing only half of it:
// a bare pid probe, which after a reboot onto a recycled pid reads a dead
// holder as alive for ever and wedges the digest permanently. `currentBootId`
// and `classifyHolder` below are that file's logic, reproduced because the
// layer model forbids importing it. THE TWO MUST CHANGE TOGETHER;
// `holder-identity.ts` carries the pointer back here.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
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
 *
 * The one case a clock WOULD have caught and a pid probe does not — a holder
 * from a previous boot whose pid has since been handed to something else — is
 * caught by identity instead, in `classifyHolder`. Identity answers exactly
 * that case; a clock only guesses at it, and guesses wrong in the direction
 * that corrupts.
 */
const STALE_MS = 60 * 60 * 1000;

/**
 * An identifier for the current boot, or `null` where this platform has no way
 * to give one that can be trusted. A copy of `currentBootId` in
 * `packages/wiring/src/backup/holder-identity.ts` — see the note at the top of
 * this file for why it is copied, and that file for the full argument.
 *
 * ONLY AN EXACT IDENTIFIER COUNTS. Linux has one (`/proc/sys/kernel/random/
 * boot_id`, a kernel-generated UUID that no clock adjustment can move).
 * Everywhere else the available quantities are wall-clock derivations —
 * `Date.now() - os.uptime()`, macOS's `kern.boottime`, Windows'
 * `GetTickCount64` — and a boot id that disagrees with itself across an NTP
 * step makes two processes from the SAME boot preempt each other, which is the
 * corruption this exists to prevent, reintroduced by the cure. So: `null`, and
 * `null` degrades to refusal.
 *
 * Memoised — a process cannot outlive its own boot, and this is read on a path
 * that can spin.
 *
 * Exported for the test that plants a lock from an EARLIER boot. That test has
 * to build an identity of the same shape this machine writes, and the shape is
 * platform-specific — deriving it from the real one is how
 * `packages/wiring/src/__tests__/backup-schedule.test.ts` does the same thing,
 * and reimplementing the platform rule in a test is how the two drift apart.
 */
let cachedBootId: string | null | undefined;

export function currentBootId(): string | null {
  if (cachedBootId === undefined) {
    cachedBootId = null;
    if (platform() === 'linux') {
      try {
        const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
        cachedBootId = id === '' ? null : `boot-id:${id}`;
      } catch {
        /* a container without /proc, a hardened kernel — degrade to refusal */
      }
    }
  }
  return cachedBootId;
}

/**
 * Can we PROVE the recorded holder belongs to an earlier boot? Every uncertain
 * answer is `false`, because `false` refuses and `true` takes a lock away: an
 * unknown on either side, a body written before this module recorded a boot at
 * all, and a shape from another platform on a shared filesystem are all
 * uncertain. The comparison is exact equality and there is no tolerance to
 * widen — every form `currentBootId` returns is exact by construction.
 */
function isDifferentBoot(recorded: string | null): boolean {
  const current = currentBootId();
  if (recorded === null || current === null) return false;
  if (!recorded.startsWith('boot-id:') || !current.startsWith('boot-id:')) return false;
  return recorded !== current;
}

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

/**
 * Who wrote this lock: a pid, and the boot that pid belongs to. `null` when the
 * body carries no usable pid — a truncated or foreign write.
 *
 * `boot` is `null` for a body written before this module recorded one, which is
 * the ordinary case for a lock left by a previous release. `null` there means
 * "cannot prove a different boot", so such a lock behaves exactly as it did
 * before: judged by its pid alone.
 */
function readHolder(body: string): { pid: number; boot: string | null } | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || !('pid' in parsed)) return null;
    const pid: unknown = parsed.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
    const boot: unknown = 'boot' in parsed ? parsed.boot : null;
    return { pid, boot: typeof boot === 'string' && boot !== '' ? boot : null };
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

/**
 * `'other-boot'` — the pid cannot refer to the holder any more, whatever it
 * answers now. `'gone'` — nothing is wearing the pid. `'live'` — a process from
 * this boot is, and nothing here takes its lock away automatically.
 *
 * The boot check runs FIRST, because the recycled pid it exists to catch is
 * precisely one that reads as alive. A copy of `classifyHolder` in
 * `packages/wiring/src/backup/holder-identity.ts`; see the top of this file.
 */
type HolderState = 'live' | 'gone' | 'other-boot';

function classifyHolder(pid: number, recordedBoot: string | null): HolderState {
  if (isDifferentBoot(recordedBoot)) return 'other-boot';
  return pidIsAlive(pid) ? 'live' : 'gone';
}

function isStale(lockPath: string, body: string): boolean {
  const holder = readHolder(body);
  if (holder !== null) return classifyHolder(holder.pid, holder.boot) !== 'live';
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
 *  3. On `EEXIST`, classify the incumbent — by HOLDER, not by pid alone: a
 *     live pid from this boot means held, and the run returns. A pid nothing
 *     is wearing, or one whose recorded boot is provably not this one, is
 *     reclaimed (comparing bytes first, so the loser of a race declines) and
 *     the create is retried exactly once. See `classifyHolder`.
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
    // Which boot the pid above belongs to, so a successor can tell a live
    // holder from a recycled pid. `null` off Linux — see `currentBootId`.
    boot: currentBootId(),
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
      const pid = readHolder(observed)?.pid ?? null;
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
