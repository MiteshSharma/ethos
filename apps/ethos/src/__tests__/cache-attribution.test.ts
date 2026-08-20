// Per-event cache-miss attribution (plan/phases/model-visible-logged.md,
// Phase E). Correlates a turn's cache-creation cost (from sessions.db
// message-level `usage`, joined by `traceId`) with whichever v1 context kind
// changed since the previous turn (from `ContextLog.resolveAt`).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteContextLog, SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attributeCacheMisses } from '../commands/cache-attribution';

const baseSession = {
  key: 'cli:default',
  platform: 'cli',
  model: 'claude-opus-4-7',
  provider: 'anthropic',
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

describe('attributeCacheMisses', () => {
  let dir: string;
  let dbPath: string;
  let sessionStore: SQLiteSessionStore;
  let contextLog: SQLiteContextLog;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ethos-cache-attribution-'));
    dbPath = join(dir, 'sessions.db');
    sessionStore = new SQLiteSessionStore(dbPath);
    contextLog = new SQLiteContextLog(dbPath);
  });

  afterEach(() => {
    sessionStore.close();
    contextLog.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('correlates a cache miss with the exact context kind that changed — and reports "unexplained" when nothing tracked changed', async () => {
    const session = await sessionStore.createSession(baseSession);

    // Turn 1 — cold start: full cache-creation miss, first personality event.
    const user1 = await sessionStore.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: 'turn 1',
      traceId: 'trace-1',
    });
    await sessionStore.appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'reply 1',
      traceId: 'trace-1',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 500,
        estimatedCostUsd: 0.01,
      },
    });
    await contextLog.append({
      sessionId: session.id,
      messageId: user1.id,
      kind: 'personality',
      mode: 'replay',
      hash: 'a'.repeat(64),
      meta: { via: 'initial' },
      timestamp: Date.parse(user1.timestamp.toISOString()),
    });

    // Guarantees a distinct millisecond timestamp between turns — see the
    // same note in extensions/session-sqlite/src/__tests__/context-log.test.ts.
    await new Promise((r) => setTimeout(r, 5));

    // Turn 2 — full cache hit, same personality. D7: a no-change turn writes
    // ZERO context rows — resolveAt's last-write-wins still resolves to turn
    // 1's hash, so no new event is appended here.
    const user2 = await sessionStore.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: 'turn 2',
      traceId: 'trace-2',
    });
    await sessionStore.appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'reply 2',
      traceId: 'trace-2',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 500,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0.001,
      },
    });

    await new Promise((r) => setTimeout(r, 5));

    // Turn 3 — a fresh miss, correlated with a hot-reloaded personality hash.
    // This is the row that proves the whole feature: a cache miss correlated
    // with the exact context kind that changed.
    const user3 = await sessionStore.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: 'turn 3',
      traceId: 'trace-3',
    });
    await sessionStore.appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'reply 3',
      traceId: 'trace-3',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 500,
        estimatedCostUsd: 0.01,
      },
    });
    await contextLog.append({
      sessionId: session.id,
      messageId: user3.id,
      kind: 'personality',
      mode: 'replay',
      hash: 'b'.repeat(64),
      meta: { via: 'hot-reload' },
      timestamp: Date.parse(user3.timestamp.toISOString()),
    });

    await new Promise((r) => setTimeout(r, 5));

    // Turn 4 — a miss with NO tracked kind changing. Proves the function
    // correctly reports "unexplained by v1 kinds" rather than hallucinating
    // an attribution.
    const user4 = await sessionStore.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: 'turn 4',
      traceId: 'trace-4',
    });
    await sessionStore.appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'reply 4',
      traceId: 'trace-4',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 300,
        estimatedCostUsd: 0.008,
      },
    });

    const messages = await sessionStore.getMessages(session.id);
    const rows = await attributeCacheMisses(session.id, messages, contextLog);

    expect(rows).toHaveLength(4);

    expect(rows[0]).toMatchObject({
      messageId: user1.id,
      cacheCreationTokens: 500,
      isMiss: true,
      changedKinds: [], // first turn — nothing to compare against
    });
    expect(rows[1]).toMatchObject({
      messageId: user2.id,
      cacheCreationTokens: 0,
      isMiss: false,
      changedKinds: [],
    });
    expect(rows[2]).toMatchObject({
      messageId: user3.id,
      cacheCreationTokens: 500,
      isMiss: true,
      changedKinds: ['personality'],
    });
    expect(rows[3]).toMatchObject({
      messageId: user4.id,
      cacheCreationTokens: 300,
      isMiss: true,
      changedKinds: [],
    });
  });
});
