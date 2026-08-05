import type { AgentLoop } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { DreamingConfig, PersonalityConfig } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DreamExecutor } from '../dream-executor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockLoop(): AgentLoop & { runCalls: Array<{ text: string; opts: unknown }> } {
  const runCalls: Array<{ text: string; opts: unknown }> = [];
  return {
    runCalls,
    run: async function* (text: string, opts?: unknown) {
      runCalls.push({ text, opts });
      yield { type: 'done' as const, text: '', turnCount: 1 };
    },
  } as unknown as AgentLoop & { runCalls: Array<{ text: string; opts: unknown }> };
}

function makeConfig(overrides?: Partial<DreamingConfig>): PersonalityConfig {
  return {
    id: 'test-personality',
    name: 'Test',
    dreaming: {
      enable: true,
      idleMinutes: 60,
      maxPerDay: 2,
      ...overrides,
    },
  } as PersonalityConfig;
}

/** Seed the personality directory so InMemoryStorage accepts writes. */
async function seedStorage(storage: InMemoryStorage, personalityId = 'test-personality') {
  await storage.mkdir(`personalities/${personalityId}`);
}

// ---------------------------------------------------------------------------
// Private-access helper — avoids `as any` for Biome's noExplicitAny rule
// ---------------------------------------------------------------------------

