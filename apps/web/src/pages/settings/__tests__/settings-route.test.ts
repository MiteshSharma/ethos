import { describe, expect, it } from 'vitest';
import { resolveSettingsRoute } from '../lib/resolve-settings-route';
import { visibleCategories } from '../lib/taxonomy';

// T7 — plan/phases/settings-navigation.md §5.5 / D5. Four inputs, one pure
// function, and `replace: true` on every one of them: a corrected settings URL
// REPLACES the entry it corrects, so a mistyped or stale link never leaves a
// dead entry in the Back stack. There is never a 404 pane and never a blank
// right column.

describe('resolveSettingsRoute', () => {
  it('renders a valid category and section as asked', () => {
    expect(resolveSettingsRoute({ category: 'voice', section: 'trunk' })).toEqual({
      category: 'voice',
      section: 'trunk',
      redirect: false,
      replace: true,
    });
  });

  it('falls back to the first section of a valid category', () => {
    expect(resolveSettingsRoute({ category: 'voice', section: 'nonsense' })).toEqual({
      category: 'voice',
      section: 'how-it-talks',
      redirect: true,
      replace: true,
    });
    expect(resolveSettingsRoute({ category: 'voice' })).toEqual({
      category: 'voice',
      section: 'how-it-talks',
      redirect: true,
      replace: true,
    });
  });

  it('sends an unknown category to general/basics', () => {
    expect(resolveSettingsRoute({ category: 'nonsense', section: 'basics' })).toEqual({
      category: 'general',
      section: 'basics',
      redirect: true,
      replace: true,
    });
  });

  it('sends a bare /settings to general/basics', () => {
    expect(resolveSettingsRoute({})).toEqual({
      category: 'general',
      section: 'basics',
      redirect: true,
      replace: true,
    });
  });

  it('treats /settings/desktop as unknown on the web build', () => {
    expect(resolveSettingsRoute({ category: 'desktop' }, visibleCategories(false))).toEqual({
      category: 'general',
      section: 'basics',
      redirect: true,
      replace: true,
    });
    expect(resolveSettingsRoute({ category: 'desktop' }, visibleCategories(true))).toEqual({
      category: 'desktop',
      section: 'connection',
      redirect: true,
      replace: true,
    });
  });
});
