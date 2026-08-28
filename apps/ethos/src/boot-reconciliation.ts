// Boot-time reconciliation — the named, re-invocable entry point from
// plan/phases/single-process-boot-profile.md §4.
//
// Today reconciliation is split across `ethos gateway start` and `ethos serve`,
// and each is missing work the other does (plan §1). This module is the single
// composition of those steps: one function, taking already-constructed objects,
// callable a second time without reconstructing anything — which is what a
// future snapshot/restore resume handler needs (plan §4c).
//
// It deliberately lives here rather than in `commands/boot.ts` (the location the
// plan names): `serve.ts`, `gateway.ts`, the future `boot.ts` and a future
// resume handler all need to import it, so it is a standalone module rather
// than a member of any one command's file.

import type { Logger, PauseLifecycle, PauseOffset } from '@ethosagent/types';

/** One reconciliation step, in the order `runBootReconciliation` runs them. */
export type BootReconciliationStep =
  | 'pause_offset'
  | 'clarify_hydrate'
  | 'clarify_sweep'
  | 'a2a_fail_non_terminal'
  | 'sweep_pending_deliveries'
  | 'sweep_undelivered_jobs'
  | 'background_boot_sweep'
  | 'cron_fire';

/** `skipped` means the dependency for that step was not supplied. */
export type BootReconciliationStepOutcome = 'ok' | 'skipped' | 'failed';

const STEP_ORDER: readonly BootReconciliationStep[] = [
  'pause_offset',
  'clarify_hydrate',
  'clarify_sweep',
  'a2a_fail_non_terminal',
  'sweep_pending_deliveries',
  'sweep_undelivered_jobs',
  'background_boot_sweep',
  'cron_fire',
];

/**
 * Every dependency is optional because the two roles hold different subsystems:
 * `serve` has an A2A task store and no `Gateway`; `gateway` has a `Gateway` and
 * no A2A store. A missing dependency means that step is SKIPPED, not failed.
 *
 * Structural types only — this module imports no concrete class, so it stays
 * callable from either command without dragging either one's dependency graph
 * in. Return types are widened where the real implementations return a count or
 * a summary object rather than `void` (see the notes on each field).
 */
export interface BootReconciliationDeps {
  /** `CronEngine` — `extensions/cron/src/index.ts:446` (`CronScheduler.fire`). */
  cronEngine?: { fire(): Promise<void> | void };
  /** `BackgroundExecutor.bootSweep` — `extensions/job-runner/src/index.ts:442`.
   *  NOTE: that method is currently `private`, so the real executor is not
   *  assignable to this shape until it is made public. */
  backgroundExecutor?: { bootSweep(): Promise<void> };
  /**
   * Gateway-side (per bot) and web-api-side clarify bridges.
   *
   * `ClarifyBridge.hydrate()` (`packages/core/src/clarify/clarify-bridge.ts`)
   * is safe to re-invoke: it re-reads the persisted rows on every call and
   * adopts only those it is not already holding, so a second call retries
   * after a failure and picks up rows persisted since the last one.
   */
  clarifyBridges?: { hydrate(): Promise<void>; sweep?(): Promise<void> }[];
  /** `A2aTaskStore.failNonTerminal` — returns the number of rows reconciled
   *  (`packages/a2a/src/sqlite-task-store.ts:236`), hence `Promise<unknown>`. */
  a2aTaskStore?: { failNonTerminal(reason: string): Promise<unknown> };
  /** Both sweeps return a `{ ... }` summary (`extensions/gateway/src/index.ts:3098,3344`),
   *  hence `Promise<unknown>`. */
  gateway?: {
    sweepPendingDeliveries(): Promise<unknown>;
    sweepUndeliveredJobs(): Promise<unknown>;
  };
  /** Read once, first, to learn whether this process was resumed from a pause. */
  pauseLifecycle?: PauseLifecycle;
  logger?: Logger;
}

export interface BootReconciliationResult {
  /** Non-null iff this process was resumed from a pause rather than cold-booted. */
  pauseOffset: PauseOffset | null;
  steps: Record<BootReconciliationStep, BootReconciliationStepOutcome>;
}

const FAIL_NON_TERMINAL_REASON = 'boot reconciliation';

