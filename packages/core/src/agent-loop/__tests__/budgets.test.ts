import { describe, expect, it } from 'vitest';
import {
  budgetGuardEvents,
  checkCostBudget,
  checkTurnBudgets,
  type IdenticalStreak,
  MAX_CONSECUTIVE_DENIALS,
  updateDenialStreak,
  updateIdenticalStreak,
} from '../budgets';

function foldCalls(calls: Array<{ toolName: string; args: unknown }>): IdenticalStreak | null {
  let streak: IdenticalStreak | null = null;
  for (const call of calls) {
    streak = updateIdenticalStreak(streak, call.toolName, call.args);
  }
  return streak;
}

function check(streak: IdenticalStreak | null, maxConsecutive: number) {
  return checkTurnBudgets(0, 100, new Map(), 100, streak, maxConsecutive);
}

describe('updateIdenticalStreak', () => {
  it('increments the streak on consecutive identical tool+args calls', () => {
    const streak = foldCalls([
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/a' } },
    ]);
    expect(streak).toEqual({
      key: `read_file:${JSON.stringify({ path: '/a' })}`,
      toolName: 'read_file',
      count: 3,
    });
  });

  it('resets to 1 when the same tool is called with different args', () => {
    const streak = foldCalls([
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/b' } },
    ]);
    expect(streak?.count).toBe(1);
  });

  it('resets to 1 when a different tool interleaves', () => {
    const streak = foldCalls([
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'bash', args: { command: 'ls' } },
      { toolName: 'read_file', args: { path: '/a' } },
    ]);
    expect(streak).toEqual({
      key: `read_file:${JSON.stringify({ path: '/a' })}`,
      toolName: 'read_file',
      count: 1,
    });
  });

  it('falls back to the tool name when args are not serializable', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const first = updateIdenticalStreak(null, 'weird_tool', circular);
    const second = updateIdenticalStreak(first, 'weird_tool', circular);
    expect(second).toEqual({ key: 'weird_tool', toolName: 'weird_tool', count: 2 });
  });
});

describe('checkTurnBudgets — consecutive-identical-call guard', () => {
  it('does not trip below the threshold', () => {
    const streak = foldCalls([
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/a' } },
    ]);
    expect(check(streak, 5)).toEqual({ exceeded: false });
  });

  it('trips at the threshold with a loop message', () => {
    const streak = foldCalls([
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/a' } },
    ]);
    expect(check(streak, 5)).toEqual({
      exceeded: true,
      rule: 'identical-streak',
      toolName: 'read_file',
      count: 5,
      message: 'Stopped: read_file called 5 times in a row with identical arguments (loop)',
    });
  });

  it('does not trip when the same tool is called many times with different args', () => {
    const streak = foldCalls(
      Array.from({ length: 10 }, (_, i) => ({ toolName: 'read_file', args: { path: `/f${i}` } })),
    );
    expect(check(streak, 5)).toEqual({ exceeded: false });
  });

  it('does not trip when an interleaved different tool keeps resetting the streak', () => {
    const streak = foldCalls([
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'bash', args: { command: 'ls' } },
      { toolName: 'read_file', args: { path: '/a' } },
      { toolName: 'read_file', args: { path: '/a' } },
    ]);
    expect(check(streak, 5)).toEqual({ exceeded: false });
  });

  it('handles a null streak (no tool calls yet)', () => {
    expect(check(null, 5)).toEqual({ exceeded: false });
  });

  it('keeps the existing total and per-name caps intact', () => {
    expect(checkTurnBudgets(100, 100, new Map(), 25, null, 5)).toEqual({
      exceeded: true,
      rule: 'tool-budget',
      toolName: '_budget',
      count: 100,
      message: 'Stopped: hit 100-tool-call budget for this turn',
    });
    expect(checkTurnBudgets(30, 100, new Map([['bash', 25]]), 25, null, 5)).toEqual({
      exceeded: true,
      rule: 'identical-name',
      toolName: 'bash',
      count: 25,
      message: 'Stopped: bash called 25 times in one turn (likely loop)',
    });
  });
});

