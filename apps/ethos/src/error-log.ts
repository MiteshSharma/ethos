// Phase 30.10 — local error log.
//
// Every `EthosError` rendered through the surface path is appended as one
// JSON line to `~/.ethos/logs/errors.jsonl`. Local-only — no upload, no
// telemetry. Rotates to `errors.jsonl.1`, `errors.jsonl.2`, … up to maxFiles
// when the file exceeds maxBytes (default: 10 MiB, 5 backups).
//
// Surfaced via `ethos doctor --recent-errors` so users can see "I've hit
// PROVIDER_AUTH_FAILED 12 times this week" without filing an issue.
//
// Log writes are best-effort: if the disk is full or the directory is
// read-only, we silently drop the line rather than masking the original
// error. The original error still renders to stderr.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { ethosDir } from '@ethosagent/config';
import type { EthosError } from '@ethosagent/types';

interface ErrorLogObservability {
  recordError(opts: {
    code?: string;
    cause?: string;
    traceId?: string;
    details?: Record<string, unknown>;
  }): void;
}

let _obs: ErrorLogObservability | undefined;

/**
 * Wire up an observability adapter so errors are also written to
 * observability.db. Call this once during CLI startup with the app's
 * EthosObservability adapter (or any object exposing `recordError`).
 */
export function setObservabilityService(obs: ErrorLogObservability): void {
  _obs = obs;
}

export interface LogRotationConfig {
  /** Maximum file size in bytes before rotation. Default: 10 MiB. */
  maxBytes: number;
  /** Maximum number of rotated backup files to keep. Default: 5. */
  maxFiles: number;
  /** Whether rotation is enabled. Default: true. */
  enabled: boolean;
}

const DEFAULT_ROTATION: LogRotationConfig = {
  maxBytes: 10 * 1024 * 1024,
  maxFiles: 5,
  enabled: true,
};

let _rotation: LogRotationConfig = DEFAULT_ROTATION;

/**
 * Override the default rotation config. Call this once during CLI startup,
 * e.g. from wiring.ts after reading ~/.ethos/config.yaml.
 */
export function setRotationConfig(config: Partial<LogRotationConfig>): void {
  const merged = { ...DEFAULT_ROTATION, ...config };
  if (!Number.isFinite(merged.maxBytes) || merged.maxBytes <= 0)
    merged.maxBytes = DEFAULT_ROTATION.maxBytes;
  if (!Number.isFinite(merged.maxFiles) || merged.maxFiles < 1)
    merged.maxFiles = DEFAULT_ROTATION.maxFiles;
  _rotation = merged;
}

function logsDir(): string {
  return join(ethosDir(), 'logs');
}

function logPath(): string {
  return join(logsDir(), 'errors.jsonl');
}

interface LogContext {
  sessionId?: string;
  personalityId?: string;
  toolName?: string;
  command?: string;
  /**
   * B3 — the turn's observability trace id, when the error happened inside a
   * turn. This is the single turn identity: the same id the turn's spans hang
   * off, that `messages.trace_id` carries, and that the `run_start` / `done`
   * AgentEvents expose. It is what turns a line in `errors.jsonl` into
   * something you can look up (`ethos trace <id>`) rather than just read.
   */
  traceId?: string;
}

export interface LoggedError {
  ts: string;
  code: string;
  cause: string;
  action: string;
  details?: unknown;
  sessionId?: string;
  personalityId?: string;
  toolName?: string;
  command?: string;
  /** The turn's observability trace id — see `LogContext.traceId`. */
  traceId?: string;
}

export function rotateIfNeeded(filePath: string, config: LogRotationConfig): void {
  if (!config.enabled) return;
  if (!Number.isFinite(config.maxBytes) || config.maxBytes <= 0) return;
  if (!Number.isFinite(config.maxFiles) || config.maxFiles < 1) return;
  const maxFiles = Math.floor(config.maxFiles);
  try {
    const stat = statSync(filePath);
    if (stat.size < config.maxBytes) return;
  } catch {
    return; // file doesn't exist yet
  }
  // Delete oldest backup if at max count
  try {
    unlinkSync(`${filePath}.${maxFiles}`);
  } catch {
    /* ok — missing is fine */
  }
  // Shift existing backups: .N → .N+1
  for (let i = maxFiles - 1; i >= 1; i--) {
    try {
      renameSync(`${filePath}.${i}`, `${filePath}.${i + 1}`);
    } catch {
      /* ok — missing is fine */
    }
  }
  // Rename current log → .1
  try {
    renameSync(filePath, `${filePath}.1`);
  } catch {
    /* ok */
  }
}

/**
 * Append one error to `~/.ethos/logs/errors.jsonl`. Best-effort — failures
 * are swallowed so the surface error still renders. Synchronous so the
 * top-level handler can run it before `process.exit(1)`.
 */
export function appendErrorLog(err: EthosError, ctx: LogContext = {}): void {
  try {
    mkdirSync(logsDir(), { recursive: true });
    rotateIfNeeded(logPath(), _rotation);
    const entry: LoggedError = {
      ts: new Date().toISOString(),
      code: err.code,
      cause: err.cause,
      action: err.action,
      ...(err.details !== undefined && { details: err.details }),
      ...ctx,
    };
    appendFileSync(logPath(), `${JSON.stringify(entry)}\n`);
    try {
      // `traceId` is lifted out of `details` and onto the event itself so the
      // observability row lands under the turn's trace instead of burying the
      // id in an opaque blob — that is what makes the jsonl row and the trace
      // the same lookup.
      const { traceId, ...rest } = ctx;
      _obs?.recordError({
        code: err.code,
        cause: err.cause,
        ...(traceId ? { traceId } : {}),
        details: { action: err.action, ...rest },
      });
    } catch {
      // Observability is best-effort — never mask the primary log write.
    }
  } catch {
    // Disk full, perms, ENOSPC — drop the entry, surface error still prints.
  }
}

/**
 * Read the most recent N errors from the log (newest first). Returns [] if
 * the file is missing or unreadable.
 */
export function readRecentErrors(limit = 50): LoggedError[] {
  try {
    const raw = readFileSync(logPath(), 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const tail = lines.slice(-limit);
    const out: LoggedError[] = [];
    for (const line of tail) {
      try {
        out.push(JSON.parse(line) as LoggedError);
      } catch {
        // Skip malformed lines rather than fail the whole report.
      }
    }
    return out.reverse();
  } catch {
    return [];
  }
}

/** True if the log file exists. Used by `doctor --recent-errors` to message empty state. */
export function errorLogExists(): boolean {
  return existsSync(logPath());
}

/** Path to the log file, for messages and tests. */
export function errorLogPath(): string {
  return logPath();
}
