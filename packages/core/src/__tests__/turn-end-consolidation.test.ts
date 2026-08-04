// Phase 3 — turn-end memory flush + auto-compaction + overflow-retry.
// Drives AgentLoop.run() end-to-end (and runMemoryFlush directly) to assert the
// hard constraints: flush is silent (zero user-visible events), non-persisted,
// restricted to memory tools, abortable, and cooldown/trivial-delta gated;
// auto-compaction fires at turn END (after `done`), never mid-task; and a
// context-overflow rejection becomes a compact-and-retry.

import type {
  CompletionChunk,
  LLMProvider,
  Message,
  Tool,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { isContextOverflowError } from '../agent-loop/overflow';
import { runMemoryFlush } from '../agent-loop/turn-end';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

const zeroUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCostUsd: 0,
  apiCallCount: 0,
  compactionCount: 0,
};

interface CompleteCall {
  messages: Message[];
  tools: ToolDefinitionLite[];
  system: string | undefined;
}

/** LLM whose per-call behaviour is supplied by `respond`. */
function makeLLM(
  respond: (
    call: CompleteCall,
    index: number,
  ) => { chunks: CompletionChunk[]; throwOverflow?: boolean; throwError?: Error },
  log: CompleteCall[] = [],
): LLMProvider {
  let index = 0;
  return {
    name: 'mock',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      messages: Message[],
      tools: ToolDefinitionLite[],
      options?: { system?: string },
    ): AsyncIterable<CompletionChunk> {
      // Snapshot the array (it is mutated in place across iterations/retries).
      const call: CompleteCall = { messages: messages.slice(), tools, system: options?.system };
      log.push(call);
      const plan = respond(call, index++);
      if (plan.throwOverflow) throw new Error('400 invalid_request_error: prompt is too long');
      if (plan.throwError) throw plan.throwError;
      for (const c of plan.chunks) yield c;
    },
    async countTokens() {
      return 10;
    },
  };
}

