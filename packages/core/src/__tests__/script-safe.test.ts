import type { PersonalityConfig, Tool } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  type ScriptExclusionCategory,
  scriptCallableFor,
  scriptExclusionError,
  scriptExclusionFor,
} from '../script-safe';
import { DefaultToolRegistry } from '../tool-registry';

function makeTool(name: string, toolset?: string): Tool {
  return {
    name,
    ...(toolset !== undefined && { toolset }),
    description: `${name} fixture`,
    schema: { type: 'object', properties: {} },
    capabilities: {},
    execute: async () => ({ ok: true, value: 'ok' }),
  };
}

function makePersonality(toolset?: string[]): Pick<PersonalityConfig, 'toolset'> {
  return toolset ? { toolset } : {};
}

/** Registry with one tool from every exclusion category plus safe tools. */
function makeRegistry(): DefaultToolRegistry {
  const registry = new DefaultToolRegistry();
  registry.registerAll([
    makeTool('read_file', 'file'),
    makeTool('web_search', 'web'),
    makeTool('memory_read', 'memory'),
    makeTool('run_code', 'code'),
    makeTool('run_tests', 'code'),
    makeTool('lint', 'code'),
    makeTool('delegate_task', 'delegation'),
    makeTool('dispatch_team', 'delegation'),
    makeTool('task_status', 'delegation'),
    makeTool('mcp__linear__list_issues'),
    makeTool('clarify', 'interactive'),
  ]);
  registry.register(makeTool('plugin_tool'), { pluginId: 'some-plugin' });
  return registry;
}

describe('scriptCallableFor', () => {
  it('derives toolset ∩ SCRIPT_SAFE as a pure function — equal on repeated calls', () => {
    const registry = makeRegistry();
    const personality = makePersonality([
      'read_file',
      'web_search',
      'run_code',
      'delegate_task',
      'clarify',
    ]);
    // The bridge (Lane B) and the character sheet (Lane G) each call this
    // independently — the two derivations must be identical.
    const forBridge = scriptCallableFor(personality, registry);
    const forCharacterSheet = scriptCallableFor(personality, registry);
    expect(forBridge).toEqual(forCharacterSheet);
    expect(forBridge).toEqual(['read_file', 'web_search']);
  });

  it('returns an empty surface when run_code is not in the toolset — the gate is the toolset', () => {
    const registry = makeRegistry();
    const personality = makePersonality(['read_file', 'web_search', 'delegate_task']);
    expect(scriptCallableFor(personality, registry)).toEqual([]);
  });

  it('returns an empty surface when run_code is not registered at all', () => {
    const registry = new DefaultToolRegistry();
    registry.register(makeTool('read_file', 'file'));
    expect(scriptCallableFor(makePersonality(['read_file', 'run_code']), registry)).toEqual([]);
  });

  it('an unrestricted personality (no toolset) still excludes every SCRIPT_SAFE category', () => {
    const registry = makeRegistry();
    const surface = scriptCallableFor(makePersonality(), registry);
    expect(surface).toEqual(['memory_read', 'read_file', 'web_search']);
    // Excluded categories never leak in, allowlist or not.
    for (const excluded of [
      'run_code',
      'run_tests',
      'lint',
      'delegate_task',
      'dispatch_team',
      'task_status',
      'mcp__linear__list_issues',
      'plugin_tool',
      'clarify',
    ]) {
      expect(surface).not.toContain(excluded);
    }
  });
});

describe('scriptExclusionFor — per-category mapping', () => {
  const cases: Array<{
    name: string;
    meta: { toolset?: string; pluginId?: string };
    category: ScriptExclusionCategory;
  }> = [
    { name: 'run_code', meta: { toolset: 'code' }, category: 'code' },
    { name: 'run_tests', meta: { toolset: 'code' }, category: 'code' },
    { name: 'lint', meta: { toolset: 'code' }, category: 'code' },
    { name: 'delegate_task', meta: { toolset: 'delegation' }, category: 'delegation' },
    { name: 'mixture_of_agents', meta: { toolset: 'delegation' }, category: 'delegation' },
    { name: 'route_to_agent', meta: { toolset: 'delegation' }, category: 'delegation' },
    { name: 'dispatch_team', meta: { toolset: 'delegation' }, category: 'delegation' },
    { name: 'broadcast_to_agents', meta: { toolset: 'delegation' }, category: 'delegation' },
    { name: 'task_status', meta: { toolset: 'delegation' }, category: 'delegation' },
    { name: 'task_result', meta: { toolset: 'delegation' }, category: 'delegation' },
    { name: 'task_cancel', meta: { toolset: 'delegation' }, category: 'delegation' },
    { name: 'task_logs', meta: { toolset: 'delegation' }, category: 'delegation' },
    { name: 'mcp__linear__list_issues', meta: {}, category: 'mcp' },
    { name: 'plugin_tool', meta: { pluginId: 'some-plugin' }, category: 'plugin' },
    { name: 'clarify', meta: { toolset: 'interactive' }, category: 'clarify' },
  ];

  for (const c of cases) {
    it(`${c.name} → ${c.category}`, () => {
      expect(scriptExclusionFor(c.name, c.meta)).toBe(c.category);
    });
  }

  it('returns null for script-safe tools', () => {
    expect(scriptExclusionFor('read_file', { toolset: 'file' })).toBeNull();
    expect(scriptExclusionFor('web_search', { toolset: 'web' })).toBeNull();
    expect(scriptExclusionFor('kanban_complete', { toolset: 'kanban' })).toBeNull();
  });
});

describe('scriptExclusionError', () => {
  it('names the exclusion category, not a generic failure', () => {
    const categories: ScriptExclusionCategory[] = [
      'code',
      'delegation',
      'mcp',
      'plugin',
      'clarify',
    ];
    for (const category of categories) {
      const error = scriptExclusionError('some_tool', category);
      expect(error).toContain('some_tool');
      expect(error).toContain(`excluded category: ${category}`);
    }
  });
});
