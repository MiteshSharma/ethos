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
import { createTerminalGuardHook, createTerminalTools } from '@ethosagent/tools-terminal';
import { createWebTools } from '@ethosagent/tools-web';
import { type EthosConfig, ethosDir, readKeys } from './config';
import { logger } from './logger';

export async function createAgentLoop(config: EthosConfig): Promise<AgentLoop> {
  const dir = ethosDir();

  const rotationKeys = config.provider === 'anthropic' ? await readKeys() : [];
  const llm =
    config.provider === 'anthropic'
      ? rotationKeys.length > 0
        ? new AuthRotatingProvider(
            [
              { id: 'primary', apiKey: config.apiKey, priority: 100 },
              ...rotationKeys.map((k, i) => ({
                id: k.label ?? `key-${i + 1}`,
                apiKey: k.apiKey,
                priority: k.priority,
              })),
            ],
            config.model,
          )
        : new AnthropicProvider({ apiKey: config.apiKey, model: config.model })
      : new OpenAICompatProvider({
          name: config.provider,
          model: config.model,
          apiKey: config.apiKey,
          baseUrl: config.baseUrl ?? 'https://openrouter.ai/api/v1',
        });

  const session = new SQLiteSessionStore(join(dir, 'sessions.db'));
  const memory =
    config.memory === 'vector'
      ? new VectorMemoryProvider({ dir })
      : new MarkdownFileMemoryProvider({ dir });
  const personalities = await createPersonalityRegistry();

  await personalities.loadFromDirectory(join(dir, 'personalities'));

  if (config.personality) {
    try {
      personalities.setDefault(config.personality);
    } catch {
      // Unknown personality — keep built-in default
    }
  }

  // Initialize Docker sandbox — both tools-browser and tools-code use it.
  // init() is non-blocking if Docker is absent; both tool sets use isAvailable().
  const sandbox = new DockerSandbox();
  await sandbox.init();
  if (!sandbox.isAvailable()) {
    logger.warn('Docker not available — run_code tool disabled');
  }

  // Build tool registry — delegation tools are added after loop creation
  // since they need a reference to the loop itself.
  const tools = new DefaultToolRegistry();
  for (const tool of createFileTools()) tools.register(tool);
  for (const tool of createTerminalTools()) tools.register(tool);
  for (const tool of createWebTools()) tools.register(tool);
  for (const tool of createMemoryTools(memory, session)) tools.register(tool);
  for (const tool of createCodeTools(sandbox)) tools.register(tool);
  for (const tool of createBrowserTools()) tools.register(tool);

  // MCP servers — load from ~/.ethos/mcp.json if present
  const mcpManager = new McpManager(await loadMcpConfig());
  await mcpManager.connect();
  for (const tool of mcpManager.getTools()) tools.register(tool);

  const injectors = createInjectors(personalities);

  const hooks = new DefaultHookRegistry();
  hooks.registerModifying('before_tool_call', createTerminalGuardHook());

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
      platform: 'cli',
      workingDir: process.cwd(),
    },
  });

  // Register delegation tools after loop creation — they call loop.run() recursively.
  // The registry is shared by reference so the loop sees them immediately.
  for (const tool of createDelegationTools(loop)) tools.register(tool);

  return loop;
}
