import type { CompletionChunk, CompletionOptions, LLMProvider, Message } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { createTestSafety } from './helpers/test-safety';

function makeMockLLM(onComplete?: (opts: CompletionOptions) => void): LLMProvider {
  return {
    name: 'mock',
    model: 'base-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      _messages: Message[],
      _tools: unknown,
      opts: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      onComplete?.(opts);
      yield { type: 'text_delta', text: 'ok' };
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
  for await (const event of gen) events.push(event);
  return events;
}

describe('Model tier resolution', () => {
  it('uses default tier model when personality declares matching provider', async () => {
    const onComplete = vi.fn();
    const llm = makeMockLLM(onComplete);
    const loop = new AgentLoop({ llm, safety: createTestSafety() });

    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define({
      id: 'tiered',
      name: 'Tiered',
      provider: 'mock',
      model: { trivial: 'haiku', default: 'sonnet', deep: 'opus' },
    });

    await collect(loop.run('hi', { personalityId: 'tiered' }));

    expect(onComplete).toHaveBeenCalled();
    const opts = onComplete.mock.calls[0]?.[0];
    expect(opts?.modelOverride).toBe('sonnet');
  });

  it('falls back to llm.model when personality provider does not match', async () => {
    const onComplete = vi.fn();
    const llm = makeMockLLM(onComplete);
    const loop = new AgentLoop({ llm, safety: createTestSafety() });

    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define({
      id: 'tiered',
      name: 'Tiered',
      provider: 'anthropic',
      model: { trivial: 'haiku', default: 'sonnet', deep: 'opus' },
    });

    await collect(loop.run('hi', { personalityId: 'tiered' }));

    const opts = onComplete.mock.calls[0]?.[0];
    expect(opts?.modelOverride).toBeUndefined();
  });

  it('falls back to llm.model when personality has plain string model', async () => {
    const onComplete = vi.fn();
    const llm = makeMockLLM(onComplete);
    const loop = new AgentLoop({ llm, safety: createTestSafety() });

    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define({
      id: 'plain',
      name: 'Plain',
      model: 'some-model',
    });

    await collect(loop.run('hi', { personalityId: 'plain' }));

    const opts = onComplete.mock.calls[0]?.[0];
    expect(opts?.modelOverride).toBeUndefined();
  });

  it('tierOverride in RunOptions makes the turn use deep tier', async () => {
    const onComplete = vi.fn();
    const llm = makeMockLLM(onComplete);
    const loop = new AgentLoop({ llm, safety: createTestSafety() });

    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define({
      id: 'tiered',
      name: 'Tiered',
      provider: 'mock',
      model: { trivial: 'haiku', default: 'sonnet', deep: 'opus' },
    });

    await collect(loop.run('think hard', { personalityId: 'tiered', tierOverride: 'deep' }));

    const opts = onComplete.mock.calls[0]?.[0];
    expect(opts?.modelOverride).toBe('opus');
  });

  it('tierOverride "dreaming" uses the declared dreaming model (background maintenance turns)', async () => {
    const onComplete = vi.fn();
    const llm = makeMockLLM(onComplete);
    const loop = new AgentLoop({ llm, safety: createTestSafety() });

    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define({
      id: 'tiered',
      name: 'Tiered',
      provider: 'mock',
      model: { default: 'sonnet', dreaming: 'haiku' },
    });

    await collect(loop.run('consolidate', { personalityId: 'tiered', tierOverride: 'dreaming' }));

    const opts = onComplete.mock.calls[0]?.[0];
    expect(opts?.modelOverride).toBe('haiku');
  });

  it('tierOverride is per-run (second run without it uses default)', async () => {
    const onComplete = vi.fn();
    const llm = makeMockLLM(onComplete);
    const loop = new AgentLoop({ llm, safety: createTestSafety() });

    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define({
      id: 'tiered',
      name: 'Tiered',
      provider: 'mock',
      model: { trivial: 'haiku', default: 'sonnet', deep: 'opus' },
    });

    await collect(loop.run('first', { personalityId: 'tiered', tierOverride: 'deep' }));
    await collect(loop.run('second', { personalityId: 'tiered' }));

    const firstOpts = onComplete.mock.calls[0]?.[0];
    const secondOpts = onComplete.mock.calls[1]?.[0];
    expect(firstOpts?.modelOverride).toBe('opus');
    expect(secondOpts?.modelOverride).toBe('sonnet');
  });

  it('modelRouting override takes precedence over tier config', async () => {
    const onComplete = vi.fn();
    const llm = makeMockLLM(onComplete);
    const loop = new AgentLoop({
      llm,
      safety: createTestSafety(),
      modelRouting: { tiered: 'override-model' },
    });

    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define({
      id: 'tiered',
      name: 'Tiered',
      provider: 'mock',
      model: { trivial: 'haiku', default: 'sonnet', deep: 'opus' },
    });

    await collect(loop.run('hi', { personalityId: 'tiered' }));

    const opts = onComplete.mock.calls[0]?.[0];
    expect(opts?.modelOverride).toBe('override-model');
  });

  it('emits run_start with correct model from tier config', async () => {
    const llm = makeMockLLM();
    const loop = new AgentLoop({ llm, safety: createTestSafety() });

    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define({
      id: 'tiered',
      name: 'Tiered',
      provider: 'mock',
      model: { trivial: 'haiku', default: 'sonnet', deep: 'opus' },
    });

    const events = await collect(loop.run('hi', { personalityId: 'tiered' }));
    const runStart = events.find((e) => e.type === 'run_start') as Extract<
      AgentEvent,
      { type: 'run_start' }
    >;

    expect(runStart).toBeDefined();
    expect(runStart.model).toBe('sonnet');
    expect(runStart.source).toBe('personality');
  });
});
