// A1 — the session's token/cost columns existed but nothing ever incremented
// them, so `ethos usage` reported $0.00 forever. The loop now accumulates each
// LLM call's usage as its assistant message is persisted and flushes the total
// through `updateUsage`.
//
// Per analytics decision 9 the `messages` rows are authoritative and the
// session rollup is a derived display cache, so the binding invariant these
// tests pin is `rollup == SUM(messages)` — including on the paths where the
// turn dies before the finalizer runs.

import type {
  CompletionChunk,
  LLMProvider,
  Message,
  SessionUsage,
  TokenUsage,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { createTurnUsage, flushTurnUsage } from '../agent-loop/stages/turn-finalizer';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import type { AgentLoopObservability } from '../observability/agent-loop-observability';
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

/** Session store whose rollup write always fails — everything else is real. */
class RollupWriteFails extends InMemorySessionStore {
  override async updateUsage(): Promise<void> {
    throw new Error('sessions.db is locked');
  }
}

/** Session store that records the deltas handed to `updateUsage`. */
class RollupWriteRecords extends InMemorySessionStore {
  readonly deltas: Partial<SessionUsage>[] = [];
  override async updateUsage(_sessionId: string, delta: Partial<SessionUsage>): Promise<void> {
    this.deltas.push(delta);
  }
}

/** Minimal observability that records the `code` of every error it is handed. */
function makeErrorRecorder(): { observability: AgentLoopObservability; codes: string[] } {
  const codes: string[] = [];
  const observability: AgentLoopObservability = {
    startTurnTrace: () => 'trace-1',
    endTrace: () => {},
    startSpan: () => 'span-1',
    endSpan: () => {},
    recordError: (opts) => {
      if (opts.code) codes.push(opts.code);
    },
    recordSafetyBlock: () => {},
    recordCompaction: () => {},
    recordTierEscalation: () => {},
    recordTierOverride: () => {},
    flush: () => {},
  };
  return { observability, codes };
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

// A1a — the flush writes first and drains only on success, so a failed rollup
// write leaves the delta recoverable instead of silently dropping it, and the
// early exits still emit the error event they exist for.
describe('turn usage flush failure (A1a)', () => {
  it('keeps the delta in the accumulator when the rollup write fails', async () => {
    const usage = createTurnUsage();
    usage.inputTokens = 100;
    usage.outputTokens = 20;
    usage.cacheReadTokens = 5;
    usage.cacheCreationTokens = 7;
    usage.estimatedCostUsd = 0.0125;
    const { observability, codes } = makeErrorRecorder();

    await flushTurnUsage(new RollupWriteFails(), 'sess-1', usage, observability);

    // Nothing was written, so nothing may be drained — the delta is still here.
    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheCreationTokens: 7,
      estimatedCostUsd: 0.0125,
    });
    // Best-effort, but not silent.
    expect(codes).toEqual(['usage_rollup_flush_failed']);
  });

  it('drains only what it wrote, keeping usage that arrived mid-write', async () => {
    const session = new RollupWriteRecords();
    const usage = createTurnUsage();
    usage.inputTokens = 10;
    usage.estimatedCostUsd = 0.001;

    const pending = flushTurnUsage(session, 'sess-1', usage);
    usage.inputTokens += 4; // a stream step appended while the write was in flight
    await pending;

    expect(session.deltas).toEqual([
      {
        inputTokens: 10,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0.001,
      },
    ]);
    expect(usage.inputTokens).toBe(4);
    expect(usage.estimatedCostUsd).toBe(0);
  });

  it('still yields the early exit error event when the rollup write fails', async () => {
    const session = new RollupWriteFails();
    const { observability, codes } = makeErrorRecorder();
    // Call 0 persists an assistant message (so the accumulator is non-empty),
    // call 1 overflows — an unrecoverable overflow with retry off is one of the
    // five exits that flush and then yield their error.
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
        : { chunks: [], throwError: new Error('prompt is too long') },
    );
    const loop = new AgentLoop({
      llm,
      session,
      safety: createTestSafety(),
      observability,
      compaction: { retryOnOverflow: false },
    });

    const events = await drain(loop.run('go', { sessionKey: 'cli:flush-fails' }));

    expect(events.some((e) => e.type === 'error' && e.code === 'context_overflow')).toBe(true);
    expect(codes).toContain('usage_rollup_flush_failed');
  });
});
