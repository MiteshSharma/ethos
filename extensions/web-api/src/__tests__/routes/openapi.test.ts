import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import { makeStubAgentLoop, makeStubPersonalityRegistry } from '../test-helpers';

// OpenAPI surface tests. Three things must work:
//   1. /openapi/spec.json — auto-generated from the Zod contract, lists every
//      procedure under its expected path
//   2. /openapi/         — Scalar UI HTML page (HEAD/GET reachable)
//   3. /openapi/<route>  — REST-shaped endpoint that hits the same service +
//      validates input through the same Zod schema (so contract drift between
//      RPC and OpenAPI surfaces is impossible)
//
// All three are auth-gated. Devs sign in via /auth/exchange?t=<token> first.

describe('createWebApi — OpenAPI surface', () => {
  let dir: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-openapi-'));
    store = new SQLiteSessionStore(':memory:');
    app = createWebApi({
      dataDir: dir,
      sessionStore: store,
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
    }).app;

    // Cookie-auth setup — same dance as the auth-and-rpc test
    const tokens = new WebTokenRepository({ dataDir: dir });
    const token = await tokens.getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000' },
    });
    expect(exchange.status).toBe(302);
    const setCookie = exchange.headers.get('set-cookie') ?? '';
    cookie = setCookie.split(';')[0] ?? '';
    expect(cookie).toMatch(/^ethos_auth=/);
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('/openapi/spec.json returns a valid OpenAPI 3.x doc covering every contract namespace', async () => {
    const res = await app.request('/openapi/spec.json', {
      headers: { cookie, origin: 'http://localhost:3000' },
    });
    expect(res.status).toBe(200);

    const spec = (await res.json()) as {
      openapi?: string;
      info?: { title?: string; version?: string };
      paths?: Record<string, unknown>;
    };

    // OpenAPI version + info block (set via specGenerateOptions)
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info?.title).toBe('Ethos Web API');
    expect(spec.info?.version).toBe('0.1.0');

    // Every wired namespace has at least one path entry. Procedures without
    // explicit `.route()` annotations land under their RPC paths (e.g.
    // `/sessions/list`, `/chat/send`), which is fine for now — what matters
    // is that the docs surface them.
    const paths = Object.keys(spec.paths ?? {});
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.some((p) => p.includes('sessions'))).toBe(true);
    expect(paths.some((p) => p.includes('chat'))).toBe(true);
  });

  it('/openapi/ serves the Scalar reference UI as HTML', async () => {
    const res = await app.request('/openapi/', {
      headers: { cookie, origin: 'http://localhost:3000' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/i);
    const html = await res.text();
    // The Scalar bundle URL is what tells us the docs UI rendered (rather than
    // some accidental empty-200). Don't assert exact bytes — the script URL
    // can update with @scalar/api-reference versions.
    expect(html.toLowerCase()).toContain('scalar');
  });

  it('/openapi/spec.json is rejected without auth cookie', async () => {
    const res = await app.request('/openapi/spec.json', {
      headers: { origin: 'http://localhost:3000' },
    });
    expect(res.status).toBe(401);
  });

  it('REST-shaped endpoint at /openapi/sessions/list hits the same service as /rpc/sessions/list', async () => {
    const res = await app.request('/openapi/sessions/list', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[]; nextCursor: string | null };
    expect(body.sessions).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });
});
