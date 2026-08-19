import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore, SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import type { PersonalityConfig } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi } from '../../index';
import { IdempotencyStore } from '../../stores/idempotency-store';
import {
  makeStubAgentLoop,
  makeStubMemoryProvider,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// D5 — `Idempotency-Key` is wired at the MOUNTED app (via `createWebApi`),
// not just at the `openAiRoutes` module. `openai-idempotency.test.ts` proves
// the middleware in isolation against a hand-built Hono app; this proves the
// real boot path (`createWebApi` → `createRoutes` → `openAiRoutes`) actually
// passes `idempotencyStore` through.

describe('createWebApi — /v1/chat/completions idempotency', () => {
  let dataDir: string;
  let sessionStore: SQLiteSessionStore;
  let apiKeys: SqliteApiKeyStore;
  let idempotencyStore: IdempotencyStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-openai-idempotency-'));
    sessionStore = new SQLiteSessionStore(':memory:');
    apiKeys = new SqliteApiKeyStore(':memory:');
    idempotencyStore = new IdempotencyStore(':memory:');
  });

  afterEach(async () => {
    sessionStore.close();
    apiKeys.close();
    idempotencyStore.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function buildApp(runCount: { n: number }) {
    const app = createWebApi({
      dataDir,
      sessionStore,
      memoryProvider: makeStubMemoryProvider(),
      agentLoop: makeStubAgentLoop({
        events: [{ type: 'done', text: 'hello', turnCount: 1 }],
        onRun: () => {
          runCount.n += 1;
        },
      }),
      personalities: makeStubPersonalityRegistry([
        { id: 'engineer', name: 'Engineer' } as PersonalityConfig,
      ]),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
      apiKeys,
      idempotencyStore,
    }).app;
    const created = await apiKeys.create({ name: 'test', scopes: ['chat'] });
    return { app, bearer: { Authorization: `Bearer ${created.secret}` } };
  }

  it('drives the agent loop once for two identical requests under the same key', async () => {
    const runCount = { n: 0 };
    const { app, bearer } = await buildApp(runCount);
    const headers = {
      ...bearer,
      'content-type': 'application/json',
      'idempotency-key': 'replay-key',
    };
    const body = JSON.stringify({
      model: 'engineer',
      messages: [{ role: 'user', content: 'hi' }],
    });

    const res1 = await app.request('/v1/chat/completions', { method: 'POST', headers, body });
    expect(res1.status).toBe(200);
    const res2 = await app.request('/v1/chat/completions', { method: 'POST', headers, body });
    expect(res2.status).toBe(200);

    expect(runCount.n).toBe(1);
    expect(await res1.json()).toEqual(await res2.json());
  });

  it('returns 422 idempotency_key_reused when the same key carries a different body', async () => {
    const runCount = { n: 0 };
    const { app, bearer } = await buildApp(runCount);
    const headers = {
      ...bearer,
      'content-type': 'application/json',
      'idempotency-key': 'reused-key',
    };

    const first = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'engineer', messages: [{ role: 'user', content: 'first' }] }),
    });
    expect(first.status).toBe(200);

    const second = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'engineer', messages: [{ role: 'user', content: 'second' }] }),
    });
    expect(second.status).toBe(422);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('idempotency_key_reused');
    expect(runCount.n).toBe(1);
  });
});
