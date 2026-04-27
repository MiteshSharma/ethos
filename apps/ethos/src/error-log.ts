// Phase 30.10 — local error log.
//
// Every `EthosError` rendered through the surface path is appended as one
// JSON line to `~/.ethos/logs/errors.jsonl`. Local-only — no upload, no
// telemetry. Capped at 10MB; rotates to `errors.jsonl.1` (single backup).
//
// Surfaced via `ethos doctor --recent-errors` so users can see "I've hit
// PROVIDER_AUTH_FAILED 12 times this week" without filing an issue.
//
// Log writes are best-effort: if the disk is full or the directory is
// read-only, we silently drop the line rather than masking the original
// error. The original error still renders to stderr.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { EthosError } from '@ethosagent/types';
import { ethosDir } from './config';

const MAX_BYTES = 10 * 1024 * 1024;

function logsDir(): string {
  return join(ethosDir(), 'logs');
}

function logPath(): string {
  return join(logsDir(), 'errors.jsonl');
}

function backupPath(): string {
  return join(logsDir(), 'errors.jsonl.1');
}

interface LogContext {
  sessionId?: string;
  personalityId?: string;
  toolName?: string;
  command?: string;
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
}

function rotateIfNeeded(): void {
  try {
    const stats = statSync(logPath());
    if (stats.size >= MAX_BYTES) {
      // Single rolling backup — overwrite the prior backup with the current log.
      renameSync(logPath(), backupPath());
    }
  } catch {
    // No file yet, or stat failed — nothing to rotate.
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
    rotateIfNeeded();
    const entry: LoggedError = {
      ts: new Date().toISOString(),
      code: err.code,
      cause: err.cause,
      action: err.action,
      ...(err.details !== undefined && { details: err.details }),
      ...ctx,
    };
    appendFileSync(logPath(), `${JSON.stringify(entry)}\n`);
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
