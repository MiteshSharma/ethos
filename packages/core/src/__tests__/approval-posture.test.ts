import type { AgentEvent, CompletionChunk, LLMProvider, Logger, LogMeta } from '@ethosagent/types';
import { ApprovalPostureError } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { DefaultHookRegistry } from '../hook-registry';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

// ---------------------------------------------------------------------------
// G4 — core owns the `before_tool_call` enforcement point but nothing told it
// whether an approval policy was registered behind it. A bare embedder got a
// fully working loop with no gating and no signal. The posture is now declared
// and checked at the first tool dispatch.
// ---------------------------------------------------------------------------

/** One tool call, then a text end_turn. */
function makeToolLLM(): LLMProvider {
  let calls = 0;
  return {
    name: 'posture',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      calls++;
      if (calls > 1) {
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      const id = 'call-1';
      const inputJson = '{}';
      yield { type: 'tool_use_start', toolCallId: id, toolName: 'echo' };
      yield { type: 'tool_use_delta', toolCallId: id, partialJson: inputJson };
      yield { type: 'tool_use_end', toolCallId: id, inputJson };
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 1;
    },
  };
}

function makeRegistry(): DefaultToolRegistry {
  const tools = new DefaultToolRegistry();
  tools.register({
    name: 'echo',
    description: 'echo tool',
    schema: { type: 'object' },
    capabilities: {},
    execute: async () => ({ ok: true, value: 'ran' }),
  });
  return tools;
}

function recordingLogger(): {
  logger: Logger;
  records: Array<{ message: string; meta?: LogMeta }>;
} {
  const records: Array<{ message: string; meta?: LogMeta }> = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (message, meta) => {
      records.push(meta === undefined ? { message } : { message, meta });
    },
    error: () => {},
    child: () => logger,
  };
  return { logger, records };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe('approval posture', () => {
  it('throws a typed error when a loop declares "gated" with no before_tool_call handler', async () => {
    const loop = new AgentLoop({
      llm: makeToolLLM(),
      tools: makeRegistry(),
      hooks: new DefaultHookRegistry(),
      safety: createTestSafety({
        approvalPosture: { kind: 'gated', policy: 'danger-predicate' },
      }),
    });

    await expect(collect(loop.run('go', { sessionKey: 'posture-gated' }))).rejects.toThrow(
      ApprovalPostureError,
    );
  });

  it('does not throw when the declared gate actually has a handler behind it', async () => {
    const hooks = new DefaultHookRegistry();
    hooks.registerModifying('before_tool_call', async () => null);

    const loop = new AgentLoop({
      llm: makeToolLLM(),
      tools: makeRegistry(),
      hooks,
      safety: createTestSafety({
        approvalPosture: { kind: 'gated', policy: 'danger-predicate' },
      }),
    });

    const events = await collect(loop.run('go', { sessionKey: 'posture-gated-ok' }));
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('runs and logs the supplied reason when the posture is "ungated"', async () => {
    const { logger, records } = recordingLogger();
    const loop = new AgentLoop({
      llm: makeToolLLM(),
      tools: makeRegistry(),
      hooks: new DefaultHookRegistry(),
      logger,
      safety: createTestSafety({
        approvalPosture: { kind: 'ungated', reason: 'embedded read-only evaluation harness' },
      }),
    });

    const events = await collect(loop.run('go', { sessionKey: 'posture-ungated' }));
    expect(events.some((e) => e.type === 'done')).toBe(true);

    const notice = records.find((r) => r.message.includes('UNGATED'));
    expect(notice).toBeDefined();
    expect(notice?.message).toContain('embedded read-only evaluation harness');
    expect(notice?.meta?.approvalPosture).toBe('ungated');
  });

  it('logs the ungated notice once per loop, not once per tool call', async () => {
    const { logger, records } = recordingLogger();
    const loop = new AgentLoop({
      llm: makeToolLLM(),
      tools: makeRegistry(),
      hooks: new DefaultHookRegistry(),
      logger,
      safety: createTestSafety({
        approvalPosture: { kind: 'ungated', reason: 'test fixture' },
      }),
    });

    await collect(loop.run('one', { sessionKey: 'posture-once' }));
    await collect(loop.run('two', { sessionKey: 'posture-once' }));

    expect(records.filter((r) => r.message.includes('UNGATED'))).toHaveLength(1);
  });
});