function usageChunk(inputTokens: number): CompletionChunk {
  return {
    type: 'usage',
    usage: {
      inputTokens,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: 0,
    },
  };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

function isFlushCall(call: CompleteCall): boolean {
  return call.system?.includes('silent background memory maintenance') ?? false;
}

/** A recording memory_write tool + a memory_read stub, plus a decoy file tool. */
function memoryRegistry(writes: Array<Record<string, unknown>>): DefaultToolRegistry {
  const reg = new DefaultToolRegistry();
  const memWrite: Tool = {
    name: 'memory_write',
    description: 'write memory',
    toolset: 'memory',
    capabilities: {},
    schema: { type: 'object', properties: {} },
    async execute(args) {
      writes.push(args as Record<string, unknown>);
      return { ok: true, value: 'ok' };
    },
  };
  const memRead: Tool = {
    name: 'memory_read',
    description: 'read memory',
    toolset: 'memory',
    capabilities: {},
    schema: { type: 'object', properties: {} },
    async execute() {
      return { ok: true, value: 'MEMORY.md is empty.' };
    },
  };
  const decoy: Tool = {
    name: 'read_file',
    description: 'read a file',
    toolset: 'file',
    capabilities: {},
    schema: { type: 'object', properties: {} },
    async execute() {
      return { ok: true, value: 'decoy' };
    },
  };
  reg.register(memWrite);
  reg.register(memRead);
  reg.register(decoy);
  return reg;
}

async function seedShortSession(session: InMemorySessionStore, key: string, pairs: number) {
  const s = await session.createSession({
    key,
    platform: 'cli',
    model: 'mock-model',
    provider: 'mock',
    usage: { ...zeroUsage },
  });
  for (let i = 0; i < pairs; i++) {
    await session.appendMessage({ sessionId: s.id, role: 'user', content: `q${i}` });
    await session.appendMessage({ sessionId: s.id, role: 'assistant', content: `a${i}` });
  }
  return s;
}

// ---------------------------------------------------------------------------
// Auto-compaction at turn END
// ---------------------------------------------------------------------------

describe('Phase 3 — auto-compaction fires at turn end, never mid-task', () => {
  it('crosses 80% on the just-finished turn → compacts AFTER `done` with a notice', async () => {
    const session = new InMemorySessionStore();
    const s = await seedShortSession(session, 'cli:auto', 8);
    // Small content (pre-LLM estimate stays under the gate) but this turn's
    // ACTUAL input jumps past 80% of 200k (~156k) → the turn-end trigger fires.
    const llm = makeLLM(() => ({
      chunks: [
        { type: 'text_delta', text: 'ok' },
        usageChunk(170_000),
        { type: 'done', finishReason: 'end_turn' },
      ],
    }));
    const loop = new AgentLoop({
      llm,
      session,
      safety: createTestSafety(),
      compaction: { autoCompact: true },
    });

    const events = await collect(loop.run('next', { sessionKey: 'cli:auto' }));
    const doneIdx = events.findIndex((e) => e.type === 'done');
    const noticeIdx = events.findIndex(
      (e) => e.type === 'tool_progress' && e.toolName === '_compaction',
    );
    expect(doneIdx).toBeGreaterThanOrEqual(0);
    expect(noticeIdx).toBeGreaterThan(doneIdx); // notice comes AFTER done — never mid-task
    const notice = events[noticeIdx];
    expect(notice?.type === 'tool_progress' && notice.audience).toBe('user');

    const wm = await session.listCompressions(s.id);
    expect(wm.at(-1)?.keptFromMessageId).toBeTruthy();
  });

  it('fires by default — autoCompact undefined means ON (context-economy Phase 2 flip)', async () => {
    const session = new InMemorySessionStore();
    const s = await seedShortSession(session, 'cli:default-on', 8);
    const llm = makeLLM(() => ({
      chunks: [
        { type: 'text_delta', text: 'ok' },
        usageChunk(170_000),
        { type: 'done', finishReason: 'end_turn' },
      ],
    }));
    // No compaction config at all — the default must be ON.
    const loop = new AgentLoop({ llm, session, safety: createTestSafety() });
    const events = await collect(loop.run('next', { sessionKey: 'cli:default-on' }));
    expect(events.some((e) => e.type === 'tool_progress' && e.toolName === '_compaction')).toBe(
      true,
    );
    const wm = await session.listCompressions(s.id);
    expect(wm.length).toBeGreaterThan(0);
  });

  it('does nothing at turn end when autoCompact is explicitly false', async () => {
    const session = new InMemorySessionStore();
    const s = await seedShortSession(session, 'cli:off', 8);
    const log: CompleteCall[] = [];
    const llm = makeLLM(
      () => ({
        chunks: [
          { type: 'text_delta', text: 'ok' },
          usageChunk(170_000),
          { type: 'done', finishReason: 'end_turn' },
        ],
      }),
      log,
    );
    const loop = new AgentLoop({
      llm,
      session,
      safety: createTestSafety(),
      compaction: { autoCompact: false },
    });
    const events = await collect(loop.run('next', { sessionKey: 'cli:off' }));
    expect(events.some((e) => e.type === 'tool_progress' && e.toolName === '_compaction')).toBe(
      false,
    );
    expect(await session.listCompressions(s.id)).toHaveLength(0);
    // Pin the LLM call count: exactly the one main-turn call, no turn-end flush.
    // A truthy-coercion bug that ran an extra flush pass would make this fail.
    expect(log).toHaveLength(1);
    expect(log.some(isFlushCall)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Silent memory flush
// ---------------------------------------------------------------------------

describe('Phase 3 — silent memory flush through run()', () => {
  it('produces ZERO user-visible events and does NOT persist to session history', async () => {
    const session = new InMemorySessionStore();
    const s = await seedShortSession(session, 'cli:flush', 3);
    const before = (await session.getMessages(s.id)).length;
    const writes: Array<Record<string, unknown>> = [];

    const llm = makeLLM((call) => {
      if (isFlushCall(call)) {
        // First flush iteration writes; subsequent iterations end (text only).
        const wrote = call.messages.some(
          (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'),
        );
        if (wrote)
          return {
            chunks: [
              { type: 'text_delta', text: 'done' },
              { type: 'done', finishReason: 'end_turn' },
            ],
          };
        const json = '{"store":"memory","action":"add","content":"fact"}';
        return {
          chunks: [
            { type: 'tool_use_start', toolCallId: 'w1', toolName: 'memory_write' },
            { type: 'tool_use_delta', toolCallId: 'w1', partialJson: json },
            { type: 'tool_use_end', toolCallId: 'w1', inputJson: json },
            { type: 'done', finishReason: 'tool_use' },
          ],
        };
      }
      return {
        chunks: [
          { type: 'text_delta', text: 'main-reply' },
          usageChunk(1_000),
          { type: 'done', finishReason: 'end_turn' },
        ],
      };
    });

    const loop = new AgentLoop({
      llm,
      session,
      tools: memoryRegistry(writes),
      safety: createTestSafety(),
      memoryConsolidation: { enabled: true, flushThreshold: 0.001, minMessagesSinceFlush: 0 },
    });

    const events = await collect(loop.run('hello', { sessionKey: 'cli:flush' }));

    // The flush actually ran (a memory_write landed)…
    expect(writes).toHaveLength(1);
    // …yet produced NO user-visible events: no memory_write tool chips, no flush text.
    expect(events.some((e) => e.type === 'tool_start' && e.toolName === 'memory_write')).toBe(
      false,
    );
    expect(events.some((e) => e.type === 'tool_end' && e.toolName === 'memory_write')).toBe(false);
    expect(events.some((e) => e.type === 'text_delta' && e.text.includes('done'))).toBe(false);
    expect(events.some((e) => e.type === 'tool_progress' && e.toolName === '_compaction')).toBe(
      false,
    );

    // The flush wrote NOTHING to session history — only the main turn's 2 rows.
    const after = (await session.getMessages(s.id)).length;
    expect(after).toBe(before + 2);
  });

  it('restricts the flush toolset to the memory tools only', async () => {
    const session = new InMemorySessionStore();
    await seedShortSession(session, 'cli:restrict', 3);
    const writes: Array<Record<string, unknown>> = [];
    const log: CompleteCall[] = [];
    const llm = makeLLM((call) => {
      if (isFlushCall(call)) {
        return {
          chunks: [
            { type: 'text_delta', text: 'nothing to save' },
            { type: 'done', finishReason: 'end_turn' },
          ],
        };
      }
      return {
        chunks: [
          { type: 'text_delta', text: 'ok' },
          usageChunk(1_000),
          { type: 'done', finishReason: 'end_turn' },
        ],
      };
    }, log);

    const loop = new AgentLoop({
      llm,
      session,
      tools: memoryRegistry(writes),
      safety: createTestSafety(),
      memoryConsolidation: { enabled: true, flushThreshold: 0.001, minMessagesSinceFlush: 0 },
    });
    await collect(loop.run('hi', { sessionKey: 'cli:restrict' }));

    const flushCall = log.find(isFlushCall);
    expect(flushCall).toBeDefined();
    const names = (flushCall?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(['memory_read', 'memory_write']); // decoy read_file excluded
  });

  it('fails open when the flush LLM call throws a non-overflow error', async () => {
    const session = new InMemorySessionStore();
    await seedShortSession(session, 'cli:failopen', 3);
    const writes: Array<Record<string, unknown>> = [];
    const llm = makeLLM((call) => {
      if (isFlushCall(call)) return { chunks: [], throwError: new Error('rate limit exceeded') };
      return {
        chunks: [
          { type: 'text_delta', text: 'ok' },
          usageChunk(1_000),
          { type: 'done', finishReason: 'end_turn' },
        ],
      };
    });
    const obs: Array<{ code?: string }> = [];
    const observability = {
      startTurnTrace: () => 'tr',
      endTrace: () => {},
      startSpan: () => 'sp',
      endSpan: () => {},
      recordSafetyBlock: () => {},
      recordCompaction: (e: { code?: string }) => obs.push({ code: e.code }),
      recordTierEscalation: () => {},
      recordTierOverride: () => {},
      flush: () => {},
    } as unknown as ConstructorParameters<typeof AgentLoop>[0]['observability'];

    const loop = new AgentLoop({
      llm,
      session,
      tools: memoryRegistry(writes),
      safety: createTestSafety(),
      observability,
      memoryConsolidation: { enabled: true, flushThreshold: 0.001, minMessagesSinceFlush: 0 },
    });

    const events = await collect(loop.run('hi', { sessionKey: 'cli:failopen' }));
    // The turn still completes cleanly — no error event surfaces from the flush.
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    // …and the failure is observable.
    expect(obs.some((e) => e.code === 'memory_flush_failed')).toBe(true);
    expect(writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runMemoryFlush unit — abort, delta cap, non-persistence, trivial-delta
// ---------------------------------------------------------------------------

describe('Phase 3 — runMemoryFlush hard constraints', () => {
  function flushDeps(llm: LLMProvider, writes: Array<Record<string, unknown>>) {
    return {
      llm,
      tools: memoryRegistry(writes),
      session: new InMemorySessionStore(),
      historyLimit: 200,
      platform: 'cli',
      workingDir: '/tmp',
      memoryConsolidation: { enabled: true },
    } as unknown as Parameters<typeof runMemoryFlush>[0];
  }

  const ctx = {
    sessionId: 's1',
    sessionKey: 'cli:s1',
    personality: { id: 'p', name: 'P' },
    turnNumber: 1,
    lastCompactionTurn: 0,
    memScopeId: 'personality:p',
    userScopeId: undefined,
    filterOpts: {},
    compactedThisTurn: false,
    abortSignal: new AbortController().signal,
  } as unknown as Parameters<typeof runMemoryFlush>[1];

  it('an already-aborted signal aborts the flush before any write', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const controller = new AbortController();
    controller.abort();
    const llm = makeLLM(() => ({
      chunks: [
        { type: 'text_delta', text: 'x' },
        { type: 'done', finishReason: 'end_turn' },
      ],
    }));
    const res = await runMemoryFlush(
      flushDeps(llm, writes),
      { ...ctx, abortSignal: controller.signal },
      [{ role: 'user', content: 'hi' }],
      20,
    );
    expect(res.flushed).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('caps the per-flush memory delta', async () => {
    const writes: Array<Record<string, unknown>> = [];
    // Every flush iteration emits one big write; the delta cap should stop the
    // second one.
    const llm = makeLLM((call) => {
      if (!isFlushCall(call)) return { chunks: [{ type: 'done', finishReason: 'end_turn' }] };
      const json = JSON.stringify({ store: 'memory', action: 'add', content: 'y'.repeat(50) });
      return {
        chunks: [
          { type: 'tool_use_start', toolCallId: 'w', toolName: 'memory_write' },
          { type: 'tool_use_delta', toolCallId: 'w', partialJson: json },
          { type: 'tool_use_end', toolCallId: 'w', inputJson: json },
          { type: 'done', finishReason: 'tool_use' },
        ],
      };
    });
    const deps = flushDeps(llm, writes);
    (deps as { memoryConsolidation: Record<string, unknown> }).memoryConsolidation = {
      enabled: true,
      maxDeltaChars: 60,
    };
    const res = await runMemoryFlush(deps, ctx, [{ role: 'user', content: 'hi' }], 20);
    // First 50-char write lands; the second would exceed the 60-char cap → rejected.
    expect(writes).toHaveLength(1);
    expect(res.deltaChars).toBe(50);
  });

  it('skips when the message delta since the last flush is trivial', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const llm = makeLLM(() => ({ chunks: [{ type: 'done', finishReason: 'end_turn' }] }));
    const deps = flushDeps(llm, writes);
    (deps as { memoryConsolidation: Record<string, unknown> }).memoryConsolidation = {
      enabled: true,
      minMessagesSinceFlush: 100,
    };
    // No storage wired → last flush count is 0; 20 < 100 → trivial → skip.
    const res = await runMemoryFlush(deps, ctx, [{ role: 'user', content: 'hi' }], 20);
    expect(res.flushed).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('skips entirely for a personality whose toolset excludes memory tools', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const log: CompleteCall[] = [];
    // This LLM would happily write if ever driven — the flush must not run it.
    const llm = makeLLM(() => {
      const json = '{"store":"memory","action":"add","content":"fact"}';
      return {
        chunks: [
          { type: 'tool_use_start', toolCallId: 'w1', toolName: 'memory_write' },
          { type: 'tool_use_delta', toolCallId: 'w1', partialJson: json },
          { type: 'tool_use_end', toolCallId: 'w1', inputJson: json },
          { type: 'done', finishReason: 'tool_use' },
        ],
      };
    }, log);
    const deps = flushDeps(llm, writes);
    (deps as { memoryConsolidation: Record<string, unknown> }).memoryConsolidation = {
      enabled: true,
      minMessagesSinceFlush: 0,
    };
    // FLUSH_TOOLSET ∩ ['read_file'] === [] → opt-out → no flush, no LLM call.
    const readOnlyCtx = {
      ...(ctx as object),
      personality: { id: 'p', name: 'P', toolset: ['read_file'] },
    } as unknown as Parameters<typeof runMemoryFlush>[1];
    const res = await runMemoryFlush(deps, readOnlyCtx, [{ role: 'user', content: 'hi' }], 20);
    expect(res.flushed).toBe(false);
    expect(writes).toHaveLength(0);
    expect(log).toHaveLength(0); // the flush LLM never ran
  });

  it('hard-timeboxes a stuck flush and resolves without writing', async () => {
    const writes: Array<Record<string, unknown>> = [];
    // A provider whose completion never yields — it only settles when the abort
    // signal (here, the internal timebox deadline) fires.
    const stuckLLM: LLMProvider = {
      name: 'stuck',
      model: 'stuck-model',
      maxContextTokens: 200_000,
      supportsCaching: false,
      supportsThinking: false,
      async *complete(_m, _t, options): AsyncIterable<CompletionChunk> {
        await new Promise<void>((_resolve, reject) => {
          options?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
        yield { type: 'done', finishReason: 'end_turn' }; // unreachable
      },
      async countTokens() {
        return 10;
      },
    };
    const deps = flushDeps(stuckLLM, writes);
    (deps as { memoryConsolidation: Record<string, unknown> }).memoryConsolidation = {
      enabled: true,
      minMessagesSinceFlush: 0,
      timeboxMs: 10,
    };
    const res = await runMemoryFlush(deps, ctx, [{ role: 'user', content: 'hi' }], 20);
    expect(res.flushed).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('aborts mid-flush between iterations after a write already landed', async () => {
    const controller = new AbortController();
    const writes: Array<Record<string, unknown>> = [];
    // memory_write records the write and then trips the run's abort signal — the
    // next flush iteration must hit the `if (signal.aborted) break` guard.
    const reg = new DefaultToolRegistry();
    reg.register({
      name: 'memory_write',
      description: 'write memory',
      toolset: 'memory',
      capabilities: {},
      schema: { type: 'object', properties: {} },
      async execute(args) {
        writes.push(args as Record<string, unknown>);
        controller.abort();
        return { ok: true, value: 'ok' };
      },
    });
    reg.register({
      name: 'memory_read',
      description: 'read memory',
      toolset: 'memory',
      capabilities: {},
      schema: { type: 'object', properties: {} },
      async execute() {
        return { ok: true, value: 'empty' };
      },
    });
    // Every flush iteration would emit another write if allowed to continue.
    const llm = makeLLM((call) => {
      if (!isFlushCall(call)) return { chunks: [{ type: 'done', finishReason: 'end_turn' }] };
      const json = '{"store":"memory","action":"add","content":"fact"}';
      return {
        chunks: [
          { type: 'tool_use_start', toolCallId: 'w', toolName: 'memory_write' },
          { type: 'tool_use_delta', toolCallId: 'w', partialJson: json },
          { type: 'tool_use_end', toolCallId: 'w', inputJson: json },
          { type: 'done', finishReason: 'tool_use' },
        ],
      };
    });
    const deps = {
      llm,
      tools: reg,
      session: new InMemorySessionStore(),
      historyLimit: 200,
      platform: 'cli',
      workingDir: '/tmp',
      memoryConsolidation: { enabled: true, minMessagesSinceFlush: 0 },
    } as unknown as Parameters<typeof runMemoryFlush>[0];
    const res = await runMemoryFlush(
      deps,
      { ...(ctx as object), abortSignal: controller.signal } as unknown as Parameters<
        typeof runMemoryFlush
      >[1],
      [{ role: 'user', content: 'hi' }],
      20,
    );
    // Exactly one write landed; the second iteration's abort guard terminated it.
    expect(writes).toHaveLength(1);
    expect(res.deltaChars).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Overflow → compact-and-retry
// ---------------------------------------------------------------------------

describe('Phase 3 — context-overflow becomes compact-and-retry', () => {
  async function seedBigSession(session: InMemorySessionStore, key: string) {
    const s = await session.createSession({
      key,
      platform: 'cli',
      model: 'mock-model',
      provider: 'mock',
      usage: { ...zeroUsage },
    });
    const big = 'x'.repeat(300_000);
    for (let i = 0; i < 4; i++) {
      await session.appendMessage({ sessionId: s.id, role: 'user', content: `turn ${i} ${big}` });
      await session.appendMessage({ sessionId: s.id, role: 'assistant', content: `reply ${i}` });
    }
    return s;
  }

  it('a rejected (too-long) request compacts the in-memory history and retries', async () => {
    const session = new InMemorySessionStore();
    await seedBigSession(session, 'cli:retry');
    const log: CompleteCall[] = [];
    const llm = makeLLM(
      (_call, index) =>
        index === 0
          ? { chunks: [], throwOverflow: true }
          : {
              chunks: [
                { type: 'text_delta', text: 'recovered' },
                usageChunk(10),
                { type: 'done', finishReason: 'end_turn' },
              ],
            },
      log,
    );
    const loop = new AgentLoop({ llm, session, safety: createTestSafety() });

    const events = await collect(loop.run('go', { sessionKey: 'cli:retry' }));
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const done = events.find((e) => e.type === 'done');
    expect(done?.type === 'done' && done.text).toBe('recovered');
    // The retry shipped a strictly shorter history than the rejected request.
    expect(log.length).toBeGreaterThanOrEqual(2);
    const first = log[0]?.messages.length ?? 0;
    const second = log[1]?.messages.length ?? 0;
    expect(second).toBeLessThan(first);
  });

  it('terminates (does not loop) when BOTH the initial call and the retry overflow', async () => {
    const session = new InMemorySessionStore();
    await seedBigSession(session, 'cli:double');
    const log: CompleteCall[] = [];
    // Overflow on call index 0 AND the retry (index 1) → the single-retry budget
    // is spent, so the loop must surface one error and stop, not spin forever.
    const llm = makeLLM(
      (_call, index) =>
        index <= 1
          ? { chunks: [], throwOverflow: true }
          : {
              chunks: [{ type: 'done', finishReason: 'end_turn' }],
            },
      log,
    );
    const loop = new AgentLoop({ llm, session, safety: createTestSafety() });

    const events = await collect(loop.run('go', { sessionKey: 'cli:double' }));
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.type === 'error' && errors[0].code).toBe('context_overflow');
    // Bounded call count: one initial + exactly one retry, then terminate.
    expect(log).toHaveLength(2);
  });

  it('surfaces a context_overflow error when retryOnOverflow is disabled', async () => {
    const session = new InMemorySessionStore();
    await seedBigSession(session, 'cli:noretry');
    const llm = makeLLM(() => ({ chunks: [], throwOverflow: true }));
    const loop = new AgentLoop({
      llm,
      session,
      safety: createTestSafety(),
      compaction: { retryOnOverflow: false },
    });
    const events = await collect(loop.run('go', { sessionKey: 'cli:noretry' }));
    const err = events.find((e) => e.type === 'error');
    expect(err?.type === 'error' && err.code).toBe('context_overflow');
  });
});

describe('Phase 3 — isContextOverflowError', () => {
  it('matches provider overflow signatures', () => {
    expect(isContextOverflowError(new Error('prompt is too long: 210000 tokens'))).toBe(true);
    expect(isContextOverflowError({ code: 'context_length_exceeded' })).toBe(true);
    expect(isContextOverflowError({ error: { type: 'context_length_exceeded' } })).toBe(true);
    expect(isContextOverflowError(new Error("This model's maximum context length is 200000"))).toBe(
      true,
    );
  });
  it('does not match unrelated errors', () => {
    expect(isContextOverflowError(new Error('rate limit exceeded'))).toBe(false);
    expect(isContextOverflowError(new Error('401 unauthorized'))).toBe(false);
    expect(isContextOverflowError(null)).toBe(false);
  });
  it('does not misclassify non-overflow errors that merely contain the bare phrases', () => {
    // A DB/validation "too long for column" must NOT trip the context-anchored
    // `too long for` alternation — otherwise emergencyCompact would silently drop
    // history on a non-overflow failure.
    expect(isContextOverflowError(new Error('value too long for column X'))).toBe(false);
    // Anthropic non-overflow 400.
    expect(
      isContextOverflowError({ type: 'invalid_request_error', message: "model 'X' not found" }),
    ).toBe(false);
  });
  it('still matches the anchored overflow phrasings', () => {
    expect(
      isContextOverflowError(
        new Error('This conversation is too long for the model context window'),
      ),
    ).toBe(true);
    expect(
      isContextOverflowError(new Error('Your request has too many tokens for this context')),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Item 7 — the absolute ceiling applies at the TURN-END gate too
// ---------------------------------------------------------------------------

describe('Item 7 — absolute ceiling at the turn-end gate', () => {
  /** A turn whose real input tokens land at `inputTokens`, on a 200k model. */
  function loopWith(
    session: InMemorySessionStore,
    compaction: { maxContextTokens?: number } | undefined,
    inputTokens: number,
  ) {
    const llm = makeLLM(() => ({
      chunks: [
        { type: 'text_delta', text: 'ok' },
        usageChunk(inputTokens),
        { type: 'done', finishReason: 'end_turn' },
      ],
    }));
    return new AgentLoop({
      llm,
      session,
      safety: createTestSafety(),
      ...(compaction ? { compaction } : {}),
    });
  }

  it('compacts at 25% pressure when the ceiling is below current usage', async () => {
    const session = new InMemorySessionStore();
    const s = await seedShortSession(session, 'cli:ceiling', 8);
    // 50k tokens against a 200k window is ~25% — the fractional gate (~157k)
    // does not fire. The 40k ceiling does.
    const loop = loopWith(session, { maxContextTokens: 40_000 }, 50_000);
    const events = await collect(loop.run('next', { sessionKey: 'cli:ceiling' }));
    expect(events.some((e) => e.type === 'tool_progress' && e.toolName === '_compaction')).toBe(
      true,
    );
    expect(await session.listCompressions(s.id)).toHaveLength(1);
  });

  it('leaves the identical turn alone with no ceiling configured', async () => {
    const session = new InMemorySessionStore();
    const s = await seedShortSession(session, 'cli:no-ceiling', 8);
    const loop = loopWith(session, undefined, 50_000);
    const events = await collect(loop.run('next', { sessionKey: 'cli:no-ceiling' }));
    expect(events.some((e) => e.type === 'tool_progress' && e.toolName === '_compaction')).toBe(
      false,
    );
    expect(await session.listCompressions(s.id)).toHaveLength(0);
  });

  it('does not double-compact when the ceiling sits above the fractional gate', async () => {
    const session = new InMemorySessionStore();
    const s = await seedShortSession(session, 'cli:high-ceiling', 8);
    // Ceiling 400k > the ~157k fractional gate; 50k usage trips neither.
    const loop = loopWith(session, { maxContextTokens: 400_000 }, 50_000);
    await collect(loop.run('next', { sessionKey: 'cli:high-ceiling' }));
    expect(await session.listCompressions(s.id)).toHaveLength(0);
  });
});
