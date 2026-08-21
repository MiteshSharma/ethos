// Lane A Phase 2 (kanban-hooks-notify-parity) — auxiliary model resolution
// for kanban_decompose. Mirrors compression-summarizer.test.ts's shape: a
// stub factory records the config it's constructed with, asserted at the
// factory seam. No window-probe/profile threading here (unlike compression) —
// kanban_decompose is a plain auxiliary completion call, so resolution is
// just provider/model/apiKey/baseUrl precedence plus the degrade-on-missing-
// provider behavior shared with auxiliaryVision/auxiliaryWeb.

import { DefaultLLMProviderRegistry } from '@ethosagent/core';
import type { CompletionChunk, LLMProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { buildKanbanDecomposerProvider } from '../compose-tools';
import type { WiringConfig } from '../index';

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLog,
};

function stubProvider(config: Record<string, unknown>): LLMProvider {
  return {
    name: String(config.provider),
    model: String(config.model),
    maxContextTokens: 0,
    supportsCaching: false,
    supportsThinking: false,
    complete(): AsyncIterable<CompletionChunk> {
      return (async function* () {
        yield { type: 'text_delta', text: '[]' } as CompletionChunk;
      })();
    },
    async countTokens() {
      return 0;
    },
  } as unknown as LLMProvider;
}

function registryRecording(seen: Record<string, unknown>[]): DefaultLLMProviderRegistry {
  const registry = new DefaultLLMProviderRegistry();
  registry.register('anthropic', ({ config }) => {
    seen.push(config as Record<string, unknown>);
    return stubProvider(config as Record<string, unknown>);
  });
  return registry;
}

describe('buildKanbanDecomposerProvider', () => {
  it('returns undefined when auxiliaryKanbanDecomposer is not configured', async () => {
    const registry = registryRecording([]);
    const config: WiringConfig = { provider: 'anthropic', model: 'main-model', apiKey: 'k' };
    const provider = await buildKanbanDecomposerProvider(registry, config, noopLog);
    expect(provider).toBeUndefined();
  });

  it('builds the provider, defaulting provider/apiKey/baseUrl to the primary values when aux overrides are unset', async () => {
    const seen: Record<string, unknown>[] = [];
    const registry = registryRecording(seen);
    const config: WiringConfig = {
      provider: 'anthropic',
      model: 'main-model',
      apiKey: 'primary-key',
      baseUrl: 'https://primary.example',
      auxiliaryKanbanDecomposer: { model: 'aux-model' },
    };
    const provider = await buildKanbanDecomposerProvider(registry, config, noopLog);
    expect(provider).toBeDefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.provider).toBe('anthropic');
    expect(seen[0]?.model).toBe('aux-model');
    expect(seen[0]?.apiKey).toBe('primary-key');
    expect(seen[0]?.baseUrl).toBe('https://primary.example');
  });

  it('prefers aux-specific provider/apiKey/baseUrl overrides when set', async () => {
    const seen: Record<string, unknown>[] = [];
    const registry = new DefaultLLMProviderRegistry();
    registry.register('ollama', ({ config }) => {
      seen.push(config as Record<string, unknown>);
      return stubProvider(config as Record<string, unknown>);
    });
    const config: WiringConfig = {
      provider: 'anthropic',
      model: 'main-model',
      apiKey: 'primary-key',
      auxiliaryKanbanDecomposer: {
        model: 'aux-model',
        provider: 'ollama',
        apiKey: 'aux-key',
        baseUrl: 'http://localhost:11434/v1',
      },
    };
    const provider = await buildKanbanDecomposerProvider(registry, config, noopLog);
    expect(provider).toBeDefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.provider).toBe('ollama');
    expect(seen[0]?.model).toBe('aux-model');
    expect(seen[0]?.apiKey).toBe('aux-key');
    expect(seen[0]?.baseUrl).toBe('http://localhost:11434/v1');
  });

  it('warns and degrades to undefined (not a throw) when the aux provider is not registered', async () => {
    const registry = new DefaultLLMProviderRegistry(); // nothing registered
    const warnings: string[] = [];
    const log = { ...noopLog, warn: (msg: string) => warnings.push(msg) };
    const config: WiringConfig = {
      provider: 'anthropic',
      model: 'main-model',
      apiKey: 'k',
      auxiliaryKanbanDecomposer: { model: 'aux-model', provider: 'unregistered-provider' },
    };
    const provider = await buildKanbanDecomposerProvider(registry, config, log);
    expect(provider).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /auxiliary\.kanban_decomposer provider "unregistered-provider" is not registered/,
    );
  });
});
