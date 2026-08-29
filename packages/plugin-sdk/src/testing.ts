import type { AgentLoopConfig } from '@ethosagent/core';
import { AgentLoop, DefaultHookRegistry, DefaultToolRegistry } from '@ethosagent/core';
import type {
  AgentSafety,
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  Tool,
  ToolDefinitionLite,
  ToolResult,
} from '@ethosagent/types';

// ---------------------------------------------------------------------------
// mockLLM — returns pre-defined text responses as streaming chunks
// ---------------------------------------------------------------------------

/**
 * Creates a mock `LLMProvider` that streams the given response strings in order.
 * Each string becomes a single `text_delta` chunk followed by a `done` chunk.
 */
export function mockLLM(responses: string[]): LLMProvider {
  let callCount = 0;

  return {
    name: 'mock',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,

    async *complete(
      _messages: Message[],
      _tools: ToolDefinitionLite[],
      _options: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      const text = responses[callCount % responses.length] ?? '';
      callCount++;

      if (text) yield { type: 'text_delta', text };
      yield { type: 'done', finishReason: 'end_turn' };
    },

    async countTokens(_messages: Message[]): Promise<number> {
      return 10;
    },
  };
}

// ---------------------------------------------------------------------------
// mockTool — returns a fixed result regardless of args
// ---------------------------------------------------------------------------

/**
 * Creates a `Tool` that always returns the given result.
 * Pass a string as shorthand for `{ ok: true, value: string }`.
 */
export function mockTool(name: string, result: ToolResult | string): Tool {
  const toolResult: ToolResult = typeof result === 'string' ? { ok: true, value: result } : result;

  return {
    name,
    description: `Mock tool: ${name}`,
    schema: { type: 'object', properties: {} },
    capabilities: {},
    async execute(_args, _ctx): Promise<ToolResult> {
      return toolResult;
    },
  };
}

// ---------------------------------------------------------------------------
// createPluginTestSafety — safety bundle for plugin tests
// ---------------------------------------------------------------------------

// Passthrough no-op safety bundle for plugin tests. Plugin tests exercise plugin
// tools and hooks, not the safety subsystem, so the real (private) safety
// implementations are intentionally not used here — keeping the published
// plugin-sdk free of any dependency on private safety/storage packages.
function createPluginTestSafety(): AgentSafety {
  return {
    injection: {
      prelude: '',
      downgradeRejectionMessage: '',
      sanitize: (content) => content,
      wrapUntrusted: ({ content }) => ({ content, strippedTokens: 0 }),
      shortPatternCheck: () => ({ containsInstructions: false, hits: [] }),
      c2PatternCheck: () => ({ containsInstructions: false }),
      resolveDowngradedTools: () => new Set<string>(),
    },
    redaction: {
      redactPii: (text) => text,
      redactString: (text) => text,
      detectSecrets: () => [],
    },
    scopedStorageFactory: (base) => base,
    approvalPosture: {
      kind: 'ungated',
      reason: 'plugin test runtime — no approval policy is registered',
    },
  };
}

// ---------------------------------------------------------------------------
// createTestRuntime — minimal AgentLoop for plugin tests
// ---------------------------------------------------------------------------

/**
 * Creates a minimal `AgentLoop` suitable for plugin tests.
 * Provide at least `llm` — everything else defaults to no-op implementations.
 *
 * @example
 * const loop = createTestRuntime({ llm: mockLLM(['Hello!']) });
 * let final = '';
 * for await (const event of loop.run('hi')) {
 *   if (event.type === 'done') final = event.text;
 * }
 */
export function createTestRuntime(
  config: Partial<AgentLoopConfig> & { llm: LLMProvider },
): AgentLoop {
  return new AgentLoop({
    tools: new DefaultToolRegistry(),
    hooks: new DefaultHookRegistry(),
    safety: createPluginTestSafety(),
    ...config,
  });
}
