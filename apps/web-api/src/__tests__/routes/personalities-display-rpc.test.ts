import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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

// P3 (plan/phases/personality-avatars.md) adds `display` to the wire
// `personalities.update` input. The RPC handler carries it through via a
// generic `...rest` spread rather than an explicit mapping (unlike `memory`
// and `mcp_tools`, which the handler special-cases) — this test drives the
// real router end to end so the spread-through is proven, not assumed.

describe('personalities RPC — display.avatar_url', () => {
  let dataDir: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-personalities-display-'));
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

  async function avatarUrlOf(res: Response): Promise<string | undefined> {
    const body = await res.json();
    const parsed = PersonalitySchema.safeParse(
      (body as { json: { personality: unknown } }).json.personality,
    );
    if (!parsed.success) throw new Error(`personality failed contract parse: ${parsed.error}`);
    return parsed.data.display?.avatar_url;
  }

  it('an update carrying display.avatar_url persists it and returns it on the wire', async () => {
    expect(
      (
        await call('create', {
          id: 'aria',
          name: 'Aria',
          toolset: [],
          soulMd: '# Aria\n',
        })
      ).status,
    ).toBe(200);

    const res = await call('update', {
      id: 'aria',
      display: { avatar_url: '/avatars/aria.svg' },
    });
    expect(res.status).toBe(200);
    expect(await avatarUrlOf(res)).toBe('/avatars/aria.svg');

    // Round-trips through a fresh `get` too, not just the `update` response.
    const got = await call('get', { id: 'aria' });
    const gotBody = (await got.json()) as { json: { personality: unknown } };
    const parsed = PersonalitySchema.safeParse(gotBody.json.personality);
    if (!parsed.success) throw new Error(`personality failed contract parse: ${parsed.error}`);
    expect(parsed.data.display?.avatar_url).toBe('/avatars/aria.svg');
  });

  it('an empty-string avatar_url clears it back to unset', async () => {
    expect(
      (
        await call('create', {
          id: 'aria',
          name: 'Aria',
          toolset: [],
          soulMd: '# Aria\n',
        })
      ).status,
    ).toBe(200);
    expect(
      (await call('update', { id: 'aria', display: { avatar_url: '/avatars/aria.svg' } })).status,
    ).toBe(200);

    const res = await call('update', { id: 'aria', display: { avatar_url: '' } });
    expect(res.status).toBe(200);
    expect(await avatarUrlOf(res)).toBeUndefined();
  });

  it('an update with no display field leaves a previously set avatar untouched', async () => {
    expect(
      (
        await call('create', {
          id: 'aria',
          name: 'Aria',
          toolset: [],
          soulMd: '# Aria\n',
        })
      ).status,
    ).toBe(200);
    expect(
      (await call('update', { id: 'aria', display: { avatar_url: '/avatars/aria.svg' } })).status,
    ).toBe(200);

    const res = await call('update', { id: 'aria', soulMd: '# Aria, updated\n' });
    expect(res.status).toBe(200);
    expect(await avatarUrlOf(res)).toBe('/avatars/aria.svg');
  });
});
