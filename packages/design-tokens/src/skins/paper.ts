import type { Skin } from './index';

// Light-mode surface from the DESIGN.md "Surface tokens" table, plus the
// light column of the "Semantic colors" table. Personality accents stay the
// same on both skins — an identity hue is not a status colour and does not
// re-tune per background. The semantics DO: `#4ADE80` / `#F59E0B` / `#F87171`
// are tuned for a near-black ground and land at 1.67 / 2.05 / 2.65:1 on
// paper-warm, so each keeps its hue and drops lightness until it clears WCAG
// AA (2026-09-04 decision). `info` is deliberately absent — it shares the
// researcher hue and the permanent altitude-rail blue, so retuning it is an
// accent question, not a contrast one. The name reflects the warm-off-white
// feel: paper-warm, not pure white.
export const paperSkin: Skin = {
  name: 'paper',
  description: 'Light mode — paper-warm surfaces, full per-personality accents.',
  tokens: {
    surface: {
      bgBase: '#FAFAF7',
      bgElevated: '#FFFFFF',
      bgOverlay: '#F0F0EC',
      borderSubtle: '#E8E8E4',
      borderStrong: '#D0D0CC',
      textPrimary: '#1A1A1A',
      textSecondary: '#585857',
      textTertiary: '#70706B',
    },
    semantic: {
      success: '#177D3C',
      warning: '#986206',
      error: '#CE2C2C',
    },
  },
};
