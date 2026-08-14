import Database, { migrate } from '@ethosagent/sqlite';
import type { ObsEvent, ObservabilityStore, Snapshot, Span, Trace } from '@ethosagent/types';
import { redactJson, redactString } from './redact';

// v1 baseline schema — the current table/index shape, unchanged. Passed to
// migrate() as the idempotent `CREATE ... IF NOT EXISTS` baseline.
const OBS_SCHEMA = `
      CREATE TABLE IF NOT EXISTS traces (
        trace_id        TEXT PRIMARY KEY,
        session_id      TEXT,
        kind            TEXT NOT NULL,
        start_ts        INTEGER NOT NULL,
        end_ts          INTEGER,
        status          TEXT,
        subject_id      TEXT,
        snapshot_id     TEXT,
        attrs           TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id, start_ts);
      CREATE INDEX IF NOT EXISTS idx_traces_kind    ON traces(kind, start_ts);

      CREATE TABLE IF NOT EXISTS spans (
        span_id         TEXT PRIMARY KEY,
        trace_id        TEXT NOT NULL,
        parent_span_id  TEXT,
        kind            TEXT NOT NULL,
        name            TEXT NOT NULL,
        start_ts        INTEGER NOT NULL,
        end_ts          INTEGER,
        status          TEXT,
        attrs           TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id, start_ts);
      CREATE INDEX IF NOT EXISTS idx_spans_name  ON spans(name, start_ts);

      CREATE TABLE IF NOT EXISTS events (
        event_id        TEXT PRIMARY KEY,
        trace_id        TEXT,
        span_id         TEXT,
        ts              INTEGER NOT NULL,
        category        TEXT NOT NULL,
        severity        TEXT NOT NULL,
        code            TEXT,
        cause           TEXT,
        details         TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_events_trace    ON events(trace_id, ts);
      CREATE INDEX IF NOT EXISTS idx_events_category ON events(category, ts);
      CREATE INDEX IF NOT EXISTS idx_events_severity ON events(severity, ts);

      CREATE TABLE IF NOT EXISTS snapshots (
        snapshot_id     TEXT PRIMARY KEY,
        taken_at        INTEGER NOT NULL,
        subject_id      TEXT NOT NULL,
        body            TEXT NOT NULL
      ) STRICT;
    `;

// ---------------------------------------------------------------------------
// SQLiteObservabilityStore
// Implements ObservabilityStore using @ethosagent/sqlite (synchronous).
// STRICT tables throughout. All methods are synchronous inside.
// ---------------------------------------------------------------------------

