import { describe, expect, it } from 'vitest';
import { filterSettings, SETTINGS_INDEX } from '../lib/settings-index';

// T4 — plan/phases/settings-navigation.md D7 + D8 + D10. Search reads the one
// index table, matches label OR config key, and does not care what the advanced
// toggle says.
//
// The key half is the half that matters: an operator who read
// `voice.trunk.webhookSecret` out of `config.yaml` has a string, not a label,
// and until this change there was nowhere on the page to type it.

describe('filterSettings', () => {
  it('matches on the label', () => {
    const hits = filterSettings('processing chime');
    expect(hits.map((h) => h.key)).toContain('display.voice_chime');
  });

  it('matches on the config key, which is what an operator arrives holding', () => {
    const hits = filterSettings('voice.trunk.webhookSecret');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.label).toBe('Webhook secret');
    expect(hits[0]?.category).toBe('voice');
    expect(hits[0]?.section).toBe('trunk');
  });

  it('matches a key fragment, so a family can be swept at once', () => {
    const hits = filterSettings('voice.bargeIn.');
    expect(hits.length).toBeGreaterThan(1);
    expect(hits.every((h) => h.section === 'barge-in')).toBe(true);
  });

  it('is case-insensitive on both halves', () => {
    expect(filterSettings('WEBHOOK SECRET').map((h) => h.key)).toContain(
      'voice.trunk.webhookSecret',
    );
    expect(filterSettings('VOICE.TIER').map((h) => h.formName)).toContain('voiceTier');
  });

  it('finds advanced entries — the toggle decides how a row is DRAWN, not whether it exists', () => {
    // `filterSettings` takes no toggle argument at all, which is the strongest
    // form this can be asserted in: there is no state it could consult.
    const hits = filterSettings('background.max_concurrent_jobs');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.advanced).toBe(true);
  });

  it('finds state-backed rows too, which have no form field to match on', () => {
    const hits = filterSettings('named secrets');
    expect(hits.some((h) => h.stateBacked)).toBe(true);
  });

  it('returns nothing for an empty or blank query rather than the whole table', () => {
    expect(filterSettings('')).toEqual([]);
    expect(filterSettings('   ')).toEqual([]);
  });

  it('returns nothing for a query nothing matches', () => {
    expect(filterSettings('zzz-no-such-setting')).toEqual([]);
  });

  it('searches the whole index, not a prefix of it', () => {
    // The last entry in the table is as findable as the first.
    const last = SETTINGS_INDEX[SETTINGS_INDEX.length - 1];
    expect(last).toBeDefined();
    if (last) expect(filterSettings(last.label)).toContainEqual(last);
  });

  it('keeps the two approval controls apart, because their keys are visible', () => {
    // §4.1: tool approval and memory approval are near-homonyms one rail apart,
    // and the standing temptation is to "unify the approval settings".
    const hits = filterSettings('approval');
    const keys = hits.map((h) => h.key);
    expect(keys).toContain('approvalMode');
    expect(keys).toContain('memoryApproval.mode');
    expect(hits.find((h) => h.key === 'approvalMode')?.category).toBe('security');
    expect(hits.find((h) => h.key === 'memoryApproval.mode')?.category).toBe('memory');
  });
});
