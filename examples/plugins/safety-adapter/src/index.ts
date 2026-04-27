/**
 * ethos-plugin-safety-adapter — Hook/adapter example
 *
 * Pattern demonstrated: using modifying hooks to intercept and alter
 * agent behaviour. This is the pattern for building safety layers,
 * compliance filters, cost controls, and access control systems.
 *
 * This plugin:
 *   1. Blocks dangerous terminal commands via before_tool_call
 *   2. Prepends a safety section to every system prompt via before_prompt_build
 *   3. Logs every blocked command via agent_done (void hook)
 */

import type { EthosPlugin, EthosPluginApi } from '@ethosagent/plugin-sdk';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\/(?!\S)/, // rm -rf / (root deletion)
  /:\(\)\{.*\|.*&\};:/, // fork bomb
  />\s*\/dev\/sd[a-z]/, // overwrite disk device
  /dd\s+if=.*of=\/dev\/sd/, // dd to disk device
  /mkfs\./, // format filesystem
  /shutdown\s+-[rh]/, // shutdown/reboot
];

const blockedCommands: string[] = [];

export function isDangerous(command: string): boolean {
  return BLOCKED_PATTERNS.some((re) => re.test(command));
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export async function beforeToolCall(payload: {
  sessionId: string;
  toolName: string;
  args: unknown;
}): Promise<{ error?: string; args?: unknown } | null> {
  if (payload.toolName !== 'terminal') return null;

  const command = (payload.args as { command?: string })?.command ?? '';

  if (isDangerous(command)) {
    blockedCommands.push(command);
    return {
      error: `[safety-adapter] Blocked: "${command}" matches a dangerous command pattern. Describe what you're trying to accomplish and I'll suggest a safer approach.`,
    };
  }

  return null;
}

const SAFETY_SECTION = `## Safety Rules

- Never run commands that delete system files or overwrite disk devices.
- Before running any destructive command (rm, mv, overwrite), confirm with the user.
- Prefer dry-run flags (--dry-run, -n) before irreversible operations.
- If a command could affect files outside the working directory, state it explicitly.`.trim();

async function beforePromptBuild(): Promise<{ prependSystem?: string } | null> {
  return { prependSystem: SAFETY_SECTION };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function activate(api: EthosPluginApi): void {
  api.registerModifyingHook('before_tool_call', beforeToolCall);
  api.registerModifyingHook('before_prompt_build', beforePromptBuild);
}

export function deactivate(): void {
  blockedCommands.length = 0;
}

/** Exposed for testing — returns commands blocked in this session. */
export function getBlockedCommands(): string[] {
  return [...blockedCommands];
}

const plugin: EthosPlugin = { activate, deactivate };
export default plugin;