export class SQLiteObservabilityStore implements ObservabilityStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  // ---------------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------------

  private migrate(): void {
    // Rename pre-existing legacy columns BEFORE any new-schema operation so
    // that indexes / future schema additions referencing `subject_id` always
    // see the renamed column.
    this.renameLegacySubjectColumns();

    // Existing production DBs are at user_version=0: migrate() runs the baseline
    // (all `IF NOT EXISTS`, a no-op on existing tables) then stamps 0→1. No data
    // touched. The legacy column rename above still runs first, exactly as before.
    migrate(this.db, {
      name: 'observability-sqlite',
      targetVersion: 1,
      baseline: OBS_SCHEMA,
      migrations: {},
    });
  }

  // Idempotent rename for databases created before the personality_id →
  // subject_id rename. Skipped when the new schema is already in place.
  private renameLegacySubjectColumns(): void {
    for (const table of ['traces', 'snapshots'] as const) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
      }>;
      const names = new Set(columns.map((c) => c.name));
      if (names.has('personality_id') && !names.has('subject_id')) {
        this.db.exec(`ALTER TABLE ${table} RENAME COLUMN personality_id TO subject_id`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Traces
  // ---------------------------------------------------------------------------

  insertTrace(trace: Trace): void {
    const attrsJson = trace.attrs ? JSON.stringify(redactJson(trace.attrs)) : null;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO traces
         (trace_id, session_id, kind, start_ts, end_ts, status, subject_id, snapshot_id, attrs)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        trace.traceId,
        trace.sessionId ?? null,
        trace.kind,
        trace.startTs,
        trace.endTs ?? null,
        trace.status ?? null,
        trace.subjectId ?? null,
        trace.snapshotId ?? null,
        attrsJson,
      );
  }

  closeTrace(traceId: string, status: 'ok' | 'error' | 'aborted'): void {
    this.db
      .prepare(`UPDATE traces SET end_ts = ?, status = ? WHERE trace_id = ?`)
      .run(Date.now(), status, traceId);
  }

  getTrace(traceId: string): Trace | null {
    const row = this.db.prepare('SELECT * FROM traces WHERE trace_id = ?').get(traceId);
    return row ? rowToTrace(row as TraceRow) : null;
  }

  getRecentTraces(limit: number): Trace[] {
    const rows = this.db.prepare('SELECT * FROM traces ORDER BY start_ts DESC LIMIT ?').all(limit);
    return (rows as TraceRow[]).map(rowToTrace);
  }

  // ---------------------------------------------------------------------------
  // Spans
  // ---------------------------------------------------------------------------

  insertSpan(span: Span, extraRedactPatterns?: string[]): void {
    const attrsJson = span.attrs
      ? JSON.stringify(redactJson(span.attrs, extraRedactPatterns))
      : null;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO spans
         (span_id, trace_id, parent_span_id, kind, name, start_ts, end_ts, status, attrs)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        span.spanId,
        span.traceId,
        span.parentSpanId ?? null,
        span.kind,
        span.name,
        span.startTs,
        span.endTs ?? null,
        span.status ?? null,
        attrsJson,
      );
  }

  closeSpan(
    spanId: string,
    status: 'ok' | 'error' | 'blocked',
    attrs?: Record<string, unknown>,
    extraRedactPatterns?: string[],
  ): void {
    // Phase 0 — merge close-time attrs (e.g. per-slice llm_call token counts)
    // into whatever the span was opened with. Without this the numbers a span
    // learns only at completion (usage, requestTokens) would be lost.
    if (attrs && Object.keys(attrs).length > 0) {
      const existingRow = this.db
        .prepare('SELECT attrs FROM spans WHERE span_id = ?')
        .get(spanId) as { attrs: string | null } | undefined;
      const existing = existingRow?.attrs
        ? (JSON.parse(existingRow.attrs) as Record<string, unknown>)
        : {};
      const merged = { ...existing, ...redactJson(attrs, extraRedactPatterns) };
      this.db
        .prepare(`UPDATE spans SET end_ts = ?, status = ?, attrs = ? WHERE span_id = ?`)
        .run(Date.now(), status, JSON.stringify(merged), spanId);
      return;
    }
    this.db
      .prepare(`UPDATE spans SET end_ts = ?, status = ? WHERE span_id = ?`)
      .run(Date.now(), status, spanId);
  }

  getSpans(traceId: string): Span[] {
    const rows = this.db
      .prepare('SELECT * FROM spans WHERE trace_id = ? ORDER BY start_ts ASC')
      .all(traceId);
    return (rows as SpanRow[]).map(rowToSpan);
  }

  /**
   * Phase 0 — all `llm_call` spans for a session, oldest first. Joins spans to
   * their trace so callers reach spans by `session_id` (spans carry only a
   * `trace_id`). Backs the per-session context anatomy view.
   */
  getLlmCallSpansForSession(sessionId: string): Span[] {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM spans s
         JOIN traces t ON t.trace_id = s.trace_id
         WHERE t.session_id = ? AND s.kind = 'llm_call'
         ORDER BY s.start_ts ASC`,
      )
      .all(sessionId);
    return (rows as SpanRow[]).map(rowToSpan);
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  insertEvent(event: ObsEvent, extraRedactPatterns?: string[]): void {
    const detailsJson = event.details
      ? JSON.stringify(redactJson(event.details, extraRedactPatterns))
      : null;
    const cause = event.cause ? redactString(event.cause, extraRedactPatterns) : null;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO events
         (event_id, trace_id, span_id, ts, category, severity, code, cause, details)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        event.eventId,
        event.traceId ?? null,
        event.spanId ?? null,
        event.ts,
        event.category,
        event.severity,
        event.code ?? null,
        cause,
        detailsJson,
      );
  }

  getEvents(filter: {
    traceId?: string;
    category?: string;
    since?: number;
    limit?: number;
  }): ObsEvent[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filter.traceId !== undefined) {
      conditions.push('trace_id = ?');
      values.push(filter.traceId);
    }
    if (filter.category !== undefined) {
      conditions.push('category = ?');
      values.push(filter.category);
    }
    if (filter.since !== undefined) {
      conditions.push('ts >= ?');
      values.push(filter.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const lim = filter.limit ?? 100;
    const rows = this.db
      .prepare(`SELECT * FROM events ${where} ORDER BY ts DESC LIMIT ?`)
      .all(...values, lim);
    return (rows as EventRow[]).map(rowToEvent);
  }

  // ---------------------------------------------------------------------------
  // Snapshots
  // ---------------------------------------------------------------------------

  insertSnapshot(snapshot: Snapshot): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO snapshots (snapshot_id, taken_at, subject_id, body)
         VALUES (?,?,?,?)`,
      )
      .run(snapshot.snapshotId, snapshot.takenAt, snapshot.subjectId, snapshot.body);
  }

  getSnapshot(snapshotId: string): Snapshot | null {
    const row = this.db.prepare('SELECT * FROM snapshots WHERE snapshot_id = ?').get(snapshotId);
    return row ? rowToSnapshot(row as SnapshotRow) : null;
  }

  getSnapshotsByIds(ids: string[]): Snapshot[] {
    if (ids.length === 0) return [];
    const ph = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM snapshots WHERE snapshot_id IN (${ph})`)
      .all(...ids);
    return (rows as SnapshotRow[]).map(rowToSnapshot);
  }

  // ---------------------------------------------------------------------------
  // Bulk queries (Wave C — support bundle + archive)
  // ---------------------------------------------------------------------------

  /** Flexible trace query for time-range and session filtering. */
  getTraces(filter: {
    since?: number;
    until?: number;
    sessionId?: string;
    limit?: number;
  }): Trace[] {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filter.since !== undefined) {
      conditions.push('start_ts >= ?');
      values.push(filter.since);
    }
    if (filter.until !== undefined) {
      conditions.push('start_ts < ?');
      values.push(filter.until);
    }
    if (filter.sessionId !== undefined) {
      conditions.push('session_id = ?');
      values.push(filter.sessionId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const lim = filter.limit ?? 1000;
    const rows = this.db
      .prepare(`SELECT * FROM traces ${where} ORDER BY start_ts ASC LIMIT ?`)
      .all(...values, lim);
    return (rows as TraceRow[]).map(rowToTrace);
  }

  /** Fetch all spans belonging to a set of trace IDs. */
  getSpansByTraceIds(traceIds: string[]): Span[] {
    if (traceIds.length === 0) return [];
    const ph = traceIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM spans WHERE trace_id IN (${ph}) ORDER BY start_ts ASC`)
      .all(...traceIds);
    return (rows as SpanRow[]).map(rowToSpan);
  }

  /** Fetch all events belonging to a set of trace IDs. */
  getEventsByTraceIds(traceIds: string[]): ObsEvent[] {
    if (traceIds.length === 0) return [];
    const ph = traceIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE trace_id IN (${ph}) ORDER BY ts ASC`)
      .all(...traceIds);
    return (rows as EventRow[]).map(rowToEvent);
  }

  // ---------------------------------------------------------------------------
  // Aggregates (AN-D1) — `ethos usage` reads these instead of pulling rows
  // into the CLI and reducing there. Each is one indexed pass; the window is
  // half-open [since, until) so adjacent windows neither overlap nor gap.
  // ---------------------------------------------------------------------------

  /**
   * Turn outcomes, in the taxonomy `ethos usage` reports.
   *
   * `traces.status` is the authority: `ok` completed, `error` errored,
   * `aborted` halted (a budget or watcher stop). A trace with a NULL status is
   * still open — counted as `running` rather than silently folded into
   * `completed`, because "in flight" and "finished cleanly" are different
   * answers to "did my agent work last night".
   */
  outcomeCounts(since: number, until: number): TurnOutcomeCounts {
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM traces
          WHERE kind = 'turn' AND start_ts >= ? AND start_ts < ?
          GROUP BY status`,
      )
      .all(since, until) as Array<{ status: string | null; n: number }>;
    const out: TurnOutcomeCounts = { completed: 0, errored: 0, halted: 0, running: 0 };
    for (const r of rows) {
      if (r.status === 'ok') out.completed += r.n;
      else if (r.status === 'error') out.errored += r.n;
      else if (r.status === 'aborted') out.halted += r.n;
      else out.running += r.n;
    }
    return out;
  }

  /** Per-tool call counts and failures, from `tool_call` spans. */
  toolCounts(since: number, until: number): ToolUsageRow[] {
    return this.db
      .prepare(
        `SELECT name AS tool,
                COUNT(*) AS calls,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
           FROM spans
          WHERE kind = 'tool_call' AND start_ts >= ? AND start_ts < ?
          GROUP BY name
          ORDER BY calls DESC`,
      )
      .all(since, until) as ToolUsageRow[];
  }

  /**
   * Per-skill invocations and exposures (AN-C1/AN-C2).
   *
   * Two columns, never summed: an exposure is a token bill paid every turn
   * whether the skill was used or not, an invocation is a deliberate
   * `get_skill` call. A skill with high exposure and zero invocations is the
   * signal worth acting on, and a combined total would hide it.
   */
  skillCounts(since: number, until: number): SkillUsageRow[] {
    return this.db
      .prepare(
        `SELECT json_extract(details, '$.skill') AS skill,
                SUM(CASE WHEN category = 'skill.invoked' THEN 1 ELSE 0 END) AS invoked,
                SUM(CASE WHEN category = 'skill.exposed' THEN 1 ELSE 0 END) AS exposed
           FROM events
          WHERE category IN ('skill.invoked', 'skill.exposed')
            AND ts >= ? AND ts < ?
            AND json_extract(details, '$.skill') IS NOT NULL
          GROUP BY skill
          ORDER BY exposed DESC, invoked DESC`,
      )
      .all(since, until) as SkillUsageRow[];
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  close(): void {
    this.db.close();
  }
}

