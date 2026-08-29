// Idle watcher — the aggregator that answers "is any work in flight in this
// process?" for a snapshot-and-restore host (plan/phases/idle-watcher.md).
//
// The predicate is a conjunction of independent per-subsystem busy checks. Each
// check is a thin `BusySource` closure built at the WIRING site (plan §5), so
// this package has ZERO cross-extension imports — the same structural-port
// decoupling `WatcherSchedulerPort` gives `@ethosagent/watchers`.
//
// Anything the watcher cannot confirm idle is treated as busy (§2), and it
// refuses to arm at all unless every operator gate holds (§3).

import { noopLogger } from '@ethosagent/logger';
import type { Logger, PauseLifecycle } from '@ethosagent/types';
import {
  advanceStreak,
  type BusySource,
  cooldownElapsed,
  DEFAULT_CHECK_TIMEOUT_MS,
  describeBusy,
  evaluateArming,
  type IdleStreak,
  type IdleWatcherCapabilities,
  MAX_TIMER_MS,
  NO_STREAK,
  sampleIdle,
  streakSatisfied,
} from './checks';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export const DEFAULT_IDLE_THRESHOLD_MS = 120_000;
export const DEFAULT_STARTUP_COOLDOWN_MS = 30_000;
export const DEFAULT_CHECK_INTERVAL_MS = 15_000;

/**
 * Operator-tunable settings. Mirrors the `idleWatcher:` block sketched in plan
 * §6 one-for-one so the later config wiring is a direct mapping. Note there is
 * deliberately no key here for the §3 gate-2 instrumentation check — that lives
 * on `IdleWatcherCapabilities` and is not overridable.
 */
export interface IdleWatcherOptions {
  /** Arming gate 1 — explicit opt-in. Default `false`; never on by omission. */
  enabled?: boolean;
  /** Arming gate 5 — continuous idle required before the exit action fires. */
  idleThresholdMs?: number;
  /** Arming gate 4 — no evaluation at all for this long after `start()`. */
  startupCooldownMs?: number;
  /** How often the predicate is sampled. */
  checkIntervalMs?: number;
  /** Arming gate 3 — operator attestation that a wake path exists. */
  wakePathConfirmed?: boolean;
  /**
   * Per-check bound. Not in plan §6's block: a `checkBusy()` that never settles
   * would hang the predicate, so each call is raced against this and a timeout
   * counts as busy (§2 fail-awake).
   */
  checkTimeoutMs?: number;
}

export interface IdleWatcherManagerConfig {
  /** One closure per subsystem, built at the wiring site. */
  sources: readonly BusySource[];
  /** The exit action's destination — the guest signals, the host suspends. */
  pauseLifecycle: PauseLifecycle;
  /** Which gap-bearing subsystems this deployment enables (arming gate 2). */
  capabilities: IdleWatcherCapabilities;
  /**
   * Arming gate 3b — whether `pauseLifecycle` can actually reach a host. Stated
   * by the WIRING site, like every `BusySource`, so the manager never has to
   * recognise a concrete implementation. `false` while the only lifecycle is a
   * no-op: signalling one succeeds and suspends nothing, which would stop the
   * watcher for the rest of the process's life. Required, not defaulted — a
   * deployment must say which it is.
   */
  hostSignalAvailable: boolean;
  options?: IdleWatcherOptions;
  logger?: Logger;
  /** Clock seam. Defaults to `Date.now`. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// IdleWatcherManager
// ---------------------------------------------------------------------------

export class IdleWatcherManager {
  private readonly sources: readonly BusySource[];
  private readonly pauseLifecycle: PauseLifecycle;
  private readonly capabilities: IdleWatcherCapabilities;
  private readonly hostSignalAvailable: boolean;
  private readonly enabled: boolean;
  private readonly idleThresholdMs: number;
  private readonly startupCooldownMs: number;
  private readonly checkIntervalMs: number;
  private readonly wakePathConfirmed: boolean;
  private readonly checkTimeoutMs: number;
  private readonly logger: Logger;
  private readonly now: () => number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private streak: IdleStreak = NO_STREAK;
  private sampling = false;
  /** Latched once the host has been told we are ready to suspend. */
  private signalled = false;

  constructor(config: IdleWatcherManagerConfig) {
    const opts = config.options ?? {};
    this.sources = config.sources;
    this.pauseLifecycle = config.pauseLifecycle;
    this.capabilities = config.capabilities;
    this.hostSignalAvailable = config.hostSignalAvailable;
    this.enabled = opts.enabled ?? false;
    this.idleThresholdMs = opts.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
    this.startupCooldownMs = opts.startupCooldownMs ?? DEFAULT_STARTUP_COOLDOWN_MS;
    // `checkIntervalMs` is a `setInterval` argument and the config layer bounds
    // it only from below, so clamp it here: above `MAX_TIMER_MS` Node collapses
    // the delay to ~1ms and the poller becomes a ~1kHz loop over SQLite and the
    // teams PID dir. Same clamp the approval timers already use — see
    // `MAX_TIMER_MS` in `apps/ethos/src/approval-coordinator.ts`.
    this.checkIntervalMs = Math.min(
      opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
      MAX_TIMER_MS,
    );
    this.wakePathConfirmed = opts.wakePathConfirmed ?? false;
    this.checkTimeoutMs = opts.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    this.logger = config.logger ?? noopLogger;
    this.now = config.now ?? Date.now;
  }

