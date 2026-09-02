// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${ETHOS_HOME}` /
// `${self}` are literal fs_reach substitution tokens, not JS template strings.
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import { PersonalitySchema } from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import {
  makeStubAgentLoop,
  makeStubMemoryProvider,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// `fs_reach.workdir` over the wire. The contract's create/update input schemas
// strip unknown keys, so a missing `workdir` there is silent data loss — the
// value never reaches the registry and the personality's declared working
// directory disappears from config.yaml on the next save from the web UI.
// These tests drive the real router so schema, service, and registry are all
// exercised on the same path the browser takes.

const WORKDIR = '${ETHOS_HOME}/workspace/${self}';

describe('personalities RPC — fs_reach.workdir', () => {
  let dataDir: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-personalities-reach-'));
    await mkdir(join(dataDir, 'personalities'), { recursive: true });

    store = new SQLiteSessionStore(':memory:');
    app = createWebApi({
      dataDir,
      sessionStore: store,
      memoryProvider: makeStubMemoryProvider(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry([], dataDir),
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
    app.request(`/rpc/personalities/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ json: input }),
    });

  async function reachOf(res: Response): Promise<Record<string, unknown> | null> {
    const body = await res.json();
    const parsed = PersonalitySchema.safeParse(
      (body as { json: { personality: unknown } }).json.personality,
    );
    if (!parsed.success) throw new Error(`personality failed contract parse: ${parsed.error}`);
    return parsed.data.fs_reach;
  }

  const configYaml = () =>
    readFile(join(dataDir, 'personalities', 'writer', 'config.yaml'), 'utf-8');

  async function createWriter(): Promise<Response> {
    return call('create', {
      id: 'writer',
      name: 'Writer',
      toolset: ['write_file'],
      soulMd: '# Writer\n',
      fs_reach: { read: ['/data'], write: ['/data/out'], workdir: WORKDIR },
    });
  }

  it('create accepts workdir, persists it, and returns it on the wire', async () => {
    const res = await createWriter();
    expect(res.status).toBe(200);
    expect(await reachOf(res)).toEqual({
      read: ['/data'],
      write: ['/data/out'],
      workdir: [WORKDIR],
    });
    expect(await configYaml()).toContain(`fs_reach.workdir: ${WORKDIR}`);
  });

  it('a read/write-only update leaves the declared workdir on disk', async () => {
    expect((await createWriter()).status).toBe(200);

    // Exactly the patch the web config editor sent before this fix: the whole
    // fs_reach object rebuilt from the two path lists, no workdir.
    const res = await call('update', {
      id: 'writer',
      fs_reach: { read: ['/data', '/more'], write: ['/data/out'] },
    });
    expect(res.status).toBe(200);
    expect(await reachOf(res)).toEqual({
      read: ['/data', '/more'],
      write: ['/data/out'],
      workdir: [WORKDIR],
    });
    expect(await configYaml()).toContain(`fs_reach.workdir: ${WORKDIR}`);
  });

  // The narrowing this suite exists to prevent, in its multi-root form: the
  // wire used to surface only the FIRST declared workdir while the config
  // editor sent `workdir` back on every save, so opening a two-root
  // personality in the editor and pressing Save silently deleted the second
  // root. Both halves are asserted — what comes back, and what survives a
  // round trip through a save that never touched the field.
  it('surfaces every declared workdir, not just the first', async () => {
    const res = await call('create', {
      id: 'writer',
      name: 'Writer',
      toolset: ['write_file'],
      soulMd: '# Writer\n',
      fs_reach: { read: ['/data'], write: ['/data/out'], workdir: [WORKDIR, '/srv/shared'] },
    });
    expect(res.status).toBe(200);
    expect(await reachOf(res)).toEqual({
      read: ['/data'],
      write: ['/data/out'],
      workdir: [WORKDIR, '/srv/shared'],
    });
    expect(await configYaml()).toContain(`fs_reach.workdir: ${WORKDIR}, /srv/shared`);
  });

  it('a multi-root personality survives a save from the config editor', async () => {
    expect(
      (
        await call('create', {
          id: 'writer',
          name: 'Writer',
          toolset: ['write_file'],
          soulMd: '# Writer\n',
          fs_reach: { read: ['/data'], write: ['/data/out'], workdir: [WORKDIR, '/srv/shared'] },
        })
      ).status,
    ).toBe(200);

    // Exactly what the editor sends: the whole fs_reach block rebuilt from the
    // form, `workdir` included, echoing back what the wire handed it.
    const res = await call('update', {
      id: 'writer',
      fs_reach: { read: ['/data'], write: ['/data/out'], workdir: [WORKDIR, '/srv/shared'] },
    });
    expect(res.status).toBe(200);
    expect(await reachOf(res)).toEqual({
      read: ['/data'],
      write: ['/data/out'],
      workdir: [WORKDIR, '/srv/shared'],
    });
    expect(await configYaml()).toContain(`fs_reach.workdir: ${WORKDIR}, /srv/shared`);
  });

  it('an empty workdir list clears it, the same way an empty string does', async () => {
    expect((await createWriter()).status).toBe(200);

    const res = await call('update', {
      id: 'writer',
      fs_reach: { read: ['/data'], write: ['/data/out'], workdir: [] },
    });
    expect(res.status).toBe(200);
    expect(await reachOf(res)).toEqual({
      read: ['/data'],
      write: ['/data/out'],
      workdir: null,
    });
    expect(await configYaml()).not.toContain('fs_reach.workdir');
  });

  it('an explicit empty workdir clears it', async () => {
    expect((await createWriter()).status).toBe(200);

    const res = await call('update', {
      id: 'writer',
      fs_reach: { read: ['/data'], write: ['/data/out'], workdir: '' },
    });
    expect(res.status).toBe(200);
    expect(await reachOf(res)).toEqual({
      read: ['/data'],
      write: ['/data/out'],
      workdir: null,
    });
    expect(await configYaml()).not.toContain('fs_reach.workdir');
  });
});