/** Turn outcomes over a window. See {@link SQLiteObservabilityStore.outcomeCounts}. */
export interface TurnOutcomeCounts {
  completed: number;
  errored: number;
  halted: number;
  running: number;
}

export interface ToolUsageRow {
  tool: string;
  calls: number;
  errors: number;
}

export interface SkillUsageRow {
  skill: string;
  invoked: number;
  exposed: number;
}

// ---------------------------------------------------------------------------
// Row types & mappers
// ---------------------------------------------------------------------------

interface TraceRow {
  trace_id: string;
  session_id: string | null;
  kind: string;
  start_ts: number;
  end_ts: number | null;
  status: string | null;
  subject_id: string | null;
  snapshot_id: string | null;
  attrs: string | null;
}

interface SpanRow {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  kind: string;
  name: string;
  start_ts: number;
  end_ts: number | null;
  status: string | null;
  attrs: string | null;
}

interface EventRow {
  event_id: string;
  trace_id: string | null;
  span_id: string | null;
  ts: number;
  category: string;
  severity: string;
  code: string | null;
  cause: string | null;
  details: string | null;
}

function rowToTrace(r: TraceRow): Trace {
  return {
    traceId: r.trace_id,
    sessionId: r.session_id ?? undefined,
    kind: r.kind as Trace['kind'],
    startTs: r.start_ts,
    endTs: r.end_ts ?? undefined,
    status: (r.status as Trace['status']) ?? undefined,
    subjectId: r.subject_id ?? undefined,
    snapshotId: r.snapshot_id ?? undefined,
    attrs: r.attrs ? (JSON.parse(r.attrs) as Record<string, unknown>) : undefined,
  };
}

