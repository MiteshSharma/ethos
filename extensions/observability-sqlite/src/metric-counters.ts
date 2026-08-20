import type Database from '@ethosagent/sqlite';

// ---------------------------------------------------------------------------
// metric_counters — monotonic running totals for Prometheus `/metrics`
// (analytics-observability plan, P2-counters / D2 / D15 / D18 / D19).
//
// Never a scrape-time SUM over `spans`/`traces`/`events`: those tables are
// prunable by retention, and a SUM would make a counter DECREASE — Prometheus
// `rate()` reads a decrease as a process restart and draws a phantom spike.
// This table only ever increments, via the upsert in `incrementCounter`, and
// it is exempt from retention pruning (`retention.ts` never references it).
//
// Increments happen inside the SAME observability.db transaction as the
// span/trace/event write that caused them (D15) — see `store.ts`'s
// `closeSpan` / `closeTrace` / `insertEvent`. Never a cross-DB transaction
// with `sessions.db`.
// ---------------------------------------------------------------------------

export const METRIC_COUNTERS_SCHEMA = `
      CREATE TABLE IF NOT EXISTS metric_counters (
        metric      TEXT NOT NULL,
        labels      TEXT NOT NULL,
        value       REAL NOT NULL DEFAULT 0,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (metric, labels)
      ) STRICT;
    `;

/**
 * Every label key any counter or histogram in this module writes. D19: no
 * per-call id (`sessionId`, `traceId`, `requestId`, `toolCallId`) may ever
 * join this list — an unbounded key blows up series cardinality forever,
 * since `metric_counters` rows are never pruned.
 */
export const ALLOWED_LABEL_KEYS = [
  'personality',
  'provider',
  'model',
  'kind',
  'tool',
  'skill',
  'mode',
  'outcome',
  'platform',
  'status',
  'adapter',
  'le',
] as const;
export type AllowedLabelKey = (typeof ALLOWED_LABEL_KEYS)[number];

export const FORBIDDEN_LABEL_KEYS = ['sessionId', 'traceId', 'requestId', 'toolCallId'] as const;

/** LLM call latency buckets (D18) — fixed, do not invent others. */
export const LLM_DURATION_BUCKETS = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64] as const;
/** Tool call latency buckets (D18) — fixed, do not invent others. */
export const TOOL_DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60] as const;

export interface MetricCounterRow {
  metric: string;
  labels: Record<string, string>;
  value: number;
}

interface MetricCounterRawRow {
  metric: string;
  labels: string;
  value: number;
}

/** Sorted-key JSON so semantically identical label sets always hit the same
 *  row — this is what keeps the table a true monotonic-totals table rather
 *  than one row per insertion order. */
export function canonicalLabels(labels: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(labels).sort()) {
    sorted[key] = labels[key] ?? '';
  }
  return JSON.stringify(sorted);
}

const UPSERT_SQL = `
  INSERT INTO metric_counters (metric, labels, value, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(metric, labels) DO UPDATE SET
    value = value + excluded.value,
    updated_at = excluded.updated_at
`;

/** Increment one counter row. MUST be called from inside the caller's
 *  `db.transaction()` — see the module doc comment. */
export function incrementCounter(
  db: Database.Database,
  metric: string,
  labels: Record<string, string>,
  amount: number,
  nowIso: string,
): void {
  db.prepare(UPSERT_SQL).run(metric, canonicalLabels(labels), amount, nowIso);
}

/**
 * One observation into a fixed-bucket histogram, modeled as ordinary counter
 * rows (D18): `<name>_bucket{...,le}` cumulative per bucket plus an implicit
 * `+Inf` bucket, `<name>_sum`, `<name>_count`. Shared by both histograms in
 * this plan so the bucket-walk logic exists exactly once.
 */
export function incrementHistogram(
  db: Database.Database,
  name: string,
  buckets: readonly number[],
  labels: Record<string, string>,
  value: number,
  nowIso: string,
): void {
  for (const bucket of buckets) {
    if (value <= bucket) {
      incrementCounter(db, `${name}_bucket`, { ...labels, le: String(bucket) }, 1, nowIso);
    }
  }
  incrementCounter(db, `${name}_bucket`, { ...labels, le: '+Inf' }, 1, nowIso);
  incrementCounter(db, `${name}_sum`, labels, value, nowIso);
  incrementCounter(db, `${name}_count`, labels, 1, nowIso);
}

/** Read every counter/histogram-bucket row, for the `/metrics` renderer. */
export function readMetricCounters(db: Database.Database): MetricCounterRow[] {
  const rows = db
    .prepare('SELECT metric, labels, value FROM metric_counters')
    .all() as MetricCounterRawRow[];
  return rows.map((r) => ({
    metric: r.metric,
    labels: JSON.parse(r.labels) as Record<string, string>,
    value: r.value,
  }));
}
