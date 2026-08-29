import BetterSqlite3 from '@ethosagent/sqlite';
import type { RetentionConfig } from '@ethosagent/types';

/** Parse a duration string to milliseconds, or null for 'forever'. */
export function parseDuration(s: string): number | null {
  if (s === 'forever') return null;
  const m = s.match(/^(\d+)(d|w|m|y)$/);
  if (!m) throw new Error(`Invalid duration: "${s}"`);
  const n = Number(m[1]);
  switch (m[2]) {
    case 'd':
      return n * 86_400_000;
    case 'w':
      return n * 7 * 86_400_000;
    case 'm':
      return n * 30 * 86_400_000;
    case 'y':
      return n * 365 * 86_400_000;
    default:
      throw new Error(`Unknown unit in "${s}"`);
  }
}

/** Deep-merge a sparse per-subject override on top of the global config. */
export function mergeRetentionConfig(
  global: RetentionConfig,
  override?: RetentionConfig,
): RetentionConfig {
  if (!override) return global;
  return {
    ...global,
    ...override,
    events: override.events ? { ...global.events, ...override.events } : global.events,
  };
}

/** Rollup columns on `sessions`, and their per-message counterparts. */
const USAGE_COLUMNS = [
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'estimated_cost_usd',
] as const;

/**
 * Take the usage of the messages about to be pruned back out of the session
 * rollup columns. Those columns are a derived cache of the surviving `messages`
 * rows (analytics decision 9), so the subtraction has to happen before the
 * delete and inside its transaction.
 *
 * Already soft-deleted rows were subtracted when they were undone, so they are
 * excluded — the column is absent on `sessions.db` files old enough to predate
 * undo, in which case there is nothing to double-subtract either. The floor at
 * zero protects sessions whose rollups predate the columns being maintained.
 *
 * Nothing here may assume the current schema: `ethos data prune` opens
 * `sessions.db` raw without running the store's migrations, so the `sessions`
 * table (and the usage columns on either table) can be missing entirely —
 * `table_info` then returns no rows. Pruning messages is the primary job, so a
 * rollup that cannot be maintained is skipped rather than allowed to throw.
 */
function subtractPrunedUsage(sessDb: BetterSqlite3.Database, iso: string): void {
  const columnsOf = (table: string) =>
    new Set((sessDb.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name));
  const messageCols = columnsOf('messages');
  const sessionCols = columnsOf('sessions');
  if (!USAGE_COLUMNS.every((c) => sessionCols.has(c) && messageCols.has(c))) return;

  const live = messageCols.has('deleted_at') ? 'AND deleted_at IS NULL' : '';
  const sets = USAGE_COLUMNS.map((col) => `${col} = max(sessions.${col} - pruned.${col}, 0)`).join(
    ', ',
  );
  const sums = USAGE_COLUMNS.map((col) => `COALESCE(SUM(${col}), 0) AS ${col}`).join(', ');

  sessDb
    .prepare(
      `UPDATE sessions SET ${sets}
       FROM (SELECT session_id, ${sums} FROM messages
             WHERE timestamp < ? ${live} GROUP BY session_id) AS pruned
       WHERE sessions.id = pruned.session_id`,
    )
    .run(iso);
}

export interface PruneResult {
  traces: number;
  spans: number;
  events: number;
  snapshots: number;
  messages: number;
}

/**
 * Prune rows from observability.db that have exceeded their retention TTL.
 * Returns counts of deleted rows (or would-delete counts when dryRun=true).
 */
