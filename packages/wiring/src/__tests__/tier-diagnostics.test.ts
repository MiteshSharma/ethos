// Lane 5(i) — tier-mismatch startup diagnostic. The resolveModelWithTier
// guard (core) silently drops a personality's tier map when the declared
// provider does not match the active LLM; wiring warns at construction. The
// guard itself STAYS — asserted here alongside each diagnostic case so the
// warning provably changes output, not behavior.

import { resolveModelWithTier } from '@ethosagent/core';
import type { PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { evaluateTierMismatch } from '../tier-diagnostics';

function personality(overrides: Partial<PersonalityConfig>): PersonalityConfig {
  return { id: 'researcher', name: 'Researcher', ...overrides };
}

describe('Lane 5(i) — evaluateTierMismatch', () => {
  it('warns on a tier map with a mismatched provider, naming personality, tiers, and both providers', () => {
    const p = personality({
      provider: 'anthropic',
      model: { trivial: 'claude-haiku-4-5', default: 'claude-sonnet-4-6', deep: 'claude-opus-4-7' },
    });
    const warning = evaluateTierMismatch(p, 'ollama');
    expect(warning).toBeDefined();
    expect(warning).toContain('researcher');
    expect(warning).toContain('trivial=claude-haiku-4-5');
    expect(warning).toContain('default=claude-sonnet-4-6');
    expect(warning).toContain('deep=claude-opus-4-7');
    expect(warning).toContain('"anthropic"');
    expect(warning).toContain('"ollama"');
    expect(warning).toContain('inert');

    // Behavior otherwise unchanged: the guard still drops the tiers.
    const resolved = resolveModelWithTier(p, 'trivial', {}, 'ollama', 'qwen3:8b');
    expect(resolved).toEqual({ model: 'qwen3:8b', source: 'global' });
  });

  it('warns when a tier map is declared with NO provider at all', () => {
    const p = personality({ model: { default: 'claude-sonnet-4-6' } });
    const warning = evaluateTierMismatch(p, 'ollama');
    expect(warning).toBeDefined();
    expect(warning).toContain('"(none)"');
  });

  it('stays silent on a tier map with a MATCHING provider', () => {
    const p = personality({
      provider: 'anthropic',
      model: { trivial: 'claude-haiku-4-5', default: 'claude-sonnet-4-6' },
    });
    expect(evaluateTierMismatch(p, 'anthropic')).toBeUndefined();

    // And the tiers actually apply — the guard admits them.
    const resolved = resolveModelWithTier(p, 'trivial', {}, 'anthropic', 'claude-sonnet-4-6');
    expect(resolved).toEqual({ model: 'claude-haiku-4-5', source: 'personality' });
  });

  it('stays silent on a personality with no model block — no new resolution path', () => {
    const p = personality({});
    expect(evaluateTierMismatch(p, 'ollama')).toBeUndefined();
    // Resolution is exactly the pre-diagnostic path: global model.
    const resolved = resolveModelWithTier(p, 'default', {}, 'ollama', 'qwen3:8b');
    expect(resolved).toEqual({ model: 'qwen3:8b', source: 'global' });
  });

  it('stays silent on a plain string model (not a tier map)', () => {
    const p = personality({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
    expect(evaluateTierMismatch(p, 'ollama')).toBeUndefined();
  });
});
