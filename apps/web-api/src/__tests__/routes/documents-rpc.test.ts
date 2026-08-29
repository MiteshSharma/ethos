// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${ETHOS_HOME}` /
// `${self}` are literal fs_reach substitution tokens, not JS template strings.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-documents-rpc-'));
    workdir = join(dataDir, 'workspace', 'writer');
    await mkdir(workdir, { recursive: true });
    await writeFile(join(workdir, 'notes.md'), 'hi');

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
          fs_reach: { workdir: '${ETHOS_HOME}/workspace/${self}' },
        } as PersonalityConfig,
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

  it('root returns the declared workdir', async () => {
    const res = await call('root', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: { root: string; personalityId: string } };
    expect(body.json).toEqual({ root: workdir, personalityId: 'writer' });
  });

  it('list surfaces size and mtime', async () => {
    const res = await call('list', { personalityId: 'writer' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      json: { entries: Array<{ name: string; size?: number; mtimeMs?: number }> };
    };
    expect(body.json.entries).toHaveLength(1);
    expect(body.json.entries[0]?.name).toBe('notes.md');
    expect(body.json.entries[0]?.size).toBe(2);
    expect(body.json.entries[0]?.mtimeMs).toBeGreaterThan(0);
  });

  it('delete removes the file, and refuses one outside the root', async () => {
    const refused = await call('delete', { path: '../../outside.txt' });
    expect(refused.status).toBe(403);

    const ok = await call('delete', { path: 'notes.md' });
    expect(ok.status).toBe(200);

    const after = await call('list', {});
    const body = (await after.json()) as { json: { entries: unknown[] } };
    expect(body.json.entries).toEqual([]);
  });

  it('401s without the cookie', async () => {
    const res = await app.request('/rpc/documents/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify({ json: {} }),
    });
    expect(res.status).toBe(401);
  });
});
