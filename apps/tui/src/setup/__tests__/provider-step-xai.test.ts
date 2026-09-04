import {
  getProvider,
  PROVIDER_CATALOG,
  type ProviderCatalogEntry,
} from '@ethosagent/wiring/provider-catalog';
import { describe, expect, it } from 'vitest';

// Tests 26 and 27 of plan/phases/xai-grok-provider.md — xAI reached through the
// two TUI provider pickers.
//
// `ProviderStep` and `MultiProviderStep` are Ink components with no exported
// seam, and apps/tui carries no renderer (no ink-testing-library in the
// workspace). Following `wizard-reducer.test.ts`, the pure selection logic is
// inlined here and the catalog facts it reads are asserted against the real
// `PROVIDER_CATALOG`. Keep the two helpers below in sync with
// `apps/tui/src/setup/steps/{ProviderStep,MultiProviderStep}.tsx`.

/** Mirrors `nextEnabled` in ProviderStep.tsx — arrow keys skip `comingSoon`. */
function nextEnabled(entries: ProviderCatalogEntry[], from: number, dir: 1 | -1): number {
  let i = from + dir;
  while (i >= 0 && i < entries.length) {
    if (!entries[i]?.comingSoon) return i;
    i += dir;
  }
  return from;
}

/** Mirrors ProviderStep.tsx's Enter branch: the patch it dispatches, or null
 *  when the highlighted row is `comingSoon` (Enter is a no-op there). */
function confirmPatch(index: number): { provider: string; baseUrl: string | undefined } | null {
  const entry = PROVIDER_CATALOG[index];
  if (!entry || entry.comingSoon) return null;
  return { provider: entry.id, baseUrl: entry.defaultBaseUrl };
}

const XAI_INDEX = PROVIDER_CATALOG.findIndex((e) => e.id === 'xai');

describe('ProviderStep — xAI (plan test 26)', () => {
  it('lists xAI as a selectable provider', () => {
    expect(XAI_INDEX).toBeGreaterThanOrEqual(0);
    expect(getProvider('xai')?.comingSoon).toBeUndefined();
    expect(getProvider('xai')?.authType).toBe('api-key');
  });

  it('arrow navigation lands on xAI instead of skipping it', () => {
    const previous = XAI_INDEX - 1;
    expect(nextEnabled(PROVIDER_CATALOG, previous, 1)).toBe(XAI_INDEX);
  });

  it('confirming xAI writes the catalog default base URL', () => {
    expect(confirmPatch(XAI_INDEX)).toEqual({
      provider: 'xai',
      baseUrl: 'https://api.x.ai/v1',
    });
  });

  it('skips the coming-soon block below xAI rather than stalling on it', () => {
    // xAI is the last enabled row before gemini/groq/deepseek, so a down-arrow
    // from it must jump the whole run to the next enabled entry.
    const below = nextEnabled(PROVIDER_CATALOG, XAI_INDEX, 1);
    expect(PROVIDER_CATALOG[below]?.comingSoon).toBeUndefined();
    expect(below).toBeGreaterThan(XAI_INDEX);
  });
});

/** Mirrors MultiProviderStep.tsx's `add-provider` cursor: clamped to the
 *  catalog bounds, with NO `comingSoon` skip. See plan/uncompleted-tasks.md —
 *  the divergence from ProviderStep is a known pre-existing inconsistency and
 *  is asserted here as current behaviour, not endorsed. */
function clampCursor(from: number, dir: 1 | -1): number {
  return dir === 1 ? Math.min(PROVIDER_CATALOG.length - 1, from + 1) : Math.max(0, from - 1);
}

/** Mirrors MultiProviderStep.tsx's `add-key` Enter branch. */
function appendEntry(providerIdx: number, apiKey: string) {
  const entry = PROVIDER_CATALOG[providerIdx];
  if (!entry) return null;
  return { provider: entry.id, apiKey, baseUrl: entry.defaultBaseUrl };
}

describe('MultiProviderStep — xAI as a fallback (plan test 27)', () => {
  it('reaches xAI with the clamped cursor', () => {
    expect(clampCursor(XAI_INDEX - 1, 1)).toBe(XAI_INDEX);
  });

  it('adds xAI to the chain with its catalog base URL', () => {
    expect(appendEntry(XAI_INDEX, 'xai-test-key')).toEqual({
      provider: 'xai',
      apiKey: 'xai-test-key',
      baseUrl: 'https://api.x.ai/v1',
    });
  });

  it('writes no model, so the entry inherits the primary model', () => {
    const added = appendEntry(XAI_INDEX, 'xai-test-key');
    // `packages/wiring/src/index.ts` resolves a chain entry with `p.model ??
    // config.model`, so an xAI fallback added here runs on the PRIMARY
    // provider's model id until the operator edits config.yaml. Asserted so the
    // gap is recorded rather than discovered at request time.
    expect(added).not.toHaveProperty('model');
  });

  it('does not skip coming-soon rows the way ProviderStep does', () => {
    // Current behaviour: the cursor steps onto the disabled row below xAI.
    const below = clampCursor(XAI_INDEX, 1);
    expect(below).toBe(XAI_INDEX + 1);
    expect(PROVIDER_CATALOG[below]?.comingSoon).toBe(true);
  });
});
