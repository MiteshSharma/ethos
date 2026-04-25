import type { CompletionChunk, LLMProvider, Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';

function makeMockLLM(responses: string[]): LLMProvider {
  let callCount = 0;
  return {
    name: 'mock',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(_messages: Message[]): AsyncIterable<CompletionChunk> {
      const text = responses[callCount++ % responses.length] ?? 'default response';
      yield { type: 'text_delta', text };
      yield {
        type: 'usage',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: 0.0001,
        },
      };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 10;
    },
  };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe('AgentLoop', () => {
  it('produces text_delta and done events for a simple turn', async () => {
    const loop = new AgentLoop({ llm: makeMockLLM(['Hello, world!']) });
    const events = await collect(loop.run('hi'));

    const textDeltas = events.filter((e) => e.type === 'text_delta');
    const done = events.find((e) => e.type === 'done');

    expect(textDeltas).toHaveLength(1);
    expect((textDeltas[0] as Extract<AgentEvent, { type: 'text_delta' }>).text).toBe(
      'Hello, world!',
    );
    expect(done).toBeDefined();
    expect((done as Extract<AgentEvent, { type: 'done' }>).turnCount).toBe(1);
  });

  it('accumulates full text in done event', async () => {
    const loop = new AgentLoop({ llm: makeMockLLM(['response text']) });
    const events = await collect(loop.run('ping'));
    const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
    expect(done.text).toBe('response text');
  });

  it('aborts cleanly when signal is fired', async () => {
    const controller = new AbortController();
    const loop = new AgentLoop({ llm: makeMockLLM(['text']) });

    // Abort before run
    controller.abort();
    const events = await collect(loop.run('hello', { abortSignal: controller.signal }));
    const errEvent = events.find((e) => e.type === 'error') as
      | Extract<AgentEvent, { type: 'error' }>
      | undefined;
    expect(errEvent?.code).toBe('aborted');
  });
});
