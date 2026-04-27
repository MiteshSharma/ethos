import type { AgentEvent } from '@ethosagent/core';
import type { ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createDelegateTaskTool, createDelegationTools, createMixtureOfAgentsTool } from '../index';

// ---------------------------------------------------------------------------
// Mock AgentLoop
// ---------------------------------------------------------------------------

function makeLoop(responses: Record<string, string> = {}) {
  const defaultResponse = 'Sub-agent completed the task.';

  return {
    run: async function* (prompt: string): AsyncGenerator<AgentEvent> {
      // Return a response keyed by a keyword in the prompt, or default
      const key = Object.keys(responses).find((k) => prompt.includes(k));
      const text = key ? responses[key] : defaultResponse;
      yield { type: 'text_delta', text };
      yield { type: 'done', text, turnCount: 1 };
    },
  } as unknown as import('@ethosagent/core').AgentLoop;
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// delegate_task
// ---------------------------------------------------------------------------

describe('delegate_task', () => {
  it('runs a sub-agent and returns its output', async () => {
    const loop = makeLoop({ summarise: 'Here is the summary.' });
    const tool = createDelegateTaskTool(loop);

    const result = await tool.execute({ prompt: 'Please summarise this text.' }, makeCtx());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('summary');
  });

  it('includes label in output when provided', async () => {
    const loop = makeLoop();
    const tool = createDelegateTaskTool(loop);

    const result = await tool.execute(
      { prompt: 'Do something.', label: 'Research Task' },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('[Research Task]');
  });

  it('returns input_invalid when prompt is missing', async () => {
    const tool = createDelegateTaskTool(makeLoop());
    const result = await tool.execute({}, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('blocks delegation when max depth is reached', async () => {
    const tool = createDelegateTaskTool(makeLoop());
    const result = await tool.execute(
      { prompt: 'Do something.' },
      makeCtx({ agentId: 'depth:3' }), // at max depth
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Maximum spawn depth');
      expect(result.code).toBe('execution_failed');
    }
  });

  it('uses the session key from parent context', async () => {
    const sessionKeys: string[] = [];
    const loop = {
      run: async function* (
        _prompt: string,
        opts: { sessionKey?: string },
      ): AsyncGenerator<AgentEvent> {
        sessionKeys.push(opts.sessionKey ?? '');
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', text: 'done', turnCount: 1 };
      },
    } as unknown as import('@ethosagent/core').AgentLoop;

    const tool = createDelegateTaskTool(loop);
    await tool.execute({ prompt: 'task', label: 'my-task' }, makeCtx({ sessionKey: 'cli:abc' }));

    expect(sessionKeys[0]).toContain('cli:abc');
    expect(sessionKeys[0]).toContain('my-task');
  });

  it('threads spawn depth into child loops via agentId', async () => {
    const seenAgentIds: Array<string | undefined> = [];
    const loop = {
      run: async function* (
        _prompt: string,
        opts: { agentId?: string },
      ): AsyncGenerator<AgentEvent> {
        seenAgentIds.push(opts.agentId);
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'done', text: 'ok', turnCount: 1 };
      },
    } as unknown as import('@ethosagent/core').AgentLoop;

    const tool = createDelegateTaskTool(loop);

    // Parent at depth 0 spawns a child → child loop should run at depth:1
    await tool.execute({ prompt: 'task' }, makeCtx({ agentId: 'depth:0' }));
    expect(seenAgentIds[0]).toBe('depth:1');

    // Parent at depth 1 spawns a child → child loop should run at depth:2
    await tool.execute({ prompt: 'task' }, makeCtx({ agentId: 'depth:1' }));
    expect(seenAgentIds[1]).toBe('depth:2');
  });

  it('mixture_of_agents threads depth into every spawned child', async () => {
    const seenAgentIds: Array<string | undefined> = [];
    const loop = {
      run: async function* (
        _prompt: string,
        opts: { agentId?: string },
      ): AsyncGenerator<AgentEvent> {
        seenAgentIds.push(opts.agentId);
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'done', text: 'ok', turnCount: 1 };
      },
    } as unknown as import('@ethosagent/core').AgentLoop;

    const tool = createMixtureOfAgentsTool(loop);
    await tool.execute(
      { agents: [{ prompt: 'a' }, { prompt: 'b' }] },
      makeCtx({ agentId: 'depth:1' }),
    );

    expect(seenAgentIds).toEqual(['depth:2', 'depth:2']);
  });
});

// ---------------------------------------------------------------------------
// mixture_of_agents
// ---------------------------------------------------------------------------

describe('mixture_of_agents', () => {
  it('runs agents in parallel and combines outputs', async () => {
    const loop = makeLoop({
      research: 'Research findings here.',
      review: 'Review notes here.',
    });
    const tool = createMixtureOfAgentsTool(loop);

    const result = await tool.execute(
      {
        agents: [
          { prompt: 'Please research this topic.', label: 'Researcher' },
          { prompt: 'Please review this code.', label: 'Reviewer' },
        ],
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('Researcher');
      expect(result.value).toContain('Reviewer');
    }
  });

  it('returns input_invalid when agents array is empty', async () => {
    const tool = createMixtureOfAgentsTool(makeLoop());
    const result = await tool.execute({ agents: [] }, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('returns input_invalid when more than 5 agents', async () => {
    const tool = createMixtureOfAgentsTool(makeLoop());
    const agents = Array.from({ length: 6 }, (_, i) => ({ prompt: `task ${i}` }));
    const result = await tool.execute({ agents }, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Maximum 5');
  });

  it('blocks at max spawn depth', async () => {
    const tool = createMixtureOfAgentsTool(makeLoop());
    const result = await tool.execute(
      { agents: [{ prompt: 'task' }] },
      makeCtx({ agentId: 'depth:3' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Maximum spawn depth');
  });

  it('synthesises results when synthesis_prompt is provided', async () => {
    const loop = {
      run: async function* (prompt: string): AsyncGenerator<AgentEvent> {
        const text = prompt.includes('Synthesise')
          ? 'Final synthesised answer.'
          : `Agent output for: ${prompt.slice(0, 20)}`;
        yield { type: 'text_delta', text };
        yield { type: 'done', text, turnCount: 1 };
      },
    } as unknown as import('@ethosagent/core').AgentLoop;

    const tool = createMixtureOfAgentsTool(loop);
    const result = await tool.execute(
      {
        agents: [{ prompt: 'Do task A.' }, { prompt: 'Do task B.' }],
        synthesis_prompt: 'Synthesise these outputs.',
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('Synthesis');
      expect(result.value).toContain('Final synthesised answer.');
    }
  });

  it('still returns partial results if some agents fail', async () => {
    let callCount = 0;
    const loop = {
      run: async function* (): AsyncGenerator<AgentEvent> {
        callCount++;
        if (callCount === 1) throw new Error('Agent 1 failed');
        yield { type: 'text_delta', text: 'Agent 2 succeeded.' };
        yield { type: 'done', text: 'done', turnCount: 1 };
      },
    } as unknown as import('@ethosagent/core').AgentLoop;

    const tool = createMixtureOfAgentsTool(loop);
    const result = await tool.execute(
      {
        agents: [
          { prompt: 'Task 1', label: 'A' },
          { prompt: 'Task 2', label: 'B' },
        ],
      },
      makeCtx(),
    );

    // One succeeded, one failed — should return the successful one
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('Agent 2 succeeded.');
  });
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

describe('createDelegationTools', () => {
  it('returns both tools', () => {
    const tools = createDelegationTools(makeLoop());
    const names = tools.map((t) => t.name);
    expect(names).toContain('delegate_task');
    expect(names).toContain('mixture_of_agents');
  });

  it('both tools belong to delegation toolset', () => {
    const tools = createDelegationTools(makeLoop());
    for (const tool of tools) {
      expect(tool.toolset).toBe('delegation');
    }
  });
});
