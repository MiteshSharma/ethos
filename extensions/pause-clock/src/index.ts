// Pause clock — the "a resume just happened" detector for a snapshot-and-restore
// deployment (plan/phases/clock-tolerance-pass.md §6).
//
// WHY DRIFT DETECTION WORKS. libuv's timer heap is keyed to CLOCK_MONOTONIC, so
// a `setInterval` left running across a multi-hour pause keeps its cadence: it
// does not replay a backlog of missed deadlines, it fires one catch-up tick the
// moment the event loop resumes and then carries on every `intervalMs`. The
// wall clock, meanwhile, jumps — either because the guest clock was frozen at
// snapshot time and resumes behind, or because the host corrected it forward in
// one discontinuous step at restore. So the *timer* stays honest while
// `Date.now()` moves; the gap between "one interval should have elapsed" and
// "this many milliseconds of wall clock actually elapsed" is precisely the
// pause. That is plan §1's mechanism read in reverse: the callback body reading
// `Date.now()` is where the jump becomes visible, and this class is the one
// place that visibility is a feature rather than the bug every staleness gate
// in the inventory suffers from.
//
// WHY 60s. The threshold has to sit above everything that moves a wall clock
// without a pause behind it — an NTP step correction (sub-second in steady
// state, seconds after a long offline stretch), a stop-the-world GC pause, a
// loaded scheduler starving the event loop — and below the smallest pause worth
// discounting. A real snapshot-and-restore pause is minutes to hours; a minute
// clears the noise floor by orders of magnitude on both sides.
//
// WHY THIS EXISTS AT ALL. Plan §8 makes designing the host→guest pause-duration
// channel an explicit non-goal, so a deployment may have no MMDS value and no
// host agent to ask. This class is the fallback for that case: it needs nothing
// from outside the process. `notifyResume()` is the seam a real control plane
// plugs into once one exists, and a deployment with a genuine host agent should
// supply its own `PauseLifecycle` instead.

import type { PauseLifecycle, PauseOffset } from '@ethosagent/types';

/** How often the wall clock is sampled for a jump. */
export const DEFAULT_DRIFT_INTERVAL_MS = 1_000;
/** Drift above this in a single interval is read as a pause, not as jitter. */
export const DEFAULT_DRIFT_THRESHOLD_MS = 60_000;

/** Notified with the drained pause duration the moment a resume is detected. */
export type ResumeHandler = (pauseDurationMs: number) => void;

export interface ClockDriftPauseLifecycleOptions {
  /** Sampling cadence. Default `DEFAULT_DRIFT_INTERVAL_MS`. */
  intervalMs?: number;
  /** Minimum excess wall-clock drift per tick to count. Default `DEFAULT_DRIFT_THRESHOLD_MS`. */
  thresholdMs?: number;
  /** Wall clock. Injected so tests need no fake timers for the arithmetic. */
  now?: () => number;
}

/**
 * Detects a resume two ways and reports the total as one pause offset:
 * a self-contained wall-clock drift watchdog (`start()`/`stop()`), and an
 * explicit `notifyResume()` for a control plane or host agent that knows the
 * real duration.
 */
export class ClockDriftPauseLifecycle implements PauseLifecycle {
  private readonly intervalMs: number;
  private readonly thresholdMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Wall-clock reading the next tick is expected to land near. */
  private expected = 0;
  /** Accumulated, not-yet-read pause duration. Summed, never overwritten. */
  private pendingMs = 0;
  /** Resume handlers, in registration order. See `onResume`. */
  private readonly handlers: ResumeHandler[] = [];

  constructor(options: ClockDriftPauseLifecycleOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_DRIFT_INTERVAL_MS;
    this.thresholdMs = options.thresholdMs ?? DEFAULT_DRIFT_THRESHOLD_MS;
    this.now = options.now ?? Date.now;
  }

  /** Arm the drift watchdog. Idempotent. The timer is `unref()`'d, so a lone
   *  pending tick never holds the process open. */
  start(): void {
    if (this.timer) return;
    this.expected = this.now();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
  }

