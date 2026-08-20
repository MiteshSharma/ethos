import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsContentStore } from '@ethosagent/cas-fs';
import { SQLiteContextLog, SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { StoredMessage } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionsRepository } from '../../features/sessions/repository';

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

  it('update() sets the title on the session', async () => {
    const sess = await store.createSession({ ...baseSession, key: 'update-test' });
    await repo.update(sess.id, { title: 'My renamed session' });
    const reloaded = await repo.get(sess.id);
    expect(reloaded?.title).toBe('My renamed session');
  });

  it('update() clears the title when null is passed', async () => {
    const sess = await store.createSession({
      ...baseSession,
      key: 'clear-title',
      title: 'Old title',
    });
    await repo.update(sess.id, { title: null });
    const reloaded = await repo.get(sess.id);
    // rowToSession converts SQL NULL → undefined for optional fields
    expect(reloaded?.title).toBeUndefined();
  });

  it('update() throws for unknown id', async () => {
    await expect(repo.update('ghost-id', { title: 'x' })).rejects.toThrow(/session not found/);
  });

  it('list({ q }) returns sessions whose messages match the query', async () => {
    const sessA = await store.createSession({ ...baseSession, key: 'q-a' });
    const sessB = await store.createSession({ ...baseSession, key: 'q-b' });
    await store.appendMessage({
      sessionId: sessA.id,
      role: 'user',
      content: 'the quick brown fox',
    });
    await store.appendMessage({
      sessionId: sessB.id,
      role: 'user',
      content: 'a completely different topic',
    });

    const page = await repo.list({ limit: 20, cursor: null, q: 'quick fox' });
    const ids = page.sessions.map((s) => s.id);
    expect(ids).toContain(sessA.id);
    expect(ids).not.toContain(sessB.id);
  });

  it('list({ q: "" }) returns all sessions (empty query = no filter)', async () => {
    await store.createSession({ ...baseSession, key: 'empty-q-1' });
    await store.createSession({ ...baseSession, key: 'empty-q-2' });
    const page = await repo.list({ limit: 20, cursor: null, q: '' });
    expect(page.sessions.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// fork() with a wired ContextLog (plan/phases/model-visible-logged.md, Phase
// E, D9). `:memory:` databases are not shareable across separate `Database`
// handles, and `SQLiteContextLog` opens its own handle — so these tests use a
// real temp-file `sessions.db`, the same pattern
// extensions/session-sqlite/src/__tests__/context-log.test.ts uses.
// ---------------------------------------------------------------------------

describe('SessionsRepository — fork with context log (Phase E, D9)', () => {
  let dir: string;
  let dbPath: string;
  let store: SQLiteSessionStore;
  let contextLog: SQLiteContextLog;
  let repo: SessionsRepository;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ethos-sessions-fork-'));
    dbPath = join(dir, 'sessions.db');
    store = new SQLiteSessionStore(dbPath);
    contextLog = new SQLiteContextLog(dbPath);
    repo = new SessionsRepository(store, contextLog);
  });

  afterEach(() => {
    store.close();
    contextLog.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("fork copies context events onto the child; resolving at the child's latest replayed message reproduces the parent's current state", async () => {
    const source = await store.createSession({ ...baseSession, key: 'cli:fork-src' });

    // Turns 1-2 see personality hash A; turns 3-4 see hash B (a mid-session
    // hot-reload) — only turns 1 and 3 write a NEW event (D7: a no-change
    // turn writes zero rows).
    const hashes = ['a'.repeat(64), 'a'.repeat(64), 'b'.repeat(64), 'b'.repeat(64)];
    const sourceMessages: StoredMessage[] = [];
    for (let i = 0; i < hashes.length; i++) {
      const msg = await store.appendMessage({
        sessionId: source.id,
        role: 'user',
        content: `turn ${i + 1}`,
      });
      sourceMessages.push(msg);
      if (i === 0 || hashes[i] !== hashes[i - 1]) {
        await contextLog.append({
          sessionId: source.id,
          messageId: msg.id,
          kind: 'personality',
          mode: 'replay',
          hash: hashes[i] as string,
          meta: { via: i === 0 ? 'initial' : 'hot-reload' },
          timestamp: Date.parse(msg.timestamp.toISOString()),
        });
      }
      // Guarantees a distinct millisecond timestamp between turns — same
      // reason context-log.test.ts uses this delay.
      await new Promise((r) => setTimeout(r, 5));
    }

    const fork = await repo.fork(source.id);
    const childMessages = await store.getMessages(fork.id);
    expect(childMessages).toHaveLength(sourceMessages.length);

    const lastSourceMsg = sourceMessages.at(-1);
    const lastChildMsg = childMessages.at(-1);
    if (!lastSourceMsg || !lastChildMsg) throw new Error('unexpected message count');

    const sourceResolved = await contextLog.resolveAt(source.id, lastSourceMsg.id);
    const childResolved = await contextLog.resolveAt(fork.id, lastChildMsg.id);
    if (sourceResolved.personality === 'unknown' || childResolved.personality === 'unknown') {
      throw new Error('expected a resolved personality entry');
    }
    // hash/mode/meta are identical — the copied event's bookkeeping timestamp
    // is remapped to the child's own turn (see repository.ts fork()), so
    // timestamp itself is deliberately not compared here.
    expect(childResolved.personality.hash).toBe(sourceResolved.personality.hash);
    expect(childResolved.personality.hash).toBe('b'.repeat(64));
    expect(childResolved.personality.mode).toBe(sourceResolved.personality.mode);
    expect(childResolved.personality.meta).toEqual(sourceResolved.personality.meta);
  });

  it('forking before vs. after a hot-reload preserves which personality was in effect at each fork point (last-write-wins across a fork)', async () => {
    // Two SEPARATE fork() calls, taken at two different points in the
    // parent's real timeline, rather than resolving at several messages
    // WITHIN one fork's replayed history: `resolveAt`'s millisecond-timestamp
    // comparison cannot distinguish between multiple messages replayed back
    // to back inside fork()'s own copy loop (no natural delay between them —
    // and adding one would make forking a long session pathologically slow),
    // so per-turn precision among messages replayed by a SINGLE fork is not a
    // guarantee this design provides. What IS guaranteed, and what this test
    // proves, is that a fork taken before a change sees the old state, and a
    // fork taken after sees the new one.
    const source = await store.createSession({ ...baseSession, key: 'cli:fork-timing' });

    const msg1 = await store.appendMessage({
      sessionId: source.id,
      role: 'user',
      content: 'turn 1',
    });
    await contextLog.append({
      sessionId: source.id,
      messageId: msg1.id,
      kind: 'personality',
      mode: 'replay',
      hash: 'a'.repeat(64),
      meta: { via: 'initial' },
      timestamp: Date.parse(msg1.timestamp.toISOString()),
    });

    const forkBefore = await repo.fork(source.id);
    const forkBeforeMessages = await store.getMessages(forkBefore.id);
    const forkBeforeMsg = forkBeforeMessages[0];
    if (!forkBeforeMsg) throw new Error('expected one replayed message');
    const beforeResolved = await contextLog.resolveAt(forkBefore.id, forkBeforeMsg.id);
    expect(beforeResolved.personality).toMatchObject({ hash: 'a'.repeat(64) });

    await new Promise((r) => setTimeout(r, 5));

    // A hot-reload changes the personality hash on the SOURCE.
    const msg2 = await store.appendMessage({
      sessionId: source.id,
      role: 'user',
      content: 'turn 2',
    });
    await contextLog.append({
      sessionId: source.id,
      messageId: msg2.id,
      kind: 'personality',
      mode: 'replay',
      hash: 'b'.repeat(64),
      meta: { via: 'hot-reload' },
      timestamp: Date.parse(msg2.timestamp.toISOString()),
    });

    const forkAfter = await repo.fork(source.id);
    const forkAfterMessages = await store.getMessages(forkAfter.id);
    expect(forkAfterMessages).toHaveLength(2);
    const forkAfterLastMsg = forkAfterMessages.at(-1);
    if (!forkAfterLastMsg) throw new Error('expected replayed messages');
    const afterResolved = await contextLog.resolveAt(forkAfter.id, forkAfterLastMsg.id);
    expect(afterResolved.personality).toMatchObject({ hash: 'b'.repeat(64) });

    // The earlier fork is untouched by the later hot-reload — it is its own
    // session with its own copied events.
    const beforeResolvedAgain = await contextLog.resolveAt(forkBefore.id, forkBeforeMsg.id);
    expect(beforeResolvedAgain.personality).toMatchObject({ hash: 'a'.repeat(64) });
  });

  it("forking at message N and replaying reproduces the parent's Tier A/B text byte-for-byte after the source files on disk have been modified (acceptance criterion 6)", async () => {
    const storage = new InMemoryStorage();
    const contentStore = new FsContentStore('/cas', storage);

    const soulV1 = '# SOUL v1\nOriginal personality body.';
    const hash1 = await contentStore.put(soulV1);

    const source = await store.createSession({ ...baseSession, key: 'cli:fork-disk' });
    const msg = await store.appendMessage({ sessionId: source.id, role: 'user', content: 'hello' });
    await contextLog.append({
      sessionId: source.id,
      messageId: msg.id,
      kind: 'personality',
      mode: 'replay',
      hash: hash1,
      meta: { via: 'initial' },
      timestamp: Date.parse(msg.timestamp.toISOString()),
    });

    const fork = await repo.fork(source.id);
    const childMessages = await store.getMessages(fork.id);
    const childMsg = childMessages[0];
    if (!childMsg) throw new Error('expected one replayed message');

    // Simulate a hot-reload / disk mutation AFTER the fork: SOUL.md changes on
    // disk, which would derive a DIFFERENT hash if re-read live.
    const soulV2 = '# SOUL v2\nCompletely different body.';
    const hash2 = await contentStore.put(soulV2);
    expect(hash2).not.toBe(hash1);

    const resolved = await contextLog.resolveAt(fork.id, childMsg.id);
    if (resolved.personality === 'unknown')
      throw new Error('expected a resolved personality entry');
    expect(resolved.personality.hash).toBe(hash1);

    // Tier A/B replay: the child reads the CAS blob keyed by the ORIGINAL
    // hash — it never re-derives from disk — so it is byte-for-byte
    // unaffected by the later mutation.
    const replayed = await contentStore.get(resolved.personality.hash);
    expect(replayed).toBe(soulV1);
  });

  it('fork() with no contextLog wired (1-arg constructor) still skips context-event copying — the second constructor param is optional', async () => {
    const bareRepo = new SessionsRepository(store);
    const source = await store.createSession({ ...baseSession, key: 'cli:fork-bare' });
    const msg = await store.appendMessage({ sessionId: source.id, role: 'user', content: 'hi' });
    await contextLog.append({
      sessionId: source.id,
      messageId: msg.id,
      kind: 'personality',
      mode: 'replay',
      hash: 'c'.repeat(64),
      meta: {},
      timestamp: Date.parse(msg.timestamp.toISOString()),
    });

    const fork = await bareRepo.fork(source.id);
    const childMessages = await store.getMessages(fork.id);
    expect(childMessages).toHaveLength(1);
    const childMsg = childMessages[0];
    if (!childMsg) throw new Error('expected one replayed message');

    // No context events copied — resolves unknown on the child, exactly like
    // pre-Phase-E behavior.
    const resolved = await contextLog.resolveAt(fork.id, childMsg.id);
    expect(resolved.personality).toBe('unknown');
  });
});