export function pruneObservability(
  db: BetterSqlite3.Database,
  config: RetentionConfig,
  opts: {
    dryRun?: boolean;
    now?: number;
    sessDb?: BetterSqlite3.Database;
    subjectId?: string;
    /** Subject IDs to exclude from the global pass (they have per-subject passes). */
    excludeSubjectIds?: string[];
  } = {},
): PruneResult {
  const now = opts.now ?? Date.now();
  const result: PruneResult = { traces: 0, spans: 0, events: 0, snapshots: 0, messages: 0 };

  const cutoff = (dur: string | undefined, def: string) => parseDuration(dur ?? def);

  const traceCutoff = cutoff(config.traces, '90d');
  const spanCutoff = cutoff(config.spans, '90d');

  // Subjects that have their own prune pass — excluded from the global pass
  // so a stricter global TTL cannot delete rows the subject pass should retain.
  const excluded = opts.excludeSubjectIds ?? [];

  if (traceCutoff !== null) {
    const threshold = now - traceCutoff;
    if (opts.subjectId) {
      if (opts.dryRun) {
        result.traces = (
          db
            .prepare('SELECT COUNT(*) as n FROM traces WHERE subject_id = ? AND start_ts < ?')
            .get(opts.subjectId, threshold) as { n: number }
        ).n;
      } else {
        result.traces = db
          .prepare('DELETE FROM traces WHERE subject_id = ? AND start_ts < ?')
          .run(opts.subjectId, threshold).changes;
      }
    } else if (excluded.length > 0) {
      const ph = excluded.map(() => '?').join(',');
      if (opts.dryRun) {
        result.traces = (
          db
            .prepare(
              `SELECT COUNT(*) as n FROM traces WHERE start_ts < ? AND (subject_id IS NULL OR subject_id NOT IN (${ph}))`,
            )
            .get(threshold, ...excluded) as { n: number }
        ).n;
      } else {
        result.traces = db
          .prepare(
            `DELETE FROM traces WHERE start_ts < ? AND (subject_id IS NULL OR subject_id NOT IN (${ph}))`,
          )
          .run(threshold, ...excluded).changes;
      }
    } else if (opts.dryRun) {
      result.traces = (
        db.prepare('SELECT COUNT(*) as n FROM traces WHERE start_ts < ?').get(threshold) as {
          n: number;
        }
      ).n;
    } else {
      result.traces = db.prepare('DELETE FROM traces WHERE start_ts < ?').run(threshold).changes;
    }
  }

  if (spanCutoff !== null) {
    const threshold = now - spanCutoff;
    if (opts.subjectId) {
      if (opts.dryRun) {
        result.spans = (
          db
            .prepare(
              'SELECT COUNT(*) as n FROM spans WHERE trace_id IN (SELECT trace_id FROM traces WHERE subject_id = ? AND start_ts < ?)',
            )
            .get(opts.subjectId, threshold) as { n: number }
        ).n;
      } else {
        result.spans = db
          .prepare(
            'DELETE FROM spans WHERE trace_id IN (SELECT trace_id FROM traces WHERE subject_id = ? AND start_ts < ?)',
          )
          .run(opts.subjectId, threshold).changes;
      }
    } else if (excluded.length > 0) {
      const ph = excluded.map(() => '?').join(',');
      if (opts.dryRun) {
        result.spans = (
          db
            .prepare(
              `SELECT COUNT(*) as n FROM spans WHERE start_ts < ? AND trace_id NOT IN (SELECT trace_id FROM traces WHERE subject_id IN (${ph}))`,
            )
            .get(threshold, ...excluded) as { n: number }
        ).n;
      } else {
        result.spans = db
          .prepare(
            `DELETE FROM spans WHERE start_ts < ? AND trace_id NOT IN (SELECT trace_id FROM traces WHERE subject_id IN (${ph}))`,
          )
          .run(threshold, ...excluded).changes;
      }
    } else if (opts.dryRun) {
      result.spans = (
        db.prepare('SELECT COUNT(*) as n FROM spans WHERE start_ts < ?').get(threshold) as {
          n: number;
        }
      ).n;
    } else {
      result.spans = db.prepare('DELETE FROM spans WHERE start_ts < ?').run(threshold).changes;
    }
  }

  // Events: per-category cutoffs.
  //
  // The keys (`audit`, `channel`, `install`) are ethos-flavored. They live
  // here because RetentionEventsConfig in `@ethosagent/types` exposes them
  // as named fields — reshaping that into a generic pattern map is
  // explicitly out-of-scope for the extractability refactor (see
  // plan/phases/observability_extractability.md "Out of scope"). The
  // hardcoded LIKE patterns mirror the conventions documented in the
  // library README's vocabulary-contract section.
  //
  // `funnel.%` is INTENTIONALLY absent (zero-friction-first-hour W4.2):
  // funnel events are one-shot install-lifecycle data, bytes in size, and
  // `ethos doctor --funnel` must still work months later — they are exempt
  // from retention/pruning by not being enumerated here. Do not add them.
  const categories: Array<[string, string]> = [
    ['error', config.events?.error ?? '90d'],
    ['audit.%', config.events?.audit ?? '365d'],
    ['channel.%', config.events?.channel ?? '365d'],
    ['install.%', config.events?.install ?? 'forever'],
  ];

  for (const [pat, dur] of categories) {
    const ms = parseDuration(dur);
    if (ms === null) continue;
    const threshold = now - ms;
    const likeOp = pat.includes('%') ? 'LIKE' : '=';
    if (opts.subjectId) {
      if (opts.dryRun) {
        result.events += (
          db
            .prepare(
              `SELECT COUNT(*) as n FROM events WHERE category ${likeOp} ? AND ts < ? AND (trace_id IS NULL OR trace_id IN (SELECT trace_id FROM traces WHERE subject_id = ?))`,
            )
            .get(pat, threshold, opts.subjectId) as { n: number }
        ).n;
      } else {
        result.events += db
          .prepare(
            `DELETE FROM events WHERE category ${likeOp} ? AND ts < ? AND (trace_id IS NULL OR trace_id IN (SELECT trace_id FROM traces WHERE subject_id = ?))`,
          )
          .run(pat, threshold, opts.subjectId).changes;
      }
    } else if (excluded.length > 0) {
      const ph = excluded.map(() => '?').join(',');
      if (opts.dryRun) {
        result.events += (
          db
            .prepare(
              `SELECT COUNT(*) as n FROM events WHERE category ${likeOp} ? AND ts < ? AND (trace_id IS NULL OR trace_id NOT IN (SELECT trace_id FROM traces WHERE subject_id IN (${ph})))`,
            )
            .get(pat, threshold, ...excluded) as { n: number }
        ).n;
      } else {
        result.events += db
          .prepare(
            `DELETE FROM events WHERE category ${likeOp} ? AND ts < ? AND (trace_id IS NULL OR trace_id NOT IN (SELECT trace_id FROM traces WHERE subject_id IN (${ph})))`,
          )
          .run(pat, threshold, ...excluded).changes;
      }
    } else if (opts.dryRun) {
      result.events += (
        db
          .prepare(`SELECT COUNT(*) as n FROM events WHERE category ${likeOp} ? AND ts < ?`)
          .get(pat, threshold) as { n: number }
      ).n;
    } else {
      result.events += db
        .prepare(`DELETE FROM events WHERE category ${likeOp} ? AND ts < ?`)
        .run(pat, threshold).changes;
    }
  }

  // Snapshots: prune orphaned snapshots (no referenced trace) — global-only
  if (!opts.subjectId && !opts.dryRun) {
    result.snapshots = db
      .prepare(
        'DELETE FROM snapshots WHERE snapshot_id NOT IN (SELECT DISTINCT snapshot_id FROM traces WHERE snapshot_id IS NOT NULL)',
      )
      .run().changes;
  }

  // Messages (sessions.db — separate DB, passed in as sessDb).
  // Not subject-scoped: messages table has no subject_id column.
  // Only run in the global pass (not per-subject passes).
  if (opts.sessDb && !opts.subjectId) {
    const msgCutoff = cutoff(config.messages, '365d');
    if (msgCutoff !== null) {
      const threshold = now - msgCutoff;
      // messages.timestamp is an ISO-8601 TEXT column; convert threshold to ISO for comparison.
      const iso = new Date(threshold).toISOString();
      if (opts.dryRun) {
        result.messages = (
          opts.sessDb
            .prepare('SELECT COUNT(*) as n FROM messages WHERE timestamp < ?')
            .get(iso) as { n: number }
        ).n;
      } else {
        const sessDb = opts.sessDb;
        result.messages = sessDb.transaction((): number => {
          subtractPrunedUsage(sessDb, iso);
          return sessDb.prepare('DELETE FROM messages WHERE timestamp < ?').run(iso).changes;
        })();
      }
    }
  }

  return result;
}

