// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${ETHOS_HOME}` /
// `${self}` are literal fs_reach substitution tokens, not JS template strings.
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import type { PersonalityConfig } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import {
  makeStubAgentLoop,
  makeStubMemoryProvider,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// Proves the `documents` namespace is wired end-to-end through the contract and
// that its containment holds over the wire, not just in a direct service call.

describe('documents RPC', () => {
  let dataDir: string;
  let workdir: string;
  let secondRoot: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-documents-rpc-'));
    workdir = join(dataDir, 'workspace', 'writer');
    secondRoot = join(dataDir, 'archive');
    await mkdir(workdir, { recursive: true });
    await mkdir(secondRoot, { recursive: true });
    await writeFile(join(workdir, 'notes.md'), 'hi');
    await writeFile(join(secondRoot, 'old.md'), 'older');

    store = new SQLiteSessionStore(':memory:');
    app = createWebApi({
      dataDir,
      sessionStore: store,
      memoryProvider: makeStubMemoryProvider(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry([
        {
          id: 'writer',
          name: 'Writer',
          fs_reach: {
            workdir: ['${ETHOS_HOME}/workspace/${self}', '${ETHOS_HOME}/archive'],
          },
        } as PersonalityConfig,
        // No `fs_reach` at all — Documents is unconfigured for it.
        { id: 'drifter', name: 'Drifter' } as PersonalityConfig,
      ]),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
    }).app;

    const tokens = new WebTokenRepository({ dataDir, storage: new FsStorage() });
    const token = await tokens.getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000' },
    });
    cookie = (exchange.headers.get('set-cookie') ?? '').split(/;\s*/)[0] ?? '';
  });

  afterEach(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const call = (method: string, input: unknown) =>
    app.request(`/rpc/documents/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ json: input }),
    });

  it('root returns every declared workdir, keyed by declaration order', async () => {
    const res = await call('root', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      json: { roots: Array<{ id: string; path: string }>; personalityId: string };
    };
    expect(body.json).toEqual({
      roots: [
        { id: '0', path: workdir },
        { id: '1', path: secondRoot },
      ],
      personalityId: 'writer',
    });
  });

  it('root returns no roots at all for an unconfigured personality', async () => {
    const res = await call('root', { personalityId: 'drifter' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: { roots: unknown[]; personalityId: string } };
    expect(body.json).toEqual({ roots: [], personalityId: 'drifter' });
  });

  it('list surfaces size and mtime, and each root lists independently', async () => {
    const res = await call('list', { personalityId: 'writer', root: '0' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      json: { entries: Array<{ name: string; size?: number; mtimeMs?: number }> };
    };
    expect(body.json.entries).toHaveLength(1);
    expect(body.json.entries[0]?.name).toBe('notes.md');
    expect(body.json.entries[0]?.size).toBe(2);
    expect(body.json.entries[0]?.mtimeMs).toBeGreaterThan(0);

    const second = await call('list', { personalityId: 'writer', root: '1' });
    const secondBody = (await second.json()) as { json: { entries: Array<{ name: string }> } };
    expect(secondBody.json.entries.map((e) => e.name)).toEqual(['old.md']);
  });

  it('list refuses a root id the personality does not declare', async () => {
    const res = await call('list', { root: '9' });
    expect(res.status).toBe(400);
    // oRPC nests a thrown error's envelope under `json`.
    const body = (await res.json()) as { json: { code: string } };
    expect(body.json.code).toBe('INVALID_INPUT');
  });

  it('list refuses a personality with no declared workdir', async () => {
    const res = await call('list', { personalityId: 'drifter', root: '0' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { json: { code: string } };
    expect(body.json.code).toBe('WORKDIR_NOT_CONFIGURED');
  });

  it('delete removes the file, and refuses one outside the root', async () => {
    const refused = await call('delete', { root: '0', path: '../../outside.txt' });
    expect(refused.status).toBe(403);

    const ok = await call('delete', { root: '0', path: 'notes.md' });
    expect(ok.status).toBe(200);

    const after = await call('list', { root: '0' });
    const body = (await after.json()) as { json: { entries: unknown[] } };
    expect(body.json.entries).toEqual([]);
  });

  it('createFolder creates one directory and returns its entry', async () => {
    const res = await call('createFolder', { root: '0', path: 'reports' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      json: { name: string; path: string; isDir: boolean; isSymlink: boolean };
    };
    expect(body.json).toMatchObject({
      name: 'reports',
      path: 'reports',
      isDir: true,
      isSymlink: false,
    });
    expect((await stat(join(workdir, 'reports'))).isDirectory()).toBe(true);
  });

  it('createFolder targets the selected root, not always the first', async () => {
    const res = await call('createFolder', { root: '1', path: 'ledger' });
    expect(res.status).toBe(200);
    expect((await stat(join(secondRoot, 'ledger'))).isDirectory()).toBe(true);
  });

  it('createFolder refuses a collision, a missing parent, and an escape', async () => {
    expect((await call('createFolder', { root: '0', path: 'notes.md' })).status).toBe(409);
    expect((await call('createFolder', { root: '0', path: 'a/b/c' })).status).toBe(404);
    expect((await call('createFolder', { root: '0', path: '../escaped' })).status).toBe(403);
    expect((await call('createFolder', { root: '0', path: '/tmp/escaped' })).status).toBe(403);
  });

  it('createFolder is non-recursive — the parent must already exist', async () => {
    expect((await call('createFolder', { root: '0', path: 'one' })).status).toBe(200);
    expect((await call('createFolder', { root: '0', path: 'one/two' })).status).toBe(200);
    expect((await stat(join(workdir, 'one', 'two'))).isDirectory()).toBe(true);
  });

  it('401s without the cookie', async () => {
    const res = await app.request('/rpc/documents/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify({ json: { root: '0' } }),
    });
    expect(res.status).toBe(401);
  });
});
