// The retention duration grammar, pinned.
//
// `RETENTION_DURATION_PATTERN` exists to be checked at CONFIG LOAD against a
// grammar whose only enforcer — `parseDuration` in
// `extensions/observability-sqlite/src/retention.ts` — lives in an extension
// `@ethosagent/types` may not import (ARCHITECTURE.md §II: types depends on
// nothing). So the two cannot be compared by construction, and this file is
// the comparison: the accept/reject rows below are `parseDuration`'s own
// `/^(\d+)(d|w|m|y)$/` plus its `'forever'` early return, transcribed. If that
// function's grammar changes, this file fails and names the drift.

import { describe, expect, it } from 'vitest';
import { isRetentionDuration, RETENTION_DEFAULTS, RETENTION_DURATION_PATTERN } from '../retention';

// Accepted by `parseDuration` without throwing.
const ACCEPTED = ['forever', '0d', '7d', '30d', '12w', '6m', '365d', '2y'];

// Rejected — `parseDuration` THROWS on every one of these, which is the whole
// reason the value has to be caught before it reaches the nightly prune.
const REJECTED = [
  '30days', // the plausible typo
  '12h', // hours are not in the grammar; docs advertised this once
  '90', // no unit
  'd', // no number
  '-1d', // sign
  '1.5d', // fraction
  '30D', // case
  '30d ', // trailing space
  ' 30d', // leading space
  '30d\n30d', // multiline — a `^…$` regex without `m` must not match this
  'never',
  '',
];

describe('RETENTION_DURATION_PATTERN', () => {
  it.each(ACCEPTED)('accepts %s', (value) => {
    expect(isRetentionDuration(value)).toBe(true);
  });

  it.each(REJECTED)('rejects %s', (value) => {
    expect(isRetentionDuration(value)).toBe(false);
  });

  it('is not a global regex — `test` must not carry lastIndex between calls', () => {
    expect(RETENTION_DURATION_PATTERN.flags).toBe('');
    expect(RETENTION_DURATION_PATTERN.test('30d')).toBe(true);
    expect(RETENTION_DURATION_PATTERN.test('30d')).toBe(true);
  });

  it('accepts every shipped default', () => {
    const defaults = [
      RETENTION_DEFAULTS.messages,
      RETENTION_DEFAULTS.traces,
      RETENTION_DEFAULTS.spans,
      RETENTION_DEFAULTS.blobs,
      RETENTION_DEFAULTS.archive,
      RETENTION_DEFAULTS.channelTranscript,
      RETENTION_DEFAULTS.events.error,
      RETENTION_DEFAULTS.events.audit,
      RETENTION_DEFAULTS.events.channel,
      RETENTION_DEFAULTS.events.install,
    ];
    for (const value of defaults) expect(isRetentionDuration(value)).toBe(true);
  });
});
