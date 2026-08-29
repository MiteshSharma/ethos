// DESIGN.md tokens as runtime data. Surfaces (TUI, Web, CLI, ...) import
// from here; DESIGN.md remains the canonical written reference. Drift
// between this file and DESIGN.md is caught by the parity test in
// __tests__/design-md-parity.test.ts.
//
// Unit conventions (load-bearing — pick once, surfaces convert):
//   • motion durations: milliseconds (canonical units, matches DESIGN.md)
//   • spacing / radius / layout / typography sizes: pixels (numbers)
//   • typography.scale.tracking: CSS em string (matches DESIGN.md table)
//   • motion.ease: CSS cubic-bezier string

export type TypographyRole = 'h1' | 'h2' | 'h3' | 'h4' | 'body' | 'small' | 'micro' | 'mono';

export interface TypographyScaleEntry {
  /** Pixel size — DESIGN.md is the source of truth. */
  px: number;
  /** Numeric font weight (400/500/600). */
  weight: number;
  /** Unitless line-height ratio. */
  lineHeight: number;
  /** Tracking as a CSS em string ('-0.01em', '0.08em', '0'). */
  tracking: string;
}

export type SpacingKey = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | '5xl';

export interface Tokens {
  surface: {
    bgBase: string;
    bgElevated: string;
    bgOverlay: string;
    borderSubtle: string;
    borderStrong: string;
    textPrimary: string;
    textSecondary: string;
    textTertiary: string;
  };
  /** Per-personality accent, keyed by personality id. */
  accents: Record<string, string>;
  semantic: {
    success: string;
    warning: string;
    error: string;
    info: string;
  };
  typography: {
    fontDisplay: string;
    fontMono: string;
    scale: Record<TypographyRole, TypographyScaleEntry>;
  };
  spacing: Record<SpacingKey, number>;
  radius: { sm: number; md: number; lg: number; full: number };
  motion: {
    /** Canonical motion durations in milliseconds. Web adapter converts to seconds. */
    fastMs: number;
    defaultMs: number;
    slowMs: number;
    /** CSS cubic-bezier string. */
    ease: string;
  };
  glyphs: {
    prompt: string;
    accentStripe: string;
    toolStart: string;
    toolOk: string;
    toolFail: string;
    divider: string;
    barFill: string;
    barEmpty: string;
  };
  layout: {
    sidebarExpandedPx: number;
    sidebarCollapsedPx: number;
    rightDrawerPx: number;
    chatMaxWidthPx: number;
    onboardingMaxWidthPx: number;
  };
}

/**
 * DESIGN.md defaults — dark-mode-primary. Light mode lives in the
 * Phase 2 `paper` skin so it stays out of the base contract.
 */
export const DEFAULT_TOKENS: Tokens = {
  surface: {
    bgBase: '#0F0F0F',
    bgElevated: '#1A1A1A',
    bgOverlay: '#2A2A2A',
    borderSubtle: '#2A2A2A',
    borderStrong: '#3A3A3A',
    textPrimary: '#E8E8E6',
    textSecondary: '#9A9A98',
    textTertiary: '#6B6B6A',
  },
  accents: {
    researcher: '#4A9EFF',
    engineer: '#4ADE80',
    reviewer: '#F59E0B',
    coach: '#E879F9',
    operator: '#94A3B8',
  },
  semantic: {
    success: '#4ADE80',
    warning: '#F59E0B',
    error: '#F87171',
    info: '#4A9EFF',
  },
  typography: {
    fontDisplay: "'Geist', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontMono: "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
    scale: {
      h1: { px: 32, weight: 600, lineHeight: 1.2, tracking: '-0.01em' },
      h2: { px: 24, weight: 600, lineHeight: 1.25, tracking: '0' },
      h3: { px: 20, weight: 600, lineHeight: 1.3, tracking: '0' },
      h4: { px: 16, weight: 500, lineHeight: 1.4, tracking: '0' },
      body: { px: 14, weight: 400, lineHeight: 1.5, tracking: '0' },
      small: { px: 12, weight: 400, lineHeight: 1.4, tracking: '0' },
      micro: { px: 11, weight: 500, lineHeight: 1.4, tracking: '0.08em' },
      mono: { px: 13, weight: 400, lineHeight: 1.45, tracking: '0' },
    },
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    '2xl': 32,
    '3xl': 48,
    '4xl': 64,
    '5xl': 96,
  },
  radius: { sm: 4, md: 8, lg: 14, full: 9999 },
  motion: {
    fastMs: 80,
    defaultMs: 180,
    slowMs: 240,
    ease: 'cubic-bezier(0.16, 1, 0.3, 1)',
  },
  glyphs: {
    prompt: '›',
    accentStripe: '▌',
    toolStart: '⟢',
    toolOk: '✓',
    toolFail: '✗',
    divider: '─',
    barFill: '▓',
    barEmpty: '░',
  },
  layout: {
    sidebarExpandedPx: 240,
    sidebarCollapsedPx: 64,
    rightDrawerPx: 360,
    chatMaxWidthPx: 800,
    onboardingMaxWidthPx: 520,
  },
};

