// Lane 6 — the arithmetic model-fit verdict (eng review D5 + D19).
//
// The acceptance criteria under test:
//   - fit is computed against the SERVED window (stubbed 4,096), never 128k;
//   - window source 'default' → verdict 'unknown', NO numeric division;
//   - 'refuses' names the largest component and equals the Lane 1(b) warn
//     diagnostic (one function, both places);
//   - 'fits-degraded' lists every degradation in effect;
//   - the denominator is SERIALIZED schema size, not toolset name count;
//   - exclusions are named (MCP count, tier models);
//   - computeModelFit does no I/O (fetch-throw guard).

import { InMemoryStorage } from '@ethosagent/storage-fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeModelFit } from '../model-fit';
import { resolvePersonalityModelFit } from '../personality-fit';
import { evaluateContextFit, measureStaticFloor } from '../static-floor';

function floorOf(opts: { soulChars?: number; toolSchemaChars?: number; toolCount?: number }) {
  return measureStaticFloor({
    soulChars: opts.soulChars ?? 1_000,
    toolSchemaChars: opts.toolSchemaChars ?? 2_000,
    toolCount: opts.toolCount ?? 3,
    preludeChars: 1_200,
  });
}

describe('computeModelFit — verdicts', () => {
  it('computes the fit against a stubbed 4,096 window, not the 128k default', () => {
    // Floor ~3,050 tokens. Against 128k this trivially fits; against the
    // served 4,096 (output reserve 2,048) the compactible region is negative.
    const floor = floorOf({ soulChars: 4_000, toolSchemaChars: 7_000 });
    const fit = computeModelFit({
      personalityId: 'coordinator',
      model: 'qwen3:8b',
      windowTokens: 4_096,
      windowSource: 'probe',
      floor,
      smallWindow: true,
      mcpServerCount: 0,
      declaresModelTiers: false,
    });
    expect(fit.verdict).toBe('refuses');
    expect(fit.windowTokens).toBe(4_096);
    expect(fit.outputReserveTokens).toBe(2_048); // min(4096, floor(4096/2))
    expect(fit.compactibleTokens).toBe(4_096 - 2_048 - floor.tokens);
  });

  it("'refuses' reuses the Lane 1(b) diagnostic verbatim — one function, both places", () => {
    const floor = floorOf({ soulChars: 20_000, toolSchemaChars: 30_000, toolCount: 12 });
    const inputs = {
      personalityId: 'researcher',
      model: 'qwen3:8b',
      windowTokens: 8_192,
      floor,
    };
    const fit = computeModelFit({
      ...inputs,
      windowSource: 'probe' as const,
      smallWindow: true,
      mcpServerCount: 0,
      declaresModelTiers: false,
    });
    expect(fit.verdict).toBe('refuses');
    // Identical text to the startup warn diagnostic — never a second wording.
    expect(fit.refusalReason).toBe(evaluateContextFit(inputs).message);
    // Names the largest component (tool schemas here) with its token count.
    expect(fit.refusalReason).toContain('tool schemas');
    expect(fit.refusalReason).toContain(`${Math.ceil(30_000 / 4).toLocaleString('en-US')} tokens`);
    expect(fit.refusalReason).toContain('12 tools');
  });

  it("window source 'default' → 'unknown' with NO arithmetic against the fallback", () => {
    const fit = computeModelFit({
      personalityId: 'writer',
      model: 'mystery:7b',
      windowSource: 'default',
      floor: floorOf({}),
      smallWindow: false,
      mcpServerCount: 0,
      declaresModelTiers: false,
    });
    expect(fit.verdict).toBe('unknown');
    // No division happened: every window-derived number is absent.
    expect(fit.windowTokens).toBeUndefined();
    expect(fit.outputReserveTokens).toBeUndefined();
    expect(fit.compactibleTokens).toBeUndefined();
    expect(fit.staticShare).toBeUndefined();
    expect(fit.refusalReason).toBeUndefined();
    expect(JSON.stringify(fit)).not.toContain('128000');
  });

  it("an unresolved window with a non-'default' source label still refuses to divide", () => {
    const fit = computeModelFit({
      personalityId: 'writer',
      model: 'mystery:7b',
      windowSource: 'probe',
      // no windowTokens — probe ran but resolved nothing
      floor: floorOf({}),
      smallWindow: false,
      mcpServerCount: 0,
      declaresModelTiers: false,
    });
    expect(fit.verdict).toBe('unknown');
    expect(fit.compactibleTokens).toBeUndefined();
  });

  it("'fits-degraded' lists every degradation: small-window mode, narrowed toolset names, static share", () => {
    // Window 20,000 (≤32k → small-window mode), floor ~8,550 tokens → share
    // ~43% > 40% ratio. Reserve 4,096? outputReserve = min(4096, 10000) = 4096.
    const floor = floorOf({ soulChars: 4_000, toolSchemaChars: 29_000, toolCount: 9 });
    const fit = computeModelFit({
      personalityId: 'engineer',
      model: 'qwen3:8b',
      windowTokens: 20_000,
      windowSource: 'config',
      floor,
      smallWindow: true,
      narrowedToolset: ['read_file', 'memory_read'],
      mcpServerCount: 0,
      declaresModelTiers: false,
    });
    expect(fit.verdict).toBe('fits-degraded');
    expect(fit.degradations).toHaveLength(3);
    expect(fit.degradations[0]).toBe('small-window mode active');
    expect(fit.degradations[1]).toContain('read_file, memory_read');
    expect(fit.degradations[1]).toContain('2 tools');
    expect(fit.degradations[2]).toMatch(/static floor is \d+% of the window \(budget ratio 40%\)/);
    expect(fit.staticShare).toBeCloseTo(floor.tokens / 20_000);
  });

  it("'fits' when nothing degrades", () => {
    const fit = computeModelFit({
      personalityId: 'writer',
      model: 'claude-sonnet-4-6',
      windowTokens: 200_000,
      windowSource: 'catalog',
      floor: floorOf({}),
      smallWindow: false,
      mcpServerCount: 0,
      declaresModelTiers: false,
    });
    expect(fit.verdict).toBe('fits');
    expect(fit.degradations).toEqual([]);
    expect(fit.refusalReason).toBeUndefined();
  });

  it('divides by SERIALIZED schema size, not toolset name count', () => {
    // Few tools, long schemas: 2 tools costing 12,000 chars (~3,000 tokens).
    const fewLong = computeModelFit({
      personalityId: 'p',
      model: 'm',
      windowTokens: 4_096,
      windowSource: 'probe',
      floor: floorOf({ soulChars: 0, toolSchemaChars: 12_000, toolCount: 2 }),
      smallWindow: true,
      mcpServerCount: 0,
      declaresModelTiers: false,
    });
    // Many tools, short names/schemas: 10 tools costing 800 chars total.
    const manyShort = computeModelFit({
      personalityId: 'p',
      model: 'm',
      windowTokens: 4_096,
      windowSource: 'probe',
      floor: floorOf({ soulChars: 0, toolSchemaChars: 800, toolCount: 10 }),
      smallWindow: true,
      mcpServerCount: 0,
      declaresModelTiers: false,
    });
    // A name-count denominator would order these the other way around.
    expect(fewLong.verdict).toBe('refuses');
    expect(manyShort.verdict).not.toBe('refuses');
    expect(fewLong.floor.components.find((c) => c.name === 'tool schemas')?.tokens).toBe(3_000);
  });

  it('names its exclusions: MCP servers not counted, tier models not evaluated', () => {
    const fit = computeModelFit({
      personalityId: 'p',
      model: 'm',
      windowTokens: 100_000,
      windowSource: 'catalog',
      floor: floorOf({}),
      smallWindow: false,
      mcpServerCount: 2,
      declaresModelTiers: true,
    });
    expect(fit.exclusions).toEqual([
      '2 MCP servers not counted — schemas unknown until connect',
      'tier models not evaluated',
    ]);
    // And a personality with neither has nothing to exclude.
    const none = computeModelFit({
      personalityId: 'p',
      model: 'm',
      windowTokens: 100_000,
      windowSource: 'catalog',
      floor: floorOf({}),
      smallWindow: false,
      mcpServerCount: 0,
      declaresModelTiers: false,
    });
    expect(none.exclusions).toEqual([]);
  });
});

