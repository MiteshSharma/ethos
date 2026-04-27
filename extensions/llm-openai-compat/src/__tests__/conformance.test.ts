// LLMProvider conformance suite — see plan/IMPROVEMENT.md P0-2.
//
// Same contract as the Anthropic conformance test: OpenAICompatProvider must
// only ever yield the 7 canonical CompletionChunk types. The OpenAI tool-call
// streaming quirk (deltas keyed by index, not id) lives inside the provider
// and must not leak to AgentLoop.

import type { CompletionChunk, LLMProvider } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';

const CANONICAL_TYPES = new Set<CompletionChunk['type']>([
  'text_delta',
  'thinking_delta',
  'tool_use_start',
  'tool_use_delta',
  'tool_use_end',
  'usage',
  'done',
]);

interface OAIChunk {
  choices: Array<{
    delta: {
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

const fakeChunks: { current: OAIChunk[] } = { current: [] };

vi.mock('openai', () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: async () => ({
          async *[Symbol.asyncIterator]() {
            for (const c of fakeChunks.current) yield c;
          },
        }),
      },
    };
  }
  return { default: MockOpenAI };
});

async function collect(provider: LLMProvider) {
  const chunks: CompletionChunk[] = [];
  for await (const c of provider.complete([], [], {})) chunks.push(c);
  return chunks;
}

describe('OpenAICompatProvider conformance', () => {
  it('only yields canonical CompletionChunk types', async () => {
    fakeChunks.current = [
      { choices: [{ delta: { content: 'hello' } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call_1', function: { name: 'echo' } }],
            },
          },
        ],
      },
      {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }] } }],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ];

    const { OpenAICompatProvider } = await import('../index');
    const provider = new OpenAICompatProvider({
      name: 'mock',
      apiKey: 'k',
      baseUrl: 'https://example.com/v1',
      model: 'gpt-4o-mini',
    });
    const chunks = await collect(provider);

    for (const c of chunks) {
      expect(CANONICAL_TYPES.has(c.type)).toBe(true);
    }
    expect(chunks.find((c) => c.type === 'text_delta')).toBeDefined();
    expect(chunks.find((c) => c.type === 'tool_use_start')).toBeDefined();
    expect(chunks.find((c) => c.type === 'tool_use_delta')).toBeDefined();
    expect(chunks.find((c) => c.type === 'tool_use_end')).toBeDefined();
    expect(chunks.find((c) => c.type === 'usage')).toBeDefined();
    expect(chunks.find((c) => c.type === 'done')).toBeDefined();
  });

  it('absorbs the index-keyed tool-call quirk — only first delta has id and name', async () => {
    // Real OpenAI streaming: the first delta for a tool call carries `id` and
    // `function.name`; subsequent deltas carry only `function.arguments`. The
    // provider must reconstruct full tool_use_start before tool_use_delta.
    fakeChunks.current = [
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call_X', function: { name: 'lookup' } }],
            },
          },
        ],
      },
      {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }],
      },
      {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] } }],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ];

    const { OpenAICompatProvider } = await import('../index');
    const provider = new OpenAICompatProvider({
      name: 'mock',
      apiKey: 'k',
      baseUrl: 'https://example.com/v1',
      model: 'gpt-4o-mini',
    });
    const chunks = await collect(provider);

    const start = chunks.find((c) => c.type === 'tool_use_start') as Extract<
      CompletionChunk,
      { type: 'tool_use_start' }
    >;
    expect(start).toBeDefined();
    expect(start.toolName).toBe('lookup');
    expect(start.toolCallId).toBe('call_X');

    const deltas = chunks.filter((c) => c.type === 'tool_use_delta');
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    // Concatenated args must form the full JSON.
    const concatenated = deltas
      .map((d) => (d as Extract<CompletionChunk, { type: 'tool_use_delta' }>).partialJson)
      .join('');
    expect(concatenated).toBe('{"q":"hi"}');

    const end = chunks.find((c) => c.type === 'tool_use_end') as Extract<
      CompletionChunk,
      { type: 'tool_use_end' }
    >;
    expect(end).toBeDefined();
    expect(end.inputJson).toBe('{"q":"hi"}');
  });

  it('emits usage with cacheReadTokens=0 and cacheCreationTokens=0 (provider does not support caching)', async () => {
    fakeChunks.current = [
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } },
    ];

    const { OpenAICompatProvider } = await import('../index');
    const provider = new OpenAICompatProvider({
      name: 'mock',
      apiKey: 'k',
      baseUrl: 'https://example.com/v1',
      model: 'gpt-4o-mini',
    });
    const chunks = await collect(provider);

    const usage = chunks.find((c) => c.type === 'usage') as Extract<
      CompletionChunk,
      { type: 'usage' }
    >;
    expect(usage).toBeDefined();
    expect(usage.usage.cacheReadTokens).toBe(0);
    expect(usage.usage.cacheCreationTokens).toBe(0);
    expect(usage.usage.inputTokens).toBe(7);
    expect(usage.usage.outputTokens).toBe(3);
  });

  it('emits done with the right finishReason mapping', async () => {
    fakeChunks.current = [
      { choices: [{ delta: { content: 'fin.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ];

    const { OpenAICompatProvider } = await import('../index');
    const provider = new OpenAICompatProvider({
      name: 'mock',
      apiKey: 'k',
      baseUrl: 'https://example.com/v1',
      model: 'gpt-4o-mini',
    });
    const chunks = await collect(provider);
    const done = chunks.find((c) => c.type === 'done') as Extract<
      CompletionChunk,
      { type: 'done' }
    >;
    expect(done).toBeDefined();
    expect(done.finishReason).toBe('end_turn');
  });
});
