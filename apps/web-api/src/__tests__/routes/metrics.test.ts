// P2-counters (D2/D16/D17) — `GET /metrics` on the real boot path
// (`createWebApi` → `createRoutes`), mirroring the `/v1/*` bearer-auth
// pattern proven in openai-idempotency-wiring.test.ts.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore, SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import type { PersonalityConfig } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebApi } from '../../index';
import {
  makeStubAgentLoop,
  makeStubMemoryProvider,
  makeStubPersonalityRegistry,
} from '../test-helpers';

describe('createWebApi — GET /metrics', () => {
  let dataDir: string;
  let sessionStore: SQLiteSessionStore;
  let apiKeys: SqliteApiKeyStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-metrics-route-'));
    sessionStore = new SQLiteSessionStore(':memory:');
    apiKeys = new SqliteApiKeyStore(':memory:');
  });

  afterEach(async () => {
    sessionStore.close();
    apiKeys.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  function buildApp(metricsTextFn?: () => Promise<string>) {
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
      ...(metricsTextFn ? { metricsTextFn } : {}),
    }).app;
  }

  it('is not mounted when metricsTextFn is not supplied', async () => {
    const app = buildApp();
    const res = await app.request('/metrics');
    expect(res.status).toBe(404);
  });

  it('rejects an unauthenticated scrape', async () => {
    const app = buildApp(async () => 'ethos_tool_calls_total{tool="bash",outcome="ok"} 1\n');
    const res = await app.request('/metrics');
    expect(res.status).toBe(401);
  });

  it('rejects a key missing the metrics:read scope', async () => {
    const app = buildApp(async () => 'irrelevant\n');
    const { secret } = await apiKeys.create({ name: 'chat-only', scopes: ['chat'] });
    const res = await app.request('/metrics', { headers: { Authorization: `Bearer ${secret}` } });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('insufficient_scope');
  });

  it('serves the rendered OpenMetrics text with the correct content type for a metrics:read key', async () => {
    const metricsTextFn = vi.fn(
      async () =>
        'ethos_llm_cost_usd_total{personality="engineer",provider="anthropic",model="x"} 0.5\n',
    );
    const app = buildApp(metricsTextFn);
    const { secret } = await apiKeys.create({ name: 'prometheus', scopes: ['metrics:read'] });

    const res = await app.request('/metrics', { headers: { Authorization: `Bearer ${secret}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4');
    const body = await res.text();
    expect(body).toContain('ethos_llm_cost_usd_total');
    expect(metricsTextFn).toHaveBeenCalledTimes(1);
  });
});
