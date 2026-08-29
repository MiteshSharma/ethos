import type { AgentEvent } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { JsonlReader, toolResultText } from '../protocol';
import { PiEventTranslator } from '../translate';

/** A clock that advances 10ms per read, so durations are deterministic. */
function tickingClock(): () => number {
  let t = 1_000;
  return () => {
    t += 10;
    return t;
  };
}

function usageEvent(input: number, output: number, cost: number) {
  return {
    type: 'message_update' as const,
    usage: { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
  };
}

describe('PiEventTranslator', () => {
  it('maps text and thinking deltas onto their AgentEvent variants', () => {
    const t = new PiEventTranslator(tickingClock());
    const out = [
      ...t.translate({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'hello ' },
      }),
      ...t.translate({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' },
      }),
      ...t.translate({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'world' },
      }),
    ];
    expect(out).toEqual<AgentEvent[]>([
      { type: 'text_delta', text: 'hello ' },
      { type: 'thinking_delta', thinking: 'hmm' },
      { type: 'text_delta', text: 'world' },
    ]);
    expect(t.outputText).toBe('hello world');
  });

  it('ignores stream bookkeeping that has no AgentEvent meaning', () => {
    const t = new PiEventTranslator(tickingClock());
    for (const type of ['agent_start', 'message_start', 'message_end', 'queue_update']) {
      expect(t.translate({ type })).toEqual([]);
    }
    // A brand-new Pi event type must be a no-op, never a throw.
    expect(t.translate({ type: 'some_future_event' })).toEqual([]);
  });

  it('pairs tool execution start/end and measures the duration itself', () => {
    const t = new PiEventTranslator(tickingClock());
    const start = t.translate({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'write',
      args: { path: 'hello.txt' },
    });
    expect(start).toEqual<AgentEvent[]>([
      { type: 'tool_start', toolCallId: 'call-1', toolName: 'write', args: { path: 'hello.txt' } },
    ]);
    const end = t.translate({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'write',
      isError: false,
      result: { content: [{ type: 'text', text: 'wrote 11 bytes' }] },
    });
    expect(end).toEqual<AgentEvent[]>([
      {
        type: 'tool_end',
        toolCallId: 'call-1',
        toolName: 'write',
        ok: true,
        durationMs: 10,
        result: 'wrote 11 bytes',
      },
    ]);
  });

  it('carries a failed tool call through as ok:false with the error body', () => {
    const t = new PiEventTranslator(tickingClock());
    t.translate({ type: 'tool_execution_start', toolCallId: 'c', toolName: 'bash' });
    const [end] = t.translate({
      type: 'tool_execution_end',
      toolCallId: 'c',
      toolName: 'bash',
      isError: true,
      result: { content: [{ text: 'Blocked by Ethos policy' }] },
    });
    expect(end).toMatchObject({ type: 'tool_end', ok: false, error: 'Blocked by Ethos policy' });
  });

  it('emits usage once per run, as a delta, from cumulative snapshots', () => {
    const t = new PiEventTranslator(tickingClock());
    // Cumulative snapshots during streaming produce nothing on their own —
    // one store write per token would be write amplification.
    expect(t.translate(usageEvent(100, 1, 0.001))).toEqual([]);
    expect(t.translate(usageEvent(100, 40, 0.004))).toEqual([]);
    expect(t.translate({ type: 'agent_end' })).toEqual<AgentEvent[]>([
      { type: 'usage', inputTokens: 100, outputTokens: 40, estimatedCostUsd: 0.004 },
    ]);
    // Already-reported usage is never reported twice.
    expect(t.translate({ type: 'agent_end' })).toEqual([]);
  });

  it('banks the previous message when the counters restart, instead of losing it', () => {
    const t = new PiEventTranslator(tickingClock());
    t.translate(usageEvent(100, 40, 0.004));
    // A new assistant message restarts Pi's counters. Treating the smaller
    // snapshot as the new total would silently drop the first message's spend.
    t.translate(usageEvent(20, 5, 0.001));
    t.translate(usageEvent(20, 9, 0.002));
    expect(t.translate({ type: 'agent_end' })).toEqual<AgentEvent[]>([
      { type: 'usage', inputTokens: 120, outputTokens: 49, estimatedCostUsd: 0.006 },
    ]);
  });

  it('reports cache tokens only when the provider actually cached', () => {
    const t = new PiEventTranslator(tickingClock());
    t.translate({
      type: 'message_update',
      usage: { input: 10, output: 2, cacheRead: 900, cacheWrite: 0, cost: { total: 0.01 } },
    });
    expect(t.translate({ type: 'agent_end' })).toEqual<AgentEvent[]>([
      {
        type: 'usage',
        inputTokens: 10,
        outputTokens: 2,
        estimatedCostUsd: 0.01,
        cacheReadTokens: 900,
      },
    ]);
  });

  it('turns a rejected command into an error event', () => {
    const t = new PiEventTranslator(tickingClock());
    expect(
      t.translate({ type: 'response', command: 'prompt', success: false, error: 'no model' }),
    ).toEqual<AgentEvent[]>([
      { type: 'error', error: "pi command 'prompt' failed: no model", code: 'pi_command_failed' },
    ]);
    expect(t.translate({ type: 'response', command: 'prompt', success: true })).toEqual([]);
  });

  it('finishes with the accumulated text and the turn count', () => {
    const t = new PiEventTranslator(tickingClock());
    t.translate({ type: 'turn_start' });
    t.translate({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'done.' },
    });
    t.translate({ type: 'turn_start' });
    expect(t.finish()).toEqual<AgentEvent[]>([{ type: 'done', text: 'done.', turnCount: 2 }]);
  });

  it('never reports turnCount 0 for a run that produced output', () => {
    const t = new PiEventTranslator(tickingClock());
    expect(t.finish()).toEqual<AgentEvent[]>([{ type: 'done', text: '', turnCount: 1 }]);
  });
});

describe('JsonlReader', () => {
  it('splits on LF only, holding a partial record across chunks', () => {
    const r = new JsonlReader();
    expect(r.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
    expect(r.push('2}\n')).toEqual(['{"b":2}']);
  });

  it('does not split on U+2028/U+2029, which are legal inside JSON strings', () => {
    const r = new JsonlReader();
    // Node's readline would break this record in half — which is exactly why
    // Pi's RPC docs say readline is not protocol-compliant.
    const line = '{"text":"a\u2028b\u2029c"}';
    expect(r.push(`${line}\n`)).toEqual([line]);
  });

  it('tolerates CRLF and skips blank records', () => {
    const r = new JsonlReader();
    expect(r.push('{"a":1}\r\n\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe('toolResultText', () => {
  it('joins content blocks and tolerates an absent result', () => {
    expect(toolResultText({ content: [{ text: 'one' }, { text: 'two' }] })).toBe('one\ntwo');
    expect(toolResultText(undefined)).toBe('');
  });
});
