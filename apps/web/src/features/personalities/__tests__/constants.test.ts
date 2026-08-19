import { describe, expect, it } from 'vitest';
import { filterSelectablePersonalities, SYSTEM_PERSONALITY_IDS } from '../constants';

describe('SYSTEM_PERSONALITY_IDS', () => {
  it('is exactly the three internal/utility personalities', () => {
    expect(SYSTEM_PERSONALITY_IDS).toEqual(
      new Set(['debug', 'personality-architect', 'team-architect']),
    );
  });
});

describe('filterSelectablePersonalities', () => {
  const items = [
    { id: 'engineer', name: 'Engineer' },
    { id: 'debug', name: 'Debug Assistant' },
    { id: 'researcher', name: 'Researcher' },
    { id: 'personality-architect', name: 'Personality Architect' },
    { id: 'team-architect', name: 'Team Architect' },
  ];

  it('excludes the three system personalities', () => {
    const out = filterSelectablePersonalities(items);
    expect(out.map((p) => p.id)).toEqual(['engineer', 'researcher']);
  });

  it('keeps non-system personalities untouched', () => {
    const out = filterSelectablePersonalities(items);
    expect(out.some((p) => p.id === 'engineer')).toBe(true);
    expect(out.some((p) => p.id === 'researcher')).toBe(true);
  });

  it('returns an empty list when everything is a system personality', () => {
    const onlySystem = items.filter((p) => SYSTEM_PERSONALITY_IDS.has(p.id));
    expect(filterSelectablePersonalities(onlySystem)).toEqual([]);
  });

  it('returns an empty list for no items', () => {
    expect(filterSelectablePersonalities([])).toEqual([]);
  });
});
