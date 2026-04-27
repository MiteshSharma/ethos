import { EthosError } from '@ethosagent/types';
import { getCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';
import type { WebTokenRepository } from '../repositories/web-token.repository';

// Cookie auth. Single-user posture (CEO finding 3.1): the URL-exchange flow
// (see routes/auth.ts) sets `etos_auth=<token>` httpOnly + SameSite=Strict
// after validating + rotating the URL token. Every subsequent request
// re-validates against the stored token; rotation breaks any stolen URL.

export const AUTH_COOKIE = 'ethos_auth';

export interface AuthMiddlewareOptions {
  tokens: WebTokenRepository;
}

export function authMiddleware(opts: AuthMiddlewareOptions): MiddlewareHandler {
  return async (c, next) => {
    const cookie = getCookie(c, AUTH_COOKIE);
    if (!cookie) {
      throw new EthosError({
        code: 'UNAUTHORIZED',
        cause: 'Missing auth cookie',
        action: 'Visit `?t=<token>` printed by `ethos serve` to sign in.',
      });
    }
    const ok = await opts.tokens.matches(cookie);
    if (!ok) {
      throw new EthosError({
        code: 'UNAUTHORIZED',
        cause: 'Auth cookie does not match the active token',
        action: 'Re-open the URL printed by `ethos serve`. Token may have rotated.',
      });
    }
    await next();
  };
}
