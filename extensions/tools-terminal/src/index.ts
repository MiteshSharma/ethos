import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool, ToolResult } from '@ethosagent/types';

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000; // 5 minutes
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024; // 5MB buffer

// ---------------------------------------------------------------------------
// terminal
// ---------------------------------------------------------------------------

export const terminalTool: Tool = {
  name: 'terminal',
  description:
    'Run a shell command and return its output. Commands run in the working directory by default. Use for build commands, tests, git operations, file operations, and anything that needs a shell. Avoid interactive commands that require user input.',
  toolset: 'terminal',
  maxResultChars: 20_000,
  schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Shell command to execute',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the command (defaults to agent working directory)',
      },
      timeout_ms: {
        type: 'number',
        description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`,
      },
    },
    required: ['command'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { command, cwd, timeout_ms } = args as {
      command: string;
      cwd?: string;
      timeout_ms?: number;
    };

    if (!command) return { ok: false, error: 'command is required', code: 'input_invalid' };

    const workDir = cwd ?? ctx.workingDir;
    const timeout = Math.min(timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: workDir,
        timeout,
        maxBuffer: MAX_OUTPUT_BYTES,
        shell: '/bin/bash',
      });

      const out = [stdout, stderr].filter(Boolean).join('\n').trim();
      return {
        ok: true,
        value: out || '(command completed with no output)',
      };
    } catch (err) {
      // exec throws on non-zero exit code; the output is still useful
      if (err instanceof Error && 'stdout' in err) {
        const execErr = err as Error & { stdout: string; stderr: string; code?: number };
        const out = [execErr.stdout, execErr.stderr].filter(Boolean).join('\n').trim();
        return {
          ok: false,
          error: `Command exited with error (code ${execErr.code ?? '?'}):\n${out || err.message}`,
          code: 'execution_failed',
        };
      }
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: 'execution_failed',
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTerminalTools(): Tool[] {
  return [terminalTool];
}

export { checkCommand, createTerminalGuardHook } from './guard';
