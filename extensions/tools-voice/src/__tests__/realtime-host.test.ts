import { DefaultToolRegistry } from '@ethosagent/core';
import type { HookRegistry, Tool } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AGENT_CONSULT_TOOL, deriveRealtimeToolset } from '../agent-consult';
import { createRealtimeToolHost, REALTIME_UNKNOWN_TOOL } from '../realtime-host';

// Tools with no loop behind them — this file is about advertising and dispatch,
// not about what a consult returns.
function echoTool(name: string, value: string, toolset = 'voice'): Tool {
  return {
    name,
    description: `echo ${name}`,
    toolset,
    capabilities: {},
    schema: { type: 'object', properties: {} },
    async execute() {
      return { ok: true, value };
    },
  };
}

function registryWith(...tools: Tool[]): DefaultToolRegistry {
  const registry = new DefaultToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}

const dispatchCtx = {
  sessionId: 'row-1',
  sessionKey: 'voice:web:browser:chat-9',
  platform: 'web',
  workingDir: '/tmp',
  abortSignal: new AbortController().signal,
  voiceOrigin: { transport: 'browser-talk-mode', speaker: 'owner' as const },
};

describe('advertised == handled', () => {
  it('every advertised tool dispatches — none answers "unknown tool"', async () => {
    // The real assertion. Comparing two name lists would only prove that one
    // `map()` matches another; what a listener actually depends on is that
    // asking for an advertised tool produces a serviced answer. So this drives
    // each advertised definition through `dispatch` and refuses the refusal.
    const registry = registryWith(
      echoTool(AGENT_CONSULT_TOOL, 'consulted'),
      echoTool('read_file', 'file contents', 'file'),
      echoTool('send_email', 'sent', 'email'),
    );
    const host = createRealtimeToolHost({
      registry,
      personalityToolset: ['read_file', 'send_email'],
      safeTools: new Set(['read_file']),
    });

    expect(host.definitions.length).toBeGreaterThan(0);
    expect(host.handled).toEqual(host.definitions.map((d) => d.name));

    for (const definition of host.definitions) {
      const result = await host.dispatch(
        { callId: `c-${definition.name}`, name: definition.name, args: {} },
        dispatchCtx,
      );
      expect(result.ok, `${definition.name} was advertised but not serviced`).toBe(true);
      expect(result.code).not.toBe(REALTIME_UNKNOWN_TOOL);
    }
  });

  it('refuses a name it never advertised instead of leaving the call hanging', async () => {
    const host = createRealtimeToolHost({
      registry: registryWith(echoTool(AGENT_CONSULT_TOOL, 'x')),
    });

    const result = await host.dispatch({ callId: 'c1', name: 'send_email', args: {} }, dispatchCtx);

    expect(result.ok).toBe(false);
    expect(result.code).toBe(REALTIME_UNKNOWN_TOOL);
  });

  it('offers agent_consult regardless of the personality toolset', () => {
    const host = createRealtimeToolHost({
      registry: registryWith(echoTool(AGENT_CONSULT_TOOL, 'x')),
      personalityToolset: ['read_file'],
    });
    expect(host.handled).toEqual([AGENT_CONSULT_TOOL]);
  });

  it('drops a safe tool the personality does not have', () => {
    const host = createRealtimeToolHost({
      registry: registryWith(echoTool(AGENT_CONSULT_TOOL, 'x'), echoTool('read_file', 'y', 'file')),
      personalityToolset: ['web_search'],
      safeTools: new Set(['read_file']),
    });
    expect(host.handled).toEqual([AGENT_CONSULT_TOOL]);
  });

  it('advertises nothing it does not hold — an unregistered consult is not claimed', () => {
    const host = createRealtimeToolHost({
      registry: registryWith(echoTool('read_file', 'y', 'file')),
    });
    expect(host.handled).toEqual([]);
  });

  it('never advertises an alwaysInclude or MCP tool the allowlist did not name', () => {
    // `toDefinitions` deliberately lets both past its allowlist — on the text
    // path they are gated by `mcp_servers` / `plugins` instead. That is the
    // wrong gate here, and the realtime derivation intersects exactly.
    const always: Tool = { ...echoTool('todo_write', 'y', 'todo'), alwaysInclude: true };
    const mcp = echoTool('mcp__github__create_issue', 'y', 'mcp');
    const host = createRealtimeToolHost({
      registry: registryWith(echoTool(AGENT_CONSULT_TOOL, 'x'), always, mcp),
    });
    expect(host.handled).toEqual([AGENT_CONSULT_TOOL]);
  });

  it('the mint and the control lane derive the same list', () => {
    // Advertised at mint (`deriveRealtimeToolset`) vs handled on the lane
    // (`createRealtimeToolHost`). Two call sites, one derivation.
    const registry = registryWith(
      echoTool(AGENT_CONSULT_TOOL, 'x'),
      echoTool('read_file', 'y', 'file'),
    );
    const personalityToolset = ['read_file'];
    const safeTools = new Set(['read_file']);

    const advertised = deriveRealtimeToolset({ registry, personalityToolset, safeTools });
    const host = createRealtimeToolHost({ registry, personalityToolset, safeTools });

    expect(advertised.map((d) => d.name)).toEqual(host.handled);
  });
});

