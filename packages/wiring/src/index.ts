import { join } from 'node:path';
import { AgentLoop, DefaultHookRegistry, DefaultToolRegistry } from '@ethosagent/core';
import { AnthropicProvider, AuthRotatingProvider } from '@ethosagent/llm-anthropic';
import { OpenAICompatProvider } from '@ethosagent/llm-openai-compat';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { VectorMemoryProvider } from '@ethosagent/memory-vector';
import { createPersonalityRegistry } from '@ethosagent/personalities';
import { DockerSandbox } from '@ethosagent/sandbox-docker';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { createInjectors } from '@ethosagent/skills';
import { createBrowserTools } from '@ethosagent/tools-browser';
import { createCodeTools } from '@ethosagent/tools-code';
import { createDelegationTools } from '@ethosagent/tools-delegation';
import { createFileTools } from '@ethosagent/tools-file';
import { loadMcpConfig, McpManager } from '@ethosagent/tools-mcp';
import { createMemoryTools } from '@ethosagent/tools-memory';
import {
  checkCommand,
  createTerminalGuardHook,
  createTerminalTools,
} from '@ethosagent/tools-terminal';
import { createWebTools } from '@ethosagent/tools-web';
import type { BeforeToolCallPayload, LLMProvider } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RotationKey {
  apiKey: string;
  priority: number;
  label?: string;
}

export interface WiringConfig {
  provider: string;
  model: string;
  apiKey: string;
  personality?: string;
  memory?: 'markdown' | 'vector';
  baseUrl?: string;
  /** Maps personality ID → model ID for per-personality model overrides. */
  modelRouting?: Record<string, string>;
  /** Anthropic key rotation pool. Empty / absent = single-key provider. */
  rotationKeys?: RotationKey[];
}

export type WiringProfile = 'cli' | 'tui' | 'web' | 'acp';

export interface WiringLogger {
  warn: (msg: string) => void;
}

const NOOP_LOGGER: WiringLogger = { warn: () => {} };

export interface CreateAgentLoopOptions {
  /** Root data directory (typically `~/.ethos`). Sessions DB, memory, and
   *  user personalities all resolve under this path. */
  dataDir: string;
  /** Working directory tools see. Defaults to `process.cwd()`. */
  workingDir?: string;
  /** Surface label surfaced to tools/hooks as `AgentLoop.options.platform`.
   *  Pure metadata — no behavioral branches keyed on it. */
  profile?: WiringProfile;
  /** Skip Docker init and the tools that depend on it (run_code, browser).
   *  Useful in containers / CI / web profiles where Docker isn't reachable. */
  disableDocker?: boolean;
  /** Optional log sink for non-fatal warnings (e.g. Docker missing, skill
   *  skipped). Defaults to a no-op so the package stays headless. */
  logger?: WiringLogger;
}

// ---------------------------------------------------------------------------
// LLM provider construction
// ---------------------------------------------------------------------------

export async function createLLM(config: WiringConfig): Promise<LLMProvider> {
  if (config.provider === 'anthropic') {
    const rotation = config.rotationKeys ?? [];
    if (rotation.length > 0) {
      return new AuthRotatingProvider(
        [
          { id: 'primary', apiKey: config.apiKey, priority: 100 },
          ...rotation.map((k, i) => ({
            id: k.label ?? `key-${i + 1}`,
            apiKey: k.apiKey,
            priority: k.priority,
          })),
        ],
        config.model,
      );
    }
    return new AnthropicProvider({ apiKey: config.apiKey, model: config.model });
  }
  return new OpenAICompatProvider({
    name: config.provider,
    model: config.model,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl ?? 'https://openrouter.ai/api/v1',
  });
}

// ---------------------------------------------------------------------------
// AgentLoop assembly
// ---------------------------------------------------------------------------