describe('cost cap', () => {
  const cost = (spentUsd: number, capUsd?: number) =>
    checkTurnBudgets(0, 100, new Map(), 25, null, 5, { spentUsd, capUsd });

  it('does not trip when no cap is configured, however much was spent', () => {
    expect(cost(999)).toEqual({ exceeded: false });
    expect(cost(999, undefined)).toEqual({ exceeded: false });
  });

  it('does not trip while spend is below the cap', () => {
    expect(cost(0.049, 0.05)).toEqual({ exceeded: false });
  });

  it('trips when spend meets or exceeds the cap', () => {
    expect(cost(0.06, 0.05)).toEqual({
      exceeded: true,
      rule: 'cost-cap',
      toolName: '_budget',
      message: 'Stopped: hit $0.05 budget cap for this session ($0.0600 spent)',
    });
    expect(cost(0.05, 0.05).exceeded).toBe(true);
  });

  it('trips a zero cap immediately', () => {
    expect(cost(0, 0).exceeded).toBe(true);
  });

  it('reports cost ahead of the tool-call budget when both are blown', () => {
    const r = checkTurnBudgets(100, 100, new Map(), 25, null, 5, { spentUsd: 1, capUsd: 0.5 });
    expect(r.exceeded && r.rule).toBe('cost-cap');
  });

  it('is the SAME check callers outside a turn run — one threshold, one message', () => {
    // The realtime voice tier accrues wall-clock audio cost on its own control
    // lane, where there are no tool calls, no identical-call streak and no
    // denials to check. It calls `checkCostBudget` directly; if that stopped
    // agreeing with the turn check, a call and a turn would stop for money at
    // different moments and say different things about it.
    const cases: Array<[number, number | undefined]> = [
      [0.049, 0.05],
      [0.05, 0.05],
      [1, 0.5],
      [999, undefined],
      [0, 0],
    ];
    for (const [spentUsd, capUsd] of cases) {
      expect(checkCostBudget({ spentUsd, ...(capUsd === undefined ? {} : { capUsd }) })).toEqual(
        cost(spentUsd, capUsd),
      );
    }
  });
});

describe('updateDenialStreak', () => {
  it('resets to zero when a batch had no approval denials', () => {
    expect(updateDenialStreak(2, { hookDenials: 0, successCount: 1 })).toBe(0);
    expect(updateDenialStreak(2, { hookDenials: 0, successCount: 0 })).toBe(0);
  });

  it('accumulates across batches where nothing executed', () => {
    let streak = 0;
    streak = updateDenialStreak(streak, { hookDenials: 1, successCount: 0 });
    streak = updateDenialStreak(streak, { hookDenials: 1, successCount: 0 });
    expect(streak).toBe(2);
  });

  it('restarts at the batch count when a tool actually executed', () => {
    // A successful execution breaks the run; this batch's own denials are
    // still the most recent consecutive ones.
    expect(updateDenialStreak(5, { hookDenials: 1, successCount: 3 })).toBe(1);
  });

  it('counts parallel denials in a single batch', () => {
    expect(updateDenialStreak(0, { hookDenials: 3, successCount: 0 })).toBe(3);
  });
});

describe('denial circuit breaker', () => {
  const denials = (n: number) => checkTurnBudgets(0, 100, new Map(), 25, null, 5, undefined, n);

  it('does not trip below the threshold', () => {
    expect(denials(0)).toEqual({ exceeded: false });
    expect(denials(MAX_CONSECUTIVE_DENIALS - 1)).toEqual({ exceeded: false });
  });

  it('trips at the threshold with the denial_circuit_breaker rule', () => {
    expect(denials(MAX_CONSECUTIVE_DENIALS)).toEqual({
      exceeded: true,
      rule: 'denial_circuit_breaker',
      toolName: '_approval',
      count: 3,
      message: 'Stopped: 3 tool calls denied in a row — retrying will not help',
    });
  });

  it('defaults to no denials when the argument is omitted', () => {
    expect(checkTurnBudgets(0, 100, new Map(), 25, null, 5)).toEqual({ exceeded: false });
  });
});

