import { describe, expect, it } from 'vitest';
import {
  appendTrailEntry,
  closeTrail,
  formatDuration,
  previewArgs,
  statusGlyph,
  statusWord,
  summariseTrail,
  type TrailAction,
  type TrailState,
  toolLabel,
  trailRowId,
  updateTrailAction,
  updateTrailActionAnywhere,
} from '../trail';

// The trail is the ONE derivation of "what the agent did" — the footer under
// the bubble and the right drawer both read it, so they cannot disagree. These
// are pure-state tests: no React, no jsdom.

function action(over: Partial<TrailAction> = {}): TrailAction {
  return {
    kind: 'action',
    toolCallId: 'tc1',
    toolName: 'read_file',
    args: { path: 'x' },
    status: 'running',
    ...over,
  };
}

describe('appendTrailEntry', () => {
  it('opens a turn key on first entry and appends in order', () => {
    let trail: TrailState = {};
    trail = appendTrailEntry(trail, 't1', action({ toolCallId: 'a' }));
    trail = appendTrailEntry(trail, 't1', action({ toolCallId: 'b' }));
    expect(trail.t1?.map((e) => (e.kind === 'action' ? e.toolCallId : e.id))).toEqual(['a', 'b']);
  });

  it('does not mutate the input', () => {
    const trail: TrailState = {};
    appendTrailEntry(trail, 't1', action());
    expect(trail).toEqual({});
  });
});

describe('updateTrailAction', () => {
  it('flips the matching action and leaves its siblings alone', () => {
    let trail: TrailState = {};
    trail = appendTrailEntry(trail, 't1', action({ toolCallId: 'a' }));
    trail = appendTrailEntry(trail, 't1', action({ toolCallId: 'b' }));
    trail = updateTrailAction(trail, 't1', 'b', { status: 'ok', durationMs: 42 });
    const [first, second] = trail.t1 ?? [];
    expect(first?.kind === 'action' && first.status).toBe('running');
    expect(second?.kind === 'action' && second.status).toBe('ok');
    expect(second?.kind === 'action' && second.durationMs).toBe(42);
  });

  it('is a no-op — same reference — for an unknown turn or call', () => {
    const trail = appendTrailEntry({}, 't1', action());
    expect(updateTrailAction(trail, 'other', 'tc1', { status: 'ok' })).toBe(trail);
    expect(updateTrailAction(trail, 't1', 'nope', { status: 'ok' })).toBe(trail);
  });

  it('never rewrites a finding', () => {
    const trail = appendTrailEntry({}, 't1', { kind: 'finding', id: 'f1', claim: 'tests pass' });
    expect(updateTrailAction(trail, 't1', 'f1', { status: 'ok' })).toBe(trail);
  });
});

describe('updateTrailActionAnywhere', () => {
  it('finds a turn that has already moved into history', () => {
    // tool_start on the live turn → done moves it to history under the same
    // key → tool_end arrives late. The row still has to close.
    let trail: TrailState = {};
    trail = appendTrailEntry(trail, 'asst-1', action({ toolCallId: 'tc9' }));
    trail = appendTrailEntry(trail, 'asst-2', action({ toolCallId: 'tc10' }));
    trail = updateTrailActionAnywhere(trail, 'tc9', { status: 'ok', durationMs: 5 });
    const entry = trail['asst-1']?.[0];
    expect(entry?.kind === 'action' && entry.status).toBe('ok');
    expect(entry?.kind === 'action' && entry.durationMs).toBe(5);
  });

  it('returns the same reference when nothing matches', () => {
    const trail = appendTrailEntry({}, 't1', action());
    expect(updateTrailActionAnywhere(trail, 'unknown', { status: 'ok' })).toBe(trail);
  });
});

describe('closeTrail', () => {
  it('marks anything still running as failed — an aborted turn did not finish', () => {
    let trail: TrailState = {};
    trail = appendTrailEntry(trail, 't1', action({ toolCallId: 'done', status: 'ok' }));
    trail = appendTrailEntry(trail, 't1', action({ toolCallId: 'live', status: 'running' }));
    trail = closeTrail(trail, 't1', 'stopped');
    expect((trail.t1 ?? []).map((e) => (e.kind === 'action' ? e.status : 'finding'))).toEqual([
      'ok',
      'failed',
    ]);
  });

  it('settles a call parked on approval too — nothing is left to answer it', () => {
    // The turn that asked is over: the approval modal it was waiting on has
    // been closed by the same terminal transition, so a row left reading
    // `waiting` would wait for ever.
    let trail = appendTrailEntry({}, 't1', action({ toolCallId: 'a', status: 'pending-approval' }));
    trail = appendTrailEntry(trail, 't1', action({ toolCallId: 'b', status: 'ok' }));
    const closed = closeTrail(trail, 't1', 'stopped');
    expect((closed.t1 ?? []).map((e) => e.kind === 'action' && e.status)).toEqual(['failed', 'ok']);
  });

  it('leaves an already-settled turn — and an unknown one — untouched', () => {
    const trail = appendTrailEntry({}, 't1', action({ status: 'ok' }));
    expect(closeTrail(trail, 't1', 'stopped')).toBe(trail);
    expect(closeTrail(trail, 'nope', 'stopped')).toBe(trail);
  });
});

