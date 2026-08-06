// Lane 1(a) delta — the max-single-tool-result term in the compactible-region
// arithmetic:
//
//   compactible = window − static_prefix − reserved_output − max_single_tool_result
//
// The term extends `evaluateGate` (ONE arithmetic shared by the pre-LLM gate
// and the turn-end trigger) rather than adding a second threshold system, and
// it defaults to 0 so an unset caller is byte-identical to before.

import type { CompletionChunk, LLMProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { effectiveGate, evaluateGate, gateThreshold } from '../agent-loop/compaction';

function llmWithWindow(maxContextTokens: number): LLMProvider {
  return {
    name: 'stub',
    model: 'mock-model',
    maxContextTokens,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

describe('Lane 1(a) — max_single_tool_result term', () => {
  const llm = llmWithWindow(8_192);

  it('subtracts the term from the compactible region (numeric)', () => {
    // 8,192 window − 4,096 output reserve = 4,096; − 1,000 static − 1,024
    // largest-result reserve = 2,072 compactible tokens.
    const g = evaluateGate({ llm, staticTokens: 1_000, maxSingleToolResultTokens: 1_024 }, [], '');
    expect(g.window).toBe(4_096);
    expect(g.staticTokens).toBe(1_000);
    expect(g.messagesWindow).toBe(2_072);
    // The threshold honours the narrowed region: 1,000 + floor(2,072 × 0.8).
    expect(gateThreshold(g, 0.8)).toBe(1_000 + Math.floor(2_072 * 0.8));
  });

  it('absent or zero → byte-identical to the pre-Lane-1 arithmetic', () => {
    const before = evaluateGate({ llm, staticTokens: 1_000 }, [], '');
    const zero = evaluateGate({ llm, staticTokens: 1_000, maxSingleToolResultTokens: 0 }, [], '');
    expect(zero).toEqual(before);
    expect(before.messagesWindow).toBe(3_096);
  });

  it('clamps: a term larger than the remaining window floors the region at 0', () => {
    const g = evaluateGate(
      { llm, staticTokens: 1_000, maxSingleToolResultTokens: 100_000 },
      [],
      '',
    );
    expect(g.messagesWindow).toBe(0);
    // Threshold degenerates to the static slice; the absolute ceiling still
    // composes through effectiveGate as the ONE lowered gate.
    expect(gateThreshold(g, 0.8)).toBe(1_000);
    expect(effectiveGate(g, 0.8, 500)).toBe(500);
  });

  it('negative input is treated as 0, never widening the region', () => {
    const g = evaluateGate({ llm, maxSingleToolResultTokens: -50 }, [], '');
    expect(g.messagesWindow).toBe(4_096);
  });
});