describe('soft-warn tier', () => {
  const warn = (totalToolCalls: number, counts: Map<string, number>, tiers = {}) =>
    checkTurnBudgets(totalToolCalls, 100, counts, 25, null, 5, undefined, 0, tiers);

  it('produces no warn when no threshold is configured', () => {
    expect(warn(99, new Map([['bash', 24]]))).toEqual({ exceeded: false });
  });

  it('warns on the total-call tier without setting exceeded', () => {
    const r = warn(40, new Map(), { maxToolCallsWarnAt: 40 });
    expect(r.exceeded).toBe(false);
    expect(r).toEqual({
      exceeded: false,
      warns: [
        {
          rule: 'tool-budget',
          toolName: '_budget',
          count: 40,
          message: '40 tool calls this turn (warn at 40, hard cap 100)',
        },
      ],
    });
  });

  it('warns on the per-tool-name tier without setting exceeded', () => {
    const r = warn(5, new Map([['bash', 10]]), { maxIdenticalToolCallsWarnAt: 10 });
    expect(r.exceeded).toBe(false);
    expect(r).toEqual({
      exceeded: false,
      warns: [
        {
          rule: 'identical-name',
          toolName: 'bash',
          count: 10,
          message: 'bash called 10 times this turn (warn at 10, hard cap 25)',
        },
      ],
    });
  });

  // Regression: the total-call tier used to return early, so once it was
  // crossed the identical-tool tier could never be reported at all.
  it('reports BOTH tiers when both are crossed in the same turn', () => {
    const r = warn(40, new Map([['bash', 10]]), {
      maxToolCallsWarnAt: 40,
      maxIdenticalToolCallsWarnAt: 10,
    });
    expect(r.exceeded).toBe(false);
    expect(r).toEqual({
      exceeded: false,
      warns: [
        expect.objectContaining({ rule: 'tool-budget', count: 40 }),
        expect.objectContaining({ rule: 'identical-name', toolName: 'bash', count: 10 }),
      ],
    });
  });

  it('stays silent below the threshold', () => {
    expect(
      warn(39, new Map([['bash', 9]]), {
        maxToolCallsWarnAt: 40,
        maxIdenticalToolCallsWarnAt: 10,
      }),
    ).toEqual({ exceeded: false });
  });

  it('yields to the hard cap — an exceeded result never carries a warn', () => {
    const r = checkTurnBudgets(100, 100, new Map(), 25, null, 5, undefined, 0, {
      maxToolCallsWarnAt: 40,
    });
    expect(r.exceeded).toBe(true);
    expect(r).not.toHaveProperty('warns');
  });
});

describe('budgetGuardEvents', () => {
  const latch = () => ({ warned: new Set<string>() });

  it('emits the warn once per rule per turn, at the internal audience', () => {
    const l = latch();
    const result = checkTurnBudgets(40, 100, new Map(), 25, null, 5, undefined, 0, {
      maxToolCallsWarnAt: 40,
    });

    const first = [...budgetGuardEvents(result, l)];
    expect(first).toEqual([
      {
        type: 'tool_progress',
        toolName: '_budget',
        message: '40 tool calls this turn (warn at 40, hard cap 100)',
        audience: 'internal',
      },
    ]);

    // Same rule, later iteration of the same turn — silent.
    const second = [...budgetGuardEvents(result, l)];
    expect(second).toEqual([]);
  });

  it('emits both crossed rules exactly once each in the same turn', () => {
    const l = latch();
    const result = checkTurnBudgets(40, 100, new Map([['bash', 10]]), 25, null, 5, undefined, 0, {
      maxToolCallsWarnAt: 40,
      maxIdenticalToolCallsWarnAt: 10,
    });

    expect([...budgetGuardEvents(result, l)]).toEqual([
      {
        type: 'tool_progress',
        toolName: '_budget',
        message: '40 tool calls this turn (warn at 40, hard cap 100)',
        audience: 'internal',
      },
      {
        type: 'tool_progress',
        toolName: 'bash',
        message: 'bash called 10 times this turn (warn at 10, hard cap 25)',
        audience: 'internal',
      },
    ]);
    // Both rules are latched — a later iteration of the same turn is silent.
    expect([...budgetGuardEvents(result, l)]).toEqual([]);
  });

  it('reports false for a warn (the turn continues) and true for a hard cap', () => {
    const l = latch();
    const warned = checkTurnBudgets(40, 100, new Map(), 25, null, 5, undefined, 0, {
      maxToolCallsWarnAt: 40,
    });
    const warnGen = budgetGuardEvents(warned, l);
    while (!warnGen.next().done) {
      // drain
    }
    expect(budgetGuardEvents(warned, latch()).next().value).toBeDefined();

    const halted = checkTurnBudgets(100, 100, new Map(), 25, null, 5);
    const gen = budgetGuardEvents(halted, latch());
    let step = gen.next();
    const events = [];
    while (!step.done) {
      events.push(step.value);
      step = gen.next();
    }
    expect(step.value).toBe(true);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'tool_progress', audience: 'user' });
    expect(events[1]).toMatchObject({ type: 'halt', kind: 'budget' });
  });

  it('returns false when nothing tripped and emits nothing', () => {
    const gen = budgetGuardEvents({ exceeded: false }, latch());
    const step = gen.next();
    expect(step.done).toBe(true);
    expect(step.value).toBe(false);
  });
});
