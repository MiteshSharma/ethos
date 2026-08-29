/**
 * Fanning one turn out to several personalities must produce one session each.
 *
 * A session's personality is bound at creation and immutable, so a child key
 * derived from label + turn alone would bind on the first personality and get
 * every later one refused with `personality_locked` — which is exactly what two
 * unlabelled `delegate_task` calls in the same turn do.
 *
 * Driven against a REAL AgentLoop so the invariant, not a stub, is what's tested.
 */

import { AgentLoop, InMemorySessionStore } from '@ethosagent/core';
import type { CompletionChunk, LLMProvider, ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import { createDelegateTaskTool } from '../index';

function makeStubLLM(): LLMProvider {
  return {
    name: 'stub',
    model: 'stub-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      yield { type: 'text_delta', text: 'answer' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

/** Parent context with no personality of its own, so cross-personality delegation is allowed. */
function makeCtx(): ToolContext {
  return {
    sessionId: 'parent-session',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    agentId: 'depth:0',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
  };
}

describe('delegate_task across personalities', () => {
  it('gives each personality its own child session within one turn', async () => {
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({ llm: makeStubLLM(), session, safety: createTestSafety() });
    const tool = createDelegateTaskTool(loop);

    // Same ToolContext for both calls — same parent session, same turn, no label.
    const ctx = makeCtx();
    const first = await tool.execute({ prompt: 'Research this.', personality: 'researcher' }, ctx);
    const second = await tool.execute({ prompt: 'Build this.', personality: 'engineer' }, ctx);

    // Neither call was refused: a `personality_locked` refusal surfaces as a
    // failed sub-agent run naming the session's binding.
    const failures = [first, second].filter((r) => !r.ok).map((r) => (r.ok ? '' : r.error));
    expect(failures).toEqual([]);

    const children = (await session.listSessions()).filter((s) => s.key.includes(':sub:'));
    expect(children).toHaveLength(2);
    expect(new Set(children.map((s) => s.key)).size).toBe(2);
    expect(children.map((s) => s.personalityId).sort()).toEqual(['engineer', 'researcher']);
  });
});
