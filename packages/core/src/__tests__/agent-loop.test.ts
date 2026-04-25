import type { CompletionChunk, CompletionOptions, LLMProvider, Message } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';

function makeMockLLM(
  responses: string[],
  onComplete?: (opts: CompletionOptions) => void,
): LLMProvider {
  let callCount = 0;
  return {
    name: 'mock',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      _messages: Message[],
      _tools: unknown,
      opts: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      onComplete?.(opts);
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

  it('passes modelOverride when modelRouting matches the personality', async () => {
    const capturedOpts: CompletionOptions[] = [];
    const llm = makeMockLLM(['ok'], (opts) => capturedOpts.push(opts));
    const loop = new AgentLoop({
      llm,
      modelRouting: { default: 'routed-model' },
    });
    await collect(loop.run('hi'));
    expect(capturedOpts[0]?.modelOverride).toBe('routed-model');
  });

  it('passes no modelOverride when routing matches the base model', async () => {
    const capturedOpts: CompletionOptions[] = [];
    const llm = makeMockLLM(['ok'], (opts) => capturedOpts.push(opts));
    const loop = new AgentLoop({
      llm,
      modelRouting: { default: 'mock-model' }, // same as llm.model
    });
    await collect(loop.run('hi'));
    expect(capturedOpts[0]?.modelOverride).toBeUndefined();
  });

  it('passes no modelOverride when no routing is configured', async () => {
    const capturedOpts: CompletionOptions[] = [];
    const llm = makeMockLLM(['ok'], (opts) => capturedOpts.push(opts));
    const loop = new AgentLoop({ llm });
    await collect(loop.run('hi'));
    expect(capturedOpts[0]?.modelOverride).toBeUndefined();
  });

  it('passes filtered tool definitions when personality has a toolset', async () => {
    const capturedTools: unknown[][] = [];
    const llm: LLMProvider = {
      name: 'mock',
      model: 'mock-model',
      maxContextTokens: 200_000,
      supportsCaching: false,
      supportsThinking: false,
      async *complete(
        _messages: Message[],
        tools: unknown[],
      ): AsyncIterable<CompletionChunk> {
        capturedTools.push(tools);
        yield { type: 'text_delta', text: 'done' };
        yield {
          type: 'usage',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, estimatedCostUsd: 0 },
        };
        yield { type: 'done', finishReason: 'end_turn' };
      },
      async countTokens() { return 1; },
    };

    const { DefaultToolRegistry } = await import('../tool-registry');
    const tools = new DefaultToolRegistry();
    tools.register({
      name: 'allowed_tool',
      description: 'allowed',
      schema: { type: 'object' },
      execute: async () => ({ ok: true, value: '' }),
    });
    tools.register({
      name: 'blocked_tool',
      description: 'blocked',
      schema: { type: 'object' },
      execute: async () => ({ ok: true, value: '' }),
    });

    // Override the default personality to have a toolset
    const { DefaultPersonalityRegistry } = await import('../defaults/noop-personality');
    const personalities = new DefaultPersonalityRegistry();
    vi.spyOn(personalities, 'getDefault').mockReturnValue({
      id: 'default',
      name: 'Default',
      toolset: ['allowed_tool'],
    });

    const loop = new AgentLoop({ llm, tools, personalities });
    await collect(loop.run('hi'));

    expect(capturedTools[0]).toHaveLength(1);
    expect((capturedTools[0] as Array<{ name: string }>)[0]?.name).toBe('allowed_tool');
  });
});
