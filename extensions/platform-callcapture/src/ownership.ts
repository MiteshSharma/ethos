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
import type { CallCaptureDaemonLogger } from './daemon';
import type { Clock } from './detector';

/** Injectable liveness probe — same injectable-port idiom used throughout
 * this package (`detector.ts`'s `SpawnFn`, `notification.ts`'s spawn hook,
 * ...). Tests supply a fake so ownership races can be driven
 * deterministically without touching real PIDs. */
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

const managerRealClock: Clock = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as NodeJS.Timeout),
};

export interface CallCaptureOwnershipManagerOptions {
  /** Same value passed straight through to `tryClaimOwnership`. */
  lockPath: string;
  /**
   * How often to retry the claim while another process holds the lock.
   * Callers should pass the same cadence they already use for the
   * daemon's own liveness heartbeat (`CALL_CAPTURE_HEARTBEAT_INTERVAL_MS`
   * in `serve.ts`/`gateway.ts`) rather than inventing a second interval —
   * see plan/phases/call-capture-desktop-ux.md, P0.
   */
  retryIntervalMs: number;
  /**
   * Called exactly once, the moment this process wins the ownership claim
   * — either on the very first attempt (`start()`) or later, from a retry
   * tick, once the previous owner has exited and released the lock. Must
   * construct and start the `CallCaptureDaemon` plus anything else that
   * should run only while this process owns the lock (e.g. the
   * heartbeat-writing loop), and return a teardown that stops all of it.
   * The manager calls that teardown exactly once, from `stop()` — callers
   * must not also tear it down on their own shutdown path.
   */
  onOwnershipClaimed: () => () => Promise<void> | void;
  /**
   * Called at most once — only from the very first `start()` attempt — when
   * this process loses the initial ownership claim to another live process
   * (`ownerPid`). A retry tick that also loses does NOT call this again: it
   * is a one-time "you will not get call-capture in this process" signal,
   * never a per-retry spam source (ARCHITECTURE.md §V S7, "silent failures
   * are forbidden" — but a message repeated every retry interval is its own
   * kind of noise). Optional: `logger` above already emits a generic
   * `info`-level line on the same losing path, which is enough for a
   * headless CLI daemon (`ethos serve`/`ethos gateway`); a caller with its
   * own UI surface tied to ownership (the desktop app's pill/notification
   * windows, which never activate at all while another process holds the
   * lock) wires this to explain THAT consequence specifically.
   */
  onClaimFailed?: (ownerPid: number) => void;
  logger?: CallCaptureDaemonLogger;
  isProcessAlive?: IsProcessAlive;
  /** Overrides the timer implementation backing the retry loop. */
  clock?: Clock;
}

/**
 * Wraps `tryClaimOwnership` with the periodic-retry behaviour `serve.ts`
 * and `gateway.ts` both need (plan/phases/call-capture-desktop-ux.md, P0):
 * a process that loses the initial claim at startup is no longer stuck
 * daemon-less for its entire lifetime. It keeps retrying on
 * `retryIntervalMs` until it either wins — because the original owner
 * exited and released the lock — or `stop()` is called. A process that
 * already owns the lock just runs `onOwnershipClaimed()` once, synchronously,
 * from `start()`, and does nothing further until `stop()`.
 */
export class CallCaptureOwnershipManager {
  private readonly options: CallCaptureOwnershipManagerOptions;
  private release: (() => void) | undefined;
  private stopDaemon: (() => Promise<void> | void) | undefined;
  private retryHandle: unknown;
  private stopped = false;

  constructor(options: CallCaptureOwnershipManagerOptions) {
    this.options = options;
  }

  /** True once this process has won the claim and started its daemon —
   * either immediately from `start()` or later, from a retry tick. */
  get owns(): boolean {
    return this.stopDaemon !== undefined;
  }

  /**
   * Attempts the initial claim synchronously. If it's lost, logs once and
   * schedules the first retry tick — never blocks waiting for a later win.
   */
  start(): void {
    const claim = tryClaimOwnership(this.options.lockPath, {
      isProcessAlive: this.options.isProcessAlive,
    });
    if (claim.claimed) {
      this.claim(claim.release);
      return;
    }
    this.options.logger?.info(
      `call-capture: already running under PID ${claim.ownerPid} — not starting a second instance in this process (retrying every ${this.options.retryIntervalMs}ms)`,
    );
    this.options.onClaimFailed?.(claim.ownerPid);
    this.scheduleRetry();
  }

  private claim(release: () => void): void {
    this.release = release;
    this.stopDaemon = this.options.onOwnershipClaimed();
  }

  private scheduleRetry(): void {
    const clock = this.options.clock ?? managerRealClock;
    this.retryHandle = clock.setTimeout(() => {
      this.retryHandle = undefined;
      if (this.stopped || this.owns) return;
      const claim = tryClaimOwnership(this.options.lockPath, {
        isProcessAlive: this.options.isProcessAlive,
      });
      if (claim.claimed) {
        this.options.logger?.info('call-capture: claimed ownership on retry — starting daemon');
        this.claim(claim.release);
        return;
      }
      this.scheduleRetry();
    }, this.options.retryIntervalMs);
  }

  /**
   * Graceful shutdown: cancels any pending retry tick, stops the daemon
   * (only if this process ever won the claim), and releases the lock. Safe
   * to call whether or not this process ever became the owner.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryHandle !== undefined) {
      const clock = this.options.clock ?? managerRealClock;
      clock.clearTimeout(this.retryHandle);
      this.retryHandle = undefined;
    }
    if (this.stopDaemon) {
      await this.stopDaemon();
      this.stopDaemon = undefined;
    }
    this.release?.();
    this.release = undefined;
  }
}
