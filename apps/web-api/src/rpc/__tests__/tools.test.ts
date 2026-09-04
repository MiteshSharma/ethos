import type { Tool } from '@ethosagent/types';
import { call } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';
import { toolsRouter } from '../tools';

// Contract conformance for `tools.detail` / `tools.test`: `call()` runs the
// oRPC output validator, so these guard the shape the UI codes against. The
// mapping and the safety gate itself are exercised directly in
// `services/__tests__/tool-inspection.test.ts`.

const SCHEMA = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };

function makeContext(tools: Tool[], toolset?: string[]) {
  const map = new Map(tools.map((t) => [t.name, t]));
  const executeParallel = vi.fn(async (calls: Array<{ toolCallId: string; name: string }>) =>
    calls.map((c) => ({ ...c, result: { ok: true as const, value: 'ran' }, durationMs: 7 })),
  );
  const context = {
    toolRegistry: {
      get: (name: string) => map.get(name),
      getAvailable: () => [...map.values()],
      getPluginId: () => undefined,
      executeParallel,
    },
    personalities: {
      get: async () => ({
        personality: {
          id: 'scout',
          name: 'Scout',
          toolset: toolset ?? tools.map((t) => t.name),
          fs_reach: null,
        },
      }),
    },
  } as never;
  return { context, executeParallel };
}

const safeTool: Tool = {
  name: 'web_search',
  description: 'Search the web.',
  toolset: 'web',
  schema: SCHEMA,
  capabilities: { network: { allowedHosts: ['api.exa.ai'] } },
  maxResultChars: 8000,
  outputIsUntrusted: true,
  execute: async () => ({ ok: true, value: 'unused' }),
};

describe('tools.detail', () => {
  it('answers an unregistered name without throwing', async () => {
    const { context } = makeContext([]);
    const out = await call(toolsRouter.detail, { name: 'ghost' }, { context });
    expect(out).toMatchObject({ name: 'ghost', registered: false, available: false });
  });

  it('emits the full detail shape for a registered tool', async () => {
    const { context } = makeContext([safeTool]);
    const input = { name: 'web_search', personalityId: 'scout' };
    const out = await call(toolsRouter.detail, input, { context });

    expect(out).toEqual({
      name: 'web_search',
      description: 'Search the web.',
      toolset: 'web',
      group: 'Web',
      schema: SCHEMA,
      capabilities: { network: { allowedHosts: ['api.exa.ai'] } },
      maxResultChars: 8000,
      outputIsUntrusted: true,
      hasSettingsSchema: false,
      registered: true,
      available: true,
      inPersonalityToolset: true,
      // Network reach alone does not disqualify a tool from execution.
      testEligibility: { canRun: true },
    });
  });
});

describe('tools.test', () => {
  it('degrades a mode:run request for an approval-gated tool', async () => {
    const gated: Tool = { ...safeTool, name: 'deploy', requiresApproval: true };
    const { context, executeParallel } = makeContext([gated]);

    const input = { name: 'deploy', personalityId: 'scout', mode: 'run' } as const;
    const out = await call(toolsRouter.test, input, { context });

    expect(executeParallel).not.toHaveBeenCalled();
    expect(out.ran).toBe(false);
    expect(out.result).toBeUndefined();
    expect(out.testEligibility.canRun).toBe(false);
    const ids = ['registered', 'available', 'in-toolset', 'args-valid'];
    expect(out.checks.map((c) => c.id)).toEqual(ids);
  });

  it('emits the executed shape for an eligible tool', async () => {
    const { context, executeParallel } = makeContext([safeTool]);

    const input = { name: 'web_search', personalityId: 'scout', mode: 'run' } as const;
    const out = await call(toolsRouter.test, input, { context });

    expect(executeParallel).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({
      ran: true,
      result: { ok: true, value: 'ran' },
      durationMs: 7,
      testEligibility: { canRun: true },
    });
  });
});
