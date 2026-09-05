// SQLiteContextLog correctness — append/resolveAt/listRefs against a
// hand-built fixture (plan/phases/model-visible-logged.md, Phase B, D3/D5).
// A preview of acceptance criterion 5: resolveAt's last-write-wins query
// logic, verified directly, without any Phase E consumer.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteContextLog } from '../context-log';
import { SQLiteSessionStore } from '../index';

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

describe('SQLiteContextLog', () => {
  let dir: string;
  let dbPath: string;
  let sessionStore: SQLiteSessionStore;
  let contextLog: SQLiteContextLog;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ethos-context-log-'));
    dbPath = join(dir, 'sessions.db');
    // Same file, separate handle — the design this test exists to confirm (D5).
    sessionStore = new SQLiteSessionStore(dbPath);
    contextLog = new SQLiteContextLog(dbPath);
  });

  afterEach(() => {
    sessionStore.close();
    contextLog.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves "unknown" for a kind with no prior event', async () => {
    const session = await sessionStore.createSession(baseSession);
    const msg = await sessionStore.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: 'hi',
    });

    const resolved = await contextLog.resolveAt(session.id, msg.id);
    expect(resolved.personality).toBe('unknown');
    expect(resolved.memory).toBe('unknown');
    expect(resolved.file_window).toBe('unknown');
    expect(resolved.team_index).toBe('unknown');
  });

  it('last-write-wins: resolves to the most recent event at or before the target message', async () => {
    const session = await sessionStore.createSession(baseSession);
    const msg1 = await sessionStore.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: 'turn 1',
    });

    await contextLog.append({
      sessionId: session.id,
      messageId: msg1.id,
      kind: 'personality',
      mode: 'replay',
      hash: 'a'.repeat(64),
      meta: { via: 'initial' },
      timestamp: Date.parse(msg1.timestamp.toISOString()),
    });

    // A later message with no NEW personality event still resolves to the
    // first one — last-write-wins across turns, not per-turn re-derivation.
    // The delay guarantees a distinct millisecond timestamp from msg1: without
    // it, two `appendMessage` calls this close together can land in the same
    // tick, and last-write-wins has no way to order two same-timestamp
    // messages against each other (only against context events, via rowid).
    await new Promise((r) => setTimeout(r, 5));
    const msg2 = await sessionStore.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: 'turn 2',
    });
    const resolvedAtMsg2 = await contextLog.resolveAt(session.id, msg2.id);
    expect(resolvedAtMsg2.personality).toEqual({
      hash: 'a'.repeat(64),
      mode: 'replay',
      meta: { via: 'initial' },
      timestamp: Date.parse(msg1.timestamp.toISOString()),
    });

    // A second event on a later message supersedes the first.
    await contextLog.append({
      sessionId: session.id,
      messageId: msg2.id,
      kind: 'personality',
      mode: 'replay',
      hash: 'b'.repeat(64),
      meta: { via: 'hot-reload' },
      timestamp: Date.parse(msg2.timestamp.toISOString()),
    });
    const resolvedAfterSecond = await contextLog.resolveAt(session.id, msg2.id);
    expect(resolvedAfterSecond.personality).toMatchObject({ hash: 'b'.repeat(64) });

    // Resolving at msg1 (before the second event) still returns the first.
    const resolvedAtMsg1Again = await contextLog.resolveAt(session.id, msg1.id);
    expect(resolvedAtMsg1Again.personality).toMatchObject({ hash: 'a'.repeat(64) });
  });

  it("scopes resolution by session — one session never sees another session's events", async () => {
    const sessionA = await sessionStore.createSession({ ...baseSession, key: 'cli:a' });
    const sessionB = await sessionStore.createSession({ ...baseSession, key: 'cli:b' });
    const msgA = await sessionStore.appendMessage({
      sessionId: sessionA.id,
      role: 'user',
      content: 'hi',
    });
    const msgB = await sessionStore.appendMessage({
      sessionId: sessionB.id,
      role: 'user',
      content: 'hi',
    });

    await contextLog.append({
      sessionId: sessionA.id,
      messageId: msgA.id,
      kind: 'memory',
      mode: 'replay',
      hash: 'c'.repeat(64),
      meta: {},
      timestamp: Date.parse(msgA.timestamp.toISOString()),
    });

    const resolvedB = await contextLog.resolveAt(sessionB.id, msgB.id);
    expect(resolvedB.memory).toBe('unknown');
  });

  it('listRefs returns the distinct set of hashes referenced across all sessions', async () => {
    const session = await sessionStore.createSession(baseSession);
    const msg = await sessionStore.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: 'hi',
    });

    await contextLog.append({
      sessionId: session.id,
      messageId: msg.id,
      kind: 'personality',
      mode: 'replay',
      hash: 'd'.repeat(64),
      meta: {},
      timestamp: Date.parse(msg.timestamp.toISOString()),
    });
    await contextLog.append({
      sessionId: session.id,
      messageId: msg.id,
      kind: 'memory',
      mode: 'replay',
      hash: 'd'.repeat(64), // same hash, different kind — dedup expected
      meta: {},
      timestamp: Date.parse(msg.timestamp.toISOString()),
    });
    await contextLog.append({
      sessionId: session.id,
      messageId: msg.id,
      kind: 'file_window',
      mode: 'detect',
      hash: 'e'.repeat(64),
      meta: {},
      timestamp: Date.parse(msg.timestamp.toISOString()),
    });

    const refs = await contextLog.listRefs();
    expect(new Set(refs)).toEqual(new Set(['d'.repeat(64), 'e'.repeat(64)]));
  });

  it('throws for an unknown messageId', async () => {
    const session = await sessionStore.createSession(baseSession);
    await expect(contextLog.resolveAt(session.id, 'no-such-message')).rejects.toThrow();
  });

  it('deleting a session cascades its context events, so listRefs stops reporting a hash only that session referenced but keeps one a surviving session still references', async () => {
    const sessionA = await sessionStore.createSession({ ...baseSession, key: 'cli:a' });
    const sessionB = await sessionStore.createSession({ ...baseSession, key: 'cli:b' });
    const msgA = await sessionStore.appendMessage({
      sessionId: sessionA.id,
      role: 'user',
      content: 'hi from a',
    });
    const msgB = await sessionStore.appendMessage({
      sessionId: sessionB.id,
      role: 'user',
      content: 'hi from b',
    });

    const sharedHash = 'f'.repeat(64);
    const exclusiveHash = 'a'.repeat(64);

    // Session A references both a hash shared with session B and one only it
    // references.
    await contextLog.append({
      sessionId: sessionA.id,
      messageId: msgA.id,
      kind: 'personality',
      mode: 'replay',
      hash: sharedHash,
      meta: {},
      timestamp: Date.parse(msgA.timestamp.toISOString()),
    });
    await contextLog.append({
      sessionId: sessionA.id,
      messageId: msgA.id,
      kind: 'memory',
      mode: 'replay',
      hash: exclusiveHash,
      meta: {},
      timestamp: Date.parse(msgA.timestamp.toISOString()),
    });
    // Session B references the shared hash too.
    await contextLog.append({
      sessionId: sessionB.id,
      messageId: msgB.id,
      kind: 'personality',
      mode: 'replay',
      hash: sharedHash,
      meta: {},
      timestamp: Date.parse(msgB.timestamp.toISOString()),
    });

    await sessionStore.deleteSession(sessionA.id);

    const refs = await contextLog.listRefs();
    expect(refs).not.toContain(exclusiveHash);
    expect(refs).toContain(sharedHash);
  });
});

