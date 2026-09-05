import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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

// `GET /backup/download` streams an archive that can contain the whole
// conversation history of this machine. CSRF never fires on GET and browsers
// omit `Origin` on top-level navigations, so `name` is fully attacker-
// influenced: the cookie gate plus the service's containment are the entire
// story, and both are asserted here end-to-end.

describe('GET /backup/download', () => {
  let dataDir: string;
  let backupDir: string;
  let prevStateDir: string | undefined;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-backup-download-'));
    backupDir = join(dataDir, 'backups');
    prevStateDir = process.env.ETHOS_STATE_DIR;
    process.env.ETHOS_STATE_DIR = dataDir;

    await mkdir(backupDir, { recursive: true });
    await writeFile(join(dataDir, 'config.yaml'), 'schemaVersion: 1\n');
    await writeFile(join(dataDir, 'private-notes.txt'), 'do not leak');
    await writeFile(join(backupDir, 'ethos-web-2026-01-01T00-00-00Z.tar.gz'), 'ARCHIVE-BYTES');
    await writeFile(join(backupDir, '.lock'), '{"pid":1}');
    await mkdir(join(backupDir, 'nested'), { recursive: true });
    await writeFile(join(backupDir, 'nested', 'inner.tar.gz'), 'nested');
    await symlink(join(dataDir, 'private-notes.txt'), join(backupDir, 'sneaky.tar.gz'));

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

  const get = (query: string) => app.request(`/backup/download?${query}`, { headers: { cookie } });

  it('401s without a credential', async () => {
    const res = await app.request('/backup/download?name=ethos-web-2026-01-01T00-00-00Z.tar.gz');
    expect(res.status).toBe(401);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('400s without a name', async () => {
    const res = await get('');
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('streams an archive from the backup directory', async () => {
    const res = await get('name=ethos-web-2026-01-01T00-00-00Z.tar.gz');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/gzip');
    expect(res.headers.get('content-length')).toBe(String('ARCHIVE-BYTES'.length));
    expect(res.headers.get('content-disposition')).toBe(
      "attachment; filename*=UTF-8''ethos-web-2026-01-01T00-00-00Z.tar.gz",
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('ARCHIVE-BYTES');
  });

  it('refuses an arbitrary absolute path', async () => {
    const res = await get(`name=${encodeURIComponent(join(dataDir, 'private-notes.txt'))}`);
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('refuses a traversal out of the backup directory', async () => {
    const res = await get(`name=${encodeURIComponent('../private-notes.txt')}`);
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('refuses a nested path even inside the backup directory', async () => {
    const res = await get(`name=${encodeURIComponent('nested/inner.tar.gz')}`);
    expect(res.status).toBe(400);
  });

  it('refuses a non-archive file in the backup directory', async () => {
    const res = await get('name=.lock');
    expect(res.status).toBe(400);
  });

  it('refuses a symlink named like an archive', async () => {
    const res = await get('name=sneaky.tar.gz');
    expect(res.status).toBe(403);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('404s for an archive that is not there', async () => {
    const res = await get('name=ethos-web-nope.tar.gz');
    expect(res.status).toBe(404);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'FILE_NOT_FOUND' });
  });
});
