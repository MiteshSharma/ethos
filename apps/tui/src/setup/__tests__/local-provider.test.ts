import { getProvider } from '@ethosagent/wiring/provider-catalog';
import { describe, expect, it } from 'vitest';
import { LOCAL_API_KEY_PLACEHOLDER, localProviderPlan } from '../local-provider';

describe('localProviderPlan', () => {
  it('flags ollama as local: skip api key, fetch models, localhost base URL', () => {
    const plan = localProviderPlan('ollama');
    expect(plan.isLocal).toBe(true);
    expect(plan.skipApiKey).toBe(true);
    expect(plan.needsModelFetch).toBe(true);
    expect(plan.defaultBaseUrl).toBe('http://localhost:11434/v1');
  });

  it('flags vllm as local with its own localhost default', () => {
    const plan = localProviderPlan('vllm');
    expect(plan.isLocal).toBe(true);
    expect(plan.skipApiKey).toBe(true);
    expect(plan.needsModelFetch).toBe(true);
    expect(plan.defaultBaseUrl).toBe('http://localhost:8000/v1');
  });

  it('treats api-key providers as non-local (keep key + catalog models)', () => {
    for (const id of ['anthropic', 'openai', 'openrouter', 'azure']) {
      const plan = localProviderPlan(id);
      expect(plan.isLocal).toBe(false);
      expect(plan.skipApiKey).toBe(false);
      expect(plan.needsModelFetch).toBe(false);
    }
  });

  it('treats bedrock as non-local — its keyless branch is iam-role, not self-hosted', () => {
    const plan = localProviderPlan('bedrock');
    expect(plan.isLocal).toBe(false);
    expect(plan.needsModelFetch).toBe(false);
    expect(plan.defaultBaseUrl).toBeUndefined();
    // AuthStep skips the key prompt off `authType`, not off the local plan.
    expect(getProvider('bedrock')?.authType).toBe('iam-role');
  });

  it('is non-local for an unknown or undefined provider', () => {
    expect(localProviderPlan('does-not-exist').isLocal).toBe(false);
    expect(localProviderPlan(undefined).isLocal).toBe(false);
  });

  it('exposes a non-empty placeholder key (openai-compat client rejects empty)', () => {
    expect(LOCAL_API_KEY_PLACEHOLDER).toBe('local');
    expect(LOCAL_API_KEY_PLACEHOLDER.length).toBeGreaterThan(0);
  });
});
