// Which `PauseLifecycle` a long-running command runs with — the operator switch
// behind `pauseClockCorrection` (plan/phases/clock-tolerance-pass.md §7).
//
// ONE INSTANCE PER PROCESS. `readPauseOffset()` is consume-on-read, so two
// instances would mean one of them silently eats the offset and the other
// reports a cold boot. Every site in a command that needs a `PauseLifecycle` —
// boot reconciliation and the idle watcher — takes the same object.

import type { EthosConfig } from '@ethosagent/config';
import { ClockDriftPauseLifecycle } from '@ethosagent/pause-clock';
import { NoopPauseLifecycle, type PauseLifecycle } from '@ethosagent/types';

/**
 * The detector owns a timer; the no-op does not. `stop()` is therefore
 * optional, and callers with a teardown path call it defensively.
 *
 * `onResume` is optional for the same reason, and it is the seam that makes the
 * corrections actually fire: a snapshot-restored guest continues the SAME
 * process image, so `readPauseOffset()` — read once during boot reconciliation,
 * long before any pause — can only ever report the cold-boot `null` on that
 * deployment. The detector is the only thing in the process that observes the
 * resume, and this is how a command subscribes to it. Absent on the no-op,
 * which never has a resume to report.
 */
export type ManagedPauseLifecycle = PauseLifecycle & {
  stop?(): void;
  onResume?(handler: (pauseDurationMs: number) => void): () => void;
};

/**
 * Off by default, and off by omission: an absent `pauseClockCorrection` block
 * yields `NoopPauseLifecycle`, whose `readPauseOffset()` is always null — today's
 * behaviour, unchanged, for every deployment that is not snapshot-and-restored.
 *
 * When enabled, the returned detector is already STARTED: it has to be sampling
 * the wall clock from boot for a later jump to be attributable to a pause.
 */
export function createPauseLifecycle(config: EthosConfig): ManagedPauseLifecycle {
  if (config.pauseClockCorrection?.enabled !== true) return new NoopPauseLifecycle();
  const { thresholdMs } = config.pauseClockCorrection;
  const lifecycle = new ClockDriftPauseLifecycle(thresholdMs !== undefined ? { thresholdMs } : {});
  lifecycle.start();
  return lifecycle;
}
