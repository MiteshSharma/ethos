import { join } from 'node:path';
import { ethosDir } from '@ethosagent/config';
import {
  type SkillUsageRow,
  SQLiteObservabilityStore,
  type ToolUsageRow,
  type TurnOutcomeCounts,
} from '@ethosagent/observability-sqlite';
import { SQLiteSessionStore, type UsageAggregateRow } from '@ethosagent/session-sqlite';

/** Dimensions `--by` accepts. `tool` and `skill` come from observability.db;
 *  the rest are grouped out of `messages` joined to `sessions`. */
const DIMENSIONS = ['day', 'model', 'personality', 'channel', 'session', 'tool', 'skill'] as const;
type Dimension = (typeof DIMENSIONS)[number];

function isDimension(v: string): v is Dimension {
  return (DIMENSIONS as readonly string[]).includes(v);
}

interface Totals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number;
  messages: number;
  /** Share of billable input served from cache, 0–1. See {@link cacheHitRate}. */
  cacheHitRate: number;
}

interface UsageResult {
  since: string;
  until: string;
  totals: Totals;
  daily: UsageAggregateRow[];
  outcomes: TurnOutcomeCounts;
  by?: { dimension: Dimension; rows: UsageAggregateRow[] | ToolUsageRow[] | SkillUsageRow[] };
}

export function parseDuration(raw: string): number {
  const m = raw.match(/^(\d+)(h|d|m)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2];
  if (unit === 'h') return n * 60 * 60 * 1000;
  if (unit === 'd') return n * 24 * 60 * 60 * 1000;
  if (unit === 'm') return n * 60 * 1000;
  return 0;
}

/**
 * Cached share of input tokens.
 *
 * Denominator is every token the model read — fresh input, cache reads, and
 * cache writes — because a cache write is input the provider still charged for.
 * Excluding it would make the first turn of a session look like a 0% hit rate
 * on a smaller base and flatter the number thereafter.
 */
export function cacheHitRate(t: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): number {
  const total = t.inputTokens + t.cacheReadTokens + t.cacheCreationTokens;
  return total === 0 ? 0 : t.cacheReadTokens / total;
}

function sumRows(rows: UsageAggregateRow[]): Omit<Totals, 'cacheHitRate'> {
  const t = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0,
    messages: 0,
  };
  for (const r of rows) {
    t.inputTokens += r.inputTokens;
    t.outputTokens += r.outputTokens;
    t.cacheReadTokens += r.cacheReadTokens;
    t.cacheCreationTokens += r.cacheCreationTokens;
    t.estimatedCostUsd += r.estimatedCostUsd;
    t.messages += r.messages;
  }
  return t;
}

const usd = (n: number): string => `$${n.toFixed(2)}`;
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

function usageHelp(): string {
  return [
    'Usage: ethos usage --since <duration> [--by <dimension>] [--json]',
    '',
    '  --since   Nh (hours), Nd (days), Nm (minutes)   e.g. 24h, 7d, 30m',
    `  --by      ${DIMENSIONS.join(' | ')}`,
    '  --json    machine-readable output',
  ].join('\n');
}

