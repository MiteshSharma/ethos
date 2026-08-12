// A1 — the session's token/cost columns existed but nothing ever incremented
// them, so `ethos usage` reported $0.00 forever. The loop now accumulates each
// LLM call's usage as its assistant message is persisted and flushes the total
// through `updateUsage`.
//
// Per analytics decision 9 the `messages` rows are authoritative and the
// session rollup is a derived display cache, so the binding invariant these
// tests pin is `rollup == SUM(messages)` — including on the paths where the
// turn dies before the finalizer runs.

import type { CompletionChunk, LLMProvider, Message, TokenUsage } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { createTestSafety } from './helpers/test-safety';

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number;
}

const ZERO: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCostUsd: 0,
};

function usageChunk(u: Partial<TokenUsage>): CompletionChunk {
  return { type: 'usage', usage: { ...ZERO, ...u } };
}

/** LLM whose per-call chunk plan is supplied by `respond`. */
function makeLLM(
  respond: (index: number) => { chunks: CompletionChunk[]; throwError?: Error },
): LLMProvider {
  let index = 0;
  return {
    name: 'mock',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(_messages: Message[]): AsyncIterable<CompletionChunk> {
      const plan = respond(index++);
      for (const c of plan.chunks) yield c;
      if (plan.throwError) throw plan.throwError;
    },
    async countTokens() {
      return 10;
    },
  };
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

async function rollup(session: InMemorySessionStore, key: string): Promise<UsageTotals> {
  const s = await session.getSessionByKey(key);
  if (!s) throw new Error(`no session for ${key}`);
  return {
    inputTokens: s.usage.inputTokens,
    outputTokens: s.usage.outputTokens,
    cacheReadTokens: s.usage.cacheReadTokens,
    cacheCreationTokens: s.usage.cacheCreationTokens,
    estimatedCostUsd: s.usage.estimatedCostUsd,
  };
}

/** The authoritative number: what the `messages` rows actually say. */
async function messageSum(session: InMemorySessionStore, key: string): Promise<UsageTotals> {
  const s = await session.getSessionByKey(key);
  if (!s) throw new Error(`no session for ${key}`);
  const messages = await session.getMessages(s.id);
  return messages.reduce<UsageTotals>(
    (acc, m) => ({
      inputTokens: acc.inputTokens + (m.usage?.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (m.usage?.outputTokens ?? 0),
      cacheReadTokens: acc.cacheReadTokens + (m.usage?.cacheReadTokens ?? 0),
      cacheCreationTokens: acc.cacheCreationTokens + (m.usage?.cacheCreationTokens ?? 0),
      estimatedCostUsd: acc.estimatedCostUsd + (m.usage?.estimatedCostUsd ?? 0),
    }),
    { ...ZERO },
  );
}

describe('session usage rollups (A1)', () => {
  it('increments the session rollup columns per turn', async () => {
    const session = new InMemorySessionStore();
    const llm = makeLLM(() => ({
      chunks: [
        { type: 'text_delta', text: 'hi' },
        usageChunk({
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 5,
          cacheCreationTokens: 7,
          estimatedCostUsd: 0.0125,
        }),
        { type: 'done', finishReason: 'end_turn' },
      ],
    }));
    const loop = new AgentLoop({ llm, session, safety: createTestSafety() });

    await drain(loop.run('one', { sessionKey: 'cli:rollup' }));
    expect(await rollup(session, 'cli:rollup')).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheCreationTokens: 7,
      estimatedCostUsd: 0.0125,
    });

    // A second turn accumulates on top rather than replacing.
    await drain(loop.run('two', { sessionKey: 'cli:rollup' }));
    expect(await rollup(session, 'cli:rollup')).toEqual({
      inputTokens: 200,
      outputTokens: 40,
      cacheReadTokens: 10,
      cacheCreationTokens: 14,
      estimatedCostUsd: 0.025,
    });

    const s = await session.getSessionByKey('cli:rollup');
    expect(s?.usage.apiCallCount).toBe(2);
  });

  it('keeps rollup == SUM(messages) after a driven turn', async () => {
    const session = new InMemorySessionStore();
    const llm = makeLLM(() => ({
      chunks: [
        { type: 'text_delta', text: 'ok' },
        usageChunk({
          inputTokens: 41,
          outputTokens: 13,
          cacheReadTokens: 2,
          cacheCreationTokens: 3,
          estimatedCostUsd: 0.004,
        }),
        { type: 'done', finishReason: 'end_turn' },
      ],
    }));
    const loop = new AgentLoop({ llm, session, safety: createTestSafety() });

    await drain(loop.run('go', { sessionKey: 'cli:sum' }));

    expect(await rollup(session, 'cli:sum')).toEqual(await messageSum(session, 'cli:sum'));
  });

  it('keeps rollup == SUM(messages) across a multi-call turn', async () => {
    const session = new InMemorySessionStore();
    // Call 0 asks for a tool (no tool is registered, so it comes back as an
    // error tool_result) which forces a second LLM call in the same turn.
    const llm = makeLLM((i) =>
      i === 0
        ? {
            chunks: [
              { type: 'tool_use_start', toolCallId: 'c1', toolName: 'nope' },
              { type: 'tool_use_end', toolCallId: 'c1', inputJson: '{}' },
              usageChunk({ inputTokens: 30, outputTokens: 9, estimatedCostUsd: 0.001 }),
              { type: 'done', finishReason: 'tool_use' },
            ],
          }
        : {
            chunks: [
              { type: 'text_delta', text: 'done' },
              usageChunk({ inputTokens: 60, outputTokens: 4, estimatedCostUsd: 0.002 }),
              { type: 'done', finishReason: 'end_turn' },
            ],
          },
    );
    const loop = new AgentLoop({ llm, session, safety: createTestSafety() });

    await drain(loop.run('go', { sessionKey: 'cli:multi' }));

    const totals = await rollup(session, 'cli:multi');
    expect(totals).toEqual(await messageSum(session, 'cli:multi'));
    expect(totals.inputTokens).toBe(90);
    expect(totals.outputTokens).toBe(13);
    expect(totals.estimatedCostUsd).toBeCloseTo(0.003, 10);
  });

  it('keeps rollup == SUM(messages) when the turn dies before the finalizer', async () => {
    const session = new InMemorySessionStore();
    const llm = makeLLM((i) =>
      i === 0
        ? {
            chunks: [
              { type: 'tool_use_start', toolCallId: 'c1', toolName: 'nope' },
              { type: 'tool_use_end', toolCallId: 'c1', inputJson: '{}' },
              usageChunk({ inputTokens: 70, outputTokens: 11, estimatedCostUsd: 0.005 }),
              { type: 'done', finishReason: 'tool_use' },
            ],
          }
        : { chunks: [], throwError: new Error('502 upstream connection reset') },
    );
    const loop = new AgentLoop({ llm, session, safety: createTestSafety() });

    const events = await drain(loop.run('go', { sessionKey: 'cli:fatal' }));
    expect(events.some((e) => e.type === 'error')).toBe(true);

    const totals = await rollup(session, 'cli:fatal');
    expect(totals).toEqual(await messageSum(session, 'cli:fatal'));
    expect(totals.inputTokens).toBe(70);
  });
});
