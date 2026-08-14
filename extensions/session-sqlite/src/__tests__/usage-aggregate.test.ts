import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteSessionStore } from '../index';

// AN-D1 — spend/token aggregates read from `messages`, not the per-session
// rollup: a session straddling the window boundary would otherwise put all of
// its spend on whichever side it started.

const base = {
  platform: 'slack',
  model: 'claude-opus-4-7',
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

describe('usageAggregate', () => {
  let store: SQLiteSessionStore;

  beforeEach(() => {
    store = new SQLiteSessionStore(':memory:');
  });
  afterEach(() => {
    store.close();
  });

  async function seed(): Promise<void> {
    const a = await store.createSession({ ...base, key: 'k1', personalityId: 'ops' } as never);
    const b = await store.createSession({
      ...base,
      key: 'k2',
      personalityId: 'research',
      platform: 'discord',
      model: 'claude-sonnet-4-7',
    } as never);
    for (const [session, cost] of [
      [a, 1.5],
      [a, 0.5],
      [b, 2.0],
    ] as const) {
      await store.appendMessage({
        sessionId: session.id,
        role: 'assistant',
        content: 'x',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 300,
          cacheCreationTokens: 100,
          estimatedCostUsd: cost,
        },
      });
    }
  }

  const window = { since: new Date(0), until: new Date(Date.now() + 60_000) };

  it('groups by personality', async () => {
    await seed();
    const rows = await store.usageAggregate({ ...window, dimension: 'personality' });
    // Sorted here, not asserted in query order: both personalities cost $2, and
    // the query's cost-DESC ordering leaves a tie unordered.
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(Object.keys(byKey).sort()).toEqual(['ops', 'research']);
    expect(byKey.ops).toMatchObject({ estimatedCostUsd: 2, messages: 2 });
    expect(byKey.research).toMatchObject({ estimatedCostUsd: 2, messages: 1 });
  });

  it('groups by channel and model', async () => {
    await seed();
    const byChannel = await store.usageAggregate({ ...window, dimension: 'channel' });
    expect(byChannel.map((r) => r.key).sort()).toEqual(['discord', 'slack']);

    const byModel = await store.usageAggregate({ ...window, dimension: 'model' });
    expect(byModel.map((r) => r.key).sort()).toEqual(['claude-opus-4-7', 'claude-sonnet-4-7']);
  });

  it('groups by UTC day', async () => {
    await seed();
    const rows = await store.usageAggregate({ ...window, dimension: 'day' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rows[0]?.estimatedCostUsd).toBe(4);
  });

  it('carries cache tokens through so the hit rate can be derived', async () => {
    await seed();
    const [row] = await store.usageAggregate({ ...window, dimension: 'day' });
    expect(row).toMatchObject({ cacheReadTokens: 900, cacheCreationTokens: 300 });
  });

  it('excludes messages outside the window', async () => {
    await seed();
    const past = { since: new Date(0), until: new Date(1) };
    expect(await store.usageAggregate({ ...past, dimension: 'day' })).toEqual([]);
  });

  it('ignores rows with no token counts', async () => {
    const s = await store.createSession({ ...base, key: 'k3' } as never);
    // A user message has no usage — it is not a billable row.
    await store.appendMessage({ sessionId: s.id, role: 'user', content: 'hello' });
    expect(await store.usageAggregate({ ...window, dimension: 'day' })).toEqual([]);
  });
});
