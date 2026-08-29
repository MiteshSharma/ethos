import { describe, expect, it } from 'vitest';
import {
  CALL_LIST_LIMIT,
  type CallStatus,
  type CallSummary,
  callDurationMs,
  callRowView,
  callsQueryInput,
  DEFAULT_CALL_FILTER,
  formatCallCost,
  formatCallDuration,
  withoutActive,
} from '../call-rows';

// The whole of CallRow's decision-making, without a DOM. Every state a call can
// be in is asserted here rather than through markup: which `.sb-dot` modifier it
// wears is the one thing an operator reads at a glance in a long list, and it is
// exactly the kind of mapping a refactor quietly reshuffles.

const START = 1_700_000_000_000;

function call(over: Partial<CallSummary> = {}): CallSummary {
  return {
    id: 'CA_1',
    botKey: 'bot_a',
    laneKey: 'voice:bot_a:sip:+15550001111',
    direction: 'inbound',
    fromNumber: '+15550001111',
    toNumber: '+15559998888',
    personalityId: 'engineer',
    tier: 'realtime',
    status: 'completed',
    startedAt: START,
    endedAt: START + 83_000,
    reason: null,
    summaryPreview: 'Asked about the deploy window.',
    hasTranscript: true,
    costUsd: 0.42,
    ...over,
  };
}

describe('callRowView — one row per status', () => {
  const cases: Array<[CallStatus, string, string, boolean, boolean]> = [
    // status, dot modifier, mono label, live, muted
    ['ringing', 'sb-dot--connecting', 'ringing', true, false],
    ['live', 'sb-dot--call-live', 'live', true, false],
    ['completed', 'sb-dot--connected', 'completed', false, false],
    ['screened', 'sb-dot--muted', 'screened', false, true],
    ['refused', 'sb-dot--wake-off', 'refused', false, true],
    ['failed', 'sb-dot--degraded', 'failed', false, false],
  ];

  for (const [status, dotClass, label, live, muted] of cases) {
    it(`${status} → ${dotClass}`, () => {
      const view = callRowView(call({ status }), START);
      expect(view.dotClass).toBe(dotClass);
      expect(view.label).toBe(label);
      expect(view.live).toBe(live);
      expect(view.muted).toBe(muted);
    });
  }

  it('gives every status a DISTINCT dot modifier', () => {
    // Six states that mean six different things. Two sharing a modifier would
    // make the list unreadable in exactly the case it exists for: telling "we
    // said no" from "it broke".
    const modifiers = cases.map(([status]) => callRowView(call({ status }), START).dotClass);
    expect(new Set(modifiers).size).toBe(modifiers.length);
  });

  it('extends the existing connection dot rather than inventing a vocabulary', () => {
    for (const [status] of cases) {
      expect(callRowView(call({ status }), START).dotClass).toMatch(/^sb-dot--/);
    }
  });
});

describe('callRowView — duration', () => {
  it('a live call is measured against now, and keeps growing', () => {
    const live = call({ status: 'live', endedAt: null });
    expect(callDurationMs(live, START + 7_000)).toBe(7_000);
    expect(callRowView(live, START + 7_000).duration).toBe('0:07');
    expect(callRowView(live, START + 67_000).duration).toBe('1:07');
  });

  it('a completed call is measured against endedAt, and now cannot move it', () => {
    const done = call({ endedAt: START + 83_000 });
    expect(callRowView(done, START + 83_000).duration).toBe('1:23');
    // An hour later the row still says 1:23 — the call did not get longer.
    expect(callRowView(done, START + 3_683_000).duration).toBe('1:23');
  });

  it('rolls into hours with a padded minute field', () => {
    expect(formatCallDuration(3_753_000)).toBe('1:02:33');
    expect(formatCallDuration(0)).toBe('0:00');
  });

  it('never renders a negative duration when a clock disagrees', () => {
    expect(callDurationMs(call({ status: 'live', endedAt: null }), START - 5_000)).toBe(0);
  });

  // A call the agent PLACED closes the instant the trunk accepts the dial —
  // nothing stays on the line to hear it end, so the log records no `endedAt`.
  // Measured against `now` it would render a FINISHED call whose duration grows
  // every second the tab is open; `0:00` would be quieter and still invented.
  // Both would sit in the same column as real, measured inbound durations.
  it('renders NO duration for an ended call nobody timed', () => {
    const unwatched = call({ status: 'completed', endedAt: null });
    expect(callDurationMs(unwatched, START + 90_000)).toBeNull();
    expect(callRowView(unwatched, START + 90_000).duration).toBeNull();
    // And it does not start growing later, either.
    expect(callRowView(unwatched, START + 3_600_000).duration).toBeNull();
  });

  it('withholds the duration on every ended status, not just completed', () => {
    for (const status of ['completed', 'screened', 'refused', 'failed'] as const) {
      expect(callRowView(call({ status, endedAt: null }), START + 90_000).duration).toBeNull();
    }
  });

  it('a ringing call with no endedAt still ticks — it has not ended', () => {
    // The `now` fallback is CORRECT for a live row; the fix must not take it.
    expect(callRowView(call({ status: 'ringing', endedAt: null }), START + 9_000).duration).toBe(
      '0:09',
    );
    expect(callRowView(call({ status: 'live', endedAt: null }), START + 9_000).duration).toBe(
      '0:09',
    );
  });

  it('a failed call keeps the duration it actually recorded', () => {
    // A trunk that refused the dial DID end here, and the log knows when.
    const failed = call({ status: 'failed', endedAt: START + 2_000 });
    expect(callRowView(failed, START + 3_600_000).duration).toBe('0:02');
  });
});

