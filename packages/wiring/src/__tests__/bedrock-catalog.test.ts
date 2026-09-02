// Bedrock is registered in both wiring paths but was missing from the provider
// catalog, so `ethos doctor` — which validates `config.provider` against
// exactly that catalog — reported a working config as an unknown provider.

import { DefaultLLMProviderRegistry } from '@ethosagent/core';
import { describe, expect, it } from 'vitest';
import { getProvider, PROVIDER_CATALOG } from '../provider-catalog';
import { registerBuiltinProviders } from '../register-builtin-providers';

describe('provider catalog — bedrock', () => {
  it('lists bedrock as a shipping, keyless provider', () => {
    const bedrock = getProvider('bedrock');
    expect(bedrock).toBeDefined();
    expect(bedrock?.authType).toBe('iam-role');
    expect(bedrock?.costType).toBe('api-billing');
    expect(bedrock?.comingSoon).toBeUndefined();
    // The endpoint is derived from the region by the Bedrock transport.
    expect(bedrock?.defaultBaseUrl).toBeUndefined();
  });

  it("passes doctor's known-provider check", () => {
    const knownIds = PROVIDER_CATALOG.map((p) => p.id);
    expect(knownIds).toContain('bedrock');
  });

  it('is registered as a real LLM provider factory', () => {
    const registry = new DefaultLLMProviderRegistry();
    registerBuiltinProviders(registry);
    expect(registry.list()).toContain('bedrock');
  });
});
