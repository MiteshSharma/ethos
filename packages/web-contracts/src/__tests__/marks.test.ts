import { describe, expect, it } from 'vitest';
import { fnv1a32, generatePersonalityMark } from '../marks';

// The personality mark is the load-bearing identity affordance from
// DESIGN.md. These tests lock the algorithm's contract: determinism,
// mirror symmetry, distinct outputs across the built-ins, bounded
// opacity set. Accent resolution is tested separately in
// @ethosagent/design-tokens — the marks algorithm is identity-only.

const TEST_IDS = ['researcher', 'engineer', 'reviewer', 'coach', 'operator'] as const;

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
    for (const id of TEST_IDS) {
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
    for (const id of TEST_IDS) {
      const spec = generatePersonalityMark(id);
      for (const cell of spec.cells) {
        expect(allowed.has(cell.opacity)).toBe(true);
      }
    }
  });

  it('is mirror-symmetric — every off-center cell has a partner at col 4 - col', () => {
    for (const id of [...TEST_IDS, 'random-custom', 'a', 'with spaces']) {
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
    for (const id of TEST_IDS) {
      const spec = generatePersonalityMark(id);
      const centerCells = spec.cells.filter((c) => c.col === 2);
      const uniqueRows = new Set(centerCells.map((c) => c.row));
      expect(centerCells).toHaveLength(uniqueRows.size);
    }
  });

  it('built-in personalities produce visually distinct marks', () => {
    // The whole point of the algorithm is that researcher/engineer/etc.
    // look different. If two collide, the visual identity claim fails.
    const fingerprints = TEST_IDS.map((id) => {
      const spec = generatePersonalityMark(id);
      return spec.cells
        .map((c) => `${c.row}:${c.col}:${c.opacity}`)
        .sort()
        .join('|');
    });
    const unique = new Set(fingerprints);
    expect(unique.size).toBe(TEST_IDS.length);
  });

  it('background alpha and ring alpha match DESIGN.md (~13% fill / ~0.55 ring)', () => {
    const spec = generatePersonalityMark('engineer');
    expect(spec.bgAlpha).toBeCloseTo(0x22 / 0xff, 6);
    expect(spec.ringAlpha).toBeCloseTo(0.55, 2);
  });
});
