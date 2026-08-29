import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteObservabilityStore } from '../store';

// AN-D1 / AN-C2 — the aggregates `ethos usage` reads. Windows are half-open
// [since, until) so adjacent windows neither overlap nor gap.

const T0 = 1_700_000_000_000;

describe('observability usage aggregates', () => {
  let store: SQLiteObservabilityStore;

  beforeEach(() => {
    store = new SQLiteObservabilityStore(':memory:');
  });
  afterEach(() => {
    store.close();
  });

  function turn(status: 'ok' | 'error' | 'aborted' | null, ts = T0): void {
    const traceId = randomUUID();
    store.insertTrace({ traceId, kind: 'turn', startTs: ts, sessionId: 's1' } as never);
    if (status) store.closeTrace(traceId, status);
  }

  describe('outcomeCounts', () => {
    it('maps trace status onto the reported taxonomy', () => {
      turn('ok');
      turn('ok');
      turn('error');
      turn('aborted');
      expect(store.outcomeCounts(T0 - 1, T0 + 1)).toEqual({
        completed: 2,
        errored: 1,
        halted: 1,
        running: 0,
      });
    });

    it('counts an unfinished turn as running, not completed', () => {
      // "In flight" and "finished cleanly" are different answers to "did my
      // agent work last night" — folding one into the other would lie.
      turn(null);
      expect(store.outcomeCounts(T0 - 1, T0 + 1)).toMatchObject({ completed: 0, running: 1 });
    });

    it('excludes turns outside the half-open window', () => {
      turn('ok', T0);
      turn('ok', T0 + 100);
      // [T0, T0+100) contains the first only.
      expect(store.outcomeCounts(T0, T0 + 100).completed).toBe(1);
    });
  });

  describe('toolCounts', () => {
    it('counts calls and failures per tool', () => {
      const traceId = randomUUID();
      store.insertTrace({ traceId, kind: 'turn', startTs: T0 } as never);
      for (const [name, status] of [
        ['read_file', 'ok'],
        ['read_file', 'ok'],
        ['bash', 'error'],
      ] as const) {
        const spanId = randomUUID();
        store.insertSpan({ spanId, traceId, kind: 'tool_call', name, startTs: T0 } as never);
        store.closeSpan(spanId, status);
      }
      const rows = store.toolCounts(T0 - 1, T0 + 1);
      expect(rows).toEqual([
        { tool: 'read_file', calls: 2, errors: 0 },
        { tool: 'bash', calls: 1, errors: 1 },
      ]);
    });
  });

  describe('skillCounts', () => {
    function skillEvent(category: 'skill.invoked' | 'skill.exposed', skill: string): void {
      store.insertEvent({
        eventId: randomUUID(),
        ts: T0,
        category,
        severity: 'info',
        details: { skill },
      } as never);
    }

    it('reports invocations and exposures as separate columns', () => {
      skillEvent('skill.exposed', 'deploy');
      skillEvent('skill.exposed', 'deploy');
      skillEvent('skill.invoked', 'deploy');
      skillEvent('skill.exposed', 'review');

      const rows = store.skillCounts(T0 - 1, T0 + 1);
      // Never summed: `review` is pure overhead — exposed every turn, never
      // used — and a combined total would hide exactly that.
      expect(rows).toEqual([
        { skill: 'deploy', invoked: 1, exposed: 2 },
        { skill: 'review', invoked: 0, exposed: 1 },
      ]);
    });

    it('ignores events with no skill name', () => {
      store.insertEvent({
        eventId: randomUUID(),
        ts: T0,
        category: 'skill.exposed',
        severity: 'info',
        details: {},
      } as never);
      expect(store.skillCounts(T0 - 1, T0 + 1)).toEqual([]);
    });
  });
});
