import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import { makeStubAgentLoop, makeStubPersonalityRegistry } from '../test-helpers';

// Route-level tests via Hono's `app.request(...)` helper. No real port; the
// app handles a `Request` directly and returns a `Response`. This catches
// regressions in the HTTP shape (status codes, cookie headers, JSON envelope
// formatting) without spinning up a server.

describe('createWebApi — auth + rpc happy path', () => {
  let dir: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>;
  let token: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-webapi-'));
    store = new SQLiteSessionStore(':memory:');
    app = createWebApi({
      dataDir: dir,
      sessionStore: store,
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
    });
    // Pre-create a token so we can run the exchange without waiting for it
    // to be lazily generated on first miss.
    const tokens = new WebTokenRepository({ dataDir: dir });
    token = await tokens.getOrCreate();
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('GET /auth/exchange with valid token sets cookie + 302 to /', async () => {
    const res = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000' },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/ethos_auth=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
  });

  it('exchange rotates the token — replaying the URL fails the second time', async () => {
    const first = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000' },
    });
    expect(first.status).toBe(302);

    const replay = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000' },
    });
    expect(replay.status).toBe(401);
  });

  it('GET /rpc/* without cookie returns 401 (unauthorized envelope)', async () => {
    const res = await app.request('/rpc/sessions/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('POST /rpc with the cookie + same-origin succeeds', async () => {
    // Step 1: grab a fresh cookie via the exchange flow.
    const exchange = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000' },
    });
    const cookieHeader = parseSetCookieValue(exchange.headers.get('set-cookie'));
    expect(cookieHeader).toBeTruthy();

    // Step 2: hit the RPC handler with the cookie attached.
    const res = await app.request('/rpc/sessions/list', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader as string,
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ json: {} }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: { sessions: unknown[]; nextCursor: null } };
    expect(body.json.sessions).toEqual([]);
    expect(body.json.nextCursor).toBeNull();
  });

  it('POST /rpc from a non-localhost Origin is blocked even with valid cookie', async () => {
    const exchange = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000' },
    });
    const cookieHeader = parseSetCookieValue(exchange.headers.get('set-cookie'));

    const res = await app.request('/rpc/sessions/list', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader as string,
        origin: 'http://evil.example.com',
      },
      body: JSON.stringify({ json: {} }),
    });
    expect(res.status).toBe(401);
  });

  // Real SSE behavior is covered in routes/sse.test.ts. Here we just confirm
  // the route exists and is auth-gated (401 without cookie).
  it('SSE handler requires the auth cookie', async () => {
    const res = await app.request('/sse/sessions/sess_1');
    expect(res.status).toBe(401);
  });
});

// `set-cookie` from `Hono`'s response is a single header on the test client
// (multi-value array exists in real envs, but app.request uses a Headers
// object that joins them). We only ever set one auth cookie, so the simple
// extraction below is enough.
function parseSetCookieValue(raw: string | null): string | null {
  if (!raw) return null;
  // Take everything before the first attribute separator
  const first = raw.split(/;\s*/)[0];
  return first ?? null;
}