describe('summariseTrail', () => {
  it('counts actions, findings and failures, and sums durations', () => {
    const summary = summariseTrail([
      action({ toolCallId: 'a', status: 'ok', durationMs: 1_200 }),
      action({ toolCallId: 'b', status: 'failed', durationMs: 300 }),
      { kind: 'finding', id: 'f1', claim: 'tests pass' },
    ]);
    expect(summary).toEqual({
      actions: 2,
      findings: 1,
      ok: 1,
      failed: 1,
      unrecorded: 0,
      totalDurationMs: 1_500,
    });
  });

  it('reports a null duration when NO action carries one (history rows)', () => {
    const summary = summariseTrail([action({ status: 'ok' }), action({ toolCallId: 'b' })]);
    expect(summary.totalDurationMs).toBeNull();
    expect(summary.actions).toBe(2);
  });

  it('sums only the actions that have a duration', () => {
    const summary = summariseTrail([action({ durationMs: 500 }), action({ toolCallId: 'b' })]);
    expect(summary.totalDurationMs).toBe(500);
  });

  it('an empty trail is zero everything', () => {
    expect(summariseTrail([])).toEqual({
      actions: 0,
      findings: 0,
      ok: 0,
      failed: 0,
      unrecorded: 0,
      totalDurationMs: null,
    });
  });

  it('an unrecorded action counts as work done, but as NEITHER a success nor a failure', () => {
    // History carries no ok/failed flag. Counting these as successes is what
    // let a reloaded turn claim `✓ N actions` for calls that may have failed.
    const summary = summariseTrail([
      action({ toolCallId: 'a', status: 'unrecorded' }),
      action({ toolCallId: 'b', status: 'unrecorded' }),
    ]);
    expect(summary.actions).toBe(2);
    expect(summary.ok).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.unrecorded).toBe(2);
  });

  it('a live tool_end on a reloaded row moves it out of unrecorded', () => {
    let trail: TrailState = {};
    trail = appendTrailEntry(trail, 't1', action({ toolCallId: 'tc1', status: 'unrecorded' }));
    trail = updateTrailActionAnywhere(trail, 'tc1', { status: 'failed', durationMs: 9 });
    expect(summariseTrail(trail.t1 ?? [])).toMatchObject({ unrecorded: 0, failed: 1 });
  });
});

describe('row vocabulary', () => {
  it('pairs a glyph with a word for every status — colour is never alone', () => {
    expect([statusGlyph('ok'), statusWord('ok')]).toEqual(['✓', 'ok']);
    expect([statusGlyph('failed'), statusWord('failed')]).toEqual(['✗', 'failed']);
    expect([statusGlyph('unverified'), statusWord('unverified')]).toEqual(['⚠', 'unverified']);
    expect([statusGlyph('pending-approval'), statusWord('pending-approval')]).toEqual([
      '?',
      'waiting',
    ]);
    expect(statusWord('running')).toBe('running');
  });

  it('marks an unrecorded outcome neutrally — neither a tick nor a cross', () => {
    // A reloaded call RAN; whether it worked was never persisted. A ✓ here
    // would be assurance the wire never carried (contract §3).
    expect(statusWord('unrecorded')).toBe('unrecorded');
    expect(statusGlyph('unrecorded')).not.toBe('✓');
    expect(statusGlyph('unrecorded')).not.toBe('✗');
    expect(statusGlyph('unrecorded')).toBe('–');
  });
});

describe('formatting helpers', () => {
  it('previews the first informative arg value, truncated', () => {
    expect(previewArgs({ path: '/etc/hosts' })).toBe('/etc/hosts');
    expect(previewArgs({ url: 'x', method: 'GET' })).toBe('x');
    expect(previewArgs({})).toBe('');
    expect(previewArgs(null)).toBe('');
    expect(previewArgs('a'.repeat(80))).toHaveLength(60);
  });

  it('formats sub-second durations in ms and the rest in tenths of a second', () => {
    expect(formatDuration(42)).toBe('42ms');
    expect(formatDuration(12_400)).toBe('12.4s');
  });

  it('builds the status line label as `{tool} · {argsPreview}`', () => {
    expect(toolLabel('read_file', { path: 'x' })).toBe('read_file · x');
    expect(toolLabel('read_file', {})).toBe('read_file');
  });

  it('derives a deterministic row id, so a finding can focus what it cites', () => {
    expect(trailRowId('asst-1', 'tc9')).toBe(trailRowId('asst-1', 'tc9'));
    expect(trailRowId('asst-1', 'tc9')).not.toBe(trailRowId('asst-2', 'tc9'));
  });
});
