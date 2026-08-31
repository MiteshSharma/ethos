import { EthosError } from '@ethosagent/types';
import type { MiddlewareHandler } from 'hono';

// CSRF protection (CEO finding 3.2). With `SameSite=Strict` cookies, the
// browser will refuse to attach our auth cookie to most cross-origin
// requests anyway, but a defense-in-depth Origin check on every state-
// changing method catches the few that slip through.
//
// Localhost-bound servers accept any localhost Origin (port doesn't have to
// match — a server bound to a LAN-visible host still wants its own address
// to work). Non-localhost deployments set `ETHOS_ALLOWED_ORIGINS` (see
// `resolveAllowedOrigins` in `apps/ethos/src/commands/serve-helpers.ts`) to
// trust their own public origin explicitly.

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
    let refererOrigin: string | null = null;
    if (referer) {
      try {
        refererOrigin = new URL(referer).origin;
      } catch {
        throw new EthosError({
          code: 'INVALID_INPUT',
          cause: 'Malformed Referer header',
          action: 'Send a valid URL in the Referer header.',
        });
      }
    }
    const candidate = origin ?? refererOrigin;

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
      action:
        'Set `ETHOS_ALLOWED_ORIGINS` to include this origin — comma-separated exact origins, or `*.yourdomain.com` wildcards for a domain you own (never a shared hosting domain like `*.fly.dev`).',
    });
  };
}

function isAllowed(
  origin: string,
  allowed: string[] | undefined,
  allowLocalhost: boolean,
): boolean {
  if (allowed && allowed.length > 0) {
    if (allowed.includes(origin)) return true;
    return allowed.some((pattern) => matchesWildcard(origin, pattern));
  }
  if (allowLocalhost && isLocalhost(origin)) return true;
  return false;
}

// `*.example.com` matches `https://foo.example.com` (any subdomain) AND
// `https://example.com` itself (the bare apex) — an operator who lists the
// wildcard almost always means "this whole domain," not "subdomains only,
// but not the domain itself."
function matchesWildcard(origin: string, pattern: string): boolean {
  if (!pattern.startsWith('*.')) return false;
  const suffix = pattern.slice(2);
  try {
    const hostname = new URL(origin).hostname;
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  } catch {
    return false;
  }
}

function isLocalhost(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}
