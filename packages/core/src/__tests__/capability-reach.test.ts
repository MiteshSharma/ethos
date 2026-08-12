import type { PersonalityConfig, Tool, ToolCapabilities } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { toolsDeclaringNetwork } from '../capability-reach';
import { DefaultToolRegistry } from '../tool-registry';

function makeTool(name: string, capabilities: ToolCapabilities = {}): Tool {
  return {
    name,
    description: `${name} fixture`,
    schema: { type: 'object', properties: {} },
    capabilities,
    execute: async () => ({ ok: true, value: 'ok' }),
  };
}

function makeRegistry(): DefaultToolRegistry {
  const registry = new DefaultToolRegistry();
  registry.registerAll([
    makeTool('read_file'),
    makeTool('memory_read'),
    makeTool('web_search', { network: { allowedHosts: ['api.exa.ai'] } }),
    makeTool('web_extract', { network: { allowedHosts: ['*'] } }),
    makeTool('terminal', { process: { allowedBinaries: ['*'] } }),
    makeTool('mcp__linear__list_issues', { network: { allowedHosts: ['*'] } }),
  ]);
  registry.register(makeTool('plugin_fetch', { network: { allowedHosts: ['*'] } }), {
    pluginId: 'some-plugin',
  });
  return registry;
}

describe('toolsDeclaringNetwork', () => {
  const registry = makeRegistry();

  it('returns only the toolset tools that declare network reach, sorted', () => {
    const personality: Pick<PersonalityConfig, 'toolset'> = {
      toolset: ['web_extract', 'read_file', 'web_search', 'terminal'],
    };
    expect(toolsDeclaringNetwork(personality, registry)).toEqual(['web_extract', 'web_search']);
  });

  it('is empty for a personality holding no network-declaring tool', () => {
    expect(toolsDeclaringNetwork({ toolset: ['read_file', 'memory_read'] }, registry)).toEqual([]);
  });

  it('excludes MCP and plugin tools — their gates are mcp_servers / plugins', () => {
    expect(toolsDeclaringNetwork({ toolset: [] }, registry)).toEqual([]);
  });

  it('reports every registered network tool when no toolset is declared', () => {
    expect(toolsDeclaringNetwork({}, registry)).toEqual(['web_extract', 'web_search']);
  });
});
