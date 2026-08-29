// Gate #12 of `plan/phases/clock-tolerance-pass.md` — the one gate that
// EXECUTES unwanted work rather than merely misclassifying: after a host pause
// longer than `idleMinutes`, the next tick fires a real LLM turn for every
// personality with dreaming enabled. `applyPauseOffset` discounts the pause
// from each personality's idle clock while preserving pre-pause idle time.

import type { AgentLoop } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { PersonalityConfig } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DreamExecutor } from '../dream-executor';

const HOUR_MS = 60 * 60_000;

function createMockLoop(): AgentLoop & { runCalls: number } {
  const loop = {
    runCalls: 0,
    run: async function* () {
      loop.runCalls += 1;
      yield { type: 'done' as const, text: '', turnCount: 1 };
    },
  };
  return loop as unknown as AgentLoop & { runCalls: number };
}

function makeConfig(): PersonalityConfig {
  return {
    id: 'test-personality',
    name: 'Test',
    dreaming: { enable: true, idleMinutes: 60, maxPerDay: 5 },
  } as PersonalityConfig;
}

type Internals = { tick(): Promise<void>; lastUserTurnAt: Map<string, number> };
const internals = (e: DreamExecutor) => e as unknown as Internals;

describe('DreamExecutor.applyPauseOffset', () => {
  let storage: InMemoryStorage;
  let loop: ReturnType<typeof createMockLoop>;
  let executor: DreamExecutor;

  const personalityId = 'test-personality';

  beforeEach(async () => {
    vi.useFakeTimers();
    storage = new InMemoryStorage();
    await storage.mkdir(`personalities/${personalityId}`);
    loop = createMockLoop();
    const cfg = makeConfig();
    executor = new DreamExecutor(
      storage,
      () => loop,
      () => cfg,
    );
  });

  afterEach(() => {
    executor?.stop();
    vi.useRealTimers();
  });

  it('THE GAP: a 6-hour host pause makes a 2-minute-idle personality dream', async () => {
    executor.recordUserTurn(personalityId);

    vi.setSystemTime(Date.now() + 2 * 60_000); // 2 minutes of real idle
    vi.setSystemTime(Date.now() + 6 * HOUR_MS); // host paused

    await internals(executor).tick();

    expect(loop.runCalls).toBe(1);
  });

  it('THE FIX: discounting the pause leaves it ineligible', async () => {
    executor.recordUserTurn(personalityId);

    vi.setSystemTime(Date.now() + 2 * 60_000);
    vi.setSystemTime(Date.now() + 6 * HOUR_MS);
    executor.applyPauseOffset(6 * HOUR_MS);

    await internals(executor).tick();

    expect(loop.runCalls).toBe(0);
  });

  it('preserves pre-pause idle time — 3 hours idle before the pause still dreams', async () => {
    executor.recordUserTurn(personalityId);

    vi.setSystemTime(Date.now() + 3 * HOUR_MS); // genuinely idle before the pause
    vi.setSystemTime(Date.now() + 6 * HOUR_MS); // host paused
    executor.applyPauseOffset(6 * HOUR_MS);

    await internals(executor).tick();

    // `recordUserTurn()` would have reset this to zero idle and suppressed it.
    expect(loop.runCalls).toBe(1);
  });

  it('an empty map and non-positive/non-finite durations are a no-op', async () => {
    // Empty map — nothing recorded yet.
    expect(() => executor.applyPauseOffset(6 * HOUR_MS)).not.toThrow();
    expect(internals(executor).lastUserTurnAt.size).toBe(0);

    executor.recordUserTurn(personalityId);
    const before = internals(executor).lastUserTurnAt.get(personalityId);

    executor.applyPauseOffset(0);
    executor.applyPauseOffset(-6 * HOUR_MS);
    executor.applyPauseOffset(Number.NaN);
    executor.applyPauseOffset(Number.POSITIVE_INFINITY);

    expect(internals(executor).lastUserTurnAt.size).toBe(1);
    expect(internals(executor).lastUserTurnAt.get(personalityId)).toBe(before);
  });
});
