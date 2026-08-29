import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// T12 — plan/phases/settings-navigation.md D2 / §5.4.
//
// The self-saving sections (web-search defaults, named secrets, A2A, API keys,
// Desktop) used to render AFTER `</Form>`; in the two-pane shape they render
// inside the outlet, therefore inside the page form. With a real `<form>` node
// that is two live defects: pressing Enter in the named-secret or API-key name
// field submits the PAGE form — writing ~107 config keys as a side effect of
// typing — and `ApiKeysSection`'s own `Form.useForm` nests forms.
//
// `component={false}` removes the `<form>` node entirely. Save becomes an
// explicit `form.submit()`, which is why the save bar is a plain button.

const shell = readFileSync(join(import.meta.dirname, '..', 'SettingsShell.tsx'), 'utf8');

/**
 * The opening `<Form …>` tag of the shell's page form, up to the `<Outlet>` it
 * encloses. Not `indexOf('>')` — the generic argument in `<Form<FormShape>`
 * carries one of its own.
 */
function pageFormTag(): string {
  const at = shell.indexOf('<Form<');
  expect(at, 'SettingsShell renders no page <Form>').toBeGreaterThan(-1);
  return shell.slice(at, shell.indexOf('<Outlet', at));
}

describe('the shell form renders no <form> node', () => {
  it('carries component={false}', () => {
    expect(pageFormTag()).toContain('component={false}');
  });

  it('saves through form.submit() rather than a submit button', () => {
    expect(shell).toContain('form.submit()');
    expect(shell).not.toContain('htmlType="submit"');
  });
});
