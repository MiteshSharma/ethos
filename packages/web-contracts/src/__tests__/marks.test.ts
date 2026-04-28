import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PERSONALITY_IDS,
  fnv1a32,
  generatePersonalityMark,
  isBuiltinPersonality,
  PERSONALITY_ACCENTS,
  personalityAccent,
} from '../marks';

// The personality mark is the load-bearing identity affordance from
// DESIGN.md. These tests lock the contract every renderer depends on:
// determinism, mirror symmetry, distinct outputs across the built-ins,
// and the bounded opacity set.

describe('fnv1a32', () => {
  it('is deterministic — same input yields same hash', () => {
    expect(fnv1a32('engineer')).toBe(fnv1a32('engineer'));
  });

  it('produces different hashes for different inputs', () => {
    expect(fnv1a32('engineer')).not.toBe(fnv1a32('researcher'));
  });

  it('returns an unsigned 32-bit integer', () => {
    const h = fnv1a32('arbitrary string with unicode é🦊');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(h)).toBe(true);
  });
});

describe('generatePersonalityMark', () => {
  it('is deterministic — same id yields the same spec', () => {
    const a = generatePersonalityMark('engineer');
    const b = generatePersonalityMark('engineer');
    expect(a).toEqual(b);
  });

  it('keeps every cell within the 5×5 grid', () => {
    for (const id of BUILTIN_PERSONALITY_IDS) {
      const spec = generatePersonalityMark(id);
      for (const cell of spec.cells) {
        expect(cell.row).toBeGreaterThanOrEqual(0);
        expect(cell.row).toBeLessThanOrEqual(4);
        expect(cell.col).toBeGreaterThanOrEqual(0);
        expect(cell.col).toBeLessThanOrEqual(4);
      }
    }
  });

  it('opacities are drawn from the bounded set {0.55, 0.68, 0.81, 0.93}', () => {
    const allowed = new Set([0.55, 0.68, 0.81, 0.93]);
    for (const id of BUILTIN_PERSONALITY_IDS) {
      const spec = generatePersonalityMark(id);
      for (const cell of spec.cells) {
        expect(allowed.has(cell.opacity)).toBe(true);
      }
    }
  });

  it('is mirror-symmetric — every off-center cell has a partner at col 4 - col', () => {
    for (const id of [...BUILTIN_PERSONALITY_IDS, 'random-custom', 'a', 'with spaces']) {
      const spec = generatePersonalityMark(id);
      const key = (c: { row: number; col: number; opacity: number }) =>
        `${c.row}:${c.col}:${c.opacity}`;
      const seen = new Set(spec.cells.map(key));
      for (const cell of spec.cells) {
        if (cell.col === 2) continue; // center column mirrors to itself
        const mirror = { row: cell.row, col: 4 - cell.col, opacity: cell.opacity };
        expect(seen.has(key(mirror))).toBe(true);
      }
    }
  });

  it('center-column cells appear exactly once (no double-mirror)', () => {
    for (const id of BUILTIN_PERSONALITY_IDS) {
      const spec = generatePersonalityMark(id);
      const centerCells = spec.cells.filter((c) => c.col === 2);
      const uniqueRows = new Set(centerCells.map((c) => c.row));
      expect(centerCells).toHaveLength(uniqueRows.size);
    }
  });

  it('built-in personalities produce visually distinct marks', () => {
    // The whole point of the algorithm is that researcher/engineer/etc.
    // look different. If two collide, the visual identity claim fails.
    const fingerprints = BUILTIN_PERSONALITY_IDS.map((id) => {
      const spec = generatePersonalityMark(id);
      return spec.cells
        .map((c) => `${c.row}:${c.col}:${c.opacity}`)
        .sort()
        .join('|');
    });
    const unique = new Set(fingerprints);
    expect(unique.size).toBe(BUILTIN_PERSONALITY_IDS.length);
  });

  it('background radius and alpha match DESIGN.md (0.16 / ~13%)', () => {
    const spec = generatePersonalityMark('engineer');
    expect(spec.bgRadius).toBe(0.16);
    expect(spec.bgAlpha).toBeCloseTo(0x22 / 0xff, 6);
  });
});

describe('personalityAccent', () => {
  it('returns the spec hex for every built-in personality', () => {
    expect(personalityAccent('researcher')).toBe('#4A9EFF');
    expect(personalityAccent('engineer')).toBe('#4ADE80');
    expect(personalityAccent('reviewer')).toBe('#F59E0B');
    expect(personalityAccent('coach')).toBe('#E879F9');
    expect(personalityAccent('operator')).toBe('#94A3B8');
  });

  it('falls back to operator grey for unknown personalities', () => {
    expect(personalityAccent('not-a-real-personality')).toBe('#94A3B8');
  });

  it('PERSONALITY_ACCENTS is frozen — runtime mutation is rejected', () => {
    expect(() => {
      // biome-ignore lint/suspicious/noExplicitAny: deliberate runtime mutation test
      (PERSONALITY_ACCENTS as any).researcher = '#FF0000';
    }).toThrow();
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
