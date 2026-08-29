import { randomUUID } from 'node:crypto';
import Database from '@ethosagent/sqlite';
import type {
  ContextEvent,
  ContextEventKind,
  ContextLog,
  ResolvedContext,
} from '@ethosagent/types';

// ---------------------------------------------------------------------------
// SQLiteContextLog
//
// Backs `ContextLog` (plan/phases/model-visible-logged.md, D5). Shares the
// SAME `sessions.db` file as `SQLiteSessionStore` — same file, separate type
// — following the precedent set by `job-store` / `delivery-ledger` /
// `session-cards` / `call-log` (CLAUDE.md's raw-SQLite carve-out roster):
// every sibling store that shares a file with another opens its OWN
// `Database` handle rather than being handed one at construction. WAL mode
// (set here, same as `SQLiteSessionStore`) makes concurrent handles on one
// file safe — readers don't block writers and vice versa — so there is no
// correctness cost to the extra handle, and it keeps `SQLiteContextLog`
// constructible (and testable) independently of `SQLiteSessionStore`.
//
// `session_context_events` is added via a raw `CREATE TABLE IF NOT EXISTS`,
// the same additive pattern `SQLiteSessionStore.migrate()` uses for the
// `trace_id` column: idempotent, no `user_version` bump needed since
// `IF NOT EXISTS` DDL is safe to re-run unconditionally.
//
// `session_id REFERENCES sessions(id) ON DELETE CASCADE` — matches the FK
// `messages`/`compressions` already declare, so `SQLiteSessionStore.deleteSession`
// cleans these rows up too (otherwise they orphan forever and `ethos cas gc`
// can never reclaim their CAS blobs). SQLite resolves a `REFERENCES` target
// against the file's schema, not the declaring connection's, so this fires
// correctly even though the DELETE runs through `SQLiteSessionStore`'s
// separate handle — but `sessions` must already exist as a table (not
// necessarily contain the row) before this `CREATE TABLE` can be followed by
// an `INSERT` here; every real construction site builds `SQLiteSessionStore`
// first (see `compose.ts`, `why.ts`, `serve.ts`), and `cas.ts` — the one
// place `SQLiteContextLog` is constructed alone — only ever reads via
// `listRefs()`, never appends. `node:sqlite` also defaults `foreign_keys` to
// ON per-connection (unlike the sqlite3 C library's OFF default), so this
// handle enforces the constraint on `append()` without its own pragma call.
// ---------------------------------------------------------------------------

const CONTEXT_EVENTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS session_context_events (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    kind       TEXT NOT NULL,
    mode       TEXT NOT NULL,
    hash       TEXT NOT NULL,
    meta       TEXT NOT NULL,
    timestamp  INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_context_events_session_kind
    ON session_context_events(session_id, kind, timestamp);
`;

const KINDS: readonly ContextEventKind[] = ['personality', 'memory', 'file_window', 'team_index'];

interface ContextEventRow {
  hash: string;
  mode: string;
  meta: string;
  timestamp: number;
}

export class SQLiteContextLog implements ContextLog {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(CONTEXT_EVENTS_SCHEMA);
  }

  async append(event: ContextEvent): Promise<void> {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO session_context_events
         (id, session_id, message_id, kind, mode, hash, meta, timestamp)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        event.sessionId,
        event.messageId,
        event.kind,
        event.mode,
        event.hash,
        JSON.stringify(event.meta),
        event.timestamp,
      );
  }

  async resolveAt(sessionId: string, messageId: string): Promise<ResolvedContext> {
    const msgRow = this.db.prepare('SELECT timestamp FROM messages WHERE id = ?').get(messageId) as
      | { timestamp: string }
      | undefined;
    if (!msgRow) {
      throw new Error(
        `SQLiteContextLog.resolveAt: message "${messageId}" not found in session "${sessionId}"`,
      );
    }
    const targetTs = Date.parse(msgRow.timestamp);

    const result = {} as ResolvedContext;
    for (const kind of KINDS) {
      // rowid tie-breaks same-millisecond events — the same convention
      // `SQLiteSessionStore.getMessages` uses internally (D3).
      const row = this.db
        .prepare(
          `SELECT hash, mode, meta, timestamp, rowid AS _row
           FROM session_context_events
           WHERE session_id = ? AND kind = ? AND timestamp <= ?
           ORDER BY timestamp DESC, rowid DESC LIMIT 1`,
        )
        .get(sessionId, kind, targetTs) as ContextEventRow | undefined;

      result[kind] = row
        ? {
            hash: row.hash,
            mode: row.mode as ContextEvent['mode'],
            meta: JSON.parse(row.meta) as Record<string, unknown>,
            timestamp: row.timestamp,
          }
        : 'unknown';
    }
    return result;
  }

  async listRefs(): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT DISTINCT hash FROM session_context_events')
      .all() as Array<{
      hash: string;
    }>;
    return rows.map((r) => r.hash);
  }

  /** Every context event recorded for one session, in insertion order
   *  (timestamp, then rowid — same tie-break `resolveAt` uses). Not part of
   *  the shared `ContextLog` interface (D5, plan/phases/model-visible-logged.md
   *  Phase E) — this is raw per-session history, which only a Phase E consumer
   *  that copies events wholesale (fork) needs; `resolveAt` only returns the
   *  merged final state per kind. */
  async listForSession(sessionId: string): Promise<ContextEvent[]> {
    const rows = this.db
      .prepare(
        `SELECT session_id, message_id, kind, mode, hash, meta, timestamp
         FROM session_context_events
         WHERE session_id = ?
         ORDER BY timestamp ASC, rowid ASC`,
      )
      .all(sessionId) as Array<{
      session_id: string;
      message_id: string;
      kind: string;
      mode: string;
      hash: string;
      meta: string;
      timestamp: number;
    }>;

    return rows.map((row) => ({
      sessionId: row.session_id,
      messageId: row.message_id,
      kind: row.kind as ContextEventKind,
      mode: row.mode as ContextEvent['mode'],
      hash: row.hash,
      meta: JSON.parse(row.meta) as Record<string, unknown>,
      timestamp: row.timestamp,
    }));
  }

  /** Close the database connection (useful in tests). */
  close(): void {
    this.db.close();
  }
}
