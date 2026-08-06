// Lane 0 — "Truth about the window". Served-window probe (per-runtime),
// resolution precedence (config > probe > catalog > default, eng review D15),
// the architecture-derived cap, and the probe disk cache (D3+D16).
// All network is stubbed — zero real calls.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  ARCH_WINDOW_CAP_TOKENS,
  detectLocalRuntime,
  parseLlamaCppProps,
  parseLmStudioModels,
  parseOllamaPs,
  parseVllmMaxModelLen,
  probeServedWindow,
  probeServedWindowCached,
  resolveContextWindow,
  windowProbeCachePath,
} from '../local-models';

const okResponse = (body: unknown): Response =>
  ({ ok: true, json: async () => body }) as unknown as Response;

function fetchStub(handler: (url: string) => unknown): typeof fetch {
  return (async (url: string) => okResponse(handler(url))) as unknown as typeof fetch;
}

/** A fetch stub that fails the test if it is ever called. */
function forbiddenFetch(): typeof fetch {
  return (async () => {
    throw new Error('TEST FAILURE: network call attempted on a warm cache');
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------

describe('detectLocalRuntime', () => {
  it('detects by provider alias first', () => {
    expect(detectLocalRuntime('ollama', 'http://somewhere:9999/v1')).toBe('ollama');
    expect(detectLocalRuntime('vllm', 'http://somewhere:9999/v1')).toBe('vllm');
    expect(detectLocalRuntime('lmstudio', 'http://x/v1')).toBe('lmstudio');
    expect(detectLocalRuntime('llamacpp', 'http://x/v1')).toBe('llamacpp');
  });

  it('falls back to default-port heuristics for generic aliases', () => {
    expect(detectLocalRuntime('openai-compat', 'http://localhost:11434/v1')).toBe('ollama');
    expect(detectLocalRuntime('openai-compat', 'http://localhost:1234/v1')).toBe('lmstudio');
    expect(detectLocalRuntime('openai-compat', 'http://localhost:8080/v1')).toBe('llamacpp');
  });

  it('never claims a hosted endpoint', () => {
    expect(detectLocalRuntime('openrouter', 'https://openrouter.ai/api/v1')).toBeUndefined();
    expect(detectLocalRuntime('openai', '')).toBeUndefined();
    expect(detectLocalRuntime('anthropic', '')).toBeUndefined();
  });

  // Post-review FIX 2 — a known hosted alias NEVER classifies as local, even
  // when its (proxied) baseUrl carries a local runtime's default port. The
  // classification drives the Lane 3 sanitizer, the 32k architecture cap, and
  // the payload-guard 'fail' severity — none of which may engage on hosted.
  it('a hosted alias behind a proxy on a local port is NOT local (FIX 2)', () => {
    for (const alias of ['openrouter', 'groq', 'deepseek', 'gemini', 'openai', 'azure', 'codex']) {
      expect(detectLocalRuntime(alias, 'https://proxy.corp.example:8080/v1')).toBeUndefined();
      expect(detectLocalRuntime(alias, 'https://proxy.corp.example:11434/v1')).toBeUndefined();
      expect(detectLocalRuntime(alias, 'https://proxy.corp.example:1234/v1')).toBeUndefined();
    }
  });

  it('port heuristics still fire for generic and unrecognized names', () => {
    expect(detectLocalRuntime('openai-compat', 'http://localhost:8080/v1')).toBe('llamacpp');
    expect(detectLocalRuntime('my-custom-endpoint', 'http://gpu-box:11434/v1')).toBe('ollama');
  });
});

// ---------------------------------------------------------------------------
// Structural parsers — unrecognized shapes yield unknown, never a guess
// ---------------------------------------------------------------------------

describe('parseOllamaPs', () => {
  it('reads the served context of the LOADED model (allocation truth)', () => {
    const body = {
      models: [{ name: 'llama3.2:latest', model: 'llama3.2:latest', context_length: 4096 }],
    };
    expect(parseOllamaPs(body, 'llama3.2')).toEqual({ loaded: true, contextWindow: 4096 });
  });

  it('reports not-loaded when the model is absent from /api/ps', () => {
    const body = { models: [{ name: 'other:latest', context_length: 8192 }] };
    expect(parseOllamaPs(body, 'llama3.2')).toEqual({ loaded: false });
  });

  it('reports loaded-but-unknown when context_length is missing', () => {
    const body = { models: [{ name: 'llama3.2:latest' }] };
    expect(parseOllamaPs(body, 'llama3.2')).toEqual({ loaded: true });
  });

  it('treats malformed bodies as not loaded (no throw, no guess)', () => {
    expect(parseOllamaPs(null, 'm')).toEqual({ loaded: false });
    expect(parseOllamaPs({ models: 'nope' }, 'm')).toEqual({ loaded: false });
    expect(parseOllamaPs({ models: [{ name: 'm', context_length: 'big' }] }, 'm')).toEqual({
      loaded: true,
    });
  });
});

describe('parseVllmMaxModelLen', () => {
  it('reads max_model_len for the matching model', () => {
    const body = { data: [{ id: 'qwen2.5', max_model_len: 16_384 }] };
    expect(parseVllmMaxModelLen(body, 'qwen2.5')).toBe(16_384);
  });

  it('returns undefined on a miss or malformed shape', () => {
    expect(
      parseVllmMaxModelLen({ data: [{ id: 'other', max_model_len: 1 }] }, 'q'),
    ).toBeUndefined();
    expect(parseVllmMaxModelLen({ data: [{ id: 'q' }] }, 'q')).toBeUndefined();
    expect(parseVllmMaxModelLen(null, 'q')).toBeUndefined();
  });
});

describe('parseLlamaCppProps', () => {
  it('reads default_generation_settings.n_ctx', () => {
    expect(parseLlamaCppProps({ default_generation_settings: { n_ctx: 8192 } })).toBe(8192);
  });

  it('falls back to a top-level n_ctx (older builds)', () => {
    expect(parseLlamaCppProps({ n_ctx: 4096 })).toBe(4096);
  });

  it('returns undefined on malformed shapes', () => {
    expect(parseLlamaCppProps(null)).toBeUndefined();
    expect(parseLlamaCppProps({ default_generation_settings: { n_ctx: 'x' } })).toBeUndefined();
  });
});

describe('parseLmStudioModels', () => {
  it('prefers loaded_context_length (allocation) over max_context_length', () => {
    const body = { data: [{ id: 'm', loaded_context_length: 8192, max_context_length: 131_072 }] };
    expect(parseLmStudioModels(body, 'm')).toEqual({ contextWindow: 8192, source: 'allocation' });
  });

  it('falls back to max_context_length as architecture-derived', () => {
    const body = { data: [{ id: 'm', max_context_length: 131_072 }] };
    expect(parseLmStudioModels(body, 'm')).toEqual({
      contextWindow: 131_072,
      source: 'architecture',
    });
  });

  it('returns undefined when the model has no context metadata', () => {
    expect(parseLmStudioModels({ data: [{ id: 'm' }] }, 'm')).toBeUndefined();
    expect(parseLmStudioModels(null, 'm')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// probeServedWindow — per-runtime endpoints
// ---------------------------------------------------------------------------

describe('probeServedWindow', () => {
  it('ollama: a LOADED model served at num_ctx 4096 yields 4096 via /api/ps', async () => {
    let calledUrl = '';
    const fetchImpl = (async (url: string) => {
      calledUrl = url;
      return okResponse({ models: [{ name: 'llama3.2:latest', context_length: 4096 }] });
    }) as unknown as typeof fetch;

    const result = await probeServedWindow({
      runtime: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.2',
      fetchImpl,
    });
    expect(calledUrl).toBe('http://localhost:11434/api/ps');
    expect(result).toEqual({ reachable: true, contextWindow: 4096, source: 'allocation' });
  });

  it('ollama: model NOT loaded → window unknown with a diagnostic naming OLLAMA_CONTEXT_LENGTH', async () => {
    const fetchImpl = fetchStub(() => ({ models: [] }));
    const result = await probeServedWindow({
      runtime: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.2',
      fetchImpl,
    });
    expect(result.contextWindow).toBeUndefined();
    expect(result.diagnostic).toMatch(/not loaded/);
    expect(result.diagnostic).toMatch(/OLLAMA_CONTEXT_LENGTH/);
    // Never the /api/show architecture number (D14).
    expect(result.diagnostic).toMatch(/contextWindow/);
  });

  it('vllm: --max-model-len 16384 yields 16384 from /v1/models', async () => {
    let calledUrl = '';
    const fetchImpl = (async (url: string) => {
      calledUrl = url;
      return okResponse({ data: [{ id: 'qwen2.5', max_model_len: 16_384 }] });
    }) as unknown as typeof fetch;

    const result = await probeServedWindow({
      runtime: 'vllm',
      baseUrl: 'http://localhost:8000/v1',
      model: 'qwen2.5',
      fetchImpl,
    });
    expect(calledUrl).toBe('http://localhost:8000/v1/models');
    expect(result).toEqual({ reachable: true, contextWindow: 16_384, source: 'allocation' });
  });

  it('llamacpp: reads n_ctx from GET /props at the server root', async () => {
    let calledUrl = '';
    const fetchImpl = (async (url: string) => {
      calledUrl = url;
      return okResponse({ default_generation_settings: { n_ctx: 8192 } });
    }) as unknown as typeof fetch;

    const result = await probeServedWindow({
      runtime: 'llamacpp',
      baseUrl: 'http://localhost:8080/v1',
      model: 'any',
      fetchImpl,
    });
    expect(calledUrl).toBe('http://localhost:8080/props');
    expect(result).toEqual({ reachable: true, contextWindow: 8192, source: 'allocation' });
  });

  it('lmstudio: per-model metadata from /v1/models', async () => {
    const fetchImpl = fetchStub(() => ({
      data: [{ id: 'm', loaded_context_length: 8192, max_context_length: 131_072 }],
    }));
    const result = await probeServedWindow({
      runtime: 'lmstudio',
      baseUrl: 'http://localhost:1234/v1',
      model: 'm',
      fetchImpl,
    });
    expect(result).toEqual({ reachable: true, contextWindow: 8192, source: 'allocation' });
  });

  it('never blocks: a hanging endpoint resolves fail-soft within the timeout', async () => {
    const hangingFetch = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('timed out')));
      })) as unknown as typeof fetch;

    const result = await probeServedWindow({
      runtime: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.2',
      timeoutMs: 25,
      fetchImpl: hangingFetch,
    });
    expect(result.reachable).toBe(false);
    expect(result.contextWindow).toBeUndefined();
    expect(result.diagnostic).toMatch(/failed/);
  });

  it('reports unreachable on a network error (no throw)', async () => {
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await probeServedWindow({
      runtime: 'vllm',
      baseUrl: 'http://localhost:8000/v1',
      model: 'q',
      fetchImpl,
    });
    expect(result).toMatchObject({ reachable: false });
  });
});

// ---------------------------------------------------------------------------
// Probe disk cache (D3+D16)
// ---------------------------------------------------------------------------

describe('probeServedWindowCached', () => {
  const dataDir = '/data';
  const cachePath = windowProbeCachePath(dataDir);
  const base = {
    runtime: 'ollama' as const,
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.2',
    cachePath,
  };
  const cacheKey = `${base.baseUrl}::${base.model}`;

  function warmCache(storage: InMemoryStorage, contextWindow: number, probedAt: number) {
    return storage.mkdir('/data/cache').then(() =>
      storage.write(
        cachePath,
        JSON.stringify({
          version: 1,
          entries: { [cacheKey]: { contextWindow, source: 'allocation', probedAt } },
        }),
      ),
    );
  }

  it('a warm cache hit makes ZERO network calls', async () => {
    const storage = new InMemoryStorage();
    await warmCache(storage, 20_000, 1_000);
    const result = await probeServedWindowCached({
      ...base,
      storage,
      fetchImpl: forbiddenFetch(),
      now: () => 1_000 + 60_000, // one minute later, well inside the 15-min TTL
    });
    expect(result).toEqual({ reachable: true, contextWindow: 20_000, source: 'allocation' });
  });

  it('forceRefresh bypasses a warm cache, probes live, and rewrites the cache', async () => {
    const storage = new InMemoryStorage();
    await warmCache(storage, 20_000, 1_000);
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return okResponse({ models: [{ name: 'llama3.2', context_length: 4096 }] });
    }) as unknown as typeof fetch;

    const result = await probeServedWindowCached({
      ...base,
      storage,
      fetchImpl,
      forceRefresh: true,
      now: () => 2_000,
    });
    expect(fetchCalls).toBe(1);
    expect(result.contextWindow).toBe(4096);
    const rewritten = JSON.parse((await storage.read(cachePath)) ?? '');
    expect(rewritten.entries[cacheKey]).toEqual({
      contextWindow: 4096,
      source: 'allocation',
      probedAt: 2_000,
    });
  });

  it('an expired entry probes live again (15-minute TTL)', async () => {
    const storage = new InMemoryStorage();
    await warmCache(storage, 20_000, 0);
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return okResponse({ models: [{ name: 'llama3.2', context_length: 4096 }] });
    }) as unknown as typeof fetch;

    const result = await probeServedWindowCached({
      ...base,
      storage,
      fetchImpl,
      now: () => 16 * 60_000, // past the TTL
    });
    expect(fetchCalls).toBe(1);
    expect(result.contextWindow).toBe(4096);
  });

  it('corrupted cache content self-heals: live probe runs and the cache is rewritten', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir('/data/cache');
    await storage.write(cachePath, 'not json {{{');
    const fetchImpl = fetchStub(() => ({ models: [{ name: 'llama3.2', context_length: 4096 }] }));

    const result = await probeServedWindowCached({ ...base, storage, fetchImpl, now: () => 5_000 });
    expect(result.contextWindow).toBe(4096);
    const healed = JSON.parse((await storage.read(cachePath)) ?? '');
    expect(healed.version).toBe(1);
    expect(healed.entries[cacheKey].contextWindow).toBe(4096);
  });

  it('a structurally invalid (but valid-JSON) cache also self-heals', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir('/data/cache');
    await storage.write(cachePath, JSON.stringify({ version: 99, entries: 'nope' }));
    const fetchImpl = fetchStub(() => ({ models: [{ name: 'llama3.2', context_length: 8192 }] }));

    const result = await probeServedWindowCached({ ...base, storage, fetchImpl, now: () => 5_000 });
    expect(result.contextWindow).toBe(8192);
    const healed = JSON.parse((await storage.read(cachePath)) ?? '');
    expect(healed.entries[cacheKey].contextWindow).toBe(8192);
  });

  it('a failed probe is not cached and does not clobber existing entries', async () => {
    const storage = new InMemoryStorage();
    await warmCache(storage, 20_000, 0);
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;

    const result = await probeServedWindowCached({
      ...base,
      storage,
      fetchImpl,
      now: () => 16 * 60_000, // stale → live probe → fails
    });
    expect(result.reachable).toBe(false);
    const untouched = JSON.parse((await storage.read(cachePath)) ?? '');
    expect(untouched.entries[cacheKey].contextWindow).toBe(20_000);
  });
});

