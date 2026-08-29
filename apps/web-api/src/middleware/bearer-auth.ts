import { type ApiKeyRecord, hashApiKey } from '@ethosagent/session-sqlite';

export type { ApiKeyRecord } from '@ethosagent/session-sqlite';

import type { Context, MiddlewareHandler } from 'hono';

// Bearer-token middleware for the OpenAI-compat surface (`/v1/*`). Reads
// `Authorization: Bearer sk-ethos-...`, sha256-matches against the bound
// `ApiKeyAuthStore`, asserts the requested scope, and stamps
// `c.set('apiKey', record)` for downstream handlers. Every failure path
// returns the OpenAI error envelope so SDK clients parse the error normally.
//
// C2 will generalise OpenAI-shaped errors via a dedicated middleware; until
// then this file inlines the 401/403 shapes itself so the F1 acceptance
// (`curl ... → 401 with OpenAI error envelope`) holds before C2 lands.

/**
 * Minimal contract the bearer-auth middleware (and `/v1/*` mount) needs from
 * an API-key backend. SQLite ships as the default impl via
 * `SqliteApiKeyStore` in `@ethosagent/session-sqlite`; other backends (env
 * vars, HSM-backed, remote) can structurally satisfy this without dragging
 * a concrete SQLite type into the HTTP layer.
 */
export interface ApiKeyAuthStore {
  findByHash(hash: string): Promise<ApiKeyRecord | null>;
  touchLastUsed(id: string): Promise<void>;
}

/**
 * Extended contract for the admin CRUD surface (create/list/revoke). The
 * `/rpc/apiKeys.*` namespace needs this; the auth middleware does not. Boot
 * code passes the same store instance for both — `SqliteApiKeyStore`
 * satisfies both interfaces structurally.
 */
export interface ApiKeyAdminStore extends ApiKeyAuthStore {
  create(input: {
    name: string;
    scopes: string[];
    allowedOrigins?: string[];
  }): Promise<{ secret: string; record: ApiKeyRecord }>;
  list(): Promise<ApiKeyRecord[]>;
  revoke(prefix: string): Promise<ApiKeyRecord | null>;
}

export interface BearerAuthOptions {
  store: ApiKeyAuthStore;
  /** Scope the route requires (e.g. `chat`). 403 if the key lacks it. */
  scope: string;
}

export type OpenAiErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'server_error';

export interface OpenAiErrorBody {
  error: {
    message: string;
    type: OpenAiErrorType;
    code: string;
    param: string | null;
    request_id?: string;
  };
}

/** Express the OpenAI error shape over Hono so callers don't repeat the wire format. */
export function openAiErrorBody(input: {
  message: string;
  type: OpenAiErrorType;
  code: string;
  param?: string | null;
  request_id?: string;
}): OpenAiErrorBody {
  const body: OpenAiErrorBody = {
    error: {
      message: input.message,
      type: input.type,
      code: input.code,
      param: input.param ?? null,
    },
  };
  if (input.request_id) body.error.request_id = input.request_id;
  return body;
}

const BEARER_PREFIX = 'Bearer ';
const SECRET_PREFIX = 'sk-ethos-';
/**
 * Coalesce `last_used` writes so a streaming Cursor / Aider client doesn't
 * turn every authenticated hit into a SQLite write contention point. The
 * `last_used` UX granularity is "minute or so", well within this window.
 */
const TOUCH_THROTTLE_MS = 60_000;

export function bearerAuth(opts: BearerAuthOptions): MiddlewareHandler {
  const lastTouchAt = new Map<string, number>();
  return async (c, next) => {
    const header = c.req.header('authorization') ?? c.req.header('Authorization');
    if (!header) return invalidAuth(c, 'Missing Authorization header.');
    if (!header.startsWith(BEARER_PREFIX)) {
      return invalidAuth(c, 'Authorization header must use the Bearer scheme.');
    }
    const secret = header.slice(BEARER_PREFIX.length).trim();
    if (!secret.startsWith(SECRET_PREFIX)) {
      return invalidAuth(c, 'API key must start with `sk-ethos-`.');
    }
    const record = await opts.store.findByHash(hashApiKey(secret));
    if (!record) return invalidAuth(c, 'API key is invalid or has been revoked.');
    // Origin allowlist. An empty list means unrestricted — `ethos api-key create`
    // has no origin flag and stores `[]`, so CLI-minted keys must stay open.
    //
    // Deliberate divergence from `dual-auth.ts`: a MISSING Origin header is
    // allowed here. `/v1/*` is the OpenAI-compat surface, and its normal client
    // (curl, the OpenAI Python/Node SDKs, Open WebUI's server-side proxy) is not
    // a browser and never sends Origin. Rejecting on absence — the way dual-auth
    // does for the browser-only `/rpc/*` surface — would silently brick every
    // SDK client the moment a key is scoped to an origin. Do not "fix" this into
    // consistency with dual-auth.
    if (record.allowedOrigins.length > 0) {
      const origin = c.req.header('origin');
      if (origin && !record.allowedOrigins.includes(origin)) {
        return c.json(
          openAiErrorBody({
            message: `Origin "${origin}" is not in the allowedOrigins list for this API key.`,
            type: 'permission_error',
            code: 'origin_not_allowed',
          }),
          403,
        );
      }
    }
    if (!record.scopes.includes(opts.scope)) {
      return forbidden(c, `API key is missing required scope "${opts.scope}".`);
    }
    // Best-effort observability — throttled so we don't take the SQLite write
    // lock on every authenticated request (streaming Cursor traffic would
    // otherwise serialise behind the auth middleware).
    const now = Date.now();
    const previous = lastTouchAt.get(record.id) ?? 0;
    if (now - previous >= TOUCH_THROTTLE_MS) {
      lastTouchAt.set(record.id, now);
      try {
        await opts.store.touchLastUsed(record.id);
      } catch {
        // intentionally ignored — never fail a request for a metadata write
      }
    }
    c.set('apiKey', record);
    await next();
  };
}

function invalidAuth(c: Context, message: string): Response {
  return c.json(
    openAiErrorBody({ message, type: 'authentication_error', code: 'invalid_api_key' }),
    401,
  );
}

function forbidden(c: Context, message: string): Response {
  return c.json(
    openAiErrorBody({ message, type: 'permission_error', code: 'insufficient_scope' }),
    403,
  );
}

// Hono variable types — surfaces `c.get('apiKey')` typed for downstream
// `/v1/*` route handlers.
declare module 'hono' {
  interface ContextVariableMap {
    apiKey: ApiKeyRecord;
  }
}
