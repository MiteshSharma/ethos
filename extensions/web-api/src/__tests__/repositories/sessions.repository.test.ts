import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionsRepository } from '../../repositories/sessions.repository';

// Repository tests use a real (in-memory) SQLite store. No HTTP, no service
// layer — we want regressions in the schema or query shape to fail HERE,
// not via a service test that mocked these methods.

const baseSession = {
  key: 'cli:proj',
  platform: 'cli',
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

describe('SessionsRepository', () => {
  let store: SQLiteSessionStore;
  let repo: SessionsRepository;

  beforeEach(() => {
    store = new SQLiteSessionStore(':memory:');
    repo = new SessionsRepository(store);
  });

  afterEach(() => {
    store.close();
  });

  it('list returns the full set with nextCursor=null when count <= limit', async () => {
    await store.createSession({ ...baseSession, key: 'a' });
    await store.createSession({ ...baseSession, key: 'b' });
    await store.createSession({ ...baseSession, key: 'c' });

    const page = await repo.list({ limit: 10, cursor: null });

    // listSessions ordering between same-millisecond inserts is non-
    // deterministic without rowid tie-breaking (CLAUDE.md learnings § "same-
    // timestamp inserts"). Assert set membership, not insertion order.
    expect(page.sessions.map((s) => s.key).sort()).toEqual(['a', 'b', 'c']);
    expect(page.nextCursor).toBeNull();
  });

  it('list paginates via opaque cursor — round trips consume the full set', async () => {
    for (const key of ['a', 'b', 'c', 'd', 'e']) {
      await store.createSession({ ...baseSession, key });
    }

    const page1 = await repo.list({ limit: 2, cursor: null });
    expect(page1.sessions).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await repo.list({ limit: 2, cursor: page1.nextCursor });
    expect(page2.sessions).toHaveLength(2);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await repo.list({ limit: 2, cursor: page2.nextCursor });
    expect(page3.sessions).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();

    const allKeys = [...page1.sessions, ...page2.sessions, ...page3.sessions].map((s) => s.key);
    expect(allKeys.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('fork copies session shape + replays the message history under a new id', async () => {
    const source = await store.createSession({ ...baseSession, personalityId: 'researcher' });
    await store.appendMessage({ sessionId: source.id, role: 'user', content: 'hello' });
    await store.appendMessage({ sessionId: source.id, role: 'assistant', content: 'hi back' });

    const fork = await repo.fork(source.id);

    expect(fork.id).not.toBe(source.id);
    expect(fork.parentSessionId).toBe(source.id);
    expect(fork.platform).toBe(source.platform);
    expect(fork.personalityId).toBe('researcher');

    const forkedMessages = await store.getMessages(fork.id);
    expect(forkedMessages.map((m) => `${m.role}:${m.content}`)).toEqual([
      'user:hello',
      'assistant:hi back',
    ]);
  });

  it('fork with personality override changes personalityId on the fork only', async () => {
    const source = await store.createSession({ ...baseSession, personalityId: 'researcher' });
    const fork = await repo.fork(source.id, 'engineer');
    expect(fork.personalityId).toBe('engineer');

    const reloaded = await store.getSession(source.id);
    expect(reloaded?.personalityId).toBe('researcher');
  });

  it('fork rejects with a "session not found" message for unknown ids', async () => {
    await expect(repo.fork('does-not-exist')).rejects.toThrow(/session not found: does-not-exist/);
  });
});
