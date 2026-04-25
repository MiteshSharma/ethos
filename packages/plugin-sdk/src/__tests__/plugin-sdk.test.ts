import {
  DefaultHookRegistry,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
} from '@ethosagent/core';
import { describe, expect, it } from 'vitest';
import { PluginApiImpl } from '../index';
import { createTestRuntime, mockLLM, mockTool } from '../testing';
import { defineTool, err, ok } from '../tool-helpers';

function makeRegistries() {
  const injectors: import('@ethosagent/types').ContextInjector[] = [];
  return {
    tools: new DefaultToolRegistry(),
    hooks: new DefaultHookRegistry(),
    injectors,
    personalities: new DefaultPersonalityRegistry(),
  };
}

// ---------------------------------------------------------------------------
// tool-helpers
// ---------------------------------------------------------------------------

describe('ok / err', () => {
  it('ok returns success result', () => {
    const result = ok('hello');
    expect(result).toEqual({ ok: true, value: 'hello' });
  });

  it('err returns failure result with default code', () => {
    const result = err('something broke');
    expect(result).toEqual({ ok: false, error: 'something broke', code: 'execution_failed' });
  });

  it('err accepts explicit code', () => {
    const result = err('bad args', 'input_invalid');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });
});

describe('defineTool', () => {
  it('returns a valid Tool object', () => {
    const tool = defineTool<{ query: string }>({
      name: 'test_tool',
      description: 'A test tool',
      schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      async execute({ query }) {
        return ok(`Result: ${query}`);
      },
    });

    expect(tool.name).toBe('test_tool');
    expect(tool.description).toBe('A test tool');
  });
});

// ---------------------------------------------------------------------------
// PluginApiImpl
// ---------------------------------------------------------------------------

describe('PluginApiImpl.registerTool', () => {
  it('registers tool into tool registry', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('test-plugin', registries);

    api.registerTool(mockTool('my_tool', 'result'));

    expect(registries.tools.get('my_tool')).toBeDefined();
    expect(registries.tools.getAvailable().map((t) => t.name)).toContain('my_tool');
  });

  it('cleanup removes the registered tool', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('test-plugin', registries);

    api.registerTool(mockTool('my_tool', 'result'));
    expect(registries.tools.get('my_tool')).toBeDefined();

    api.cleanup();
    expect(registries.tools.get('my_tool')).toBeUndefined();
  });
});

describe('PluginApiImpl.registerVoidHook', () => {
  it('registers a void hook that fires', async () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('test-plugin', registries);

    let fired = false;
    api.registerVoidHook('agent_done', async () => {
      fired = true;
    });

    await registries.hooks.fireVoid('agent_done', {
      sessionId: 'test',
      text: 'hello',
      turnCount: 1,
    });

    expect(fired).toBe(true);
  });

  it('cleanup removes the hook', async () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('test-plugin', registries);

    let fired = false;
    api.registerVoidHook('agent_done', async () => {
      fired = true;
    });

    api.cleanup();

    await registries.hooks.fireVoid('agent_done', {
      sessionId: 'test',
      text: 'hello',
      turnCount: 1,
    });

    expect(fired).toBe(false);
  });
});

describe('PluginApiImpl.registerInjector', () => {
  it('adds injector to the shared array', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('test-plugin', registries);

    const injector: import('@ethosagent/types').ContextInjector = {
      id: 'test',
      priority: 50,
      async inject() {
        return { content: 'test content', position: 'append' };
      },
    };

    api.registerInjector(injector);
    expect(registries.injectors).toContain(injector);
  });

  it('cleanup removes the injector from the shared array', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('test-plugin', registries);

    const injector: import('@ethosagent/types').ContextInjector = {
      id: 'test',
      priority: 50,
      async inject() {
        return null;
      },
    };

    api.registerInjector(injector);
    api.cleanup();
    expect(registries.injectors).not.toContain(injector);
  });
});

// ---------------------------------------------------------------------------
// testing utilities
// ---------------------------------------------------------------------------

describe('mockLLM', () => {
  it('streams the given response', async () => {
    const llm = mockLLM(['Hello world']);
    const chunks: string[] = [];

    for await (const chunk of llm.complete([], [], {})) {
      if (chunk.type === 'text_delta') chunks.push(chunk.text);
    }

    expect(chunks.join('')).toBe('Hello world');
  });

  it('cycles through responses', async () => {
    const llm = mockLLM(['First', 'Second']);
    const collect = async () => {
      const chunks: string[] = [];
      for await (const chunk of llm.complete([], [], {})) {
        if (chunk.type === 'text_delta') chunks.push(chunk.text);
      }
      return chunks.join('');
    };

    expect(await collect()).toBe('First');
    expect(await collect()).toBe('Second');
    expect(await collect()).toBe('First'); // wraps
  });
});

describe('mockTool', () => {
  it('returns fixed string result', async () => {
    const tool = mockTool('search', 'found results');
    const ctx = {
      sessionId: 'test',
      sessionKey: 'cli:test',
      platform: 'cli',
      workingDir: '/tmp',
      currentTurn: 1,
      messageCount: 1,
      abortSignal: new AbortController().signal,
      emit: () => {},
      resultBudgetChars: 80_000,
    };
    const result = await tool.execute({}, ctx);
    expect(result).toEqual({ ok: true, value: 'found results' });
  });

  it('accepts ToolResult directly', async () => {
    const tool = mockTool('bad', { ok: false, error: 'nope', code: 'not_available' });
    const ctx = {
      sessionId: 'test',
      sessionKey: 'cli:test',
      platform: 'cli',
      workingDir: '/tmp',
      currentTurn: 1,
      messageCount: 1,
      abortSignal: new AbortController().signal,
      emit: () => {},
      resultBudgetChars: 80_000,
    };
    const result = await tool.execute({}, ctx);
    expect(result.ok).toBe(false);
  });
});

describe('createTestRuntime', () => {
  it('creates an AgentLoop that emits done', async () => {
    const loop = createTestRuntime({ llm: mockLLM(['Hi!']) });
    const events: string[] = [];

    for await (const event of loop.run('hello')) {
      events.push(event.type);
    }

    expect(events).toContain('text_delta');
    expect(events).toContain('done');
  });
});