// ---------------------------------------------------------------------------
// Durability posture — see AGENTS.md's SQLite store roster.
// ---------------------------------------------------------------------------

/** Reads `PRAGMA synchronous` off the store's OWN handle — it is a
 *  per-connection setting, so a second connection to the same file would
 *  report its own default and prove nothing. 2 = FULL (SQLite's default),
 *  1 = NORMAL. */
function syncPragma(store: unknown): number {
  const rows = (store as { db: { pragma(s: string): unknown } }).db.pragma('synchronous');
  return (rows as Array<{ synchronous: number }>)[0]?.synchronous ?? -1;
}

describe('SQLiteContextLog — durability posture', () => {
  it('stays at synchronous = FULL', () => {
    // Same file as sessions.db, separate handle — and `synchronous` is a
    // PER-CONNECTION setting, so this handle needs its own pin. Same reasoning
    // as SQLiteSessionStore: this is what `ethos why` reconstructs a turn's
    // context from, and a rolled-back tail is a turn that can no longer be
    // explained.
    const dir = mkdtempSync(join(tmpdir(), 'ethos-context-log-sync-'));
    // `sessions` must exist before SQLiteContextLog's CREATE TABLE ... REFERENCES.
    const sessions = new SQLiteSessionStore(join(dir, 'sessions.db'));
    const log = new SQLiteContextLog(join(dir, 'sessions.db'));
    // Asserted against the opened database, not the source text.
    expect(syncPragma(log)).toBe(2);
    log.close();
    sessions.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
