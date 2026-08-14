import { accentFor, DEFAULT_TOKENS } from '@ethosagent/design-tokens';
import type { ThemeConfig } from 'antd';
import type { CSSProperties } from 'react';

// Chat-tab theming. The user's pinned skin from `~/.ethos/config.yaml` is
// carried by the OUTER ConfigProvider in main.tsx; this inner provider only
// swaps the accent colour, which still varies per personality.
//
// TWO consumers need that accent and they must not disagree:
//   • Antd primitives read `colorPrimary` off the ConfigProvider theme.
//   • Raw CSS reads `var(--accent)` — and a ConfigProvider renders no DOM
//     node, so the variable has to be stamped on the subtree's own element.
// `personalityAccent` is the one resolver behind both.

/** The accent for a personality — the single lookup this module performs. */
export function personalityAccent(personalityId: string): string {
  return accentFor(DEFAULT_TOKENS, personalityId);
}

export function personalityTheme(personalityId: string): ThemeConfig {
  // Per-personality accent override. Whatever the outer provider resolved
  // (engine default or user-pinned skin), the chat subtree keeps that base
  // and only re-tints the accent for this personality.
  return { token: { colorPrimary: personalityAccent(personalityId) } };
}

/**
 * `--accent` for a subtree, as a style prop.
 *
 * Every `var(--accent, var(--ethos-info))` in `styles.css` fell back to the
 * generic info blue until this existed — the variable was read nineteen times
 * and defined nowhere. Stamp it on the same element the per-personality
 * `<ConfigProvider>` wraps and the fallbacks stop firing.
 */
export function accentVars(accent: string): CSSProperties {
  return { '--accent': accent } as CSSProperties;
}
