// Phase 30.9 — Error envelope discipline.
//
// Every user-facing error has a code, a one-line cause, and a suggested action.
// `EthosError` extends `Error` so it throws and catches like any other error,
// but carries the structured payload that surfaces (CLI, gateway, web API)
// render with `formatError`.
//
// Library code (packages/core, extensions/*) may still `throw new Error(...)`.
// Surface code (apps/ethos/src/commands/*, gateway adapters, web routes) must
// throw `EthosError` — enforced by the lint test in tests/lint/.
//
// Keep this file zero-dep and side-effect-free; @ethosagent/types is imported
// by every package and must stay safe to load anywhere.

/**
 * Registered error codes. SCREAMING_SNAKE_CASE.
 *
 * Adding a code? Document it in `docs/content/troubleshooting.md` ("Error
 * reference" section). The doc-sync gate in Phase 30.7 enforces the round-trip.
 */
export type EthosErrorCode =
  // Configuration / setup
  | 'CONFIG_MISSING'
  | 'CONFIG_INVALID'
  | 'PERSONALITY_NOT_FOUND'
  // Provider / LLM
  | 'PROVIDER_AUTH_FAILED'
  | 'LLM_ERROR'
  | 'STREAM_TIMEOUT'
  // CLI input
  | 'INVALID_INPUT'
  | 'INVALID_PROVIDER'
  | 'INVALID_TOOLSET'
  | 'FILE_NOT_FOUND'
  | 'BATCH_INVALID_LINE'
  | 'EVAL_INVALID_LINE'
  // Tools / subagents
  | 'TOOL_REJECTED'
  | 'TOOL_EXECUTION_FAILED'
  | 'SUBAGENT_TASK_DUPLICATED'
  // Cron / jobs
  | 'JOB_NOT_FOUND'
  | 'JOB_DUPLICATE'
  | 'JOB_LOCK_FAILED'
  | 'CRON_INVALID'
  | 'CRON_PERSONALITY_MISSING'
  | 'CRON_RUN_FAILED'
  | 'CRON_TARGET_NOT_ALLOWED'
  // Recipes (one-click use-case bundles)
  | 'RECIPE_NOT_FOUND'
  | 'RECIPE_INVALID'
  | 'RECIPE_STALE'
  | 'RECIPE_BLOCKED'
  | 'RECIPE_CHANNEL_SETUP_FAILED'
  // MCP
  | 'MCP_TRANSPORT_INVALID'
  | 'MCP_SERVER_NOT_FOUND'
  // Secrets
  | 'SECRETS_UNAVAILABLE'
  // Network / registry
  | 'REGISTRY_FETCH_FAILED'
  | 'NETWORK_ERROR'
  // Skills (Phase 30.3 surface)
  | 'SKILL_INSTALL_FAILED'
  | 'SKILL_NOT_FOUND'
  | 'SKILL_EXISTS'
  | 'SKILL_READONLY'
  | 'MISSING_SKILL'
  // Plugins (Phase 30.6 surface)
  | 'PLUGIN_CONTRACT_INCOMPATIBLE'
  | 'PLUGIN_INSTALL_FAILED'
  // Team manifest (Teamwork Core)
  | 'TEAM_MANIFEST_INVALID'
  // Backup / import
  | 'IMPORT_BLOCKED'
  | 'IMPORT_NEWER_SCHEMA'
  // Memory
  | 'MEMORY_CONFLICT'
  // Web API (Phase 26)
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'NOT_CONFIGURED'
  | 'SESSION_NOT_FOUND'
  | 'PERSONALITY_EXISTS'
  | 'PERSONALITY_READ_ONLY'
  // Documents (Documents upload + folders)
  | 'WORKDIR_NOT_CONFIGURED'
  | 'DOCUMENT_EXISTS'
  | 'PAYLOAD_TOO_LARGE'
  // Catch-all
  | 'INTERNAL';

export interface EthosErrorInit {
  code: EthosErrorCode;
  /** One-line description of what went wrong. No trailing period needed. */
  cause: string;
  /** One-line suggested next step the user can take. */
  action: string;
  /** Free-form structured context for logs. Not shown by default in CLI rendering. */
  details?: unknown;
}

/**
 * Surface-layer error. Throw from CLI commands, gateway adapters, and the web
 * API. Catch-all rendering in the surface picks up `code/cause/action`.
 */
export class EthosError extends Error {
  readonly code: EthosErrorCode;
  readonly cause: string;
  readonly action: string;
  readonly details?: unknown;

  constructor(init: EthosErrorInit) {
    // Use `cause` as the Error message so existing `err.message` consumers keep
    // working. The structured fields live alongside.
    super(init.cause);
    this.name = 'EthosError';
    this.code = init.code;
    this.cause = init.cause;
    this.action = init.action;
    if (init.details !== undefined) this.details = init.details;
  }
}

export function isEthosError(err: unknown): err is EthosError {
  return err instanceof EthosError;
}

/**
 * Wrap an unknown error so callers can render it through the same path. Used
 * by the top-level handler in `apps/ethos/src/index.ts` to coerce stray
 * exceptions from library code into the envelope shape.
 */
export function toEthosError(err: unknown, fallbackCode: EthosErrorCode = 'INTERNAL'): EthosError {
  if (isEthosError(err)) return err;
  const cause = err instanceof Error ? err.message : String(err);
  return new EthosError({
    code: fallbackCode,
    cause: cause || 'Unknown error',
    action: 'Re-run with the same inputs. If the error repeats, file an issue with the message.',
    details: err instanceof Error ? { name: err.name, stack: err.stack } : { value: err },
  });
}

interface FormatOptions {
  /** Emit ANSI color codes. Defaults to false (let the caller decide). */
  color?: boolean;
}

const ANSI = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

/**
 * Render an `EthosError` into the standard 3-line block:
 *
 *     ✗ <CODE>: <cause>
 *       → <action>
 *
 * Surfaces (CLI, gateway adapters) call this and pipe the result to stderr or
 * the user channel.
 */
export function formatError(err: EthosError, opts: FormatOptions = {}): string {
  const color = opts.color === true;
  const c = color ? ANSI : { reset: '', red: '', yellow: '', dim: '', bold: '' };
  return [
    `${c.red}✗ ${c.bold}${err.code}${c.reset}${c.red}:${c.reset} ${err.cause}`,
    `  ${c.dim}→${c.reset} ${err.action}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// MemoryConflictError
// ---------------------------------------------------------------------------

/**
 * Thrown by LastWriteWinsPolicy when a concurrent write is detected: the
 * entry's mtime at the time of sync() is newer than the mtime recorded when
 * the caller last read it.
 *
 * Callers may catch `MemoryConflictError` and retry after re-reading the
 * current entry.
 */
export class MemoryConflictError extends EthosError {
  readonly key: string;
  readonly scopeId: string;
  /** mtime recorded when the caller last read the entry (ms). */
  readonly recordedAt: number;
  /** current mtime of the entry at sync() time (ms). */
  readonly currentAt: number;

  constructor(opts: { key: string; scopeId: string; recordedAt: number; currentAt: number }) {
    const cause =
      `Conflict on "${opts.key}" in scope "${opts.scopeId}": ` +
      `entry modified at ${opts.currentAt} but caller last read at ${opts.recordedAt}`;
    super({
      code: 'MEMORY_CONFLICT',
      cause,
      action: 'Re-read the entry and retry the sync.',
    });
    this.name = 'MemoryConflictError';
    this.key = opts.key;
    this.scopeId = opts.scopeId;
    this.recordedAt = opts.recordedAt;
    this.currentAt = opts.currentAt;
  }
}
