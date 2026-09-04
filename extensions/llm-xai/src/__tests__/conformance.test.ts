// xAI provider conformance — mirrors llm-codex/llm-azure/__tests__/conformance.
// XaiProvider owns no streaming loop of its own (ARCHITECTURE.md:264-265): it
// builds a ResponsesApiBody and delegates to `streamResponsesApi` from
// @ethosagent/llm-codex. This test pins the chunk contract at the seam a caller
// actually sees, so a change inside the shared transport shows up here too.
//
// The SSE fixture below is SYNTHETIC — it is the OpenAI Responses event shape
// the shared transport already parses, not a recorded xAI response. No xAI key
// was available; see the UNVERIFIED note at the top of ../index.ts.

import type { CompletionChunk, LLMProvider } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XaiProvider } from '../index';

const CANONICAL_TYPES = new Set<CompletionChunk['type']>([
  'text_delta',
  'thinking_delta',
  'tool_use_start',
  'tool_use_delta',
  'tool_use_end',
  'usage',
  'done',
]);

function sse(events: Array<{ event: string; data: unknown }>): Response {
  const text = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
  return new Response(text, { status: 200 });
}

const realFetch = globalThis.fetch;

async function collect(provider: LLMProvider) {
  const chunks: CompletionChunk[] = [];
  for await (const c of provider.complete([], [], {})) chunks.push(c);
  return chunks;
}

describe('XaiProvider conformance', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () =>
      sse([
        { event: 'response.created', data: {} },
        { event: 'response.output_text.delta', data: { delta: 'hello' } },
        {
          event: 'response.output_item.added',
          data: { item: { type: 'function_call', call_id: 'call_1', name: 'echo' } },
        },
        { event: 'response.function_call_arguments.delta', data: { delta: '{"x":1}' } },
        {
          event: 'response.output_item.done',
          data: { item: { type: 'function_call', call_id: 'call_1', arguments: '{"x":1}' } },
        },
        {
          event: 'response.completed',
          data: { response: { usage: { input_tokens: 10, output_tokens: 5 } } },
        },
      ]),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('only yields canonical CompletionChunk types', async () => {
    const provider = new XaiProvider({ model: 'grok-4.6', apiKey: 'k' });
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

  it('reports usage tokens, with cacheReadTokens 0 until a stable cache key lands (D7)', async () => {
    const provider = new XaiProvider({ model: 'grok-4.6', apiKey: 'k' });
    const chunks = await collect(provider);
    const usage = chunks.find((c) => c.type === 'usage');
    if (usage?.type !== 'usage') throw new Error('expected a usage chunk');
    expect(usage.usage.inputTokens).toBe(10);
    expect(usage.usage.outputTokens).toBe(5);
    expect(usage.usage.cacheReadTokens).toBe(0);
  });

  it('declares capabilities honestly: no prompt caching, no stop sequences', () => {
    const provider = new XaiProvider({ model: 'grok-4.6', apiKey: 'k' });
    expect(provider.capabilities.streaming).toBe(true);
    expect(provider.capabilities.toolCalling).toBe(true);
    expect(provider.capabilities.promptCaching).toBe(false);
    expect(provider.capabilities.stopSequences).toBe(false);
    expect(provider.supportsCaching).toBe(false);
  });

  it('countTokens returns a positive integer for non-empty messages', async () => {
    const provider = new XaiProvider({ model: 'grok-4.6', apiKey: 'k' });
    const n = await provider.countTokens([{ role: 'user', content: 'hello world from xAI' }]);
    expect(n).toBeGreaterThan(0);
    expect(Number.isInteger(n)).toBe(true);
  });
});
