import type { AgentLoopConfig } from '@ethosagent/core';
import { AgentLoop, DefaultHookRegistry, DefaultToolRegistry } from '@ethosagent/core';
import type {
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
    async execute(_args, _ctx): Promise<ToolResult> {
      return toolResult;
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
 * for await (const event of loop.run('hi')) {
 *   if (event.type === 'done') console.log(event.text);
 * }
 */
export function createTestRuntime(
  config: Partial<AgentLoopConfig> & { llm: LLMProvider },
): AgentLoop {
  return new AgentLoop({
    tools: new DefaultToolRegistry(),
    hooks: new DefaultHookRegistry(),
    ...config,
  });
}
