import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// T13 — plan/phases/settings-navigation.md §8 "0a-2". `auxiliary.{asr,tts}.timeout`
// is seconds and is consumed as seconds, but the page and the API contract both
// shipped it in milliseconds, so a saved `30000` became an 8h20m budget — a
// timeout that never fires. The unit belief was written into three layers, and
// this asserts all three agree on the one the runtime actually uses.
//
// The bounds are not invented here: they are the ones the ROSTER rows for the
// very same field already carry. If the default entry and the roster entry ever
// disagree again, this file fails. Same source-text technique as
// `features/voice/__tests__/call-row-css.test.ts` — `apps/web` has no jsdom.

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
const router = readFileSync(join(root, 'packages', 'web-contracts', 'src', 'router.ts'), 'utf8');

/** The `<Form.Item>` block for a named field, up to its closing tag. */
function formItem(name: string): string {
  const at = page.indexOf(`name="${name}"`);
  expect(at, `missing form field: ${name}`).toBeGreaterThan(-1);
  return page.slice(at, page.indexOf('</Form.Item>', at));
}

describe('auxiliary STT/TTS timeout units', () => {
  it.each([
    ['voiceSttTimeoutMs', 'STT'],
    ['voiceTtsTimeoutMs', 'TTS'],
  ])('%s asks for seconds, not milliseconds', (field, kind) => {
    const item = formItem(field);
    expect(item).toContain(`label="${kind} timeout (seconds)"`);
    expect(item).not.toContain('(ms)');
  });

  it.each(['voiceSttTimeoutMs', 'voiceTtsTimeoutMs'])(
    '%s bounds 1–3600, the same range the roster rows already use',
    (field) => {
      const input = formItem(field);
      expect(input).toContain('min={1}');
      expect(input).toContain('max={3600}');
      expect(input).toContain('step={1}');
      expect(input).toContain('placeholder="120"');
    },
  );

  it('the roster row it now matches is untouched — that field was always right', () => {
    const at = page.indexOf('<RowLabel>Timeout (seconds)</RowLabel>');
    expect(at, 'missing the roster timeout row').toBeGreaterThan(-1);
    const input = page.slice(at, page.indexOf('/>', at));
    expect(input).toContain('min={1}');
    expect(input).toContain('max={3600}');
    expect(input).toContain('placeholder="120"');
  });

  it.each(['voiceTtsTimeoutMs', 'voiceSttTimeoutMs'])(
    'configUpdate validates %s as 1–3600 seconds',
    (field) => {
      const at = router.indexOf(`${field}: z.number().int()`);
      expect(at, `missing write-shape validator for ${field}`).toBeGreaterThan(-1);
      expect(router.slice(at, router.indexOf('\n', at))).toContain('.min(1).max(3600)');
    },
  );

  it.each(['voiceTtsTimeoutMs', 'voiceSttTimeoutMs'])(
    'no doc comment on %s still claims milliseconds',
    (field) => {
      const key = field === 'voiceTtsTimeoutMs' ? 'auxiliary.tts.timeout' : 'auxiliary.asr.timeout';
      const comments = router.split('\n').filter((l) => l.includes(`\`${key}\``));
      expect(comments.length).toBeGreaterThan(0);
      for (const line of comments) {
        expect(line).toContain('seconds');
        expect(line).not.toContain(' ms');
      }
    },
  );
});
