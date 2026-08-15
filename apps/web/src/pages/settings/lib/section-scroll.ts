// Whether a `resolved.category`/`resolved.section` change should scroll the
// new section's heading into view (plan §6.1 follow-up: SectionNav's tabs
// changed the URL and highlighted the active tab, but nothing ever moved the
// viewport — for a short pane like General both sections were already on
// screen, and for a long one like Voice the target was scrolled out of view
// with no way to reach it).
//
// Pulled out as a pure function so the "when" is testable without a DOM
// (D5/D8/D9 pattern, same rationale as `parseSettingsPath`): the caller does
// the actual `scrollIntoView`/`getBoundingClientRect` work, which needs a
// browser and has no meaningful jsdom-free unit test.

export interface SectionRoute {
  category: string;
  section: string;
}

/**
 * | prev | next | scroll? |
 * |---|---|---|
 * | `undefined` (first mount) | any | no — don't jump on ordinary page load |
 * | different category | any section | no — a category switch is a fresh pane, not a tab click |
 * | same category, same section | — | no — nothing moved |
 * | same category, different section | — | yes — this is the SectionNav tab click |
 */
export function shouldScrollToSection(prev: SectionRoute | undefined, next: SectionRoute): boolean {
  if (!prev) return false;
  if (prev.category !== next.category) return false;
  return prev.section !== next.section;
}
