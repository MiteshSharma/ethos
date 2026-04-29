/**
 * Session continuity across personality switches (Decision D1).
 *
 * When a user runs `/personality engineer` mid-chat, the conversation thread
 * MUST stay in the same session — same session_id, same history. The session
 * belongs to the human, not to the role. A personality switch changes what the
 * agent can *do*, not *who the human is talking to*.
 *
 * This test locks that contract so a future PR cannot accidentally introduce
 * per-personality session keys without CI catching it.
 */

import type { CompletionChunk, LLMProvider, Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop, InMemorySessionStore } from '@ethosagent/core';

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
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, estimatedCostUsd: 0 },
      };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() { return 1; },
  };
}

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) { /* consume */ }
}

describe('session continuity across personality switches', () => {
  it('switching personality keeps the same session — same session_id, same thread', async () => {
    // The session store is shared; the same sessionKey maps to the same session
    // regardless of which personality is active.
    const session = new InMemorySessionStore();

    const loop = new AgentLoop({
      llm: makeMockLLM(),
      session,
    });

    const sessionKey = 'cli:session-continuity-test';

    // Turn 1 — send as personality A
    await drain(loop.run('message from personality A', {
      sessionKey,
      personalityId: 'researcher',
    }));

    // Turn 2 — switch to personality B, same sessionKey
    await drain(loop.run('message from personality B', {
      sessionKey,
      personalityId: 'engineer',
    }));

    // Both turns must live in the same session
    const sess = await session.getSessionByKey(sessionKey);
    expect(sess).not.toBeNull();

    const messages = await session.getMessages(sess!.id, { limit: 100 });
    const userMessages = messages.filter((m) => m.role === 'user');

    // Both user messages are in one session — no fork, no per-personality sessions
    expect(userMessages).toHaveLength(2);
    expect(userMessages.some((m) => m.content === 'message from personality A')).toBe(true);
    expect(userMessages.some((m) => m.content === 'message from personality B')).toBe(true);
  });

  it('switching personality does NOT create a new session', async () => {
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({ llm: makeMockLLM(), session });
    const sessionKey = 'cli:no-fork-test';

    await drain(loop.run('first', { sessionKey, personalityId: 'researcher' }));
    const sessionAfterFirst = await session.getSessionByKey(sessionKey);

    await drain(loop.run('second', { sessionKey, personalityId: 'engineer' }));
    const sessionAfterSwitch = await session.getSessionByKey(sessionKey);

    // session_id is unchanged after the personality switch
    expect(sessionAfterFirst!.id).toBe(sessionAfterSwitch!.id);
  });
});
