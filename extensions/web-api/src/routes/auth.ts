import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { AUTH_COOKIE } from '../middleware/auth';
import type { WebTokenRepository } from '../repositories/web-token.repository';

// First-visit token exchange.
//
// Flow (CEO finding 3.1):
//   1. `ethos serve` prints `http://localhost:3000?t=<token>` on first run.
//   2. Browser opens the URL. The SPA detects `?t=...` and redirects to
//      `/auth/exchange?t=...` (or hits this route directly).
//   3. We compare `t` against the stored token in constant time, then
//      ROTATE the file (URL token is invalidated).
//   4. We set the steady-state cookie (httpOnly + SameSite=Strict) and
//      302-redirect to `/` so the URL token never lands in browser history.
//
// Subsequent loads skip this route — the cookie alone authenticates.

export interface AuthRoutesOptions {
  tokens: WebTokenRepository;
  /** TTL for the auth cookie. Defaults to 30 days. */
  cookieMaxAgeSeconds?: number;
  /** When true, the cookie's `secure` flag is set. Default: false (localhost). */
  secureCookie?: boolean;
}

export function authRoutes(opts: AuthRoutesOptions) {
  const app = new Hono();
  const maxAge = opts.cookieMaxAgeSeconds ?? 60 * 60 * 24 * 30;

  app.get('/exchange', async (c) => {
    const token = c.req.query('t');
    if (!token) {
      return c.json(
        { ok: false, code: 'UNAUTHORIZED', error: 'Missing token query', action: 'Use the URL printed by `ethos serve`.' },
        401,
      );
    }

    const valid = await opts.tokens.matches(token);
    if (!valid) {
      return c.json(
        { ok: false, code: 'UNAUTHORIZED', error: 'Invalid or rotated token', action: 'Re-run `ethos serve` to print a fresh URL.' },
        401,
      );
    }

    // Rotate so the URL can't be replayed (e.g. from browser history,
    // referrer headers, screen-recording, shoulder-surfing).
    const fresh = await opts.tokens.rotate();
    setCookie(c, AUTH_COOKIE, fresh, {
      httpOnly: true,
      sameSite: 'Strict',
      secure: opts.secureCookie ?? false,
      path: '/',
      maxAge,
    });

    // 302 to a clean URL so the token doesn't land in browser history.
    return c.redirect('/', 302);
  });

  return app;
}