type Internals = { tick(): Promise<void>; timer: unknown; ticking: boolean };
const internals = (e: DreamExecutor) => e as unknown as Internals;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DreamExecutor', () => {
  let storage: InMemoryStorage;
  let loop: ReturnType<typeof createMockLoop>;
  let executor: DreamExecutor;

  const personalityId = 'test-personality';
  const statePath = `personalities/${personalityId}/dream-state.json`;

  beforeEach(async () => {
    vi.useFakeTimers();
    storage = new InMemoryStorage();
    loop = createMockLoop();
    await seedStorage(storage);
  });

  afterEach(() => {
    executor?.stop();
    vi.useRealTimers();
  });

  /** Build a DreamExecutor with a fixed config. */
  function build(config?: PersonalityConfig) {
    const cfg = config ?? makeConfig();
    executor = new DreamExecutor(
      storage,
      () => loop,
      () => cfg,
    );
    return executor;
  }

  // -----------------------------------------------------------------------
  // Eligibility logic
  // -----------------------------------------------------------------------

  describe('eligibility', () => {
    it('no state file → eligible', async () => {
      build();
      executor.recordUserTurn(personalityId);

      // Advance past idle threshold (60 min) so tick fires dream
      vi.setSystemTime(Date.now() + 61 * 60_000);
      await internals(executor).tick();

      const raw = await storage.read(statePath);
      expect(raw).not.toBeNull();
      expect(loop.runCalls).toHaveLength(1);
    });

    it('within window, under cap → eligible', async () => {
      // Pre-seed state with 0 runs today, recent window
      const windowStart = new Date().toISOString();
      await storage.writeAtomic(
        statePath,
        JSON.stringify({ lastDreamAt: windowStart, runsToday: 0, windowStart }),
      );

      build();
      executor.recordUserTurn(personalityId);
      vi.setSystemTime(Date.now() + 61 * 60_000);
      await internals(executor).tick();

      expect(loop.runCalls).toHaveLength(1);
    });

    it('within window, at cap → not eligible', async () => {
      const windowStart = new Date().toISOString();
      await storage.writeAtomic(
        statePath,
        JSON.stringify({ lastDreamAt: windowStart, runsToday: 2, windowStart }),
      );

      build(makeConfig({ maxPerDay: 2 }));
      executor.recordUserTurn(personalityId);
      vi.setSystemTime(Date.now() + 61 * 60_000);
      await internals(executor).tick();

      expect(loop.runCalls).toHaveLength(0);
    });

    it('window expired → eligible (reset)', async () => {
      const oldWindow = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
      await storage.writeAtomic(
        statePath,
        JSON.stringify({ lastDreamAt: oldWindow, runsToday: 5, windowStart: oldWindow }),
      );

      build();
      executor.recordUserTurn(personalityId);
      vi.setSystemTime(Date.now() + 61 * 60_000);
      await internals(executor).tick();

      expect(loop.runCalls).toHaveLength(1);
      // runsToday should reset to 1 (new window)
      const state = JSON.parse((await storage.read(statePath)) ?? '');
      expect(state.runsToday).toBe(1);
    });

    it('corrupt state file → eligible', async () => {
      await storage.writeAtomic(statePath, '{{{not valid json!!!');

      build();
      executor.recordUserTurn(personalityId);
      vi.setSystemTime(Date.now() + 61 * 60_000);
      await internals(executor).tick();

      expect(loop.runCalls).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Idle detection
  // -----------------------------------------------------------------------

  describe('idle detection', () => {
    it('not idle yet → no dream', async () => {
      build();
      executor.recordUserTurn(personalityId);

      // Tick immediately — should not fire (not idle yet)
      await internals(executor).tick();

      expect(loop.runCalls).toHaveLength(0);
    });

    it('idle past threshold → fires dream', async () => {
      build();
      executor.recordUserTurn(personalityId);

      // Advance past 60-minute idle threshold
      vi.setSystemTime(Date.now() + 61 * 60_000);
      await internals(executor).tick();

      expect(loop.runCalls).toHaveLength(1);
    });

    it('user message resets timer', async () => {
      build();
      executor.recordUserTurn(personalityId);

      // Advance 30 minutes (not yet idle)
      vi.setSystemTime(Date.now() + 30 * 60_000);
      // Record another turn — resets the timer
      executor.recordUserTurn(personalityId);

      // Advance another 30 minutes from that point (total 60 from start,
      // but only 30 from last turn)
      vi.setSystemTime(Date.now() + 30 * 60_000);
      await internals(executor).tick();

      expect(loop.runCalls).toHaveLength(0);
    });

    it('dream run resets timer', async () => {
      build();
      executor.recordUserTurn(personalityId);

      // Trigger first dream
      vi.setSystemTime(Date.now() + 61 * 60_000);
      await internals(executor).tick();
      expect(loop.runCalls).toHaveLength(1);

      // Advance only 30 minutes from post-dream reset — should not fire again
      vi.setSystemTime(Date.now() + 30 * 60_000);
      await internals(executor).tick();
      expect(loop.runCalls).toHaveLength(1); // still 1
    });

    it('dreaming disabled → no dream', async () => {
      const disabledConfig = makeConfig({ enable: false });
      build(disabledConfig);
      executor.recordUserTurn(personalityId);

      vi.setSystemTime(Date.now() + 120 * 60_000);
      await internals(executor).tick();

      expect(loop.runCalls).toHaveLength(0);
    });

    it('no dreaming config → no dream', async () => {
      const noConfig = { id: personalityId, name: 'Test' } as PersonalityConfig;
      build(noConfig);
      executor.recordUserTurn(personalityId);

      vi.setSystemTime(Date.now() + 120 * 60_000);
      await internals(executor).tick();

      expect(loop.runCalls).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // State persistence
  // -----------------------------------------------------------------------

  describe('state persistence', () => {
    it('after dream, state file is written with correct fields', async () => {
      const now = Date.now();
      build();
      executor.recordUserTurn(personalityId);

      vi.setSystemTime(now + 61 * 60_000);
      await internals(executor).tick();

      const raw = await storage.read(statePath);
      expect(raw).not.toBeNull();
      const state = JSON.parse(raw ?? '');
      expect(state.lastDreamAt).toBeDefined();
      expect(state.runsToday).toBe(1);
      expect(state.windowStart).toBeDefined();
      // Verify timestamps are ISO strings
      expect(() => new Date(state.lastDreamAt).toISOString()).not.toThrow();
      expect(() => new Date(state.windowStart).toISOString()).not.toThrow();
    });

    it('maxPerDay caps dreams inside the rolling window and resumes after it rolls', async () => {
      build(makeConfig({ maxPerDay: 2 }));

      // Two dreams inside a single 24h window — both allowed.
      for (let i = 0; i < 2; i++) {
        executor.recordUserTurn(personalityId);
        vi.setSystemTime(Date.now() + 61 * 60_000);
        await internals(executor).tick();
      }
      expect(loop.runCalls).toHaveLength(2);

      // Third idle crossing inside the same window — capped.
      executor.recordUserTurn(personalityId);
      vi.setSystemTime(Date.now() + 61 * 60_000);
      await internals(executor).tick();
      expect(loop.runCalls).toHaveLength(2);

      // Window rolls past 24h — the cap resets and dreaming resumes.
      vi.setSystemTime(Date.now() + 25 * 60 * 60_000);
      await internals(executor).tick();
      expect(loop.runCalls).toHaveLength(3);
      const state = JSON.parse((await storage.read(statePath)) ?? '');
      expect(state.runsToday).toBe(1);
    });

    it('second dream increments runsToday', async () => {
      build();
      executor.recordUserTurn(personalityId);

      // First dream
      vi.setSystemTime(Date.now() + 61 * 60_000);
      await internals(executor).tick();
      expect(loop.runCalls).toHaveLength(1);

      const stateAfterFirst = JSON.parse((await storage.read(statePath)) ?? '');
      expect(stateAfterFirst.runsToday).toBe(1);

      // Record a new user turn and trigger second dream
      executor.recordUserTurn(personalityId);
      vi.setSystemTime(Date.now() + 61 * 60_000);
      await internals(executor).tick();

      expect(loop.runCalls).toHaveLength(2);
      const stateAfterSecond = JSON.parse((await storage.read(statePath)) ?? '');
      expect(stateAfterSecond.runsToday).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Model routing
  // -----------------------------------------------------------------------

  describe('model routing', () => {
    it('session key starts with dream:<personalityId>:', async () => {
      build();
      executor.recordUserTurn(personalityId);

      vi.setSystemTime(Date.now() + 61 * 60_000);
      await internals(executor).tick();

      expect(loop.runCalls).toHaveLength(1);
      const opts = loop.runCalls[0].opts as Record<string, unknown>;
      const sessionKey = opts.sessionKey as string;
      expect(sessionKey).toMatch(new RegExp(`^dream:${personalityId}:`));
    });

    it('requests the `dreaming` model tier for the dream turn', async () => {
      build();
      executor.recordUserTurn(personalityId);

      vi.setSystemTime(Date.now() + 61 * 60_000);
      await internals(executor).tick();

      const opts = loop.runCalls[0].opts as Record<string, unknown>;
      expect(opts.tierOverride).toBe('dreaming');
    });
  });

  // -----------------------------------------------------------------------
  // Timer lifecycle (start/stop)
  // -----------------------------------------------------------------------

  describe('timer lifecycle', () => {
    it('start() creates an interval; stop() clears it', () => {
      build();
      executor.start();
      expect(internals(executor).timer).toBeDefined();

      executor.stop();
      expect(internals(executor).timer).toBeUndefined();
    });

    it('the started interval drives dreams; stop() ends them', async () => {
      build();
      executor.recordUserTurn(personalityId);
      executor.start();

      // Interval ticks every 5 min; the 60-min idle threshold is crossed here.
      await vi.advanceTimersByTimeAsync(61 * 60_000);
      expect(loop.runCalls).toHaveLength(1);

      executor.stop();
      executor.recordUserTurn(personalityId);
      await vi.advanceTimersByTimeAsync(120 * 60_000);

      // Timer is gone — no further ticks, no further dreams.
      expect(loop.runCalls).toHaveLength(1);
    });

    it('start() is idempotent — calling twice does not create a second timer', () => {
      build();
      executor.start();
      const firstTimer = internals(executor).timer;
      executor.start();
      expect(internals(executor).timer).toBe(firstTimer);
    });
  });
});
