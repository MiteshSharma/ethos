import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClarifyBridge, FileClarifyStore } from '@ethosagent/core';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage, InMemoryStorage } from '@ethosagent/storage-fs';
import type { PendingClarify } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import {
  makeStubAgentLoop,
  makeStubMemoryProvider,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// `clarify.respond` is the SIBLING of the takeover socket's `handback` frame —
// `TakeoverMode` falls back to it whenever the screencast lane is not live —
// and it carried the same bug in a smaller shape: `return { ok: true }` on
// every path, including `context.clarifyBridge?.respond(...)` optional-chaining
// past an absent bridge into a success the caller renders as "done".
//
// `{ ok: true }` now means the row was RESOLVED. These tests drive the three
// ways it is not, and the one way it is.

function row(over: Partial<PendingClarify> = {}): PendingClarify {
  return {
    requestId: 'req-1',
    sessionId: 'web:sess-1',
    surfaceType: 'web',
    surfaceContext: {},
    question: 'Sign in and hand the browser back.',
    answerableBy: 'anyone',
    createdAt: '2026-08-20T11:00:00.000Z',
    defaultDeadlineAt: '2026-08-20T12:00:00.000Z',
    presentedAt: '2026-08-20T11:00:00.000Z',
    ...over,
  };
}

describe('clarify.respond RPC', () => {
  let dataDir: string;
  let sessions: SQLiteSessionStore;
  let clarifyStore: FileClarifyStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;

  /** Build the API with, or deliberately without, a bridge on the loop. */
  async function boot(withBridge: boolean): Promise<void> {
    const loop = makeStubAgentLoop();
    if (withBridge) {
      const bridge = new ClarifyBridge(clarifyStore, { reconcilePollMs: 0 });
      (loop as unknown as { clarifyBridge: ClarifyBridge }).clarifyBridge = bridge;
    }
    app = createWebApi({
      dataDir,
      sessionStore: sessions,
      memoryProvider: makeStubMemoryProvider(),
      agentLoop: loop,
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
    }).app;

    const tokens = new WebTokenRepository({ dataDir, storage: new FsStorage() });
    const token = await tokens.getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000' },
    });
    cookie = (exchange.headers.get('set-cookie') ?? '').split(/;\s*/)[0] ?? '';
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-clarify-respond-'));
    sessions = new SQLiteSessionStore(':memory:');
    clarifyStore = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
  });

  afterEach(async () => {
    sessions.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const respond = async (requestId: string) =>
    app.request('/rpc/clarify/respond', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ json: { requestId, answer: 'handed back', source: 'user' } }),
    });

  it('does not return ok when this process has no clarify bridge', async () => {
    await boot(false);
    await clarifyStore.add(row());

    const res = await respond('req-1');

    // The whole of the old bug: optional chaining called nothing and the
    // handler returned success anyway.
    expect(res.status).not.toBe(200);
    expect(await res.text()).toContain('no clarify bridge');
  });

  it('does not return ok for a request that is no longer open', async () => {
    // Nothing in memory and nothing on disk — answered in another tab a moment
    // ago, or timed out. `ClarifyBridge.respond()` returns quietly here.
    await boot(true);

    const res = await respond('req-gone');

    expect(res.status).not.toBe(200);
    expect(await res.text()).toContain('did not land');
  });

  it('does not return ok for a takeover the bridge refuses to answer', async () => {
    // The answer gate (`isClarifyAnswerableOn`): a `browser_takeover` routed to
    // a channel cannot be handed back from anywhere but that channel's
    // allowlist, and web is not on it for a telegram-surfaced row. `respond()`
    // refuses SILENTLY, which is exactly the shape this endpoint must not read
    // as a hand-back.
    await boot(true);
    await clarifyStore.add(row({ kind: 'browser_takeover', surfaceType: 'telegram' }));

    const res = await respond('req-1');

    expect(res.status).not.toBe(200);
    const stored = await clarifyStore.get('req-1');
    expect(stored?.answer).toBeUndefined();
  });

  it('returns ok — and records the answer — when the row actually resolves', async () => {
    // The control. Without it every assertion above is satisfied by an endpoint
    // that always fails.
    await boot(true);
    await clarifyStore.add(row());

    const res = await respond('req-1');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ json: { ok: true } });
    const stored = await clarifyStore.get('req-1');
    expect(stored?.answer).toMatchObject({ answer: 'handed back', source: 'user' });
  });
});
