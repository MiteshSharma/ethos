// Cross-process ownership claim for the call-capture daemon.
//
// `ethos serve` and `ethos gateway` are both independently documented as
// deployable, always-on hosts (this package's README's "Running as a
// LaunchAgent" section, plus `ethos gateway`'s own separately-documented
// LaunchAgent setup), and `ethos run-all` spawns both as child processes
// simultaneously. Each independently constructs a full `CallCaptureDaemon`
// when `callCapture.personalityId` is configured — with no coordination,
// two hosts running at once means two notifications for one call, two
// concurrent `TapCapture`/`MicCapture` pairs fighting over the same Process
// Tap/mic if both get accepted, and both processes writing the SAME shared
// heartbeat file (`callCaptureHealthPath()`), where whichever exits first
// deletes it out from under the other still-alive process.
//
// This module enforces "at most one daemon owner at a time" via an atomic
// PID-claim file, mirroring `extensions/team-supervisor/src/pid.ts`'s
// `acquirePidFile` technique exactly (atomic `O_CREAT|O_EXCL` create via
// `openSync(path, 'wx')`, `process.kill(pid, 0)` for liveness, stale-file
// cleanup) — see that file for the technique's own rationale. Deliberately
// NOT reused as-is: `acquirePidFile` throws when the lock is already held,
// which is correct for team-supervisor's mutex (failing to acquire IS a
// fatal startup error there). Here, losing the race is a normal, expected
// outcome (the other host process is already running call-capture) and must
// NOT crash `ethos serve`/`ethos gateway` — it just means "don't construct a
// daemon in THIS process." `tryClaimOwnership` returns a result instead of
// throwing so callers can branch on it.
//
// Raw `node:fs` here is the same carve-out category as
// `extensions/team-supervisor/src/pid.ts`: process-management state (a PID
// lock), not `~/.ethos/` personality data — see
// `apps/ethos/src/__tests__/no-raw-fs.test.ts`'s allowlist entry for this
// file.

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Injectable liveness probe — mirrors `process-prefilter.ts`'s
 * `CheckProcessRunning` port pattern. Tests supply a fake so ownership
 * races can be driven deterministically without touching real PIDs. */
export type IsProcessAlive = (pid: number) => boolean;

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process (dead). EPERM = alive but owned by someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type ClaimOwnershipResult =
  | { claimed: true; release: () => void }
  | { claimed: false; ownerPid: number };

export interface TryClaimOwnershipDeps {
  isProcessAlive?: IsProcessAlive;
}

function tryCreateLockFile(lockPath: string): boolean {
  try {
    // O_CREAT | O_EXCL | O_WRONLY — atomic, fails with EEXIST if the file
    // already exists. This is the actual race-closing primitive; everything
    // else in this function is bookkeeping around it.
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return false;
  }
}

function readOwnerPid(lockPath: string): number | null {
  try {
    const src = readFileSync(lockPath, 'utf-8').trim();
    return Number(src) || null;
  } catch {
    return null;
  }
}

/**
 * Attempt to become the sole owner of the call-capture daemon across
 * processes. Returns `{ claimed: true, release }` when this call won the
 * lock — `release()` removes the lock file and must be called on this
 * process's graceful shutdown path, alongside where it stops its daemon.
 * Returns `{ claimed: false, ownerPid }` when another live process already
 * holds it — the caller must skip constructing a daemon entirely, not treat
 * this as an error.
 */
export function tryClaimOwnership(
  lockPath: string,
  deps: TryClaimOwnershipDeps = {},
): ClaimOwnershipResult {
  const isAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  mkdirSync(dirname(lockPath), { recursive: true });

  const release = (): void => {
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore — already gone */
    }
  };

  if (tryCreateLockFile(lockPath)) {
    return { claimed: true, release };
  }

  // Lock file exists — check whether its owner is actually alive.
  const existingPid = readOwnerPid(lockPath);
  if (existingPid !== null && isAlive(existingPid)) {
    return { claimed: false, ownerPid: existingPid };
  }

  // Stale lock file from a previous crash (or unreadable) — clean up and
  // retake.
  try {
    unlinkSync(lockPath);
  } catch {
    /* ignore */
  }

  if (tryCreateLockFile(lockPath)) {
    return { claimed: true, release };
  }

  // Lost a second race (another process claimed it between our cleanup and
  // retry) — report whatever owner is now on disk, best-effort.
  return { claimed: false, ownerPid: readOwnerPid(lockPath) ?? 0 };
}
