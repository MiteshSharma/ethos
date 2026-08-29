import Database, { migrate } from '@ethosagent/sqlite';
import type { ObsEvent, ObservabilityStore, Snapshot, Span, Trace } from '@ethosagent/types';
import {
  incrementCounter,
  incrementHistogram,
  LLM_DURATION_BUCKETS,
  METRIC_COUNTERS_SCHEMA,
  type MetricCounterRow,
  readMetricCounters,
  TOOL_DURATION_BUCKETS,
} from './metric-counters';
import { redactJson, redactString } from './redact';

// v3 baseline schema — the current table/index shape. Passed to migrate() as
// the idempotent `CREATE ... IF NOT EXISTS` baseline, so a fresh DB gets
// `metric_counters` (P2-counters, D2/D15) and the `traces.exported_at` /
// `claimed_at` claim columns (P2-langfuse, D7) without walking the migration
// chain. `MIGRATIONS[2]`/`MIGRATIONS[3]` below bring an existing older DB the
// rest of the way — SQLite has no `ADD COLUMN IF NOT EXISTS`, so the baseline
// alone cannot upgrade a DB that already has a `traces` table without them.
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
        attrs           TEXT,
        -- P2-langfuse (D7) — nullable, ms-epoch. exported_at is set once
        -- the trace has shipped to Langfuse; claimed_at marks it
        -- in-flight for a poller so two pollers (or two ticks) never export
        -- the same trace twice. Both NULL for every trace outside that
        -- pipeline (untouched by the export poller).
        exported_at     INTEGER,
        claimed_at      INTEGER
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

      ${METRIC_COUNTERS_SCHEMA}
    `;

const MIGRATIONS = {
  // v1 -> v2: `metric_counters` (P2-counters). `IF NOT EXISTS` in the
  // baseline above already creates it for a v1 DB (baseline runs
  // unconditionally, before this step), so this is a documentation-and-
  // version-bump step, not load-bearing DDL.
  2: (db: Database.Database): void => {
    db.exec(METRIC_COUNTERS_SCHEMA);
  },
  // v2 -> v3: `traces.exported_at` / `claimed_at` (P2-langfuse, D7). Unlike
  // `metric_counters` above, an existing v2 `traces` table already exists
  // and `CREATE TABLE IF NOT EXISTS` in the baseline is therefore a no-op on
  // it — the two columns must be added explicitly here, or a v2 DB would
  // never get them.
  3: (db: Database.Database): void => {
    db.exec('ALTER TABLE traces ADD COLUMN exported_at INTEGER');
    db.exec('ALTER TABLE traces ADD COLUMN claimed_at INTEGER');
  },
};

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
    this.db.pragma('busy_timeout = 5000');
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
      targetVersion: 3,
      baseline: OBS_SCHEMA,
      migrations: MIGRATIONS,
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
    const now = Date.now();
    this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT kind, subject_id, attrs, end_ts FROM traces WHERE trace_id = ?')
        .get(traceId) as
        | { kind: string; subject_id: string | null; attrs: string | null; end_ts: number | null }
        | undefined;
      this.db
        .prepare(`UPDATE traces SET end_ts = ?, status = ? WHERE trace_id = ?`)
        .run(now, status, traceId);
      // Only the transition into "closed" counts — a repeat close() must not
      // double-increment the monotonic total.
      if (!row || row.end_ts !== null || row.kind !== 'turn') return;
      const attrs = row.attrs ? (JSON.parse(row.attrs) as Record<string, unknown>) : {};
      const platform = typeof attrs.platform === 'string' ? attrs.platform : 'unknown';
      incrementCounter(
        this.db,
        'ethos_turn_outcomes_total',
        { personality: row.subject_id ?? 'unknown', platform, status },
        1,
        new Date(now).toISOString(),
      );
    })();
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
    const now = Date.now();
    this.db.transaction(() => {
      const existingRow = this.db
        .prepare(
          'SELECT trace_id, kind, name, start_ts, end_ts, attrs FROM spans WHERE span_id = ?',
        )
        .get(spanId) as
        | {
            trace_id: string;
            kind: string;
            name: string;
            start_ts: number;
            end_ts: number | null;
            attrs: string | null;
          }
        | undefined;
      const existing = existingRow?.attrs
        ? (JSON.parse(existingRow.attrs) as Record<string, unknown>)
        : {};

      // Phase 0 — merge close-time attrs (e.g. per-slice llm_call token
      // counts) into whatever the span was opened with. Without this the
      // numbers a span learns only at completion (usage, requestTokens)
      // would be lost.
      let merged = existing;
      if (attrs && Object.keys(attrs).length > 0) {
        merged = { ...existing, ...redactJson(attrs, extraRedactPatterns) };
        this.db
          .prepare(`UPDATE spans SET end_ts = ?, status = ?, attrs = ? WHERE span_id = ?`)
          .run(now, status, JSON.stringify(merged), spanId);
      } else {
        this.db
          .prepare(`UPDATE spans SET end_ts = ?, status = ? WHERE span_id = ?`)
          .run(now, status, spanId);
      }

      // Only the transition into "closed" counts — a repeat close() must not
      // double-increment the monotonic total. An unknown span (e.g. a
      // suppressed-write no-op spanId) has nothing to count either.
      if (!existingRow || existingRow.end_ts !== null) return;
      this.recordSpanCloseCounters(existingRow, status, merged, now);
    })();
  }

  /** Counter/histogram side effects of a FIRST-TIME span close (P2-counters,
   *  D2/D15/D18/D19). Called from inside `closeSpan`'s transaction only. */
  private recordSpanCloseCounters(
    span: { trace_id: string; kind: string; name: string; start_ts: number },
    status: 'ok' | 'error' | 'blocked',
    attrs: Record<string, unknown>,
    nowMs: number,
  ): void {
    const nowIso = new Date(nowMs).toISOString();
    const durationSeconds = Math.max(nowMs - span.start_ts, 0) / 1000;

    if (span.kind === 'llm_call') {
      const traceRow = this.db
        .prepare('SELECT subject_id FROM traces WHERE trace_id = ?')
        .get(span.trace_id) as { subject_id: string | null } | undefined;
      const personality = traceRow?.subject_id ?? 'unknown';
      const provider = typeof attrs.provider === 'string' ? attrs.provider : 'unknown';
      const model = span.name;

      const tokenKinds: Array<[string, unknown]> = [
        ['input', attrs.inputTokens],
        ['output', attrs.outputTokens],
        ['cache_read', attrs.cacheReadTokens],
        ['cache_creation', attrs.cacheCreationTokens],
      ];
      for (const [kind, raw] of tokenKinds) {
        const count = typeof raw === 'number' ? raw : 0;
        if (count > 0) {
          incrementCounter(
            this.db,
            'ethos_llm_tokens_total',
            { personality, provider, model, kind },
            count,
            nowIso,
          );
        }
      }

      const cost = typeof attrs.estimatedCostUsd === 'number' ? attrs.estimatedCostUsd : 0;
      incrementCounter(
        this.db,
        'ethos_llm_cost_usd_total',
        { personality, provider, model },
        cost,
        nowIso,
      );

      if (attrs.costBasis === 'unknown') {
        incrementCounter(this.db, 'ethos_llm_unpriced_calls_total', { provider, model }, 1, nowIso);
      }

      // D19 — histograms drop `personality` so bucket-row count does not
      // multiply by personality count.
      incrementHistogram(
        this.db,
        'ethos_llm_request_duration_seconds',
        LLM_DURATION_BUCKETS,
        { provider, model },
        durationSeconds,
        nowIso,
      );
    } else if (span.kind === 'tool_call') {
      const tool = span.name;
      incrementCounter(this.db, 'ethos_tool_calls_total', { tool, outcome: status }, 1, nowIso);
      // A4 — parallel tool spans are all opened before any of them execute,
      // so span start_ts..end_ts is batch wall-clock, not the per-call
      // duration. `attrs.durationMs` (tool-registry.ts's per-call timer) is
      // the accurate figure; the span-derived fallback is only for the rare
      // caller that closes a tool_call span without it.
      const toolDurationSeconds =
        typeof attrs.durationMs === 'number' ? attrs.durationMs / 1000 : durationSeconds;
      incrementHistogram(
        this.db,
        'ethos_tool_duration_seconds',
        TOOL_DURATION_BUCKETS,
        { tool },
        toolDurationSeconds,
        nowIso,
      );
    }
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
    this.db.transaction(() => {
      const inserted = this.db
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
        ).changes;

      // A duplicate event_id (INSERT OR IGNORE no-op) must not double-count.
      if (inserted === 0) return;
      if (event.category !== 'skill.invoked' && event.category !== 'skill.exposed') return;
      const skill = event.details?.skill;
      if (typeof skill !== 'string') return;
      incrementCounter(
        this.db,
        'ethos_skill_invocations_total',
        { skill, mode: event.category === 'skill.invoked' ? 'invoked' : 'exposed' },
        1,
        new Date(event.ts).toISOString(),
      );
    })();
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
  // Metrics (P2-counters, D2/D20) — not on `ObservabilityStore`; the
  // `/metrics` renderer reaches this concrete class directly.
  // ---------------------------------------------------------------------------

  getMetricCounters(): MetricCounterRow[] {
    return readMetricCounters(this.db);
  }

  // ---------------------------------------------------------------------------
  // Langfuse export claims (P2-langfuse, D7/D20) — not on `ObservabilityStore`;
  // `extensions/export-langfuse`'s poller reaches this concrete class
  // directly, the same way `getMetricCounters` above is reached by the
  // `/metrics` renderer.
  // ---------------------------------------------------------------------------

  /**
   * Atomically claim up to `batchSize` completed, unexported traces
   * (delivery-ledger idiom, D7). The SELECT and the claiming UPDATE run
   * inside one `db.transaction().immediate` so no other transaction — even
   * from a peer process sharing this file, given `busy_timeout` — can
   * interleave between them; that is what makes two pollers' claims
   * disjoint. `.immediate` takes the write lock up front (this call is
   * write-first by nature), so a losing peer fails fast on `SQLITE_BUSY`
   * instead of doing a wasted candidate SELECT before losing the race on the
   * UPDATE. `status IS NOT NULL` is "closed" (`closeTrace` sets it); an open
   * trace has nothing to export yet.
   *
   * `claimed_at < staleCutoff` re-claims a row a crashed poller abandoned.
   * There is no separate stale-claim sweep: the next tick's claim call IS
   * the sweep, and there is no terminal "abandoned" state — an unexported
   * trace is eligible again as soon as its claim goes stale, forever.
   *
   * The reload after the UPDATE is scoped to `claimed_at = now` — not just
   * the original candidate id list — so a row a peer claimed out from under
   * this call between the SELECT and the UPDATE (and that this call's
   * UPDATE therefore skipped) is never returned as claimed here too. Each
   * returned trace carries the exact `claimedAt` this call stamped, so
   * `markTraceExported`/`releaseTraceClaim` can later prove they still hold
   * the claim they think they hold.
   */
  claimUnexportedTraces(batchSize: number, staleClaimCutoffMs: number): ClaimedTrace[] {
    const now = Date.now();
    const staleCutoff = now - staleClaimCutoffMs;
    return this.db
      .transaction((): ClaimedTrace[] => {
        const candidates = this.db
          .prepare(
            `SELECT trace_id FROM traces
           WHERE status IS NOT NULL AND exported_at IS NULL
             AND (claimed_at IS NULL OR claimed_at < ?)
           ORDER BY start_ts ASC LIMIT ?`,
          )
          .all(staleCutoff, batchSize) as { trace_id: string }[];
        if (candidates.length === 0) return [];
        const ids = candidates.map((c) => c.trace_id);
        const placeholders = ids.map(() => '?').join(',');
        this.db
          .prepare(
            `UPDATE traces SET claimed_at = ?
           WHERE trace_id IN (${placeholders})
             AND exported_at IS NULL AND (claimed_at IS NULL OR claimed_at < ?)`,
          )
          .run(now, ...ids, staleCutoff);
        const rows = this.db
          .prepare(`SELECT * FROM traces WHERE trace_id IN (${placeholders}) AND claimed_at = ?`)
          .all(...ids, now) as TraceRow[];
        return rows.map((r) => ({ trace: rowToTrace(r), claimedAt: now }));
      })
      .immediate();
  }

  /**
   * Stamp a claimed trace exported. `claimed_at = ?` restricts this to the
   * row this SPECIFIC claim holds — not merely "some claim exists" — so a
   * stale reclaim by a peer can never be stamped exported by the original,
   * now-late caller.
   */
  markTraceExported(traceId: string, claimedAt: number): void {
    this.db
      .prepare(
        `UPDATE traces SET exported_at = ?, claimed_at = NULL
         WHERE trace_id = ? AND claimed_at = ?`,
      )
      .run(Date.now(), traceId, claimedAt);
  }

  /**
   * Put a claimed trace back in the unexported pool — the retry path for any
   * export failure. Unlike the delivery ledger, Langfuse export has no
   * terminal "abandoned" state: an unexported trace retries forever, because
   * a temporarily-down Langfuse endpoint is not a reason to stop trying.
   * `claimed_at = ?` is the same claim-scoping as `markTraceExported` — a
   * caller that lost the claim to a peer's stale-reclaim must not clear the
   * peer's now-active claim out from under it.
   */
  releaseTraceClaim(traceId: string, claimedAt: number): void {
    this.db
      .prepare(`UPDATE traces SET claimed_at = NULL WHERE trace_id = ? AND claimed_at = ?`)
      .run(traceId, claimedAt);
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

/**
 * A trace paired with the exact `claimed_at` timestamp this call's
 * `claimUnexportedTraces` stamped it with — see the method doc. Local to
 * this export-claim bookkeeping; `Trace` itself (the shared
 * `@ethosagent/types` interface) is not extended (D20).
 */
export interface ClaimedTrace {
  trace: Trace;
  claimedAt: number;
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
