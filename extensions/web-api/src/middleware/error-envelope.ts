import { EthosError, type EthosErrorCode, isEthosError } from '@ethosagent/types';
import type { Context, MiddlewareHandler } from 'hono';

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
}

const STATUS_BY_CODE: Partial<Record<EthosErrorCode, number>> = {
  UNAUTHORIZED: 401,
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
  if (isEthosError(err)) {
    return c.json(
      toEnvelope(err),
      statusFor(err.code) as 400 | 401 | 403 | 404 | 409 | 500 | 502 | 504,
    );
  }
  // Anything else is a bug (uncaught raw Error). Coerce to INTERNAL so the
  // client sees the standard envelope shape; the original message lands in
  // `error` for greppable logs.
  const wrapped = new EthosError({
    code: 'INTERNAL',
    cause: err.message || 'Unknown error',
    action: 'Re-run the request. If the error repeats, file an issue.',
  });
  return c.json(toEnvelope(wrapped), 500);
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
