import { readFileSync } from 'node:fs';
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
const page = readFileSync(join(root, 'apps', 'web', 'src', 'pages', 'Settings.tsx'), 'utf8');
const desktop = readFileSync(
  join(root, 'apps', 'web', 'src', 'pages', 'DesktopSettings.tsx'),
  'utf8',
);

/** The `<Form.Item>` block for a named field, up to its closing tag. */
function formItem(name: string): string {
  const at = page.indexOf(`name="${name}"`);
  expect(at, `missing form field: ${name}`).toBeGreaterThan(-1);
  return page.slice(page.lastIndexOf('<Form.Item', at), page.indexOf('</Form.Item>', at));
}

describe('settings label collisions', () => {
  it('the two verbosity controls no longer share a name', () => {
    expect(formItem('verbosity')).toContain('label="Response length"');
    expect(formItem('displayVerbosity')).toContain('label="Interface detail"');
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
    expect(formItem('webSearchBackend')).toContain('Web-search defaults');

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
