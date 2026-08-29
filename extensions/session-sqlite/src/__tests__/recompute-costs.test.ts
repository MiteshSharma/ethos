import { estimateCost } from '@ethosagent/pricing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteSessionStore } from '../index';

// A5 backfill — `ethos data recompute-costs`. The fixture DB stands in for
// history written before @ethosagent/pricing existed: Gemini/Bedrock/Codex rows
// carry $0 because their transports hardcoded it, and an unrecognised
// `claude-*` row carries a Sonnet-priced number llm-anthropic invented.

function usage(overrides: Partial<Record<string, number>> = {}) {
  return {
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0,
    ...overrides,
  };
}

const baseSession = {
  platform: 'cli',
  provider: 'anthropic',
  workingDir: '/tmp',
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0,
    apiCallCount: 0,
    compactionCount: 0,
  },
};

/** The invariant A1 pins (analytics decision 9): the session rollup is a
 *  derived cache of the live message rows. */
async function rollupVsMessages(store: SQLiteSessionStore, sessionId: string) {
  const session = await store.getSession(sessionId);
  const messages = await store.getMessages(sessionId);
  const sum = messages.reduce((acc, m) => acc + (m.usage?.estimatedCostUsd ?? 0), 0);
  return { rollup: session?.usage.estimatedCostUsd ?? 0, sum };
}

