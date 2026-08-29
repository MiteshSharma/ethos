import { describe, expect, it } from 'vitest';
import { cacheHitRate, parseDuration } from '../usage';

// AN-D1 — the cache-hit rate reported by `ethos usage`.

describe('cacheHitRate', () => {
  it('counts cache writes in the denominator', () => {
    // A cache write is input the provider still charged for. Leaving it out
    // would show 100% on a turn that actually paid full price to populate the
    // cache.
    expect(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 100 })).toBe(0);
  });

  it('reports the cached share of everything the model read', () => {
    expect(
      cacheHitRate({ inputTokens: 100, cacheReadTokens: 300, cacheCreationTokens: 100 }),
    ).toBeCloseTo(0.6, 5);
  });

  it('is 0 rather than NaN on an empty window', () => {
    expect(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBe(0);
  });

  it('reaches 1 only when every token came from cache', () => {
    expect(cacheHitRate({ inputTokens: 0, cacheReadTokens: 500, cacheCreationTokens: 0 })).toBe(1);
  });
});

describe('parseDuration', () => {
  it('accepts minutes, hours and days', () => {
    expect(parseDuration('30m')).toBe(30 * 60_000);
    expect(parseDuration('24h')).toBe(24 * 3_600_000);
    expect(parseDuration('7d')).toBe(7 * 86_400_000);
  });

  it('returns 0 for anything it does not understand', () => {
    for (const bad of ['', '7', 'd', '7w', '-1d', '1.5h']) {
      expect(parseDuration(bad)).toBe(0);
    }
  });
});
