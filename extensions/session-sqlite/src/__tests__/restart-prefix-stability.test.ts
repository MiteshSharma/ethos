// Lane 2b — the SQLite half of the restart-prefix contract:
// render(loop_messages) == render(reload(persist(loop_messages))), byte-identical.
//
// The core sibling test (packages/core/src/__tests__/restart-prefix-stability
// .test.ts) proves the LIVE loop and the replay pipeline agree on one store
// instance. This test proves the SQLite persist → process-restart → reload leg
// changes nothing: STRICT-table round-trips, JSON `toolCalls` serialization,
// and the DESC-then-reverse + rowid tie-breaking window must all be
// byte-transparent to the serialized provider messages.
//
// The render is the PRODUCTION replay pipeline exported by @ethosagent/core
// (watermark → dedup → toLLMMessages) — never a test-local serializer.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dedupHistory,
  reconstructFromWatermark,
  selectActiveWatermark,
  toLLMMessages,
} from '@ethosagent/core';
import type { CompressionEvent, StoredMessage } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteSessionStore } from '../index';

const HISTORY_LIMIT = 200;

/** The production replay render, as context-assembly runs it for a default
 *  personality (skills injection_mode 'index' → skillMarkers on). */
function render(history: StoredMessage[], compressions: CompressionEvent[]): string {
  const filtered = history.filter((m) => m.role !== 'system');
  const ghostOpts = { skillMarkers: true };
  const watermark = selectActiveWatermark(compressions);
  const replay = watermark
    ? reconstructFromWatermark(filtered, watermark, ghostOpts).history
    : filtered;
  return JSON.stringify(toLLMMessages(dedupHistory(replay, ghostOpts)));
}

// Persisted exactly as the live loop persists it — the tool_result row carries
// the injection-defense delimiters because the stored bytes are the replay
// bytes (see tool-processing.ts).
const WRAPPED_RESULT = '===TOOL_RESULT_START:echo===\nechoed value\n===TOOL_RESULT_END===';

describe('Lane 2b — restart prefix stability across a SQLite reopen', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ethos-restart-prefix-'));
    dbPath = join(dir, 'sessions.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('renders byte-identical messages before and after closing and reopening the store', async () => {
    const storeA = new SQLiteSessionStore(dbPath);
    const session = await storeA.createSession({
      key: 'cli:restart-prefix',
      platform: 'cli',
      model: 'mock-model',
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
    });

    // A session containing text, tool calls, tool results, and (below) a
    // compaction summary. Appends run back-to-back so same-millisecond
    // timestamps exercise the rowid tie-breaking in getMessages.
    const rows: StoredMessage[] = [];
    const append = async (msg: Omit<StoredMessage, 'id' | 'timestamp' | 'sessionId'>) => {
      rows.push(await storeA.appendMessage({ sessionId: session.id, ...msg }));
    };
    await append({ role: 'user', content: 'turn one' });
    await append({ role: 'assistant', content: 'reply one' });
    await append({ role: 'user', content: 'use the tool' });
    await append({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'tc_1', name: 'echo', input: { value: 'x' } }],
    });
    await append({
      role: 'tool_result',
      content: WRAPPED_RESULT,
      toolCallId: 'tc_1',
      toolName: 'echo',
    });
    await append({ role: 'assistant', content: 'done' });

    // Compaction watermark: everything before 'use the tool' is summarized.
    const keptFrom = rows[2]?.id;
    expect(keptFrom).toBeDefined();
    await storeA.recordCompression({
      sessionId: session.id,
      engineName: 'semantic_summary',
      originalCount: 6,
      keptCount: 5,
      summaryText: 'Earlier the user and the assistant exchanged greetings.',
      keptFromMessageId: keptFrom ?? '',
      summaryTokens: 12,
      preTotalTokens: 100,
      postTotalTokens: 60,
      durationMs: 1,
    });

    // Live view: the rows exactly as the loop appended them, plus the
    // compression event it recorded.
    const liveCompressions = await storeA.listCompressions(session.id);
    const liveRender = render(rows, liveCompressions);

    // Same-connection reload — the getMessages window (DESC-then-reverse,
    // rowid tie-break) must reproduce insertion order.
    const reloadedA = await storeA.getMessages(session.id, { limit: HISTORY_LIMIT });
    const renderA = render(reloadedA, liveCompressions);
    expect(renderA).toBe(liveRender);

    // Restart: close the store, reopen a fresh instance on the same file.
    storeA.close();
    const storeB = new SQLiteSessionStore(dbPath);
    const restarted = await storeB.getSessionByKey('cli:restart-prefix');
    expect(restarted).not.toBeNull();
    if (!restarted) throw new Error('unreachable');
    const reloadedB = await storeB.getMessages(restarted.id, { limit: HISTORY_LIMIT });
    const renderB = render(reloadedB, await storeB.listCompressions(restarted.id));
    storeB.close();

    expect(renderB).toBe(liveRender);
    // The render genuinely contains every shape under test.
    expect(renderB).toContain('"type":"tool_use"');
    expect(renderB).toContain('"type":"tool_result"');
    expect(renderB).toContain('Earlier the user and the assistant exchanged greetings.');
  });
});