  /** Disarm the drift watchdog. Idempotent. Anything already detected stays
   *  pending — stopping the detector does not discard a pause. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * The explicit path: a host agent, control plane, or test reporting a known
   * pause duration. Adds to the same accumulator the watchdog feeds, and
   * re-baselines the watchdog so the next tick does not count the same jump a
   * second time. Non-finite and non-positive values are ignored rather than
   * thrown — a bad reading from a transport is not worth crashing a boot over.
   */
  notifyResume(pauseDurationMs: number): void {
    if (!Number.isFinite(pauseDurationMs) || pauseDurationMs <= 0) return;
    this.pendingMs += pauseDurationMs;
    this.expected = this.now();
    this.dispatch();
  }

  /**
   * Hand the accumulated pause to the registered handlers and zero it.
   *
   * EXACTLY ONE of the two delivery paths ever sees a given pause: with
   * handlers registered this drains `pendingMs`, so the later
   * `readPauseOffset()` correctly reports `null` and nothing is corrected
   * twice; with none registered it is a no-op and the pause stays pending for
   * a reader. That keeps the pull path — boot reconciliation on a process that
   * really did cold-boot after a restore — working unchanged.
   */
  private dispatch(): void {
    if (this.handlers.length === 0 || this.pendingMs <= 0) return;
    const pauseDurationMs = this.pendingMs;
    this.pendingMs = 0;
    // A copy: a handler that unsubscribes itself must not reindex the walk.
    for (const handler of [...this.handlers]) {
      try {
        handler(pauseDurationMs);
      } catch {
        // Fail open. A correction target that throws loses its own correction,
        // never the others' — and never the process.
      }
    }
  }

  /**
   * Register a handler to be called the MOMENT a resume is detected, with the
   * pause duration. Returns an unsubscribe function.
   *
   * WHY A PUSH SEAM EXISTS AT ALL, given `readPauseOffset()` already reports
   * the same number. A snapshot-restored guest continues the SAME process
   * image — no reboot, no top-level boot code re-run
   * (plan/phases/single-process-boot-profile.md §1). So the one caller of
   * `readPauseOffset()`, boot reconciliation, has already run to completion
   * long before the pause happens, and would only ever see the cold-boot
   * `null`. A pull-only contract therefore cannot deliver a correction on the
   * exact deployment shape the correction exists for. The detector is the only
   * thing in the process that knows a resume happened; this is how it says so.
   *
   * Handlers must not throw — one bad handler must not cost the others their
   * correction — so each is invoked inside its own try/catch and failures are
   * swallowed, matching the fail-open posture of `HookRegistry.fireVoid`.
   */
  onResume(handler: ResumeHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const i = this.handlers.indexOf(handler);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }

  /**
   * CONSUME-ON-READ. Returns the accumulated pause and zeroes it, so boot
   * reconciliation reads it exactly once and no gate applies the same
   * correction twice. `null` means no pause is pending — the cold-boot answer,
   * identical to `NoopPauseLifecycle`.
   */
  readPauseOffset(): Promise<PauseOffset | null> {
    if (this.pendingMs <= 0) return Promise.resolve(null);
    const pauseDurationMs = this.pendingMs;
    this.pendingMs = 0;
    return Promise.resolve({ pauseDurationMs });
  }

  /**
   * No-op. This class detects resumes; it has no host agent to signal. A
   * deployment with a real host agent supplies its own `PauseLifecycle`.
   */
  signalReadyToSuspend(): Promise<void> {
    return Promise.resolve();
  }

  private tick(): void {
    const actual = this.now();
    const drift = actual - this.expected - this.intervalMs;
    // Re-baseline on EVERY tick, jump or not — otherwise ordinary per-tick
    // scheduler slack compounds until it crosses the threshold on its own.
    this.expected = actual;
    if (drift <= this.thresholdMs) return;
    this.pendingMs += drift;
    this.dispatch();
  }
}