describe('callRowView — what the row says', () => {
  it('shows the FAR end of the call, not our own number', () => {
    expect(callRowView(call({ direction: 'inbound' }), START).otherParty).toBe('+15550001111');
    expect(callRowView(call({ direction: 'outbound' }), START).otherParty).toBe('+15559998888');
    expect(callRowView(call({ direction: 'inbound' }), START).arrow).toBe('←');
    expect(callRowView(call({ direction: 'outbound' }), START).arrow).toBe('→');
  });

  it('a screened row surfaces its reason inline', () => {
    const view = callRowView(call({ status: 'screened', reason: 'not_allowlisted' }), START);
    expect(view.reason).toBe('not_allowlisted');
    expect(view.muted).toBe(true);
  });

  it('a refused row surfaces its reason too — the refusal is the point of logging it', () => {
    expect(callRowView(call({ status: 'refused', reason: 'over_budget' }), START).reason).toBe(
      'over_budget',
    );
  });

  // An outbound call the agent placed is closed the moment the trunk accepts it,
  // because nothing stays on the line to see it end. Its reason is the only thing
  // separating "it finished" from "we stopped watching", so a bare green
  // `completed` with the explanation dropped would overclaim.
  it('a completed row surfaces its reason — a green row alone would overclaim', () => {
    expect(
      callRowView(call({ status: 'completed', reason: 'the outcome was not recorded' }), START)
        .reason,
    ).toBe('the outcome was not recorded');
  });

  it('a completed call the log kept no reason for renders none', () => {
    expect(callRowView(call({ status: 'completed', reason: null }), START).reason).toBeNull();
  });

  it('a call still up has no reason to show — it has not ended', () => {
    expect(callRowView(call({ status: 'ringing', reason: 'whatever' }), START).reason).toBeNull();
    expect(callRowView(call({ status: 'live', reason: 'whatever' }), START).reason).toBeNull();
  });

  it('hasTranscript: false hides the transcript link', () => {
    expect(callRowView(call({ hasTranscript: false }), START).showTranscript).toBe(false);
    expect(callRowView(call({ hasTranscript: true }), START).showTranscript).toBe(true);
  });

  it('an unpriced call renders no cost rather than $0.00', () => {
    expect(formatCallCost(null)).toBeNull();
    expect(formatCallCost(0.4)).toBe('$0.40');
    expect(callRowView(call({ costUsd: null }), START).cost).toBeNull();
  });
});

describe('callsQueryInput — the filter chips narrow the SERVER query', () => {
  it('the default filter asks for everything, and says so by omission', () => {
    const input = callsQueryInput(DEFAULT_CALL_FILTER);
    expect(input).toEqual({ limit: CALL_LIST_LIMIT });
    // `'all'` is never sent: the contract's enums would refuse it.
    expect(input).not.toHaveProperty('direction');
    expect(input).not.toHaveProperty('status');
  });

  it('a direction chip narrows direction and leaves status alone', () => {
    expect(callsQueryInput({ direction: 'inbound', status: 'all' }, 25)).toEqual({
      limit: 25,
      direction: 'inbound',
    });
  });

  it('a status chip narrows status', () => {
    expect(callsQueryInput({ direction: 'all', status: 'screened' })).toEqual({
      limit: CALL_LIST_LIMIT,
      status: 'screened',
    });
  });

  it('both chips compose', () => {
    expect(callsQueryInput({ direction: 'outbound', status: 'failed' })).toEqual({
      limit: CALL_LIST_LIMIT,
      direction: 'outbound',
      status: 'failed',
    });
  });
});

describe('withoutActive', () => {
  it('drops calls already pinned as in-progress, so nothing renders twice', () => {
    const live = call({ id: 'CA_live', status: 'live', endedAt: null });
    const old = call({ id: 'CA_old' });
    expect(withoutActive([live, old], [live]).map((c) => c.id)).toEqual(['CA_old']);
  });

  it('leaves the history alone when nothing is live', () => {
    const rows = [call({ id: 'a' }), call({ id: 'b' })];
    expect(withoutActive(rows, [])).toHaveLength(2);
  });
});
