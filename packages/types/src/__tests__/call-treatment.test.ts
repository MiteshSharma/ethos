import { describe, expect, it } from 'vitest';
import {
  CALL_TREATMENTS,
  type CallTreatment,
  derivedCallTreatment,
  resolveCallTreatment,
} from '../personality';

// The one precedence rule for which shape a call draws. It lives in the
// contracts layer because three surfaces answer the question — the web Call
// Stage, the character sheet, and (through them) the config editor — and three
// copies of an ordering is three chances to disagree about it.

describe('derivedCallTreatment', () => {
  it('is stable for a given id — same shape on every machine, every restart', () => {
    // Pinned literals, not a recomputation: a test that recomputes the hash
    // agrees with any hash, including a new one that silently reshuffles every
    // existing personality's look on upgrade.
    expect(derivedCallTreatment('researcher')).toBe('liquid');
    expect(derivedCallTreatment('engineer')).toBe('orb');
    expect(derivedCallTreatment('reviewer')).toBe('rings');
    expect(derivedCallTreatment('coach')).toBe('liquid');
    expect(derivedCallTreatment('operator')).toBe('liquid');
  });

  it('only ever returns a real treatment, including for the empty id', () => {
    for (const id of ['', 'a', 'a-very-long-personality-id-with-dashes', '🌀', 'Zz9']) {
      expect(CALL_TREATMENTS).toContain(derivedCallTreatment(id));
    }
  });

  it('spreads ids across all three treatments rather than favouring one', () => {
    const seen = new Set<CallTreatment>();
    for (let i = 0; i < 200; i++) seen.add(derivedCallTreatment(`personality-${i}`));
    expect([...seen].sort()).toEqual(['liquid', 'orb', 'rings']);
  });
});

describe('resolveCallTreatment', () => {
  it('1. the personality wins — explicit identity beats everything', () => {
    expect(
      resolveCallTreatment({
        personalityId: 'engineer',
        personalityCallStyle: 'rings',
        operatorCallStyle: 'liquid',
      }),
    ).toBe('rings');
  });

  it('2. a concrete operator pin wins when the personality is silent', () => {
    expect(resolveCallTreatment({ personalityId: 'engineer', operatorCallStyle: 'liquid' })).toBe(
      'liquid',
    );
  });

  it('2b. `personality` is not a pin — it defers to the derivation', () => {
    expect(
      resolveCallTreatment({ personalityId: 'engineer', operatorCallStyle: 'personality' }),
    ).toBe('orb');
  });

  it('3. nothing set at all derives from the id', () => {
    expect(resolveCallTreatment({ personalityId: 'reviewer' })).toBe('rings');
    expect(
      resolveCallTreatment({
        personalityId: 'reviewer',
        personalityCallStyle: undefined,
        operatorCallStyle: undefined,
      }),
    ).toBe('rings');
  });

  it('a personality pin survives an operator pin that disagrees', () => {
    // The interesting half of rule 1: an operator who pinned `orb` globally
    // still sees the one personality that declared its own look.
    for (const operator of CALL_TREATMENTS) {
      expect(
        resolveCallTreatment({
          personalityId: 'coach',
          personalityCallStyle: 'orb',
          operatorCallStyle: operator,
        }),
      ).toBe('orb');
    }
  });
});
