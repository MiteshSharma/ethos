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
  const injectors: ContextInjector[] = [];
  return {
    pluginId,
    registerTool: () => {},
    registerVoidHook: () => {},
    registerModifyingHook: () => {},
    registerInjector(inj: ContextInjector) {
      registries.injectors.push(inj);
      injectors.push(inj);
    },
    registerPersonality: (cfg: import('@ethosagent/types').PersonalityConfig) =>
      registries.personalities.define(cfg),
    _cleanup() {
      for (const inj of injectors) {
        const idx = registries.injectors.indexOf(inj);
        if (idx >= 0) registries.injectors.splice(idx, 1);
      }
    },
  };
}

const baseCtx = {
  sessionId: 'test',
  sessionKey: 'cli:test',
  platform: 'cli',
  model: 'claude-opus-4-7',
  history: [],
  workingDir: '/tmp',
  isDm: true,
  turnNumber: 1,
};

describe('strategist personality plugin', () => {
  let registries: ReturnType<typeof makeRegistries>;
  let api: ReturnType<typeof makeApi>;

  beforeEach(() => {
    registries = makeRegistries();
    api = makeApi('strategist-plugin', registries);
    activate(api);
  });

  afterEach(() => {
    deactivate();
    api._cleanup();
  });

  it('registers the strategist personality', () => {
    const p = registries.personalities.get('strategist');
    expect(p).toBeDefined();
    expect(p?.name).toBe('Strategist');
    expect(p?.model).toBe('claude-opus-4-7');
    expect(p?.memoryScope).toBe('global');
  });

  it('strategist toolset contains web and memory tools', () => {
    const p = registries.personalities.get('strategist');
    expect(p?.toolset).toContain('web_search');
    expect(p?.toolset).toContain('memory_read');
  });

  it('registers two context injectors', () => {
    const ids = registries.injectors.map((i) => i.id);
    expect(ids).toContain('strategist-identity');
    expect(ids).toContain('strategist-skills');
  });

  it('identity injector has higher priority than skills injector', () => {
    const identity = registries.injectors.find((i) => i.id === 'strategist-identity');
    const skills = registries.injectors.find((i) => i.id === 'strategist-skills');
    expect(identity?.priority).toBeGreaterThan(skills?.priority);
  });

  it('identity injector fires for strategist personality', async () => {
    const injector = registries.injectors.find((i) => i.id === 'strategist-identity');
    expect(injector?.shouldInject?.({ ...baseCtx, personalityId: 'strategist' })).toBe(true);
    expect(injector?.shouldInject?.({ ...baseCtx, personalityId: 'researcher' })).toBe(false);
  });

  it('identity content includes core framework language', async () => {
    const injector = registries.injectors.find((i) => i.id === 'strategist-identity');
    const result = await injector?.inject({ ...baseCtx, personalityId: 'strategist' });
    expect(result?.content).toContain('Strategist');
    expect(result?.content).toContain('core constraint');
    expect(result?.position).toBe('prepend');
  });

  it('skills content includes strategic frameworks', async () => {
    const injector = registries.injectors.find((i) => i.id === 'strategist-skills');
    const result = await injector?.inject({ ...baseCtx, personalityId: 'strategist' });
    expect(result?.content).toContain('Five Whys');
    expect(result?.content).toContain('Reversibility test');
  });

  it('injectors are removed on cleanup', () => {
    api._cleanup();
    const ids = registries.injectors.map((i) => i.id);
    expect(ids).not.toContain('strategist-identity');
    expect(ids).not.toContain('strategist-skills');
  });
});
