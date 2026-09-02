import { EthosError, type EthosErrorCode, isEthosError } from '@ethosagent/types';
import type { Context, MiddlewareHandler } from 'hono';
// Side-effect import: `hono/request-id` augments Hono's `ContextVariableMap`
// with `requestId`, which is what types `c.get('requestId')` below. The
// middleware itself is mounted in routes/index.ts.
import 'hono/request-id';

// Uniform JSON error shape on the wire. Services throw `EthosError`; this
// middleware catches anything that escaped a route and renders it as
// `{ ok: false, code, error, action }`. oRPC handlers also feed through here
// when their procedure body throws.
//
// HTTP status is derived from the code so `fetch().ok` is meaningful client
// side. Unknown codes bucket as 500 — the `INTERNAL` fallback used by
// `toEthosError` already does this naturally.

export interface ErrorEnvelope {
  ok: false;
  code: EthosErrorCode;
  error: string;
  action: string;
  /** B1 — the request's `x-request-id`, echoed so a user can quote the exact
   *  failed request. Optional because `toEnvelope` is also called from routes
   *  that build an envelope without a Hono context. */
  requestId?: string;
}

const STATUS_BY_CODE: Partial<Record<EthosErrorCode, number>> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  SESSION_NOT_FOUND: 404,
  CONFIG_MISSING: 400,
  CONFIG_INVALID: 400,
  INVALID_INPUT: 400,
  PERSONALITY_NOT_FOUND: 404,
  FILE_NOT_FOUND: 404,
  JOB_NOT_FOUND: 404,
  SKILL_NOT_FOUND: 404,
  SKILL_EXISTS: 409,
  PERSONALITY_EXISTS: 409,
  PERSONALITY_READ_ONLY: 403,
  WORKDIR_NOT_CONFIGURED: 400,
  DOCUMENT_EXISTS: 409,
  PAYLOAD_TOO_LARGE: 413,
  PROVIDER_AUTH_FAILED: 502,
  LLM_ERROR: 502,
  STREAM_TIMEOUT: 504,
  TOOL_REJECTED: 403,
  NETWORK_ERROR: 502,
};

export function toEnvelope(err: EthosError): ErrorEnvelope {
  return { ok: false, code: err.code, error: err.cause, action: err.action };
}

export function statusFor(code: EthosErrorCode): number {
  return STATUS_BY_CODE[code] ?? 500;
}

/**
 * Last-resort handler. Mounted via `app.onError(...)` in `createWebApi`.
 * Routes themselves can also `c.json(toEnvelope(err), statusFor(err.code))`
 * directly when they want to short-circuit without throwing.
 */
export function errorHandler(err: Error, c: Context): Response {
  // B1 — the id the `x-request-id` middleware settled on for THIS request (an
  // inbound one it accepted, or the UUID it generated). This used to be a
  // freshly minted UUID visible only in the 500 body, so the id the client was
  // told to quote appeared in no response header and named no other log line.
  // Widened to `| undefined` on purpose: Hono types the variable as `string`
  // once the middleware is registered, but `errorHandler` is also mounted on
  // sub-apps in tests where it never ran.
  const requestId: string | undefined = c.get('requestId');
  if (isEthosError(err)) {
    return c.json(
      { ...toEnvelope(err), ...(requestId ? { requestId } : {}) },
      statusFor(err.code) as 400 | 401 | 403 | 404 | 409 | 413 | 500 | 502 | 504,
    );
  }
  // Anything else is a bug (uncaught raw Error). Log the full error server-side
  // for debugging but never reflect raw err.message to the client — it may
  // contain internal paths, stack traces, or database details.
  console.error('[internal_error]', requestId, err);
  const wrapped = new EthosError({
    code: 'INTERNAL',
    cause: requestId ? `Internal server error (request_id: ${requestId})` : 'Internal server error',
    action: 'Re-run the request. If the error repeats, file an issue with the request_id.',
  });
  return c.json({ ...toEnvelope(wrapped), ...(requestId ? { requestId } : {}) }, 500);
}

/**
 * Convenience middleware that wraps the rest of the chain in a try/catch.
 * Equivalent to `app.onError`, but composable into sub-routers when a single
 * Hono instance hosts both the API and (later) the static Vite assets.
 */
export const errorEnvelope: MiddlewareHandler = async (c, next) => {
  try {
    await next();
  } catch (err) {
    return errorHandler(err instanceof Error ? err : new Error(String(err)), c);
  }
};
