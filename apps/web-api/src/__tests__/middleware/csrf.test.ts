import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { type CsrfMiddlewareOptions, csrfMiddleware } from '../../middleware/csrf';
import { errorHandler } from '../../middleware/error-envelope';

function makeApp(opts: CsrfMiddlewareOptions = {}): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.use('*', csrfMiddleware(opts));
  app.post('/ping', (c) => c.json({ ok: true }));
  app.get('/ping', (c) => c.json({ ok: true }));
  return app;
}

function post(app: Hono, origin: string | undefined) {
  return app.request('/ping', {
    method: 'POST',
    headers: origin ? { origin } : {},
  });
}

describe('csrfMiddleware isAllowed', () => {
  it('no allowedOrigins set, localhost origin is allowed (regression)', async () => {
    const app = makeApp();
    const res = await post(app, 'http://localhost:3000');
    expect(res.status).toBe(200);
  });

  it('no allowedOrigins set, non-localhost origin is blocked', async () => {
    const app = makeApp();
    const res = await post(app, 'https://evil.com');
    expect(res.status).toBe(401);
  });

  it('allowedOrigins exact match is allowed', async () => {
    const app = makeApp({ allowedOrigins: ['https://app.example.com'] });
    const res = await post(app, 'https://app.example.com');
    expect(res.status).toBe(200);
  });

  it('allowedOrigins with a different origin is blocked', async () => {
    const app = makeApp({ allowedOrigins: ['https://app.example.com'] });
    const res = await post(app, 'https://other.example.com');
    expect(res.status).toBe(401);
  });

  it('wildcard allowedOrigins matches a subdomain', async () => {
    const app = makeApp({ allowedOrigins: ['*.ethos.example.com'] });
    const res = await post(app, 'https://foo.ethos.example.com');
    expect(res.status).toBe(200);
  });

  it('wildcard allowedOrigins matches the bare apex domain', async () => {
    const app = makeApp({ allowedOrigins: ['*.ethos.example.com'] });
    const res = await post(app, 'https://ethos.example.com');
    expect(res.status).toBe(200);
  });

  it('wildcard allowedOrigins does not match an unrelated domain', async () => {
    const app = makeApp({ allowedOrigins: ['*.ethos.example.com'] });
    const res = await post(app, 'https://evil.com');
    expect(res.status).toBe(401);
  });

  it('GET requests bypass the check regardless of origin (regression)', async () => {
    const app = makeApp({ allowedOrigins: ['https://app.example.com'] });
    const res = await app.request('/ping', {
      method: 'GET',
      headers: { origin: 'https://evil.com' },
    });
    expect(res.status).toBe(200);
  });
});