describe('recomputeMessageCosts (A5 backfill)', () => {
  let store: SQLiteSessionStore;

  beforeEach(() => {
    store = new SQLiteSessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('repairs the hardcoded $0 a provider wrote for a priced model', async () => {
    const session = await store.createSession({
      ...baseSession,
      key: 'cli:gemini',
      model: 'gemini-2.5-pro',
      provider: 'gemini-native',
    });
    await store.appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'a',
      usage: usage(),
    });

    const before = await store.getMessages(session.id);
    expect(before[0]?.usage?.estimatedCostUsd).toBe(0);

    const result = await store.recomputeMessageCosts();
    expect(result.messagesScanned).toBe(1);
    expect(result.messagesUpdated).toBe(1);
    expect(result.unpricedModels).toEqual([]);

    // gemini-2.5-pro: 1.25 / 10 per 1M → 1000*1.25 + 500*10 = 6250
    const after = await store.getMessages(session.id);
    expect(after[0]?.usage?.estimatedCostUsd).toBeCloseTo(6250 / 1_000_000, 12);
  });

  it('replaces the invented Sonnet price on an unrecognised Anthropic model', async () => {
    const session = await store.createSession({
      ...baseSession,
      key: 'cli:unknown',
      model: 'claude-quintuple-9',
    });
    // What llm-anthropic's silent Sonnet fallback would have stored.
    await store.appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'a',
      usage: usage({ estimatedCostUsd: (1000 * 3 + 500 * 15) / 1_000_000 }),
    });

    const result = await store.recomputeMessageCosts();
    expect(result.unpricedModels).toEqual(['claude-quintuple-9']);

    const after = await store.getMessages(session.id);
    expect(after[0]?.usage?.estimatedCostUsd).toBe(0);
  });

  it('leaves rows with no token counts alone', async () => {
    const session = await store.createSession({
      ...baseSession,
      key: 'cli:mixed',
      model: 'claude-sonnet-4-6',
    });
    await store.appendMessage({ sessionId: session.id, role: 'user', content: 'q' });
    await store.appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'a',
      usage: usage(),
    });

    const result = await store.recomputeMessageCosts();
    expect(result.messagesScanned).toBe(1);

    const after = await store.getMessages(session.id);
    expect(after[0]?.usage).toBeUndefined();
    expect(after[1]?.usage?.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('prices cache tokens at their own rate, not the input rate', async () => {
    const session = await store.createSession({
      ...baseSession,
      key: 'cli:cached',
      model: 'claude-sonnet-4-6',
    });
    await store.appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'a',
      usage: usage({ cacheReadTokens: 20_000, cacheCreationTokens: 4000 }),
    });

    await store.recomputeMessageCosts();

    const expected = estimateCost('claude-sonnet-4-6', {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 20_000,
      cacheCreationTokens: 4000,
    }).costUsd;
    const flat = ((1000 + 20_000 + 4000) * 3 + 500 * 15) / 1_000_000;

    const after = await store.getMessages(session.id);
    expect(after[0]?.usage?.estimatedCostUsd).toBeCloseTo(expected, 12);
    expect(after[0]?.usage?.estimatedCostUsd).not.toBeCloseTo(flat, 12);
  });

  it('rebuilds the session rollup so rollup == SUM(messages) still holds', async () => {
    const session = await store.createSession({
      ...baseSession,
      key: 'cli:rollup',
      model: 'gemini-2.5-pro',
      provider: 'gemini-native',
    });
    for (let i = 0; i < 3; i++) {
      await store.appendMessage({
        sessionId: session.id,
        role: 'assistant',
        content: `a${i}`,
        usage: usage(),
      });
      // The rollup faithfully cached the (wrong) $0 the provider reported.
      await store.updateUsage(session.id, usage());
    }

    const stale = await rollupVsMessages(store, session.id);
    expect(stale.rollup).toBe(0);

    const result = await store.recomputeMessageCosts();
    expect(result.sessionsUpdated).toBe(1);

    const fixed = await rollupVsMessages(store, session.id);
    expect(fixed.sum).toBeGreaterThan(0);
    expect(fixed.rollup).toBeCloseTo(fixed.sum, 12);
  });

  it('excludes soft-deleted messages from the rebuilt rollup', async () => {
    const session = await store.createSession({
      ...baseSession,
      key: 'cli:undone',
      model: 'claude-sonnet-4-6',
    });
    for (let i = 0; i < 2; i++) {
      await store.appendMessage({
        sessionId: session.id,
        role: 'assistant',
        content: `a${i}`,
        usage: usage(),
      });
      await store.appendMessage({ sessionId: session.id, role: 'user', content: `q${i}` });
    }
    expect(await store.undoTurns(session.id, 1)).toBe(1);

    await store.recomputeMessageCosts();

    const { rollup, sum } = await rollupVsMessages(store, session.id);
    expect(await store.getMessages(session.id)).toHaveLength(2);
    expect(rollup).toBeCloseTo(sum, 12);
  });

  it('is idempotent — a second run changes nothing', async () => {
    const gemini = await store.createSession({
      ...baseSession,
      key: 'cli:idem-a',
      model: 'gemini-2.0-flash',
      provider: 'gemini-native',
    });
    const unknown = await store.createSession({
      ...baseSession,
      key: 'cli:idem-b',
      model: 'gpt-does-not-exist',
      provider: 'openai',
    });
    for (const id of [gemini.id, unknown.id]) {
      await store.appendMessage({
        sessionId: id,
        role: 'assistant',
        content: 'a',
        usage: usage({ cacheReadTokens: 300 }),
      });
    }

    const first = await store.recomputeMessageCosts();
    const snapshot = async () => ({
      messages: (await store.getMessages(gemini.id))
        .concat(await store.getMessages(unknown.id))
        .map((m) => m.usage?.estimatedCostUsd),
      rollups: [
        (await store.getSession(gemini.id))?.usage.estimatedCostUsd,
        (await store.getSession(unknown.id))?.usage.estimatedCostUsd,
      ],
    });
    const afterFirst = await snapshot();

    const second = await store.recomputeMessageCosts();
    const afterSecond = await snapshot();

    expect(first.messagesUpdated).toBe(1); // only the gemini row moved off $0
    expect(second.messagesUpdated).toBe(0);
    expect(second.sessionsUpdated).toBe(0);
    expect(second.messagesScanned).toBe(first.messagesScanned);
    expect(afterSecond).toEqual(afterFirst);
  });

  it('reports an empty database as a no-op', async () => {
    expect(await store.recomputeMessageCosts()).toEqual({
      messagesScanned: 0,
      messagesUpdated: 0,
      sessionsUpdated: 0,
      unpricedModels: [],
    });
  });
});
