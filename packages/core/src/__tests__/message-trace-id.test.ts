// A3 — `messages.trace_id` was a dead column: the migration added it, nothing
// wrote it, nothing read it. The loop now stamps the turn's observability
// `traceId` on every message row it persists, which is what makes the
// `sessions.db` ⟷ `observability.db` join free.
//
// The binding these tests pin is IDENTITY, not shape: the id on the rows must
// be the SAME id `startTurnTrace` minted for the turn — the one the spans hang
// off and `endTrace` closes — not a second id that merely looks like one.

import type {
  AgentEvent,
  CompletionChunk,
  LLMProvider,
  StoredMessage,
  ToolResult,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import type { AgentLoopObservability } from '../observability/agent-loop-observability';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

interface TraceRecorder {
  observability: AgentLoopObservability;
  /** Ids handed back by `startTurnTrace`, in turn order. */
  minted: string[];
  /** `traceId` every span was filed under. */
  spanTraceIds: string[];
  /** Ids `endTrace` closed. */
  ended: string[];
}

function makeTraceRecorder(): TraceRecorder {
  const minted: string[] = [];
  const spanTraceIds: string[] = [];
  const ended: string[] = [];
  let spanSeq = 0;
  const observability: AgentLoopObservability = {
    startTurnTrace: () => {
      const id = `trace-${minted.length + 1}`;
      minted.push(id);
      return id;
    },
    endTrace: (traceId) => {
      ended.push(traceId);
    },
    startSpan: (opts) => {
      spanTraceIds.push(opts.traceId);
      return `span-${++spanSeq}`;
    },
    endSpan: () => {},
    recordSafetyBlock: () => {},
    recordCompaction: () => {},
    recordTierEscalation: () => {},
    recordTierOverride: () => {},
    flush: () => {},
  };
  return { observability, minted, spanTraceIds, ended };
}

/** One tool call on the first LLM round, plain text on the second. */
function scriptedLLM(): LLMProvider {
  let calls = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      calls++;
      if (calls % 2 === 1) {
        yield { type: 'tool_use_start', toolCallId: `c${calls}`, toolName: 'echo' };
        yield { type: 'tool_use_end', toolCallId: `c${calls}`, inputJson: '{}' };
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

function echoTools(): DefaultToolRegistry {
  const tools = new DefaultToolRegistry();
  tools.register({
    name: 'echo',
    description: 'echoes',
    schema: { type: 'object' },
    capabilities: {},
    async execute(): Promise<ToolResult> {
      return { ok: true, value: 'echoed' };
    },
  });
  return tools;
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<void> {
  for await (const _e of gen) {
    // drain
  }
}

async function messagesFor(session: InMemorySessionStore, key: string): Promise<StoredMessage[]> {
  const s = await session.getSessionByKey(key);
  if (!s) throw new Error(`no session for ${key}`);
  return session.getMessages(s.id);
}

describe('messages.trace_id (A3)', () => {
  it('stamps the SAME traceId the observability trace uses on every persisted row', async () => {
    const recorder = makeTraceRecorder();
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({
      llm: scriptedLLM(),
      tools: echoTools(),
      session,
      safety: createTestSafety(),
      observability: recorder.observability,
    });

    await drain(loop.run('go', { sessionKey: 'cli:trace' }));

    const turnTraceId = recorder.minted[0];
    expect(turnTraceId).toBe('trace-1');
    // The turn's spans hang off this id and the trace closes on it — so it IS
    // the row in `observability.db` that the message rows now point at.
    expect(recorder.spanTraceIds.length).toBeGreaterThan(0);
    expect(new Set(recorder.spanTraceIds)).toEqual(new Set([turnTraceId]));
    expect(recorder.ended).toContain(turnTraceId);

    const messages = await messagesFor(session, 'cli:trace');
    // user + assistant(tool_use) + tool_result + assistant(final)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool_result', 'assistant']);
    for (const m of messages) {
      expect(m.traceId).toBe(turnTraceId);
    }
  });

  it('partitions rows by turn — each turn carries its own trace id', async () => {
    const recorder = makeTraceRecorder();
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({
      llm: scriptedLLM(),
      tools: echoTools(),
      session,
      safety: createTestSafety(),
      observability: recorder.observability,
    });

    await drain(loop.run('one', { sessionKey: 'cli:two-turns' }));
    await drain(loop.run('two', { sessionKey: 'cli:two-turns' }));

    expect(recorder.minted).toEqual(['trace-1', 'trace-2']);
    const messages = await messagesFor(session, 'cli:two-turns');
    const first = messages.filter((m) => m.traceId === 'trace-1');
    const second = messages.filter((m) => m.traceId === 'trace-2');
    expect(first).toHaveLength(4);
    expect(second).toHaveLength(4);
    expect(first.length + second.length).toBe(messages.length);
  });

  it('leaves traceId undefined when no observability is wired', async () => {
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({
      llm: scriptedLLM(),
      tools: echoTools(),
      session,
      safety: createTestSafety(),
    });

    await drain(loop.run('go', { sessionKey: 'cli:no-obs' }));

    const messages = await messagesFor(session, 'cli:no-obs');
    expect(messages.length).toBeGreaterThan(0);
    for (const m of messages) {
      expect(m.traceId).toBeUndefined();
    }
  });
});
