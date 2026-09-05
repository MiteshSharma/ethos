import { describe, expect, it } from 'vitest';
import { buildManifest, groupByProvider } from '../models';

describe('model catalog handler', () => {
  it('groups catalog entries by providerId', () => {
    const manifest = buildManifest();
    const anthropic = manifest.providers.anthropic;
    expect(anthropic).toBeDefined();
    expect(Array.isArray(anthropic?.models)).toBe(true);
    expect((anthropic?.models.length ?? 0) > 0).toBe(true);
    expect(anthropic?.models.some((m) => m.id === 'claude-opus-4-7')).toBe(true);
  });

  it('preserves the default flag only on default models', () => {
    const manifest = buildManifest();
    const anthropic = manifest.providers.anthropic;
    const sonnet = anthropic?.models.find((m) => m.id === 'claude-sonnet-5');
    expect(sonnet?.default).toBe(true);
    const opus = anthropic?.models.find((m) => m.id === 'claude-opus-4-7');
    expect(opus).toBeDefined();
    expect('default' in (opus ?? {})).toBe(false);
  });

  it('stamps version 1', () => {
    expect(buildManifest().version).toBe(1);
  });

  it('stamps a valid ISO datetime', () => {
    const manifest = buildManifest();
    expect(Number.isNaN(Date.parse(manifest.updatedAt))).toBe(false);
  });

  it('groupByProvider on empty input returns an empty map', () => {
    expect(groupByProvider([])).toEqual({});
  });
});
