import { describe, expect, it, vi } from 'vitest';
import {
  translateBeforePromptBuildHook,
  translateCorpusSupplement,
  translateMemoryCapability,
  translateMemoryRuntime,
  translatePromptSectionBuilder,
} from '../memory-translator';
import type { MemoryLoadContext, PromptContext } from '@ethosagent/types';
import type { MemoryPluginCapability, MemoryPluginRuntime } from '../types';

const baseLoadCtx: MemoryLoadContext = {
  sessionId: 'sess-1',
  sessionKey: 'key-1',
  platform: 'cli',
};

const basePromptCtx: PromptContext = {
  sessionId: 'sess-1',
  sessionKey: 'key-1',
  platform: 'cli',
  model: 'claude-sonnet-4-6',
  history: [],
  isDm: false,
  turnNumber: 1,
};

// ---------------------------------------------------------------------------
// translateMemoryCapability
// ---------------------------------------------------------------------------

describe('translateMemoryCapability', () => {
  it('returns null when no promptBuilder or runtime', async () => {
    const provider = translateMemoryCapability({});
    expect(await provider.prefetch(baseLoadCtx)).toBeNull();
  });

  it('uses promptBuilder when present', async () => {
    const cap: MemoryPluginCapability = {
      promptBuilder: () => ['memory line 1', 'memory line 2'],
    };
    const provider = translateMemoryCapability(cap);
    const result = await provider.prefetch(baseLoadCtx);
    expect(result).not.toBeNull();
    expect(result!.content).toBe('memory line 1\nmemory line 2');
    expect(result!.source).toBe('custom');
    expect(result!.truncated).toBe(false);
  });

  it('returns null when promptBuilder returns empty array', async () => {
    const cap: MemoryPluginCapability = { promptBuilder: () => [] };
    const provider = translateMemoryCapability(cap);
    expect(await provider.prefetch(baseLoadCtx)).toBeNull();
  });

  it('delegates to runtime when no promptBuilder', async () => {
    const runtime: MemoryPluginRuntime = {
      async getMemorySearchManager() {
        return {
          manager: {
            async search() {
              return [{ content: 'result from runtime', id: '1', score: 0.9 }];
            },
          },
        };
      },
    };
    const cap: MemoryPluginCapability = { runtime };
    const provider = translateMemoryCapability(cap);
    const ctx = { ...baseLoadCtx, query: 'what do I know?' };
    const result = await provider.prefetch(ctx);
    expect(result).not.toBeNull();
    expect(result!.content).toContain('result from runtime');
  });

  it('sync() resolves without throwing', async () => {
    const provider = translateMemoryCapability({});
    await expect(provider.sync(baseLoadCtx, [])).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// translateMemoryRuntime
// ---------------------------------------------------------------------------

describe('translateMemoryRuntime', () => {
  it('returns null when manager is null', async () => {
    const runtime: MemoryPluginRuntime = {
      async getMemorySearchManager() { return { manager: null }; },
    };
    const provider = translateMemoryRuntime(runtime);
    expect(await provider.prefetch(baseLoadCtx)).toBeNull();
  });

  it('returns null when no query in context', async () => {
    const runtime: MemoryPluginRuntime = {
      async getMemorySearchManager() {
        return { manager: { async search() { return []; } } };
      },
    };
    const provider = translateMemoryRuntime(runtime);
    // baseLoadCtx has no query
    expect(await provider.prefetch(baseLoadCtx)).toBeNull();
  });

  it('returns null when manager has no search method', async () => {
    const runtime: MemoryPluginRuntime = {
      async getMemorySearchManager() { return { manager: {} }; },
    };
    const provider = translateMemoryRuntime(runtime);
    const ctx = { ...baseLoadCtx, query: 'hello' };
    expect(await provider.prefetch(ctx)).toBeNull();
  });

  it('returns null when getMemorySearchManager throws', async () => {
    const runtime: MemoryPluginRuntime = {
      async getMemorySearchManager() { throw new Error('connection failed'); },
    };
    const provider = translateMemoryRuntime(runtime);
    const ctx = { ...baseLoadCtx, query: 'hello' };
    expect(await provider.prefetch(ctx)).toBeNull();
  });

  it('returns joined results from search()', async () => {
    const runtime: MemoryPluginRuntime = {
      async getMemorySearchManager() {
        return {
          manager: {
            async search({ query }: { query: string }) {
              return [
                { content: `result A for: ${query}`, id: '1', score: 0.9 },
                { content: 'result B', id: '2', score: 0.7 },
              ];
            },
          },
        };
      },
    };
    const provider = translateMemoryRuntime(runtime);
    const ctx = { ...baseLoadCtx, query: 'who am I?' };
    const result = await provider.prefetch(ctx);
    expect(result).not.toBeNull();
    expect(result!.content).toContain('result A for: who am I?');
    expect(result!.content).toContain('result B');
    expect(result!.source).toBe('custom');
  });

  it('returns null when search returns empty array', async () => {
    const runtime: MemoryPluginRuntime = {
      async getMemorySearchManager() {
        return { manager: { async search() { return []; } } };
      },
    };
    const provider = translateMemoryRuntime(runtime);
    const ctx = { ...baseLoadCtx, query: 'anything' };
    expect(await provider.prefetch(ctx)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// translatePromptSectionBuilder → ContextInjector
// ---------------------------------------------------------------------------

describe('translatePromptSectionBuilder', () => {
  it('returns injector with correct id and priority', () => {
    const injector = translatePromptSectionBuilder('my-plugin', () => ['line'], 3);
    expect(injector.id).toBe('openclaw-my-plugin-prompt-section-3');
    expect(injector.priority).toBe(90);
  });

  it('respects custom priority', () => {
    const injector = translatePromptSectionBuilder('p', () => [], 0, 50);
    expect(injector.priority).toBe(50);
  });

  it('inject() returns null for empty lines', async () => {
    const injector = translatePromptSectionBuilder('p', () => [], 0);
    expect(await injector.inject(basePromptCtx)).toBeNull();
  });

  it('inject() returns prepend result with joined lines', async () => {
    const injector = translatePromptSectionBuilder('p', () => ['A', 'B'], 0);
    const result = await injector.inject(basePromptCtx);
    expect(result).not.toBeNull();
    expect(result!.content).toBe('A\nB');
    expect(result!.position).toBe('prepend');
  });
});

// ---------------------------------------------------------------------------
// translateCorpusSupplement → ContextInjector
// ---------------------------------------------------------------------------

describe('translateCorpusSupplement', () => {
  it('returns null when no query in context', async () => {
    const supplement = {
      async search() { return []; },
      async get() { return null; },
    };
    const injector = translateCorpusSupplement('p', supplement, 0);
    expect(await injector.inject(basePromptCtx)).toBeNull();
  });

  it('returns content when search returns results', async () => {
    const supplement = {
      async search({ query }: { query: string }) {
        return [{ id: '1', content: `found: ${query}`, score: 1 }];
      },
      async get() { return null; },
    };
    const injector = translateCorpusSupplement('p', supplement, 0);
    const ctx = { ...basePromptCtx, query: 'test search' } as PromptContext & { query: string };
    const result = await injector.inject(ctx);
    expect(result).not.toBeNull();
    expect(result!.content).toContain('found: test search');
  });
});

// ---------------------------------------------------------------------------
// translateBeforePromptBuildHook → ContextInjector
// ---------------------------------------------------------------------------

describe('translateBeforePromptBuildHook', () => {
  it('id and priority are derived from pluginId, idx, and opts', () => {
    const injector = translateBeforePromptBuildHook('lancedb', vi.fn(), 2, 95);
    expect(injector.id).toBe('openclaw-lancedb-before-prompt-build-2');
    expect(injector.priority).toBe(95);
  });

  it('returns null when handler returns falsy', async () => {
    const injector = translateBeforePromptBuildHook('p', vi.fn().mockResolvedValue(null), 0);
    expect(await injector.inject(basePromptCtx)).toBeNull();
  });

  it('returns prepend result when handler returns prependContext', async () => {
    const handler = vi.fn().mockResolvedValue({ prependContext: 'recalled memory' });
    const injector = translateBeforePromptBuildHook('p', handler, 0);
    const result = await injector.inject(basePromptCtx);
    expect(result).not.toBeNull();
    expect(result!.content).toBe('recalled memory');
    expect(result!.position).toBe('prepend');
  });

  it('returns append result when handler returns appendContext', async () => {
    const handler = vi.fn().mockResolvedValue({ appendContext: 'appended' });
    const injector = translateBeforePromptBuildHook('p', handler, 0);
    const result = await injector.inject(basePromptCtx);
    expect(result!.position).toBe('append');
  });

  it('returns null when handler throws', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('oops'));
    const injector = translateBeforePromptBuildHook('p', handler, 0);
    expect(await injector.inject(basePromptCtx)).toBeNull();
  });

  it('passes sessionId to handler context', async () => {
    const handler = vi.fn().mockResolvedValue({});
    const injector = translateBeforePromptBuildHook('p', handler, 0);
    const ctx = { ...basePromptCtx, sessionId: 'test-session' };
    await injector.inject(ctx);
    const [, hookCtx] = handler.mock.calls[0] as [unknown, { sessionId: string }];
    expect(hookCtx.sessionId).toBe('test-session');
  });
});
