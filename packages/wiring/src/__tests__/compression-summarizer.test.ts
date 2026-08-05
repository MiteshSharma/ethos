// Lane 5(ii) — the compression summarizer's provider gets the SAME
// window/profile threading as the main provider. Asserted at the factory
// seam: a stub factory records the config it is constructed with, and the
// probe path is exercised cache-first with a fetch stub that fails the test
// on any network call.

import { DefaultLLMProviderRegistry } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { CompletionChunk, LLMProvider, Message, Tool } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { buildCompressionSummarizer, type WiringConfig } from '../index';
import { windowProbeCachePath } from '../local-models';

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLog,
};

const BASE_URL = 'http://localhost:11434/v1';

function stubProvider(config: Record<string, unknown>): LLMProvider {
  return {
    name: String(config.provider),
    model: String(config.model),
    maxContextTokens: typeof config.maxContextTokens === 'number' ? config.maxContextTokens : 0,
    supportsCaching: false,
    supportsThinking: false,
    complete(
      _messages: Message[],
      _tools: Tool[],
      _opts?: unknown,
    ): AsyncIterable<CompletionChunk> {
      return (async function* () {
        yield { type: 'text_delta', text: 'a summary' } as CompletionChunk;
      })();
    },
  } as unknown as LLMProvider;
}

function registryRecording(seen: Record<string, unknown>[]): DefaultLLMProviderRegistry {
  const registry = new DefaultLLMProviderRegistry();
  registry.register('ollama', ({ config }) => {
    seen.push(config as Record<string, unknown>);
    return stubProvider(config as Record<string, unknown>);
  });
  return registry;
}

/** Warm probe cache so window resolution never touches the network. */
async function warmCache(storage: InMemoryStorage, model: string, contextWindow: number) {
  await storage.mkdir('/data/cache');
  await storage.write(
    windowProbeCachePath('/data'),
    JSON.stringify({
      version: 1,
      entries: {
        [`${BASE_URL}::${model}`]: { contextWindow, source: 'allocation', probedAt: Date.now() },
      },
    }),
  );
}

const forbiddenFetch = (async () => {
  throw new Error('TEST FAILURE: network call attempted on a warm cache');
}) as unknown as typeof fetch;

describe('Lane 5(ii) — buildCompressionSummarizer window/profile threading', () => {
  it('constructs the summarizer provider with the resolved window and profile', async () => {
    const seen: Record<string, unknown>[] = [];
    const registry = registryRecording(seen);
    const storage = new InMemoryStorage();
    await warmCache(storage, 'aux-model', 20_000);

    const config: WiringConfig = {
      provider: 'ollama',
      model: 'main-model',
      apiKey: 'local',
      baseUrl: BASE_URL,
      auxiliaryCompression: { model: 'aux-model' },
      models: { 'ollama/aux-model': { toolCallFormat: 'openai', maxOutputTokens: 512 } },
    };
    const summarize = buildCompressionSummarizer(registry, config, undefined, noopLog, {
      storage,
      dataDir: '/data',
      fetchImpl: forbiddenFetch,
    });
    const result = await summarize([{ role: 'user', content: 'hello' }], 100);

    expect(result).toBe('a summary');
    expect(seen).toHaveLength(1);
    const providerConfig = seen[0] ?? {};
    expect(providerConfig.model).toBe('aux-model');
    // The mis-sizing fix: the cached served window, not the 128k inherit.
    expect(providerConfig.maxContextTokens).toBe(20_000);
    // Profile fields, threaded the same way the main provider gets them.
    expect(providerConfig.toolCallFormat).toBe('openai');
    expect(providerConfig.maxOutputTokens).toBe(512);
  });

  it('builds the provider once and reuses it across calls', async () => {
    const seen: Record<string, unknown>[] = [];
    const registry = registryRecording(seen);
    const storage = new InMemoryStorage();
    await warmCache(storage, 'aux-model', 20_000);

    const config: WiringConfig = {
      provider: 'ollama',
      model: 'main-model',
      apiKey: 'local',
      baseUrl: BASE_URL,
      auxiliaryCompression: { model: 'aux-model' },
    };
    const summarize = buildCompressionSummarizer(registry, config, undefined, noopLog, {
      storage,
      dataDir: '/data',
      fetchImpl: forbiddenFetch,
    });
    await summarize([{ role: 'user', content: 'one' }], 100);
    await summarize([{ role: 'user', content: 'two' }], 100);
    expect(seen).toHaveLength(1);
  });

  it('omits maxContextTokens when no window resolves (no probe context, no catalog hit)', async () => {
    const seen: Record<string, unknown>[] = [];
    const registry = registryRecording(seen);

    const config: WiringConfig = {
      provider: 'ollama',
      model: 'main-model',
      apiKey: 'local',
      baseUrl: BASE_URL,
      auxiliaryCompression: { model: 'aux-model' },
    };
    // No windowProbe context at all → resolution falls through with no value;
    // the provider keeps its own default rather than a fabricated one.
    const summarize = buildCompressionSummarizer(registry, config, undefined, noopLog);
    await summarize([{ role: 'user', content: 'hello' }], 100);

    const providerConfig = seen[0] ?? {};
    expect('maxContextTokens' in providerConfig).toBe(false);
  });
});
