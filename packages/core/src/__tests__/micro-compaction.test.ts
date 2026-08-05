// Item 7 stage 3 — micro-compaction's four cache-safe properties.
//
// Each property gets its own assertion because each one, broken on its own,
// silently defeats prefix caching and costs money on every subsequent turn.
// They are copied deliberately from `advanceAgingState`; see the module header
// in `agent-loop/micro-compaction.ts`.

import type { Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  advanceMicroState,
  applyMicroToView,
  DEFAULT_MICRO_STATE,
  levelForRatio,
  MICRO_BATCH,
  MICRO_FLOOR_RATIO,
  MICRO_STEP_RATIO,
  type MicroCompactionState,
  parseMicroState,
} from '../agent-loop/micro-compaction';

/** A tool-using assistant turn plus its results, as the LLM view carries them. */
function toolTurn(n: number, resultChars = 6_000): Message[] {
  const id = `toolu_${n}`;
  return [
    { role: 'user', content: `request ${n}` },
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'read_file', input: { n } }] },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: id, content: `R${n}:${'x'.repeat(resultChars)}` },
      ],
    },
    { role: 'assistant', content: `answer ${n}` },
  ];
}

function history(turns: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < turns; i++) out.push(...toolTurn(i));
  return out;
}

/** Ratio that lands exactly on step `level`. */
function ratioForLevel(level: number): number {
  return level === 0 ? 0 : MICRO_FLOOR_RATIO + (level - 1) * MICRO_STEP_RATIO;
}

describe('micro-compaction — property 1: monotonic level', () => {
  it('never lowers the level when pressure drops', () => {
    const msgs = history(12);
    const high = advanceMicroState(DEFAULT_MICRO_STATE, msgs, ratioForLevel(6));
    expect(high.state.level).toBe(6);

    // Pressure collapses (a compaction ran, or the session was trimmed).
    const dip = advanceMicroState(high.state, msgs, 0);
    expect(dip.state.level).toBe(6);
    expect(dip.changed).toBe(false);
  });

  it('never un-ages an id it has already aged', () => {
    const msgs = history(12);
    const a = advanceMicroState(DEFAULT_MICRO_STATE, msgs, ratioForLevel(3));
    const b = advanceMicroState(a.state, msgs, ratioForLevel(5));
    for (const id of [...a.state.trimmed, ...a.state.cleared]) {
      expect([...b.state.trimmed, ...b.state.cleared]).toContain(id);
    }
  });

  it('promotes trimmed ids to cleared rather than dropping them', () => {
    const msgs = history(20);
    const early = advanceMicroState(DEFAULT_MICRO_STATE, msgs, ratioForLevel(1));
    expect(early.state.trimmed.length).toBeGreaterThan(0);
    expect(early.state.cleared).toEqual([]);

    const late = advanceMicroState(early.state, msgs, ratioForLevel(8));
    const firstTrimmed = early.state.trimmed[0] ?? '';
    expect(late.state.cleared).toContain(firstTrimmed);
    expect(late.state.trimmed).not.toContain(firstTrimmed);
  });
});

describe('micro-compaction — property 2: early return on no crossing', () => {
  it('returns the previous state object unchanged between crossings', () => {
    const msgs = history(12);
    const first = advanceMicroState(DEFAULT_MICRO_STATE, msgs, ratioForLevel(2));
    expect(first.changed).toBe(true);

    // Same step band — nothing crosses.
    const between = advanceMicroState(first.state, msgs, ratioForLevel(2) + MICRO_STEP_RATIO / 2);
    expect(between.changed).toBe(false);
    expect(between.state).toBe(first.state);
  });

  it('rewrites the view byte-identically on a turn with no crossing', () => {
    const msgs = history(12);
    const { state } = advanceMicroState(DEFAULT_MICRO_STATE, msgs, ratioForLevel(3));

    const a = applyMicroToView(msgs, state);
    const b = applyMicroToView(msgs, state);
    expect(JSON.stringify(b.messages)).toBe(JSON.stringify(a.messages));
    expect(b.cacheBreakpoint).toBe(a.cacheBreakpoint);
  });

  it('does nothing at all below the floor ratio', () => {
    const msgs = history(12);
    const r = advanceMicroState(DEFAULT_MICRO_STATE, msgs, MICRO_FLOOR_RATIO - 0.001);
    expect(r.changed).toBe(false);
    expect(levelForRatio(MICRO_FLOOR_RATIO - 0.001)).toBe(0);
    expect(applyMicroToView(msgs, r.state).messages).toBe(msgs);
  });
});

