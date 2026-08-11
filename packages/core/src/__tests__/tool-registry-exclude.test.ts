// Surface exclusion (`ToolFilterOpts.excludeTools`) — the gateway drops
// UI-card tools on channel adapters. Unlike the personality toolset, this gate
// is a SURFACE policy: it outranks `alwaysInclude` and applies to MCP and
// plugin tools too. Law L8 requires enforcement at definition time AND
// execution time, so both halves are asserted here.

import type { Tool, ToolContext, ToolFilterOpts, ToolResult } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { DefaultToolRegistry } from '../tool-registry';

function makeTool(name: string, extra: Partial<Tool> = {}): Tool {
  return {
    name,
    description: `test tool ${name}`,
    schema: {},
    toolset: 'test',
    capabilities: {},
    execute: async () => ({ ok: true, value: 'ok' }) as ToolResult,
    ...extra,
  };
}

function ctx(): ToolContext {
  return {
    sessionId: 'test',
    sessionKey: 'test',
    platform: 'telegram',
    workingDir: '/tmp',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
  };
}

const EXCLUDE: ToolFilterOpts = { excludeTools: ['emit_card', 'render_ui'] };

describe('ToolFilterOpts.excludeTools — definition time', () => {
  it('drops an excluded tool the personality toolset explicitly lists', () => {
    const reg = new DefaultToolRegistry();
    reg.register(makeTool('emit_card'));
    reg.register(makeTool('read_file'));

    const names = reg.toDefinitions(['emit_card', 'read_file'], EXCLUDE).map((d) => d.name);
    expect(names).not.toContain('emit_card');
    expect(names).toContain('read_file');
  });

  it('drops an excluded tool that declares alwaysInclude', () => {
    const reg = new DefaultToolRegistry();
    reg.register(makeTool('render_ui', { alwaysInclude: true }));

    const names = reg.toDefinitions([], EXCLUDE).map((d) => d.name);
    expect(names).not.toContain('render_ui');
  });

  it('drops an excluded plugin tool that the plugin allowlist admits', () => {
    const reg = new DefaultToolRegistry();
    reg.register(makeTool('emit_card'), { pluginId: 'cards' });

    const names = reg
      .toDefinitions(undefined, { allowedPlugins: ['cards'], ...EXCLUDE })
      .map((d) => d.name);
    expect(names).not.toContain('emit_card');
  });

  it('excludeTools undefined → nothing is dropped', () => {
    const reg = new DefaultToolRegistry();
    reg.register(makeTool('emit_card'));

    const names = reg.toDefinitions(['emit_card'], { allowedPlugins: [] }).map((d) => d.name);
    expect(names).toContain('emit_card');
  });
});

describe('ToolFilterOpts.excludeTools — execution time', () => {
  it('rejects an excluded tool with code not_available', async () => {
    const reg = new DefaultToolRegistry();
    reg.register(makeTool('emit_card'));
    reg.register(makeTool('read_file'));

    const results = await reg.executeParallel(
      [
        { toolCallId: '1', name: 'emit_card', args: {} },
        { toolCallId: '2', name: 'read_file', args: {} },
      ],
      ctx(),
      ['emit_card', 'read_file'],
      EXCLUDE,
    );

    const excluded = results.find((r) => r.name === 'emit_card');
    expect(excluded?.result.ok).toBe(false);
    if (excluded && !excluded.result.ok) {
      expect(excluded.result.code).toBe('not_available');
      expect(excluded.result.error).toContain('not available on this surface');
    }
    expect(results.find((r) => r.name === 'read_file')?.result.ok).toBe(true);
  });

  it('rejects an excluded tool that declares alwaysInclude', async () => {
    const reg = new DefaultToolRegistry();
    reg.register(makeTool('render_ui', { alwaysInclude: true }));

    const results = await reg.executeParallel(
      [{ toolCallId: '1', name: 'render_ui', args: {} }],
      ctx(),
      [],
      EXCLUDE,
    );

    const only = results[0];
    expect(only?.result.ok).toBe(false);
    if (only && !only.result.ok) expect(only.result.code).toBe('not_available');
  });
});
