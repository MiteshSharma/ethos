// Pause HTTP — the outbound half of a snapshot-and-restore deployment
// (plan/phases/idle-watcher.md, plan/phases/clock-tolerance-pass.md §6): tells
// an orchestrator over HTTP that the process is idle and safe to suspend.

import type { PauseLifecycle, PauseOffset } from '@ethosagent/types';

export interface HttpPauseLifecycleOptions {
  url: string;
  token?: string;
  timeoutMs?: number; // default 5_000
  fetchImpl?: typeof fetch; // for tests; defaults to global fetch
}

/**
 * Real outbound half of PauseLifecycle: POSTs to an orchestrator URL when
 * idle-watcher decides the process is safe to suspend. The orchestrator (not
 * this class) decides what happens next — this only signals readiness.
 *
 * readPauseOffset() always resolves null: this class has no way to detect a
 * resume or measure a pause duration. That's ClockDriftPauseLifecycle's job;
 * the two concerns are orthogonal and not composed here (nothing today needs
 * both signalReadyToSuspend and clock-drift correction on the same process).
 *
 * No internal retry/backoff and no logger dependency: IdleWatcherManager's
 * own signalReadyToSuspend wrapper (extensions/idle-watcher/src/index.ts)
 * already catches a thrown error, unlatches, resets the idle streak, logs via
 * its own injected Logger, and retries once the streak re-earns on a later
 * tick. Swallowing a failure here would falsely stop the watcher, so this
 * class throws on ANY failure (non-2xx, network error, timeout) and does
 * nothing else.
 */
export class HttpPauseLifecycle implements PauseLifecycle {
  readonly hostSignalAvailable = true;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpPauseLifecycleOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  /**
   * No-op. This class signals readiness to suspend; it has no way to detect
   * or measure a resume. A deployment needing both pairs this with
   * ClockDriftPauseLifecycle instead.
   */
  readPauseOffset(): Promise<PauseOffset | null> {
    return Promise.resolve(null);
  }

  async signalReadyToSuspend(): Promise<void> {
    const response = await this.fetchImpl(this.options.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`pause-http: orchestrator responded ${response.status}`);
    }
  }
}
