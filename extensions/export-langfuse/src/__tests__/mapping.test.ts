import type { ObsEvent, Span, Trace } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { buildLangfuseBatch } from '../mapping';

describe('buildLangfuseBatch', () => {
  const trace: Trace = {
    traceId: 'trace-1',
    sessionId: 'sess-1',
    kind: 'turn',
    startTs: 1_000,
    endTs: 5_000,
    status: 'ok',
    subjectId: 'assistant',
    attrs: { platform: 'telegram' },
  };

  const llmSpan: Span = {
    spanId: 'span-llm',
    traceId: 'trace-1',
    kind: 'llm_call',
    name: 'claude-sonnet-5',
    startTs: 1_100,
    endTs: 2_000,
    status: 'ok',
    attrs: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheCreationTokens: 0,
      estimatedCostUsd: 0.0042,
      clientRequestId: 'client-req-1',
      providerRequestId: 'provider-req-1',
      provider: 'anthropic',
      costBasis: 'known',
    },
  };

  const toolSpan: Span = {
    spanId: 'span-tool',
    traceId: 'trace-1',
    kind: 'tool_call',
    name: 'read_file',
    startTs: 2_100,
    endTs: 2_300,
    status: 'ok',
    attrs: { durationMs: 180 },
  };

  const skillEvent: ObsEvent = {
    eventId: 'evt-1',
    traceId: 'trace-1',
    ts: 2_400,
    category: 'skill.invoked',
    severity: 'info',
    details: { skill: 'docs' },
  };

  it('maps a fixture turn to the expected Langfuse batch', () => {
    const batch = buildLangfuseBatch(trace, [llmSpan, toolSpan], [skillEvent]);

    expect(batch).toHaveLength(4);
    const [traceEvt, genEvt, spanEvt, eventEvt] = batch;

    expect(traceEvt.type).toBe('trace-create');
    expect(traceEvt.body).toMatchObject({
      id: 'trace-1',
      timestamp: new Date(1_000).toISOString(),
      name: 'turn',
      sessionId: 'sess-1',
      metadata: { personality: 'assistant', platform: 'telegram' },
    });

    expect(genEvt.type).toBe('generation-create');
    expect(genEvt.body).toMatchObject({
      id: 'span-llm',
      traceId: 'trace-1',
      name: 'claude-sonnet-5',
      model: 'claude-sonnet-5',
      startTime: new Date(1_100).toISOString(),
      endTime: new Date(2_000).toISOString(),
      usageDetails: { input: 100, output: 50, cache_read_input_tokens: 20 },
      costDetails: { total: 0.0042 },
      metadata: {
        provider: 'anthropic',
        costBasis: 'known',
        clientRequestId: 'client-req-1',
        providerRequestId: 'provider-req-1',
      },
    });
    // cache_creation_input_tokens was 0 — excluded, not written as a zero bucket.
    expect(genEvt.body.usageDetails).not.toHaveProperty('cache_creation_input_tokens');

    expect(spanEvt.type).toBe('span-create');
    expect(spanEvt.body).toMatchObject({
      id: 'span-tool',
      traceId: 'trace-1',
      name: 'read_file',
      metadata: { durationMs: 180, kind: 'tool_call' },
    });

    expect(eventEvt.type).toBe('event-create');
    expect(eventEvt.body).toMatchObject({
      id: 'evt-1',
      traceId: 'trace-1',
      name: 'skill.invoked',
      level: 'DEFAULT',
      metadata: { skill: 'docs' },
    });
  });

  it('marks an error tool_call span with an ERROR level', () => {
    const erroredTool: Span = { ...toolSpan, status: 'error' };
    const batch = buildLangfuseBatch(trace, [erroredTool], []);
    expect(batch[0]).toBeDefined(); // trace-create
    const [, spanEvt] = batch;
    expect(spanEvt.body.level).toBe('ERROR');
  });

  it('omits platform metadata when the trace carries none', () => {
    const bareTrace: Trace = { ...trace, attrs: undefined };
    const [traceEvt] = buildLangfuseBatch(bareTrace, [], []);
    expect(traceEvt.body.metadata).toEqual({ personality: 'assistant' });
  });
});