// ---------------------------------------------------------------------------
// Resolution precedence (D15): config > probe > catalog > default
// ---------------------------------------------------------------------------

describe('resolveContextWindow', () => {
  it('config wins over a successful probe AND the catalog, and is NOT capped', () => {
    const resolved = resolveContextWindow({
      provider: 'ollama',
      model: 'llama3.2',
      configWindow: 65_536,
      probe: { reachable: true, contextWindow: 16_384, source: 'allocation' },
      catalogWindow: 131_072,
      localRuntime: true,
    });
    expect(resolved.contextWindow).toBe(65_536);
    expect(resolved.source).toBe('config');
    expect(resolved.capped).toBe(false);
  });

  it('warns when config and a successful probe disagree', () => {
    const resolved = resolveContextWindow({
      provider: 'ollama',
      model: 'llama3.2',
      configWindow: 8_192,
      probe: { reachable: true, contextWindow: 4_096, source: 'allocation' },
      localRuntime: true,
    });
    expect(resolved.contextWindow).toBe(8_192);
    expect(resolved.diagnostics.some((d) => d.includes('disagrees'))).toBe(true);
  });

  it('an explicit config above the cap draws a sanity warning, never a clamp', () => {
    const resolved = resolveContextWindow({
      provider: 'ollama',
      model: 'llama3.2',
      configWindow: 262_144,
      localRuntime: true,
    });
    expect(resolved.contextWindow).toBe(262_144);
    expect(resolved.capped).toBe(false);
    expect(resolved.diagnostics.some((d) => d.includes(`${ARCH_WINDOW_CAP_TOKENS}`))).toBe(true);
  });

  it('an allocation-backed probe value is used verbatim — 16384 stays 16384', () => {
    const resolved = resolveContextWindow({
      provider: 'vllm',
      model: 'qwen2.5',
      probe: { reachable: true, contextWindow: 16_384, source: 'allocation' },
      catalogWindow: 32_768,
      localRuntime: true,
    });
    expect(resolved).toMatchObject({ contextWindow: 16_384, source: 'probe', capped: false });
    expect(resolved.diagnostics).toEqual([]);
  });

  it('an allocation-backed probe value ABOVE the cap is not capped', () => {
    const resolved = resolveContextWindow({
      provider: 'vllm',
      model: 'big',
      probe: { reachable: true, contextWindow: 131_072, source: 'allocation' },
      localRuntime: true,
    });
    expect(resolved).toMatchObject({ contextWindow: 131_072, capped: false });
  });

  it('an architecture-derived probe value above the cap IS capped, visibly', () => {
    const resolved = resolveContextWindow({
      provider: 'lmstudio',
      model: 'm',
      probe: { reachable: true, contextWindow: 262_144, source: 'architecture' },
      localRuntime: true,
    });
    expect(resolved.contextWindow).toBe(ARCH_WINDOW_CAP_TOKENS);
    expect(resolved.capped).toBe(true);
    expect(resolved.diagnostics.some((d) => d.includes('capped to 32768'))).toBe(true);
  });

  it('a catalog 262144 on a local runtime resolves to 32768 with the cap in the diagnostic', () => {
    const resolved = resolveContextWindow({
      provider: 'ollama',
      model: 'huge',
      catalogWindow: 262_144,
      localRuntime: true,
    });
    expect(resolved.contextWindow).toBe(32_768);
    expect(resolved.source).toBe('catalog');
    expect(resolved.capped).toBe(true);
    expect(resolved.diagnostics.some((d) => d.includes('capped to 32768'))).toBe(true);
  });

  it('a hosted catalog window is never capped (the cap is a local-GPU concern)', () => {
    const resolved = resolveContextWindow({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      catalogWindow: 200_000,
      localRuntime: false,
    });
    expect(resolved).toMatchObject({ contextWindow: 200_000, source: 'catalog', capped: false });
    expect(resolved.diagnostics).toEqual([]);
  });

  it('nothing resolved on a local runtime → loud named diagnostic, not a silent 128000', () => {
    const resolved = resolveContextWindow({
      provider: 'ollama',
      model: 'qwen3',
      localRuntime: true,
    });
    expect(resolved.contextWindow).toBeUndefined();
    expect(resolved.source).toBe('default');
    expect(
      resolved.diagnostics.some((d) =>
        /window for qwen3 on ollama is unknown; assuming 128000.*contextWindow/.test(d),
      ),
    ).toBe(true);
  });

  it('nothing resolved on a hosted provider stays silent (no local diagnostic)', () => {
    const resolved = resolveContextWindow({
      provider: 'openrouter',
      model: 'some/model',
      localRuntime: false,
    });
    expect(resolved.contextWindow).toBeUndefined();
    expect(resolved.diagnostics).toEqual([]);
  });

  it("surfaces the probe's own diagnostic (ollama not-loaded) alongside the fallback", () => {
    const resolved = resolveContextWindow({
      provider: 'ollama',
      model: 'llama3.2',
      probe: {
        reachable: true,
        diagnostic: "ollama model 'llama3.2' is not loaded — set OLLAMA_CONTEXT_LENGTH",
      },
      catalogWindow: 32_000,
      localRuntime: true,
    });
    expect(resolved.contextWindow).toBe(32_000);
    expect(resolved.diagnostics.some((d) => d.includes('OLLAMA_CONTEXT_LENGTH'))).toBe(true);
  });
});
