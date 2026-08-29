import { describe, expect, it } from 'vitest';
import {
  accentFor,
  BUILTIN_PERSONALITY_IDS,
  DEFAULT_TOKENS,
  isBuiltinPersonality,
  personalityAccent,
} from '../index';
import { hexToHue } from '../validate';

const HEX_PATTERN = /^#[0-9A-F]{6}$/;
const PURPLE_HUE_MIN = 240;
const PURPLE_HUE_MAX = 290;

describe('personalityAccent', () => {
  it('returns the DESIGN.md hex for every built-in personality', () => {
    expect(personalityAccent('researcher')).toBe('#4A9EFF');
    expect(personalityAccent('engineer')).toBe('#4ADE80');
    expect(personalityAccent('reviewer')).toBe('#F59E0B');
    expect(personalityAccent('coach')).toBe('#E879F9');
    expect(personalityAccent('operator')).toBe('#94A3B8');
  });

  it('derives a valid, deterministic hex color for unknown personalities', () => {
    const accent = personalityAccent('not-a-real-personality');
    expect(accent).toMatch(HEX_PATTERN);
    expect(personalityAccent('not-a-real-personality')).toBe(accent);
  });
});

describe('accentFor', () => {
  it('resolves against the supplied token pack', () => {
    const custom = {
      ...DEFAULT_TOKENS,
      accents: { ...DEFAULT_TOKENS.accents, strategist: '#123456' },
    };
    expect(accentFor(custom, 'strategist')).toBe('#123456');
    expect(accentFor(custom, 'engineer')).toBe('#4ADE80');
  });

  it('derives distinct colors per unknown id instead of bucketing into the curated 5', () => {
    // This is the regression this test guards against: hashing unknown ids
    // into Object.values(tokens.accents) meant, with only 5 curated colors,
    // any deployment with more than 5 personalities was guaranteed
    // collisions. Two different unknown ids must resolve to different hexes.
    const a = accentFor(DEFAULT_TOKENS, 'strategist');
    const b = accentFor(DEFAULT_TOKENS, 'ghost');
    expect(a).toMatch(HEX_PATTERN);
    expect(b).toMatch(HEX_PATTERN);
    expect(a).not.toBe(b);
  });

  it('is deterministic per id', () => {
    expect(accentFor(DEFAULT_TOKENS, 'ghost')).toBe(accentFor(DEFAULT_TOKENS, 'ghost'));
  });

  it('avoids the slop-blacklisted purple/violet/indigo hue band for derived colors', () => {
    const sampleIds = [
      'strategist',
      'ghost',
      'not-a-real-personality',
      'analyst',
      'planner',
      'archivist',
      'scout',
      'curator',
    ];
    for (const id of sampleIds) {
      const hex = accentFor(DEFAULT_TOKENS, id);
      const hue = hexToHue(hex);
      if (hue === null) continue; // grey, no hue to check
      const inPurpleBand = hue >= PURPLE_HUE_MIN && hue <= PURPLE_HUE_MAX;
      expect(inPurpleBand, `${id} -> ${hex} landed at hue ${hue}° inside the purple band`).toBe(
        false,
      );
    }
  });
});

describe('isBuiltinPersonality', () => {
  it('matches every built-in id and rejects custom ones', () => {
    for (const id of BUILTIN_PERSONALITY_IDS) {
      expect(isBuiltinPersonality(id)).toBe(true);
    }
    expect(isBuiltinPersonality('strategist')).toBe(false);
    expect(isBuiltinPersonality('')).toBe(false);
  });
});

describe('BUILTIN_PERSONALITY_IDS', () => {
  it('lists the five DESIGN.md personalities', () => {
    expect([...BUILTIN_PERSONALITY_IDS].sort()).toEqual(
      ['coach', 'engineer', 'operator', 'researcher', 'reviewer'].sort(),
    );
  });
});
