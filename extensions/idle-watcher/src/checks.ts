// Pure predicate logic for the idle watcher (plan/phases/idle-watcher.md §2/§3).
//
// Everything here is a function of its arguments — no timers, no clock, no
// state of its own. The manager owns the clock seam and the polling timer and
// threads `now` in, mirroring how `@ethosagent/watchers` splits its
// deterministic differs (`differs.ts`) from the manager class.

/**
 * One subsystem's busy signal. Every source is a thin closure built at the
 * WIRING site (plan §5) so this package needs no cross-extension imports —
 * structural typing keeps it decoupled the same way `WatcherSchedulerPort`
 * keeps `@ethosagent/watchers` off `@ethosagent/cron`.
 */
export interface BusySource {
  name: string;
  checkBusy(): Promise<{ busy: boolean; reason?: string }>;
}

/** One source's evaluated verdict, always with a reason when busy. */
export interface BusyReport {
  name: string;
  busy: boolean;
  reason?: string;
}

/**
 * One sample of the whole predicate. Structured rather than a bare boolean so
 * "why did/didn't it fire" is answerable (plan §8 OQ7 — debuggability).
 */
export interface IdleSample {
  idle: boolean;
  /** Only the sources that reported busy, each with its reason. */
  busySources: BusyReport[];
}

/**
 * Per-check timeout. A `checkBusy()` that never settles would hang the whole
 * predicate forever, which reads as "still sampling" rather than "busy" — so
 * each call is raced against this bound and a timeout is treated as busy.
 */
export const DEFAULT_CHECK_TIMEOUT_MS = 5_000;

/**
 * Longest delay `setTimeout` can represent (32-bit signed ms, ~24.8 days).
 * Anything larger makes Node emit `TimeoutOverflowWarning` and collapse the
 * delay to ~1ms. Same clamp, same literal, same reason as `MAX_TIMER_MS` in
 * `apps/ethos/src/approval-coordinator.ts` and
 * `apps/web-api/src/services/approvals.service.ts`.
 */
export const MAX_TIMER_MS = 2_147_483_647;

const TIMED_OUT = Symbol('idle-watcher.check-timeout');

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Fail-awake wrapper (plan §2): "unknown is never idle". A source that throws,
 * rejects, or never settles is reported busy with a reason, never skipped.
 * This lives in the manager's control flow rather than in each checker's own
 * code, exactly as §2 requires.
 */
