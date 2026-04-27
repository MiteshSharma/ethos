/**
 * Integration test: safety-adapter plugin loaded into real registries.
 * Verifies the before_tool_call hook actually prevents execution.
 */

import {
  DefaultHookRegistry,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
} from '@ethosagent/core';
import type { ContextInjector } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activate, deactivate } from '../index';

function makeRegistries() {
  const injectors: ContextInjector[] = [];
  return {
    tools: new DefaultToolRegistry(),
    hooks: new DefaultHookRegistry(),
    injectors,
    personalities: new DefaultPersonalityRegistry(),
  };
}

function makeApi(pluginId: string, registries: ReturnType<typeof makeRegistries>) {
  return {
    pluginId,
    registerTool: (tool: import('@ethosagent/types').Tool) => registries.tools.register(tool),
    registerVoidHook<K extends keyof import('@ethosagent/types').VoidHooks>(
      name: K,
      handler: (payload: import('@ethosagent/types').VoidHooks[K]) => Promise<void>,
    ) {
      registries.hooks.registerVoid(name, handler, { pluginId });
    },
    registerModifyingHook<K extends keyof import('@ethosagent/types').ModifyingHooks>(
      name: K,
      handler: (
        payload: import('@ethosagent/types').ModifyingHooks[K][0],
      ) => Promise<Partial<import('@ethosagent/types').ModifyingHooks[K][1]> | null>,
    ) {
      registries.hooks.registerModifying(name, handler, { pluginId });
    },
    registerInjector: (inj: ContextInjector) => registries.injectors.push(inj),
    registerPersonality: (cfg: import('@ethosagent/types').PersonalityConfig) =>
      registries.personalities.define(cfg),
    _cleanup() {
      registries.hooks.unregisterPlugin(pluginId);
    },
  };
}

describe('safety-adapter — integration', () => {
  let registries: ReturnType<typeof makeRegistries>;
  let api: ReturnType<typeof makeApi>;

  beforeEach(() => {
    registries = makeRegistries();
    api = makeApi('safety-adapter', registries);
    activate(api);
  });

  afterEach(() => {
    deactivate();
    api._cleanup();
  });

  it('before_tool_call hook blocks rm -rf /', async () => {
    const result = await registries.hooks.fireModifying('before_tool_call', {
      sessionId: 'test',
      toolName: 'terminal',
      args: { command: 'rm -rf /' },
    });

    expect(result.error).toBeDefined();
    expect(result.error).toContain('safety-adapter');
  });

  it('before_tool_call hook passes safe commands', async () => {
    const result = await registries.hooks.fireModifying('before_tool_call', {
      sessionId: 'test',
      toolName: 'terminal',
      args: { command: 'echo hello' },
    });

    expect(result.error).toBeUndefined();
  });

  it('before_prompt_build hook prepends safety section', async () => {
    const result = await registries.hooks.fireModifying('before_prompt_build', {
      sessionId: 'test',
      personalityId: 'researcher',
      history: [],
    });

    expect(result.prependSystem).toBeDefined();
    expect(result.prependSystem).toContain('Safety Rules');
    expect(result.prependSystem).toContain('dry-run');
  });

  it('hook is removed after cleanup', async () => {
    api._cleanup();

    const result = await registries.hooks.fireModifying('before_tool_call', {
      sessionId: 'test',
      toolName: 'terminal',
      args: { command: 'rm -rf /' },
    });

    // After cleanup, the hook is gone — no error returned
    expect(result.error).toBeUndefined();
  });
});
