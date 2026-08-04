import type { AgentEvent, CompletionChunk, LLMProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

interface LoopLLMOptions {
  /** How many tool-calling LLM calls to script before the model ends the turn. */
  toolCalls: number;
  /** Tool name for the 1-indexed call number. Default cycles 20 distinct names. */
  name?: (n: number) => string;
  /** Tool args for the 1-indexed call number. Default varies per call. */
  args?: (n: number) => unknown;
  /** `estimatedCostUsd` reported on every LLM call. Default 0. */
  costUsd?: number;
}

/** Distinct tool names the default script cycles through. */
const NAME_POOL = 20;

/**
 * Scripted provider that emits exactly one tool call per LLM round for the
 * first `toolCalls` rounds, then a plain text end_turn. No network, no timers.
 */
function makeToolLoopLLM(o: LoopLLMOptions): { llm: LLMProvider; calls: () => number } {
  let calls = 0;
  const llm: LLMProvider = {
    name: 'tool-loop',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      calls++;
      const n = calls;
      const usage: CompletionChunk = {
        type: 'usage',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: o.costUsd ?? 0,
        },
      };
      if (n > o.toolCalls) {
        yield { type: 'text_delta', text: 'finished' };
        yield usage;
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      const id = `call-${n}`;
      const toolName = o.name?.(n) ?? `tool_${n % NAME_POOL}`;
      const inputJson = JSON.stringify(o.args?.(n) ?? { n });
      yield { type: 'tool_use_start', toolCallId: id, toolName };
      yield { type: 'tool_use_delta', toolCallId: id, partialJson: inputJson };
      yield { type: 'tool_use_end', toolCallId: id, inputJson };
      yield usage;
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 1;
    },
  };
  return { llm, calls: () => calls };
}

function makeRegistry(names: string[]): DefaultToolRegistry {
  const tools = new DefaultToolRegistry();
  for (const name of names) {
    tools.register({
      name,
      description: `${name} tool`,
      schema: { type: 'object' },
      capabilities: {},
      execute: async () => ({ ok: true, value: 'ran' }),
    });
  }
  return tools;
}

/** The 20 names the default script cycles through, plus the repeat-loop name. */
const POOL_NAMES = Array.from({ length: NAME_POOL }, (_, i) => `tool_${i}`);

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

function haltsOf(events: AgentEvent[]): Extract<AgentEvent, { type: 'halt' }>[] {
  return events.filter((e): e is Extract<AgentEvent, { type: 'halt' }> => e.type === 'halt');
}

describe('iteration cap', () => {
  it('runs 400 tool-calling iterations in one turn without halting', async () => {
    const { llm, calls } = makeToolLoopLLM({ toolCalls: 400 });
    const loop = new AgentLoop({
      llm,
      tools: makeRegistry(POOL_NAMES),
      safety: createTestSafety(),
    });

    const events = await collect(loop.run('go', { sessionKey: 'deep-run' }));

    // 400 tool rounds + one final text round. On the pre-raise defaults
    // (maxIterations 50) this stops at 50.
    expect(calls()).toBe(401);
    expect(haltsOf(events)).toEqual([]);
    expect(events.find((e) => e.type === 'done')).toBeDefined();
  }, 60_000);

  it('still halts on 5 consecutive identical tool calls after the raise', async () => {
    const { llm, calls } = makeToolLoopLLM({
      toolCalls: 400,
      name: () => 'repeat_me',
      args: () => ({}),
    });
    const loop = new AgentLoop({
      llm,
      tools: makeRegistry(['repeat_me']),
      safety: createTestSafety(),
    });

    const events = await collect(loop.run('go', { sessionKey: 'streak' }));

    const halt = haltsOf(events)[0];
    expect(halt?.kind).toBe('budget');
    expect(halt?.rule).toBe('identical-streak');
    expect(halt?.toolName).toBe('repeat_me');
    expect(halt?.count).toBe(5);
    expect(calls()).toBe(5);
  });

  it('halts mid-turn in ONE run() when accumulated spend crosses budgetCapUsd', async () => {
    const personalities = new DefaultPersonalityRegistry();
    personalities.define({ id: 'capped', name: 'Capped', budgetCapUsd: 0.05 });

    // $0.02 per LLM call: 0.02, 0.04, 0.06 — the third call crosses the cap,
    // so the guard at the top of the fourth iteration must stop the turn.
    const { llm, calls } = makeToolLoopLLM({ toolCalls: 400, costUsd: 0.02 });
    const loop = new AgentLoop({
      llm,
      tools: makeRegistry(POOL_NAMES),
      personalities,
      safety: createTestSafety(),
    });

    const events = await collect(
      loop.run('go', { personalityId: 'capped', sessionKey: 'cost-cap' }),
    );

    const halt = haltsOf(events)[0];
    expect(halt?.kind).toBe('budget');
    expect(halt?.rule).toBe('cost-cap');
    expect(halt?.message).toMatch(/budget cap/);
    expect(calls()).toBe(3);
    // The pre-turn refusal is not what fired — this is a mid-turn stop.
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.find((e) => e.type === 'done')).toBeDefined();
  });

  it('does not halt on cost when the personality has no budgetCapUsd', async () => {
    const { llm, calls } = makeToolLoopLLM({ toolCalls: 10, costUsd: 0.02 });
    const loop = new AgentLoop({
      llm,
      tools: makeRegistry(POOL_NAMES),
      safety: createTestSafety(),
    });

    const events = await collect(loop.run('go', { sessionKey: 'no-cap-run' }));

    expect(haltsOf(events)).toEqual([]);
    expect(calls()).toBe(11);
    expect(loop.getSessionCost('no-cap-run')).toBeCloseTo(0.22, 6);
    expect(events.find((e) => e.type === 'done')).toBeDefined();
  });

  it('honours an explicit maxIterations override over the raised default', async () => {
    const { llm, calls } = makeToolLoopLLM({ toolCalls: 400 });
    const loop = new AgentLoop({
      llm,
      tools: makeRegistry(POOL_NAMES),
      safety: createTestSafety(),
      options: { maxIterations: 3 },
    });

    const events = await collect(loop.run('go', { sessionKey: 'explicit-cap' }));

    expect(calls()).toBe(3);
    expect(haltsOf(events)).toEqual([]);
    expect(events.find((e) => e.type === 'done')).toBeDefined();
  });
});
