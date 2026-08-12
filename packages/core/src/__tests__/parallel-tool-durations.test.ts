// A4 — per-tool durations used to be the batch wall clock: tool-processing
// took ONE `Date.now()` before `executeParallel` and subtracted it once the
// whole batch had settled, so a 0ms tool sharing a batch with a 200ms tool
// reported 200ms. Every duration consumer inherited the lie — the `tool_end`
// AgentEvent, the `tool_call` span, the `after_tool_call` hook and the plugin
// metric callback.
//
// The clock now lives where the call runs (`DefaultToolRegistry.executeParallel`
// times each call and returns its own `durationMs`), so these tests run a fast
// and a slow tool in ONE batch and assert the reported numbers are distinct and
// each matches its own tool. Against the pre-fix code both numbers are the
// batch's, and every assertion below that separates them fails.

import type {
  AfterToolCallPayload,
  AgentEvent,
  CompletionChunk,
  LLMProvider,
  ToolResult,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
import { DefaultHookRegistry } from '../hook-registry';
import type { AgentLoopObservability } from '../observability/agent-loop-observability';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

/**
 * Timing budget. `SLOW_MS` is what the slow tool sleeps; the two thresholds
 * sit far from BOTH true values so a loaded box cannot flip the result:
 * - the slow tool cannot report under `SLOW_FLOOR_MS` (a timer never fires
 *   early), so that assertion only tightens under load;
 * - the fast tool truly takes ~0ms, so `FAST_CEILING_MS` leaves 100ms of
 *   scheduling slack — while still being 100ms BELOW the batch duration the
 *   pre-fix code reported for it, which is what makes this a regression test.
 */
const SLOW_MS = 200;
const SLOW_FLOOR_MS = 150;
const FAST_CEILING_MS = 100;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One LLM round asking for `fast` and `slow` together, then a plain finish. */
function twoToolLLM(): LLMProvider {
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
        yield { type: 'tool_use_start', toolCallId: 'c-fast', toolName: 'fast' };
        yield { type: 'tool_use_end', toolCallId: 'c-fast', inputJson: '{}' };
        yield { type: 'tool_use_start', toolCallId: 'c-slow', toolName: 'slow' };
        yield { type: 'tool_use_end', toolCallId: 'c-slow', inputJson: '{}' };
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

/** `fast` returns immediately, `slow` after SLOW_MS. Both carry a pluginId so
 *  the `onToolMetric` callback (gated on plugin ownership) fires for them. */
function fastAndSlowTools(): DefaultToolRegistry {
  const tools = new DefaultToolRegistry();
  tools.register(
    {
      name: 'fast',
      description: 'returns immediately',
      schema: { type: 'object' },
      capabilities: {},
      async execute(): Promise<ToolResult> {
        return { ok: true, value: 'fast' };
      },
    },
    { pluginId: 'timing' },
  );
  tools.register(
    {
      name: 'slow',
      description: 'returns late',
      schema: { type: 'object' },
      capabilities: {},
      async execute(): Promise<ToolResult> {
        await sleep(SLOW_MS);
        return { ok: true, value: 'slow' };
      },
    },
    { pluginId: 'timing' },
  );
  return tools;
}

/** The tools are plugin-owned (so `onToolMetric` fires), and a plugin tool
 *  only executes for a personality that lists its plugin. */
function pluginPersonalities(): DefaultPersonalityRegistry {
  const personalities = new DefaultPersonalityRegistry();
  vi.spyOn(personalities, 'getDefault').mockReturnValue({
    id: 'default',
    name: 'Default',
    plugins: ['timing'],
  });
  return personalities;
}

interface SpanRecorder {
  observability: AgentLoopObservability;
  /** tool name → durationMs handed to `endSpan`, for `tool_call` spans only. */
  spanDurations: Map<string, number>;
}

function makeSpanRecorder(): SpanRecorder {
  const spanDurations = new Map<string, number>();
  const toolSpans = new Map<string, string>();
  let seq = 0;
  const observability: AgentLoopObservability = {
    startTurnTrace: () => 'trace-1',
    endTrace: () => {},
    startSpan: (opts) => {
      const id = `span-${++seq}`;
      if (opts.kind === 'tool_call') toolSpans.set(id, opts.name);
      return id;
    },
    endSpan: (spanId, _status, attrs) => {
      const name = toolSpans.get(spanId);
      const duration = attrs?.durationMs;
      if (name !== undefined && typeof duration === 'number') spanDurations.set(name, duration);
    },
    recordSafetyBlock: () => {},
    recordCompaction: () => {},
    recordTierEscalation: () => {},
    recordTierOverride: () => {},
    flush: () => {},
  };
  return { observability, spanDurations };
}

function toolEndDurations(events: AgentEvent[]): Map<string, number> {
  const byTool = new Map<string, number>();
  for (const e of events) {
    if (e.type === 'tool_end') byTool.set(e.toolName, e.durationMs);
  }
  return byTool;
}

describe('per-tool durations in a parallel batch (A4)', () => {
  it('reports each parallel tool its own duration, not the batch wall clock', async () => {
    const events: AgentEvent[] = [];
    const loop = new AgentLoop({
      llm: twoToolLLM(),
      tools: fastAndSlowTools(),
      personalities: pluginPersonalities(),
      safety: createTestSafety(),
    });
    for await (const e of loop.run('go', { sessionKey: 'cli:a4-events' })) events.push(e);

    const durations = toolEndDurations(events);
    const fast = durations.get('fast');
    const slow = durations.get('slow');
    expect(typeof fast).toBe('number');
    expect(typeof slow).toBe('number');
    // The regression: pre-fix both were the batch's wall clock, so `fast` sat
    // at or above SLOW_MS and this pair of bounds could not both hold.
    expect(slow ?? 0).toBeGreaterThanOrEqual(SLOW_FLOOR_MS);
    expect(fast ?? Number.POSITIVE_INFINITY).toBeLessThan(FAST_CEILING_MS);
    expect(fast ?? 0).toBeLessThan(slow ?? 0);
  });

  it('gives the span, the after_tool_call hook and the plugin metric the per-tool value', async () => {
    const recorder = makeSpanRecorder();
    const hookDurations = new Map<string, number>();
    const hooks = new DefaultHookRegistry();
    hooks.registerVoid('after_tool_call', async (payload: AfterToolCallPayload) => {
      hookDurations.set(payload.toolName, payload.durationMs);
    });
    const metricDurations = new Map<string, number>();

    const loop = new AgentLoop({
      llm: twoToolLLM(),
      tools: fastAndSlowTools(),
      hooks,
      personalities: pluginPersonalities(),
      safety: createTestSafety(),
      observability: recorder.observability,
      onToolMetric: ({ toolName, durationMs }) => {
        metricDurations.set(toolName, durationMs);
      },
    });
    for await (const _e of loop.run('go', { sessionKey: 'cli:a4-consumers' })) {
      // drain
    }

    for (const [label, seen] of [
      ['span', recorder.spanDurations],
      ['hook', hookDurations],
      ['metric', metricDurations],
    ] as const) {
      const fast = seen.get('fast');
      const slow = seen.get('slow');
      expect(`${label}:${typeof fast}`).toBe(`${label}:number`);
      expect(`${label}:${typeof slow}`).toBe(`${label}:number`);
      expect(slow ?? 0).toBeGreaterThanOrEqual(SLOW_FLOOR_MS);
      expect(fast ?? Number.POSITIVE_INFINITY).toBeLessThan(FAST_CEILING_MS);
    }
  });

  it('executeParallel returns a duration per call, timed at the call', async () => {
    const tools = fastAndSlowTools();
    const results = await tools.executeParallel(
      [
        { toolCallId: 'c-fast', name: 'fast', args: {} },
        { toolCallId: 'c-slow', name: 'slow', args: {} },
      ],
      {
        sessionId: 's1',
        sessionKey: 'cli:a4-registry',
        platform: 'cli',
        workingDir: process.cwd(),
        resultBudgetChars: 80_000,
        currentTurn: 1,
        messageCount: 1,
        abortSignal: new AbortController().signal,
        emit: () => {},
      },
    );

    const byName = new Map(results.map((r) => [r.name, r.durationMs]));
    const fast = byName.get('fast');
    const slow = byName.get('slow');
    expect(typeof fast).toBe('number');
    expect(typeof slow).toBe('number');
    expect(slow ?? 0).toBeGreaterThanOrEqual(SLOW_FLOOR_MS);
    expect(fast ?? Number.POSITIVE_INFINITY).toBeLessThan(FAST_CEILING_MS);
  });
});
