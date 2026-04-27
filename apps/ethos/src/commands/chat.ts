import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentEvent, AgentLoop } from '@ethosagent/core';
import type { EthosConfig } from '../config';
import { createAgentLoop } from '../wiring';

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

const out = (s: string) => process.stdout.write(s);

// ---------------------------------------------------------------------------
// Mutable chat state (shared between REPL and slash commands)
// ---------------------------------------------------------------------------

interface ChatState {
  sessionKey: string;
  personalityId: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

// ---------------------------------------------------------------------------
// Main chat entry point
// ---------------------------------------------------------------------------

export async function runChat(config: EthosConfig): Promise<void> {
  const loop = await createAgentLoop(config);

  if (process.stdout.isTTY && process.stdin.isTTY) {
    const { runTUI } = await import('@ethosagent/tui');
    await runTUI(loop, { model: config.model, personality: config.personality });
    return;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const state: ChatState = {
    sessionKey: `cli:${basename(process.cwd())}`,
    personalityId: config.personality,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };

  let abort: AbortController | null = null;

  // First Ctrl+C aborts the running turn. If nothing is running, it exits.
  rl.on('SIGINT', () => {
    if (abort) {
      abort.abort();
      out(`\n${c.dim}[aborted — press Ctrl+C again to exit]${c.reset}\n`);
    } else {
      out('\n');
      rl.close();
    }
  });

  rl.on('close', () => process.exit(0));

  // Welcome
  out(
    `${c.bold}ethos${c.reset}  ${c.dim}${config.model} · ${state.personalityId} · /help${c.reset}\n\n`,
  );

  // REPL loop
  for (;;) {
    let input: string;
    try {
      input = await prompt(rl);
    } catch {
      break; // readline closed
    }

    if (!input) continue;

    if (input.startsWith('/')) {
      await handleSlashCommand(input, state, loop, rl, config);
      continue;
    }

    // Agent turn
    abort = new AbortController();
    out(`\n${c.bold}ethos${c.reset} > `);

    const toolTimers = new Map<string, number>();
    let hasText = false;

    try {
      for await (const event of loop.run(input, {
        sessionKey: state.sessionKey,
        personalityId: state.personalityId,
        abortSignal: abort.signal,
      })) {
        renderEvent(event, toolTimers, state.usage, hasText);
        if (event.type === 'text_delta') hasText = true;
      }
    } catch (err) {
      if (!abort?.signal.aborted) {
        out(`\n${c.red}Error: ${err instanceof Error ? err.message : String(err)}${c.reset}`);
      }
    } finally {
      abort = null;
      out('\n\n');
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt helper (wraps readline.question as a Promise)
// ---------------------------------------------------------------------------

function prompt(rl: ReturnType<typeof createInterface>): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.readable) {
      reject(new Error('stdin closed'));
      return;
    }
    rl.question(`${c.cyan}You${c.reset} > `, resolve);
  });
}

// ---------------------------------------------------------------------------
// Event renderer
// ---------------------------------------------------------------------------

function renderEvent(
  event: AgentEvent,
  toolTimers: Map<string, number>,
  usage: ChatState['usage'],
  hasText: boolean,
): void {
  switch (event.type) {
    case 'text_delta':
      out(event.text);
      break;

    case 'thinking_delta':
      // Hidden by default — surface with /think toggle if needed
      break;

    case 'tool_start': {
      // Newline before first tool if text preceded it
      if (hasText) out('\n');
      out(`${c.dim}  ⟳ ${event.toolName}${c.reset}`);
      toolTimers.set(event.toolCallId, Date.now());
      break;
    }

    case 'tool_progress': {
      // Phase 30.2 — only surface tool progress the tool explicitly tagged
      // for the user. Internal/default progress stays in logs/telemetry.
      // Framework-emitted budget warnings always tag `audience: 'user'`.
      if (event.audience !== 'user') break;
      if (hasText) out('\n');
      out(`${c.dim}  · ${event.toolName}: ${event.message}${c.reset}\n`);
      break;
    }

    case 'tool_end': {
      const ms = Date.now() - (toolTimers.get(event.toolCallId) ?? Date.now());
      toolTimers.delete(event.toolCallId);
      const mark = event.ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
      // \r overwrites the ⟳ spinner line with the completion status
      out(`\r${c.dim}  ${mark} ${c.reset}${c.dim}${event.toolName} ${ms}ms${c.reset}\n`);
      break;
    }

    case 'usage':
      usage.inputTokens += event.inputTokens;
      usage.outputTokens += event.outputTokens;
      usage.costUsd += event.estimatedCostUsd;
      break;

    case 'error':
      out(`\n${c.red}[${event.code}] ${event.error}${c.reset}`);
      break;

    case 'done':
      // Nothing to render — the REPL loop handles the newlines
      break;
  }
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

async function handleSlashCommand(
  raw: string,
  state: ChatState,
  _loop: AgentLoop,
  rl: ReturnType<typeof createInterface>,
  _config: EthosConfig,
): Promise<void> {
  const parts = raw.slice(1).trim().split(/\s+/);
  const name = parts[0]?.toLowerCase() ?? '';
  const arg = parts.slice(1).join(' ');

  switch (name) {
    case 'help':
      out(
        `\n${c.dim}` +
          `  /new                  start a fresh session\n` +
          `  /personality          show current personality\n` +
          `  /personality list     list all personalities\n` +
          `  /personality <id>     switch personality\n` +
          `  /model <name>         switch model for this session\n` +
          `  /memory               show ~/.ethos/MEMORY.md and USER.md\n` +
          `  /usage                show token and cost stats\n` +
          `  /exit                 quit\n` +
          `${c.reset}\n`,
      );
      break;

    case 'new':
    case 'reset':
      state.sessionKey = `cli:${basename(process.cwd())}:${Date.now()}`;
      out(`${c.dim}[new session started]${c.reset}\n`);
      break;

    case 'personality': {
      if (!arg) {
        out(`${c.dim}Current: ${state.personalityId}${c.reset}\n`);
        break;
      }
      if (arg === 'list') {
        out(
          `${c.dim}Built-ins: researcher · engineer · reviewer · coach · operator\n` +
            `User personalities: ~/.ethos/personalities/<id>/\n${c.reset}`,
        );
        break;
      }
      state.personalityId = arg;
      out(`${c.dim}[personality: ${arg}]${c.reset}\n`);
      break;
    }

    case 'model': {
      if (!arg) {
        out(`${c.dim}Current model: ${_config.model}${c.reset}\n`);
        break;
      }
      // Model switching requires a new AgentLoop — note for Phase 5
      out(
        `${c.yellow}Model switching takes effect on next restart. Edit ~/.ethos/config.yaml to persist.${c.reset}\n`,
      );
      break;
    }

    case 'memory': {
      const { MarkdownFileMemoryProvider } = await import('@ethosagent/memory-markdown');
      const mem = new MarkdownFileMemoryProvider();
      const result = await mem.prefetch({
        sessionId: '',
        sessionKey: state.sessionKey,
        platform: 'cli',
      });
      if (result) {
        out(`\n${result.content}${result.truncated ? `\n${c.dim}[truncated]${c.reset}` : ''}\n\n`);
      } else {
        out(`${c.dim}[no memory yet — chat to build it]${c.reset}\n`);
      }
      break;
    }

    case 'usage':
      out(
        `${c.dim}` +
          `Tokens  : ${state.usage.inputTokens.toLocaleString()} in · ${state.usage.outputTokens.toLocaleString()} out\n` +
          `Cost    : $${state.usage.costUsd.toFixed(5)}\n` +
          `${c.reset}`,
      );
      break;

    case 'exit':
    case 'quit':
      rl.close();
      break;

    default:
      out(`${c.dim}Unknown command /${name} — type /help${c.reset}\n`);
  }
}
