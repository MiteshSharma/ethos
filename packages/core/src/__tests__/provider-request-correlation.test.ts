// B2 — the two request ids meet here. The loop mints one `requestId` per LLM
// call (client-minted, sent OUTBOUND); the provider reports its own
// server-assigned id back on the usage chunk (INBOUND). Both must land on the
// `llm_call` span attrs AND on the request-dump record, under names that keep
// them apart: `clientRequestId` correlates our own logs, `providerRequestId` is
// what a provider support ticket asks for.

import type { CompletionChunk, CompletionOptions, LLMProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import type { AgentLoopObservability } from '../observability/agent-loop-observability';
import { InMemoryRequestDumpStore } from '../request-dump-store';
import { createTestSafety } from './helpers/test-safety';

const PROVIDER_REQUEST_ID = 'req_011CQoiTPabcdef123456';

/** Records the outbound options it was handed and reports a server id back. */
function correlatingLLM(seen: CompletionOptions[], providerRequestId?: string): LLMProvider {
  return {
    name: 'mock-correlating',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(_messages, _tools, options: CompletionOptions): AsyncIterable<CompletionChunk> {
      seen.push(options);
      yield { type: 'text_delta', text: 'ok' };
      yield {
        type: 'usage',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: 0,
        },
        ...(providerRequestId ? { providerRequestId } : {}),
      };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 10;
    },
  };
}

interface Driven {
  outbound: CompletionOptions[];
  llmSpanAttrs: Array<Record<string, unknown> | undefined>;
  dumps: InMemoryRequestDumpStore;
}

async function drive(providerRequestId?: string): Promise<Driven> {
  const outbound: CompletionOptions[] = [];
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
  const dumps = new InMemoryRequestDumpStore();
  const loop = new AgentLoop({
    llm: correlatingLLM(outbound, providerRequestId),
    safety: createTestSafety(),
    observability,
    requestDumpStore: dumps,
  });
  for await (const _e of loop.run('go', { sessionKey: `cli:b2-${providerRequestId ?? 'none'}` })) {
    // drain
  }
  return { outbound, llmSpanAttrs, dumps };
}

describe('provider request correlation (B2)', () => {
  it('sends the loop requestId outward on the completion options', async () => {
    const { outbound } = await drive(PROVIDER_REQUEST_ID);
    expect(outbound).toHaveLength(1);
    // Pre-fix: `requestId` never left the loop, so this was undefined.
    expect(outbound[0]?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('puts BOTH ids on the llm_call span attrs, under distinguishable names', async () => {
    const { outbound, llmSpanAttrs } = await drive(PROVIDER_REQUEST_ID);
    expect(llmSpanAttrs).toHaveLength(1);
    const attrs = llmSpanAttrs[0];
    expect(attrs?.clientRequestId).toBe(outbound[0]?.requestId);
    expect(attrs?.providerRequestId).toBe(PROVIDER_REQUEST_ID);
    // Two different values — conflating them would lose one of the two joins.
    expect(attrs?.clientRequestId).not.toBe(attrs?.providerRequestId);
    // The attrs A2 already put there must survive.
    expect(attrs?.inputTokens).toBe(10);
    expect(attrs).toHaveProperty('estimatedCostUsd');
  });

  it('puts BOTH ids on the request-dump record', async () => {
    const { outbound, dumps } = await drive(PROVIDER_REQUEST_ID);
    const records = dumps.getAll();
    expect(records).toHaveLength(1);
    expect(records[0]?.requestId).toBe(outbound[0]?.requestId);
    // Pre-fix: the record carried only our own id.
    expect(records[0]?.providerRequestId).toBe(PROVIDER_REQUEST_ID);
  });

  it('still records our own id on both sinks when the provider reports none', async () => {
    const { outbound, llmSpanAttrs, dumps } = await drive();
    expect(llmSpanAttrs[0]?.clientRequestId).toBe(outbound[0]?.requestId);
    expect(llmSpanAttrs[0]?.providerRequestId).toBeUndefined();
    expect(dumps.getAll()[0]?.requestId).toBe(outbound[0]?.requestId);
    expect(dumps.getAll()[0]?.providerRequestId).toBeUndefined();
  });
});
