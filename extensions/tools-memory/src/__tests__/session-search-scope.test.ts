/**
 * session_search is scoped to the current session by design — memory is
 * scope-bound and a cross-session search would cross personality boundaries.
 * The description must not promise recall the tool does not have.
 */

import type { SessionStore, ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createSessionSearchTool } from '../index';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'session-under-test',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
    ...overrides,
  };
}

describe('session_search scope', () => {
  it('does not claim cross-session scope in its description', () => {
    const { description } = createSessionSearchTool({} as unknown as SessionStore);
    expect(description).not.toMatch(/across all sessions/i);
    expect(description).not.toMatch(/all sessions/i);
    expect(description).toMatch(/current session/i);
  });

  it('scopes the search to ctx.sessionId', async () => {
    const calls: Array<{ limit?: number; sessionId?: string }> = [];
    const mockSession = {
      search: async (_query: string, opts?: { limit?: number; sessionId?: string }) => {
        calls.push({ ...opts });
        return [];
      },
    } as unknown as SessionStore;

    const tool = createSessionSearchTool(mockSession);
    const result = await tool.execute({ query: 'deploy' }, makeCtx());

    expect(result.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]?.sessionId).toBe('session-under-test');
  });
});
