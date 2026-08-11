/**
 * Session continuity within a personality.
 *
 * A session's personality is bound when the session is created and is immutable
 * thereafter. A turn that names a DIFFERENT personality for an already-bound
 * session is refused with error code `personality_locked` — the transcript of
 * one session is the record of one personality, and `personality evolve` reads
 * it back as training evidence. The only sanctioned ways to involve another
 * personality are to create a new session bound to it, or to fork into a child
 * session bound to it. `/personality <id>` in the CLI therefore rotates the
 * session key and starts a fresh session bound to the new personality.
 *
 * This SUPERSEDES Decision D1, which held the inverse — that a personality
 * switch must keep the same session because "the session belongs to the human,
 * not to the role".
 *
 * Continuity is still a real property and still guarded here: the same session
 * key with the same (or an unspecified) personality stays one session, one
 * session_id, one thread.
 */

import type { AgentEvent } from '@ethosagent/core';
import { AgentLoop, InMemorySessionStore } from '@ethosagent/core';
import type { CompletionChunk, LLMProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';

function makeMockLLM(): LLMProvider {
  return {
    name: 'mock',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      yield { type: 'text_delta', text: 'ok' };
      yield {
        type: 'usage',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: 0,
        },
      };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

/** Drain a turn to completion and hand back everything it emitted. */
async function drain(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe('session personality binding and continuity', () => {
  it('refuses a turn naming a different personality and leaves the session untouched', async () => {
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({
      llm: makeMockLLM(),
      session,
      safety: createTestSafety(),
    });

    const sessionKey = 'cli:session-continuity-test';

    // Turn 1 — binds the session to personality A.
    await drain(
      loop.run('message from personality A', {
        sessionKey,
        personalityId: 'researcher',
      }),
    );

    // Turn 2 — same sessionKey, different personality. Must be refused.
    const events = await drain(
      loop.run('message from personality B', {
        sessionKey,
        personalityId: 'engineer',
      }),
    );

    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    expect(error?.type === 'error' && error.code).toBe('personality_locked');

    const sess = await session.getSessionByKey(sessionKey);
    if (!sess) throw new Error('Expected session to exist');

    // The session stays bound to A, and the refused turn appended nothing.
    expect(sess.personalityId).toBe('researcher');
    const messages = await session.getMessages(sess.id, { limit: 100 });
    const userMessages = messages.filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.content).toBe('message from personality A');
  });

  it('keeps one session across turns with the same (or unspecified) personality', async () => {
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({ llm: makeMockLLM(), session, safety: createTestSafety() });
    const sessionKey = 'cli:no-fork-test';

    await drain(loop.run('first', { sessionKey, personalityId: 'researcher' }));
    const sessionAfterFirst = await session.getSessionByKey(sessionKey);

    await drain(loop.run('second', { sessionKey, personalityId: 'researcher' }));
    // A turn that names no personality inherits the session's binding.
    await drain(loop.run('third', { sessionKey }));
    const sessionAfterThird = await session.getSessionByKey(sessionKey);

    // Same session_id, one continuous thread.
    expect(sessionAfterFirst?.id).toBe(sessionAfterThird?.id);
    if (!sessionAfterThird) throw new Error('Expected session to exist');
    expect(sessionAfterThird.personalityId).toBe('researcher');

    const messages = await session.getMessages(sessionAfterThird.id, { limit: 100 });
    const userMessages = messages.filter((m) => m.role === 'user');
    expect(userMessages.map((m) => m.content)).toEqual(['first', 'second', 'third']);
  });

  it('a fresh session key binds cleanly to the new personality (the /personality fork path)', async () => {
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({ llm: makeMockLLM(), session, safety: createTestSafety() });
    const sessionKey = 'cli:fork-test';

    await drain(loop.run('as researcher', { sessionKey, personalityId: 'researcher' }));
    const original = await session.getSessionByKey(sessionKey);

    // `/personality engineer` rotates the session key the way the CLI does.
    const forkedKey = `${sessionKey}:${Date.now()}`;
    const events = await drain(
      loop.run('as engineer', { sessionKey: forkedKey, personalityId: 'engineer' }),
    );
    expect(events.some((e) => e.type === 'error')).toBe(false);

    const forked = await session.getSessionByKey(forkedKey);
    if (!forked) throw new Error('Expected forked session to exist');

    expect(forked.id).not.toBe(original?.id);
    expect(forked.personalityId).toBe('engineer');
    expect(original?.personalityId).toBe('researcher');

    // The forked session carries only its own turn.
    const messages = await session.getMessages(forked.id, { limit: 100 });
    expect(messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
      'as engineer',
    ]);
  });
});
