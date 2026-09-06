import { describe, expect, it } from 'vitest';
import { RETENTION_SUBKEYS } from '../settings/lib/config-types';
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
