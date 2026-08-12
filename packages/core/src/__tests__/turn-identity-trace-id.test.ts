// B3 — one turn identity.
//
// The turn's observability `traceId` is the single id that names a turn. These
// tests pin that it LEAVES the loop: `run_start` opens the turn under it and
// `done` closes the turn under it, and both carry the SAME id `startTurnTrace`
// minted — not a second id that merely looks like one.
//
// The field is additive-optional on two existing AgentEvent variants (no new
// variant, so `KNOWN_AGENT_EVENT_TYPES` is untouched), which is why the
// no-observability case must still emit both events, just without the id.

import type { AgentEvent, CompletionChunk, LLMProvider, ToolResult } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import type { AgentLoopObservability } from '../observability/agent-loop-observability';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

interface TraceRecorder {
  observability: AgentLoopObservability;
  /** Ids handed back by `startTurnTrace`, in turn order. */
  minted: string[];
  /** `traceId` every span was filed under. */
  spanTraceIds: string[];
}

function makeTraceRecorder(): TraceRecorder {
  const minted: string[] = [];
  const spanTraceIds: string[] = [];
  let spanSeq = 0;
  const observability: AgentLoopObservability = {
    startTurnTrace: () => {
      const id = `trace-${minted.length + 1}`;
      minted.push(id);
      return id;
    },
    endTrace: () => {},
    startSpan: (opts) => {
      spanTraceIds.push(opts.traceId);
      return `span-${++spanSeq}`;
    },
    endSpan: () => {},
    recordSafetyBlock: () => {},
    recordCompaction: () => {},
    recordTierEscalation: () => {},
    recordTierOverride: () => {},
    flush: () => {},
  };
  return { observability, minted, spanTraceIds };
}

/** Plain text, one round. */
function textLLM(): LLMProvider {
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      yield { type: 'text_delta', text: 'hi' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

/** One tool call, then plain text — exercises the multi-iteration path. */
function toolThenTextLLM(): LLMProvider {
  let calls = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      calls++;
      if (calls === 1) {
        yield { type: 'tool_use_start', toolCallId: 'c1', toolName: 'echo' };
        yield { type: 'tool_use_end', toolCallId: 'c1', inputJson: '{}' };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

function echoTools(): DefaultToolRegistry {
  const tools = new DefaultToolRegistry();
  tools.register({
    name: 'echo',
    description: 'echoes',
    schema: { type: 'object' },
    capabilities: {},
    async execute(): Promise<ToolResult> {
      return { ok: true, value: 'echoed' };
    },
  });
  return tools;
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function runStartOf(events: AgentEvent[]): Extract<AgentEvent, { type: 'run_start' }> {
  const e = events.find((x) => x.type === 'run_start');
  if (e?.type !== 'run_start') throw new Error('no run_start event');
  return e;
}

function doneOf(events: AgentEvent[]): Extract<AgentEvent, { type: 'done' }> {
  const e = events.find((x) => x.type === 'done');
  if (e?.type !== 'done') throw new Error('no done event');
  return e;
}

describe('turn identity — traceId on run_start / done (B3)', () => {
  it('run_start and done carry the SAME id startTurnTrace minted for the turn', async () => {
    const recorder = makeTraceRecorder();
    const loop = new AgentLoop({
      llm: textLLM(),
      tools: new DefaultToolRegistry(),
      session: new InMemorySessionStore(),
      safety: createTestSafety(),
      observability: recorder.observability,
    });

    const events = await collect(loop.run('go', { sessionKey: 'cli:identity' }));

    const turnTraceId = recorder.minted[0];
    expect(turnTraceId).toBe('trace-1');
    // The turn's spans hang off this id, so it IS the observability.db row.
    expect(new Set(recorder.spanTraceIds)).toEqual(new Set([turnTraceId]));

    expect(runStartOf(events).traceId).toBe(turnTraceId);
    expect(doneOf(events).traceId).toBe(turnTraceId);
  });

  it('holds across a tool-using turn, and partitions per turn', async () => {
    const recorder = makeTraceRecorder();
    const loop = new AgentLoop({
      llm: toolThenTextLLM(),
      tools: echoTools(),
      session: new InMemorySessionStore(),
      safety: createTestSafety(),
      observability: recorder.observability,
    });

    const first = await collect(loop.run('one', { sessionKey: 'cli:two-turns' }));
    const second = await collect(loop.run('two', { sessionKey: 'cli:two-turns' }));

    expect(recorder.minted).toEqual(['trace-1', 'trace-2']);
    expect(runStartOf(first).traceId).toBe('trace-1');
    expect(doneOf(first).traceId).toBe('trace-1');
    expect(runStartOf(second).traceId).toBe('trace-2');
    expect(doneOf(second).traceId).toBe('trace-2');
  });

  it('omits traceId (but still emits both events) when no observability is wired', async () => {
    const loop = new AgentLoop({
      llm: textLLM(),
      tools: new DefaultToolRegistry(),
      session: new InMemorySessionStore(),
      safety: createTestSafety(),
    });

    const events = await collect(loop.run('go', { sessionKey: 'cli:no-obs' }));

    expect(runStartOf(events).traceId).toBeUndefined();
    expect(doneOf(events).traceId).toBeUndefined();
  });

  it('is additive-optional: no new AgentEvent variant was introduced', async () => {
    const recorder = makeTraceRecorder();
    const loop = new AgentLoop({
      llm: textLLM(),
      tools: new DefaultToolRegistry(),
      session: new InMemorySessionStore(),
      safety: createTestSafety(),
      observability: recorder.observability,
    });

    const events = await collect(loop.run('go', { sessionKey: 'cli:variants' }));
    // `traceId` rides variants that already existed; the drift gate in
    // packages/types (`agent-event-drift.test.ts`) owns the variant list.
    expect(events.some((e) => e.type === 'run_start')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });
});
