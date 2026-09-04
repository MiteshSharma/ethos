import type { Tool, ToolRegistry } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import {
  describeTool,
  evaluateTestEligibility,
  groupFor,
  runToolTest,
  type ToolTestPersonality,
} from '../tool-inspection';

// The load-bearing behaviour here is the safety gate: a tool that can write,
// spawn, or needs approval must never be executed by a verification click, no
// matter what `mode` the browser asked for.

function makeTool(overrides: Partial<Tool> & { name: string }): Tool {
  return {
    description: 'A tool.',
    schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    capabilities: {},
    execute: async () => ({ ok: true, value: 'unused' }),
    ...overrides,
  };
}

function makeRegistry(tools: Tool[], executeParallel?: ReturnType<typeof vi.fn>) {
  const map = new Map(tools.map((t) => [t.name, t]));
  const exec =
    executeParallel ??
    vi.fn(async (calls: Array<{ toolCallId: string; name: string }>) =>
      calls.map((c) => ({
        toolCallId: c.toolCallId,
        name: c.name,
        result: { ok: true as const, value: 'ran' },
        durationMs: 7,
      })),
    );
  const registry = {
    get: (name: string) => map.get(name),
    getAvailable: () => [...map.values()],
    getPluginId: () => undefined,
    executeParallel: exec,
  } as unknown as ToolRegistry;
  return { registry, exec };
}

function person(toolset: string[] | null): ToolTestPersonality {
  return { id: 'scout', name: 'Scout', toolset, fs_reach: null };
}

describe('groupFor', () => {
  it('capitalises the toolset and falls back to Other', () => {
    expect(groupFor('web')).toBe('Web');
    expect(groupFor(undefined)).toBe('Other');
  });
});

describe('evaluateTestEligibility', () => {
  const ineligible: Array<[string, Partial<Tool>, string]> = [
    [
      'declares filesystem write reach',
      { capabilities: { fs_reach: { read: ['/a'], write: ['/a'] } } },
      'filesystem write',
    ],
    [
      'inherits write reach from the personality',
      { capabilities: { fs_reach: { write: 'from-personality' } } },
      'filesystem write',
    ],
    [
      'declares a process capability',
      { capabilities: { process: { allowedBinaries: ['git'] } } },
      'process',
    ],
    ['requires approval', { requiresApproval: true }, 'approval'],
    [
      'writes personality-scoped storage',
      { capabilities: { storage: { scope: 'personality', kind: 'kv' } } },
      'personality-scoped storage',
    ],
    [
      'writes session-scoped storage',
      { capabilities: { storage: { scope: 'session', kind: 'kv' } } },
      'session-scoped storage',
    ],
  ];

  for (const [label, overrides, reason] of ineligible) {
    it(`refuses a tool that ${label}`, () => {
      const out = evaluateTestEligibility(makeTool({ name: 'danger', ...overrides }));
      expect(out.canRun).toBe(false);
      expect(out.reason).toContain(reason);
    });
  }

  it('allows an empty write array, tool-private storage, and network reach', () => {
    const tool = makeTool({
      name: 'safe',
      capabilities: {
        fs_reach: { read: ['/a'], write: [] },
        storage: { scope: 'tool-private', kind: 'kv' },
        network: { allowedHosts: ['api.exa.ai'] },
      },
    });
    expect(evaluateTestEligibility(tool)).toEqual({ canRun: true });
  });
});

describe('describeTool', () => {
  it('returns registered:false, well-formed, for an unknown name', () => {
    const { registry } = makeRegistry([]);
    expect(describeTool(registry, 'ghost')).toEqual({
      name: 'ghost',
      description: '',
      group: 'Other',
      schema: {},
      capabilities: {},
      hasSettingsSchema: false,
      registered: false,
      available: false,
      testEligibility: { canRun: false, reason: 'Tool is not registered.' },
    });
  });

  it('still reports a toolset entry the deployment never registered', () => {
    const { registry } = makeRegistry([]);
    const out = describeTool(registry, 'ghost', person(['ghost']));
    expect(out.registered).toBe(false);
    expect(out.inPersonalityToolset).toBe(true);
  });

  it('reports available:false when isAvailable() says no', () => {
    const { registry } = makeRegistry([
      makeTool({ name: 'web_search', toolset: 'web', isAvailable: () => false }),
    ]);
    const out = describeTool(registry, 'web_search');
    expect(out).toMatchObject({ registered: true, available: false, group: 'Web' });
  });

  it('omits inPersonalityToolset when no personality was supplied', () => {
    const { registry } = makeRegistry([makeTool({ name: 'safe' })]);
    expect('inPersonalityToolset' in describeTool(registry, 'safe')).toBe(false);
  });

  it('reports hasSettingsSchema without dumping the schema', () => {
    const { registry } = makeRegistry([makeTool({ name: 'safe', settingsSchema: { fields: [] } })]);
    const out = describeTool(registry, 'safe');
    expect(out.hasSettingsSchema).toBe(true);
    expect('settingsSchema' in out).toBe(false);
  });

  it('degrades to no registry at all', () => {
    expect(describeTool(undefined, 'anything').registered).toBe(false);
  });
});

