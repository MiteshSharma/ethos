import { personalityAccent } from '@ethosagent/web-contracts';
import { type ThemeConfig, theme } from 'antd';

// Single source of truth for the web theme — DESIGN.md tokens, applied via
// Antd ConfigProvider. The chat surface wraps its subtree in a SECOND
// ConfigProvider built from `personalityTheme(id)` so the per-personality
// accent flows through every Antd primitive (button background, input
// caret, focus ring) without recomputing the full palette.
//
// Why two providers, not one?
//   • The base theme is stable across the whole app (sidebar, top bar,
//     onboarding, sessions, settings).
//   • The accent is per-personality and changes when the user switches
//     personalities mid-session — wrapping just the chat subtree keeps
//     the rest of the app on the global accent (researcher blue).
//   • Antd merges nested `ConfigProvider` themes shallowly, so we only
//     need to override `colorPrimary` in the inner one.

export const baseTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    fontFamily: "'Geist', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontFamilyCode: "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
    colorBgLayout: '#0F0F0F',
    colorBgContainer: '#1A1A1A',
    colorBgElevated: '#2A2A2A',
    colorPrimary: '#4A9EFF',
    colorBorder: '#2A2A2A',
    colorBorderSecondary: '#3A3A3A',
    borderRadius: 6,
    motionDurationFast: '0.08s',
    motionDurationMid: '0.18s',
    motionDurationSlow: '0.24s',
    motionEaseOut: 'cubic-bezier(0.16, 1, 0.3, 1)',
    motionEaseInOut: 'cubic-bezier(0.16, 1, 0.3, 1)',
  },
  components: {
    Card: { borderRadius: 14 },
    Modal: { borderRadius: 12 },
  },
};

/**
 * Theme override for a personality-scoped subtree. Only swaps the accent —
 * caller wraps the chat surface in `<ConfigProvider theme={personalityTheme(id)}>`
 * INSIDE the base provider, and Antd merges them.
 */
export function personalityTheme(personalityId: string): ThemeConfig {
  return {
    token: {
      colorPrimary: personalityAccent(personalityId),
    },
  };
}
