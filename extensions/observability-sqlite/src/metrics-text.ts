import type { MetricCounterRow } from './metric-counters';

// ---------------------------------------------------------------------------
// OpenMetrics text exposition (D14) — pure rendering over `metric_counters`
// rows plus the live gateway-adapter gauge. No FS/DB access here: the two
// mounts (web-api, gateway health server) each gather their own inputs and
// call this. `/metrics` content type is `text/plain; version=0.0.4`.
// ---------------------------------------------------------------------------

/** Fixed family list (D2) — a row for a metric outside this roster is
 *  dropped rather than guessed at, matching D18's "no invented families". */
const COUNTER_FAMILIES = [
  'ethos_llm_tokens_total',
  'ethos_llm_cost_usd_total',
  'ethos_llm_unpriced_calls_total',
  'ethos_tool_calls_total',
  'ethos_skill_invocations_total',
  'ethos_turn_outcomes_total',
] as const;

/** Histogram base names (D18) — bucket rows are named `<base>_bucket`, plus
 *  `<base>_sum` / `<base>_count`, all stored as ordinary counter rows. */
const HISTOGRAM_FAMILIES = [
  'ethos_llm_request_duration_seconds',
  'ethos_tool_duration_seconds',
] as const;

export interface GatewayAdapterStatus {
  adapter: string;
  up: 0 | 1;
}

/** Escape a label value per the OpenMetrics text format: backslash, quote,
 *  then newline, in that order — reversing the order would double-escape a
 *  backslash introduced by the quote/newline passes. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const pairs = keys.map((k) => `${k}="${escapeLabelValue(labels[k] ?? '')}"`);
  return `{${pairs.join(',')}}`;
}

function formatLine(metric: string, labels: Record<string, string>, value: number): string {
  return `${metric}${formatLabels(labels)} ${value}`;
}

/** Stable row order within a family: by canonical label JSON, so the same
 *  input always renders byte-identical text (scrape diffing, test fixtures). */
function sortRows(rows: MetricCounterRow[]): MetricCounterRow[] {
  return [...rows].sort((a, b) => JSON.stringify(a.labels).localeCompare(JSON.stringify(b.labels)));
}

export function renderMetricsText(
  counters: MetricCounterRow[],
  gatewayAdapters: GatewayAdapterStatus[],
): string {
  const byMetric = new Map<string, MetricCounterRow[]>();
  for (const row of counters) {
    const bucket = byMetric.get(row.metric);
    if (bucket) bucket.push(row);
    else byMetric.set(row.metric, [row]);
  }

  const lines: string[] = [];

  for (const name of COUNTER_FAMILIES) {
    const rows = byMetric.get(name);
    if (!rows || rows.length === 0) continue;
    lines.push(`# TYPE ${name} counter`);
    for (const row of sortRows(rows)) {
      lines.push(formatLine(name, row.labels, row.value));
    }
  }

  for (const base of HISTOGRAM_FAMILIES) {
    const bucketRows = byMetric.get(`${base}_bucket`) ?? [];
    const sumRows = byMetric.get(`${base}_sum`) ?? [];
    const countRows = byMetric.get(`${base}_count`) ?? [];
    if (bucketRows.length === 0 && sumRows.length === 0 && countRows.length === 0) continue;
    lines.push(`# TYPE ${base} histogram`);
    for (const row of sortRows(bucketRows))
      lines.push(formatLine(`${base}_bucket`, row.labels, row.value));
    for (const row of sortRows(sumRows))
      lines.push(formatLine(`${base}_sum`, row.labels, row.value));
    for (const row of sortRows(countRows))
      lines.push(formatLine(`${base}_count`, row.labels, row.value));
  }

  if (gatewayAdapters.length > 0) {
    lines.push('# TYPE ethos_gateway_adapter_up gauge');
    for (const { adapter, up } of [...gatewayAdapters].sort((a, b) =>
      a.adapter.localeCompare(b.adapter),
    )) {
      lines.push(formatLine('ethos_gateway_adapter_up', { adapter }, up));
    }
  }

  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/** Structural — both mounts pass their own `SQLiteObservabilityStore`
 *  instance without this module depending on the concrete class. */
export interface MetricsTextSource {
  getMetricCounters(): MetricCounterRow[];
}

export interface CreateMetricsTextProviderOptions {
  store: MetricsTextSource;
  /** Live gateway-adapter gauge data. The 30s staleness gate (same window
   *  `/healthz` uses) lives in the caller, since each mount already has its
   *  own way to read `gateway-health.json` (web-api: `Storage`; the gateway
   *  health server: direct fs). */
  getGatewayAdapters: () => GatewayAdapterStatus[] | Promise<GatewayAdapterStatus[]>;
  /** Default 5s (decision 6 / D2) — a scrape burst must not re-read the DB
   *  on every hit. */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 5_000;

/**
 * One rendering pipeline, reused at both `/metrics` mounts (D16): web-api and
 * the gateway health server each construct their own instance over their own
 * store connection + gateway-health source, so the byte-for-byte text both
 * serve comes from the exact same code path.
 */
export function createMetricsTextProvider(
  opts: CreateMetricsTextProviderOptions,
): () => Promise<string> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  let cached: { text: string; expiresAt: number } | undefined;
  return async () => {
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.text;
    const counters = opts.store.getMetricCounters();
    const gatewayAdapters = await opts.getGatewayAdapters();
    const text = renderMetricsText(counters, gatewayAdapters);
    cached = { text, expiresAt: now + ttlMs };
    return text;
  };
}
