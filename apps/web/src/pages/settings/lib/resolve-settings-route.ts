// `/settings/:category/:section` → what to render, and whether the URL has to be
// corrected first. Pure over the taxonomy so the whole routing contract is
// covered without a router (D5, T7).
//
// There is never a 404 pane and never a blank right column: every input resolves
// to a real category and a real section of it.

import { findCategory, SETTINGS_CATEGORIES, type SettingsCategory } from './taxonomy';

export interface SettingsRouteResolution {
  /** The category slug to render. Always one that exists. */
  category: string;
  /** The section slug to render. Always one the category has. */
  section: string;
  /** True when the URL asked for something else and must be navigated away from. */
  redirect: boolean;
  /**
   * Always `true`. A corrected settings URL REPLACES the entry it corrects, so a
   * mistyped or stale link leaves no dead entry in the Back stack.
   */
  replace: true;
}

/**
 * | Input | Result |
 * |---|---|
 * | valid category + valid section | render it |
 * | valid category + unknown/absent section | first section of that category |
 * | unknown category | `general/basics` |
 * | `/settings` | `general/basics` |
 */
export function resolveSettingsRoute(
  params: { category?: string; section?: string },
  categories: readonly SettingsCategory[] = SETTINGS_CATEGORIES,
): SettingsRouteResolution {
  const fallback = categories[0];
  const category = findCategory(params.category, categories);
  if (!category) {
    return {
      category: fallback?.slug ?? '',
      section: fallback?.sections[0]?.slug ?? '',
      redirect: true,
      replace: true,
    };
  }
  const first = category.sections[0]?.slug ?? '';
  const section = category.sections.find((s) => s.slug === params.section);
  if (!section) {
    return { category: category.slug, section: first, redirect: true, replace: true };
  }
  return { category: category.slug, section: section.slug, redirect: false, replace: true };
}

/** The path a resolution addresses. */
export function settingsRoutePath(resolution: SettingsRouteResolution): string {
  return `/settings/${resolution.category}/${resolution.section}`;
}
