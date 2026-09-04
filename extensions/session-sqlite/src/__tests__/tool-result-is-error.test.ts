import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '@ethosagent/sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteSessionStore } from '../index';

// `messages.is_error` — did this `tool_result` row record a failure? Three
// answers, not two: 1 failed, 0 succeeded, NULL never recorded. A row written
// before the column existed must read back as UNKNOWN, because reading it as a
// success would fabricate exactly the assurance the flag exists to make honest
// (plan/phases/feedback-activity-contract.md §3).

const baseSession = {
  key: 'cli:is-error',
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

describe('StoredMessage.isError round trip', () => {
  let store: SQLiteSessionStore;

  beforeEach(() => {
    store = new SQLiteSessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('round-trips a recorded failure as true and a recorded success as false', async () => {
    const session = await store.createSession(baseSession);
    await store.appendMessage({
      sessionId: session.id,
      role: 'tool_result',
      content: 'boom',
      toolCallId: 't1',
      toolName: 'probe',
      isError: true,
    });
    await store.appendMessage({
      sessionId: session.id,
      role: 'tool_result',
      content: 'fine',
      toolCallId: 't2',
      toolName: 'probe',
      isError: false,
    });

    const rows = await store.getMessages(session.id);
    expect(rows.map((m) => m.isError)).toEqual([true, false]);
  });

  it('leaves the flag absent when the caller did not record one', async () => {
    const session = await store.createSession(baseSession);
    await store.appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'hello',
    });

    const rows = await store.getMessages(session.id);
    expect(rows[0]?.isError).toBeUndefined();
  });
});

describe('is_error migration', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ethos-is-error-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a pre-migration row back as UNKNOWN, never as a success', async () => {
    const dbPath = join(dir, 'sessions.db');

    // Build the "before" database: full schema, minus the column this change
    // adds, with one tool_result row already in it.
    const first = new SQLiteSessionStore(dbPath);
    const session = await first.createSession(baseSession);
    await first.appendMessage({
      sessionId: session.id,
      role: 'tool_result',
      content: 'wrote before the flag existed',
      toolCallId: 't1',
      toolName: 'probe',
    });
    first.close();

    const raw = new Database(dbPath);
    raw.exec('ALTER TABLE messages DROP COLUMN is_error');
    const cols = raw.pragma('table_info(messages)') as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'is_error')).toBe(false);
    raw.close();

    // Reopen: the migration adds the column back, and the old row has NULL.
    const migrated = new SQLiteSessionStore(dbPath);
    const rows = await migrated.getMessages(session.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isError).toBeUndefined();
    // The distinction that matters: absent is NOT a recorded success.
    expect(rows[0]?.isError).not.toBe(false);

    // And a row written after the migration is distinguishable from it.
    await migrated.appendMessage({
      sessionId: session.id,
      role: 'tool_result',
      content: 'fine',
      toolCallId: 't2',
      toolName: 'probe',
      isError: false,
    });
    const after = await migrated.getMessages(session.id);
    expect(after.map((m) => m.isError)).toEqual([undefined, false]);
    migrated.close();
  });
});
