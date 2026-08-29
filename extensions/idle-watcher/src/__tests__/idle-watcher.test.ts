import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  advanceStreak,
  type BusySource,
  checkSourceFailAwake,
  cooldownElapsed,
  evaluateArming,
  type IdleWatcherCapabilities,
  IdleWatcherManager,
  type IdleWatcherManagerConfig,
  type IdleWatcherOptions,
  NO_STREAK,
  sampleIdle,
  streakSatisfied,
} from '../index';

const IDLE_THRESHOLD_MS = 120_000;
const COOLDOWN_MS = 30_000;
const INTERVAL_MS = 15_000;

function idleSource(name: string): BusySource {
  return { name, checkBusy: async () => ({ busy: false }) };
}

function busySource(name: string, reason?: string): BusySource {
  return { name, checkBusy: async () => ({ busy: true, ...(reason ? { reason } : {}) }) };
}

interface Harness {
  manager: IdleWatcherManager;
  /** Mutable — read after advancing timers. */
  signals: number;
  /** Set to make the next `signalReadyToSuspend()` reject. */
  signalFailure: { err?: Error };
}

function makeHarness(
  sources: BusySource[],
  overrides: {
    options?: Partial<IdleWatcherOptions>;
    capabilities?: Partial<IdleWatcherCapabilities>;
    hostSignalAvailable?: boolean;
    logger?: IdleWatcherManagerConfig['logger'];
  } = {},
): Harness {
  const h: Harness = {
    manager: undefined as unknown as IdleWatcherManager,
    signals: 0,
    signalFailure: {},
  };
  h.manager = new IdleWatcherManager({
    sources,
    capabilities: { cron: false, voice: false, ...overrides.capabilities },
    hostSignalAvailable: overrides.hostSignalAvailable ?? true,
    pauseLifecycle: {
      readPauseOffset: async () => null,
      signalReadyToSuspend: async () => {
        h.signals += 1;
        if (h.signalFailure.err) throw h.signalFailure.err;
      },
    },
    options: {
      enabled: true,
      wakePathConfirmed: true,
      idleThresholdMs: IDLE_THRESHOLD_MS,
      startupCooldownMs: COOLDOWN_MS,
      checkIntervalMs: INTERVAL_MS,
      ...overrides.options,
    },
    ...(overrides.logger ? { logger: overrides.logger } : {}),
  });
  return h;
}

