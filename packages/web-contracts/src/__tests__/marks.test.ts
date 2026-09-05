import { describe, expect, it } from 'vitest';
import { fnv1a32, generatePersonalityMark, teamRingArcs, teamRingGlyph } from '../marks';

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

// The team ring (plan/phases/teams-as-a-scope.md D10) — one arc per member,
// clockwise from 12 o'clock, built from the roster rather than hashed.
// Locks the prototype's geometry: stroke `max(1.5, size*0.09)`, `r = size/2
// - sw/2 - 0.5`, circumference-based dasharray, `gap = min(3, 18%)`.
describe('teamRingArcs', () => {
  const ACCENTS = ['#4A9EFF', '#4ADE80', '#F59E0B'];

  it('yields one arc per accent, in order, sharing one radius and stroke', () => {
    const arcs = teamRingArcs(ACCENTS, 22);
    expect(arcs.map((a) => a.color)).toEqual(ACCENTS);
    expect(new Set(arcs.map((a) => a.r)).size).toBe(1);
    expect(new Set(arcs.map((a) => a.strokeWidth)).size).toBe(1);
  });

  it('stroke width is max(1.5, size * 0.09) and r = size/2 - sw/2 - 0.5', () => {
    const small = teamRingArcs(ACCENTS, 14)[0];
    expect(small?.strokeWidth).toBe(1.5);
    expect(small?.r).toBeCloseTo(14 / 2 - 0.75 - 0.5, 6);
    const large = teamRingArcs(ACCENTS, 36)[0];
    expect(large?.strokeWidth).toBeCloseTo(3.24, 6);
    expect(large?.r).toBeCloseTo(36 / 2 - 1.62 - 0.5, 6);
  });

  it('each dasharray sums to the circumference and arcs tile it with min(3, 18%) gaps', () => {
    const arcs = teamRingArcs(ACCENTS, 36);
    const first = arcs[0];
    if (!first) throw new Error('no arcs');
    const circumference = 2 * Math.PI * first.r;
    const segment = circumference / ACCENTS.length;
    const gap = Math.min(3, segment * 0.18);
    for (const arc of arcs) {
      const [dash, rest] = arc.dashArray.split(' ').map(Number);
      expect((dash ?? 0) + (rest ?? 0)).toBeCloseTo(circumference, 6);
      expect(dash).toBeCloseTo(segment - gap, 6);
    }
  });

  it('caps the gap at 3px on a large ring and scales it down on a tiny one', () => {
    const large = teamRingArcs(['a', 'b'], 36)[0];
    const largeC = 2 * Math.PI * (large?.r ?? 0);
    expect(Number(large?.dashArray.split(' ')[0])).toBeCloseTo(largeC / 2 - 3, 6);
    const tiny = teamRingArcs(['a', 'b', 'c', 'd', 'e', 'f'], 14)[0];
    const tinyC = 2 * Math.PI * (tiny?.r ?? 0);
    const seg = tinyC / 6;
    expect(Number(tiny?.dashArray.split(' ')[0])).toBeCloseTo(seg - seg * 0.18, 6);
  });

  it("walks the offset by one segment per arc, starting at 0 (12 o'clock after the -90° rotation)", () => {
    const arcs = teamRingArcs(ACCENTS, 22);
    const first = arcs[0];
    if (!first) throw new Error('no arcs');
    const segment = (2 * Math.PI * first.r) / ACCENTS.length;
    expect(arcs.map((a) => a.dashOffset)).toEqual([0, -segment, -2 * segment]);
  });

  it('a single member is one arc covering the whole circumference minus the gap', () => {
    const arc = teamRingArcs(['#4A9EFF'], 22)[0];
    const circumference = 2 * Math.PI * (arc?.r ?? 0);
    expect(Number(arc?.dashArray.split(' ')[0])).toBeCloseTo(circumference - 3, 6);
  });

  it('an empty roster yields no arcs', () => {
    expect(teamRingArcs([], 22)).toEqual([]);
  });
});

describe('teamRingGlyph', () => {
  it('fills a quarter per member up to a full disc', () => {
    expect(teamRingGlyph(0)).toBe('○');
    expect(teamRingGlyph(1)).toBe('◔');
    expect(teamRingGlyph(2)).toBe('◑');
    expect(teamRingGlyph(3)).toBe('◕');
    expect(teamRingGlyph(4)).toBe('●');
    expect(teamRingGlyph(11)).toBe('●');
  });
});
