import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bearerAuth } from '../../middleware/bearer-auth';

describe('bearerAuth middleware', () => {
  let store: SqliteApiKeyStore;
  let app: Hono;
  let secret: string;

  beforeEach(async () => {
    store = new SqliteApiKeyStore(':memory:');
    const created = await store.create({ name: 'cursor', scopes: ['chat'] });
    secret = created.secret;
    app = new Hono();
    app.use('/v1/*', bearerAuth({ store, scope: 'chat' }));
    app.get('/v1/ping', (c) => c.json({ ok: true, keyName: c.get('apiKey').name }));
  });

  afterEach(() => {
    store.close();
  });

  it('returns 200 + sets c.set(apiKey) for a valid key', async () => {
    const res = await app.request('/v1/ping', {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; keyName: string };
    expect(body).toEqual({ ok: true, keyName: 'cursor' });
  });

  it('returns 401 with OpenAI error envelope when Authorization is missing', async () => {
    const res = await app.request('/v1/ping');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string; code: string; message: string } };
    expect(body.error.type).toBe('authentication_error');
    expect(body.error.code).toBe('invalid_api_key');
    expect(body.error.message).toMatch(/Missing Authorization/i);
  });

  it('returns 401 when the scheme is not Bearer', async () => {
    const res = await app.request('/v1/ping', {
      headers: { Authorization: `Basic ${secret}` },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_api_key');
  });

  it('returns 401 when the key does not start with sk-ethos-', async () => {
    const res = await app.request('/v1/ping', {
      headers: { Authorization: 'Bearer foo-bar-baz' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when the hash does not match a stored key', async () => {
    const res = await app.request('/v1/ping', {
      headers: { Authorization: 'Bearer sk-ethos-deadbeefdeadbeef' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when the key has been revoked', async () => {
    const all = await store.list();
    const target = all[0];
    if (!target) throw new Error('expected one key');
    await store.revoke(target.prefix);
    const res = await app.request('/v1/ping', {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 with permission_error when the key lacks the required scope', async () => {
    const adminApp = new Hono();
    adminApp.use('/v1/*', bearerAuth({ store, scope: 'admin' }));
    adminApp.get('/v1/ping', (c) => c.json({ ok: true }));
    const res = await adminApp.request('/v1/ping', {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { type: string; code: string } };
    expect(body.error.type).toBe('permission_error');
    expect(body.error.code).toBe('insufficient_scope');
  });

  it('touches last_used on a successful request', async () => {
    const before = (await store.list())[0]?.lastUsed;
    expect(before).toBeNull();
    await app.request('/v1/ping', {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const after = (await store.list())[0]?.lastUsed;
    expect(after).toBeInstanceOf(Date);
  });

  describe('allowedOrigins', () => {
    let restrictedSecret: string;
    let restrictedApp: Hono;

    beforeEach(async () => {
      const created = await store.create({
        name: 'browser',
        scopes: ['chat'],
        allowedOrigins: ['https://a.example'],
      });
      restrictedSecret = created.secret;
      restrictedApp = new Hono();
      restrictedApp.use('/v1/*', bearerAuth({ store, scope: 'chat' }));
      restrictedApp.get('/v1/ping', (c) => c.json({ ok: true }));
    });

    it('returns 403 origin_not_allowed for an Origin outside the list', async () => {
      const res = await restrictedApp.request('/v1/ping', {
        headers: { Authorization: `Bearer ${restrictedSecret}`, Origin: 'https://b.example' },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        error: { type: string; code: string; message: string; param: string | null };
      };
      expect(body.error.type).toBe('permission_error');
      expect(body.error.code).toBe('origin_not_allowed');
      expect(body.error.param).toBeNull();
      expect(body.error.message).toMatch(/https:\/\/b\.example/);
    });

    it('passes through for an Origin inside the list', async () => {
      const res = await restrictedApp.request('/v1/ping', {
        headers: { Authorization: `Bearer ${restrictedSecret}`, Origin: 'https://a.example' },
      });
      expect(res.status).toBe(200);
    });

    it('passes through when no Origin header is sent (server-side SDK clients)', async () => {
      const res = await restrictedApp.request('/v1/ping', {
        headers: { Authorization: `Bearer ${restrictedSecret}` },
      });
      expect(res.status).toBe(200);
    });

    it('passes through for any Origin when allowedOrigins is empty (CLI keys)', async () => {
      const res = await app.request('/v1/ping', {
        headers: { Authorization: `Bearer ${secret}`, Origin: 'https://anywhere.example' },
      });
      expect(res.status).toBe(200);
    });
  });

  it('coalesces last_used writes within the throttle window (no SQLite write per request)', async () => {
    // Spy on the underlying store. The middleware should write once on the
    // first request and then skip subsequent calls until the throttle expires.
    const touch = vi.spyOn(store, 'touchLastUsed');
    const headers = { Authorization: `Bearer ${secret}` };
    await app.request('/v1/ping', { headers });
    await app.request('/v1/ping', { headers });
    await app.request('/v1/ping', { headers });
    expect(touch).toHaveBeenCalledTimes(1);
    touch.mockRestore();
  });
});
