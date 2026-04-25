import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
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
});