export async function checkSourceFailAwake(
  source: BusySource,
  timeoutMs: number,
): Promise<BusyReport> {
  const boundedMs = Math.min(timeoutMs, MAX_TIMER_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      (async () => source.checkBusy())(),
      new Promise<typeof TIMED_OUT>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(TIMED_OUT), boundedMs);
      }),
    ]);
    if (result === TIMED_OUT) {
      return { name: source.name, busy: true, reason: `check timed out after ${boundedMs}ms` };
    }
    if (!result.busy) return { name: source.name, busy: false };
    return { name: source.name, busy: true, reason: result.reason ?? 'reported busy' };
  } catch (err) {
    return { name: source.name, busy: true, reason: `check threw: ${errorMessage(err)}` };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The conjunction: idle only when EVERY source reports not-busy. Deliberately
 * does NOT short-circuit — the checks are cheap in-process reads, and sampling
 * all of them means the result names every busy subsystem, not just the first.
 */
export async function sampleIdle(
  sources: readonly BusySource[],
  timeoutMs: number,
): Promise<IdleSample> {
  const reports = await Promise.all(sources.map((s) => checkSourceFailAwake(s, timeoutMs)));
  const busySources = reports.filter((r) => r.busy);
  return { idle: busySources.length === 0, busySources };
}

/** Formats an `IdleSample`'s busy set for a log line. */
export function describeBusy(sample: IdleSample): string {
  return sample.busySources.map((r) => `${r.name} (${r.reason ?? 'busy'})`).join(', ');
}

// ---------------------------------------------------------------------------
// Debounce (arming gate 5) and startup cooldown (arming gate 4)
// ---------------------------------------------------------------------------

/** Start of the current continuous-idle run; `null` when the last sample was busy. */
export interface IdleStreak {
  since: number | null;
}

export const NO_STREAK: IdleStreak = { since: null };

/** Fold one sample into the streak. A single busy sample resets it to zero. */
export function advanceStreak(streak: IdleStreak, idle: boolean, now: number): IdleStreak {
  if (!idle) return { since: null };
  return streak.since === null ? { since: now } : streak;
}

/** True once the predicate has been continuously idle for `thresholdMs`. */
export function streakSatisfied(streak: IdleStreak, thresholdMs: number, now: number): boolean {
  return streak.since !== null && now - streak.since >= thresholdMs;
}

/** True once `cooldownMs` has elapsed since `startedAt` — before that the
 *  predicate is not evaluated at all, so a just-woken VM is not immediately
 *  re-suspended before its first message arrives. */
export function cooldownElapsed(startedAt: number, cooldownMs: number, now: number): boolean {
  return now - startedAt >= cooldownMs;
}

// ---------------------------------------------------------------------------
// Arming gates (plan §3)
// ---------------------------------------------------------------------------

/**
 * Which subsystems this deployment has switched on. Gate 2 is a coarse,
 * deployment-level circuit breaker: plan §1 grades cron mid-execution (#7) and
 * voice/call state (#13/#14) as signals that do not exist in ANY form, and §7
 * lists building them as an explicit non-goal — so with either enabled there is
 * no honest predicate to run and the watcher refuses to arm.
 *
 * Deliberately NOT part of `IdleWatcherOptions`: per plan §6 this must not be
 * operator-overridable, because overriding it would just reintroduce the
 * silent-data-loss risk the gate exists to prevent.
 */
export interface IdleWatcherCapabilities {
  cron: boolean;
  voice: boolean;
}

export interface ArmingDecision {
  armed: boolean;
  /** Why arming was refused. Absent when `armed`. */
  reason?: string;
  /** True for the default-off case, which is expected rather than a warning. */
  disabled?: boolean;
}

export function evaluateArming(input: {
  enabled: boolean;
  wakePathConfirmed: boolean;
  hostSignalAvailable: boolean;
  capabilities: IdleWatcherCapabilities;
}): ArmingDecision {
  // Gate 1 — explicit opt-in. Never active by omission.
  if (!input.enabled) {
    return { armed: false, disabled: true, reason: 'idleWatcher.enabled is false' };
  }

  // Gate 2 — unresolved instrumentation gaps.
  const gaps: string[] = [];
  if (input.capabilities.cron) {
    gaps.push('cron mid-execution state (plan §1 check #7) has no signal in any form');
  }
  if (input.capabilities.voice) {
    gaps.push('voice/call session state (plan §1 checks #13/#14) has no queryable signal');
  }
  if (gaps.length > 0) {
    return {
      armed: false,
      reason: `unresolved instrumentation gap in this deployment's active feature set: ${gaps.join('; ')}`,
    };
  }

  // Gate 3 — operator-attested wake path. Trusted at face value, not verified
  // by the watcher (plan §3 gate 3 / OQ5 chose attestation over verification).
  if (!input.wakePathConfirmed) {
    return {
      armed: false,
      reason:
        'idleWatcher.wakePathConfirmed is false — suspending into a VM nothing will unpause is a silent black hole for every future inbound message',
    };
  }

  // Gate 3b — the guest-side half of gate 3. Gate 3 attests that SOMETHING
  // will wake us; this asks whether we can even tell the host we are ready.
  // With a no-op `PauseLifecycle`, `signalReadyToSuspend()` resolves fine, the
  // one-shot latch sets, and the watcher stops — yet nothing was suspended, so
  // the process lives on with the watcher permanently dead. A capability that
  // is not there must read as unavailable, never as a successful handoff.
  // The wiring site owns this boolean, exactly as it owns each `BusySource`;
  // the manager never inspects a concrete lifecycle implementation.
  if (!input.hostSignalAvailable) {
    return {
      armed: false,
      reason:
        'no host suspend signal is wired — the PauseLifecycle in this deployment cannot reach a host, so arming would stop the watcher on a handoff that suspends nothing',
    };
  }

  return { armed: true };
}
