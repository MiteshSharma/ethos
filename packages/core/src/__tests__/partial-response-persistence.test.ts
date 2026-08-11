// A terminal stream failure (stalled watchdog / provider error) used to throw
// away everything the assistant had already streamed: the catch in
// `streamStep` returned before `appendMessage`, so the partial text lived only
// in the client's buffer and vanished the moment the next turn reloaded
// history. These tests pin the fix and its two boundaries — the recoverable
// context-overflow path still persists nothing, and neither does an empty
// response.

import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  MessageContent,
  StoredMessage,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { createTestSafety } from './helpers/test-safety';

/** LLM whose per-call chunk plan is supplied by `respond`. */
function makeLLM(
  respond: (index: number) => { chunks: CompletionChunk[]; throwError?: Error },
  log: Message[][] = [],
): LLMProvider {
  let index = 0;
  return {
    name: 'mock',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(messages: Message[]): AsyncIterable<CompletionChunk> {
      log.push(messages.slice());
      const plan = respond(index++);
      for (const c of plan.chunks) yield c;
      if (plan.throwError) throw plan.throwError;
    },
    async countTokens() {
      return 10;
    },
  };
}

/** LLM that streams `text`, then hangs until aborted — trips the watchdog. */
function makeStallingLLM(text: string): LLMProvider {
  return {
    name: 'stalling',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      _messages: Message[],
      _tools: unknown,
      opts: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      if (text) yield { type: 'text_delta', text };
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 30_000);
        opts.abortSignal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    async countTokens() {
      return 10;
    },
  };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

async function assistantMessages(
  session: InMemorySessionStore,
  sessionKey: string,
): Promise<StoredMessage[]> {
  const s = await session.getSessionByKey(sessionKey);
  if (!s) return [];
  const messages = await session.getMessages(s.id);
  return messages.filter((m) => m.role === 'assistant');
}

/** tool_use ids in `messages` with no matching tool_result anywhere. */
function orphanToolUseIds(messages: Message[]): string[] {
  const blocks = (m: Message): MessageContent[] => (Array.isArray(m.content) ? m.content : []);
  const resultIds = new Set<string>();
  for (const m of messages) {
    for (const b of blocks(m)) if (b.type === 'tool_result') resultIds.add(b.tool_use_id);
  }
  const orphans: string[] = [];
  for (const m of messages) {
    for (const b of blocks(m)) {
      if (b.type === 'tool_use' && !resultIds.has(b.id)) orphans.push(b.id);
    }
  }
  return orphans;
}

describe('partial assistant text survives a terminal stream failure', () => {
  it('persists the partial text on a terminal llm_error', async () => {
    const session = new InMemorySessionStore();
    const llm = makeLLM(() => ({
      chunks: [{ type: 'text_delta', text: 'Here is what I found so far' }],
      throwError: new Error('502 upstream connection reset'),
    }));
    const loop = new AgentLoop({ llm, session, safety: createTestSafety() });

    const events = await collect(loop.run('go', { sessionKey: 'cli:err' }));
    const err = events.find((e) => e.type === 'error');
    expect(err?.type === 'error' && err.code).toBe('llm_error');

    const assistant = await assistantMessages(session, 'cli:err');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.content).toContain('Here is what I found so far');
    expect(assistant[0]?.content).toContain('[interrupted —');
  });

  it('persists the partial text when the streaming watchdog trips', async () => {
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({
      llm: makeStallingLLM('partial answer before the stall'),
      session,
      safety: createTestSafety(),
      options: { streamingTimeoutMs: 50 },
    });

    const events = await collect(loop.run('go', { sessionKey: 'cli:stall' }));
    const err = events.find((e) => e.type === 'error');
    expect(err?.type === 'error' && err.code).toBe('streaming_timeout');

    const assistant = await assistantMessages(session, 'cli:stall');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.content).toContain('partial answer before the stall');
    expect(assistant[0]?.content).toContain('[interrupted —');
  });

  it('does NOT persist on the recoverable context-overflow path', async () => {
    const session = new InMemorySessionStore();
    const llm = makeLLM(() => ({
      chunks: [{ type: 'text_delta', text: 'streamed before the overflow' }],
      throwError: new Error('400 invalid_request_error: prompt is too long'),
    }));
    const loop = new AgentLoop({
      llm,
      session,
      safety: createTestSafety(),
      compaction: { retryOnOverflow: false },
    });

    const events = await collect(loop.run('go', { sessionKey: 'cli:overflow' }));
    const err = events.find((e) => e.type === 'error');
    expect(err?.type === 'error' && err.code).toBe('context_overflow');

    // Compact-and-retry needs a clean history — nothing may be persisted here.
    expect(await assistantMessages(session, 'cli:overflow')).toHaveLength(0);
  });

  it('persists nothing when no text streamed before the failure', async () => {
    const session = new InMemorySessionStore();
    const llm = makeLLM(() => ({ chunks: [], throwError: new Error('503 service unavailable') }));
    const loop = new AgentLoop({ llm, session, safety: createTestSafety() });

    const events = await collect(loop.run('go', { sessionKey: 'cli:empty' }));
    const err = events.find((e) => e.type === 'error');
    expect(err?.type === 'error' && err.code).toBe('llm_error');

    expect(await assistantMessages(session, 'cli:empty')).toHaveLength(0);
  });

  it('leaves no orphan tool_use in the next turn when a tool call was in flight', async () => {
    const session = new InMemorySessionStore();
    const log: Message[][] = [];
    const llm = makeLLM(
      (index) =>
        index === 0
          ? {
              chunks: [
                { type: 'text_delta', text: 'Let me check that' },
                { type: 'tool_use_start', toolCallId: 'call_1', toolName: 'read_file' },
                { type: 'tool_use_delta', toolCallId: 'call_1', partialJson: '{"path":"/tmp' },
              ],
              throwError: new Error('502 upstream connection reset'),
            }
          : { chunks: [{ type: 'done', finishReason: 'end_turn' }] },
      log,
    );
    const loop = new AgentLoop({ llm, session, safety: createTestSafety() });

    await collect(loop.run('go', { sessionKey: 'cli:inflight' }));
    await collect(loop.run('and now?', { sessionKey: 'cli:inflight' }));

    const secondTurn = log[1] ?? [];
    expect(orphanToolUseIds(secondTurn)).toEqual([]);
    // The half-streamed tool call is dropped entirely; only the text survives.
    // (The second, successful turn appends its own assistant row after it.)
    const interrupted = (await assistantMessages(session, 'cli:inflight'))[0];
    expect(interrupted?.toolCalls).toBeUndefined();
    expect(interrupted?.content).toContain('Let me check that');
    expect(interrupted?.content).toContain('[interrupted —');
  });
});
