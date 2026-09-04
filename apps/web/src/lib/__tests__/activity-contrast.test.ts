import { describe, expect, it } from 'vitest';

// Contrast gate for the feedback & activity surfaces (StatusLine, Trail,
// FeedbackRow). The contract claims "`--text-secondary` for every reading line
// (≈6.8:1 on `--bg-base`), `--text-tertiary` only for numbers" — this is the
// arithmetic behind that claim, computed from the hex values in DESIGN.md's
// surface-token and semantic-colour tables, in BOTH skins.
//
// This file used to PIN five known shortfalls and assert they were below the
// bar. The 2026-09-04 decisions-log row raised those five tokens (and the
// light `--text-secondary` the light ramp depended on), so the table below
// flipped meaning: it no longer documents a known failure, it guards a fixed
// one. The assertions stay two-sided — a recorded ratio AND the 4.5 bar — so a
// value drifting in either direction fails here rather than silently.
//
// Hexes are copied from DESIGN.md § "Surface tokens" / § "Semantic colors".
// They are duplicated here on purpose: the point is to catch the stylesheet
// and the doc drifting apart, which a shared import would hide.

const DARK = {
  bgBase: '#0F0F0F',
  textPrimary: '#E8E8E6',
  textSecondary: '#9A9A98',
  textTertiary: '#7E7E7D',
};
const LIGHT = {
  bgBase: '#FAFAF7',
  textPrimary: '#1A1A1A',
  textSecondary: '#585857',
  textTertiary: '#70706B',
};
// Semantics carry a dark AND a light value — they are tuned to the ground
// they sit on, unlike a personality accent, which is the same hue in both.
const DARK_SEMANTIC = { success: '#4ADE80', warning: '#F59E0B', error: '#F87171' };
const LIGHT_SEMANTIC = { success: '#177D3C', warning: '#986206', error: '#CE2C2C' };

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
    for (const hex of Object.values(DARK_SEMANTIC)) {
      expect(contrast(hex, DARK.bgBase)).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });

  it('the light skin clears 4.5:1 for every semantic glyph', () => {
    for (const hex of Object.values(LIGHT_SEMANTIC)) {
      expect(contrast(hex, LIGHT.bgBase)).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });
});

// ---------------------------------------------------------------------------
// The five pairs the feedback & activity contract put under load.
//
// `--text-tertiary` carries every duration and elapsed number at 13px, and
// `--warning` carries `⚠ still working` / `⚠ N unverified` — 13px is normal
// text, so 4.5:1 applies. All five failed it until 2026-09-04; each is now
// recorded with the ratio it was raised to. Glyph + word still accompany every
// one of them in the markup (`✓ ok`, `⚠ unverified`, `12.4s` beside its label),
// so no state is carried by colour alone — that belt stays on.
//
// The assertions are two-sided: they fail if a value drifts at all, and they
// fail if it drops back below the bar.
// ---------------------------------------------------------------------------
const RAISED_TO_AA: Array<[string, number, number]> = [
  ['--text-tertiary on --bg-base (dark)', contrast(DARK.textTertiary, DARK.bgBase), 4.72],
  ['--text-tertiary on --bg-base (light)', contrast(LIGHT.textTertiary, LIGHT.bgBase), 4.76],
  ['--warning on --bg-base (light)', contrast(LIGHT_SEMANTIC.warning, LIGHT.bgBase), 4.92],
  ['--success on --bg-base (light)', contrast(LIGHT_SEMANTIC.success, LIGHT.bgBase), 4.98],
  ['--error on --bg-base (light)', contrast(LIGHT_SEMANTIC.error, LIGHT.bgBase), 4.99],
];

describe('contrast — the pairs raised to clear AA, pinned', () => {
  for (const [name, actual, recorded] of RAISED_TO_AA) {
    it(`${name} is ${recorded}:1 — clears the 4.5:1 bar`, () => {
      expect(actual).toBeCloseTo(recorded, 1);
      expect(actual).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }
});

// The muted ramp only means something if you can see the step. Raising
// tertiary to clear AA pushes it toward secondary in both skins; these bounds
// are what stops a future contrast fix from collapsing the two into one grey.
describe('contrast — secondary and tertiary stay a hierarchy', () => {
  it('tertiary is meaningfully lower-contrast than secondary in both skins', () => {
    for (const skin of [DARK, LIGHT]) {
      const secondary = contrast(skin.textSecondary, skin.bgBase);
      const tertiary = contrast(skin.textTertiary, skin.bgBase);
      expect(tertiary).toBeLessThan(secondary);
      expect(secondary / tertiary).toBeGreaterThan(1.35);
    }
  });
});
