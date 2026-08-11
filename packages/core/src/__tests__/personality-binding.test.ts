import type { CompletionChunk, LLMProvider, Message } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { compactSession } from '../agent-loop/manual-compact';
import type { SummarizerFn } from '../context-engines/semantic-summary';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
import { createTestSafety } from './helpers/test-safety';

function makeMockLLM(): LLMProvider {
  return {
    name: 'mock',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(_messages: Message[]): AsyncIterable<CompletionChunk> {
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 10;
    },
  };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function makeRegistry(): DefaultPersonalityRegistry {
  const personalities = new DefaultPersonalityRegistry();
  personalities.define({ id: 'scribe', name: 'Scribe' });
  personalities.define({ id: 'auditor', name: 'Auditor' });
  return personalities;
}

function makeLoop(session: InMemorySessionStore) {
  return new AgentLoop({
    llm: makeMockLLM(),
    session,
    personalities: makeRegistry(),
    safety: createTestSafety(),
  });
}

describe('session personality binding', () => {
  it('refuses a turn that names a personality other than the bound one', async () => {
    const session = new InMemorySessionStore();
    const loop = makeLoop(session);
    const sessionKey = 'cli:locked';

    await collect(loop.run('hi', { sessionKey, personalityId: 'scribe' }));

    const events = await collect(loop.run('hi again', { sessionKey, personalityId: 'auditor' }));
    const err = events.find((e) => e.type === 'error') as
      | Extract<AgentEvent, { type: 'error' }>
      | undefined;

    expect(err?.code).toBe('personality_locked');
    expect(err?.error).toContain('scribe');
    expect(err?.error).toContain('auditor');
    // Turn did not run: no assistant text, and the binding is untouched.
    expect(events.find((e) => e.type === 'text_delta')).toBeUndefined();
    expect((await session.getSessionByKey(sessionKey))?.personalityId).toBe('scribe');
  });

  it('proceeds when the turn names the personality the session is bound to', async () => {
    const session = new InMemorySessionStore();
    const loop = makeLoop(session);
    const sessionKey = 'cli:matching';

    await collect(loop.run('hi', { sessionKey, personalityId: 'scribe' }));
    const events = await collect(loop.run('hi again', { sessionKey, personalityId: 'scribe' }));

    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.find((e) => e.type === 'text_delta')).toBeDefined();
    expect(events.find((e) => e.type === 'done')).toBeDefined();
  });

  it('uses the bound personality when the turn names none', async () => {
    const session = new InMemorySessionStore();
    const personalities = makeRegistry();
    const loop = new AgentLoop({
      llm: makeMockLLM(),
      session,
      personalities,
      safety: createTestSafety(),
    });
    const sessionKey = 'cli:implicit';

    await collect(loop.run('hi', { sessionKey, personalityId: 'scribe' }));

    const get = vi.spyOn(personalities, 'get');
    const events = await collect(loop.run('hi again', { sessionKey }));

    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(get).toHaveBeenCalledWith('scribe');
  });

  it('binds and persists the personality on a legacy session that has none', async () => {
    const session = new InMemorySessionStore();
    const loop = makeLoop(session);
    const sessionKey = 'cli:legacy';

    // A row created before the binding rule: no personalityId at all.
    await session.createSession({
      key: sessionKey,
      platform: 'cli',
      model: 'mock-model',
      provider: 'mock',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
        apiCallCount: 0,
        compactionCount: 0,
      },
    });
    const update = vi.spyOn(session, 'updateSession');

    const events = await collect(loop.run('hi', { sessionKey, personalityId: 'auditor' }));

    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(update).toHaveBeenCalledWith(expect.any(String), { personalityId: 'auditor' });
    expect((await session.getSessionByKey(sessionKey))?.personalityId).toBe('auditor');

    // Now bound — a conflicting turn is refused.
    const refused = await collect(loop.run('hi', { sessionKey, personalityId: 'scribe' }));
    expect(
      (refused.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>)?.code,
    ).toBe('personality_locked');
  });
});

