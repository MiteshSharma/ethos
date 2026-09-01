// P2-counters (D2) — `ethos_http_requests_total`, wired the same way as
// `/metrics` (metrics.test.ts): a plain closure passed into `createWebApi`,
// which threads it into `createRoutes` as a `'*'` middleware. Verifies real
// tenant traffic is counted and `/healthz` (platform liveness probing) is
// excluded.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore, SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebApi } from '../../index';
import {
  makeStubAgentLoop,
  makeStubMemoryProvider,
  makeStubPersonalityRegistry,
} from '../test-helpers';

describe('createWebApi — ethos_http_requests_total', () => {
  let dataDir: string;
  let sessionStore: SQLiteSessionStore;
  let apiKeys: SqliteApiKeyStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-http-counter-route-'));
    sessionStore = new SQLiteSessionStore(':memory:');
    apiKeys = new SqliteApiKeyStore(':memory:');
  });

  afterEach(async () => {
    sessionStore.close();
    apiKeys.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  function buildApp(recordHttpRequest: (method: string, status: number) => void) {
    return createWebApi({
      dataDir,
      storage: new InMemoryStorage(),
      sessionStore,
      memoryProvider: makeStubMemoryProvider(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
      apiKeys,
      recordHttpRequest,
    }).app;
  }

  it('records method and status for a real route', async () => {
    const recordHttpRequest = vi.fn();
    const app = buildApp(recordHttpRequest);

    // Unauthenticated /metrics scrape — no metricsTextFn wired, so 404, but
    // still a real routed request that must be counted.
    const res = await app.request('/metrics');

    expect(res.status).toBe(404);
    expect(recordHttpRequest).toHaveBeenCalledWith('GET', 404);
  });

  it('does not record a request to /healthz', async () => {
    const recordHttpRequest = vi.fn();
    const app = buildApp(recordHttpRequest);

    await app.request('/healthz');

    expect(recordHttpRequest).not.toHaveBeenCalled();
  });

  it('is not mounted when recordHttpRequest is not supplied', async () => {
    const app = createWebApi({
      dataDir,
      storage: new InMemoryStorage(),
      sessionStore,
      memoryProvider: makeStubMemoryProvider(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
      apiKeys,
    }).app;

    // No throw, and /healthz still works normally.
    const res = await app.request('/healthz');
    expect(res.status).toBe(503);
  });
});
