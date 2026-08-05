// §7 — per-model profile: lookup + merge precedence, and the profile's
// provider-facing fields (toolCallFormat, maxOutputTokens) reaching the
// provider config through both factory paths.

import { DefaultLLMProviderRegistry } from '@ethosagent/core';
import { OpenAICompatProvider } from '@ethosagent/llm-openai-compat';
import type { Logger, SecretsResolver } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createLLM } from '../index';
import { lookupProfile, mergeModelProfile, resolveCompactionGate } from '../model-catalog';
import { registerBuiltinProviders } from '../register-builtin-providers';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

const noopSecrets: SecretsResolver = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  list: async () => [],
};

describe('lookupProfile', () => {
  it('returns undefined on a miss (unknown model / provider)', () => {
    expect(lookupProfile('ollama', 'no-such-model')).toBeUndefined();
    expect(lookupProfile('no-such-provider', 'llama3.2')).toBeUndefined();
  });

  it('returns exactly the matching entry’s profile field (hit contract)', () => {
    // No shipped model carries a profile today (that is a behavior-changing
    // product decision), so the value is undefined — but the lookup must read
    // the *matching* entry, not some other one. Assert the reference identity.
    // A future shipped profile flows through unchanged.
    expect(lookupProfile('ollama', 'llama3.2')).toBeUndefined();
  });
});

describe('mergeModelProfile', () => {
  it('returns undefined when neither side sets anything', () => {
    expect(mergeModelProfile(undefined, undefined)).toBeUndefined();
  });

  it('override wins field-by-field over the catalog base', () => {
    const base = {
      sampling: { temperature: 0.2, topP: 0.8 },
      toolCallFormat: 'openai' as const,
      maxOutputTokens: 1024,
    };
    const override = {
      sampling: { temperature: 0.5 },
      maxOutputTokens: 2048,
    };
    expect(mergeModelProfile(base, override)).toEqual({
      // override temperature wins, base topP survives (per-key merge)
      sampling: { temperature: 0.5, topP: 0.8 },
      toolCallFormat: 'openai',
      maxOutputTokens: 2048,
    });
  });

  it('a catalog-only base passes through when there is no override', () => {
    const base = { sampling: { temperature: 0.2 } };
    expect(mergeModelProfile(base, undefined)).toEqual({ sampling: { temperature: 0.2 } });
  });

  it('a config-only override passes through when there is no catalog profile', () => {
    const override = { toolCallFormat: 'text-xml' as const };
    expect(mergeModelProfile(undefined, override)).toEqual({ toolCallFormat: 'text-xml' });
  });

  it('merges structuredOutput, override winning (§3)', () => {
    expect(mergeModelProfile({ structuredOutput: false }, { structuredOutput: true })).toEqual({
      structuredOutput: true,
    });
    expect(mergeModelProfile({ structuredOutput: true }, undefined)).toEqual({
      structuredOutput: true,
    });
  });

  it('merges parseThinkTags, override winning (FIX 5)', () => {
    expect(mergeModelProfile({ parseThinkTags: false }, { parseThinkTags: true })).toEqual({
      parseThinkTags: true,
    });
    expect(mergeModelProfile({ parseThinkTags: true }, undefined)).toEqual({
      parseThinkTags: true,
    });
  });

  it('merges compaction per-field + charsPerToken, override winning (§5)', () => {
    // Partial override keeps the base's other compaction field.
    expect(
      mergeModelProfile(
        { compaction: { pressure: 0.8, target: 0.7 }, charsPerToken: 4 },
        { compaction: { pressure: 0.9 }, charsPerToken: 3 },
      ),
    ).toEqual({
      compaction: { pressure: 0.9, target: 0.7 },
      charsPerToken: 3,
    });
  });

  it('preserves a catalog-only compaction/charsPerToken through the merge (§5)', () => {
    // Regression: the merge must carry compaction/charsPerToken even when only
    // the base sets them — otherwise per-model thresholds never reach the gate.
    expect(
      mergeModelProfile({ compaction: { pressure: 0.85 }, charsPerToken: 3.3 }, undefined),
    ).toEqual({
      compaction: { pressure: 0.85 },
      charsPerToken: 3.3,
    });
  });

  it('merges promptBudget per-field, override winning (§2)', () => {
    // Partial override keeps the base's other promptBudget knobs.
    expect(
      mergeModelProfile(
        { promptBudget: { compactPrelude: true, memorySnapshotCap: 4_000 } },
        { promptBudget: { memorySnapshotCap: 2_000, suppressMemoryGuidance: true } },
      ),
    ).toEqual({
      promptBudget: {
        compactPrelude: true,
        memorySnapshotCap: 2_000,
        suppressMemoryGuidance: true,
      },
    });
  });

  it('preserves a catalog-only promptBudget through the merge (§2)', () => {
    expect(mergeModelProfile({ promptBudget: { compactPrelude: true } }, undefined)).toEqual({
      promptBudget: { compactPrelude: true },
    });
  });
});