/**
 * Run every boot-time reconciliation step whose dependency is supplied.
 *
 * **Ordering** follows plan §4b: pause offset, clarify hydrate, clarify sweep,
 * A2A `failNonTerminal`, pending-delivery sweep, undelivered-job sweep,
 * background boot sweep, cron fire.
 *
 * **Precondition (caller's responsibility, not enforced here):** the delivery
 * sweeps redeliver through live channel adapters, so the caller must have
 * started its adapters before calling — the same deliberate ordering
 * `gateway.ts` already encodes (plan §3b step 9).
 *
 * **Fail-open, per step.** Each step is wrapped in its own try/catch, logs a
 * warning naming the step, and execution continues to the next one. This
 * function never rejects. It preserves today's semantics exactly: the existing
 * call sites are fire-and-forget on purpose — `gateway.ts`'s hydrate is
 * `void ...hydrate().catch(() => {})` under the comment "Best-effort: a
 * hydration failure must not block gateway startup", and both sweeps are
 * `void gateway.<sweep>()...catch(err => logger.warn(...))`. Awaiting and
 * propagating would turn one flaky hydration into a total boot failure
 * (plan §4a). The per-step outcome record is how a caller sees what failed.
 *
 * **Pause offset is surfaced, not consumed.** A non-null offset means the
 * process was resumed from a snapshot; under snapshot+restore the process image
 * continues and no boot code re-runs, so this read is the only signal a resume
 * happened. This function does NOT correct any staleness gate with it —
 * `plan/phases/vm-lifecycle-pause-resume.md` §4 catalogues seven wall-clock
 * gates a long pause corrupts (delivery-ledger `abandonStale`, job-store
 * `reclaimStale`, agent-mesh peer staleness, heartbeat freshness windows) and
 * choosing a correction mechanism is an open question in that plan. Do not
 * assume those gates are handled because the offset was read here.
 *
 * **Second-call behaviour of the underlying steps** (verified against source):
 * cron `fire()` re-checks each job's `nextRunAt` under a compare-and-swap claim
 * (`extensions/cron/src/index.ts:1133-1152`); `bootSweep()`'s `reclaimStale`/
 * `expireQueued` are threshold-filtered UPDATEs and its `claimLoop` is
 * re-entrancy guarded (`extensions/job-runner/src/index.ts:479-503`);
 * `failNonTerminal` and both gateway sweeps select only rows in a specific
 * state and claim them atomically. `ClarifyBridge.hydrate()` is idempotent by
 * construction rather than by a latch — it re-reads the persisted rows each
 * call and adopts only those not already pending — so a second invocation both
 * retries a failed first one and picks up rows persisted since it.
 */
export async function runBootReconciliation(
  deps: BootReconciliationDeps,
): Promise<BootReconciliationResult> {
  const { logger } = deps;
  const steps = Object.fromEntries(
    STEP_ORDER.map((name) => [name, 'skipped' as BootReconciliationStepOutcome]),
  ) as Record<BootReconciliationStep, BootReconciliationStepOutcome>;

  const step = async (name: BootReconciliationStep, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
      steps[name] = 'ok';
    } catch (err) {
      steps[name] = 'failed';
      logger?.warn(`[boot-reconciliation] step "${name}" failed`, {
        component: 'boot-reconciliation',
        step: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  /**
   * Bridge steps settle every bridge INDEPENDENTLY. Under `Promise.all` one
   * rejection both hides whether the other bridges ran and marks the whole
   * step failed, so a single flaky bot is indistinguishable from every bot
   * failing. Each failure is logged naming its bridge; the step is `'failed'`
   * if ANY bridge failed — never `'ok'` on a partial failure — and `'ok'` only
   * when all of them succeeded.
   */
  const settleBridges = async (
    name: BootReconciliationStep,
    ops: readonly (() => Promise<void>)[],
  ): Promise<BootReconciliationStepOutcome> => {
    const results = await Promise.allSettled(ops.map(async (op) => op()));
    let failed = 0;
    results.forEach((result, index) => {
      if (result.status !== 'rejected') return;
      failed++;
      logger?.warn(`[boot-reconciliation] step "${name}" failed for bridge ${index}`, {
        component: 'boot-reconciliation',
        step: name,
        bridge: index,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });
    return failed > 0 ? 'failed' : 'ok';
  };

  let pauseOffset: PauseOffset | null = null;
  const { pauseLifecycle } = deps;
  if (pauseLifecycle) {
    await step('pause_offset', async () => {
      const offset = await pauseLifecycle.readPauseOffset();
      pauseOffset = offset;
      if (offset !== null) {
        logger?.info('[boot-reconciliation] resumed from pause', {
          component: 'boot-reconciliation',
          pauseDurationMs: offset.pauseDurationMs,
        });
      }
    });
  }

  const bridges = deps.clarifyBridges ?? [];
  if (bridges.length > 0) {
    steps.clarify_hydrate = await settleBridges(
      'clarify_hydrate',
      bridges.map((b) => () => b.hydrate()),
    );
  }
  const sweepable = bridges.filter((b) => b.sweep !== undefined);
  if (sweepable.length > 0) {
    steps.clarify_sweep = await settleBridges(
      'clarify_sweep',
      sweepable.map((b) => async () => {
        await b.sweep?.();
      }),
    );
  }

  const { a2aTaskStore } = deps;
  if (a2aTaskStore) {
    await step('a2a_fail_non_terminal', () =>
      a2aTaskStore.failNonTerminal(FAIL_NON_TERMINAL_REASON),
    );
  }

  const { gateway } = deps;
  if (gateway) {
    await step('sweep_pending_deliveries', () => gateway.sweepPendingDeliveries());
    await step('sweep_undelivered_jobs', () => gateway.sweepUndeliveredJobs());
  }

  const { backgroundExecutor } = deps;
  if (backgroundExecutor) {
    await step('background_boot_sweep', () => backgroundExecutor.bootSweep());
  }

  const { cronEngine } = deps;
  if (cronEngine) {
    await step('cron_fire', async () => cronEngine.fire());
  }

  return { pauseOffset, steps };
}
