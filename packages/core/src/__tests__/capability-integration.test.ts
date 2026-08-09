import { safeFetch } from '@ethosagent/safety-network';
import type { KeyValueStore, Tool, ToolContext } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { CapabilityBackends } from '../capability-resolver';
import { ScopedFetchImpl } from '../scoped/scoped-fetch';
import { ScopedFsImpl } from '../scoped/scoped-fs';
import { ScopedProcessImpl } from '../scoped/scoped-process';
import { ScopedSecretsImpl } from '../scoped/scoped-secrets';
import { DefaultToolRegistry } from '../tool-registry';

const baseCtx: ToolContext = {
  sessionId: 'sess-1',
  sessionKey: 'cli:test',
  platform: 'cli',
  workingDir: '/tmp',
  currentTurn: 1,
  messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 80_000,
};

const mockKvStore: KeyValueStore = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
};

const makeBackends = (): CapabilityBackends => ({
  kvStoreFactory: vi.fn().mockReturnValue(mockKvStore),
  secretsBackend: vi.fn().mockResolvedValue('secret-value'),
  storage: {
    read: vi.fn(),
    readBytes: vi.fn(),
    write: vi.fn(),
    exists: vi.fn(),
    list: vi.fn(),
    mtime: vi.fn(),
    listEntries: vi.fn(),
    append: vi.fn(),
    writeAtomic: vi.fn(),
    mkdir: vi.fn(),
    remove: vi.fn(),
    rename: vi.fn(),
    chmod: vi.fn(),
  },
  personalityFsReach: () => ({ read: ['/data'], write: ['/out'] }),
  safeFetch,
});

const allCapsTool = (capture: { ctx?: ToolContext }): Tool => ({
  name: 'all_caps_tool',
  description: 'Tool declaring all 5 capabilities',
  schema: { type: 'object' },
  capabilities: {
    network: { allowedHosts: ['api.example.com'] },
    secrets: ['api/key'],
    storage: { scope: 'session', kind: 'kv' as const },
    fs_reach: { read: ['/data'], write: ['/out'] },
    process: { allowedBinaries: ['echo'] },
  },
  execute: async (_args, ctx) => {
    capture.ctx = ctx;
    return { ok: true, value: 'done' };
  },
});

const plainTool = (capture: { ctx?: ToolContext }): Tool => ({
  name: 'plain_tool',
  description: 'Tool with no capabilities',
  schema: { type: 'object' },
  capabilities: {},
  execute: async (_args, ctx) => {
    capture.ctx = ctx;
    return { ok: true, value: 'plain done' };
  },
});

describe('Capability integration', () => {
  it('tool with all 5 capabilities gets scoped context fields populated', async () => {
    const capture: { ctx?: ToolContext } = {};
    const backends = makeBackends();
    const registry = new DefaultToolRegistry(backends);
    registry.register(allCapsTool(capture));

    await registry.executeParallel(
      [{ toolCallId: 'c1', name: 'all_caps_tool', args: {} }],
      baseCtx,
    );

    const ctx = capture.ctx;
    expect(ctx).toBeDefined();
    expect(ctx?.kvStore).toBe(mockKvStore);
    expect(ctx?.secretsResolver).toBeInstanceOf(ScopedSecretsImpl);
    expect(ctx?.scopedFetch).toBeInstanceOf(ScopedFetchImpl);
    expect(ctx?.scopedFs).toBeInstanceOf(ScopedFsImpl);
    expect(ctx?.scopedProcess).toBeInstanceOf(ScopedProcessImpl);
  });

  it('tool without capabilities gets no scoped fields', async () => {
    const capture: { ctx?: ToolContext } = {};
    const backends = makeBackends();
    const registry = new DefaultToolRegistry(backends);
    registry.register(plainTool(capture));

    await registry.executeParallel([{ toolCallId: 'c1', name: 'plain_tool', args: {} }], baseCtx);

    const ctx = capture.ctx;
    expect(ctx).toBeDefined();
    expect(ctx?.kvStore).toBeUndefined();
    expect(ctx?.secretsResolver).toBeUndefined();
    expect(ctx?.scopedFetch).toBeUndefined();
    expect(ctx?.scopedFs).toBeUndefined();
    expect(ctx?.scopedProcess).toBeUndefined();
  });

  it('fail-closed: tool with capabilities on registry without backends', async () => {
    const capture: { ctx?: ToolContext } = {};
    const registry = new DefaultToolRegistry();
    registry.register(allCapsTool(capture));

    const results = await registry.executeParallel(
      [{ toolCallId: 'c1', name: 'all_caps_tool', args: {} }],
      baseCtx,
    );

    expect(results).toHaveLength(1);
    const r = results[0]?.result;
    expect(r?.ok).toBe(false);
    if (!r?.ok) {
      expect(r.error).toContain('declares capabilities but no capability backends');
    }
    expect(capture.ctx).toBeUndefined();
  });

  it('tool with empty capabilities executes without backends (regression)', async () => {
    const capture: { ctx?: ToolContext } = {};
    const emptyCapTool: Tool = {
      name: 'empty_cap_tool',
      description: 'Tool with capabilities: {}',
      schema: { type: 'object' },
      capabilities: {},
      execute: async (_args, ctx) => {
        capture.ctx = ctx;
        return { ok: true, value: 'ok' };
      },
    };
    const registry = new DefaultToolRegistry();
    registry.register(emptyCapTool);

    const results = await registry.executeParallel(
      [{ toolCallId: 'c1', name: 'empty_cap_tool', args: {} }],
      baseCtx,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.result.ok).toBe(true);
    expect(capture.ctx).toBeDefined();
    expect(capture.ctx?.kvStore).toBeUndefined();
    expect(capture.ctx?.scopedFetch).toBeUndefined();
  });

  it('mixed batch: capable tool + plain tool in same executeParallel', async () => {
    const capCapture: { ctx?: ToolContext } = {};
    const plainCapture: { ctx?: ToolContext } = {};
    const backends = makeBackends();
    const registry = new DefaultToolRegistry(backends);
    registry.register(allCapsTool(capCapture));
    registry.register(plainTool(plainCapture));

    const results = await registry.executeParallel(
      [
        { toolCallId: 'c1', name: 'all_caps_tool', args: {} },
        { toolCallId: 'c2', name: 'plain_tool', args: {} },
      ],
      baseCtx,
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.result.ok).toBe(true);
    expect(results[1]?.result.ok).toBe(true);

    expect(capCapture.ctx?.kvStore).toBe(mockKvStore);
    expect(capCapture.ctx?.secretsResolver).toBeInstanceOf(ScopedSecretsImpl);
    expect(capCapture.ctx?.scopedFetch).toBeInstanceOf(ScopedFetchImpl);
    expect(capCapture.ctx?.scopedFs).toBeInstanceOf(ScopedFsImpl);
    expect(capCapture.ctx?.scopedProcess).toBeInstanceOf(ScopedProcessImpl);

    expect(plainCapture.ctx?.kvStore).toBeUndefined();
    expect(plainCapture.ctx?.secretsResolver).toBeUndefined();
    expect(plainCapture.ctx?.scopedFetch).toBeUndefined();
    expect(plainCapture.ctx?.scopedFs).toBeUndefined();
    expect(plainCapture.ctx?.scopedProcess).toBeUndefined();
  });
});
