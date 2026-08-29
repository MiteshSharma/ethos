// Which `PauseLifecycle` a long-running command runs with — the operator switch
// behind `pauseClockCorrection` (plan/phases/clock-tolerance-pass.md §7), plus
// the HTTP-signaled variant (`pauseLifecycle.http`) for hosts that need an
// explicit ready-to-suspend call rather than clock-drift detection.
//
// ONE INSTANCE PER PROCESS. `readPauseOffset()` is consume-on-read, so two
// instances would mean one of them silently eats the offset and the other
// reports a cold boot. Every site in a command that needs a `PauseLifecycle` —
// boot reconciliation and the idle watcher — takes the same object.

import type { EthosConfig } from '@ethosagent/config';
import { ClockDriftPauseLifecycle } from '@ethosagent/pause-clock';
import { HttpPauseLifecycle } from '@ethosagent/pause-http';
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
  hostSignalAvailable?: boolean;
};

/**
 * Wraps `NoopPauseLifecycle` purely to make its `signalReadyToSuspend()`
 * observable. Lives in `apps/ethos/src/` — an app-entry module, where
 * `console.*` is explicitly allowed (unlike library/extension code).
 */
class ObservableNoopPauseLifecycle extends NoopPauseLifecycle {
  override async signalReadyToSuspend(): Promise<void> {
    console.log(
      '[pause-lifecycle] idle-watcher signaled ready-to-suspend (noop — no host wired, nothing will actually suspend)',
    );
    return super.signalReadyToSuspend();
  }
}

/**
 * Off by default, and off by omission: an absent `pauseClockCorrection` block
 * yields `ObservableNoopPauseLifecycle`, whose `readPauseOffset()` is always null
 * — today's behaviour, unchanged, for every deployment that is not
 * snapshot-and-restored.
 *
 * `pauseLifecycle.http` is checked first — it's orthogonal to clock-drift
 * detection and no deployment needs both today, so first-match-wins is simplest.
 *
 * When clock-drift correction is enabled, the returned detector is already
 * STARTED: it has to be sampling the wall clock from boot for a later jump to
 * be attributable to a pause.
 */
export function createPauseLifecycle(config: EthosConfig): ManagedPauseLifecycle {
  const http = config.pauseLifecycle?.http;
  if (http?.enabled === true) {
    if (!http.url) {
      throw new Error('pauseLifecycle.http.enabled is true but pauseLifecycle.http.url is not set');
    }
    return new HttpPauseLifecycle({ url: http.url, token: http.token, timeoutMs: http.timeoutMs });
  }
  if (config.pauseClockCorrection?.enabled !== true) return new ObservableNoopPauseLifecycle();
  const { thresholdMs } = config.pauseClockCorrection;
  const lifecycle = new ClockDriftPauseLifecycle(thresholdMs !== undefined ? { thresholdMs } : {});
  lifecycle.start();
  return lifecycle;
}
