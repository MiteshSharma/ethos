// The resume-boundary correction fanout (plan/phases/clock-tolerance-pass.md §3/§4).
//
// TWO CALLERS, ONE IMPLEMENTATION, AND THE SECOND IS THE ONE THAT MATTERS.
//
//  - `runBootReconciliation()` calls this at boot, for a process that cold-booted
//    after a restore and learns about the pause from `readPauseOffset()`.
//  - Every long-running command registers `onResume` on the clock-drift detector
//    and calls this MID-RUN. A snapshot-restored guest continues the same process
//    image — no reboot, no top-level boot code re-run
//    (plan/phases/single-process-boot-profile.md §1) — so boot reconciliation has
//    already finished long before the pause happens and would only ever see the
//    cold-boot `null`. Without the mid-run path the corrections never fire on the
//    exact deployment shape they exist for.
//
// The targets are structural and each optional, because the three long-running
// commands hold different subsystems: only `ethos gateway start` builds a
// `DreamExecutor`, only `ethos serve` runs the kanban poll loop, and the merged
// `ethos boot` profile builds neither. An unsupplied target is skipped, never
// constructed on demand — a correction pass must not be the thing that brings a
// second writer to a store nothing else in the process is using.

import type { Logger } from '@ethosagent/types';

/**
 * Everything a resumed process can correct. Every field optional: a caller
 * supplies what it actually holds, and the empty case is a no-op.
 */
export interface PauseCorrectionTargets {
  /** Gate #5 — `reclaimStale` reads `heartbeat_at`. */
  jobStore?: { bumpRunningHeartbeats(pauseDurationMs: number): Promise<number> };
  /** Gates #6/#7 — `findStalledRuns` / `findStaleRunningTasks`. The highest-stakes
   *  gate in the inventory: an uncorrected reclaim burns real retry budget (§3.1). */
  kanbanStore?: { bumpActiveHeartbeats(pauseDurationMs: number): number };
  /**
   * Gate #9 — the 30-day pending-candidate TTL, whose expiry is an auto-REJECT.
   *
   * KNOWINGLY UNSUPPLIED BY EVERY COMMAND TODAY. This field exists and works —
   * `runBootReconciliation` will correct a store handed to it — but no command
   * passes one, so a resume does NOT currently discount this gate. That is a
   * deliberate call, not an oversight, and the reason is instance topology:
   * `pauseOffsetMs` is per-instance in-memory state, and a process holds up to
   * two `PendingMemoryStore`s per agent loop (the capture path in
   * `build-agent-loop.ts` and the gated-memory path in `memory-backend.ts`)
   * times one loop per bot. Correcting it therefore means returning every live
   * instance out through `createAgentLoop` and aggregating them here — a change
   * to `packages/wiring`'s public return shape across two construction sites,
   * where missing one leaves the gate half-protected and silent about it.
   *
   * Weighed against the exposure: this is the mildest gate in the inventory. The
   * threshold is 30 DAYS, so only a pause of days trips it at all, and the
   * consequence is one memory candidate auto-rejected early — not burned retry
   * budget (#7) or spent API cost (#12). Revisit if the TTL ever shortens, or if
   * `createAgentLoop` grows a store registry for another reason.
   */
  pendingMemoryStore?: { applyPauseOffset(pauseDurationMs: number): void };
  /** Gate #12 — the idle trigger, the one gate that spends real API cost when
   *  it misfires rather than merely misclassifying. */
  dreamExecutor?: { applyPauseOffset(pauseDurationMs: number): void };
  /** Gate #2 — the delivery-ledger `abandonStale` cutoff. */
  gateway?: { applyPauseOffset?(pauseDurationMs: number): void };
}

/**
 * Narrow a `JobStore` to the pause-correction entry point the concrete
 * `SQLiteJobStore` carries.
 *
 * Duck-typed rather than `instanceof`-checked because `@ethosagent/job-store` is
 * deliberately NOT a dependency of this app — `createAgentLoop` hands back the
 * narrow `JobStore` contract, which has no correction method, while the object
 * behind it does. A backend without the method is simply skipped rather than
 * failing the whole pass.
 */
