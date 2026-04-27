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
