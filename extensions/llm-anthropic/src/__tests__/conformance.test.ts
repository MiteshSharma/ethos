// LLMProvider conformance suite — see plan/IMPROVEMENT.md P0-2.
//
// The contract: AnthropicProvider.complete() must yield ONLY the 7 canonical
// CompletionChunk types. Provider-specific shapes (message_start cache tokens,
// thinking_delta, content_block_*, message_delta usage) must be absorbed into
// the canonical wire shape so AgentLoop never sees them.
//
// If a future Anthropic SDK upgrade adds a new event type, this test is where
// the regression surfaces — long before it reaches AgentLoop.

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

// Mock the Anthropic SDK at the module level. Each test sets the events
// the fake stream will emit, then constructs the provider and collects.
const fakeEvents: { current: AnthropicSdkEvent[] } = { current: [] };

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = {
      stream: () => ({
        abort: () => {},
        async *[Symbol.asyncIterator]() {
          for (const ev of fakeEvents.current) yield ev;
        },
      }),
      countTokens: async () => ({ input_tokens: 1 }),
    };
  }
  return { default: MockAnthropic };
});

// Minimal type shape covering what AnthropicProvider reads on each event.
type AnthropicSdkEvent =
  | { type: 'message_start'; message: { usage: Record<string, number> } }
  | { type: 'content_block_start'; content_block: Record<string, unknown> }
  | { type: 'content_block_delta'; delta: Record<string, unknown> }
  | { type: 'content_block_stop' }
  | {
      type: 'message_delta';
      usage: { output_tokens: number };
      delta: { stop_reason?: string };
    }
  | { type: 'message_stop' };

async function collect(provider: LLMProvider) {
  const chunks: CompletionChunk[] = [];
  for await (const c of provider.complete([], [], {})) chunks.push(c);
  return chunks;
}

describe('AnthropicProvider conformance', () => {
  it('only yields canonical CompletionChunk types', async () => {
    fakeEvents.current = [
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 10,
          },
        },
      },
      { type: 'content_block_start', content_block: { type: 'text' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
      { type: 'content_block_stop' },
      {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'tu_1', name: 'echo' },
      },
      {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"x":1}' },
      },
      { type: 'content_block_stop' },
      { type: 'message_delta', usage: { output_tokens: 5 }, delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ];

    const { AnthropicProvider } = await import('../index');
    const provider = new AnthropicProvider({ apiKey: 'k', model: 'claude-haiku-4-5' });
    const chunks = await collect(provider);

    // Every chunk must be in the canonical set.
    for (const c of chunks) {
      expect(CANONICAL_TYPES.has(c.type)).toBe(true);
    }
    // Specific shape spot-checks.
    expect(chunks.find((c) => c.type === 'text_delta')).toBeDefined();
    expect(chunks.find((c) => c.type === 'tool_use_start')).toBeDefined();
    expect(chunks.find((c) => c.type === 'tool_use_delta')).toBeDefined();
    expect(chunks.find((c) => c.type === 'tool_use_end')).toBeDefined();
    expect(chunks.find((c) => c.type === 'usage')).toBeDefined();
    expect(chunks.find((c) => c.type === 'done')).toBeDefined();
  });

  it('absorbs cache token quirk — cache_read/cache_creation appear inside usage chunk', async () => {
    fakeEvents.current = [
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 20,
          },
        },
      },
      { type: 'content_block_start', content_block: { type: 'text' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '.' } },
      { type: 'content_block_stop' },
      { type: 'message_delta', usage: { output_tokens: 1 }, delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ];

    const { AnthropicProvider } = await import('../index');
    const provider = new AnthropicProvider({ apiKey: 'k', model: 'claude-haiku-4-5' });
    const chunks = await collect(provider);

    const usage = chunks.find((c) => c.type === 'usage') as Extract<
      CompletionChunk,
      { type: 'usage' }
    >;
    expect(usage).toBeDefined();
    expect(usage.usage.cacheReadTokens).toBe(80);
    expect(usage.usage.cacheCreationTokens).toBe(20);
    // Cache fields never leak as separate chunk types.
    for (const c of chunks) {
      expect((c as { type: string }).type).not.toMatch(/cache/);
    }
  });

  it('absorbs thinking_delta quirk — yields canonical thinking_delta, not raw SDK shape', async () => {
    fakeEvents.current = [
      {
        type: 'message_start',
        message: { usage: { input_tokens: 1 } },
      },
      { type: 'content_block_start', content_block: { type: 'thinking' } },
      {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'reasoning step 1...' },
      },
      { type: 'content_block_stop' },
      { type: 'content_block_start', content_block: { type: 'text' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } },
      { type: 'content_block_stop' },
      { type: 'message_delta', usage: { output_tokens: 1 }, delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ];

    const { AnthropicProvider } = await import('../index');
    const provider = new AnthropicProvider({
      apiKey: 'k',
      model: 'claude-opus-4-7',
    });
    const chunks = await collect(provider);
    const thinking = chunks.find((c) => c.type === 'thinking_delta') as Extract<
      CompletionChunk,
      { type: 'thinking_delta' }
    >;
    expect(thinking).toBeDefined();
    expect(thinking.thinking).toBe('reasoning step 1...');
    // No raw 'content_block_*' or 'message_*' types leak.
    for (const c of chunks) {
      expect(c.type).not.toMatch(/^content_block_/);
      expect(c.type).not.toMatch(/^message_/);
    }
  });

  it('emits a done chunk at the end of the stream', async () => {
    fakeEvents.current = [
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'content_block_start', content_block: { type: 'text' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop' },
      { type: 'message_delta', usage: { output_tokens: 1 }, delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ];

    const { AnthropicProvider } = await import('../index');
    const provider = new AnthropicProvider({ apiKey: 'k', model: 'claude-haiku-4-5' });
    const chunks = await collect(provider);
    const done = chunks.find((c) => c.type === 'done') as Extract<
      CompletionChunk,
      { type: 'done' }
    >;
    expect(done).toBeDefined();
    expect(['end_turn', 'tool_use', 'max_tokens', 'stop_sequence']).toContain(done.finishReason);
  });
});