function rowToSpan(r: SpanRow): Span {
  return {
    spanId: r.span_id,
    traceId: r.trace_id,
    parentSpanId: r.parent_span_id ?? undefined,
    kind: r.kind as Span['kind'],
    name: r.name,
    startTs: r.start_ts,
    endTs: r.end_ts ?? undefined,
    status: (r.status as Span['status']) ?? undefined,
    attrs: r.attrs ? (JSON.parse(r.attrs) as Record<string, unknown>) : undefined,
  };
}

function rowToEvent(r: EventRow): ObsEvent {
  return {
    eventId: r.event_id,
    traceId: r.trace_id ?? undefined,
    spanId: r.span_id ?? undefined,
    ts: r.ts,
    category: r.category as ObsEvent['category'],
    severity: r.severity as ObsEvent['severity'],
    code: r.code ?? undefined,
    cause: r.cause ?? undefined,
    details: r.details ? (JSON.parse(r.details) as Record<string, unknown>) : undefined,
  };
}

interface SnapshotRow {
  snapshot_id: string;
  taken_at: number;
  subject_id: string;
  body: string;
}

function rowToSnapshot(r: SnapshotRow): Snapshot {
  return {
    snapshotId: r.snapshot_id,
    takenAt: r.taken_at,
    subjectId: r.subject_id,
    body: r.body,
  };
}