describe('compactSession — personality binding', () => {
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0,
    apiCallCount: 0,
    compactionCount: 0,
  };

  /** Distinct `context_engine` per personality — `engineName` on the result is
   *  the observable proof of WHICH personality drove the compaction. */
  function makeEngineRegistry(): DefaultPersonalityRegistry {
    const personalities = new DefaultPersonalityRegistry();
    personalities.define({ id: 'scribe', name: 'Scribe', context_engine: 'tiered_summary' });
    personalities.define({ id: 'auditor', name: 'Auditor', context_engine: 'semantic_summary' });
    return personalities;
  }

  async function seed(
    session: InMemorySessionStore,
    key: string,
    personalityId?: string,
  ): Promise<string> {
    const s = await session.createSession({
      key,
      platform: 'cli',
      model: 'mock-model',
      provider: 'mock',
      ...(personalityId ? { personalityId } : {}),
      usage,
    });
    for (let i = 0; i < 20; i++) {
      await session.appendMessage({
        sessionId: s.id,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `MSG-${i}`,
      });
    }
    return s.id;
  }

  function deps(session: InMemorySessionStore, personalities: DefaultPersonalityRegistry) {
    const summarizer: SummarizerFn = async () => 'SUMMARY';
    return { session, personalities, historyLimit: 100, summarizer };
  }

  it("uses the session's bound personality, not the caller's", async () => {
    const session = new InMemorySessionStore();
    const personalities = makeEngineRegistry();
    await seed(session, 'cli:bound', 'scribe');

    const result = await compactSession(deps(session, personalities), 'cli:bound');

    expect(result.ok).toBe(true);
    expect(result.engineName).toBe('tiered_summary');
  });

  it('refuses when the caller names a personality the session is not bound to', async () => {
    const session = new InMemorySessionStore();
    const personalities = makeEngineRegistry();
    const sessionId = await seed(session, 'cli:conflict', 'scribe');

    const result = await compactSession(deps(session, personalities), 'cli:conflict', {
      personalityId: 'auditor',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('personality_locked');
    // Nothing was summarized and no watermark was written.
    expect(result.droppedCount).toBe(0);
    expect(await session.listCompressions(sessionId)).toHaveLength(0);
  });

  it('accepts a caller id that matches the binding', async () => {
    const session = new InMemorySessionStore();
    const personalities = makeEngineRegistry();
    await seed(session, 'cli:agree', 'scribe');

    const result = await compactSession(deps(session, personalities), 'cli:agree', {
      personalityId: 'scribe',
    });

    expect(result.ok).toBe(true);
    expect(result.engineName).toBe('tiered_summary');
  });

  it('falls back to the caller id on a legacy session that has no binding', async () => {
    const session = new InMemorySessionStore();
    const personalities = makeEngineRegistry();
    await seed(session, 'cli:legacy-compact');

    const result = await compactSession(deps(session, personalities), 'cli:legacy-compact', {
      personalityId: 'auditor',
    });

    expect(result.ok).toBe(true);
    expect(result.engineName).toBe('semantic_summary');
  });
});

describe('InMemorySessionStore.updateSession — personality backstop', () => {
  const base = {
    key: 'cli:backstop',
    platform: 'cli',
    model: 'mock-model',
    provider: 'mock',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: 0,
      apiCallCount: 0,
      compactionCount: 0,
    },
  };

  it('throws when a patch would change a bound personality', async () => {
    const store = new InMemorySessionStore();
    const s = await store.createSession({ ...base, personalityId: 'scribe' });

    await expect(store.updateSession(s.id, { personalityId: 'auditor' })).rejects.toThrow(
      /bound to personality "scribe"/,
    );
    expect((await store.getSession(s.id))?.personalityId).toBe('scribe');
  });

  it('allows binding a personality when none is set', async () => {
    const store = new InMemorySessionStore();
    const s = await store.createSession(base);

    await store.updateSession(s.id, { personalityId: 'scribe' });
    expect((await store.getSession(s.id))?.personalityId).toBe('scribe');
  });

  it('allows a no-op patch that repeats the bound personality', async () => {
    const store = new InMemorySessionStore();
    const s = await store.createSession({ ...base, personalityId: 'scribe' });

    await store.updateSession(s.id, { personalityId: 'scribe', title: 'still scribe' });
    const got = await store.getSession(s.id);
    expect(got?.personalityId).toBe('scribe');
    expect(got?.title).toBe('still scribe');
  });
});
