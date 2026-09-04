import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CapabilityBackends } from '@ethosagent/core';
import { DefaultToolRegistry } from '@ethosagent/core';
import { FsStorage } from '@ethosagent/storage-fs';
import type { ToolContext, ToolResult } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createImageTools } from '../index';
import type { ImageGenProvider } from '../providers/types';

// ---------------------------------------------------------------------------
// Minimal capability backends — image_generate declares network + secrets.
// The tool uses direct imports, not ctx.*, so these just pass the guard.
// ---------------------------------------------------------------------------

const testBackends: CapabilityBackends = {
  personalityNetworkPolicy: () => ({
    allow: ['api.openai.com', 'api.replicate.com', '*.replicate.delivery'],
  }),
};

// ---------------------------------------------------------------------------
// PNG magic bytes
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Minimal valid-ish PNG: signature + IHDR-like padding so the file has >8 bytes
function makePngBuffer(): Buffer {
  return Buffer.concat([PNG_SIGNATURE, Buffer.alloc(32, 0)]);
}

// ---------------------------------------------------------------------------
// Mock provider — returns a real PNG buffer + cost without hitting any API
// ---------------------------------------------------------------------------

function makeMockProvider(name: string, available: boolean, costPerImage = 0.04): ImageGenProvider {
  return {
    name,
    isAvailable: vi.fn().mockReturnValue(available),
    supports: vi.fn().mockReturnValue(true),
    generate: vi.fn().mockResolvedValue({
      buffer: makePngBuffer(),
      cost_usd: costPerImage,
      prompt_used: 'mock revised prompt',
    }),
  };
}

