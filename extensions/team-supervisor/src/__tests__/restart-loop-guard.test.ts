// Item 4 — `teamSupervisor.restartLoopGuard`. The supervisor's exit handler
// asks `evaluateRestartGuard` whether a crashed member may be respawned; these
// drive that decision directly, since `runSupervisor` spawns child processes,
// acquires a PID file, and blocks forever.

import { describe, expect, it } from 'vitest';
import { evaluateRestartGuard, resolveRestartLimits } from '../supervisor';

describe('resolveRestartLimits', () => {
  it('defaults to a 5-restarts-in-60s policy', () => {
    expect(resolveRestartLimits()).toEqual({ maxRestarts: 5, windowMs: 60_000 });
    expect(resolveRestartLimits({})).toEqual({ maxRestarts: 5, windowMs: 60_000 });
  });

  it('takes each bound independently', () => {
    expect(resolveRestartLimits({ maxRestarts: 2 })).toEqual({ maxRestarts: 2, windowMs: 60_000 });
    expect(resolveRestartLimits({ windowSeconds: 10 })).toEqual({
      maxRestarts: 5,
      windowMs: 10_000,
    });
  });
});

describe('evaluateRestartGuard', () => {
  const limits = resolveRestartLimits({ maxRestarts: 3, windowSeconds: 60 });

  /** Decisions for `count` consecutive crashes one second apart. */
  function crashes(count: number, lim = limits): boolean[] {
    let failures: number[] = [];
    const decisions: boolean[] = [];
    for (let i = 0; i < count; i++) {
      const result = evaluateRestartGuard(failures, 1_000 + i * 1_000, lim);
      failures = result.failures;
      decisions.push(result.allowed);
    }
    return decisions;
  }

  // `maxRestarts` counts RESPAWNS: crash N earns restart N, and only the crash
  // after the budget is spent is refused. Boundaries at N-1 / N / N+1.
  it('allows exactly maxRestarts respawns inside the window', () => {
    expect(crashes(limits.maxRestarts - 1)).toEqual([true, true]);
    expect(crashes(limits.maxRestarts)).toEqual([true, true, true]);
    expect(crashes(limits.maxRestarts + 1)).toEqual([true, true, true, false]);
  });

  it('allows five respawns on the unset default', () => {
    const decisions = crashes(6, resolveRestartLimits());
    expect(decisions.filter(Boolean)).toHaveLength(5);
    expect(decisions[5]).toBe(false);
  });

  it('resumes restarting once the earlier crashes roll off the window', () => {
    const start = 1_000;
    let failures: number[] = [];
    for (let i = 0; i < 4; i++) {
      failures = evaluateRestartGuard(failures, start + i * 1_000, limits).failures;
    }
    // A crash more than a window later sees an empty history again.
    const later = evaluateRestartGuard(failures, start + 120_000, limits);
    expect(later.allowed).toBe(true);
    expect(later.failures).toEqual([start + 120_000]);
  });

  it('prunes only the crashes older than the window, keeping the rest', () => {
    const now = 100_000;
    const result = evaluateRestartGuard([now - 90_000, now - 10_000], now, limits);
    expect(result.failures).toEqual([now - 10_000, now]);
    expect(result.allowed).toBe(true);
  });

  it('honours a tighter configured cap than the default', () => {
    const tight = resolveRestartLimits({ maxRestarts: 1, windowSeconds: 60 });
    expect(evaluateRestartGuard([], 5_000, tight).allowed).toBe(true);
    expect(evaluateRestartGuard([5_000], 6_000, tight).allowed).toBe(false);
  });

  it('honours a wider configured window than the default', () => {
    const wide = resolveRestartLimits({ maxRestarts: 1, windowSeconds: 3600 });
    // 10 minutes earlier: outside the 60s default, inside the configured hour,
    // so the earlier crash still counts and this one is refused.
    expect(evaluateRestartGuard([1_000_000], 1_600_000, wide).allowed).toBe(false);
  });
});
