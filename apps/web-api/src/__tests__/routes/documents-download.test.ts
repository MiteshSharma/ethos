// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${ETHOS_HOME}` /
// `${self}` are literal fs_reach substitution tokens, not JS template strings.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import type { PersonalityConfig } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import { contentDisposition } from '../../routes/documents';
import {
  makeStubAgentLoop,
  makeStubMemoryProvider,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// `GET /documents/download` is the only route in the app that streams arbitrary
// file bytes. CSRF never fires on GET, so the cookie gate plus the service's
// containment are the whole story — both are asserted here end-to-end.

describe('GET /documents/download', () => {
  let dataDir: string;
  let workdir: string;
  let outside: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-documents-route-'));
    workdir = join(dataDir, 'workspace', 'writer');
    outside = join(dataDir, 'outside');
    await mkdir(workdir, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'do not leak');
    await writeFile(join(workdir, 'notes.md'), '# hello\n');
    await writeFile(join(workdir, 'rapport financier — été.txt'), 'accents');
    await symlink(join(outside, 'secret.txt'), join(workdir, 'link.txt'));

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
    expect(cookie).toBeTruthy();
  });

  afterEach(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const get = (query: string) =>
    app.request(`/documents/download?${query}`, { headers: { cookie } });

  it('401s without a credential', async () => {
    const res = await app.request('/documents/download?root=0&path=notes.md');
    expect(res.status).toBe(401);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('streams the file with attachment headers', async () => {
    const res = await get('personality=writer&root=0&path=notes.md');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('content-length')).toBe('8');
    expect(res.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''notes.md");
    expect(await res.text()).toBe('# hello\n');
  });

  it('encodes a non-ASCII filename', async () => {
    const res = await get(
      `personality=writer&root=0&path=${encodeURIComponent('rapport financier — été.txt')}`,
    );
    expect(res.status).toBe(200);
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toBe(
      "attachment; filename*=UTF-8''rapport%20financier%20%E2%80%94%20%C3%A9t%C3%A9.txt",
    );
    expect(await res.text()).toBe('accents');
  });

  it('refuses traversal, absolute paths, and symlinks', async () => {
    for (const path of ['../../../etc/passwd', '/etc/passwd', 'link.txt']) {
      const res = await get(`personality=writer&root=0&path=${encodeURIComponent(path)}`);
      expect(res.status, path).toBe(403);
      expect((await res.json()) as { code: string }).toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('400s without a path', async () => {
    const res = await get('personality=writer&root=0');
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('400s without a root', async () => {
    const res = await get('personality=writer&path=notes.md');
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('400s for a root id the personality does not declare', async () => {
    const res = await get('personality=writer&root=7&path=notes.md');
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('400s for a personality with no declared workdir', async () => {
    const res = await get('personality=drifter&root=0&path=notes.md');
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'WORKDIR_NOT_CONFIGURED',
    });
  });
});

describe('contentDisposition', () => {
  it('escapes the RFC 5987 non-attr-chars that encodeURIComponent leaves', () => {
    expect(contentDisposition("a'b(c)d*e.txt")).toBe(
      "attachment; filename*=UTF-8''a%27b%28c%29d%2Ae.txt",
    );
  });

  it('cannot be used to inject a header', () => {
    const injected = contentDisposition('evil\r\nSet-Cookie: a=b.txt');
    expect(injected).not.toContain('\r');
    expect(injected).not.toContain('\n');
    expect(injected).toBe("attachment; filename*=UTF-8''evil%0D%0ASet-Cookie%3A%20a%3Db.txt");
  });
});
