import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import type { ActivityHistoryRow } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import type { ActivityHistoryFn } from '../../routes/index';
import {
  makeStubAgentLoop,
  makeStubMemoryProvider,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// Proves the `activity` namespace is wired end-to-end through the contract, and
// that a deployment with no observability store degrades to an empty page
// rather than erroring — the same posture `sessions.contextAnatomy` takes.

function row(over: Partial<ActivityHistoryRow> = {}): ActivityHistoryRow {
  return {
    id: 'span-1',
    kind: 'tool_call',
    name: 'read_file',
    sessionId: 'sess-a',
    personalityId: 'agent-a',
    startedAt: 1000,
    endedAt: 1010,
    status: 'ok',
    details: { path: '/tmp/x' },
    ...over,
  };
}

describe('activity RPC', () => {
  let dataDir: string;
  let store: SQLiteSessionStore;
  let cookie: string;
  let calls: Array<Parameters<ActivityHistoryFn>[0]>;

  async function boot(activityHistoryFn?: ActivityHistoryFn) {
    const app = createWebApi({
      dataDir,
      sessionStore: store,
      memoryProvider: makeStubMemoryProvider(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
      ...(activityHistoryFn ? { activityHistoryFn } : {}),
    }).app;

    const tokens = new WebTokenRepository({ dataDir, storage: new FsStorage() });
    const token = await tokens.getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000' },
    });
    cookie = (exchange.headers.get('set-cookie') ?? '').split(/;\s*/)[0] ?? '';
    return app;
  }

  const call = (app: Awaited<ReturnType<typeof boot>>, input: unknown) =>
    app.request('/rpc/activity/history', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ json: input }),
    });

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-activity-rpc-'));
    store = new SQLiteSessionStore(':memory:');
    calls = [];
  });

  afterEach(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('returns an empty page when no observability store is wired', async () => {
    const app = await boot();
    const res = await call(app, { limit: 50 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      json: { items: unknown[]; nextBefore: number | null; nextBeforeId: string | null };
    };
    expect(body.json).toEqual({ items: [], nextBefore: null, nextBeforeId: null });
  });

  it('passes the personality filter and cursor through to the store', async () => {
    const app = await boot((filter) => {
      calls.push(filter);
      return [row()];
    });
    const res = await call(app, {
      personalityId: 'agent-a',
      limit: 10,
      before: 5000,
      beforeId: 'span-9',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: { items: ActivityHistoryRow[] } };
    expect(body.json.items).toEqual([row()]);
    // Both halves of the cursor reach the store — the timestamp alone cannot
    // resume inside a group of rows that share one millisecond.
    expect(calls).toEqual([
      { personalityId: 'agent-a', limit: 10, before: 5000, beforeId: 'span-9' },
    ]);
  });

  it('omits personalityId from the filter at the global altitude', async () => {
    const app = await boot((filter) => {
      calls.push(filter);
      return [];
    });
    await call(app, { personalityId: null, limit: 50 });
    expect(calls).toEqual([{ limit: 50 }]);
  });

  it('hands back both halves of the cursor, and only on a full page', async () => {
    const app = await boot(() => [
      row({ id: 'a', startedAt: 300 }),
      row({ id: 'b', startedAt: 200 }),
    ]);
    const full = (await (await call(app, { limit: 2 })).json()) as {
      json: { nextBefore: number | null; nextBeforeId: string | null };
    };
    expect(full.json.nextBefore).toBe(200);
    expect(full.json.nextBeforeId).toBe('b');

    const short = (await (await call(app, { limit: 5 })).json()) as {
      json: { nextBefore: number | null; nextBeforeId: string | null };
    };
    expect(short.json.nextBefore).toBeNull();
    expect(short.json.nextBeforeId).toBeNull();
  });
});
