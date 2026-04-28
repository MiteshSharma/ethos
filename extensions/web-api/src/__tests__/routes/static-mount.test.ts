import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi } from '../../index';
import { makeStubAgentLoop, makeStubPersonalityRegistry } from '../test-helpers';

// Confirms the static mount lights up when `webDist` is supplied — the
// last piece of the v0 web foundation (26.W1). Auth + RPC + SSE wiring
// continues to behave as before; the static handler just sits at the
// bottom of the stack so unmatched paths fall through to it.

describe('createWebApi — static SPA mount', () => {
  let dir: string;
  let dist: string;
  let store: SQLiteSessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-webapi-static-'));
    dist = join(dir, 'web-dist');
    await mkdir(join(dist, 'assets'), { recursive: true });
    await writeFile(
      join(dist, 'index.html'),
      '<!doctype html><title>Ethos</title><div id="root"></div>',
      'utf-8',
    );
    await writeFile(join(dist, 'assets', 'main.js'), 'export {};', 'utf-8');
    store = new SQLiteSessionStore(':memory:');
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  function makeApp(webDist?: string) {
    return createWebApi({
      dataDir: dir,
      sessionStore: store,
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'm', provider: 'p' },
      ...(webDist ? { webDist } : {}),
    });
  }

  it('serves index.html at / when webDist is set', async () => {
    const app = makeApp(dist);
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Ethos');
  });

  it('serves built assets at their path', async () => {
    const app = makeApp(dist);
    const res = await app.request('/assets/main.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/javascript');
  });

  it('SPA-falls-back to index.html for client-side routes', async () => {
    const app = makeApp(dist);
    const res = await app.request('/chat');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('does NOT intercept /rpc paths even when SPA is mounted', async () => {
    // No cookie → auth middleware returns 401 BEFORE the static handler
    // ever gets a chance to fall through to index.html.
    const app = makeApp(dist);
    const res = await app.request('/rpc/sessions/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify({ json: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown paths when webDist is omitted (no SPA mount)', async () => {
    const app = makeApp(); // no dist
    const res = await app.request('/some-client-route');
    expect(res.status).toBe(404);
  });
});
