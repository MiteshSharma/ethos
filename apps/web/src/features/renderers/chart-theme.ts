import type { Tokens } from '@ethosagent/design-tokens';
import { isLightSurface } from '@ethosagent/design-tokens/antd';

// An echarts theme built from the resolved `Tokens` object, not from CSS
// variables: `tokensToCssVariables` emits surface / border / text / semantic /
// layout / radius, and a chart also needs the five categorical `accents`, the
// display font, and the motion durations — none of which become variables.
// Canvas-rendered charts cannot read CSS custom properties anyway.
//
// Pure and export-tested: theme correctness is asserted without mounting a
// chart.

/**
 * Closest named easing to the DESIGN.md curve `cubic-bezier(0.16, 1, 0.3, 1)`.
 * echarts takes named easings only — it will not accept a cubic-bezier string —
 * so this is an approximation: both are fast-out, long-settle curves, but the
 * exact control points are lost.
 */
export const CHART_ANIMATION_EASING = 'exponentialOut';

/** DESIGN.md's categorical accents, in declaration order. */
export function chartPalette(tokens: Tokens): string[] {
  const palette = Object.values(tokens.accents);
  return palette.length > 0 ? palette : [tokens.semantic.info];
}

export function buildChartTheme(tokens: Tokens, reduceMotion: boolean): Record<string, unknown> {
  const { surface, typography, motion } = tokens;
  const axis = {
    axisLine: { lineStyle: { color: surface.borderStrong } },
    axisTick: { lineStyle: { color: surface.borderStrong } },
    axisLabel: { color: surface.textSecondary },
    splitLine: { lineStyle: { color: surface.borderSubtle } },
  };
  return {
    // Skin luminance decides dark/light — never `prefers-color-scheme`, which
    // would disagree with the skin the user actually picked.
    darkMode: !isLightSurface(tokens),
    color: chartPalette(tokens),
    backgroundColor: 'transparent',
    textStyle: {
      fontFamily: typography.fontDisplay,
      color: surface.textSecondary,
      fontSize: typography.scale.small.px,
    },
    title: {
      textStyle: {
        color: surface.textPrimary,
        fontFamily: typography.fontDisplay,
        fontSize: typography.scale.h4.px,
        fontWeight: typography.scale.h4.weight,
      },
      subtextStyle: { color: surface.textTertiary },
    },
    legend: { textStyle: { color: surface.textSecondary } },
    tooltip: {
      backgroundColor: surface.bgOverlay,
      borderColor: surface.borderSubtle,
      borderWidth: 1,
      textStyle: { color: surface.textPrimary },
    },
    categoryAxis: { ...axis, splitLine: { show: false } },
    valueAxis: axis,
    logAxis: axis,
    timeAxis: axis,
    // The global reduce-motion stylesheet is CSS; it cannot reach a canvas.
    // Turning animation off in the option is the only thing that works here.
    animation: !reduceMotion,
    animationDuration: motion.defaultMs,
    animationEasing: CHART_ANIMATION_EASING,
  };
}