  /** True while the polling timer is armed. */
  isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * Evaluate the arming gates and, if all hold, start polling. A no-op when
   * already started, and a no-op (not a throw) when a gate refuses — a refusal
   * is a deployment fact, not a caller error.
   */
  start(): void {
    if (this.timer !== null) return;

    const decision = evaluateArming({
      enabled: this.enabled,
      wakePathConfirmed: this.wakePathConfirmed,
      hostSignalAvailable: this.hostSignalAvailable,
      capabilities: this.capabilities,
    });
    if (!decision.armed) {
      // Gate 1 (default-off) is the expected state everywhere but a microVM
      // host, so it is quiet. A gate 2/3/3b refusal means the operator asked
      // for this and cannot have it — that is loud.
      const message = `[idle-watcher] not arming: ${decision.reason}`;
      if (decision.disabled) {
        this.logger.debug(message, { component: 'idle-watcher' });
      } else {
        this.logger.warn(message, { component: 'idle-watcher', reason: decision.reason });
      }
      return;
    }

    this.startedAt = this.now();
    this.streak = NO_STREAK;
    this.signalled = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.checkIntervalMs);
    // Never hold the process open on this subsystem's account.
    this.timer.unref?.();
    this.logger.info('[idle-watcher] armed', {
      component: 'idle-watcher',
      sources: this.sources.length,
      idleThresholdMs: this.idleThresholdMs,
      startupCooldownMs: this.startupCooldownMs,
      checkIntervalMs: this.checkIntervalMs,
    });
  }

  /** Stop polling. Safe before `start()` and safe to call twice. */
  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One sample. Exposed for tests and for a future ops surface (plan §8 OQ7);
   * the interval drives it in production.
   */
  async tick(): Promise<void> {
    if (this.signalled) return;
    // Overlapping samples would double-count the streak and could fire the
    // exit action twice.
    if (this.sampling) return;
    // Arming gate 4 — startup cooldown. No evaluation at all before it elapses.
    if (!cooldownElapsed(this.startedAt, this.startupCooldownMs, this.now())) return;

    this.sampling = true;
    try {
      const sample = await sampleIdle(this.sources, this.checkTimeoutMs);
      // `stop()` may have landed while the sample was in flight.
      if (this.timer === null || this.signalled) return;

      this.streak = advanceStreak(this.streak, sample.idle, this.now());
      if (!sample.idle) {
        this.logger.debug(`[idle-watcher] busy: ${describeBusy(sample)}`, {
          component: 'idle-watcher',
          busySources: sample.busySources.map((r) => r.name),
        });
        return;
      }
      // Arming gate 5 — debounce. A single idle sample is not enough.
      if (!streakSatisfied(this.streak, this.idleThresholdMs, this.now())) return;
      await this.signalReadyToSuspend();
    } finally {
      this.sampling = false;
    }
  }

  private async signalReadyToSuspend(): Promise<void> {
    // Latch BEFORE awaiting so nothing can fire the action twice.
    this.signalled = true;
    this.logger.info('[idle-watcher] idle threshold met — signalling ready to suspend', {
      component: 'idle-watcher',
      idleThresholdMs: this.idleThresholdMs,
    });
    try {
      // THE EXIT ACTION IS `signalReadyToSuspend()`, NEVER `process.exit(0)`.
      //
      // plan/phases/idle-watcher.md §4 says `process.exit(0)`; that text is
      // STALE and has been overridden. Under the snapshot+terminate+load host
      // in plan/phases/vm-lifecycle-pause-resume.md the guest signals readiness
      // and the HOST tears the VM down — a guest that exits itself destroys the
      // very process that was supposed to be snapshotted. Do not "fix" this
      // back to the plan's wording.
      await this.pauseLifecycle.signalReadyToSuspend();
    } catch (err) {
      // A failed handoff must be retried, or the VM never suspends. Unlatch and
      // make the full debounce window be re-earned from scratch.
      this.signalled = false;
      this.streak = NO_STREAK;
      this.logger.error('[idle-watcher] signalReadyToSuspend failed — will retry', {
        component: 'idle-watcher',
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    // Latch and stop. The handoff is one-shot: the host now owns this VM's
    // fate and may snapshot it at any moment, so re-signalling on every
    // subsequent tick is noise at best and a double-suspend request at worst.
    // `start()` is the ONE re-arm path: it clears this latch and resets the
    // streak and cooldown. But a snapshot-resumed VM continues the SAME
    // process image — no reboot, no top-level boot code re-run
    // (plan/phases/single-process-boot-profile.md §1) — so nothing calls
    // `start()` on its own. The resume handler (`runBootReconciliation()`,
    // driven by `PauseLifecycle.readPauseOffset()` returning non-null) MUST
    // call `start()` again, or the VM suspends exactly once and never after.
    this.stop();
  }
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type {
  ArmingDecision,
  BusyReport,
  BusySource,
  IdleSample,
  IdleStreak,
  IdleWatcherCapabilities,
} from './checks';
export {
  advanceStreak,
  checkSourceFailAwake,
  cooldownElapsed,
  DEFAULT_CHECK_TIMEOUT_MS,
  describeBusy,
  evaluateArming,
  NO_STREAK,
  sampleIdle,
  streakSatisfied,
} from './checks';
