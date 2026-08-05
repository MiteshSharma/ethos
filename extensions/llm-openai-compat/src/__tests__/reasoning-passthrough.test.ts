// Lane 4b(b) — reasoning/thinking passthrough + the reasoning-only-turn retry.
//
//   - `delta.reasoning_content` (and the OpenRouter `delta.reasoning` variant)
//     surface as thinking_delta chunks, never as text.
//   - Balanced `<think>…</think>` blocks in `delta.content` are emitted as
//     thinking_delta and STRIPPED from the text stream.
//   - An unbalanced `<think>` is left in the text untouched (never eat
//     conversational mentions — plan Lane 4 risk note).
//   - A reasoning-only turn (thinking, zero text, zero tool calls) gets ONE
//     retry that is NOT vendor-gated — asserted for a non-OpenAI provider
//     name (the OpenClaw #101077 mistake was gating the retry to one vendor).

import type { CompletionChunk, LLMProvider } from '@ethosagent/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface OAIChunk {
  choices: Array<{
    delta: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
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

/** Queue of per-request streams; each create() call consumes one. */
const streams: { queue: OAIChunk[][]; createCalls: number } = { queue: [], createCalls: 0 };

vi.mock('openai', () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: async () => {
          streams.createCalls += 1;
          const chunks = streams.queue.shift();
          if (!chunks) throw new Error('mock stream queue exhausted');
          return {
            async *[Symbol.asyncIterator]() {
              for (const c of chunks) yield c;
            },
          };
        },
      },
    };
  }
  return { default: MockOpenAI };
});

const diagnostics: string[] = [];

async function makeProvider(): Promise<LLMProvider> {
  const { OpenAICompatProvider } = await import('../index');
  // Deliberately a non-OpenAI provider name + local port: the retry must not
  // be vendor-gated.
  return new OpenAICompatProvider({
    name: 'lmstudio',
    model: 'qwen3:8b',
    apiKey: 'k',
    baseUrl: 'http://localhost:1234/v1',
    onDiagnostic: (m) => diagnostics.push(m),
  });
}

async function collect(provider: LLMProvider): Promise<CompletionChunk[]> {
  const chunks: CompletionChunk[] = [];
  for await (const c of provider.complete([], [], {})) chunks.push(c);
  return chunks;
}

function textOf(chunks: CompletionChunk[]): string {
  return chunks
    .filter((c): c is Extract<CompletionChunk, { type: 'text_delta' }> => c.type === 'text_delta')
    .map((c) => c.text)
    .join('');
}

function thinkingOf(chunks: CompletionChunk[]): string {
  return chunks
    .filter(
      (c): c is Extract<CompletionChunk, { type: 'thinking_delta' }> => c.type === 'thinking_delta',
    )
    .map((c) => c.thinking)
    .join('');
}

beforeEach(() => {
  streams.queue = [];
  streams.createCalls = 0;
  diagnostics.length = 0;
});

describe('reasoning passthrough (Lane 4b(b))', () => {
  it('emits delta.reasoning_content as thinking_delta, stripped from text', async () => {
    streams.queue = [
      [
        { choices: [{ delta: { reasoning_content: 'let me think' }, finish_reason: null }] },
        { choices: [{ delta: { content: 'the answer' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ],
    ];
    const provider = await makeProvider();
    const chunks = await collect(provider);
    expect(thinkingOf(chunks)).toBe('let me think');
    expect(textOf(chunks)).toBe('the answer');
    expect(streams.createCalls).toBe(1);
  });

  it('handles the delta.reasoning variant (OpenRouter)', async () => {
    streams.queue = [
      [
        { choices: [{ delta: { reasoning: 'hmm' }, finish_reason: null }] },
        { choices: [{ delta: { content: 'ok' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ],
    ];
    const provider = await makeProvider();
    const chunks = await collect(provider);
    expect(thinkingOf(chunks)).toBe('hmm');
    expect(textOf(chunks)).toBe('ok');
  });

  it('emits balanced <think> blocks in content as thinking_delta and strips them from text', async () => {
    streams.queue = [
      [
        { choices: [{ delta: { content: '<think>step by ' }, finish_reason: null }] },
        { choices: [{ delta: { content: 'step</think>the answer' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ],
    ];
    const provider = await makeProvider();
    const chunks = await collect(provider);
    expect(thinkingOf(chunks)).toBe('step by step');
    expect(textOf(chunks)).toBe('the answer');
  });

  it('leaves an unbalanced <think> in the text untouched', async () => {
    streams.queue = [
      [
        { choices: [{ delta: { content: 'use a <think> tag for that' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ],
    ];
    const provider = await makeProvider();
    const chunks = await collect(provider);
    expect(thinkingOf(chunks)).toBe('');
    expect(textOf(chunks)).toBe('use a <think> tag for that');
  });

  it('retries ONCE on a reasoning-only turn, for a non-OpenAI provider name, with a diagnostic', async () => {
    streams.queue = [
      // Attempt 1: thinking only, then stop — no text, no tool calls.
      [
        { choices: [{ delta: { reasoning_content: 'endless pondering' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ],
      // Attempt 2 (the one retry): real output.
      [
        { choices: [{ delta: { content: 'recovered' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ],
    ];
    const provider = await makeProvider();
    const chunks = await collect(provider);

    expect(streams.createCalls).toBe(2);
    expect(textOf(chunks)).toBe('recovered');
    // Exactly one done reaches the consumer (the first was suppressed).
    expect(chunks.filter((c) => c.type === 'done')).toHaveLength(1);
    expect(diagnostics.some((d) => d.includes('reasoning-only turn (qwen3:8b)'))).toBe(true);
  });

  it('retries at most once — a second reasoning-only attempt ends the turn normally', async () => {
    const reasoningOnly: OAIChunk[] = [
      { choices: [{ delta: { reasoning_content: 'still thinking' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ];
    streams.queue = [reasoningOnly, reasoningOnly];
    const provider = await makeProvider();
    const chunks = await collect(provider);

    expect(streams.createCalls).toBe(2);
    expect(chunks.filter((c) => c.type === 'done')).toHaveLength(1);
    expect(textOf(chunks)).toBe('');
  });

  it('does not retry when the turn has real text alongside thinking', async () => {
    streams.queue = [
      [
        { choices: [{ delta: { reasoning_content: 'brief' }, finish_reason: null }] },
        { choices: [{ delta: { content: 'answer' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ],
    ];
    const provider = await makeProvider();
    await collect(provider);
    expect(streams.createCalls).toBe(1);
    expect(diagnostics).toHaveLength(0);
  });
});
