import { describe, expect, it } from 'vitest';
import {
  countByCategory,
  EXPECTED_EMPTY_SECTIONS,
  isExpectedEmptySection,
  SETTINGS_INDEX,
} from '../lib/settings-index';
import { SETTINGS_CATEGORIES } from '../lib/taxonomy';

// T5 — plan/phases/settings-navigation.md D8. Every figure the rail and the
// advanced toggle render is DERIVED from `SETTINGS_INDEX`.
//
// Which is the only reason to trust them. A hand-maintained count is a count
// that goes wrong on the first move and stays wrong, because nobody counts
// switches. So none of the expectations below is a literal number either —
// each recomputes from the table by a different route than the function does.

describe('rail counts', () => {
  it('gives every visible category the number of entries it actually holds', () => {
    const counts = countByCategory();
    for (const category of SETTINGS_CATEGORIES) {
      const mine = SETTINGS_INDEX.filter((e) => e.category === category.slug);
      expect(counts[category.slug] ?? 0, `count for ${category.slug}`).toBe(mine.length);
    }
  });

  it('counts nothing that is outside the taxonomy', () => {
    const known = new Set(SETTINGS_CATEGORIES.map((c) => c.slug));
    expect(Object.keys(countByCategory()).filter((slug) => !known.has(slug))).toEqual([]);
  });

  it('sums to the whole table, so no entry is counted twice or dropped', () => {
    const total = Object.values(countByCategory()).reduce((a, b) => a + b, 0);
    expect(total).toBe(SETTINGS_INDEX.length);
  });

  it('places every entry in a section its category declares', () => {
    for (const entry of SETTINGS_INDEX) {
      const category = SETTINGS_CATEGORIES.find((c) => c.slug === entry.category);
      expect(category, `unknown category ${entry.category} (${entry.label})`).toBeDefined();
      expect(
        category?.sections.map((s) => s.slug),
        `${entry.label} → ${entry.category}/${entry.section}`,
      ).toContain(entry.section);
    }
  });
});

describe('the sections that are empty on purpose', () => {
  // A rail count of `0` is only honest where the section really holds no
  // control. Anywhere else it is drift, and this is what keeps the two apart.
  it('is exactly the set of sections with no entries', () => {
    const empty: string[] = [];
    for (const category of SETTINGS_CATEGORIES) {
      for (const section of category.sections) {
        const holds = SETTINGS_INDEX.some(
          (e) => e.category === category.slug && e.section === section.slug,
        );
        if (!holds) empty.push(`${category.slug}/${section.slug}`);
      }
    }
    expect(empty.sort()).toEqual(
      EXPECTED_EMPTY_SECTIONS.map((s) => `${s.category}/${s.section}`).sort(),
    );
  });

  it('names the two sections that are a readout and a paragraph', () => {
    expect(isExpectedEmptySection('models', 'per-personality-routing')).toBe(true);
    expect(isExpectedEmptySection('data', 'built-in-defaults')).toBe(true);
    expect(isExpectedEmptySection('voice', 'trunk')).toBe(false);
  });
});
