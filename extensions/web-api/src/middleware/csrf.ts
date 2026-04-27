import { EthosError } from '@ethosagent/types';
import type { MiddlewareHandler } from 'hono';

// CSRF protection (CEO finding 3.2). With `SameSite=Strict` cookies, the
// browser will refuse to attach our auth cookie to most cross-origin
// requests anyway, but a defense-in-depth Origin check on every state-
// changing method catches the few that slip through.
//
// Localhost-bound servers accept any localhost Origin (port doesn't have to
// match — `?bind=0.0.0.0` deployments still want their own LAN address to
// work). When `allowedOrigins` is set explicitly, that list is enforced
// verbatim instead.

const STATEFUL_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface CsrfMiddlewareOptions {
  /** Explicit allow-list. When provided, only these origins pass. Empty
   *  array means "no cross-origin allowed at all". */
  allowedOrigins?: string[];
  /** When true, any localhost / 127.0.0.1 / [::1] origin is accepted regardless
   *  of port. Default: true (localhost-default posture). */
  allowLocalhost?: boolean;
}

export function csrfMiddleware(opts: CsrfMiddlewareOptions = {}): MiddlewareHandler {
  const allowedOrigins = opts.allowedOrigins;
  const allowLocalhost = opts.allowLocalhost ?? true;

  return async (c, next) => {
    if (!STATEFUL_METHODS.has(c.req.method)) return next();

    const origin = c.req.header('origin');
    // Same-origin requests don't always send Origin (older browsers, some
    // fetch contexts). Fall back to Referer when present.
    const referer = c.req.header('referer');
    const candidate = origin ?? (referer ? new URL(referer).origin : null);

    if (!candidate) {
      throw new EthosError({
        code: 'UNAUTHORIZED',
        cause: 'Missing Origin header on state-changing request',
        action: 'Browsers send Origin automatically for fetch/XHR. Check your client.',
      });
    }

    if (isAllowed(candidate, allowedOrigins, allowLocalhost)) return next();

    throw new EthosError({
      code: 'UNAUTHORIZED',
      cause: `Cross-origin request from ${candidate} blocked`,
      action: 'Use the URL printed by `ethos serve`, or pass `--bind` with an explicit allow-list.',
    });
  };
}

function isAllowed(
  origin: string,
  allowed: string[] | undefined,
  allowLocalhost: boolean,
): boolean {
  if (allowed && allowed.length > 0) return allowed.includes(origin);
  if (allowLocalhost && isLocalhost(origin)) return true;
  return false;
}

function isLocalhost(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}
