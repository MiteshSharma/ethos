import type { Logger, SecretsResolver, VoiceProviderFactoryContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { validateRealtimeProvider } from '../realtime-conformance';
import {
  DefaultRealtimeVoiceProviderRegistry,
  registerBuiltInRealtimeProviders,
} from '../realtime-registry';

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

describe('DefaultRealtimeVoiceProviderRegistry', () => {
  it('registers both built-ins under their configured provider ids', () => {
    const registry = new DefaultRealtimeVoiceProviderRegistry();
    registerBuiltInRealtimeProviders(registry);
    expect(registry.list().sort()).toEqual(['gemini-live', 'openai-realtime']);
  });

  it.each(['openai-realtime', 'gemini-live'])(
    'resolves %s into a conforming provider',
    async (id) => {
      const registry = new DefaultRealtimeVoiceProviderRegistry();
      registerBuiltInRealtimeProviders(registry);

      const factory = registry.get(id);
      expect(factory).toBeDefined();
      const provider = await factory?.(ctx({ apiKey: 'test-key' }));
      expect(provider).toBeDefined();
      if (provider) expect(validateRealtimeProvider(provider)).toEqual([]);
    },
  );

  it.each(['openai-realtime', 'gemini-live'])('%s requires an apiKey', (id) => {
    const registry = new DefaultRealtimeVoiceProviderRegistry();
    registerBuiltInRealtimeProviders(registry);
    expect(() => registry.get(id)?.(ctx({}))).toThrow(/apiKey/);
  });

  it('refuses to overwrite a live registration', () => {
    const registry = new DefaultRealtimeVoiceProviderRegistry();
    registerBuiltInRealtimeProviders(registry);
    expect(() => registerBuiltInRealtimeProviders(registry)).toThrow(/already registered/);
  });

  it('unregister frees the name again', () => {
    const registry = new DefaultRealtimeVoiceProviderRegistry();
    registerBuiltInRealtimeProviders(registry);
    registry.unregister('gemini-live');
    expect(registry.get('gemini-live')).toBeUndefined();
    expect(registry.list()).toEqual(['openai-realtime']);
  });
});
