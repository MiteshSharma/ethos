import type { AgentEvent, CompletionChunk, LLMProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { DefaultHookRegistry } from '../hook-registry';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

/**
 * Scripted provider emitting one tool call per LLM round for `toolCalls`
 * rounds, then a plain text end_turn. Every call uses distinct args so the
 * identical-call guards never fire and the denial breaker is the only stop
 * under test.
 */
function makeToolLoopLLM(toolCalls: number, toolName = 'danger'): LLMProvider {
  let calls = 0;
  return {
    name: 'tool-loop',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      calls++;
      const n = calls;
      if (n > toolCalls) {
        yield { type: 'text_delta', text: 'finished' };
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      const id = `call-${n}`;
      const inputJson = JSON.stringify({ n });
      yield { type: 'tool_use_start', toolCallId: id, toolName };
      yield { type: 'tool_use_delta', toolCallId: id, partialJson: inputJson };
      yield { type: 'tool_use_end', toolCallId: id, inputJson };
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 1;
    },
  };
}

function makeRegistry(names: string[]): DefaultToolRegistry {
  const tools = new DefaultToolRegistry();
  for (const name of names) {
    tools.register({
      name,
      description: `${name} tool`,
      schema: { type: 'object' },
      capabilities: {},
      execute: async () => ({ ok: true, value: 'ran' }),
    });
  }
  return tools;
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

function haltsOf(events: AgentEvent[]): Extract<AgentEvent, { type: 'halt' }>[] {
  return events.filter((e): e is Extract<AgentEvent, { type: 'halt' }> => e.type === 'halt');
}

/** Hook registry whose `before_tool_call` denies the first `n` calls. */
function denyFirst(n: number): DefaultHookRegistry {
  const hooks = new DefaultHookRegistry();
  let seen = 0;
  hooks.registerModifying('before_tool_call', async () => {
    seen++;
    return seen <= n ? { error: 'denied by user — recursive force-delete' } : null;
  });
  return hooks;
}

describe('consecutive-denial circuit breaker', () => {
  it('halts the run after three consecutive approval denials', async () => {
    const loop = new AgentLoop({
      llm: makeToolLoopLLM(10),
      tools: makeRegistry(['danger']),
      hooks: denyFirst(10),
      safety: createTestSafety(),
    });

    const events = await collect(loop.run('go', { sessionKey: 'breaker-3' }));
    const halts = haltsOf(events);

    expect(halts).toHaveLength(1);
    expect(halts[0]?.kind).toBe('budget');
    expect(halts[0]?.rule).toBe('denial_circuit_breaker');
    expect(halts[0]?.count).toBe(3);
    // A normal `done` still follows the halt.
    expect(events.find((e) => e.type === 'done')).toBeDefined();
  });

  it('does not halt on two denials followed by a successful call', async () => {
    const loop = new AgentLoop({
      llm: makeToolLoopLLM(4),
      tools: makeRegistry(['danger']),
      hooks: denyFirst(2),
      safety: createTestSafety(),
    });

    const events = await collect(loop.run('go', { sessionKey: 'breaker-2' }));

    expect(haltsOf(events)).toEqual([]);
    expect(events.find((e) => e.type === 'done')).toBeDefined();
  });

  it('relays the specific denial reason into the tool_result the model sees', async () => {
    const loop = new AgentLoop({
      llm: makeToolLoopLLM(1),
      tools: makeRegistry(['danger']),
      hooks: denyFirst(1),
      safety: createTestSafety(),
    });

    const events = await collect(loop.run('go', { sessionKey: 'breaker-reason' }));
    const end = events.find((e) => e.type === 'tool_end');

    expect(end?.type === 'tool_end' && end.ok).toBe(false);
    expect(end?.type === 'tool_end' && end.error).toMatch(/recursive force-delete/);
  });

  it('does NOT advance on non-approval rejections (MCP policy blocks)', async () => {
    // An MCP-policy block lands in the same `Prepped.rejected` field as an
    // approval denial. Only the `before_tool_call` branch may feed the breaker.
    const loop = new AgentLoop({
      llm: makeToolLoopLLM(6, 'mcp__disabled__thing'),
      tools: makeRegistry(['mcp__disabled__thing']),
      safety: createTestSafety(),
      mcpPolicy: { servers: { disabled: { enabled: false } } },
    });

    const events = await collect(loop.run('go', { sessionKey: 'breaker-mcp' }));

    expect(haltsOf(events)).toEqual([]);
    expect(events.find((e) => e.type === 'done')).toBeDefined();
  });
});