// DESIGN.md's slop-blacklist forbids purple/violet/indigo accents in the
// same hue band `validate.ts` rejects for the curated accents (rule 1:
// hue [240°, 290°]). Derived hues are shifted out of the band rather than
// re-hashed, so the mapping stays a pure function of the id.
const DERIVED_HUE_PURPLE_MIN = 240;
const DERIVED_HUE_PURPLE_MAX = 290;
const DERIVED_HUE_BAND_SPAN = DERIVED_HUE_PURPLE_MAX - DERIVED_HUE_PURPLE_MIN + 1; // 51
// Fixed saturation/lightness chosen to match the curated palette's
// vividness (e.g. #4A9EFF ≈ S100 L65, #4ADE80 ≈ S71 L65, #F59E0B ≈ S92 L50,
// #E879F9 ≈ S90 L73) — only the hue varies per id.
const DERIVED_ACCENT_SATURATION = 0.75;
const DERIVED_ACCENT_LIGHTNESS = 0.62;

/** Simple deterministic string hash — pure function of the input, no state. */
function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** HSL (h in [0,360), s/l in [0,1]) to a 6-digit uppercase hex color. */
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hPrime = h / 60;
  const x = c * (1 - Math.abs((hPrime % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hPrime < 1) [r, g, b] = [c, x, 0];
  else if (hPrime < 2) [r, g, b] = [x, c, 0];
  else if (hPrime < 3) [r, g, b] = [0, c, x];
  else if (hPrime < 4) [r, g, b] = [0, x, c];
  else if (hPrime < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

/**
 * Derive a deterministic, unique-per-id accent color for a personality
 * that has no curated entry in `tokens.accents`. Hue comes from a hash of
 * the id (so different ids land at different points on the wheel instead
 * of bucketing into the 5 curated colors); saturation/lightness are fixed
 * to match the curated palette's vividness. Hues that land in the
 * slop-blacklisted purple/violet/indigo band are shifted just past it.
 */
function deriveAccentHex(personalityId: string): string {
  let hue = hashString(personalityId) % 360;
  if (hue >= DERIVED_HUE_PURPLE_MIN && hue <= DERIVED_HUE_PURPLE_MAX) {
    hue = (hue + DERIVED_HUE_BAND_SPAN) % 360;
  }
  return hslToHex(hue, DERIVED_ACCENT_SATURATION, DERIVED_ACCENT_LIGHTNESS);
}

/**
 * Resolve a personality's accent against a token pack. The 5 curated
 * built-ins (and anything a caller explicitly adds to a custom token pack)
 * resolve to their exact hex. Every other id gets a color hash-derived from
 * its own id — distinct per id, not bucketed into the curated 5 — so a
 * deployment with more personalities than curated colors still gives each
 * one a genuinely distinct accent.
 */
export function accentFor(tokens: Tokens, personalityId: string): string {
  if (tokens.accents[personalityId]) return tokens.accents[personalityId];
  return deriveAccentHex(personalityId);
}

/**
 * Convenience accessor that resolves against `DEFAULT_TOKENS`. Useful for
 * call sites that don't carry the token pack around (e.g. the marks
 * algorithm in web-contracts, which is identity-only — the accent rendering
 * happens on top by surface code that does have the token pack).
 */
export function personalityAccent(personalityId: string): string {
  return accentFor(DEFAULT_TOKENS, personalityId);
}

/** Built-in personality ids. Custom personalities resolve via accentFor. */
export const BUILTIN_PERSONALITY_IDS: ReadonlyArray<string> = Object.freeze(
  Object.keys(DEFAULT_TOKENS.accents),
);

/** True when id matches one of the five built-in personalities. */
export function isBuiltinPersonality(personalityId: string): boolean {
  return personalityId in DEFAULT_TOKENS.accents;
}

// Re-exports so consumers can `import { resolveSkin } from '@ethosagent/design-tokens'`
// instead of reaching into sub-paths. Sub-path imports also work for tree-shaking.
export {
  BUILTIN_SKIN_NAMES,
  BUILTIN_SKINS,
  type DeepPartial,
  defaultSkin,
  monoSkin,
  paperSkin,
  resolveBuiltinSkin,
  resolveSkin,
  type Skin,
  type SkinRegistry,
} from './skins';
export {
  contrastRatio,
  hexToHue,
  type ValidationFinding,
  type ValidationResult,
  validateSkin,
  validateTokens,
} from './validate';