export function hasHeartbeatBump(
  store: unknown,
): store is NonNullable<PauseCorrectionTargets['jobStore']> {
  if (typeof store !== 'object' || store === null) return false;
  return typeof (store as { bumpRunningHeartbeats?: unknown }).bumpRunningHeartbeats === 'function';
}

/** One correction, labelled so a failure names the subsystem that lost it. */
export interface PauseCorrectionTarget {
  label: string;
  run: () => Promise<void>;
}

/**
 * Resolve the supplied targets into a runnable list, in a fixed order: the
 * stores whose sweeps run soonest after a resume come first, so a slow target
 * later in the list cannot delay one whose gate is about to fire.
 *
 * Split out from `applyPauseCorrections` so `runBootReconciliation` can feed the
 * same list through its own `settleTargets` step accounting instead of
 * duplicating the target construction.
 */
export function buildPauseCorrectionTargets(
  targets: PauseCorrectionTargets,
  pauseDurationMs: number,
): PauseCorrectionTarget[] {
  const { jobStore, kanbanStore, pendingMemoryStore, dreamExecutor } = targets;
  // Bound to the owner now: a caller may hand us a plain object literal, and an
  // unbound method would lose `this` when invoked from the closure below.
  const gatewayApply = targets.gateway?.applyPauseOffset?.bind(targets.gateway);
  const resolved: PauseCorrectionTarget[] = [];
  if (jobStore) {
    resolved.push({
      label: 'jobStore',
      run: async () => {
        await jobStore.bumpRunningHeartbeats(pauseDurationMs);
      },
    });
  }
  if (kanbanStore) {
    resolved.push({
      label: 'kanbanStore',
      run: async () => {
        kanbanStore.bumpActiveHeartbeats(pauseDurationMs);
      },
    });
  }
  if (pendingMemoryStore) {
    resolved.push({
      label: 'pendingMemoryStore',
      run: async () => {
        pendingMemoryStore.applyPauseOffset(pauseDurationMs);
      },
    });
  }
  if (dreamExecutor) {
    resolved.push({
      label: 'dreamExecutor',
      run: async () => {
        dreamExecutor.applyPauseOffset(pauseDurationMs);
      },
    });
  }
  if (gatewayApply) {
    resolved.push({
      label: 'gateway',
      run: async () => {
        gatewayApply(pauseDurationMs);
      },
    });
  }
  return resolved;
}

/**
 * Apply every supplied correction. Used by the MID-RUN resume path; boot
 * reconciliation runs the same targets through its own step accounting.
 *
 * FAIL-OPEN, per target. `Promise.allSettled` rather than `Promise.all`: one
 * store that throws must not deny every other store its correction, and must
 * never reject into an `onResume` handler where nothing would catch it. A
 * failure is logged naming the subsystem, and the rest still apply.
 *
 * Returns the labels that were actually corrected, for the caller's log line.
 */
export async function applyPauseCorrections(
  targets: PauseCorrectionTargets,
  pauseDurationMs: number,
  logger?: Logger,
  component = 'pause-corrections',
): Promise<string[]> {
  const resolved = buildPauseCorrectionTargets(targets, pauseDurationMs);
  if (resolved.length === 0) return [];
  const results = await Promise.allSettled(resolved.map(async (t) => t.run()));
  const applied: string[] = [];
  results.forEach((result, index) => {
    const label = resolved[index]?.label ?? String(index);
    if (result.status === 'rejected') {
      logger?.warn(`[${component}] correction failed for ${label}`, {
        component,
        target: label,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
      return;
    }
    applied.push(label);
  });
  logger?.info(`[${component}] applied pause corrections`, {
    component,
    pauseDurationMs,
    targets: applied,
  });
  return applied;
}
