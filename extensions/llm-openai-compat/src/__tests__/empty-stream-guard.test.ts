// Lane 4a(c) — empty/silent-completion guard. Local runtimes (Ollama,
// llama.cpp, LM Studio) can end the SSE stream with NO finish_reason on
// abort, OOM, or a malformed final chunk. Before the guard, the transport
// yielded nothing at all — not even `done` — and the failure was silent.
//
//   - No finish_reason AND no output → an explicit error naming the model
//     and "no output" (thrown; CompletionChunk has no error variant — the
//     provider contract is to throw and AgentLoop surfaces `llm_error`).
//   - Content streamed but no finish_reason → the turn ends cleanly with a
//     synthesized `done`; the streamed text is preserved, not discarded.
//
// Unconditional across every dialect (universal bugfix per plan §2).

import type { CompletionChunk, LLMProvider } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';

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

async function makeProvider(): Promise<LLMProvider> {
  const { OpenAICompatProvider } = await import('../index');
  return new OpenAICompatProvider({
    name: 'lmstudio',
    model: 'qwen3:8b',
    apiKey: 'k',
    baseUrl: 'http://localhost:1234/v1',
  });
}

async function collect(provider: LLMProvider): Promise<CompletionChunk[]> {
  const chunks: CompletionChunk[] = [];
  for await (const c of provider.complete([], [], {})) chunks.push(c);
  return chunks;
}

describe('streamChatCompletions — empty/silent-completion guard (Lane 4a(c))', () => {
  it('throws an error naming the model and "no output" when the stream ends with no finish_reason and no content', async () => {
    fakeChunks.current = [
      // A single empty delta (role announcement shape), then the stream dies.
      { choices: [{ delta: {}, finish_reason: null }] },
    ];
    const provider = await makeProvider();
    await expect(collect(provider)).rejects.toThrow(/model qwen3:8b returned no output/);
  });

  it('throws even when only a usage chunk arrives (no output at all)', async () => {
    fakeChunks.current = [{ choices: [], usage: { prompt_tokens: 3, completion_tokens: 0 } }];
    const provider = await makeProvider();
    await expect(collect(provider)).rejects.toThrow(/returned no output/);
  });

  it('ends the turn cleanly when content WAS streamed but no finish_reason arrived', async () => {
    fakeChunks.current = [
      { choices: [{ delta: { content: 'hello' }, finish_reason: null }] },
      { choices: [{ delta: { content: ' world' }, finish_reason: null }] },
    ];
    const provider = await makeProvider();
    const chunks = await collect(provider);

    // Streamed text is preserved, not thrown away.
    const text = chunks
      .filter((c): c is Extract<CompletionChunk, { type: 'text_delta' }> => c.type === 'text_delta')
      .map((c) => c.text)
      .join('');
    expect(text).toBe('hello world');

    // A clean synthesized done ends the turn.
    const done = chunks.at(-1);
    expect(done).toEqual({ type: 'done', finishReason: 'end_turn' });
  });

  it('flushes pending tool calls and synthesizes done tool_use when tool deltas streamed but no finish_reason arrived', async () => {
    fakeChunks.current = [
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'echo' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }] },
            finish_reason: null,
          },
        ],
      },
    ];
    const provider = await makeProvider();
    const chunks = await collect(provider);

    const toolEnd = chunks.find(
      (c): c is Extract<CompletionChunk, { type: 'tool_use_end' }> => c.type === 'tool_use_end',
    );
    expect(toolEnd).toEqual({ type: 'tool_use_end', toolCallId: 'call_1', inputJson: '{"x":1}' });
    expect(chunks.at(-1)).toEqual({ type: 'done', finishReason: 'tool_use' });
  });

  it('does not fire when the stream carries a normal finish_reason (guard is inert on healthy streams)', async () => {
    fakeChunks.current = [
      { choices: [{ delta: { content: 'ok' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ];
    const provider = await makeProvider();
    const chunks = await collect(provider);
    const dones = chunks.filter((c) => c.type === 'done');
    expect(dones).toEqual([{ type: 'done', finishReason: 'end_turn' }]);
  });
});
