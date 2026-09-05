import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore, SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import {
  makeStubAgentLoop,
  makeStubMemoryProvider,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// Proves the `backup` namespace is wired end-to-end through the contract, and
// that D6 — the web restores `identity` and nothing else — is a SERVER-side
// refusal rather than a missing button.

describe('backup RPC', () => {
  let dataDir: string;
  let prevStateDir: string | undefined;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-backup-rpc-'));
    prevStateDir = process.env.ETHOS_STATE_DIR;
    process.env.ETHOS_STATE_DIR = dataDir;

    await writeFile(join(dataDir, 'config.yaml'), 'schemaVersion: 1\nbackup.keep: 3\n');
    await mkdir(join(dataDir, 'personalities', 'writer'), { recursive: true });
    await writeFile(join(dataDir, 'personalities', 'writer', 'SOUL.md'), '# writer\n');

    store = new SQLiteSessionStore(':memory:');
    app = createWebApi({
      dataDir,
      sessionStore: store,
      memoryProvider: makeStubMemoryProvider(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry([{ id: 'writer', name: 'Writer' }]),
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
    if (prevStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
    else process.env.ETHOS_STATE_DIR = prevStateDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  // oRPC's JSON serializer wraps both directions in `{ json: ... }`.
  const call = (method: string, input: unknown = {}) =>
    app.request(`/rpc/backup/${method}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify({ json: input }),
    });

  const payload = async <T>(res: Response): Promise<T> => ((await res.json()) as { json: T }).json;

  /** oRPC wraps thrown `EthosError`s the same way it wraps results. */
  const failure = async (res: Response): Promise<{ code: string; message: string }> =>
    ((await res.json()) as { json: { code: string; message: string } }).json;

  it('401s without a credential', async () => {
    const res = await app.request('/rpc/backup/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify({ json: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('status answers the whole pane header in one call', async () => {
    const res = await call('status');
    expect(res.status).toBe(200);
    const body = await payload<Record<string, unknown>>(res);

    expect(body).toMatchObject({
      directory: join(dataDir, 'backups'),
      running: false,
      // A cookie caller CAN use the raw download route.
      downloadAvailable: true,
      lastBackup: null,
      archives: [],
    });
    // The restart notice keys off this: an identity restore rewrites files
    // that are read at boot, and only a changed start time proves the restart.
    expect(typeof body.serverStartedAt).toBe('string');
    expect(Number.isNaN(Date.parse(String(body.serverStartedAt)))).toBe(false);
    // `backup.keep: 3` in config.yaml is reflected, so the pane is honest.
    expect(body.schedule).toMatchObject({ enabled: true, keep: 3, nextRunAt: null });
    expect(Array.isArray(body.stores)).toBe(true);
  });

  it('create writes an archive that then shows up in status', async () => {
    const created = await call('create');
    expect(created.status).toBe(200);
    const result = await payload<{ archive: { name: string; bytes: number } }>(created);
    expect(result.archive.name).toMatch(/^ethos-web-.*\.tar\.gz$/);
    expect(result.archive.bytes).toBeGreaterThan(0);

    const status = await payload<{
      archives: Array<{ name: string }>;
      lastBackup: { ok: boolean } | null;
    }>(await call('status'));
    expect(status.archives.map((a) => a.name)).toEqual([result.archive.name]);
    expect(status.lastBackup?.ok).toBe(true);
  });

  it('rejects a `state` restore over RPC (D6)', async () => {
    const { archive } = await payload<{ archive: { name: string } }>(await call('create'));

    const res = await call('restoreIdentity', { name: archive.name, scopes: ['state'] });

    expect(res.status).toBe(403);
    const body = await failure(res);
    expect(body.code).toBe('FORBIDDEN');
    expect(body.message).toMatch(/only the `identity` scope/i);
    expect(body.message).toMatch(/in-use check/);
  });

  it('restores identity and carries inUseCheck + restartRequired to the client', async () => {
    const { archive } = await payload<{ archive: { name: string } }>(await call('create'));

    const res = await call('restoreIdentity', { name: archive.name });
    expect(res.status).toBe(200);
    const report = await payload<Record<string, unknown>>(res);

    expect(report.scopes).toEqual(['identity']);
    expect(report.inUseCheck).toBe('held');
    expect(report.restartRequired).toBe(true);
    expect(Array.isArray(report.lockedDatabases)).toBe(true);
    expect(report).toHaveProperty('secretsManifest');
  });

  it('refuses an archive name that is a path', async () => {
    const res = await call('restoreIdentity', { name: '../../etc/passwd' });
    expect(res.status).toBe(400);
    expect(await failure(res)).toMatchObject({ code: 'INVALID_INPUT' });
  });

  // The download route is cookie-only. A caller that cannot present a cookie
  // must be TOLD, not handed a link that 401s on click. Today that answer is
  // absolute: `backup` is not in `dual-auth.ts`'s SCOPE_MAP, so an API key is
  // refused the whole namespace with a message naming cookie auth — nothing
  // reaches such a client that it could render a download from. The
  // `downloadAvailable` field carries the same fact in the payload, and is
  // what keeps this honest if `backup` is ever scope-mapped.
  it('refuses an API-key caller outright, naming cookie auth', async () => {
    const apiKeys = new SqliteApiKeyStore(':memory:');
    try {
      const bearerApp = createWebApi({
        dataDir,
        sessionStore: store,
        memoryProvider: makeStubMemoryProvider(),
        agentLoop: makeStubAgentLoop(),
        personalities: makeStubPersonalityRegistry([{ id: 'writer', name: 'Writer' }]),
        chatDefaults: { model: 'claude-test', provider: 'anthropic' },
        apiKeys,
      }).app;
      const { secret } = await apiKeys.create({ name: 'remote', scopes: ['sessions:read'] });

      const res = await bearerApp.request('/rpc/backup/status', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'content-type': 'application/json',
          origin: 'http://localhost:3000',
        },
        body: JSON.stringify({ json: {} }),
      });

      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).toMatch(/cookie auth/i);
    } finally {
      apiKeys.close();
    }
  });
});
