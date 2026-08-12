// A6 — `chunk-handler.ts` flattened the provider's `TokenUsage` down to
// input/output/cost, so the cache columns never reached an `AgentEvent`
// consumer at all. Every surface that reads the event stream (CLI `/usage`,
// the agent bridge, the goal runner) was therefore blind to cache activity
// even when the provider reported it.
//
// `AgentEvent`'s `usage` variant is on the ARCHITECTURE.md §VII frozen-schema
// roster, so the fix is additive-optional: `cacheReadTokens?` and
// `cacheCreationTokens?` are present only when the provider reported cache
// activity. A cacheless call omits them rather than emitting 0, which keeps
// "caching not in play" distinguishable from "cached nothing this call".

import type { AgentEvent, CompletionChunk, LLMProvider, TokenUsage } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { handleChunk } from '../agent-loop/chunk-handler';
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

/** Runs one chunk through the handler and returns the events it yielded. */
function emit(chunk: CompletionChunk): AgentEvent[] {
  return [...handleChunk(chunk, [], () => {})];
}

function usageEvents(events: AgentEvent[]): Array<Extract<AgentEvent, { type: 'usage' }>> {
  return events.filter((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage');
}

/** One LLM round emitting the given usage, then a plain finish. */
function llmReporting(usage: Partial<TokenUsage>): LLMProvider {
  return {
    name: 'mock-cached',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: true,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      yield { type: 'text_delta', text: 'ok' };
      yield usageChunk(usage);
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 10;
    },
  };
}

describe('usage AgentEvent cache tokens (A6)', () => {
  it('carries both cache fields when the provider reported them', () => {
    const events = usageEvents(
      emit(
        usageChunk({
          inputTokens: 120,
          outputTokens: 30,
          cacheReadTokens: 4096,
          cacheCreationTokens: 2048,
          estimatedCostUsd: 0.002,
        }),
      ),
    );

    expect(events).toHaveLength(1);
    const usage = events[0];
    // Pre-fix these two keys did not exist on the event.
    expect(usage?.cacheReadTokens).toBe(4096);
    expect(usage?.cacheCreationTokens).toBe(2048);
    // The already-shipped fields are untouched — this is an additive change.
    expect(usage?.inputTokens).toBe(120);
    expect(usage?.outputTokens).toBe(30);
    expect(usage?.estimatedCostUsd).toBe(0.002);
  });

  it('omits a cache field the provider did not report, rather than emitting 0', () => {
    const events = usageEvents(
      emit(usageChunk({ inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.001 })),
    );

    expect(events).toHaveLength(1);
    const usage = events[0];
    expect(usage).not.toHaveProperty('cacheReadTokens');
    expect(usage).not.toHaveProperty('cacheCreationTokens');
    expect(usage?.cacheReadTokens).toBeUndefined();
    expect(usage?.cacheCreationTokens).toBeUndefined();
  });

  it('carries each cache field independently', () => {
    const readOnly = usageEvents(emit(usageChunk({ cacheReadTokens: 512 })))[0];
    expect(readOnly?.cacheReadTokens).toBe(512);
    expect(readOnly).not.toHaveProperty('cacheCreationTokens');

    const writeOnly = usageEvents(emit(usageChunk({ cacheCreationTokens: 256 })))[0];
    expect(writeOnly?.cacheCreationTokens).toBe(256);
    expect(writeOnly).not.toHaveProperty('cacheReadTokens');
  });

  it('surfaces the cache tokens on the events a real turn yields', async () => {
    const events: AgentEvent[] = [];
    const loop = new AgentLoop({
      llm: llmReporting({
        inputTokens: 200,
        outputTokens: 40,
        cacheReadTokens: 8192,
        cacheCreationTokens: 1024,
        estimatedCostUsd: 0.003,
      }),
      safety: createTestSafety(),
    });
    for await (const e of loop.run('go', { sessionKey: 'cli:a6-turn' })) events.push(e);

    const usage = usageEvents(events)[0];
    expect(usage?.cacheReadTokens).toBe(8192);
    expect(usage?.cacheCreationTokens).toBe(1024);
  });
});