describe('computeModelFit — offline criterion', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('performs no network I/O — a poisoned fetch never fires', () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('computeModelFit must not touch the network');
    });
    const fit = computeModelFit({
      personalityId: 'p',
      model: 'm',
      windowTokens: 8_192,
      windowSource: 'probe',
      floor: floorOf({}),
      smallWindow: true,
      mcpServerCount: 1,
      declaresModelTiers: false,
    });
    expect(fit.verdict).toBe('fits-degraded');
  });
});

describe('resolvePersonalityModelFit — window resolution end to end', () => {
  it('uses the probed served window (stubbed vLLM 4,096) as the denominator', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [{ id: 'my-model', max_model_len: 4_096 }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    // ~3,000 tokens of tool schemas alone → refuses on 4,096, fits on 128k.
    const bigDef = { name: 'search_web', description: 'x'.repeat(6_000), parameters: {} };
    const fit = await resolvePersonalityModelFit({
      personality: { id: 'coordinator', name: 'Coordinator', toolset: ['search_web'] },
      soulMd: 's'.repeat(4_000),
      toolDefinitions: [bigDef, bigDef],
      provider: 'vllm',
      model: 'my-model',
      baseUrl: 'http://localhost:8000/v1',
      storage: new InMemoryStorage(),
      dataDir: '/data',
      forceProbeRefresh: true,
      fetchImpl,
    });
    expect(fit.windowTokens).toBe(4_096);
    expect(fit.windowSource).toBe('probe');
    expect(fit.verdict).toBe('refuses');
    expect(fit.refusalReason).toContain('4,096 tokens');
  });

  it('yields unknown (never the 128k default) when nothing resolves', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const fit = await resolvePersonalityModelFit({
      personality: { id: 'p', name: 'P', toolset: [] },
      soulMd: '',
      toolDefinitions: [],
      provider: 'llamacpp', // local runtime, no catalog entry for this model
      model: 'mystery-gguf',
      baseUrl: 'http://localhost:8080/v1',
      storage: new InMemoryStorage(),
      dataDir: '/data',
      forceProbeRefresh: true,
      fetchImpl,
    });
    expect(fit.verdict).toBe('unknown');
    expect(fit.windowSource).toBe('default');
    expect(fit.windowTokens).toBeUndefined();
  });

  it('reports the declared small-window toolset narrowing as a degradation', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [{ id: 'small', max_model_len: 8_192 }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const fit = await resolvePersonalityModelFit({
      personality: {
        id: 'engineer',
        name: 'Engineer',
        toolset: ['read_file', 'write_file', 'terminal'],
        context_engine_options: { small_window_toolset: ['read_file', 'terminal'] },
      },
      soulMd: 'soul',
      toolDefinitions: [{ name: 'read_file' }, { name: 'write_file' }, { name: 'terminal' }],
      provider: 'vllm',
      model: 'small',
      baseUrl: 'http://localhost:8000/v1',
      storage: new InMemoryStorage(),
      dataDir: '/data',
      forceProbeRefresh: true,
      fetchImpl,
    });
    expect(fit.verdict).toBe('fits-degraded');
    expect(fit.degradations).toContain('small-window mode active');
    expect(fit.degradations.some((d) => d.includes('read_file, terminal'))).toBe(true);
  });
});
