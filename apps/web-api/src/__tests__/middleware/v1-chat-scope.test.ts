import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { ApiKeyScopeSchema } from '@ethosagent/web-contracts';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bearerAuth } from '../../middleware/bearer-auth';

// The `/v1/*` mount asserts the literal scope `chat` (see
// apps/web-api/src/routes/openai/index.ts). For a long stretch `chat` was not a
// member of `ApiKeyScopeSchema`, so `apiKeys.create` — the only mint path the
// web UI has — could not issue a key that reached this surface. These tests pin
// both halves: the scope exists in the contract, and it is the one the gate
// actually checks.

const V1_SCOPE = 'chat';

describe('/v1/* requires the `chat` scope', () => {
  let store: SqliteApiKeyStore;
  let app: Hono;

  beforeEach(() => {
    store = new SqliteApiKeyStore(':memory:');
    app = new Hono();
    app.use('/v1/*', bearerAuth({ store, scope: V1_SCOPE }));
    app.get('/v1/models', (c) => c.json({ object: 'list' }));
  });

  afterEach(() => {
    store.close();
  });

  it('`chat` is a member of ApiKeyScopeSchema', () => {
    expect(ApiKeyScopeSchema.safeParse(V1_SCOPE).success).toBe(true);
  });

  it('accepts a key carrying `chat`', async () => {
    const { secret } = await store.create({ name: 'openai-compat', scopes: ['chat'] });
    const res = await app.request('/v1/models', {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
  });

  it('rejects a key carrying only `chat:send` with 403 insufficient_scope', async () => {
    const { secret } = await store.create({ name: 'rpc-only', scopes: ['chat:send'] });
    const res = await app.request('/v1/models', {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { type: string; code: string; message: string } };
    expect(body.error.type).toBe('permission_error');
    expect(body.error.code).toBe('insufficient_scope');
    expect(body.error.message).toMatch(/chat/);
  });

  it('`chat:send` remains a distinct member — neither scope subsumes the other', () => {
    expect(ApiKeyScopeSchema.safeParse('chat:send').success).toBe(true);
    expect(ApiKeyScopeSchema.options).toContain('chat');
    expect(ApiKeyScopeSchema.options).toContain('chat:send');
  });
});