describe('spoken output', () => {
  it('sanitizes tool output before it can reach the provider', async () => {
    const raw = [
      '<think>the user seems annoyed</think>',
      '## Result',
      'See `/Users/ada/secret/notes.md` and **do not** panic.',
      '```ts',
      'const x = 1;',
      '```',
      'More at https://example.com/a/b?c=d',
    ].join('\n');
    const host = createRealtimeToolHost({
      registry: registryWith(echoTool(AGENT_CONSULT_TOOL, raw)),
    });

    const { output } = await host.dispatch(
      { callId: 'c1', name: AGENT_CONSULT_TOOL, args: {} },
      dispatchCtx,
    );

    expect(output).not.toContain('<think>');
    expect(output).not.toContain('the user seems annoyed');
    expect(output).not.toContain('```');
    expect(output).not.toContain('/Users/ada/secret/notes.md');
    expect(output).not.toContain('https://example.com');
    expect(output).not.toContain('##');
    expect(output).not.toContain('**');
  });

  it('never answers with an empty string', async () => {
    const host = createRealtimeToolHost({
      registry: registryWith(echoTool(AGENT_CONSULT_TOOL, '   ')),
    });
    const { output } = await host.dispatch(
      { callId: 'c1', name: AGENT_CONSULT_TOOL, args: {} },
      dispatchCtx,
    );
    expect(output.trim().length).toBeGreaterThan(0);
  });
});

describe('approval surface', () => {
  it('routes every dispatch through before_tool_call with the voice origin', async () => {
    const seen: unknown[] = [];
    const hooks = {
      async fireModifying(name: string, payload: unknown) {
        if (name === 'before_tool_call') seen.push(payload);
        return {};
      },
    } as unknown as HookRegistry;
    const host = createRealtimeToolHost({
      registry: registryWith(echoTool(AGENT_CONSULT_TOOL, 'ok')),
      hooks,
    });

    await host.dispatch({ callId: 'c1', name: AGENT_CONSULT_TOOL, args: {} }, dispatchCtx);

    expect(seen).toEqual([
      {
        sessionId: 'row-1',
        toolCallId: 'c1',
        toolName: AGENT_CONSULT_TOOL,
        args: {},
        voiceOrigin: { transport: 'browser-talk-mode', speaker: 'owner' },
      },
    ]);
  });

  it('a hook refusal blocks execution and is spoken back', async () => {
    let ran = false;
    const blocked: Tool = {
      ...echoTool('send_email', 'sent', 'email'),
      async execute() {
        ran = true;
        return { ok: true, value: 'sent' };
      },
    };
    const hooks = {
      async fireModifying() {
        return { error: 'send_email was requested out loud — confirm it verbally first' };
      },
    } as unknown as HookRegistry;
    const host = createRealtimeToolHost({
      registry: registryWith(echoTool(AGENT_CONSULT_TOOL, 'x'), blocked),
      hooks,
      personalityToolset: ['send_email'],
      safeTools: new Set(['send_email']),
    });

    const result = await host.dispatch({ callId: 'c1', name: 'send_email', args: {} }, dispatchCtx);

    expect(ran).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('confirm it verbally');
  });
});
