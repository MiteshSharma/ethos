import { DEFAULT_TOKENS } from '@ethosagent/design-tokens';
import { describe, expect, it } from 'vitest';
import { resolveTokensForSkin } from '../../../lib/skin-tokens';
import { buildChartTheme, chartPalette } from '../chart-theme';

describe('buildChartTheme', () => {
  it('draws its palette from the categorical accents, not from CSS variables', () => {
    // `tokensToCssVariables` never emits `accents`, which is why the theme is
    // built from the token object.
    expect(chartPalette(DEFAULT_TOKENS)).toEqual(Object.values(DEFAULT_TOKENS.accents));
    expect(buildChartTheme(DEFAULT_TOKENS, false).color).toEqual(chartPalette(DEFAULT_TOKENS));
  });

  it('uses the DESIGN.md motion duration and a named easing', () => {
    const theme = buildChartTheme(DEFAULT_TOKENS, false);
    expect(theme.animation).toBe(true);
    expect(theme.animationDuration).toBe(DEFAULT_TOKENS.motion.defaultMs);
    // echarts rejects a cubic-bezier string; the token curve is approximated.
    expect(theme.animationEasing).toBe('exponentialOut');
    expect(String(theme.animationEasing)).not.toContain('cubic-bezier');
  });

  it('disables animation entirely under reduced motion', () => {
    // The global reduce-motion stylesheet cannot reach a canvas.
    expect(buildChartTheme(DEFAULT_TOKENS, true).animation).toBe(false);
  });

  it('picks dark/light from the skin surface, not the OS preference', () => {
    const paper = resolveTokensForSkin('paper');
    expect(buildChartTheme(DEFAULT_TOKENS, false).darkMode).toBe(true);
    expect(buildChartTheme(paper, false).darkMode).toBe(false);
  });

  it('produces a different theme per skin, so a skin switch re-themes a mounted chart', () => {
    // `EChartsBlock`'s init effect depends on the theme inputs; a changed theme
    // tears the instance down and rebuilds it.
    const dark = buildChartTheme(DEFAULT_TOKENS, false);
    const light = buildChartTheme(resolveTokensForSkin('paper'), false);
    expect(light).not.toEqual(dark);
    expect((light.textStyle as { color: string }).color).not.toBe(
      (dark.textStyle as { color: string }).color,
    );
  });
});

describe('resolveTokensForSkin', () => {
  it('falls back to the default token pack for an unknown or missing skin', () => {
    expect(resolveTokensForSkin('does-not-exist')).toBe(DEFAULT_TOKENS);
    expect(resolveTokensForSkin(undefined)).toBe(DEFAULT_TOKENS);
  });
});