export async function runUsage(argv: string[]): Promise<void> {
  const sinceIdx = argv.indexOf('--since');
  const sinceRaw = sinceIdx !== -1 ? argv[sinceIdx + 1] : undefined;
  const byIdx = argv.indexOf('--by');
  const byRaw = byIdx !== -1 ? argv[byIdx + 1] : undefined;
  const jsonMode = argv.includes('--json');

  if (!sinceRaw) {
    console.error(usageHelp());
    process.exit(2);
  }

  const durationMs = parseDuration(sinceRaw);
  if (durationMs === 0) {
    console.error(`Invalid duration: ${sinceRaw}. Use Nh, Nd, or Nm (e.g. 24h, 7d, 30m).`);
    process.exit(2);
  }

  if (byRaw !== undefined && !isDimension(byRaw)) {
    console.error(`Unknown dimension: ${byRaw}. Use one of: ${DIMENSIONS.join(', ')}.`);
    process.exit(2);
  }
  const dimension: Dimension | undefined =
    byRaw !== undefined && isDimension(byRaw) ? byRaw : undefined;

  const until = new Date();
  const since = new Date(until.getTime() - durationMs);

  let store: SQLiteSessionStore;
  try {
    store = new SQLiteSessionStore(join(ethosDir(), 'sessions.db'));
  } catch {
    // Fresh install — no database yet. An empty result is the right answer, not
    // an error: "you have not spent anything" is true.
    const empty: UsageResult = {
      since: since.toISOString(),
      until: until.toISOString(),
      totals: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
        messages: 0,
        cacheHitRate: 0,
      },
      daily: [],
      outcomes: { completed: 0, errored: 0, halted: 0, running: 0 },
    };
    if (jsonMode) process.stdout.write(`${JSON.stringify(empty)}\n`);
    else console.log('No usage data (sessions database not found).');
    return;
  }

  // observability.db is optional: turn outcomes, tool and skill breakdowns come
  // from it, and a deployment with telemetry off simply reports zeros rather
  // than failing the whole command.
  let obs: SQLiteObservabilityStore | undefined;
  try {
    obs = new SQLiteObservabilityStore(join(ethosDir(), 'observability.db'));
  } catch {
    obs = undefined;
  }

  try {
    const daily = await store.usageAggregate({ since, until, dimension: 'day' });
    const summed = sumRows(daily);
    const totals: Totals = { ...summed, cacheHitRate: cacheHitRate(summed) };

    const outcomes = obs?.outcomeCounts(since.getTime(), until.getTime()) ?? {
      completed: 0,
      errored: 0,
      halted: 0,
      running: 0,
    };

    let by: UsageResult['by'];
    if (dimension === 'tool') {
      by = { dimension, rows: obs?.toolCounts(since.getTime(), until.getTime()) ?? [] };
    } else if (dimension === 'skill') {
      by = { dimension, rows: obs?.skillCounts(since.getTime(), until.getTime()) ?? [] };
    } else if (dimension !== undefined) {
      by = { dimension, rows: await store.usageAggregate({ since, until, dimension }) };
    }

    const result: UsageResult = {
      since: since.toISOString(),
      until: until.toISOString(),
      totals,
      daily,
      outcomes,
      ...(by ? { by } : {}),
    };

    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }

    console.log(`Usage from ${since.toISOString()} to ${until.toISOString()}\n`);
    console.log(
      `  Tokens        ${totals.inputTokens.toLocaleString()} in / ${totals.outputTokens.toLocaleString()} out`,
    );
    console.log(`  Cost          ${usd(totals.estimatedCostUsd)}`);
    console.log(
      `  Cache hits    ${pct(totals.cacheHitRate)} (${totals.cacheReadTokens.toLocaleString()} cached / ${totals.cacheCreationTokens.toLocaleString()} written)`,
    );
    console.log(
      `  Turns         ${outcomes.completed} completed, ${outcomes.errored} errored, ${outcomes.halted} halted` +
        (outcomes.running > 0 ? `, ${outcomes.running} running` : ''),
    );

    if (daily.length > 1) {
      console.log('\n  Daily spend:');
      for (const d of [...daily].sort((a, b) => a.key.localeCompare(b.key))) {
        console.log(`    ${d.key}  ${usd(d.estimatedCostUsd).padStart(9)}`);
      }
    }

    if (by) printBreakdown(by);
  } finally {
    obs?.close();
    store.close();
  }
}

function printBreakdown(by: NonNullable<UsageResult['by']>): void {
  console.log(`\n  By ${by.dimension}:`);
  if (by.rows.length === 0) {
    console.log('    (nothing recorded in this window)');
    return;
  }
  if (by.dimension === 'tool') {
    for (const r of by.rows as ToolUsageRow[]) {
      const failed = r.errors > 0 ? `, ${r.errors} failed` : '';
      console.log(`    ${r.tool}: ${r.calls} calls${failed}`);
    }
    return;
  }
  if (by.dimension === 'skill') {
    // Two columns, never summed — an exposure is paid every turn, an
    // invocation is a choice. High exposure with zero invocations is the
    // number worth acting on.
    for (const r of by.rows as SkillUsageRow[]) {
      console.log(`    ${r.skill}: ${r.invoked} invoked / ${r.exposed} exposed`);
    }
    return;
  }
  for (const r of by.rows as UsageAggregateRow[]) {
    console.log(
      `    ${r.key}: ${usd(r.estimatedCostUsd)} (${r.inputTokens.toLocaleString()} in / ${r.outputTokens.toLocaleString()} out)`,
    );
  }
}
