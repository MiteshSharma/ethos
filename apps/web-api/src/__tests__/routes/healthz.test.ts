import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi } from '../../index';
import {
  makeStubAgentLoop,
  makeStubMemoryProvider,
  makeStubPersonalityRegistry,
} from '../test-helpers';

describe('GET /healthz', () => {
  let dir: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-webapi-'));
    store = new SQLiteSessionStore(':memory:');
    app = createWebApi({
      dataDir: dir,
      // In-memory storage so the heartbeat lookup cannot see the real
      // ~/.ethos/gateway-health.json — the gateway-heartbeat suite writes that
      // same path, and vitest runs the two files in parallel.
      storage: new InMemoryStorage(),
      sessionStore: store,
      memoryProvider: makeStubMemoryProvider(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
    }).app;
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('returns 503 with status degraded and gateway down when no heartbeat file exists', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      status: string;
      uptime: number;
      gateway: { status: string };
    };
    expect(body.status).toBe('degraded');
    expect(body.uptime).toBeGreaterThan(0);
    expect(body.gateway.status).toBe('down');
  });

  it('responds without auth headers (unauthenticated)', async () => {
    // No cookie, no bearer token — should still respond (no auth required).
    const res = await app.request('/healthz');
    expect(res.status).toBe(503);
  });
});
