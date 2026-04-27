/**
 * ethos-plugin-memory-logger — Memory/persistence example
 *
 * Pattern demonstrated: using a void hook to persist data after each turn.
 * This is the pattern for building custom memory backends, analytics
 * sinks, audit logs, and session exporters.
 *
 * On every agent_done event, appends a one-line summary to
 * ~/.ethos/logs/sessions.log (configurable via ETHOS_LOG_FILE).
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EthosPlugin, EthosPluginApi } from '@ethosagent/plugin-sdk';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function logFilePath(): string {
  return process.env.ETHOS_LOG_FILE ?? join(homedir(), '.ethos', 'logs', 'sessions.log');
}

// ---------------------------------------------------------------------------
// Hook handler
// ---------------------------------------------------------------------------

export async function logSessionEntry(payload: {
  sessionId: string;
  text: string;
  turnCount: number;
}): Promise<void> {
  const path = logFilePath();
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      sessionId: payload.sessionId,
      turns: payload.turnCount,
      chars: payload.text.length,
    }) + '\n';

  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, line, 'utf-8');
  } catch {
    // Non-critical: log to stderr and continue
    console.error(`[memory-logger] Failed to write to ${path}`);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function activate(api: EthosPluginApi): void {
  api.registerVoidHook('agent_done', logSessionEntry);
}

export function deactivate(): void {}

const plugin: EthosPlugin = { activate, deactivate };
export default plugin;
