import type { BackgroundJobStatusWire, SseEvent } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import {
  activeRuns,
  allRuns,
  applyRunEvent,
  emptyRunsState,
  forgetTerminalRuns,
  isTerminalRun,
  runCardView,
  runCounts,
  runsNeedingYou,
} from '../pi-run-reducer';

// T24 — the run card's whole state table, tested as a reducer (D9). No jsdom,
// no @testing-library: the repo has zero component tests and this plan does not
// spend an innovation token adding that.

function digest(over: Partial<Extract<SseEvent, { type: 'run.update' }>> = {}): SseEvent {
  return {
    type: 'run.update',
    jobId: 'job_1',
    runner: 'pi',
    status: 'running',
    now: 'editing packages/core/src/auth/session-token.ts',
    elapsedMs: 1_000,
    spendUsd: 0.1,
    toolCount: 2,
    ...over,
  };
}

describe('applyRunEvent', () => {
  it('opens a run on its first digest', () => {
    const s = applyRunEvent(emptyRunsState, digest(), 1_000);
    expect(s.order).toEqual(['job_1']);
    expect(s.byId.job_1?.firstSeenAt).toBe(1_000);
    expect(s.byId.job_1?.now).toBe('editing packages/core/src/auth/session-token.ts');
  });

  it('replaces the now line rather than appending to it', () => {
    let s = applyRunEvent(emptyRunsState, digest(), 1_000);
    s = applyRunEvent(s, digest({ now: 'running tests' }), 2_000);
    expect(s.byId.job_1?.now).toBe('running tests');
    // First-seen is the transcript anchor's birth order; it must not move.
    expect(s.byId.job_1?.firstSeenAt).toBe(1_000);
    expect(s.byId.job_1?.updatedAt).toBe(2_000);
    expect(s.order).toEqual(['job_1']);
  });

  it('keeps runs in arrival order', () => {
    let s = applyRunEvent(emptyRunsState, digest(), 1);
    s = applyRunEvent(s, digest({ jobId: 'job_2' }), 2);
    s = applyRunEvent(s, digest({ jobId: 'job_1', spendUsd: 9 }), 3);
    expect(allRuns(s).map((r) => r.jobId)).toEqual(['job_1', 'job_2']);
    expect(s.byId.job_1?.spendUsd).toBe(9);
  });

  it('ignores every event that is not a run digest', () => {
    const s = applyRunEvent(emptyRunsState, { type: 'done', text: 'x', turnCount: 1 }, 1);
    expect(s).toBe(emptyRunsState);
  });
});

describe('selectors', () => {
  const built = (() => {
    let s = applyRunEvent(emptyRunsState, digest({ jobId: 'a', status: 'running' }), 1);
    s = applyRunEvent(s, digest({ jobId: 'b', status: 'blocked', now: '' }), 2);
    s = applyRunEvent(s, digest({ jobId: 'c', status: 'done' }), 3);
    return s;
  })();

  it('separates active from terminal', () => {
    expect(activeRuns(built).map((r) => r.jobId)).toEqual(['a', 'b']);
    expect(isTerminalRun('done')).toBe(true);
    expect(isTerminalRun('blocked')).toBe(false);
    // A lost host is not terminal — §4.1 offers Resume on a stale card.
    expect(isTerminalRun('stale')).toBe(false);
  });

  it('counts what the pill and the nav badge render', () => {
    expect(runsNeedingYou(built).map((r) => r.jobId)).toEqual(['b']);
    expect(runCounts(built)).toEqual({ running: 1, needsYou: 1, done: 1 });
  });

  it('drops terminal runs on a session change, keeping the rest', () => {
    const pruned = forgetTerminalRuns(built);
    expect(pruned.order).toEqual(['a', 'b']);
    // Same reference when nothing changed — the surfaces re-render on identity.
    expect(forgetTerminalRuns(pruned)).toBe(pruned);
  });
});

describe('runCardView — §4.1 states and transitions', () => {
  const table: Array<[BackgroundJobStatusWire, string[]]> = [
    ['queued', ['open', 'cancel']],
    ['running', ['open', 'interrupt', 'cancel', 'takeover']],
    ['blocked', ['open', 'cancel', 'takeover']],
    ['done', ['review-diff', 'open-log', 'attach']],
    ['failed', ['open-log', 'retry', 'attach']],
    ['aborted', ['open-log', 'retry', 'attach']],
    ['stale', ['open-log', 'resume', 'cancel']],
  ];

  it.each(table)('%s offers exactly its buttons', (status, buttons) => {
    expect(runCardView(status).buttons).toEqual(buttons);
  });

  it('pulses the dot only while the run is actually moving', () => {
    const pulsing = table.map(([status]) => status).filter((status) => runCardView(status).pulsing);
    expect(pulsing).toEqual(['running']);
  });

  it('gives the blocked card the warm tint and a warning border, nothing else', () => {
    const warm = table.map(([s]) => s).filter((s) => runCardView(s).warmTint);
    expect(warm).toEqual(['blocked']);
    expect(runCardView('blocked').border).toBe('warning');
  });

  it('maps every state to a chip tone and a border', () => {
    expect(
      Object.fromEntries(
        table.map(([status]) => {
          const v = runCardView(status);
          return [status, `${v.chipTone}/${v.border}`];
        }),
      ),
    ).toMatchInlineSnapshot(`
      {
        "aborted": "warning/error",
        "blocked": "warning/warning",
        "done": "success/success",
        "failed": "error/error",
        "queued": "neutral/subtle",
        "running": "info/subtle",
        "stale": "warning/warning",
      }
    `);
  });
});