export async function createAgentLoop(
  config: WiringConfig,
  opts: CreateAgentLoopOptions,
): Promise<AgentLoop> {
  const { dataDir } = opts;
  const workingDir = opts.workingDir ?? process.cwd();
  const profile: WiringProfile = opts.profile ?? 'cli';
  const log: WiringLogger = opts.logger ?? NOOP_LOGGER;

  const llm = await createLLM(config);

  const session = new SQLiteSessionStore(join(dataDir, 'sessions.db'));
  const memory =
    config.memory === 'vector'
      ? new VectorMemoryProvider({ dir: dataDir })
      : new MarkdownFileMemoryProvider({ dir: dataDir });
  const personalities = await createPersonalityRegistry();
  await personalities.loadFromDirectory(join(dataDir, 'personalities'));

  if (config.personality) {
    try {
      personalities.setDefault(config.personality);
    } catch {
      // Unknown personality — fall back to built-in default.
    }
  }

  // Sandbox is shared by the browser and code tools. init() is non-blocking
  // when Docker is absent; the tool sets gate themselves on isAvailable().
  const sandbox = new DockerSandbox();
  if (!opts.disableDocker) {
    await sandbox.init();
    if (!sandbox.isAvailable()) log.warn('Docker not available — run_code tool disabled');
  }

  const tools = new DefaultToolRegistry();
  for (const tool of createFileTools()) tools.register(tool);
  for (const tool of createTerminalTools()) tools.register(tool);
  for (const tool of createWebTools()) tools.register(tool);
  for (const tool of createMemoryTools(memory, session)) tools.register(tool);
  if (!opts.disableDocker) {
    for (const tool of createCodeTools(sandbox)) tools.register(tool);
    for (const tool of createBrowserTools()) tools.register(tool);
  }

  const mcpManager = new McpManager(await loadMcpConfig());
  await mcpManager.connect();
  for (const tool of mcpManager.getTools()) tools.register(tool);

  const injectors = createInjectors(personalities, {
    onSkillSkip: (skillId, reason) => log.warn(`skill ${skillId} skipped: ${reason}`),
  });

  const hooks = new DefaultHookRegistry();
  // CLI/TUI/ACP get the synchronous block-and-explain guard. Web replaces it
  // with an interactive approval flow registered after createAgentLoop returns
  // (see @ethosagent/web-api). Both call sites share `checkCommand` via
  // `createDangerPredicate` below.
  if (profile !== 'web') {
    hooks.registerModifying('before_tool_call', createTerminalGuardHook());
  }

  const loop = new AgentLoop({
    llm,
    tools,
    session,
    memory,
    personalities,
    injectors,
    hooks,
    modelRouting: config.modelRouting,
    options: {
      platform: profile,
      workingDir,
    },
  });

  // Delegation tools need the loop reference; register after loop creation.
  // The registry is shared by reference, so the loop sees them on next turn.
  for (const tool of createDelegationTools(loop)) tools.register(tool);

  return loop;
}

// ---------------------------------------------------------------------------
// Danger predicate (shared between CLI guard + web approval flow)
// ---------------------------------------------------------------------------

/** Result returned by a danger predicate. `null` = no approval needed. */
export type DangerReason = string | null;
export type DangerPredicate = (payload: BeforeToolCallPayload) => DangerReason;

/**
 * Default danger predicate. Returns the human-readable reason when a tool
 * call should require explicit user approval (web profile) or be blocked
 * outright (CLI/TUI fallback path). Today only the `terminal` tool is
 * checked, but `alwaysAsk` lets surfaces opt additional tools into the
 * always-prompt set without baking the list in here.
 */
export function createDangerPredicate(
  opts: { alwaysAsk?: ReadonlyArray<string> } = {},
): DangerPredicate {
  const alwaysAsk = new Set(opts.alwaysAsk ?? []);
  return (payload) => {
    if (alwaysAsk.has(payload.toolName)) {
      return `${payload.toolName} requires explicit approval`;
    }
    if (payload.toolName === 'terminal') {
      const args = payload.args as { command?: string } | null | undefined;
      if (args?.command) {
        const result = checkCommand(args.command);
        if (result.dangerous) return result.reason;
      }
    }
    return null;
  };
}
