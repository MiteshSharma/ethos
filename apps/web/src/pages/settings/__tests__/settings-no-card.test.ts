import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// T9 — plan/phases/settings-navigation.md DESIGN.md:134, "Cards earn
// existence". The `Card` primitive is reserved for skill rows, cron rows and
// task tiles — nothing in Settings qualifies.
//
// Scope widens phase by phase (3 → 4 → 5b) and is repo-final at Phase 7, when
// it covers the rest of `settings/` and `DesktopSettings.tsx` too. Phase 3
// only asserts the four Agent-group panes it converts, so this list is meant
// to grow — later phases push their own files onto it rather than replacing
// the technique. Phase 4 adds the Machine-group panes (`data.tsx`,
// `security.tsx`, `developer.tsx`) and `DesktopSettings.tsx` — the latter is
// NOT under `settings/panes/`; it is rendered by `panes/desktop.tsx` but its
// controls still live at `pages/DesktopSettings.tsx` post-Phase-1, so it gets
// its own describe block against its own path.
//
// Source-text technique, same as `settings-form-placement.test.ts` (T1) —
// `apps/web` has no jsdom and this change deliberately does not add one.

const panesDir = join(import.meta.dirname, '..', 'panes');
const pagesDir = join(import.meta.dirname, '..', '..');

/** Files this test currently covers. Extend this list; don't replace the test. */
const FILES = [
  'general.tsx',
  'models.tsx',
  'memory.tsx',
  'chat.tsx',
  'data.tsx',
  'security.tsx',
  'developer.tsx',
  'desktop.tsx',
];

describe('no <Card> in the converted panes', () => {
  it.each(FILES)('%s renders zero <Card', (file) => {
    const source = readFileSync(join(panesDir, file), 'utf8');
    expect((source.match(/<Card/g) ?? []).length).toBe(0);
  });
});

describe('no <Card> in DesktopSettings', () => {
  it('DesktopSettings.tsx renders zero <Card', () => {
    const source = readFileSync(join(pagesDir, 'DesktopSettings.tsx'), 'utf8');
    expect((source.match(/<Card/g) ?? []).length).toBe(0);
  });
});
