// Fix 4 (analytics-observability Phase 2 review) — a failed LLM call used to
// lose its accumulated usage/cost/provider attrs at `endSpan(..., 'error',
// ...)`, which only carried `clientRequestId`/`providerRequestId`. The
// tokens/cost accumulator locals in `stream-step.ts` are already populated
// from whatever usage chunks arrived before the stream errored — they just
// weren't being passed through. This meant a failed call after partial
// streaming both lost its real token/cost counts AND got tagged
// `provider="unknown"` in the Prometheus counters, even though the
// provider's name was in scope the whole time.

import type { CompletionChunk, LLMProvider, TokenUsage } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import type { AgentLoopObservability } from '../observability/agent-loop-observability';
import { createTestSafety } from './helpers/test-safety';

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

/** Emits one usage chunk (partial progress), then throws — simulating a
 *  stream that errors after some tokens/cost were already reported. */
function pricedLLMThatErrorsMidStream(usage: Partial<TokenUsage>): LLMProvider {
  return {
    name: 'mock-priced-provider',
    model: 'claude-sonnet-4-6',
    maxContextTokens: 200_000,
    supportsCaching: true,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      yield { type: 'text_delta', text: 'partial' };
      yield usageChunk(usage);
      throw new Error('stream broke after partial usage');
    },
    async countTokens() {
      return 10;
    },
  };
}

interface SpanRecorder {
  observability: AgentLoopObservability;
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

describe('llm_call span usage on the error path (Fix 4)', () => {
  it('carries the partial usage/cost/provider onto endSpan(..., "error", ...)', async () => {
    const recorder = makeSpanRecorder();
    const loop = new AgentLoop({
      llm: pricedLLMThatErrorsMidStream({
        inputTokens: 1000,
        outputTokens: 500,
        estimatedCostUsd: 0.0105,
      }),
      safety: createTestSafety(),
      observability: recorder.observability,
    });

    for await (const _e of loop.run('go', { sessionKey: 'cli:fix4-error-usage' })) {
      // drain
    }

    expect(recorder.llmSpanAttrs).toHaveLength(1);
    const attrs = recorder.llmSpanAttrs[0];
    // Pre-fix these were all absent on the error-path endSpan call.
    expect(attrs?.inputTokens).toBe(1000);
    expect(attrs?.outputTokens).toBe(500);
    expect(attrs?.estimatedCostUsd).toBe(0.0105);
    expect(attrs?.provider).toBe('mock-priced-provider');
  });
});