// ---------------------------------------------------------------------------
// Shared context builder
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeCtx(): ToolContext {
  return {
    sessionId: 'int-test',
    sessionKey: 'cli:int-test',
    platform: 'cli',
    workingDir: tmpDir,
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: vi.fn(),
    resultBudgetChars: 80_000,
    storage: new FsStorage(),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('image_generate integration', () => {
  let outPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ethos-img-int-${Date.now()}`);
    outPath = join(tmpDir, 'test-output.png');
  });

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // -----------------------------------------------------------------------
  // 1. Real tool through DefaultToolRegistry with mock provider — writes
  //    file via Storage.writeAtomic, returns correct JSON shape + cost
  // -----------------------------------------------------------------------

  it('runs image_generate through DefaultToolRegistry and writes a real file', async () => {
    const mockProvider = makeMockProvider('openai-dalle', true, 0.04);
    const registry = new DefaultToolRegistry(testBackends);
    const tools = createImageTools({ providers: [mockProvider] });
    registry.registerAll(tools);

    const results = await registry.executeParallel(
      [
        {
          toolCallId: 'c1',
          name: 'image_generate',
          args: { prompt: 'a cat on a windowsill', output_path: outPath },
        },
      ],
      makeCtx(),
      ['image_generate'],
    );

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r).toBeDefined();
    expect(r?.name).toBe('image_generate');
    expect(r?.toolCallId).toBe('c1');

    const result = r?.result as Extract<ToolResult, { ok: true }>;
    expect(result.ok).toBe(true);
    expect(result.cost_usd).toBe(0.04);

    const parsed = JSON.parse(result.value);
    expect(parsed.path).toBe(outPath);
    expect(parsed.dimensions).toEqual({ width: 1024, height: 1024 });
    expect(parsed.cost_usd).toBe(0.04);
    expect(parsed.provider).toBe('openai-dalle');
    expect(parsed.prompt_used).toBe('mock revised prompt');

    // File exists and starts with PNG magic bytes
    expect(existsSync(outPath)).toBe(true);
    const bytes = readFileSync(outPath);
    expect(bytes.length).toBeGreaterThan(8);
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50); // P
    expect(bytes[2]).toBe(0x4e); // N
    expect(bytes[3]).toBe(0x47); // G
    expect(bytes[4]).toBe(0x0d);
    expect(bytes[5]).toBe(0x0a);
    expect(bytes[6]).toBe(0x1a);
    expect(bytes[7]).toBe(0x0a);
  });

  // -----------------------------------------------------------------------
  // 2. Toolset omits image_generate — executeParallel returns not_available
  // -----------------------------------------------------------------------

  it('returns not_available when image_generate is not in the allowed toolset', async () => {
    const mockProvider = makeMockProvider('openai-dalle', true);
    const registry = new DefaultToolRegistry(testBackends);
    const tools = createImageTools({ providers: [mockProvider] });
    registry.registerAll(tools);

    const results = await registry.executeParallel(
      [
        {
          toolCallId: 'c1',
          name: 'image_generate',
          args: { prompt: 'a dog in a park' },
        },
      ],
      makeCtx(),
      ['terminal', 'read_file'], // image_generate not in the list
    );

    expect(results).toHaveLength(1);
    const r = results[0]?.result as Extract<ToolResult, { ok: false }>;
    expect(r.ok).toBe(false);
    expect(r.code).toBe('not_available');
    expect(r.error).toMatch(/not permitted/);
  });

  // -----------------------------------------------------------------------
  // 3. Cost aggregation — ToolResult.cost_usd is set and non-zero,
  //    using the real tool with an injectable mock provider
  // -----------------------------------------------------------------------

  it('ToolResult carries cost_usd from a successful generation', async () => {
    const mockProvider = makeMockProvider('openai-dalle', true, 0.08);
    const registry = new DefaultToolRegistry(testBackends);
    const tools = createImageTools({ providers: [mockProvider] });
    registry.registerAll(tools);

    const results = await registry.executeParallel(
      [
        {
          toolCallId: 'c1',
          name: 'image_generate',
          args: { prompt: 'cost test', output_path: outPath },
        },
      ],
      makeCtx(),
      ['image_generate'],
    );

    expect(results).toHaveLength(1);
    const r = results[0]?.result;
    expect(r).toBeDefined();
    expect(r?.ok).toBe(true);
    if (r?.ok) {
      expect(r.cost_usd).toBe(0.08);
      const parsed = JSON.parse(r.value);
      expect(parsed.cost_usd).toBe(0.08);
      expect(parsed.prompt_used).toBe('mock revised prompt');
    }
  });

  // -----------------------------------------------------------------------
  // 4. File presence — PNG file exists with correct magic bytes,
  //    written through the real Storage.writeAtomic path
  // -----------------------------------------------------------------------

  it('written PNG file has correct magic bytes via Storage.writeAtomic', async () => {
    const mockProvider = makeMockProvider('openai-dalle', true, 0.04);
    const registry = new DefaultToolRegistry(testBackends);
    const tools = createImageTools({ providers: [mockProvider] });
    registry.registerAll(tools);

    const results = await registry.executeParallel(
      [
        {
          toolCallId: 'c1',
          name: 'image_generate',
          args: { prompt: 'magic byte test', output_path: outPath },
        },
      ],
      makeCtx(),
      ['image_generate'],
    );

    const r = results[0]?.result as Extract<ToolResult, { ok: true }>;
    expect(r.ok).toBe(true);

    expect(existsSync(outPath)).toBe(true);
    const bytes = readFileSync(outPath);
    expect(bytes.length).toBeGreaterThan(8);

    // Verify PNG signature (8 bytes)
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50); // P
    expect(bytes[2]).toBe(0x4e); // N
    expect(bytes[3]).toBe(0x47); // G
    expect(bytes[4]).toBe(0x0d);
    expect(bytes[5]).toBe(0x0a);
    expect(bytes[6]).toBe(0x1a);
    expect(bytes[7]).toBe(0x0a);
  });

  // -----------------------------------------------------------------------
  // 5. cost_usd is surfaced on ToolResult for budget-cap enforcement
  //    Budget-cap enforcement is tested in packages/core/__tests__/agent-loop.test.ts
  //    (describe('budget cap (budgetCapUsd)')). This test verifies the tool
  //    sets cost_usd so the AgentLoop gate at agent-loop.ts:367 can read it.
  // -----------------------------------------------------------------------

  it('ToolResult.cost_usd is set on a successful generation for budgetCapUsd enforcement', async () => {
    const mockProvider = makeMockProvider('openai-dalle', true, 0.12);
    const registry = new DefaultToolRegistry(testBackends);
    const tools = createImageTools({ providers: [mockProvider] });
    registry.registerAll(tools);

    const results = await registry.executeParallel(
      [
        {
          toolCallId: 'budget-1',
          name: 'image_generate',
          args: { prompt: 'budget cap test', output_path: outPath },
        },
      ],
      makeCtx(),
      ['image_generate'],
    );

    expect(results).toHaveLength(1);
    const r = results[0]?.result;
    expect(r).toBeDefined();
    expect(r?.ok).toBe(true);
    if (r?.ok) {
      // cost_usd must be present and match the provider's reported cost
      // so AgentLoop can accumulate it against budgetCapUsd
      expect(r.cost_usd).toBe(0.12);
      expect(typeof r.cost_usd).toBe('number');
    }
  });

  // -----------------------------------------------------------------------
  // Registration shape
  // -----------------------------------------------------------------------

  it('createImageTools registers image_generate with correct metadata', () => {
    const mockProvider = makeMockProvider('openai-dalle', true);
    const registry = new DefaultToolRegistry(testBackends);
    const tools = createImageTools({ providers: [mockProvider] });
    registry.registerAll(tools);

    const tool = registry.get('image_generate');
    expect(tool).toBeDefined();
    expect(tool?.toolset).toBe('image');
    expect(tool?.maxResultChars).toBe(1_000);
  });

  it('toDefinitions includes image_generate when in allowedTools', () => {
    const mockProvider = makeMockProvider('openai-dalle', true);
    const registry = new DefaultToolRegistry(testBackends);
    registry.registerAll(createImageTools({ providers: [mockProvider] }));

    const defs = registry.toDefinitions(['image_generate']);
    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe('image_generate');
  });

  it('toDefinitions excludes image_generate when not in allowedTools', () => {
    const mockProvider = makeMockProvider('openai-dalle', true);
    const registry = new DefaultToolRegistry(testBackends);
    registry.registerAll(createImageTools({ providers: [mockProvider] }));

    const defs = registry.toDefinitions(['terminal']);
    expect(defs.map((d) => d.name)).not.toContain('image_generate');
  });

  // -----------------------------------------------------------------------
  // createImageTools() with no args still works (default providers)
  // -----------------------------------------------------------------------

  it('createImageTools() with no args uses default providers', () => {
    const tools = createImageTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('image_generate');
  });
});
