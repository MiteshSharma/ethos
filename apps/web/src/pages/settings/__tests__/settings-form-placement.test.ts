import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// T1 — plan/phases/settings-navigation.md §5.3. The structural half of the one
// constraint the whole two-pane rebuild is organised around:
//
//   The `<Form>` element must enclose the `<Outlet/>`. A pane must never create
//   a form instance for page-Save-backed fields, and `preserve` must never be
//   set to `false`.
//
// Break it and `getFieldsValue(true)` stops seeing the fields whose panes are
// unmounted; the patch builder writes `?? null` for them; `null` is a CLEAR; and
// saving from Memory deletes the trunk credentials with no error and no visible
// symptom. T2 guards the same thing behaviourally, because a sufficiently
// creative refactor can invent a shape this file does not recognise.
//
// Source-text technique, same as `features/voice/__tests__/call-row-css.test.ts`
// — `apps/web` has no jsdom and this change deliberately does not add one.

const settingsDir = join(import.meta.dirname, '..');
const panesDir = join(settingsDir, 'panes');

const shell = readFileSync(join(settingsDir, 'SettingsShell.tsx'), 'utf8');

/** Source with `//` and `/* *\/` comments blanked, so prose cannot satisfy an assertion. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function paneFiles(): string[] {
  return readdirSync(panesDir).filter((f) => f.endsWith('.tsx'));
}

function settingsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...settingsFiles(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('the shell form encloses the outlet', () => {
  it('SettingsShell renders both a <Form> and an <Outlet>', () => {
    expect(shell).toContain('<Form');
    expect(shell).toContain('<Outlet');
  });

  it('the <Form> comes before the <Outlet>', () => {
    expect(shell.indexOf('<Form')).toBeLessThan(shell.indexOf('<Outlet'));
  });

  it('holds with the comments stripped, so the ordering is the JSX and not the prose', () => {
    const code = stripComments(shell);
    expect(code.indexOf('<Form')).toBeGreaterThan(-1);
    expect(code.indexOf('<Form')).toBeLessThan(code.indexOf('<Outlet'));
  });
});

describe('no pane mints a form', () => {
  it.each(paneFiles())('%s creates no form instance outside an allowlisted modal', (file) => {
    const lines = readFileSync(join(panesDir, file), 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      if (!/Form\.useForm\(|<Form[\s<]/.test(line)) continue;
      // An explicit marker within the three lines above is the only escape, and
      // it is only ever correct for a modal-local form over fields the page Save
      // does not write.
      const preamble = lines.slice(Math.max(0, index - 3), index).join('\n');
      expect(
        preamble,
        `${file}:${index + 1} creates a form without a T1-ALLOW-MODAL-FORM marker: ${line.trim()}`,
      ).toContain('T1-ALLOW-MODAL-FORM');
    }
  });
});

describe('preserve is never switched off', () => {
  it.each(settingsFiles(settingsDir).map((f) => [f.slice(settingsDir.length + 1), f]))(
    '%s does not set preserve to false',
    (_name, full) => {
      const source = readFileSync(full, 'utf8');
      expect(source).not.toContain('preserve={false}');
      expect(source).not.toContain('preserve: false');
    },
  );
});
