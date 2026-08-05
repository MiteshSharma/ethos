// Lane 0 — end-to-end resolution through `createLLM`: the D15 precedence
// (config > probe > catalog > default) as observed on the constructed
// provider's `maxContextTokens`. All network is stubbed via the probe
// context's fetch seam — zero real calls.

import type { OpenAICompatProvider } from '@ethosagent/llm-openai-compat';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { Logger } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createLLM, type WiringConfig } from '../index';
import { windowProbeCachePath } from '../local-models';

const okResponse = (body: unknown): Response =>
  ({ ok: true, json: async () => body }) as unknown as Response;

const BASE_URL = 'http://localhost:11434/v1';

function ollamaConfig(overrides: Partial<WiringConfig> = {}): WiringConfig {
  return {
    provider: 'ollama',
    model: 'somemodel',
    apiKey: 'local',
    baseUrl: BASE_URL,
    ...overrides,
  };
}

/** fetch stub serving /api/ps with the given served window. */
function psFetch(contextWindow: number): typeof fetch {
  return (async () =>
    okResponse({
      models: [{ name: 'somemodel', context_length: contextWindow }],
    })) as unknown as typeof fetch;
}

describe('createLLM — Lane 0 window resolution (stubbed network)', () => {
  it('probe resolves the served window into the provider', async () => {
    const storage = new InMemoryStorage();
    const llm = await createLLM(ollamaConfig(), {
      storage,
      dataDir: '/data',
      fetchImpl: psFetch(20_000),
    });
    expect(llm.maxContextTokens).toBe(20_000);
  });

  it('config contextWindow wins over a successful probe and is NOT capped', async () => {
    const storage = new InMemoryStorage();
    const llm = await createLLM(ollamaConfig({ contextWindow: 65_536 }), {
      storage,
      dataDir: '/data',
      fetchImpl: psFetch(20_000),
    });
    expect(llm.maxContextTokens).toBe(65_536);
  });

  it('a warm probe cache resolves the window with NO network call', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir('/data/cache');
    await storage.write(
      windowProbeCachePath('/data'),
      JSON.stringify({
        version: 1,
        entries: {
          [`${BASE_URL}::somemodel`]: {
            contextWindow: 20_000,
            source: 'allocation',
            probedAt: Date.now(),
          },
        },
      }),
    );
    const forbidden = (async () => {
      throw new Error('TEST FAILURE: network call attempted on a warm cache');
    }) as unknown as typeof fetch;

    const llm = await createLLM(ollamaConfig(), {
      storage,
      dataDir: '/data',
      fetchImpl: forbidden,
    });
    expect(llm.maxContextTokens).toBe(20_000);
  });

  it('an unreachable probe never blocks construction — provider falls back to its default', async () => {
    const storage = new InMemoryStorage();
    const failing = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;

    const llm = await createLLM(ollamaConfig(), {
      storage,
      dataDir: '/data',
      fetchImpl: failing,
    });
    // No config, no probe, no catalog row for 'somemodel' → the provider's own
    // 128k default applies (the factory warns loudly; it must not throw).
    expect(llm.maxContextTokens).toBe(128_000);
  });

  it('an ollama catalog row is capped as architecture-derived on the catalog path', async () => {
    const storage = new InMemoryStorage();
    const failing = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;

    // llama3.2 has a bundled catalog row of 131_072 (architecture max) — with
    // the probe unreachable, the catalog value is used and capped to 32_768.
    const llm = await createLLM(ollamaConfig({ model: 'llama3.2' }), {
      storage,
      dataDir: '/data',
      fetchImpl: failing,
    });
    expect(llm.maxContextTokens).toBe(32_768);
  });

  // Post-review FIX 2 — a hosted alias whose baseUrl carries a local-looking
  // port must resolve as HOSTED end to end: no llamacpp sanitizer profile, no
  // 32k architecture cap on its catalog window.
  it('a hosted alias proxied through :8080 keeps hosted behavior (FIX 2)', async () => {
    const storage = new InMemoryStorage();
    const forbidden = (async () => {
      throw new Error('TEST FAILURE: hosted endpoints are never probed');
    }) as unknown as typeof fetch;

    const llm = await createLLM(
      {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4-6',
        apiKey: 'sk',
        baseUrl: 'https://proxy.corp.example:8080/v1',
      },
      { storage, dataDir: '/data', fetchImpl: forbidden },
    );
    // Catalog window (200k) uncapped — the 32k architecture cap is local-only.
    expect(llm.maxContextTokens).toBe(200_000);
    // No llamacpp schema sanitizer on a hosted endpoint.
    expect((llm as OpenAICompatProvider).toolSchemaProfile).toBeUndefined();
    expect((llm as OpenAICompatProvider).localRuntime).toBeUndefined();
  });

  // Post-review FIX 8 — the unresolved-window condition surfaces exactly ONE
  // warning through the wiring path (wiring's resolution diagnostic; the
  // factory's near-identical copy is suppressed).
  it('an unresolved local window warns exactly once through the wiring path (FIX 8)', async () => {
    const storage = new InMemoryStorage();
    const failing = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const warns: string[] = [];
    const log: Logger = {
      info: () => {},
      warn: (msg: string) => {
        warns.push(msg);
      },
      error: () => {},
      debug: () => {},
      child: () => log,
    };

    await createLLM(ollamaConfig(), { storage, dataDir: '/data', fetchImpl: failing }, log);

    const unknownWindowWarns = warns.filter((w) => w.includes('is unknown; assuming 128000'));
    expect(unknownWindowWarns).toHaveLength(1);
  });
});
