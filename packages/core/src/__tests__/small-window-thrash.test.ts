// Lane 1 — a 500-iteration synthetic run (the shipped `maxIterations`
// default) on a 4,096-token window completes without compaction thrash: the
// run finishes, and the number of recorded compactions stays bounded instead
// of firing every iteration. Stubbed provider — no network, no timers.

import type { AgentEvent, CompletionChunk, LLMProvider, ToolResult } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

// 499 tool rounds + the final text round = exactly the shipped maxIterations
// default of 500 LLM iterations, all consumed.
const TOOL_ROUNDS = 499;
const NAME_POOL = 25; // ~20 calls per name — under the identical-call caps

function makeToolLoopLLM(): { llm: LLMProvider; calls: () => number } {
  let calls = 0;
  const llm: LLMProvider = {
    name: 'tool-loop',
    model: 'mock-model',
    maxContextTokens: 4_096,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      calls++;
      const n = calls;
      if (n > TOOL_ROUNDS) {
        yield { type: 'text_delta', text: 'finished' };
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      const id = `call-${n}`;
      const inputJson = JSON.stringify({ n });
      yield { type: 'tool_use_start', toolCallId: id, toolName: `tool_${n % NAME_POOL}` };
      yield { type: 'tool_use_delta', toolCallId: id, partialJson: inputJson };
      yield { type: 'tool_use_end', toolCallId: id, inputJson };
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 1;
    },
  };
  return { llm, calls: () => calls };
}

function makeRegistry(): DefaultToolRegistry {
  const tools = new DefaultToolRegistry();
  for (let i = 0; i < NAME_POOL; i++) {
    tools.register({
      name: `tool_${i}`,
      description: `tool_${i}`,
      schema: { type: 'object' },
      capabilities: {},
      async execute(): Promise<ToolResult> {
        return { ok: true, value: `output ${'x'.repeat(200)}` };
      },
    });
  }
  return tools;
}

describe('Lane 1 — small-window thrash guard', () => {
  it('completes a full 500-iteration run on a 4,096-token window with a bounded compaction count', async () => {
    const { llm, calls } = makeToolLoopLLM();
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({
      llm,
      tools: makeRegistry(),
      session,
      safety: createTestSafety(),
      // The knobs wiring would resolve for a 4,096-token window: scaled
      // result budget (Lane 1c) and its gate term (Lane 1a).
      compaction: { maxSingleToolResultTokens: 500 },
      options: {
        resultBudgetChars: 2_000,
        // Raised so the identical-call safety caps do not end the run early —
        // this test isolates compaction behaviour, not the call budgets.
        maxIdenticalToolCalls: 1_000,
      },
    });

    const events: AgentEvent[] = [];
    for await (const event of loop.run('go', { sessionKey: 'cli:thrash' })) events.push(event);

    // The run completed: all 499 tool rounds plus the final text round.
    expect(calls()).toBe(TOOL_ROUNDS + 1);
    expect(events.find((e) => e.type === 'done')).toBeDefined();
    expect(events.filter((e) => e.type === 'error')).toEqual([]);

    // Bounded compaction: pressure on a 4k window must not translate into a
    // compaction storm. The cooldown + watermark design keeps the count in
    // the single digits for a single turn; 10 is the generous ceiling.
    const stored = await session.getSessionByKey('cli:thrash');
    if (!stored) throw new Error('session missing');
    const compressions = await session.listCompressions(stored.id);
    expect(compressions.length).toBeLessThanOrEqual(10);
  }, 120_000);
});
