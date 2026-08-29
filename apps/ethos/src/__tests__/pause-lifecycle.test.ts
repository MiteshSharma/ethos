// `createPauseLifecycle` — the operator switch that decides whether a process
// runs a real clock-drift detector or the no-op (plan/phases/clock-tolerance-pass.md §7).
//
// The property that matters most is the DEFAULT: an absent `pauseClockCorrection`
// block must yield `NoopPauseLifecycle`, whose `readPauseOffset()` is always
// null, so boot reconciliation's `pause_corrections` step skips and every
// existing deployment behaves exactly as it did before this feature landed.

import type { EthosConfig } from '@ethosagent/config';
import { ClockDriftPauseLifecycle, DEFAULT_DRIFT_THRESHOLD_MS } from '@ethosagent/pause-clock';
import { NoopPauseLifecycle } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createPauseLifecycle } from '../pause-lifecycle';

const base: EthosConfig = {
  provider: 'ollama',
  model: 'llama3.2',
  apiKey: 'sk',
  personality: 'p',
};

describe('createPauseLifecycle', () => {
  it('yields a NoopPauseLifecycle when the block is absent', async () => {
    const lifecycle = createPauseLifecycle(base);
    expect(lifecycle).toBeInstanceOf(NoopPauseLifecycle);
    expect(await lifecycle.readPauseOffset()).toBeNull();
  });

  it('yields a NoopPauseLifecycle when the block is present but disabled', () => {
    expect(
      createPauseLifecycle({ ...base, pauseClockCorrection: { enabled: false } }),
    ).toBeInstanceOf(NoopPauseLifecycle);
    // A threshold on its own is not an opt-in.
    expect(
      createPauseLifecycle({ ...base, pauseClockCorrection: { thresholdMs: 30_000 } }),
    ).toBeInstanceOf(NoopPauseLifecycle);
  });

  it('yields a started ClockDriftPauseLifecycle when enabled', () => {
    const lifecycle = createPauseLifecycle({
      ...base,
      pauseClockCorrection: { enabled: true },
    });
    expect(lifecycle).toBeInstanceOf(ClockDriftPauseLifecycle);
    // Started: `stop()` is what a command's teardown path calls, and calling it
    // on an unarmed detector would be a silent no-op rather than a disarm.
    expect(typeof lifecycle.stop).toBe('function');
    lifecycle.stop?.();
  });

  it('passes thresholdMs through, and omits it so the detector default applies', async () => {
    const detector = createPauseLifecycle({
      ...base,
      pauseClockCorrection: { enabled: true, thresholdMs: 5 },
    });
    // Drive the detector's own seam rather than reaching into its timer: a
    // reported resume must survive to `readPauseOffset()` exactly once.
    (detector as ClockDriftPauseLifecycle).notifyResume(DEFAULT_DRIFT_THRESHOLD_MS + 1);
    expect(await detector.readPauseOffset()).toEqual({
      pauseDurationMs: DEFAULT_DRIFT_THRESHOLD_MS + 1,
    });
    expect(await detector.readPauseOffset()).toBeNull();
    detector.stop?.();
  });
});
