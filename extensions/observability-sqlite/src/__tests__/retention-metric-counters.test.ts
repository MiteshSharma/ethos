// P2-counters — decision 11 / D15: `metric_counters` is a pre-aggregated
// monotonic-totals table, exempt from retention pruning. Pruning the spans
// and traces that CAUSED an increment must never make the counter go
// backwards — that is what a Prometheus `rate()` reads as a process restart.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RETENTION_DEFAULTS } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneObservabilityByPath } from '../retention';
import { SQLiteObservabilityStore } from '../store';

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obs-retention-metrics-'));
  dbPath = join(tmp, 'observability.db');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const NOW = 1_000_000_000_000;
const OLD = NOW - 200 * 86_400_000; // 200 days ago — past every default TTL

describe('retention prune vs. metric_counters', () => {
  it('a prune cycle leaves metric_counters rows and values unchanged', () => {
    const store = new SQLiteObservabilityStore(dbPath);
    const traceId = randomUUID();
    store.insertTrace({
      traceId,
      kind: 'turn',
      startTs: OLD,
      subjectId: 'engineer',
      attrs: { platform: 'cli' },
    });
    const spanId = randomUUID();
    store.insertSpan({ spanId, traceId, kind: 'llm_call', name: 'claude-sonnet-5', startTs: OLD });
    store.closeSpan(spanId, 'ok', {
      inputTokens: 10,
      outputTokens: 5,
      estimatedCostUsd: 0.001,
      provider: 'anthropic',
      costBasis: 'priced',
    });
    store.closeTrace(traceId, 'ok');

    const before = store.getMetricCounters();
    expect(before.length).toBeGreaterThan(0);
    store.close();

    // Old enough that the default 90d trace/span TTL prunes both rows.
    const result = pruneObservabilityByPath(dbPath, RETENTION_DEFAULTS, {
      now: NOW,
      dryRun: false,
    });
    expect(result.traces).toBe(1);
    expect(result.spans).toBe(1);

    const reopened = new SQLiteObservabilityStore(dbPath);
    const after = reopened.getMetricCounters();
    expect(after).toEqual(before);

    // The span/trace that caused the increments is genuinely gone — this
    // proves the counters are pre-aggregated, not a live SUM that happened
    // to still find rows.
    expect(reopened.getTrace(traceId)).toBeNull();
    reopened.close();
  });

  it('a second prune cycle over already-pruned data still leaves counters monotonic', () => {
    const store = new SQLiteObservabilityStore(dbPath);
    const traceId = randomUUID();
    store.insertTrace({ traceId, kind: 'turn', startTs: OLD, attrs: { platform: 'cli' } });
    store.closeTrace(traceId, 'ok');
    const before = store.getMetricCounters();
    store.close();

    pruneObservabilityByPath(dbPath, RETENTION_DEFAULTS, { now: NOW, dryRun: false });
    pruneObservabilityByPath(dbPath, RETENTION_DEFAULTS, { now: NOW, dryRun: false });

    const reopened = new SQLiteObservabilityStore(dbPath);
    const after = reopened.getMetricCounters();
    expect(after).toEqual(before);
    reopened.close();
  });
});
