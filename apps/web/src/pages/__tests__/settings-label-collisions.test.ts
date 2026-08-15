import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// plan/phases/settings-navigation.md §8 "0f" — three naming collisions. Two
// controls two fields apart were both called some flavour of "Verbosity" and
// both offered an option called "Verbose"; two retention cards differed only by
// a word the reader could not see; and web search is configured in two places
// with two Save buttons, neither of which admitted the other existed.
//
// Config keys are unchanged — this guards the LABELS. Same source-text
// technique as `aux-timeout-units.test.ts`; `apps/web` has no jsdom.

const root = join(import.meta.dirname, '..', '..', '..', '..', '..');
// The page is now eleven panes under `pages/settings/panes/`; the controls these
// assertions are about moved there verbatim in Phase 1 of
// plan/phases/settings-navigation.md. Concatenating the panes keeps every
// assertion below exactly what it was against the single file.
const panesDir = join(root, 'apps', 'web', 'src', 'pages', 'settings', 'panes');
const page = readdirSync(panesDir)
  .filter((f) => f.endsWith('.tsx'))
  .sort()
  .map((f) => readFileSync(join(panesDir, f), 'utf8'))
  .join('\n');
const desktop = readFileSync(
  join(root, 'apps', 'web', 'src', 'pages', 'DesktopSettings.tsx'),
  'utf8',
);

/**
 * The block that carries a named field's label, up to its closing tag.
 *
 * Plan Phase 3 (settings-navigation.md §6.2) moves the label off `Form.Item`
 * and onto the enclosing `SettingRow` as panes convert off `Card` — so the
 * label site is whichever of the two opens closer to the `name=` attribute:
 * `SettingRow` in a converted pane, `Form.Item` in one Phase 3 has not reached
 * yet. Checking both keeps this guard live across the whole rebuild instead of
 * only until the next pane converts.
 */
function fieldBlock(name: string): string {
  const at = page.indexOf(`name="${name}"`);
  expect(at, `missing form field: ${name}`).toBeGreaterThan(-1);
  const itemStart = page.lastIndexOf('<Form.Item', at);
  const rowStart = page.lastIndexOf('<SettingRow', at);
  // `rowStart` truly encloses this field only if it opens before the
  // `Form.Item` AND has not already closed before reaching it — otherwise it
  // is some earlier, unrelated `SettingRow` a blind backward search picked up.
  const enclosed =
    rowStart !== -1 &&
    rowStart < itemStart &&
    !page.slice(rowStart, itemStart).includes('</SettingRow>');
  if (enclosed) {
    return page.slice(rowStart, page.indexOf('</SettingRow>', at));
  }
  return page.slice(itemStart, page.indexOf('</Form.Item>', at));
}

describe('settings label collisions', () => {
  it('the two verbosity controls no longer share a name', () => {
    expect(fieldBlock('verbosity')).toContain('label="Response length"');
    expect(fieldBlock('displayVerbosity')).toContain('label="Interface detail"');
    expect(page).not.toContain('label="Verbosity"');
    expect(page).not.toContain('label="Surface verbosity"');
  });

  it('the two retention cards say whose data they retain', () => {
    expect(page).toContain('<Card title="Agent data retention"');
    expect(desktop).toContain('<Card title="Desktop cache retention"');
    expect(page).not.toContain('<Card title="Data retention"');
    expect(desktop).not.toContain('<Card title="Retention"');
  });

  it('each web-search control names the other one', () => {
    expect(fieldBlock('webSearchBackend')).toContain('Web-search defaults');

    const card = page.slice(page.indexOf('<Card title="Web-search defaults"'));
    const prose = card.slice(0, card.indexOf('</Typography.Paragraph>')).replace(/\s+/g, ' ');
    expect(prose).toContain('Web search backend');
    expect(prose).toContain('Models &amp; backends');
  });

  it('no two settings cards share a title', () => {
    const titles = [
      ...page.matchAll(/<Card title="([^"]+)"/g),
      ...desktop.matchAll(/<Card title="([^"]+)"/g),
    ].map((m) => m[1]);
    const counts = new Map<string, number>();
    for (const t of titles) counts.set(t, (counts.get(t) ?? 0) + 1);
    const duplicates = [...counts.entries()].filter(([, n]) => n > 1).map(([t]) => t);
    expect(duplicates).toEqual([]);
  });
});