/** Advance fake timers by `ms`, flushing the async work each interval fires. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Pure predicate — conjunction
// ---------------------------------------------------------------------------

describe('sampleIdle — conjunction', () => {
  it('reports idle when every source reports not-busy', async () => {
    const sample = await sampleIdle([idleSource('a'), idleSource('b')], 1000);
    expect(sample.idle).toBe(true);
    expect(sample.busySources).toEqual([]);
  });

  it('reports busy when any single source is busy, and names that source', async () => {
    const sample = await sampleIdle(
      [idleSource('gateway-turns'), busySource('jobs', '2 running'), idleSource('approvals')],
      1000,
    );
    expect(sample.idle).toBe(false);
    expect(sample.busySources).toEqual([{ name: 'jobs', busy: true, reason: '2 running' }]);
  });

  it('names every busy source, not just the first', async () => {
    const sample = await sampleIdle([busySource('a', 'x'), busySource('b', 'y')], 1000);
    expect(sample.busySources.map((r) => r.name)).toEqual(['a', 'b']);
  });

  it('supplies a default reason when a busy source omits one', async () => {
    const sample = await sampleIdle([busySource('a')], 1000);
    expect(sample.busySources[0]?.reason).toBe('reported busy');
  });

  it('is idle with no sources at all', async () => {
    const sample = await sampleIdle([], 1000);
    expect(sample.idle).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fail-awake
// ---------------------------------------------------------------------------

describe('fail-awake', () => {
  it('treats a source that throws synchronously as busy', async () => {
    const source: BusySource = {
      name: 'thrower',
      checkBusy: () => {
        throw new Error('boom');
      },
    };
    const report = await checkSourceFailAwake(source, 1000);
    expect(report.busy).toBe(true);
    expect(report.reason).toBe('check threw: boom');
  });

  it('treats a source that rejects as busy', async () => {
    const source: BusySource = {
      name: 'rejector',
      checkBusy: () => Promise.reject(new Error('unreachable')),
    };
    const report = await checkSourceFailAwake(source, 1000);
    expect(report.busy).toBe(true);
    expect(report.reason).toBe('check threw: unreachable');
  });

  it('treats a source that never settles as busy via the timeout', async () => {
    const source: BusySource = { name: 'hanger', checkBusy: () => new Promise(() => {}) };
    const pending = checkSourceFailAwake(source, 5000);
    await advance(5000);
    const report = await pending;
    expect(report.busy).toBe(true);
    expect(report.reason).toBe('check timed out after 5000ms');
  });

  it('a single failing source makes the whole conjunction busy', async () => {
    const thrower: BusySource = {
      name: 'team-supervisor',
      checkBusy: () => Promise.reject(new Error('EACCES')),
    };
    const sample = await sampleIdle([idleSource('a'), thrower], 1000);
    expect(sample.idle).toBe(false);
    expect(sample.busySources[0]).toEqual({
      name: 'team-supervisor',
      busy: true,
      reason: 'check threw: EACCES',
    });
  });
});

// ---------------------------------------------------------------------------
// Streak + cooldown primitives
// ---------------------------------------------------------------------------

describe('streak and cooldown primitives', () => {
  it('starts a streak on the first idle sample and keeps its origin', () => {
    const first = advanceStreak(NO_STREAK, true, 1000);
    expect(first.since).toBe(1000);
    expect(advanceStreak(first, true, 2000).since).toBe(1000);
  });

  it('resets the streak on a single busy sample', () => {
    const started = advanceStreak(NO_STREAK, true, 1000);
    expect(advanceStreak(started, false, 2000).since).toBeNull();
  });

  it('is satisfied only at or past the threshold', () => {
    const streak = { since: 1000 };
    expect(streakSatisfied(streak, 500, 1400)).toBe(false);
    expect(streakSatisfied(streak, 500, 1500)).toBe(true);
    expect(streakSatisfied(NO_STREAK, 0, 9999)).toBe(false);
  });

  it('elapses the cooldown only at or past the window', () => {
    expect(cooldownElapsed(0, 30_000, 29_999)).toBe(false);
    expect(cooldownElapsed(0, 30_000, 30_000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Arming gates
// ---------------------------------------------------------------------------

describe('evaluateArming', () => {
  const green = {
    enabled: true,
    wakePathConfirmed: true,
    hostSignalAvailable: true,
    capabilities: { cron: false, voice: false },
  };

  it('arms when every gate holds', () => {
    expect(evaluateArming(green)).toEqual({ armed: true });
  });

  it('gate 1 — refuses when disabled, marked as the expected default', () => {
    const d = evaluateArming({ ...green, enabled: false });
    expect(d.armed).toBe(false);
    expect(d.disabled).toBe(true);
  });

  it('gate 2 — refuses when cron is enabled, naming the gap', () => {
    const d = evaluateArming({ ...green, capabilities: { cron: true, voice: false } });
    expect(d.armed).toBe(false);
    expect(d.reason).toContain('cron mid-execution');
    expect(d.reason).not.toContain('voice');
  });

  it('gate 2 — refuses when voice is enabled, naming the gap', () => {
    const d = evaluateArming({ ...green, capabilities: { cron: false, voice: true } });
    expect(d.armed).toBe(false);
    expect(d.reason).toContain('voice/call session state');
  });

  it('gate 2 — names both gaps when both are enabled', () => {
    const d = evaluateArming({ ...green, capabilities: { cron: true, voice: true } });
    expect(d.reason).toContain('cron mid-execution');
    expect(d.reason).toContain('voice/call session state');
  });

  it('gate 3 — refuses when the wake path is not attested', () => {
    const d = evaluateArming({ ...green, wakePathConfirmed: false });
    expect(d.armed).toBe(false);
    expect(d.reason).toContain('wakePathConfirmed');
  });

  it('gate 3b — refuses when no host suspend signal is wired', () => {
    const d = evaluateArming({ ...green, hostSignalAvailable: false });
    expect(d.armed).toBe(false);
    expect(d.disabled).toBeUndefined();
    expect(d.reason).toContain('no host suspend signal is wired');
  });
});

// ---------------------------------------------------------------------------
// Manager — arming
// ---------------------------------------------------------------------------

describe('IdleWatcherManager arming', () => {
  it('gate 1 — enabled:false arms no timer and never signals', async () => {
    const h = makeHarness([idleSource('a')], { options: { enabled: false } });
    h.manager.start();
    expect(h.manager.isRunning()).toBe(false);
    await advance(COOLDOWN_MS + IDLE_THRESHOLD_MS + INTERVAL_MS * 5);
    expect(h.signals).toBe(0);
  });

  it('gate 3 — wakePathConfirmed:false refuses to arm', async () => {
    const h = makeHarness([idleSource('a')], { options: { wakePathConfirmed: false } });
    h.manager.start();
    expect(h.manager.isRunning()).toBe(false);
    await advance(COOLDOWN_MS + IDLE_THRESHOLD_MS + INTERVAL_MS * 5);
    expect(h.signals).toBe(0);
  });

  it('gate 2 — capabilities.cron refuses to arm even with every other gate green', async () => {
    const warn = vi.fn();
    const manager = new IdleWatcherManager({
      sources: [idleSource('a')],
      capabilities: { cron: true, voice: false },
      hostSignalAvailable: true,
      pauseLifecycle: { readPauseOffset: async () => null, signalReadyToSuspend: async () => {} },
      options: { enabled: true, wakePathConfirmed: true },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn,
        error: vi.fn(),
        child: () => {
          throw new Error('unused');
        },
      },
    });
    manager.start();
    expect(manager.isRunning()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('cron mid-execution');
  });

  it('gate 2 — capabilities.voice refuses to arm and names the gap', async () => {
    const warn = vi.fn();
    const manager = new IdleWatcherManager({
      sources: [idleSource('a')],
      capabilities: { cron: false, voice: true },
      hostSignalAvailable: true,
      pauseLifecycle: { readPauseOffset: async () => null, signalReadyToSuspend: async () => {} },
      options: { enabled: true, wakePathConfirmed: true },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn,
        error: vi.fn(),
        child: () => {
          throw new Error('unused');
        },
      },
    });
    manager.start();
    expect(manager.isRunning()).toBe(false);
    expect(String(warn.mock.calls[0]?.[0])).toContain('voice/call session state');
  });
});

// ---------------------------------------------------------------------------
// Manager — cooldown, debounce, exit action
// ---------------------------------------------------------------------------

describe('IdleWatcherManager evaluation', () => {
  it('gate 4 — does not evaluate or signal before the startup cooldown elapses', async () => {
    const probe = vi.fn(async () => ({ busy: false }));
    const h = makeHarness([{ name: 'a', checkBusy: probe }]);
    h.manager.start();
    await advance(COOLDOWN_MS - 1);
    expect(probe).not.toHaveBeenCalled();
    expect(h.signals).toBe(0);
  });

  it('gate 5 — a busy sample inside the window resets the streak and blocks the exit action', async () => {
    const busy = { value: false };
    const h = makeHarness([
      { name: 'gateway-turns', checkBusy: async () => ({ busy: busy.value, reason: 'turn' }) },
    ]);
    h.manager.start();
    // Idle through the cooldown and most of the debounce window.
    await advance(COOLDOWN_MS + IDLE_THRESHOLD_MS - INTERVAL_MS * 2);
    expect(h.signals).toBe(0);
    // One busy sample resets the streak.
    busy.value = true;
    await advance(INTERVAL_MS);
    busy.value = false;
    // The old window would have expired here; the reset streak has not.
    await advance(INTERVAL_MS * 3);
    expect(h.signals).toBe(0);
    // A full fresh window does fire.
    await advance(IDLE_THRESHOLD_MS + INTERVAL_MS);
    expect(h.signals).toBe(1);
  });

  it('fires the exit action exactly once after continuous idle past the threshold', async () => {
    const h = makeHarness([idleSource('a'), idleSource('b')]);
    h.manager.start();
    await advance(COOLDOWN_MS + IDLE_THRESHOLD_MS + INTERVAL_MS);
    expect(h.signals).toBe(1);
    // Latched: subsequent ticks must not re-signal.
    await advance(INTERVAL_MS * 10);
    expect(h.signals).toBe(1);
    expect(h.manager.isRunning()).toBe(false);
  });

  it('never calls process.exit', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit must never be called by idle-watcher');
    }) as never);
    const h = makeHarness([idleSource('a')]);
    h.manager.start();
    await advance(COOLDOWN_MS + IDLE_THRESHOLD_MS + INTERVAL_MS * 5);
    expect(h.signals).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('a source that hangs keeps the process awake indefinitely', async () => {
    const h = makeHarness(
      [idleSource('a'), { name: 'hanger', checkBusy: () => new Promise(() => {}) }],
      {
        options: { checkTimeoutMs: 1000 },
      },
    );
    h.manager.start();
    await advance(COOLDOWN_MS + IDLE_THRESHOLD_MS * 3);
    expect(h.signals).toBe(0);
  });

  it('retries after a failed signalReadyToSuspend, re-earning the full window', async () => {
    const h = makeHarness([idleSource('a')]);
    h.signalFailure.err = new Error('host agent unreachable');
    h.manager.start();
    await advance(COOLDOWN_MS + IDLE_THRESHOLD_MS + INTERVAL_MS);
    expect(h.signals).toBe(1);
    expect(h.manager.isRunning()).toBe(true);
    h.signalFailure.err = undefined;
    await advance(IDLE_THRESHOLD_MS + INTERVAL_MS);
    expect(h.signals).toBe(2);
    expect(h.manager.isRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Manager — host signal availability (arming gate 3b)
// ---------------------------------------------------------------------------

describe('IdleWatcherManager host signal gate', () => {
  it('gate 3b — refuses to arm and never signals when no host signal is wired', async () => {
    const warn = vi.fn();
    const h = makeHarness([idleSource('a')], {
      hostSignalAvailable: false,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn,
        error: vi.fn(),
        child: () => {
          throw new Error('unused');
        },
      },
    });
    h.manager.start();
    expect(h.manager.isRunning()).toBe(false);
    await advance(COOLDOWN_MS + IDLE_THRESHOLD_MS + INTERVAL_MS * 5);
    // The no-op lifecycle would have "succeeded" here, latching and stopping
    // the watcher for the rest of the process's life having suspended nothing.
    expect(h.signals).toBe(0);
    expect(String(warn.mock.calls[0]?.[0])).toContain('no host suspend signal is wired');
  });

  it('arms as before once the host signal is available and every other gate is green', async () => {
    const h = makeHarness([idleSource('a')], { hostSignalAvailable: true });
    h.manager.start();
    expect(h.manager.isRunning()).toBe(true);
    await advance(COOLDOWN_MS + IDLE_THRESHOLD_MS + INTERVAL_MS);
    expect(h.signals).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Manager — timer-argument clamping
// ---------------------------------------------------------------------------

// Above 2147483647ms Node emits `TimeoutOverflowWarning` and collapses the
// delay to ~1ms, turning the poller into a ~1kHz loop over SQLite and the
// teams PID dir. Same clamp the approval timers already apply.
describe('timer clamping', () => {
  it('clamps an out-of-range checkIntervalMs instead of collapsing to a ~1ms loop', async () => {
    const probe = vi.fn(async () => ({ busy: false }));
    const h = makeHarness([{ name: 'a', checkBusy: probe }], {
      options: { checkIntervalMs: 9_000_000_000, startupCooldownMs: 0 },
    });
    h.manager.start();
    expect(h.manager.isRunning()).toBe(true);
    await advance(60_000);
    expect(probe).not.toHaveBeenCalled();
    expect(h.signals).toBe(0);
    h.manager.stop();
  });

  it('clamps an out-of-range checkTimeoutMs and reports the bound it actually used', async () => {
    const source: BusySource = { name: 'hanger', checkBusy: () => new Promise(() => {}) };
    const pending = checkSourceFailAwake(source, 9_000_000_000);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await advance(60_000);
    expect(settled).toBe(false);
    await advance(2_147_483_647);
    expect(await pending).toEqual({
      name: 'hanger',
      busy: true,
      reason: 'check timed out after 2147483647ms',
    });
  });
});

// ---------------------------------------------------------------------------
// Manager — lifecycle
// ---------------------------------------------------------------------------

describe('IdleWatcherManager lifecycle', () => {
  it('stop() prevents any further evaluation', async () => {
    const probe = vi.fn(async () => ({ busy: false }));
    const h = makeHarness([{ name: 'a', checkBusy: probe }]);
    h.manager.start();
    await advance(COOLDOWN_MS);
    const callsAtStop = probe.mock.calls.length;
    expect(callsAtStop).toBeGreaterThan(0);
    h.manager.stop();
    await advance(IDLE_THRESHOLD_MS * 2);
    expect(probe.mock.calls.length).toBe(callsAtStop);
    expect(h.signals).toBe(0);
  });

  it('double start() is a no-op and does not double-sample', async () => {
    const probe = vi.fn(async () => ({ busy: false }));
    const h = makeHarness([{ name: 'a', checkBusy: probe }]);
    h.manager.start();
    h.manager.start();
    await advance(COOLDOWN_MS);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  // A snapshot-resumed VM continues the SAME process image — no reboot, no
  // top-level boot code re-run (plan/phases/single-process-boot-profile.md §1)
  // — so `start()` is the only thing that can undo the one-shot latch. If the
  // resume handler forgets to call it, the VM suspends exactly once, ever.
  it('re-arms after a resume — start() clears the signalled latch so a snapshot-resumed process can suspend again', async () => {
    const h = makeHarness([idleSource('a')]);
    h.manager.start();
    await advance(COOLDOWN_MS + IDLE_THRESHOLD_MS + INTERVAL_MS);
    expect(h.signals).toBe(1);
    expect(h.manager.isRunning()).toBe(false);

    // What the resume handler must do.
    h.manager.start();
    expect(h.manager.isRunning()).toBe(true);

    // The startup cooldown restarts — no evaluation inside it.
    await advance(COOLDOWN_MS - INTERVAL_MS);
    expect(h.signals).toBe(1);
    // And the streak restarts: the full idle window is re-earned from the
    // first post-cooldown sample, not inherited from the pre-suspend run.
    await advance(IDLE_THRESHOLD_MS);
    expect(h.signals).toBe(1);

    await advance(INTERVAL_MS);
    expect(h.signals).toBe(2);
    expect(h.manager.isRunning()).toBe(false);
  });

  it('stop() before start() and double stop() are safe no-ops', () => {
    const h = makeHarness([idleSource('a')]);
    expect(() => h.manager.stop()).not.toThrow();
    h.manager.start();
    h.manager.stop();
    expect(() => h.manager.stop()).not.toThrow();
    expect(h.manager.isRunning()).toBe(false);
  });
});