describe('micro-compaction — property 3: keyed by tool_use ids, not indices', () => {
  it('rewrites the same tool results after the array grows', () => {
    const msgs = history(12);
    const { state } = advanceMicroState(DEFAULT_MICRO_STATE, msgs, ratioForLevel(2));
    const targeted = new Set([...state.trimmed, ...state.cleared]);
    expect(targeted.size).toBeGreaterThan(0);

    // Two more turns arrive; every existing message shifts by 8 positions.
    const grown = [...msgs, ...toolTurn(98), ...toolTurn(99)];
    const applied = applyMicroToView(grown, state);

    const contentById = (list: Message[]) => {
      const out = new Map<string, string>();
      for (const m of list) {
        if (m.role !== 'user' || typeof m.content === 'string') continue;
        for (const b of m.content) if (b.type === 'tool_result') out.set(b.tool_use_id, b.content);
      }
      return out;
    };
    const before = contentById(grown);
    const after = contentById(applied.messages);
    const rewritten = [...after.keys()].filter((id) => after.get(id) !== before.get(id));
    expect(rewritten.sort()).toEqual([...targeted].sort());
  });

  it('ignores an engine nomination naming an id that is not in the history', () => {
    const msgs = history(12);
    const { state } = advanceMicroState(DEFAULT_MICRO_STATE, msgs, ratioForLevel(2), {
      trimToolResults: ['toolu_does_not_exist'],
    });
    for (const id of state.trimmed) expect(id).toMatch(/^toolu_\d+$/);
  });
});

describe('micro-compaction — property 4: content-only, in-place', () => {
  it('never removes, adds, or reorders a message', () => {
    const msgs = history(12);
    const { state } = advanceMicroState(DEFAULT_MICRO_STATE, msgs, ratioForLevel(6));
    const out = applyMicroToView(msgs, state).messages;

    expect(out).toHaveLength(msgs.length);
    out.forEach((m, i) => {
      expect(m.role).toBe(msgs[i]?.role);
    });
  });

  it('keeps every tool_use paired with its tool_result', () => {
    const msgs = history(12);
    const { state } = advanceMicroState(DEFAULT_MICRO_STATE, msgs, ratioForLevel(6));
    const out = applyMicroToView(msgs, state).messages;

    const uses = new Set<string>();
    const results = new Set<string>();
    for (const m of out) {
      if (typeof m.content === 'string') continue;
      for (const b of m.content) {
        if (b.type === 'tool_use') uses.add(b.id);
        if (b.type === 'tool_result') results.add(b.tool_use_id);
      }
    }
    expect([...uses].sort()).toEqual([...results].sort());
  });

  it('shrinks the rewritten results rather than the message count', () => {
    const msgs = history(12);
    const { state } = advanceMicroState(DEFAULT_MICRO_STATE, msgs, ratioForLevel(8));
    const before = JSON.stringify(msgs).length;
    const after = JSON.stringify(applyMicroToView(msgs, state).messages).length;
    expect(after).toBeLessThan(before);
  });
});

describe('micro-compaction — amortization', () => {
  it('bounds the work done in any single turn across a 100-turn session', () => {
    // Baseline: what a single compaction pass touches when the gate finally
    // trips — every stale tool result, in one turn.
    const full = history(100);
    const baseline = advanceMicroState(DEFAULT_MICRO_STATE, full, 5).state;
    const baselinePause = baseline.trimmed.length + baseline.cleared.length;

    // Micro: 100 turns, pressure climbing linearly into the same band.
    let state: MicroCompactionState = DEFAULT_MICRO_STATE;
    let worstPause = 0;
    let crossings = 0;
    for (let turn = 1; turn <= 100; turn++) {
      const msgs = history(turn);
      const before = state.trimmed.length + state.cleared.length;
      const r = advanceMicroState(state, msgs, (turn / 100) * 5);
      if (r.changed) crossings++;
      const after = r.state.trimmed.length + r.state.cleared.length;
      worstPause = Math.max(worstPause, after - before);
      state = r.state;
    }

    expect(crossings).toBeGreaterThan(1);
    // No single turn does more than one step's worth of work…
    expect(worstPause).toBeLessThanOrEqual(MICRO_BATCH);
    // …and that is strictly better than the one-shot baseline pause.
    expect(worstPause).toBeLessThan(baselinePause);
  });
});

describe('micro-compaction — state persistence', () => {
  it('degrades to the default state on corrupt or hostile input', () => {
    expect(parseMicroState('not json')).toEqual(DEFAULT_MICRO_STATE);
    expect(parseMicroState('{"level":-3,"trimmed":[1,"a"],"cleared":null}')).toEqual({
      level: 0,
      trimmed: ['a'],
      cleared: [],
    });
  });

  it('round-trips a real state', () => {
    const msgs = history(12);
    const { state } = advanceMicroState(DEFAULT_MICRO_STATE, msgs, ratioForLevel(4));
    expect(parseMicroState(JSON.stringify(state))).toEqual(state);
  });
});
