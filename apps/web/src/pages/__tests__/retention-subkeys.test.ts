import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RETENTION_NO_PERSONALITY_SCOPE } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { RETENTION_SUBKEYS, RETENTION_SUBKEYS_PER_PERSONALITY } from '../settings/lib/config-types';
import { retentionRowsFromConfig } from '../settings/lib/rows';

// Settings → Data & retention. `config.update`'s retention patch is a FULL
// replacement of the subkeys the service owns (`RETENTION_SUBKEYS` in
// apps/web-api/src/services/config.service.ts — the `owned` sweep in `update`),
// and `buildConfigPatch` rebuilds that patch from exactly the rows
// `retentionRowsFromConfig` produced. So a subkey missing from the list in
// config-types.ts is not merely un-editable: it is read off config, dropped,
// and then DELETED from config.yaml by the next unrelated save, restoring the
// category's default window.
//
// For `channelTranscript` that default is longer than the value an operator
// would hand-edit in (RETENTION_DEFAULTS.channelTranscript = 30d), and the data
// is real message text from watched rooms — so the failure mode is retaining it
// for longer than asked, silently.

/** Source with `//` and block comments blanked, so prose cannot satisfy an
 *  assertion. Copied from `settings-form-placement.test.ts`. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** A settings pane's source below its import block — an identifier that appears
 *  only in an `import` line proves nothing about what the pane RENDERS. */
function paneBody(file: string): string {
  const source = stripComments(
    readFileSync(join(import.meta.dirname, '..', 'settings', 'panes', file), 'utf8'),
  );
  const firstDeclaration = source.search(/^export function /m);
  if (firstDeclaration < 0) throw new Error(`no exported component in panes/${file}`);
  return source.slice(firstDeclaration);
}

describe('retention subkey coverage', () => {
  it('hydrates a row for every subkey config.get can return', () => {
    const map = Object.fromEntries(RETENTION_SUBKEYS.map((k) => [k, '7d']));
    const rows = retentionRowsFromConfig(map, {});
    expect(rows.map((r) => r.subkey).sort()).toEqual([...RETENTION_SUBKEYS].sort());
  });

  it('carries observe-mode transcript retention, so a save cannot lengthen it', () => {
    expect(RETENTION_SUBKEYS).toContain('channelTranscript');
    const rows = retentionRowsFromConfig({ channelTranscript: '7d' }, {});
    expect(rows).toEqual([
      expect.objectContaining({ personalityId: '', subkey: 'channelTranscript', duration: '7d' }),
    ]);
  });
});

// The Scope dropdown's per-personality option list. `RETENTION_SUBKEYS` must
// keep carrying every subkey (above); what a row scoped to ONE personality may
// carry is narrower, because `RETENTION_NO_PERSONALITY_SCOPE`
// (@ethosagent/types) names the subkeys the nightly prune reads globally only.
// Derived, not hand-written, so a subkey added to the full list is offered per
// personality unless the shared roster refuses it.
describe('retention subkeys offered per personality', () => {
  it('omits exactly the subkeys the shared roster refuses', () => {
    const refused = Object.keys(RETENTION_NO_PERSONALITY_SCOPE);
    expect(refused).toContain('channelTranscript');
    expect(RETENTION_SUBKEYS_PER_PERSONALITY).not.toContain('channelTranscript');
    expect([...RETENTION_SUBKEYS_PER_PERSONALITY].sort()).toEqual(
      RETENTION_SUBKEYS.filter((s) => !refused.includes(s)).sort(),
    );
  });

  // A stale `personalities.<id>.retention.channelTranscript` line still hydrates
  // into a row — hiding it would delete an operator's value with nothing said.
  // `buildConfigPatch` is what refuses it, naming the row and the fix.
  it('still hydrates a row an earlier build wrote, rather than hiding it', () => {
    const rows = retentionRowsFromConfig({}, { researcher: { channelTranscript: '7d' } });
    expect(rows).toEqual([
      expect.objectContaining({
        personalityId: 'researcher',
        subkey: 'channelTranscript',
        duration: '7d',
      }),
    ]);
  });

  // The list existing is not the same as the editor USING it. Source-text
  // technique, same as `settings/__tests__/settings-form-placement.test.ts` —
  // `apps/web` has no jsdom and this change deliberately does not add one.
  // Comments AND the import block are stripped first: an unused import would
  // otherwise satisfy the assertion the moment the call site was reverted.
  it('is what the Data pane offers, and the Personality column narrows too', () => {
    const pane = paneBody('data.tsx');
    // Pick the personality first and the refused subkey is gone from Scope.
    expect(pane).toContain('RETENTION_SUBKEYS_PER_PERSONALITY');
    // Pick the subkey first and the Personality column offers only `Global`.
    expect(pane).toContain('RETENTION_NO_PERSONALITY_SCOPE');
  });
});
