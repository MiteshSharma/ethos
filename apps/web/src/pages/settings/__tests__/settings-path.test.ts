import { describe, expect, it } from 'vitest';
import { parseSettingsPath } from '../lib/parse-settings-path';

// Regression: `SettingsShell` used to destructure `pathname.split('/')` at the
// wrong offset (`const [, category, section] = ...`), which put the layout
// route's own `"settings"` segment into `category` instead of skipping it.
// `resolveSettingsRoute` (T7, settings-route.test.ts) is a correct pure
// function — it was fed a wrong value by its call site, and testing the pure
// function alone would never have caught that. `parseSettingsPath` is the
// call-site logic pulled out so THIS is testable too.

describe('parseSettingsPath', () => {
  it('parses a bare /settings as no category, no section', () => {
    expect(parseSettingsPath('/settings')).toEqual({ category: undefined, section: undefined });
  });

  it('parses /settings/voice as category only', () => {
    expect(parseSettingsPath('/settings/voice')).toEqual({
      category: 'voice',
      section: undefined,
    });
  });

  it('parses /settings/voice/trunk as category and section', () => {
    expect(parseSettingsPath('/settings/voice/trunk')).toEqual({
      category: 'voice',
      section: 'trunk',
    });
  });

  it('ignores segments past the section', () => {
    expect(parseSettingsPath('/settings/voice/trunk/extra/deep')).toEqual({
      category: 'voice',
      section: 'trunk',
    });
  });

  it('treats a trailing slash as an empty section, not a shifted one', () => {
    expect(parseSettingsPath('/settings/voice/')).toEqual({ category: 'voice', section: '' });
  });
});
