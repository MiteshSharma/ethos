// B1 — `x-request-id` on the web API.
//
// Four properties, in the order the plan states them:
//   1. every response echoes an id,
//   2. an INBOUND id is respected, not regenerated,
//   3. the id is on the error envelope,
//   4. the id is on the SSE stream — both as a response header and, because
//      `EventSource` hides response headers from browser code, as the first
//      frame of the stream itself.
//
// Plus the one that keeps it safe: a malformed inbound id is discarded rather
// than reflected, since the value is written back into a response header.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import {
  makeStubAgentLoop,
  makeStubMemoryProvider,
  makeStubPersonalityRegistry,
} from '../test-helpers';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('x-request-id middleware (B1)', () => {
  let dir: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-reqid-'));
    store = new SQLiteSessionStore(':memory:');
    app = createWebApi({
      dataDir: dir,
      sessionStore: store,
      memoryProvider: makeStubMemoryProvider(),
      agentLoop: makeStubAgentLoop({
        events: [
          { type: 'run_start', provider: 'anthropic', model: 'm', source: 'global' },
          { type: 'text_delta', text: 'pong' },
          { type: 'done', text: 'pong', turnCount: 1 },
        ],
      }),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
    }).app;

    const tokens = new WebTokenRepository({ dataDir: dir, storage: new FsStorage() });
    const token = await tokens.getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000' },
    });
    cookie = (exchange.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('echoes a generated UUID on a plain response', async () => {
    const res = await app.request('/healthz');
    const id = res.headers.get('x-request-id');
    expect(id).toBeTruthy();
    expect(id ?? '').toMatch(UUID_RE);
  });

  it('echoes on an authenticated RPC response too', async () => {
    const res = await app.request('/rpc/chat/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost:3000' },
      body: JSON.stringify({ json: { clientId: 'tab-1', text: 'hi' } }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id') ?? '').toMatch(UUID_RE);
  });

  it('respects an inbound id instead of regenerating one', async () => {
    const inbound = 'client-supplied-abc123';
    const res = await app.request('/healthz', { headers: { 'x-request-id': inbound } });
    expect(res.headers.get('x-request-id')).toBe(inbound);
  });

  it('regenerates when the inbound id is malformed or over-long', async () => {
    const hostile = 'probe"id;injected';
    const res = await app.request('/healthz', { headers: { 'x-request-id': hostile } });
    const id = res.headers.get('x-request-id');
    expect(id).not.toBe(hostile);
    expect(id ?? '').toMatch(UUID_RE);

    const overLong = 'a'.repeat(300);
    const res2 = await app.request('/healthz', { headers: { 'x-request-id': overLong } });
    const id2 = res2.headers.get('x-request-id');
    expect(id2).not.toBe(overLong);
    expect(id2 ?? '').toMatch(UUID_RE);
  });

  it('puts the id on the error envelope, matching the response header', async () => {
    const inbound = 'envelope-probe-1';
    // Unauthenticated RPC → the auth middleware raises an EthosError, which
    // `errorHandler` renders as the envelope.
    const res = await app.request('/rpc/sessions/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': inbound },
      body: JSON.stringify({ json: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('x-request-id')).toBe(inbound);
    const body = (await res.json()) as { requestId?: string; code?: string };
    expect(body.requestId).toBe(inbound);
  });

  it('carries the id on the SSE stream — header AND leading stream_meta frame', async () => {
    const send = await app.request('/rpc/chat/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost:3000' },
      body: JSON.stringify({ json: { clientId: 'tab-1', text: 'hi' } }),
    });
    const { sessionId } = ((await send.json()) as { json: { sessionId: string } }).json;

    const inbound = 'sse-probe-1';
    const sse = await app.request(`/sse/sessions/${sessionId}`, {
      headers: { cookie, 'x-request-id': inbound },
    });
    expect(sse.status).toBe(200);
    expect(sse.headers.get('x-request-id')).toBe(inbound);

    const first = await readFirstFrame(sse, 1000);
    expect(first).toEqual({ type: 'stream_meta', requestId: inbound });
  });

  it('the chat.send turnId is the request id, not a freshly minted UUID', async () => {
    const inbound = 'turn-handle-1';
    const res = await app.request('/rpc/chat/send', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost:3000',
        'x-request-id': inbound,
      },
      body: JSON.stringify({ json: { clientId: 'tab-1', text: 'hi' } }),
    });
    const body = (await res.json()) as { json: { turnId: string } };
    expect(body.json.turnId).toBe(inbound);
    expect(res.headers.get('x-request-id')).toBe(inbound);
  });
});

/** Read just the first complete SSE frame's JSON payload. */
async function readFirstFrame(response: Response, timeoutMs: number): Promise<unknown> {
  if (!response.body) throw new Error('SSE response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const start = Date.now();
  try {
    while (Date.now() - start < timeoutMs) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) buf += decoder.decode(value, { stream: true });
      const split = buf.indexOf('\n\n');
      if (split === -1) continue;
      const frame = buf.slice(0, split);
      for (const line of frame.split('\n')) {
        if (line.startsWith('data:')) return JSON.parse(line.slice(5).trimStart());
      }
      return null;
    }
  } finally {
    reader.releaseLock();
    void response.body.cancel().catch(() => {});
  }
  throw new Error('timed out waiting for the first SSE frame');
}
