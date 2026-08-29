import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi } from '../../index';
import {
  makeStubAgentLoop,
  makeStubMemoryProvider,
  makeStubPersonalityRegistry,
} from '../test-helpers';

const healthPath = join(homedir(), '.ethos', 'gateway-health.json');

describe('GET /healthz — gateway heartbeat', () => {
  let dir: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let savedContent: string | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(join(homedir(), '.ethos', 'test-webapi-'));
    store = new SQLiteSessionStore(':memory:');
    app = createWebApi({
      dataDir: dir,
      sessionStore: store,
      memoryProvider: makeStubMemoryProvider(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
    }).app;

    // Preserve any existing heartbeat file so we can restore after tests.
    try {
      const { readFile } = await import('node:fs/promises');
      savedContent = await readFile(healthPath, 'utf-8');
    } catch {
      savedContent = null;
    }
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
    // Restore or clean up the heartbeat file.
    if (savedContent !== null) {
      await writeFile(healthPath, savedContent, 'utf-8');
    } else {
      await rm(healthPath, { force: true }).catch(() => {});
    }
  });

  it('returns 200 + ok when heartbeat is fresh and all adapters ok', async () => {
    const hb = {
      pid: 1234,
      startedAt: '2026-05-20T08:00:00Z',
      updatedAt: new Date().toISOString(),
      adapters: [{ name: 'telegram:bot-1', ok: true }],
    };
    await mkdir(join(homedir(), '.ethos'), { recursive: true });
    await writeFile(healthPath, JSON.stringify(hb), 'utf-8');

    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.uptime).toBeGreaterThan(0);

    const gw = body.gateway as {
      status: string;
      adapters: Array<{ name: string; ok: boolean }>;
      lastHeartbeatAgeSec: number;
    };
    expect(gw.status).toBe('ok');
    expect(gw.adapters).toEqual([{ name: 'telegram:bot-1', ok: true }]);
    expect(gw.lastHeartbeatAgeSec).toBeLessThan(5);
  });

  it('returns 503 + degraded when heartbeat is stale (>30s)', async () => {
    const staleDate = new Date(Date.now() - 60_000).toISOString();
    const hb = {
      pid: 1234,
      startedAt: '2026-05-20T08:00:00Z',
      updatedAt: staleDate,
      adapters: [{ name: 'telegram:bot-1', ok: true }],
    };
    await mkdir(join(homedir(), '.ethos'), { recursive: true });
    await writeFile(healthPath, JSON.stringify(hb), 'utf-8');

    const res = await app.request('/healthz');
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('degraded');

    const gw = body.gateway as { status: string; lastHeartbeatAgeSec: number };
    expect(gw.status).toBe('stale');
    expect(gw.lastHeartbeatAgeSec).toBeGreaterThan(29);
  });

  it('returns 503 + degraded when heartbeat file is missing', async () => {
    await rm(healthPath, { force: true }).catch(() => {});

    const res = await app.request('/healthz');
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('degraded');

    const gw = body.gateway as {
      status: string;
      adapters: unknown[];
      lastHeartbeatAgeSec: null;
    };
    expect(gw.status).toBe('down');
    expect(gw.adapters).toEqual([]);
    expect(gw.lastHeartbeatAgeSec).toBeNull();
  });

  it('returns 503 + degraded when heartbeat has a malformed updatedAt', async () => {
    const hb = {
      pid: 1234,
      startedAt: '2026-05-20T08:00:00Z',
      updatedAt: 'not-a-date',
      adapters: [{ name: 'telegram:bot-1', ok: true }],
    };
    await mkdir(join(homedir(), '.ethos'), { recursive: true });
    await writeFile(healthPath, JSON.stringify(hb), 'utf-8');

    const res = await app.request('/healthz');
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('degraded');

    const gw = body.gateway as { status: string };
    expect(gw.status).toBe('stale');
  });

  it('returns 200 + ok when the gateway is fresh and no adapters are configured', async () => {
    // A headless deployment with no Slack/Telegram/Discord bot attached is a
    // normal configuration — an empty adapter list is not a failure.
    const hb = {
      pid: 1234,
      startedAt: '2026-05-20T08:00:00Z',
      updatedAt: new Date().toISOString(),
      adapters: [],
    };
    await mkdir(join(homedir(), '.ethos'), { recursive: true });
    await writeFile(healthPath, JSON.stringify(hb), 'utf-8');

    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');

    const gw = body.gateway as { status: string; adapters: unknown[] };
    expect(gw.status).toBe('ok');
    expect(gw.adapters).toEqual([]);
  });

  it('returns 503 + degraded when an adapter reports not-ok', async () => {
    const hb = {
      pid: 1234,
      startedAt: '2026-05-20T08:00:00Z',
      updatedAt: new Date().toISOString(),
      adapters: [
        { name: 'telegram:bot-1', ok: true },
        { name: 'slack:app-1', ok: false },
      ],
    };
    await mkdir(join(homedir(), '.ethos'), { recursive: true });
    await writeFile(healthPath, JSON.stringify(hb), 'utf-8');

    const res = await app.request('/healthz');
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('degraded');

    const gw = body.gateway as { status: string };
    expect(gw.status).toBe('ok'); // gateway itself is fresh
  });
});
