// External cron trigger (plan/phases/cron-scheduler-seam.md) — `POST
// /cron/fire` on the real boot path (`createWebApi` → `createRoutes`),
// mirroring the `/metrics` bearer-auth pattern in metrics.test.ts.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore, SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import type { PersonalityConfig } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebApi } from '../../index';
import type { CronFireTrigger } from '../../routes/cron';
import {
  makeStubAgentLoop,
  makeStubMemoryProvider,
  makeStubPersonalityRegistry,
} from '../test-helpers';

describe('createWebApi — POST /cron/fire', () => {
  let dataDir: string;
  let sessionStore: SQLiteSessionStore;
  let apiKeys: SqliteApiKeyStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-cron-fire-route-'));
    sessionStore = new SQLiteSessionStore(':memory:');
    apiKeys = new SqliteApiKeyStore(':memory:');
  });

  afterEach(async () => {
    sessionStore.close();
    apiKeys.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  function buildApp(cronFireTrigger?: CronFireTrigger) {
    return createWebApi({
      dataDir,
      sessionStore,
      memoryProvider: makeStubMemoryProvider(),
      agentLoop: makeStubAgentLoop({ events: [{ type: 'done', text: 'hi', turnCount: 1 }] }),
      personalities: makeStubPersonalityRegistry([
        { id: 'engineer', name: 'Engineer' } as PersonalityConfig,
      ]),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
      apiKeys,
      ...(cronFireTrigger ? { cronFireTrigger } : {}),
    }).app;
  }

  it('is not mounted when the host app supplies no cronFireTrigger', async () => {
    const app = buildApp();
    const res = await app.request('/cron/fire', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('rejects an unauthenticated request', async () => {
    const app = buildApp({ fire: vi.fn(async () => {}) });
    const res = await app.request('/cron/fire', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('rejects a key missing the cron scope', async () => {
    const fire = vi.fn(async () => {});
    const app = buildApp({ fire });
    const { secret } = await apiKeys.create({ name: 'chat-only', scopes: ['chat'] });

    const res = await app.request('/cron/fire', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}` },
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('insufficient_scope');
    expect(fire).not.toHaveBeenCalled();
  });

  it('calls fire() and returns ok for a cron-scoped key', async () => {
    const fire = vi.fn(async () => {});
    const app = buildApp({ fire });
    const { secret } = await apiKeys.create({ name: 'external-scheduler', scopes: ['cron'] });

    const res = await app.request('/cron/fire', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(fire).toHaveBeenCalledTimes(1);
  });
});
