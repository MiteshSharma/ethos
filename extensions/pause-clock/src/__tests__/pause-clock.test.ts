import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClockDriftPauseLifecycle } from '../index';

const HOUR_MS = 3_600_000;

describe('ClockDriftPauseLifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports no pause on a cold boot', async () => {
    const lifecycle = new ClockDriftPauseLifecycle();

    expect(await lifecycle.readPauseOffset()).toBeNull();
  });

  it('reports an explicitly notified resume, and consumes it on read', async () => {
    const lifecycle = new ClockDriftPauseLifecycle();

    lifecycle.notifyResume(HOUR_MS);

    expect(await lifecycle.readPauseOffset()).toEqual({ pauseDurationMs: HOUR_MS });
    expect(await lifecycle.readPauseOffset()).toBeNull();
  });

  it('accumulates two resumes rather than overwriting', async () => {
    const lifecycle = new ClockDriftPauseLifecycle();

    lifecycle.notifyResume(HOUR_MS);
    lifecycle.notifyResume(2 * HOUR_MS);

    expect(await lifecycle.readPauseOffset()).toEqual({ pauseDurationMs: 3 * HOUR_MS });
  });

  it('ignores negative, NaN and Infinity durations', async () => {
    const lifecycle = new ClockDriftPauseLifecycle();

    lifecycle.notifyResume(-1);
    lifecycle.notifyResume(Number.NaN);
    lifecycle.notifyResume(Number.POSITIVE_INFINITY);

    expect(await lifecycle.readPauseOffset()).toBeNull();
  });

  it('detects a multi-hour wall-clock jump as a pause', async () => {
    vi.useFakeTimers();
    let wall = 0;
    const lifecycle = new ClockDriftPauseLifecycle({
      intervalMs: 1_000,
      thresholdMs: 60_000,
      now: () => wall,
    });
    lifecycle.start();

    // An ordinary tick: the wall clock advanced by exactly one interval.
    wall += 1_000;
    vi.advanceTimersByTime(1_000);
    expect(await lifecycle.readPauseOffset()).toBeNull();

    // The resume tick: six hours of wall clock, one interval of monotonic time.
    wall += 6 * HOUR_MS;
    vi.advanceTimersByTime(1_000);

    const offset = await lifecycle.readPauseOffset();
    expect(offset).not.toBeNull();
    // The subtracted interval is the only difference from the raw jump.
    expect(offset?.pauseDurationMs).toBeGreaterThan(6 * HOUR_MS - 2 * 1_000);
    expect(offset?.pauseDurationMs).toBeLessThanOrEqual(6 * HOUR_MS);

    lifecycle.stop();
  });

  it('stops detecting once stopped', async () => {
    vi.useFakeTimers();
    let wall = 0;
    const lifecycle = new ClockDriftPauseLifecycle({
      intervalMs: 1_000,
      thresholdMs: 60_000,
      now: () => wall,
    });
    lifecycle.start();
    lifecycle.stop();

    wall += 6 * HOUR_MS;
    vi.advanceTimersByTime(1_000);

    expect(await lifecycle.readPauseOffset()).toBeNull();
  });

  it('resolves signalReadyToSuspend', async () => {
    const lifecycle = new ClockDriftPauseLifecycle();

    await expect(lifecycle.signalReadyToSuspend()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The push seam. `readPauseOffset()` alone cannot serve snapshot+restore: that
// deployment continues the SAME process image, so its one caller (boot
// reconciliation) has already run to completion before the pause happens.
// ---------------------------------------------------------------------------

describe('ClockDriftPauseLifecycle.onResume', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pushes an explicitly notified resume to every handler', () => {
    const lifecycle = new ClockDriftPauseLifecycle();
    const seen: number[] = [];
    lifecycle.onResume((ms) => seen.push(ms));
    lifecycle.onResume((ms) => seen.push(ms * 2));

    lifecycle.notifyResume(HOUR_MS);

    expect(seen).toEqual([HOUR_MS, 2 * HOUR_MS]);
  });

  it('pushes a detected wall-clock jump without anyone polling', () => {
    let now = 1_000_000;
    vi.useFakeTimers();
    const lifecycle = new ClockDriftPauseLifecycle({ now: () => now });
    const seen: number[] = [];
    lifecycle.onResume((ms) => seen.push(ms));
    lifecycle.start();

    now += 6 * HOUR_MS;
    vi.advanceTimersByTime(1_000);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThan(5 * HOUR_MS);
    lifecycle.stop();
  });

  it('DRAINS on push, so a later read cannot apply the same correction twice', async () => {
    const lifecycle = new ClockDriftPauseLifecycle();
    lifecycle.onResume(() => {});

    lifecycle.notifyResume(HOUR_MS);

    expect(await lifecycle.readPauseOffset()).toBeNull();
  });

  it('leaves the pause pending for a reader when no handler is registered', async () => {
    const lifecycle = new ClockDriftPauseLifecycle();

    lifecycle.notifyResume(HOUR_MS);

    // The pull path — a process that really did cold-boot after a restore —
    // must keep working exactly as before.
    expect(await lifecycle.readPauseOffset()).toEqual({ pauseDurationMs: HOUR_MS });
  });

  it('does not push a sub-threshold jump', () => {
    let now = 1_000_000;
    vi.useFakeTimers();
    const lifecycle = new ClockDriftPauseLifecycle({ now: () => now });
    const seen: number[] = [];
    lifecycle.onResume((ms) => seen.push(ms));
    lifecycle.start();

    now += 2_000; // 1s of drift — NTP-step territory, not a pause
    vi.advanceTimersByTime(1_000);

    expect(seen).toEqual([]);
    lifecycle.stop();
  });

  it('keeps one throwing handler from costing the others their correction', () => {
    const lifecycle = new ClockDriftPauseLifecycle();
    const seen: number[] = [];
    lifecycle.onResume(() => {
      throw new Error('kanban board is locked');
    });
    lifecycle.onResume((ms) => seen.push(ms));

    expect(() => lifecycle.notifyResume(HOUR_MS)).not.toThrow();
    expect(seen).toEqual([HOUR_MS]);
  });

  it('stops pushing after unsubscribe', () => {
    const lifecycle = new ClockDriftPauseLifecycle();
    const seen: number[] = [];
    const off = lifecycle.onResume((ms) => seen.push(ms));

    lifecycle.notifyResume(HOUR_MS);
    off();
    lifecycle.notifyResume(HOUR_MS);

    expect(seen).toEqual([HOUR_MS]);
  });
});
