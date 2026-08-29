// Pause lifecycle contract — the two halves of a snapshot-and-restore deployment.
//
// On a Firecracker-style host the guest VM is snapshotted when idle and thawed
// later. The guest's wall clock does not advance while it is paused, so on
// resume every staleness gate in the codebase — delivery-ledger `abandonStale`,
// job-store `reclaimStale`, agent-mesh peer staleness, heartbeat freshness
// windows — sees an arbitrarily large elapsed gap and misreads a pause as a
// crash. `readPauseOffset()` is how a resumed process learns how much of that
// gap was a pause rather than downtime, so those gates can discount it.
//
// `signalReadyToSuspend()` is the outbound half: the guest telling its host
// agent that no work is in flight and it is safe to snapshot. The guest never
// exits itself — the host tears the VM down.
//
// The callers live in two collaborating plans:
// `plan/phases/idle-watcher.md` calls `signalReadyToSuspend`, and
// `plan/phases/single-process-boot-profile.md` calls `readPauseOffset`.
//
// The contract is FROZEN at two methods. Adding a third requires the
// pause-lifecycle-method-count gate in
// __tests__/pause-lifecycle-method-count.test.ts to be bumped in the same
// commit, plus a two-maintainer bump per ARCHITECTURE.md §VII (mirrors
// ContentStore's four-method freeze and MemoryProvider's five). The number is a
// load-bearing schema discipline, not a spec.

/** How much of the elapsed wall-clock gap was a pause, not downtime. */
export interface PauseOffset {
  pauseDurationMs: number;
}

export interface PauseLifecycle {
  /** Called once, early in boot reconciliation. Returns null if this process
   *  was not resumed from a pause, or the duration is unknown — the default,
   *  correct answer for every non-paused deployment. */
  readPauseOffset(): Promise<PauseOffset | null>;

  /** Called by idle-watcher once its predicate is satisfied. The default
   *  implementation is a no-op — nothing to suspend, nowhere to signal. */
  signalReadyToSuspend(): Promise<void>;
}

/**
 * The default. Correct for every deployment that is not running under a
 * snapshotting host — bare metal, docker, a laptop `pnpm dev`. There was no
 * pause to discount and no host agent to signal.
 */
export class NoopPauseLifecycle implements PauseLifecycle {
  readPauseOffset(): Promise<PauseOffset | null> {
    return Promise.resolve(null);
  }

  signalReadyToSuspend(): Promise<void> {
    return Promise.resolve();
  }
}
