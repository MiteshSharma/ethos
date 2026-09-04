import { describe, expect, it } from 'vitest';

// Contrast gate for the feedback & activity surfaces (StatusLine, Trail,
// FeedbackRow). The contract claims "`--text-secondary` for every reading line
// (≈6.6:1 on `--bg-base`), `--text-tertiary` only for numbers" — this is the
// arithmetic behind that claim, computed from the hex values in DESIGN.md's
// surface-token and semantic-colour tables, in BOTH skins.
//
// Hexes are copied from DESIGN.md § "Surface tokens" / § "Semantic colors".
// They are duplicated here on purpose: the point is to catch the stylesheet
// and the doc drifting apart, which a shared import would hide.

const DARK = {
  bgBase: '#0F0F0F',
  textPrimary: '#E8E8E6',
  textSecondary: '#9A9A98',
  textTertiary: '#6B6B6A',
};
const LIGHT = {
  bgBase: '#FAFAF7',
  textPrimary: '#1A1A1A',
  textSecondary: '#6B6B6A',
  textTertiary: '#94948F',
};
const SEMANTIC = { success: '#4ADE80', warning: '#F59E0B', error: '#F87171' };

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.1 relative luminance. */
export function luminance(hex: string): number {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  const r = channel((n >> 16) & 0xff);
  const g = channel((n >> 8) & 0xff);
  const b = channel(n & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio, 1..21. */
export function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const AA_NORMAL = 4.5;

describe('contrast — the lines the user READS', () => {
  it('sanity-checks the formula against WCAG reference pairs', () => {
    expect(contrast('#FFFFFF', '#000000')).toBeCloseTo(21, 2);
    expect(contrast('#777777', '#FFFFFF')).toBeCloseTo(4.48, 1);
  });

  // Every reading line in the status line, the trail footer and a trail/feedback
  // row is `--text-secondary` on `--bg-base`. This is the load-bearing pair.
  it('--text-secondary on --bg-base clears 4.5:1 in both skins', () => {
    expect(contrast(DARK.textSecondary, DARK.bgBase)).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(contrast(LIGHT.textSecondary, LIGHT.bgBase)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  // `.activity-row-subject` — the mono tool name / subject.
  it('--text-primary on --bg-base clears 4.5:1 in both skins', () => {
    expect(contrast(DARK.textPrimary, DARK.bgBase)).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(contrast(LIGHT.textPrimary, LIGHT.bgBase)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('the dark skin — the primary one — clears 4.5:1 for every semantic glyph', () => {
    for (const hex of Object.values(SEMANTIC)) {
      expect(contrast(hex, DARK.bgBase)).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });
});

// ---------------------------------------------------------------------------
// Pairs that DO NOT clear the bar.
//
// These are recorded rather than quietly swapped for a passing token: the
// contract names these exact tokens for these exact roles, so the honest thing
// is to pin the numbers and report them. Every one of them is paired with a
// glyph AND a word in the markup (`✓ ok`, `⚠ unverified`, `12.4s` beside its
// label), so no state is carried by colour alone — that is the mitigation, not
// a fix. Raising the tokens is DESIGN.md's call, not this component's.
//
// The assertions are two-sided: they fail if a value drifts WORSE, and they
// fail if a token is fixed without this table being updated.
// ---------------------------------------------------------------------------
const BELOW_BAR: Array<[string, number, number]> = [
  ['--text-tertiary on --bg-base (dark)', contrast(DARK.textTertiary, DARK.bgBase), 3.59],
  ['--text-tertiary on --bg-base (light)', contrast(LIGHT.textTertiary, LIGHT.bgBase), 2.91],
  ['--warning on --bg-base (light)', contrast(SEMANTIC.warning, LIGHT.bgBase), 2.05],
  ['--success on --bg-base (light)', contrast(SEMANTIC.success, LIGHT.bgBase), 1.67],
  ['--error on --bg-base (light)', contrast(SEMANTIC.error, LIGHT.bgBase), 2.65],
];

describe('contrast — known shortfalls, pinned and reported', () => {
  for (const [name, actual, recorded] of BELOW_BAR) {
    it(`${name} is ${recorded}:1 — BELOW the 4.5:1 bar`, () => {
      expect(actual).toBeCloseTo(recorded, 1);
      expect(actual).toBeLessThan(AA_NORMAL);
    });
  }
});