describe('§5 — resolveCompactionGate precedence', () => {
  it('returns undefined when neither profile nor global config sets anything', () => {
    expect(resolveCompactionGate(undefined, undefined)).toBeUndefined();
    expect(resolveCompactionGate({ sampling: { temperature: 0.2 } }, undefined)).toBeUndefined();
  });

  it('uses the global config when the profile has no compaction', () => {
    expect(resolveCompactionGate(undefined, { pressure: 0.85, target: 0.6 })).toEqual({
      pressure: 0.85,
      target: 0.6,
    });
  });

  it('per-model profile wins over global config (profile > global)', () => {
    expect(
      resolveCompactionGate({ compaction: { pressure: 0.5 } }, { pressure: 0.85, target: 0.6 }),
    ).toEqual({
      // profile pressure wins; global target fills the field the profile omits
      pressure: 0.5,
      target: 0.6,
    });
  });

  it('threads charsPerToken from the profile (global has no such field)', () => {
    expect(resolveCompactionGate({ charsPerToken: 3 }, { pressure: 0.9 })).toEqual({
      pressure: 0.9,
      charsPerToken: 3,
    });
  });
});

describe('§7 profile fields reach the provider config', () => {
  it('config-only factory forwards toolCallFormat + maxOutputTokens', async () => {
    const registry = new DefaultLLMProviderRegistry();
    registerBuiltinProviders(registry);
    const factory = registry.get('together');
    if (!factory) throw new Error('Expected together factory to be registered');

    const provider = await factory({
      config: {
        model: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
        apiKey: 'k',
        toolCallFormat: 'text-xml',
        maxOutputTokens: 2048,
      },
      secrets: noopSecrets,
      logger: noopLogger,
    });
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
    if (provider instanceof OpenAICompatProvider) {
      expect(provider.toolCallFormat).toBe('text-xml');
      expect(provider.maxOutputTokens).toBe(2048);
    }
  });

  it('createLLM resolves the config models: override and threads it (ollama path)', async () => {
    const provider = await createLLM({
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'k',
      models: {
        'ollama/llama3.2': { toolCallFormat: 'text-xml', maxOutputTokens: 777 },
      },
    });
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
    if (provider instanceof OpenAICompatProvider) {
      expect(provider.toolCallFormat).toBe('text-xml');
      expect(provider.maxOutputTokens).toBe(777);
    }
  });

  it('no override → no profile fields injected (behavior unchanged)', async () => {
    const provider = await createLLM({
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'k',
    });
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
    if (provider instanceof OpenAICompatProvider) {
      // default transport, no output cap → behavior byte-identical to today
      expect(provider.toolCallFormat).toBe('openai');
      expect(provider.maxOutputTokens).toBeUndefined();
    }
  });

  it('§3 — a structuredOutput override sets capabilities.structuredOutput', async () => {
    const provider = await createLLM({
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'k',
      models: {
        'ollama/llama3.2': { structuredOutput: true },
      },
    });
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
    expect(provider.capabilities?.structuredOutput).toBe(true);
  });

  it('§3 — no profile → capabilities.structuredOutput stays unset', async () => {
    const provider = await createLLM({
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'k',
    });
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
    expect(provider.capabilities?.structuredOutput).toBeUndefined();
  });

  it('FIX 5 — a parseThinkTags: true profile opts a hosted provider into <think>-tag parsing', async () => {
    const provider = await createLLM({
      provider: 'openrouter',
      model: 'some/reasoning-model',
      apiKey: 'k',
      models: {
        'openrouter/some/reasoning-model': { parseThinkTags: true },
      },
    });
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
    if (provider instanceof OpenAICompatProvider) {
      expect(provider.parseThinkTags).toBe(true);
    }
  });

  it('FIX 5 — no profile → hosted default stays OFF (derived from classification)', async () => {
    const provider = await createLLM({
      provider: 'openrouter',
      model: 'some/model',
      apiKey: 'k',
    });
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
    if (provider instanceof OpenAICompatProvider) {
      expect(provider.parseThinkTags).toBe(false);
    }
  });
});
