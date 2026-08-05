// Lane 5 — the setup wizard's "Supported providers" hint derives from the
// provider catalog, so it can never drift from what wiring supports. This
// test compares both derivations AND pins the expected roster: a catalog
// change (new provider, comingSoon flip) fails here, forcing the hint and
// the docs provider matrix to be reconciled deliberately.

import { PROVIDER_CATALOG } from '@ethosagent/wiring/provider-catalog';
import { describe, expect, it } from 'vitest';
import { supportedProvidersHint } from '../commands/setup';

describe('Lane 5 — setup provider hint', () => {
  it('matches the catalog non-comingSoon set exactly', () => {
    const fromCatalog = PROVIDER_CATALOG.filter((p) => !p.comingSoon).map((p) => p.id);
    expect(supportedProvidersHint()).toBe(fromCatalog.join(', '));
  });

  it('pins the seven supported providers (catalog drift must be deliberate)', () => {
    const fromCatalog = PROVIDER_CATALOG.filter((p) => !p.comingSoon).map((p) => p.id);
    expect(fromCatalog).toEqual([
      'anthropic',
      'openai',
      'codex',
      'openrouter',
      'azure',
      'ollama',
      'vllm',
    ]);
  });
});
