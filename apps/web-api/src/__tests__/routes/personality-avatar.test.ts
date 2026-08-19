import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import { AVATAR_MAX_BYTES } from '../../routes/personality-avatar';
import {
  makeStubAgentLoop,
  makeStubMemoryProvider,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// `POST|GET|DELETE /api/personalities/:id/avatar` — mirrors
// `documents-download.test.ts`'s shape: a real `FilePersonalityRegistry`
// backed by real `FsStorage` under a tmpdir (never the user's real
// `~/.ethos`), driven through the actual mounted app via `app.request()` so
// the route-module wiring (basePath, auth posture) is exercised too, not just
// the handler in isolation.

describe('POST|GET|DELETE /api/personalities/:id/avatar', () => {
  let dataDir: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-avatar-route-'));
    const registry = makeStubPersonalityRegistry([], dataDir);
    await registry.create({ id: 'nova', name: 'Nova', toolset: [], soulMd: '# Nova\n' });

    store = new SQLiteSessionStore(':memory:');
    app = createWebApi({
      dataDir,
      sessionStore: store,
      memoryProvider: makeStubMemoryProvider(),
      agentLoop: makeStubAgentLoop(),
      personalities: registry,
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
    }).app;

    const tokens = new WebTokenRepository({ dataDir, storage: new FsStorage() });
    const token = await tokens.getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000' },
    });
    cookie = (exchange.headers.get('set-cookie') ?? '').split(/;\s*/)[0] ?? '';
    expect(cookie).toBeTruthy();
  });

  afterEach(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const personalityDir = () => join(dataDir, 'personalities', 'nova');
  const avatarFiles = async () =>
    (await readdir(personalityDir())).filter((n) => n.startsWith('avatar.'));

  // `Request`'s BodyInit type wants a plain ArrayBuffer, not a
  // `Uint8Array<ArrayBufferLike>` — same DOM-lib friction `static.ts` works
  // around when building a `Response` from bytes.
  const toBody = (bytes: Uint8Array) =>
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

  const post = (body: Uint8Array, contentType: string) =>
    app.request('/api/personalities/nova/avatar', {
      method: 'POST',
      headers: { cookie, 'content-type': contentType },
      body: toBody(body),
    });

  it('401s without a credential', async () => {
    const res = await app.request('/api/personalities/nova/avatar', {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: toBody(new Uint8Array([1, 2, 3])),
    });
    expect(res.status).toBe(401);
  });

  it('accepts a valid upload, writes the file, and updates config.yaml', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const res = await post(bytes, 'image/png');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { avatarUrl: string };
    expect(body.avatarUrl).toBe('/api/personalities/nova/avatar');

    expect(await avatarFiles()).toEqual(['avatar.png']);
    const raw = await readFile(join(personalityDir(), 'config.yaml'), 'utf-8');
    expect(raw).toContain('display.avatar_url: /api/personalities/nova/avatar');
  });

  it('rejects an unsupported MIME type', async () => {
    const res = await post(new Uint8Array([1, 2, 3]), 'text/plain');
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await avatarFiles()).toEqual([]);
  });

  it('rejects an oversized upload before it is fully buffered', async () => {
    const oversized = new Uint8Array(AVATAR_MAX_BYTES + 1);
    const res = await post(oversized, 'image/png');
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await avatarFiles()).toEqual([]);
  });

  it('re-upload with a different extension deletes the stale file', async () => {
    const first = await post(new Uint8Array([1, 2, 3]), 'image/png');
    expect(first.status).toBe(200);
    expect(await avatarFiles()).toEqual(['avatar.png']);

    const second = await post(new Uint8Array([4, 5, 6]), 'image/webp');
    expect(second.status).toBe(200);
    expect(await avatarFiles()).toEqual(['avatar.webp']);
  });

  it('GET serves the correct bytes and content-type', async () => {
    const bytes = new Uint8Array([9, 8, 7, 6, 5]);
    await post(bytes, 'image/jpeg');

    const res = await app.request('/api/personalities/nova/avatar', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('etag')).toBeTruthy();
    expect(res.headers.get('last-modified')).toBeTruthy();
    const got = new Uint8Array(await res.arrayBuffer());
    expect(got).toEqual(bytes);
  });

  it('GET 404s when no avatar is set', async () => {
    const res = await app.request('/api/personalities/nova/avatar', { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it('GET 404s for an unknown personality id', async () => {
    const res = await app.request('/api/personalities/ghost/avatar', { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it('DELETE removes the file and clears display.avatar_url', async () => {
    await post(new Uint8Array([1, 2, 3]), 'image/gif');
    expect(await avatarFiles()).toEqual(['avatar.gif']);

    const del = await app.request('/api/personalities/nova/avatar', {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(del.status).toBe(200);
    expect(await avatarFiles()).toEqual([]);

    const raw = await readFile(join(personalityDir(), 'config.yaml'), 'utf-8');
    expect(raw).not.toContain('display.avatar_url');

    const get = await app.request('/api/personalities/nova/avatar', { headers: { cookie } });
    expect(get.status).toBe(404);
  });
});
