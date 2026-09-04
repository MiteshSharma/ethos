import { ProviderIdSchema } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import {
  EXPANDED_PROVIDERS,
  getCatalogEntry,
  PROVIDER_CATALOG,
  RECOMMENDED_PROVIDERS,
} from '../providers';

// The onboarding catalog is a narrower roster than
// `packages/wiring/src/provider-catalog.ts`, so a provider can be fully wired
// and still be invisible on the "Pick a model API." step. These lock the three
// things that have to line up for an entry to actually reach the server.

describe('onboarding provider catalog', () => {
  it('every entry resolves through getCatalogEntry (no silent anthropic fallback)', () => {
    for (const entry of PROVIDER_CATALOG) {
      const found = getCatalogEntry(entry.id);
      expect(found.id, `getCatalogEntry("${entry.id}") fell back`).toBe(entry.id);
    }
  });

  it('every wiresAs is a member of ProviderIdSchema', () => {
    // Onboarding.tsx and AuthStep.tsx both `as ProviderId`-cast this value, so
    // a missing enum member survives typecheck and fails Zod at runtime.
    for (const entry of PROVIDER_CATALOG) {
      expect(
        ProviderIdSchema.safeParse(entry.wiresAs).success,
        `wiresAs "${entry.wiresAs}" (from "${entry.id}") is not a ProviderId`,
      ).toBe(true);
    }
  });

  describe('xAI', () => {
    it('resolves rather than falling back to anthropic', () => {
      const entry = getCatalogEntry('xai');
      expect(entry.id).toBe('xai');
      expect(entry.wiresAs).toBe('xai');
      expect(entry.authType).toBe('api-key');
      expect(entry.signupUrl).toBe('https://console.x.ai/');
    });

    it('sits behind "Show all providers", not in the recommended set', () => {
      // Deliberate: Grok is paid with no free tier. Falsy `recommended` +
      // `authType: 'api-key'` is what puts it in the disclosure.
      expect(EXPANDED_PROVIDERS.map((p) => p.id)).toContain('xai');
      expect(RECOMMENDED_PROVIDERS.map((p) => p.id)).not.toContain('xai');
    });

    it('declares no baseUrl block, so AuthStep prompts for a key only', () => {
      // The provider pins https://api.x.ai/v1 and ignores config, so a URL
      // field would offer a choice that does nothing. AuthStep gates the input
      // on `!!catalog.baseUrl`.
      expect(getCatalogEntry('xai').baseUrl).toBeUndefined();
    });
  });
});
