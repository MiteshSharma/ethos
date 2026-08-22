// SQLite-backed A2aTaskStore (plan §3 T1.6).
//
// `InMemoryA2aTaskStore` loses every async task's state, result, and
// idempotency key on restart — including the idempotency key, which is the
// mechanism that makes RETRYING a `message/send` safe. Backoff (T1.3) without
// this is three fast retries that forget across a restart and re-run the
// loop. This is the durable backend, following the same shape
// `extensions/job-store` and `extensions/delivery-ledger` already established
// for exactly this kind of store: `@ethosagent/sqlite` opens a raw path,
// `mkdirSync`s the parent dir (CLAUDE.md's raw-node:fs exception list), WAL +
// a busy timeout for cross-process sharing, and a forward-only `user_version`
// migration chain.
//
// The `A2aTaskStore` INTERFACE is unchanged — `InMemoryA2aTaskStore` stays the
// default in tests. This is a second implementation, not a replacement of the
// contract.
//
// `subscribe()` stays in-memory (`Map<id, Set<listener>>`): an SSE connection
// is inherently per-process and does not survive a restart either way, so
// there is nothing to persist there.
//
// Retention: terminal tasks are pruned in two passes. `pruneBodies` clears
// `result`/`error` text after the shorter window — the row (status +
// idempotency key) survives, because idempotency surviving a restart is the
// whole point of this store. `pruneTerminal` deletes the row entirely after
// the longer window.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { migrate } from '@ethosagent/sqlite';
import type { A2aTask, A2aTaskStatus, A2aTaskStore } from './task-store';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS a2a_tasks (
    id               TEXT PRIMARY KEY,
    status           TEXT NOT NULL,
    result           TEXT,
    error            TEXT,
    created_at       INTEGER NOT NULL,
    idempotency_key  TEXT NOT NULL,
    trace_id         TEXT NOT NULL,
    peer_fingerprint TEXT NOT NULL,
    personality_id   TEXT
  ) STRICT;

  CREATE INDEX IF NOT EXISTS a2a_tasks_idempotency
    ON a2a_tasks(peer_fingerprint, idempotency_key);
  CREATE INDEX IF NOT EXISTS a2a_tasks_status_created
    ON a2a_tasks(status, created_at);
`;

const SCHEMA_VERSION = 1;

// Mirrors task-store.ts's TERMINAL set (T1.7 removed `cancelled`; a later
// pass removed `expired`/`peer-unreachable` on the same precedent). Kept as a
// literal SQL IN-list rather than built from an import so pruning stays a
// plain prepared statement; keep the two in sync if a status is ever added.
const TERMINAL_STATUSES_SQL = "('completed','failed')";

interface TaskRow {
  id: string;
  status: string;
  result: string | null;
  error: string | null;
  created_at: number;
  idempotency_key: string;
  trace_id: string;
  peer_fingerprint: string;
  personality_id: string | null;
}

function rowToTask(r: TaskRow): A2aTask {
  return {
    id: r.id,
    status: r.status as A2aTaskStatus,
    result: r.result ?? undefined,
    error: r.error ?? undefined,
    createdAt: r.created_at,
    idempotencyKey: r.idempotency_key,
    traceId: r.trace_id,
    peerFingerprint: r.peer_fingerprint,
    personalityId: r.personality_id ?? undefined,
  };
}

/**
 * Durable {@link A2aTaskStore}. One row per task; SSE subscriptions stay
 * in-memory (see module header) and do not survive a restart.
 */
export class SQLiteA2aTaskStore implements A2aTaskStore {
  private readonly db: Database.Database;
  private readonly listeners = new Map<string, Set<(task: A2aTask) => void>>();

  constructor(dbPath: string) {
    // mkdir -p the parent directory — the same raw-fs exception the other
    // SQLite stores use for path setup (Storage covers ~/.ethos/ data IO, not
    // bootstrapping the DB file's enclosing directory). `:memory:` has no
    // parent path, so skip.
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    // Same busy-timeout idiom every sibling SQLite store uses so a concurrent
    // open/write waits instead of throwing SQLITE_BUSY.
    this.db.pragma('busy_timeout = 5000');

    migrate(this.db, {
      name: 'a2a-task-store',
      targetVersion: SCHEMA_VERSION,
      baseline: SCHEMA,
    });
  }

  async create(task: A2aTask): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO a2a_tasks
         (id, status, result, error, created_at, idempotency_key, trace_id, peer_fingerprint, personality_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.status,
        task.result ?? null,
        task.error ?? null,
        task.createdAt,
        task.idempotencyKey,
        task.traceId,
        task.peerFingerprint,
        task.personalityId ?? null,
      );
  }

  async get(id: string): Promise<A2aTask | null> {
    const row = this.db.prepare('SELECT * FROM a2a_tasks WHERE id = ?').get(id) as
      | TaskRow
      | undefined;
    return row ? rowToTask(row) : null;
  }

  async findByIdempotencyKey(
    peerFingerprint: string,
    idempotencyKey: string,
  ): Promise<A2aTask | null> {
    // rowid DESC — mirrors InMemoryA2aTaskStore's Map semantics (last write
    // wins) in the unlikely event the same key is ever inserted twice.
    const row = this.db
      .prepare(
        `SELECT * FROM a2a_tasks
         WHERE peer_fingerprint = ? AND idempotency_key = ?
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(peerFingerprint, idempotencyKey) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  async update(id: string, patch: Partial<Omit<A2aTask, 'id'>>): Promise<A2aTask | null> {
    const current = await this.get(id);
    if (!current) return null;
    const next: A2aTask = { ...current, ...patch, id };
    this.db
      .prepare(
        `UPDATE a2a_tasks SET status = ?, result = ?, error = ?, personality_id = ?
         WHERE id = ?`,
      )
      .run(next.status, next.result ?? null, next.error ?? null, next.personalityId ?? null, id);

    const set = this.listeners.get(id);
    if (set) {
      const snapshot = { ...next };
      for (const listener of set) listener(snapshot);
    }
    return next;
  }

  subscribe(id: string, listener: (task: A2aTask) => void): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    return () => {
      const s = this.listeners.get(id);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.listeners.delete(id);
    };
  }

  /**
   * Clear `result`/`error` on terminal tasks created before `cutoffMs`. The
   * row — status + idempotency key — survives; idempotency surviving a
   * restart is the reason this store exists. Returns rows cleared.
   */
  async pruneBodies(cutoffMs: number): Promise<number> {
    const result = this.db
      .prepare(
        `UPDATE a2a_tasks SET result = NULL, error = NULL
         WHERE status IN ${TERMINAL_STATUSES_SQL}
           AND created_at < ?
           AND (result IS NOT NULL OR error IS NOT NULL)`,
      )
      .run(cutoffMs);
    return result.changes;
  }

  /**
   * Delete terminal task rows created before `cutoffMs` entirely, including
   * their idempotency key. Returns rows removed.
   */
  async pruneTerminal(cutoffMs: number): Promise<number> {
    const result = this.db
      .prepare(`DELETE FROM a2a_tasks WHERE status IN ${TERMINAL_STATUSES_SQL} AND created_at < ?`)
      .run(cutoffMs);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
