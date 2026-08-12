import type {
  Logger,
  RealtimeVoiceProviderFactory,
  RealtimeVoiceProviderRegistry,
  SecretsResolver,
  VoiceProviderFactoryContext,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { validateRealtimeProvider } from '../realtime-conformance';
import { registerBuiltInRealtimeProviders } from '../realtime-registry';

// WHICH providers this package ships, and that each one resolves into something
// that satisfies the contract. The registry CLASS itself lives beside its
// STT/TTS siblings in `packages/core` and is tested there; this file uses a
// throwaway registry so the extension keeps no dependency on the kernel.

class TestRealtimeRegistry implements RealtimeVoiceProviderRegistry {
  private readonly factories = new Map<string, RealtimeVoiceProviderFactory>();

  register(name: string, factory: RealtimeVoiceProviderFactory): void {
    this.factories.set(name, factory);
  }

  unregister(name: string): void {
    this.factories.delete(name);
  }

  get(name: string): RealtimeVoiceProviderFactory | undefined {
    return this.factories.get(name);
  }

  list(): string[] {
    return [...this.factories.keys()];
  }
}

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};

const noopSecrets: SecretsResolver = {
  async get() {
    return null;
  },
  async set() {},
  async delete() {},
  async list() {
    return [];
  },
};

function ctx(config: Record<string, unknown>): VoiceProviderFactoryContext {
  return { config, secrets: noopSecrets, logger: noopLogger };
}

describe('built-in realtime providers', () => {
  it('registers both built-ins under their configured provider ids', () => {
    const registry = new TestRealtimeRegistry();
    registerBuiltInRealtimeProviders(registry);
    expect(registry.list().sort()).toEqual(['gemini-live', 'openai-realtime']);
  });

  it.each(['openai-realtime', 'gemini-live'])(
    'resolves %s into a conforming provider',
    async (id) => {
      const registry = new TestRealtimeRegistry();
      registerBuiltInRealtimeProviders(registry);

      const factory = registry.get(id);
      expect(factory).toBeDefined();
      const provider = await factory?.(ctx({ apiKey: 'test-key' }));
      expect(provider).toBeDefined();
      if (provider) expect(validateRealtimeProvider(provider)).toEqual([]);
    },
  );

  it.each(['openai-realtime', 'gemini-live'])('%s requires an apiKey', (id) => {
    const registry = new TestRealtimeRegistry();
    registerBuiltInRealtimeProviders(registry);
    expect(() => registry.get(id)?.(ctx({}))).toThrow(/apiKey/);
  });

  it('declares the sample rates each provider actually speaks', async () => {
    const registry = new TestRealtimeRegistry();
    registerBuiltInRealtimeProviders(registry);
    const openai = await registry.get('openai-realtime')?.(ctx({ apiKey: 'k' }));
    const gemini = await registry.get('gemini-live')?.(ctx({ apiKey: 'k' }));

    // Symmetric.
    expect(openai?.caps.inputSampleRate).toBe(24_000);
    expect(openai?.caps.outputSampleRate).toBe(24_000);
    // ASYMMETRIC — the property the split contract exists to express, and the
    // one that used to be hidden behind an internal 24 k → 16 k decimation.
    expect(gemini?.caps.inputSampleRate).toBe(16_000);
    expect(gemini?.caps.outputSampleRate).toBe(24_000);
  });
});
