// A2 — the `llm_call` span ended with tokens but no money. `stream-step.ts`
// already summed the provider's reported `estimatedCostUsd` off the usage
// chunks (it feeds the session budget and the A1 rollup), then dropped it on
// the floor at `endSpan`, so every cost aggregate computed over `llm_call`
// spans read $0.00 no matter what the call actually cost.
//
// The span now carries `estimatedCostUsd`. The value is the provider's own —
// core does NOT re-derive it, because `packages/core` must not depend on
// `@ethosagent/pricing` (layer direction, ARCHITECTURE.md §II). These tests
// therefore drive a provider that reports a cost the way the real ones do and
// assert the exact number reaches the span.

import type { CompletionChunk, LLMProvider, TokenUsage } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import type { AgentLoopObservability } from '../observability/agent-loop-observability';
import { createTestSafety } from './helpers/test-safety';

/**
 * A priced model and the cost `@ethosagent/pricing` yields for it: the
 * `claude-sonnet-4` row is $3/1M input and $15/1M output, so
 * 1000 in + 500 out = 0.003 + 0.0075 = 0.0105 USD. The provider extension
 * computes this and puts it on the usage chunk; core just carries it.
 */
const PRICED_MODEL = 'claude-sonnet-4-6';
const INPUT_TOKENS = 1000;
const OUTPUT_TOKENS = 500;
const EXPECTED_COST_USD = 0.0105;

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCostUsd: 0,
};

function usageChunk(u: Partial<TokenUsage>): CompletionChunk {
  return { type: 'usage', usage: { ...ZERO_USAGE, ...u } };
}

/** One LLM round emitting the given usage chunks, then a plain finish. */
function pricedLLM(usageChunks: CompletionChunk[]): LLMProvider {
  return {
    name: 'mock-priced',
    model: PRICED_MODEL,
    maxContextTokens: 200_000,
    supportsCaching: true,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      yield { type: 'text_delta', text: 'ok' };
      for (const c of usageChunks) yield c;
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 10;
    },
  };
}

interface SpanRecorder {
  observability: AgentLoopObservability;
  /** attrs handed to `endSpan` for `llm_call` spans, in close order. */
  llmSpanAttrs: Array<Record<string, unknown> | undefined>;
}

function makeSpanRecorder(): SpanRecorder {
  const llmSpanAttrs: Array<Record<string, unknown> | undefined> = [];
  const llmSpans = new Set<string>();
  let seq = 0;
  const observability: AgentLoopObservability = {
    startTurnTrace: () => 'trace-1',
    endTrace: () => {},
    startSpan: (opts) => {
      const id = `span-${++seq}`;
      if (opts.kind === 'llm_call') llmSpans.add(id);
      return id;
    },
    endSpan: (spanId, _status, attrs) => {
      if (llmSpans.has(spanId)) llmSpanAttrs.push(attrs);
    },
    recordSafetyBlock: () => {},
    recordCompaction: () => {},
    recordTierEscalation: () => {},
    recordTierOverride: () => {},
    flush: () => {},
  };
  return { observability, llmSpanAttrs };
}

async function runWith(usageChunks: CompletionChunk[], sessionKey: string): Promise<SpanRecorder> {
  const recorder = makeSpanRecorder();
  const loop = new AgentLoop({
    llm: pricedLLM(usageChunks),
    safety: createTestSafety(),
    observability: recorder.observability,
  });
  for await (const _e of loop.run('go', { sessionKey })) {
    // drain
  }
  return recorder;
}

describe('llm_call span cost (A2)', () => {
  it('ends the span with the provider-reported estimatedCostUsd for a priced model', async () => {
    const { llmSpanAttrs } = await runWith(
      [
        usageChunk({
          inputTokens: INPUT_TOKENS,
          outputTokens: OUTPUT_TOKENS,
          estimatedCostUsd: EXPECTED_COST_USD,
        }),
      ],
      'cli:a2-priced',
    );

    expect(llmSpanAttrs).toHaveLength(1);
    const attrs = llmSpanAttrs[0];
    // Pre-fix the key was simply absent, so both of these fail.
    expect(attrs?.estimatedCostUsd).toBe(EXPECTED_COST_USD);
    expect(
      typeof attrs?.estimatedCostUsd === 'number' ? attrs.estimatedCostUsd : 0,
    ).toBeGreaterThan(0);
    // The tokens the span already carried must still be there.
    expect(attrs?.inputTokens).toBe(INPUT_TOKENS);
    expect(attrs?.outputTokens).toBe(OUTPUT_TOKENS);
  });

  it('sums every usage chunk of the call into the one span cost', async () => {
    const { llmSpanAttrs } = await runWith(
      [usageChunk({ estimatedCostUsd: 0.004 }), usageChunk({ estimatedCostUsd: 0.006 })],
      'cli:a2-multi-chunk',
    );

    expect(llmSpanAttrs).toHaveLength(1);
    expect(llmSpanAttrs[0]?.estimatedCostUsd).toBeCloseTo(0.01, 10);
  });

  it('reports 0 — not a missing attribute — when the provider priced the call at zero', async () => {
    // A local model (Ollama) is an intentional $0, and that is a different
    // fact from "cost was never recorded". The attribute must be present.
    const { llmSpanAttrs } = await runWith(
      [usageChunk({ inputTokens: 10, outputTokens: 5 })],
      'cli:a2-free',
    );

    expect(llmSpanAttrs).toHaveLength(1);
    expect(llmSpanAttrs[0]).toHaveProperty('estimatedCostUsd');
    expect(llmSpanAttrs[0]?.estimatedCostUsd).toBe(0);
  });
});
