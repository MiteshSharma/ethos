import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { DefaultToolRegistry } from '../tool-registry';

const makeCtx = (): ToolContext => ({
  sessionId: 's1',
  sessionKey: 'cli:default',
  platform: 'cli',
  workingDir: '/tmp',
  currentTurn: 1,
  messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 10_000,
});

const echoTool: Tool = {
  name: 'echo',
  description: 'Echoes input',
  schema: { type: 'object', properties: { text: { type: 'string' } } },
  execute: async (args) => ({ ok: true, value: String((args as { text: string }).text) }),
};

const failTool: Tool = {
  name: 'fail',
  description: 'Always fails',
  schema: { type: 'object' },
  execute: async () => ({ ok: false, error: 'intentional failure', code: 'execution_failed' }),
};

describe('DefaultToolRegistry', () => {
  it('registers and retrieves a tool', () => {
    const reg = new DefaultToolRegistry();
    reg.register(echoTool);
    expect(reg.get('echo')).toBe(echoTool);
  });

  it('returns undefined for unknown tool', () => {
    const reg = new DefaultToolRegistry();
    expect(reg.get('nope')).toBeUndefined();
  });

  it('executeParallel: both tools run, results in input order', async () => {
    const reg = new DefaultToolRegistry();
    reg.register(echoTool);
    reg.register(failTool);

    const results = await reg.executeParallel(
      [
        { toolCallId: 'c1', name: 'echo', args: { text: 'hello' } },
        { toolCallId: 'c2', name: 'fail', args: {} },
      ],
      makeCtx(),
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.toolCallId).toBe('c1');
    expect(results[0]?.result.ok).toBe(true);
    expect(results[1]?.toolCallId).toBe('c2');
    expect(results[1]?.result.ok).toBe(false);
  });

  it('executeParallel: unknown tool returns not_available', async () => {
    const reg = new DefaultToolRegistry();
    const results = await reg.executeParallel(
      [{ toolCallId: 'c1', name: 'ghost', args: {} }],
      makeCtx(),
    );
    const r = results[0]?.result as Extract<ToolResult, { ok: false }>;
    expect(r.ok).toBe(false);
    expect(r.code).toBe('not_available');
  });

  it('toDefinitions: returns all tools when no allowedTools provided', () => {
    const reg = new DefaultToolRegistry();
    reg.register(echoTool);
    reg.register(failTool);
    expect(reg.toDefinitions()).toHaveLength(2);
  });

  it('toDefinitions: filters by allowedTools when provided', () => {
    const reg = new DefaultToolRegistry();
    reg.register(echoTool);
    reg.register(failTool);
    const defs = reg.toDefinitions(['echo']);
    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe('echo');
  });

  it('toDefinitions: returns empty when allowedTools has no matches', () => {
    const reg = new DefaultToolRegistry();
    reg.register(echoTool);
    expect(reg.toDefinitions(['nonexistent'])).toHaveLength(0);
  });

  it('executeParallel: blocked tool returns not_available when not in allowedTools', async () => {
    const reg = new DefaultToolRegistry();
    reg.register(echoTool);
    reg.register(failTool);
    const results = await reg.executeParallel(
      [
        { toolCallId: 'c1', name: 'echo', args: { text: 'hi' } },
        { toolCallId: 'c2', name: 'fail', args: {} },
      ],
      makeCtx(),
      ['echo'],
    );
    expect(results[0]?.result.ok).toBe(true);
    const r = results[1]?.result as Extract<ToolResult, { ok: false }>;
    expect(r.ok).toBe(false);
    expect(r.code).toBe('not_available');
    expect(r.error).toMatch(/not permitted/);
  });

  it('executeParallel: no restriction when allowedTools is undefined', async () => {
    const reg = new DefaultToolRegistry();
    reg.register(echoTool);
    reg.register(failTool);
    const results = await reg.executeParallel(
      [{ toolCallId: 'c1', name: 'echo', args: { text: 'ok' } }],
      makeCtx(),
      undefined,
    );
    expect(results[0]?.result.ok).toBe(true);
  });

  // Toolset isolation contract — these tests exist so a future PR that loosens
  // the filter check at tool-registry.ts:57 fails CI. See plan/IMPROVEMENT.md P0-1.

  it('executeParallel: blocked tools never have execute() invoked (side effect)', async () => {
    const echoExec = vi.fn(async (): Promise<ToolResult> => ({ ok: true, value: 'ran' }));
    const failExec = vi.fn(
      async (): Promise<ToolResult> => ({
        ok: false,
        error: 'should not run',
        code: 'execution_failed',
      }),
    );
    const reg = new DefaultToolRegistry();
    reg.register({ ...echoTool, execute: echoExec });
    reg.register({ ...failTool, execute: failExec });

    await reg.executeParallel(
      [
        { toolCallId: 'c1', name: 'echo', args: { text: 'ok' } },
        { toolCallId: 'c2', name: 'fail', args: {} },
      ],
      makeCtx(),
      ['echo'],
    );

    expect(echoExec).toHaveBeenCalledTimes(1);
    expect(failExec).not.toHaveBeenCalled();
  });

  it('executeParallel: rejected tool result honors Anthropic tool_result contract', async () => {
    // Every tool_use block in an assistant message needs a matching tool_result block
    // when sent back to Anthropic. Rejected tools must surface ok: false with a non-empty
    // error string so the LLM history stays valid.
    const reg = new DefaultToolRegistry();
    reg.register(echoTool);
    const results = await reg.executeParallel(
      [{ toolCallId: 'c1', name: 'echo', args: { text: 'hi' } }],
      makeCtx(),
      ['other_tool'],
    );
    const r = results[0]?.result as Extract<ToolResult, { ok: false }>;
    expect(r.ok).toBe(false);
    expect(r.code).toBe('not_available');
    expect(r.error).toBeTruthy();
    expect(r.error.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // filterOpts gating — Phase 2.1 personality isolation
  // ---------------------------------------------------------------------------

  describe('filterOpts gating', () => {
    const makePluginTool = (name: string, pluginId?: string) => ({
      name,
      description: `tool ${name}`,
      schema: { type: 'object' },
      execute: async (): Promise<{ ok: true; value: string }> => ({ ok: true, value: name }),
      pluginId,
    });

    it('toDefinitions: allowedPlugins=[] blocks plugin tools, keeps built-ins', () => {
      const reg = new DefaultToolRegistry();
      reg.register({
        name: 'builtin',
        description: 'b',
        schema: {},
        execute: async () => ({ ok: true, value: '' }),
      });
      reg.register(
        {
          name: 'plugin_tool',
          description: 'p',
          schema: {},
          execute: async () => ({ ok: true, value: '' }),
        },
        { pluginId: 'p1' },
      );

      const defs = reg.toDefinitions(undefined, { allowedPlugins: [] });
      expect(defs.map((d) => d.name)).toEqual(['builtin']);
    });

    it('toDefinitions: allowedPlugins=[p1] allows p1 tools', () => {
      const reg = new DefaultToolRegistry();
      reg.register({
        name: 'builtin',
        description: 'b',
        schema: {},
        execute: async () => ({ ok: true, value: '' }),
      });
      reg.register(
        {
          name: 'p1_tool',
          description: 'p',
          schema: {},
          execute: async () => ({ ok: true, value: '' }),
        },
        { pluginId: 'p1' },
      );
      reg.register(
        {
          name: 'p2_tool',
          description: 'q',
          schema: {},
          execute: async () => ({ ok: true, value: '' }),
        },
        { pluginId: 'p2' },
      );

      const defs = reg.toDefinitions(undefined, { allowedPlugins: ['p1'] });
      const names = defs.map((d) => d.name);
      expect(names).toContain('builtin');
      expect(names).toContain('p1_tool');
      expect(names).not.toContain('p2_tool');
    });

    it('toDefinitions: allowedMcpServers=[] blocks MCP tools', () => {
      const reg = new DefaultToolRegistry();
      reg.register({
        name: 'builtin',
        description: 'b',
        schema: {},
        execute: async () => ({ ok: true, value: '' }),
      });
      reg.register({
        name: 'mcp__weather__get',
        description: 'm',
        schema: {},
        execute: async () => ({ ok: true, value: '' }),
      });

      const defs = reg.toDefinitions(undefined, { allowedMcpServers: [] });
      expect(defs.map((d) => d.name)).toEqual(['builtin']);
    });

    it('toDefinitions: allowedMcpServers=[weather] allows that MCP server', () => {
      const reg = new DefaultToolRegistry();
      reg.register({
        name: 'mcp__weather__get',
        description: 'w',
        schema: {},
        execute: async () => ({ ok: true, value: '' }),
      });
      reg.register({
        name: 'mcp__calendar__list',
        description: 'c',
        schema: {},
        execute: async () => ({ ok: true, value: '' }),
      });

      const defs = reg.toDefinitions(undefined, { allowedMcpServers: ['weather'] });
      expect(defs.map((d) => d.name)).toEqual(['mcp__weather__get']);
    });

    // Mirrors the engineer scenario: a personality with a fixed toolset.yaml
    // (so allowedTools is non-empty) but no mcp_servers field. The default-deny
    // fix in agent-loop.ts normalises missing mcp_servers to [], so MCP tools
    // must NOT appear in toDefinitions even though their names also aren't
    // present in toolset.yaml. The LLM should not even see them.
    it('toDefinitions: toolset set + allowedMcpServers=[] hides MCP tools from the LLM', () => {
      const reg = new DefaultToolRegistry();
      reg.register({
        name: 'terminal',
        description: 't',
        schema: {},
        execute: async () => ({ ok: true, value: '' }),
      });
      reg.register({
        name: 'read_file',
        description: 'r',
        schema: {},
        execute: async () => ({ ok: true, value: '' }),
      });
      reg.register({
        name: 'mcp__filesystem__list_directory',
        description: 'm',
        schema: {},
        execute: async () => ({ ok: true, value: '' }),
      });

      const defs = reg.toDefinitions(['terminal', 'read_file'], { allowedMcpServers: [] });
      expect(defs.map((d) => d.name).sort()).toEqual(['read_file', 'terminal']);
      expect(defs.map((d) => d.name)).not.toContain('mcp__filesystem__list_directory');
    });

    it('executeParallel: filterOpts blocks plugin tool at execution time', async () => {
      const reg = new DefaultToolRegistry();
      reg.register({
        name: 'builtin',
        description: 'b',
        schema: {},
        execute: async () => ({ ok: true, value: 'ok' }),
      });
      reg.register(
        {
          name: 'p1_tool',
          description: 'p',
          schema: {},
          execute: async () => ({ ok: true, value: 'plugin ran' }),
        },
        { pluginId: 'p1' },
      );

      const results = await reg.executeParallel(
        [
          { toolCallId: 'c1', name: 'builtin', args: {} },
          { toolCallId: 'c2', name: 'p1_tool', args: {} },
        ],
        makeCtx(),
        undefined,
        { allowedPlugins: [] },
      );

      expect(results[0]?.result.ok).toBe(true);
      const r = results[1]?.result as Extract<ToolResult, { ok: false }>;
      expect(r.ok).toBe(false);
      expect(r.code).toBe('not_available');
    });
  });

  it('executeParallel: property — across random allowlists, blocked tools never execute', async () => {
    const allToolNames = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    const reg = new DefaultToolRegistry();
    const counters = new Map<string, ReturnType<typeof vi.fn>>();
    for (const name of allToolNames) {
      const exec = vi.fn(async (): Promise<ToolResult> => ({ ok: true, value: name }));
      counters.set(name, exec);
      reg.register({
        name,
        description: `tool ${name}`,
        schema: { type: 'object' },
        execute: exec,
      });
    }

    for (let scenario = 0; scenario < 100; scenario++) {
      for (const exec of counters.values()) exec.mockClear();

      const allowed = allToolNames.filter(() => Math.random() < 0.5);
      const calls = Array.from({ length: 1 + Math.floor(Math.random() * 5) }, (_, i) => {
        const pick = allToolNames[Math.floor(Math.random() * allToolNames.length)] ?? 'alpha';
        return { toolCallId: `c${i}`, name: pick, args: {} };
      });

      await reg.executeParallel(calls, makeCtx(), allowed.length > 0 ? allowed : undefined);

      for (const name of allToolNames) {
        const expectedCalls =
          allowed.length === 0
            ? calls.filter((c) => c.name === name).length
            : allowed.includes(name)
              ? calls.filter((c) => c.name === name).length
              : 0;
        const exec = counters.get(name);
        expect(exec).toBeDefined();
        if (exec) {
          expect(exec.mock.calls.length).toBe(expectedCalls);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 4.3 — cross-plan integration: MCP filter catches skill+MCP mismatch
//
// A skill that declares `required_tools` from an MCP server should be inert
// if the active personality does not list that server in `mcp_servers`. This
// test exercises the MCP filter directly at the ToolRegistry layer — the
// same gate that AgentLoop threads through on every turn — to catch drift
// between this plan's MCP gating and extension_plan.md's skill filter.
// ---------------------------------------------------------------------------

describe('Phase 4.3 — cross-plan: MCP server gate catches skill+MCP mismatch', () => {
  it('MCP tool is absent from toDefinitions when server is not in personality mcp_servers', () => {
    const reg = new DefaultToolRegistry();

    // Built-in tool — always visible regardless of MCP filter.
    reg.register({
      name: 'read_file',
      description: 'Read a file',
      schema: {},
      execute: async () => ({ ok: true, value: '' }),
    });

    // MCP tool from 'linear' server — would power a skill that reads Linear issues.
    reg.register({
      name: 'mcp__linear__get_issue',
      description: 'Get Linear issue',
      schema: {},
      execute: async () => ({ ok: true, value: '' }),
    });

    // Personality A has linear in its mcp_servers — sees both tools.
    const defsWithLinear = reg.toDefinitions(undefined, { allowedMcpServers: ['linear'] });
    expect(defsWithLinear.map((d) => d.name)).toContain('mcp__linear__get_issue');
    expect(defsWithLinear.map((d) => d.name)).toContain('read_file');

    // Personality B has no mcp_servers — only built-in tools visible.
    // A skill that requires mcp__linear__get_issue is therefore inert for B.
    const defsNoMcp = reg.toDefinitions(undefined, { allowedMcpServers: [] });
    expect(defsNoMcp.map((d) => d.name)).not.toContain('mcp__linear__get_issue');
    expect(defsNoMcp.map((d) => d.name)).toContain('read_file');
  });

  it('MCP tool is blocked at execution time even when called by name — belt-and-suspenders', async () => {
    const reg = new DefaultToolRegistry();
    const executed = vi.fn(async (): Promise<ToolResult> => ({ ok: true, value: 'ran' }));
    reg.register({
      name: 'mcp__linear__get_issue',
      description: 'Get Linear issue',
      schema: {},
      execute: executed,
    });

    // Attempt to call the MCP tool while the filter blocks the server.
    const results = await reg.executeParallel(
      [{ toolCallId: 'c1', name: 'mcp__linear__get_issue', args: {} }],
      makeCtx(),
      undefined,
      { allowedMcpServers: [] },
    );

    // Tool was NOT executed; error result surfaced to the LLM as is_error.
    expect(executed).not.toHaveBeenCalled();
    const r = results[0]?.result as Extract<ToolResult, { ok: false }>;
    expect(r.ok).toBe(false);
    expect(r.code).toBe('not_available');
  });
});
