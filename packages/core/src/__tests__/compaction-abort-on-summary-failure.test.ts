// Item 7 — `compaction.abortOnSummaryFailure`. A context-overflow rejection
// whose emergency compaction THREW is reported as its own
// `compaction_summary_failed` error instead of being masked as the provider's
// generic `context_overflow`. Default off: the masking behaviour is unchanged.

import type {
  CompletionChunk,
  ContextEngine,
  ContextEngineCompactInput,
  LLMProvider,
  Message,
  PersonalityConfig,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { applyOverflowRetry } from '../agent-loop/overflow';
import { DefaultContextEngineRegistry } from '../context-engines/registry';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { createTestSafety } from './helpers/test-safety';

/** Registry whose `drop_oldest` slot behaves as `compact` dictates. */
function registryWith(compact: ContextEngine['compact']) {
  const registry = new DefaultContextEngineRegistry();
  registry.register({ name: 'drop_oldest', compact });
  return registry;
}

const throwingEngine: ContextEngine['compact'] = async () => {
  throw new Error('summarizer unreachable');
};

/** Runs, keeps everything, and so never shrinks the history. */
const noShrinkEngine: ContextEngine['compact'] = async (opts: ContextEngineCompactInput) => ({
  messages: opts.messages,
  notes: 'kept everything',
});

const personality = { id: 'p', name: 'p' } as unknown as PersonalityConfig;

const llmStub = {
  countTokens: async (m: Message[]) => m.length,
} as unknown as Parameters<typeof applyOverflowRetry>[0]['llm'];

const meta = { sessionId: 's', sessionKey: 'cli:t', turnNumber: 1, lastCompactionTurn: 0 };

describe('applyOverflowRetry — summary-failure reporting', () => {
  const history: Message[] = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' },
  ];

  it('reports summaryError when the engine throws', async () => {
    const result = await applyOverflowRetry(
      { llm: llmStub, contextEngines: registryWith(throwingEngine) },
      [...history],
      '',
      personality,
      meta,
    );
    expect(result.retried).toBe(false);
    expect(result.summaryError).toBe('summarizer unreachable');
  });

  it('leaves summaryError unset when the engine ran but could not shrink', async () => {
    const result = await applyOverflowRetry(
      { llm: llmStub, contextEngines: registryWith(noShrinkEngine) },
      [...history],
      '',
      personality,
      meta,
    );
    expect(result.retried).toBe(false);
    expect(result.summaryError).toBeUndefined();
  });

  it('reports retried when the engine shrinks the history in place', async () => {
    const messages = [...history];
    const result = await applyOverflowRetry(
      {
        llm: llmStub,
        contextEngines: registryWith(async (o) => ({
          messages: o.messages.slice(0, 1),
          notes: 'kept the head',
        })),
      },
      messages,
      '',
      personality,
      meta,
    );
    expect(result).toEqual({ retried: true });
    expect(messages).toHaveLength(1);
  });
});

describe('AgentLoop — compaction.abortOnSummaryFailure', () => {
  /** LLM that always rejects the request as a context overflow. */
  const overflowLlm: LLMProvider = {
    name: 'stub',
    model: 'stub-model',
    maxContextTokens: 200_000,
    // biome-ignore lint/correctness/useYield: the throw IS the behaviour under test
    async *complete(): AsyncIterable<CompletionChunk> {
      throw new Error('400 invalid_request_error: prompt is too long');
    },
    async countTokens(messages: Message[]) {
      return messages.length;
    },
  } as unknown as LLMProvider;

  async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
    const out: AgentEvent[] = [];
    for await (const e of gen) out.push(e);
    return out;
  }

  function loopWith(
    compaction: { abortOnSummaryFailure?: boolean } | undefined,
    compact: ContextEngine['compact'],
  ) {
    return new AgentLoop({
      llm: overflowLlm,
      session: new InMemorySessionStore(),
      safety: createTestSafety(),
      contextEngines: registryWith(compact),
      ...(compaction ? { compaction } : {}),
    });
  }

  it('emits compaction_summary_failed when the flag is on and the summary threw', async () => {
    const loop = loopWith({ abortOnSummaryFailure: true }, throwingEngine);
    const events = await collect(loop.run('go', { sessionKey: 'cli:abort' }));
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.type === 'error' && errors[0].code).toBe('compaction_summary_failed');
    expect(errors[0]?.type === 'error' && errors[0].error).toContain('summarizer unreachable');
  });

  it('still emits context_overflow when the flag is on but the summary merely could not shrink', async () => {
    const loop = loopWith({ abortOnSummaryFailure: true }, noShrinkEngine);
    const events = await collect(loop.run('go', { sessionKey: 'cli:noshrink' }));
    const err = events.find((e) => e.type === 'error');
    expect(err?.type === 'error' && err.code).toBe('context_overflow');
  });

  it('masks the summary failure as context_overflow by default (flag unset)', async () => {
    const loop = loopWith(undefined, throwingEngine);
    const events = await collect(loop.run('go', { sessionKey: 'cli:default' }));
    const err = events.find((e) => e.type === 'error');
    expect(err?.type === 'error' && err.code).toBe('context_overflow');
  });

  it('masks the summary failure when the flag is explicitly false', async () => {
    const loop = loopWith({ abortOnSummaryFailure: false }, throwingEngine);
    const events = await collect(loop.run('go', { sessionKey: 'cli:off' }));
    const err = events.find((e) => e.type === 'error');
    expect(err?.type === 'error' && err.code).toBe('context_overflow');
  });
});