/**
 * Convenience wrapper: open a SQLite database by path, prune it, then close.
 * Lets callers (e.g. the CLI `data prune` command) avoid importing @ethosagent/sqlite
 * directly when they only have a file path.
 */
export function pruneObservabilityByPath(
  dbPath: string,
  config: RetentionConfig,
  opts: {
    dryRun?: boolean;
    now?: number;
    sessDbPath?: string;
    subjectId?: string;
    excludeSubjectIds?: string[];
  } = {},
): PruneResult {
  const db = new BetterSqlite3(dbPath);
  let sessDb: BetterSqlite3.Database | undefined;
  if (opts.sessDbPath) {
    sessDb = new BetterSqlite3(opts.sessDbPath);
  }
  try {
    return pruneObservability(db, config, { ...opts, sessDb });
  } finally {
    sessDb?.close();
    db.close();
  }
}

/**
 * Get SQLite page statistics for a database file.
 * Returns null if the file cannot be opened.
 */
export function getSqliteStats(
  dbPath: string,
): { pageCount: number; pageSize: number; totalBytes: number } | null {
  let db: BetterSqlite3.Database | null = null;
  try {
    db = new BetterSqlite3(dbPath, { readonly: true });
    const pageCount = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
    const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
    return { pageCount, pageSize, totalBytes: pageCount * pageSize };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
