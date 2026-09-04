// Lane 5 — the setup wizard's "Supported providers" hint derives from the
// provider catalog, so it can never drift from what wiring supports. This
// test compares both derivations AND pins the expected roster: a catalog
// change (new provider, comingSoon flip) fails here, forcing the hint and
// the docs provider matrix to be reconciled deliberately.

import { getProvider, PROVIDER_CATALOG } from '@ethosagent/wiring/provider-catalog';
import { describe, expect, it } from 'vitest';
import { resolveWizardBaseUrl, supportedProvidersHint } from '../commands/setup';

describe('Lane 5 — setup provider hint', () => {
  it('matches the catalog non-comingSoon set exactly', () => {
    const fromCatalog = PROVIDER_CATALOG.filter((p) => !p.comingSoon).map((p) => p.id);
    expect(supportedProvidersHint()).toBe(fromCatalog.join(', '));
  });

  it('pins the nine supported providers (catalog drift must be deliberate)', () => {
    const fromCatalog = PROVIDER_CATALOG.filter((p) => !p.comingSoon).map((p) => p.id);
    expect(fromCatalog).toEqual([
      'anthropic',
      'openai',
      'codex',
      'openrouter',
      'azure',
      'bedrock',
      'xai',
      'ollama',
      'vllm',
    ]);
  });
});

// D9 — the readline wizard's base-URL default. This line runs for every
// non-local provider in the wizard, so the regression that matters is the
// providers that carry NO catalog `defaultBaseUrl`: they must still get the
// historical OpenRouter literal, byte-identical to before the fix.
describe('D9 — wizard base-URL default', () => {
  it('leaves providers with no catalog defaultBaseUrl on the OpenRouter literal', () => {
    for (const provider of ['openai', 'anthropic', 'codex', 'azure', 'bedrock']) {
      expect(getProvider(provider)?.defaultBaseUrl).toBeUndefined();
      expect(resolveWizardBaseUrl(provider)).toBe('https://openrouter.ai/api/v1');
    }
  });

  it('uses the catalog URL for providers that carry one', () => {
    const expected: Record<string, string> = {
      openrouter: 'https://openrouter.ai/api/v1',
      xai: 'https://api.x.ai/v1',
      gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
      groq: 'https://api.groq.com/openai/v1',
      deepseek: 'https://api.deepseek.com/v1',
      ollama: 'http://localhost:11434/v1',
      vllm: 'http://localhost:8000/v1',
    };
    for (const [provider, url] of Object.entries(expected)) {
      expect(getProvider(provider)?.defaultBaseUrl).toBe(url);
      expect(resolveWizardBaseUrl(provider)).toBe(url);
    }
  });

  it('falls back to the literal for an unknown provider id', () => {
    expect(resolveWizardBaseUrl('not-a-provider')).toBe('https://openrouter.ai/api/v1');
  });
});
