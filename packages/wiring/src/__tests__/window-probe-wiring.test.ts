// Lane 0 — end-to-end resolution through `createLLM`: the D15 precedence
// (config > probe > catalog > default) as observed on the constructed
// provider's `maxContextTokens`. All network is stubbed via the probe
// context's fetch seam — zero real calls.

import { InMemoryStorage } from '@ethosagent/storage-fs';
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
});