describe('runToolTest', () => {
  it('fails every downstream check for an unregistered tool', async () => {
    const { registry } = makeRegistry([]);
    const out = await runToolTest(registry, 'ghost', person([]), 'run');
    expect(out.ran).toBe(false);
    expect(out.checks.map((c) => [c.id, c.status])).toEqual([
      ['registered', 'fail'],
      ['available', 'skip'],
      ['in-toolset', 'skip'],
      ['args-valid', 'skip'],
    ]);
  });

  it('degrades mode:run to verify-only for an ineligible tool, checks intact', async () => {
    const tool = makeTool({
      name: 'danger',
      capabilities: { process: { allowedBinaries: ['sh'] } },
    });
    const { registry, exec } = makeRegistry([tool]);

    const out = await runToolTest(registry, 'danger', person(['danger']), 'run');

    expect(exec).not.toHaveBeenCalled();
    expect(out.ran).toBe(false);
    expect(out.result).toBeUndefined();
    expect(out.testEligibility.canRun).toBe(false);
    // A refusal to execute is not a refusal to verify.
    expect(out.checks.every((c) => c.status === 'pass')).toBe(true);
  });

  it('never executes in verify mode', async () => {
    const { registry, exec } = makeRegistry([makeTool({ name: 'safe' })]);
    const out = await runToolTest(registry, 'safe', person(['safe']), 'verify');
    expect(exec).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ran: false, testEligibility: { canRun: true } });
  });

  it('fails `available` and does not execute', async () => {
    const { registry, exec } = makeRegistry([makeTool({ name: 'safe', isAvailable: () => false })]);
    const out = await runToolTest(registry, 'safe', person(['safe']), 'run');
    expect(out.checks.find((c) => c.id === 'available')?.status).toBe('fail');
    expect(out.ran).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it('fails `in-toolset` when the personality does not list the tool', async () => {
    const { registry } = makeRegistry([makeTool({ name: 'read_file' })]);
    const out = await runToolTest(registry, 'read_file', person(['web_search']), 'run');
    expect(out.checks.find((c) => c.id === 'in-toolset')?.status).toBe('fail');
    expect(out.ran).toBe(false);
  });

  it('passes `in-toolset` for an alwaysInclude tool outside the toolset', async () => {
    const { registry } = makeRegistry([makeTool({ name: 'get_skill', alwaysInclude: true })]);
    const out = await runToolTest(registry, 'get_skill', person([]), 'run');
    expect(out.checks.find((c) => c.id === 'in-toolset')?.status).toBe('pass');
    expect(out.ran).toBe(true);
  });

  it('routes through executeParallel with a single-name allowlist', async () => {
    const { registry, exec } = makeRegistry([makeTool({ name: 'safe' })]);
    const out = await runToolTest(registry, 'safe', person(['safe']), 'run');

    const [calls, ctx, allowed] = exec.mock.calls[0];
    expect(calls).toEqual([
      { toolCallId: expect.any(String), name: 'safe', args: { q: 'example' } },
    ]);
    expect(allowed).toEqual(['safe']);
    expect(ctx).toMatchObject({
      platform: 'web',
      personalityId: 'scout',
      currentTurn: 0,
      messageCount: 0,
      resultBudgetChars: 4000,
    });
    expect(ctx.sessionId).toMatch(/^tool-test:/);
    expect(ctx.sessionKey).toMatch(/^tool-test:/);
    expect(ctx.abortSignal).toBeInstanceOf(AbortSignal);
    expect(out).toMatchObject({ ran: true, result: { ok: true, value: 'ran' }, durationMs: 7 });
  });

  it('uses an absolute declared workdir, and cwd for a templated one', async () => {
    const { registry, exec } = makeRegistry([makeTool({ name: 'safe' })]);
    // Assembled rather than written literally: a `${CWD}` in a test source
    // reads as an unfinished template string to both Biome and a human.
    const templated = `${'$'}{CWD}/docs`;

    await runToolTest(
      registry,
      'safe',
      { id: 'scout', name: 'Scout', toolset: ['safe'], fs_reach: { workdir: ['/srv/docs'] } },
      'run',
    );
    expect(exec.mock.calls[0][1].workingDir).toBe('/srv/docs');

    await runToolTest(
      registry,
      'safe',
      { id: 'scout', name: 'Scout', toolset: ['safe'], fs_reach: { workdir: [templated] } },
      'run',
    );
    expect(exec.mock.calls[1][1].workingDir).toBe(process.cwd());
  });

  it('truncates a long result value', async () => {
    const exec = vi.fn(async () => [
      { toolCallId: 'x', name: 'safe', result: { ok: true as const, value: 'x'.repeat(9000) } },
    ]);
    const { registry } = makeRegistry([makeTool({ name: 'safe' })], exec);

    const out = await runToolTest(registry, 'safe', person(['safe']), 'run');

    expect(out.result?.value).toHaveLength(4000 + '… [truncated]'.length);
    expect(out.durationMs).toEqual(expect.any(Number));
  });

  it('reports a failed tool result as data, not a thrown error', async () => {
    const exec = vi.fn(async () => [
      {
        toolCallId: 'x',
        name: 'safe',
        result: { ok: false as const, code: 'not_available' as const, error: 'no key' },
        durationMs: 3,
      },
    ]);
    const { registry } = makeRegistry([makeTool({ name: 'safe' })], exec);

    const out = await runToolTest(registry, 'safe', person(['safe']), 'run');

    expect(out.ran).toBe(true);
    expect(out.result).toEqual({ ok: false, error: 'no key', code: 'not_available' });
  });
});
