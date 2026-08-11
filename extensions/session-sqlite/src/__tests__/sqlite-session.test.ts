import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteSessionStore } from '../index';

// Uses an in-memory SQLite database — no disk I/O, no cleanup needed.
function makeStore() {
  return new SQLiteSessionStore(':memory:');
}

const baseSession = {
  key: 'cli:default',
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

describe('SQLiteSessionStore', () => {
  let store: SQLiteSessionStore;

  beforeEach(() => {
    store = makeStore();
  });

  afterEach(() => {
    store.close();
  });

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  it('creates and retrieves a session by id', async () => {
    const session = await store.createSession(baseSession);

    expect(session.id).toBeTruthy();
    expect(session.key).toBe('cli:default');
    expect(session.createdAt).toBeInstanceOf(Date);

    const found = await store.getSession(session.id);
    expect(found?.id).toBe(session.id);
    expect(found?.platform).toBe('cli');
  });

  it('retrieves a session by key', async () => {
    const session = await store.createSession(baseSession);
    const found = await store.getSessionByKey('cli:default');
    expect(found?.id).toBe(session.id);
  });

  it('returns null for unknown session', async () => {
    expect(await store.getSession('nonexistent')).toBeNull();
    expect(await store.getSessionByKey('nonexistent')).toBeNull();
  });

  it('deletes a session and cascades to messages', async () => {
    const session = await store.createSession(baseSession);
    await store.appendMessage({ sessionId: session.id, role: 'user', content: 'hello' });

    await store.deleteSession(session.id);

    expect(await store.getSession(session.id)).toBeNull();
    const msgs = await store.getMessages(session.id);
    expect(msgs).toHaveLength(0);
  });

  it('lists sessions with filters', async () => {
    await store.createSession({ ...baseSession, key: 'cli:1', platform: 'cli' });
    await store.createSession({ ...baseSession, key: 'tg:1', platform: 'telegram' });

    const cliSessions = await store.listSessions({ platform: 'cli' });
    expect(cliSessions).toHaveLength(1);
    expect(cliSessions[0]?.platform).toBe('cli');
  });

  it('lists sessions by keyPrefix — bg: prefix returns only background sessions', async () => {
    await store.createSession({ ...baseSession, key: 'cli:default', platform: 'cli' });
    await store.createSession({ ...baseSession, key: 'bg:1234:abcd', platform: 'cli' });
    await store.createSession({ ...baseSession, key: 'bg:5678:ef01', platform: 'cli' });

    const bgSessions = await store.listSessions({ keyPrefix: 'bg:' });
    expect(bgSessions).toHaveLength(2);
    expect(bgSessions.every((s) => s.key.startsWith('bg:'))).toBe(true);
  });

  it('excludes sessions by excludeKeyPrefixes — goal: sessions are hidden', async () => {
    await store.createSession({ ...baseSession, key: 'web:1', platform: 'web' });
    await store.createSession({ ...baseSession, key: 'cli:default', platform: 'cli' });
    await store.createSession({ ...baseSession, key: 'goal:abc:attempt-1', platform: 'web' });
    await store.createSession({ ...baseSession, key: 'goal:def:attempt-2', platform: 'web' });

    const chatSessions = await store.listSessions({ excludeKeyPrefixes: ['goal:'] });
    expect(chatSessions).toHaveLength(2);
    expect(chatSessions.every((s) => !s.key.startsWith('goal:'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  it('appends and retrieves messages in chronological order', async () => {
    const session = await store.createSession(baseSession);

    await store.appendMessage({ sessionId: session.id, role: 'user', content: 'hello' });
    await store.appendMessage({ sessionId: session.id, role: 'assistant', content: 'hi there' });
    await store.appendMessage({ sessionId: session.id, role: 'user', content: 'how are you' });

    const msgs = await store.getMessages(session.id);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]?.role).toBe('user');
    expect(msgs[0]?.content).toBe('hello');
    expect(msgs[2]?.content).toBe('how are you');
  });

  it('getMessages with limit returns most recent N messages', async () => {
    const session = await store.createSession(baseSession);

    for (let i = 1; i <= 5; i++) {
      await store.appendMessage({ sessionId: session.id, role: 'user', content: `msg ${i}` });
    }

    const recent = await store.getMessages(session.id, { limit: 3 });
    expect(recent).toHaveLength(3);
    // Should be the last 3 in chronological order
    expect(recent[0]?.content).toBe('msg 3');
    expect(recent[2]?.content).toBe('msg 5');
  });

  it('persists toolCalls on assistant messages', async () => {
    const session = await store.createSession(baseSession);

    await store.appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'searching...',
      toolCalls: [{ id: 'call_1', name: 'web_search', input: { query: 'test' } }],
    });

    const msgs = await store.getMessages(session.id);
    expect(msgs[0]?.toolCalls).toEqual([
      { id: 'call_1', name: 'web_search', input: { query: 'test' } },
    ]);
  });

  // -------------------------------------------------------------------------
  // Usage
  // -------------------------------------------------------------------------

  it('increments usage deltas correctly', async () => {
    const session = await store.createSession(baseSession);

    await store.updateUsage(session.id, { inputTokens: 100, outputTokens: 50, apiCallCount: 1 });
    await store.updateUsage(session.id, { inputTokens: 200, outputTokens: 80, apiCallCount: 1 });

    const updated = await store.getSession(session.id);
    expect(updated?.usage.inputTokens).toBe(300);
    expect(updated?.usage.outputTokens).toBe(130);
    expect(updated?.usage.apiCallCount).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Full-text search
  // -------------------------------------------------------------------------

  it('finds messages via FTS search', async () => {
    const session = await store.createSession(baseSession);

    await store.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: 'What is quantum computing?',
    });
    await store.appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'Quantum computing uses qubits.',
    });
    await store.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: 'Tell me about classical computers.',
    });

    const results = await store.search('quantum');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.snippet.toLowerCase().includes('quantum'))).toBe(true);
  });

  it('search scoped to sessionId excludes other sessions', async () => {
    const s1 = await store.createSession({ ...baseSession, key: 's1' });
    const s2 = await store.createSession({ ...baseSession, key: 's2' });

    await store.appendMessage({ sessionId: s1.id, role: 'user', content: 'quantum physics' });
    await store.appendMessage({ sessionId: s2.id, role: 'user', content: 'quantum chemistry' });

    const results = await store.search('quantum', { sessionId: s1.id });
    expect(results.every((r) => r.sessionId === s1.id)).toBe(true);
  });

  it('search filters by `since` bound (inclusive)', async () => {
    const session = await store.createSession(baseSession);
    await store.appendMessage({ sessionId: session.id, role: 'user', content: 'old quantum note' });
    const old = await store.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: 'older quantum note',
    });
    // biome-ignore lint/suspicious/noExplicitAny: direct DB access for test setup
    (store as any).db
      .prepare('UPDATE messages SET timestamp = ? WHERE id = ?')
      .run('2026-05-01T00:00:00.000Z', old.id);

    const cutoff = new Date('2026-05-10T00:00:00.000Z');
    const results = await store.search('quantum', { since: cutoff });
    expect(results.every((r) => r.timestamp >= cutoff)).toBe(true);
    expect(results.some((r) => r.messageId === old.id)).toBe(false);
  });

  it('search filters by `until` bound (inclusive)', async () => {
    const session = await store.createSession(baseSession);
    await store.appendMessage({ sessionId: session.id, role: 'user', content: 'fresh quantum' });
    const future = await store.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: 'future quantum',
    });
    // biome-ignore lint/suspicious/noExplicitAny: direct DB access for test setup
    (store as any).db
      .prepare('UPDATE messages SET timestamp = ? WHERE id = ?')
      .run('2099-01-01T00:00:00.000Z', future.id);

    const until = new Date('2030-01-01T00:00:00.000Z');
    const results = await store.search('quantum', { until });
    expect(results.every((r) => r.timestamp <= until)).toBe(true);
    expect(results.some((r) => r.messageId === future.id)).toBe(false);
  });

  it('search composes since + until + sessionId', async () => {
    const s1 = await store.createSession({ ...baseSession, key: 'k1' });
    const s2 = await store.createSession({ ...baseSession, key: 'k2' });
    await store.appendMessage({ sessionId: s1.id, role: 'user', content: 'in-range quantum' });
    await store.appendMessage({ sessionId: s2.id, role: 'user', content: 'wrong-session quantum' });

    const results = await store.search('quantum', {
      sessionId: s1.id,
      since: new Date(Date.now() - 60_000),
      until: new Date(Date.now() + 60_000),
    });
    expect(results.every((r) => r.sessionId === s1.id)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Pruning
  // -------------------------------------------------------------------------

  it('prunes sessions older than a given date', async () => {
    const old = await store.createSession({ ...baseSession, key: 'old' });
    const fresh = await store.createSession({ ...baseSession, key: 'fresh' });

    // Manually backdate the old session
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    // biome-ignore lint/suspicious/noExplicitAny: direct DB access for test setup
    (store as any).db
      .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
      .run(yesterday, old.id);

    const cutoff = new Date(Date.now() - 3_600_000); // 1 hour ago
    const pruned = await store.pruneOldSessions(cutoff);

    expect(pruned).toBe(1);
    expect(await store.getSession(old.id)).toBeNull();
    expect(await store.getSession(fresh.id)).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // context_compression F3 — compaction event persistence
  // -------------------------------------------------------------------------

  it('records and lists compression events oldest-first', async () => {
    const session = await store.createSession(baseSession);

    const first = await store.recordCompression({
      sessionId: session.id,
      engineName: 'semantic_summary',
      originalCount: 40,
      keptCount: 8,
      summaryText: 'summary of turns 2-34',
      summaryTokens: 120,
      preTotalTokens: 9000,
      postTotalTokens: 3000,
      durationMs: 850,
    });
    const second = await store.recordCompression({
      sessionId: session.id,
      engineName: 'drop_oldest',
      originalCount: 20,
      keptCount: 12,
      summaryTokens: 0,
      preTotalTokens: 8000,
      postTotalTokens: 4000,
      durationMs: 3,
    });

    expect(first.id).toBeTruthy();
    expect(first.createdAt).toBeInstanceOf(Date);

    const events = await store.listCompressions(session.id);
    expect(events).toHaveLength(2);
    expect(events[0]?.id).toBe(first.id);
    expect(events[1]?.id).toBe(second.id);
    expect(events[0]?.summaryText).toBe('summary of turns 2-34');
    expect(events[0]?.preTotalTokens).toBe(9000);
    expect(events[0]?.postTotalTokens).toBe(3000);
    // drop_oldest produced no summary — summaryText round-trips as undefined
    expect(events[1]?.summaryText).toBeUndefined();
  });

  it('keeps original messages queryable after a compression is recorded', async () => {
    const session = await store.createSession(baseSession);
    await store.appendMessage({ sessionId: session.id, role: 'user', content: 'original task' });
    await store.appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'working on it',
    });

    await store.recordCompression({
      sessionId: session.id,
      engineName: 'semantic_summary',
      originalCount: 2,
      keptCount: 1,
      summaryText: 'condensed',
      summaryTokens: 10,
      preTotalTokens: 100,
      postTotalTokens: 30,
      durationMs: 5,
    });

    // Compression is replay-only — the raw history is untouched.
    const msgs = await store.getMessages(session.id);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.content).toBe('original task');
    const hits = await store.search('original task', { sessionId: session.id });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('cascades compression rows when a session is deleted', async () => {
    const session = await store.createSession(baseSession);
    await store.recordCompression({
      sessionId: session.id,
      engineName: 'drop_oldest',
      originalCount: 10,
      keptCount: 5,
      summaryTokens: 0,
      preTotalTokens: 500,
      postTotalTokens: 250,
      durationMs: 1,
    });

    await store.deleteSession(session.id);
    expect(await store.listCompressions(session.id)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // context_compression Q2 — turn bookkeeping for the anti-thrashing cooldown
  // -------------------------------------------------------------------------

  it('recordTurnStart increments the per-session turn counter', async () => {
    const session = await store.createSession(baseSession);

    const t1 = await store.recordTurnStart(session.id);
    expect(t1).toEqual({ turnNumber: 1, lastCompactionTurn: 0 });
    const t2 = await store.recordTurnStart(session.id);
    expect(t2.turnNumber).toBe(2);
  });

  it('recordCompactionTurn is reflected in the next recordTurnStart', async () => {
    const session = await store.createSession(baseSession);
    await store.recordTurnStart(session.id); // turn 1
    await store.recordTurnStart(session.id); // turn 2

    await store.recordCompactionTurn(session.id, 2);

    const t3 = await store.recordTurnStart(session.id);
    expect(t3).toEqual({ turnNumber: 3, lastCompactionTurn: 2 });
  });

  it('turn counters are isolated per session', async () => {
    const a = await store.createSession({ ...baseSession, key: 'cli:a' });
    const b = await store.createSession({ ...baseSession, key: 'cli:b' });

    await store.recordTurnStart(a.id);
    await store.recordTurnStart(a.id);
    const bFirst = await store.recordTurnStart(b.id);

    expect(bFirst.turnNumber).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Session pinning
  // -------------------------------------------------------------------------

  it('pins and unpins a session', async () => {
    const session = await store.createSession(baseSession);
    expect(session.pinned).toBeFalsy();

    await store.updateSession(session.id, { pinned: true });
    const pinned = await store.getSession(session.id);
    expect(pinned?.pinned).toBe(true);

    await store.updateSession(session.id, { pinned: false });
    const unpinned = await store.getSession(session.id);
    expect(unpinned?.pinned).toBe(false);
  });

  it('lists pinned sessions before unpinned', async () => {
    const s1 = await store.createSession({ ...baseSession, key: 'cli:1' });
    const s2 = await store.createSession({ ...baseSession, key: 'cli:2' });
    const s3 = await store.createSession({ ...baseSession, key: 'cli:3' });

    await store.updateSession(s1.id, { pinned: true });

    const all = await store.listSessions();
    expect(all[0]?.id).toBe(s1.id);
    // Unpinned sessions appear after the pinned one
    const unpinnedIds = all.slice(1).map((s) => s.id);
    expect(unpinnedIds).toContain(s2.id);
    expect(unpinnedIds).toContain(s3.id);
  });

  // -------------------------------------------------------------------------
  // Personality binding — set at creation, immutable thereafter
  // -------------------------------------------------------------------------

  it('refuses to change a session bound to a personality', async () => {
    const session = await store.createSession({ ...baseSession, personalityId: 'scribe' });

    await expect(store.updateSession(session.id, { personalityId: 'auditor' })).rejects.toThrow(
      /bound to personality "scribe"/,
    );
    expect((await store.getSession(session.id))?.personalityId).toBe('scribe');
  });

  it('allows binding a personality when the session has none', async () => {
    const session = await store.createSession(baseSession);
    expect(session.personalityId).toBeUndefined();

    await store.updateSession(session.id, { personalityId: 'scribe' });
    expect((await store.getSession(session.id))?.personalityId).toBe('scribe');
  });

  it('allows a no-op patch that repeats the bound personality', async () => {
    const session = await store.createSession({ ...baseSession, personalityId: 'scribe' });

    await store.updateSession(session.id, { personalityId: 'scribe', title: 'still scribe' });
    const got = await store.getSession(session.id);
    expect(got?.personalityId).toBe('scribe');
    expect(got?.title).toBe('still scribe');
  });
});

// -------------------------------------------------------------------------
// FW-4 — title management
// -------------------------------------------------------------------------

describe('SQLiteSessionStore — title management', () => {
  let store: SQLiteSessionStore;

  beforeEach(() => {
    store = new SQLiteSessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('setTitle persists a title on the session', async () => {
    const session = await store.createSession(baseSession);
    await store.setTitle(session.id, 'auth refactor');

    const found = await store.getSession(session.id);
    expect(found?.title).toBe('auth refactor');
  });

  it('setTitle with null clears the title', async () => {
    const session = await store.createSession({ ...baseSession, title: 'old title' });
    await store.setTitle(session.id, null);

    const found = await store.getSession(session.id);
    expect(found?.title).toBeUndefined();
  });
});

// -------------------------------------------------------------------------
// FW-2 — session resume lookup
// -------------------------------------------------------------------------

describe('SQLiteSessionStore — resume lookup', () => {
  let store: SQLiteSessionStore;

  beforeEach(() => {
    store = new SQLiteSessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('findMostRecent returns the session with the latest updated_at', async () => {
    await store.createSession({ ...baseSession, key: 'cli:a' });
    const s2 = await store.createSession({ ...baseSession, key: 'cli:b' });
    // Advance s2's updated_at by touching it
    await store.updateSession(s2.id, { title: 'newer' });

    const found = await store.findMostRecent();
    expect(found?.id).toBe(s2.id);
  });

  it('findMostRecent returns null when no sessions exist', async () => {
    const found = await store.findMostRecent();
    expect(found).toBeNull();
  });

  it('findByTitle returns exact match on title (case-insensitive)', async () => {
    const s = await store.createSession({ ...baseSession, key: 'cli:x', title: 'Auth Refactor' });
    const results = await store.findByTitle('auth refactor');
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(s.id);
  });

  it('findByTitle returns fragment match when no exact match', async () => {
    const s = await store.createSession({
      ...baseSession,
      key: 'cli:y',
      title: 'auth refactoring pass',
    });
    const results = await store.findByTitle('refactor');
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(s.id);
  });

  it('findByTitle returns empty array when nothing matches', async () => {
    await store.createSession({ ...baseSession, key: 'cli:z', title: 'something else' });
    const results = await store.findByTitle('quantum');
    expect(results).toHaveLength(0);
  });

  it('findByTitle returns multiple sessions for fragment with multiple matches', async () => {
    await store.createSession({ ...baseSession, key: 'cli:1', title: 'auth feature' });
    await store.createSession({ ...baseSession, key: 'cli:2', title: 'auth bug fix' });
    const results = await store.findByTitle('auth');
    expect(results.length).toBeGreaterThanOrEqual(2);
  });
});

describe('SQLiteSessionStore migration idempotency', () => {
  it('opening the same db twice does not throw and trace_id column exists exactly once', async () => {
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dbPath = join(tmpdir(), `session-migration-test-${Date.now()}.db`);

    // First open — creates schema + runs migration
    const s1 = new SQLiteSessionStore(dbPath);
    s1.close();

    // Second open — migration guard (col exists check) must prevent duplicate ALTER TABLE
    expect(() => {
      const s2 = new SQLiteSessionStore(dbPath);
      s2.close();
    }).not.toThrow();

    // Confirm the column exists exactly once in the schema
    const Database = (await import('@ethosagent/sqlite')).default;
    const db = new Database(dbPath);
    const cols = db.pragma('table_info(messages)') as Array<{ name: string }>;
    db.close();
    const traceIdCols = cols.filter((c) => c.name === 'trace_id');
    expect(traceIdCols).toHaveLength(1);
  });
});

describe('SQLiteSessionStore schema versioning', () => {
  it('stamps a fresh db to user_version 1', async () => {
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dbPath = join(tmpdir(), `session-version-fresh-${Date.now()}.db`);

    const store = new SQLiteSessionStore(dbPath);
    store.close();

    const Database = (await import('@ethosagent/sqlite')).default;
    const db = new Database(dbPath);
    const rows = db.pragma('user_version') as Array<{ user_version: number }>;
    db.close();
    expect(rows[0]?.user_version).toBe(1);
  });

  it('reopening a populated db preserves rows and keeps user_version at 1', async () => {
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dbPath = join(tmpdir(), `session-version-reopen-${Date.now()}.db`);

    const s1 = new SQLiteSessionStore(dbPath);
    const session = await s1.createSession(baseSession);
    s1.close();

    const s2 = new SQLiteSessionStore(dbPath);
    const got = await s2.getSession(session.id);
    s2.close();
    expect(got?.id).toBe(session.id);

    const Database = (await import('@ethosagent/sqlite')).default;
    const db = new Database(dbPath);
    const rows = db.pragma('user_version') as Array<{ user_version: number }>;
    db.close();
    expect(rows[0]?.user_version).toBe(1);
  });

  it('refuses to open a db whose user_version is newer than the code', async () => {
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dbPath = join(tmpdir(), `session-version-downgrade-${Date.now()}.db`);

    const Database = (await import('@ethosagent/sqlite')).default;
    const raw = new Database(dbPath);
    raw.pragma('user_version = 2');
    raw.close();

    expect(() => new SQLiteSessionStore(dbPath)).toThrow(/refusing to open to avoid downgrade/);
  });
});
