import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { migrate } from '@ethosagent/sqlite';
import type {
  BackgroundJob,
  BackgroundJobEvent,
  BackgroundJobEventType,
  BackgroundJobStatus,
  CreateBackgroundJobInput,
  JobStore,
} from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    id                 TEXT PRIMARY KEY,
    owner              TEXT NOT NULL,
    parent_session_key TEXT NOT NULL,
    root_session_key   TEXT NOT NULL,
    child_session_key  TEXT NOT NULL,
    personality_id     TEXT,
    depth              INTEGER NOT NULL,
    status             TEXT NOT NULL DEFAULT 'queued',
    label              TEXT,
    prompt             TEXT NOT NULL,
    summary            TEXT,
    error              TEXT,
    spend_usd          REAL NOT NULL DEFAULT 0,
    max_cost_usd       REAL,
    cancel_requested   INTEGER NOT NULL DEFAULT 0,
    heartbeat_at       INTEGER,
    created_at         INTEGER NOT NULL,
    started_at         INTEGER,
    finished_at        INTEGER,
    delivered_at       INTEGER,
    origin_platform    TEXT,
    origin_bot_key     TEXT,
    origin_chat_id     TEXT,
    origin_thread_id   TEXT,
    remote_peer        TEXT,
    remote_job_id      TEXT,
    runner             TEXT,
    blocked_since      INTEGER,
    blocked_request_id TEXT
  ) STRICT;

  CREATE TABLE IF NOT EXISTS job_events (
    id         INTEGER PRIMARY KEY,
    job_id     TEXT NOT NULL REFERENCES jobs(id),
    seq        INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS job_events_job ON job_events(job_id, seq);
  CREATE INDEX IF NOT EXISTS jobs_root_status ON jobs(root_session_key, status);
  CREATE INDEX IF NOT EXISTS jobs_owner_status ON jobs(owner, status);
  CREATE INDEX IF NOT EXISTS jobs_status_created ON jobs(status, created_at);
`;

/**
 * The restore sweep's index. NOT in the baseline: `migrate` execs the baseline
 * BEFORE the migration chain, so on an older database `delivered_at` does not
 * exist yet and the CREATE INDEX would fail. It goes after the chain instead,
 * where the column is guaranteed to be there.
 */
const DELIVERY_INDEX =
  'CREATE INDEX IF NOT EXISTS jobs_undelivered ON jobs(origin_bot_key, status, delivered_at)';

const JOB_STORE_SCHEMA_VERSION = 5;

/**
 * Forward-only DDL steps. Each brings a `(N-1)` database to `N`; the baseline
 * above already describes v5, so a FRESH database never runs one. The
 * `table_info` guards keep each ALTER idempotent even if a database was
 * hand-repaired to the newer shape without its `user_version` being bumped.
 */
const JOB_STORE_MIGRATIONS: Record<number, (db: Database.Database) => void> = {
  2: (db) => {
    addColumnIfMissing(db, 'remote_peer', 'TEXT');
    addColumnIfMissing(db, 'remote_job_id', 'TEXT');
  },
  // v2 -> v3: the delivery claim. `ALTER TABLE ... ADD COLUMN` keeps the table
  // STRICT (STRICT is a table property, not a column one) and leaves every
  // existing row intact with `delivered_at` NULL — i.e. "never announced",
  // which is the honest state for a job that finished before this code existed.
  3: (db) => addColumnIfMissing(db, 'delivered_at', 'INTEGER'),
  // v3 -> v4: which runner executed the row. NULL on every pre-existing row,
  // which reads as "the default runner" — the only one that existed then.
  4: (db) => addColumnIfMissing(db, 'runner', 'TEXT'),
  // v4 -> v5: the `blocked` state's two fields. Same ALTER shape as v2/v3 —
  // existing rows get NULLs, which is the honest state for every job that
  // finished before a run could park on a human answer.
  5: (db) => {
    addColumnIfMissing(db, 'blocked_since', 'INTEGER');
    addColumnIfMissing(db, 'blocked_request_id', 'TEXT');
  },
};

function addColumnIfMissing(db: Database.Database, column: string, type: string): void {
  const cols = db.pragma('table_info(jobs)') as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE jobs ADD COLUMN ${column} ${type}`);
  }
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface JobRow {
  id: string;
  owner: string;
  parent_session_key: string;
  root_session_key: string;
  child_session_key: string;
  personality_id: string | null;
  depth: number;
  status: string;
  label: string | null;
  prompt: string;
  summary: string | null;
  error: string | null;
  spend_usd: number;
  max_cost_usd: number | null;
  cancel_requested: number;
  heartbeat_at: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  delivered_at: number | null;
  origin_platform: string | null;
  origin_bot_key: string | null;
  origin_chat_id: string | null;
  origin_thread_id: string | null;
  remote_peer: string | null;
  remote_job_id: string | null;
  runner: string | null;
  blocked_since: number | null;
  blocked_request_id: string | null;
}

interface JobEventRow {
  id: number;
  job_id: string;
  seq: number;
  event_type: string;
  payload: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function rowToJob(r: JobRow): BackgroundJob {
  return {
    id: r.id,
    owner: r.owner,
    parentSessionKey: r.parent_session_key,
    rootSessionKey: r.root_session_key,
    childSessionKey: r.child_session_key,
    personalityId: r.personality_id ?? undefined,
    depth: r.depth,
    status: r.status as BackgroundJobStatus,
    label: r.label ?? undefined,
    prompt: r.prompt,
    summary: r.summary ?? undefined,
    error: r.error ?? undefined,
    spendUsd: r.spend_usd,
    maxCostUsd: r.max_cost_usd ?? undefined,
    cancelRequested: r.cancel_requested === 1,
    heartbeatAt: r.heartbeat_at ?? undefined,
    createdAt: r.created_at,
    startedAt: r.started_at ?? undefined,
    finishedAt: r.finished_at ?? undefined,
    deliveredAt: r.delivered_at ?? undefined,
    originPlatform: r.origin_platform ?? undefined,
    originBotKey: r.origin_bot_key ?? undefined,
    originChatId: r.origin_chat_id ?? undefined,
    originThreadId: r.origin_thread_id ?? undefined,
    remotePeer: r.remote_peer ?? undefined,
    remoteJobId: r.remote_job_id ?? undefined,
    runner: r.runner ?? undefined,
    blockedSince: r.blocked_since ?? undefined,
    blockedRequestId: r.blocked_request_id ?? undefined,
  };
}

function rowToEvent(r: JobEventRow): BackgroundJobEvent {
  return {
    id: r.id,
    jobId: r.job_id,
    seq: r.seq,
    eventType: r.event_type as BackgroundJobEventType,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    createdAt: r.created_at,
  };
}

// `blocked` is ACTIVE, not terminal: a run parked on a human answer still owns
// its concurrency slot, so the per-root / per-personality caps must see it.
const ACTIVE_STATUSES = "('queued','running','blocked')";
const TERMINAL_STATUSES = "('done','failed','aborted','stale','expired')";

// ---------------------------------------------------------------------------
// SQLiteJobStore
// ---------------------------------------------------------------------------

export class SQLiteJobStore implements JobStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    // mkdir -p the parent directory — same raw-fs exception the other SQLite
    // stores use for path setup (the Storage abstraction covers ~/.ethos/ data
    // IO, not bootstrapping the DB file's enclosing directory). `:memory:` has
    // no parent path, so skip.
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    // One jobs.db is shared cross-process (gateway + serve + CLL). An explicit
    // busy timeout makes concurrent opens/writes wait instead of throwing
    // SQLITE_BUSY.
    this.db.pragma('busy_timeout = 5000');

    // Downgrade guard, idempotent baseline, and the stepwise chain all live in
    // the shared harness — the same one session-sqlite / delivery-ledger use.
    migrate(this.db, {
      name: 'job-store',
      targetVersion: JOB_STORE_SCHEMA_VERSION,
      baseline: SCHEMA,
      migrations: JOB_STORE_MIGRATIONS,
    });
    this.db.exec(DELIVERY_INDEX);
  }

  async create(input: CreateBackgroundJobInput): Promise<BackgroundJob> {
    const id = randomUUID();
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO jobs
         (id, owner, parent_session_key, root_session_key, child_session_key,
          personality_id, depth, status, label, prompt, spend_usd,
          max_cost_usd, cancel_requested, created_at,
          origin_platform, origin_bot_key, origin_chat_id, origin_thread_id,
          remote_peer, remote_job_id, runner)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.owner,
        input.parentSessionKey,
        input.rootSessionKey,
        input.childSessionKey,
        input.personalityId ?? null,
        input.depth,
        'queued',
        input.label ?? null,
        input.prompt,
        0,
        input.maxCostUsd ?? null,
        0,
        now,
        input.originPlatform ?? null,
        input.originBotKey ?? null,
        input.originChatId ?? null,
        input.originThreadId ?? null,
        input.remotePeer ?? null,
        input.remoteJobId ?? null,
        input.runner ?? null,
      );

    this.appendEventSync(id, 'queued', {});

    const job = this.getSync(id);
    if (!job) throw new Error(`create: inserted job ${id} not found`);
    return job;
  }

  async get(id: string): Promise<BackgroundJob | null> {
    return this.getSync(id);
  }

  private getSync(id: string): BackgroundJob | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  async claimNextQueued(owner: string): Promise<BackgroundJob | null> {
    const now = Date.now();
    const claim = this.db.transaction((): string | null => {
      const candidate = this.db
        .prepare(
          `SELECT id FROM jobs
           WHERE status = 'queued' AND owner = ?
           ORDER BY created_at ASC, rowid ASC
           LIMIT 1`,
        )
        .get(owner) as { id: string } | undefined;
      if (!candidate) return null;

      const result = this.db
        .prepare(
          `UPDATE jobs SET status = 'running', started_at = ?, heartbeat_at = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(now, now, candidate.id);
      if (result.changes !== 1) return null;

      this.appendEventSync(candidate.id, 'claimed', {});
      this.appendEventSync(candidate.id, 'running', {});
      return candidate.id;
    });

    const claimedId = claim();
    return claimedId ? this.getSync(claimedId) : null;
  }

  async heartbeat(id: string): Promise<void> {
    // The column update IS the beat — no event, to avoid write amplification.
    this.db
      .prepare(`UPDATE jobs SET heartbeat_at = ? WHERE id = ? AND status = 'running'`)
      .run(Date.now(), id);
  }

  async updateSpend(id: string, spendUsd: number): Promise<void> {
    // No event — the executor coalesces spend updates.
    this.db.prepare('UPDATE jobs SET spend_usd = ? WHERE id = ?').run(spendUsd, id);
  }

  async requestCancel(id: string): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE jobs SET cancel_requested = 1 WHERE id = ?').run(id);
      this.appendEventSync(id, 'cancel_requested', {});
    });
    tx();
  }

  async markBlocked(id: string, requestId: string): Promise<void> {
    const tx = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE jobs SET status = 'blocked', blocked_since = ?, blocked_request_id = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(Date.now(), requestId, id);
      // Guarded, not asserted: the row may have been cancelled or finished
      // between the question being asked and this write. No transition, no event.
      if (result.changes === 1) this.appendEventSync(id, 'blocked', { requestId });
    });
    tx();
  }

  async resumeFromBlocked(id: string): Promise<void> {
    const tx = this.db.transaction(() => {
      // heartbeat_at is bumped here, not left as it was: a run parked longer than
      // staleMs would otherwise be swept stale in the gap between resuming and
      // the executor's next beat.
      const result = this.db
        .prepare(
          `UPDATE jobs SET status = 'running', blocked_since = NULL,
             blocked_request_id = NULL, heartbeat_at = ?
           WHERE id = ? AND status = 'blocked'`,
        )
        .run(Date.now(), id);
      if (result.changes === 1) this.appendEventSync(id, 'resumed', {});
    });
    tx();
  }

  async finish(
    id: string,
    terminal: 'done' | 'failed' | 'aborted',
    fields: { summary?: string; error?: string },
  ): Promise<void> {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare('SELECT status FROM jobs WHERE id = ?').get(id) as
        | { status: string }
        | undefined;
      if (!row) throw new Error(`finish: job ${id} not found`);
      // `blocked` is a legal SOURCE (a parked run is still cancellable — §4.1's
      // blocked card offers Cancel) but never a terminal ARGUMENT.
      if (row.status !== 'running' && row.status !== 'stale' && row.status !== 'blocked') {
        throw new Error(`finish: job ${id} not in running/stale/blocked (status=${row.status})`);
      }

      // The blocked fields are cleared with the transition: a terminal row is not
      // parked on anything. The audit trail keeps the `blocked` event.
      this.db
        .prepare(
          `UPDATE jobs SET status = ?, summary = ?, error = ?, finished_at = ?,
             blocked_since = NULL, blocked_request_id = NULL
           WHERE id = ?`,
        )
        .run(terminal, fields.summary ?? null, fields.error ?? null, Date.now(), id);

      // A stale row that turns out alive recovers: record it before the terminal
      // event so the audit trail reads stale -> recovered -> <terminal>.
      if (row.status === 'stale') {
        this.appendEventSync(id, 'recovered', {});
      }
      this.appendEventSync(id, terminal, {});
    });
    tx();
  }

  async listByRoot(rootSessionKey: string): Promise<BackgroundJob[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs WHERE root_session_key = ?
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(rootSessionKey) as JobRow[];
    return rows.map(rowToJob);
  }

  async countActiveByRoot(rootSessionKey: string): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM jobs
         WHERE root_session_key = ? AND status IN ${ACTIVE_STATUSES}`,
      )
      .get(rootSessionKey) as { n: number };
    return row.n;
  }

  async countActiveByPersonality(personalityId: string): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM jobs
         WHERE personality_id = ? AND status IN ${ACTIVE_STATUSES}`,
      )
      .get(personalityId) as { n: number };
    return row.n;
  }

  async reclaimStale(staleMs: number): Promise<BackgroundJob[]> {
    const threshold = Date.now() - staleMs;
    const ids = this.db.transaction((): string[] => {
      // `status = 'running'` is what keeps `blocked` out of the sweep, and that
      // is deliberate, not incidental: the executor stops beating for a parked
      // run, so a blocked row's heartbeat ages past the threshold by design. A
      // question waiting on a person must never be filed as a dead host.
      const rows = this.db
        .prepare(
          `SELECT id FROM jobs
           WHERE status = 'running' AND heartbeat_at IS NOT NULL AND heartbeat_at <= ?`,
        )
        .all(threshold) as Array<{ id: string }>;
      if (rows.length === 0) return [];

      const transitioned: string[] = [];
      for (const { id } of rows) {
        const result = this.db
          .prepare(
            `UPDATE jobs SET status = 'stale', error = 'stalled — no heartbeat'
             WHERE id = ? AND status = 'running'`,
          )
          .run(id);
        if (result.changes === 1) {
          this.appendEventSync(id, 'stale', {});
          transitioned.push(id);
        }
      }
      return transitioned;
    })();

    return ids.map((id) => this.getSync(id)).filter((j): j is BackgroundJob => j !== null);
  }

  async expireQueued(ttlMs: number): Promise<BackgroundJob[]> {
    const threshold = Date.now() - ttlMs;
    const ids = this.db.transaction((): string[] => {
      const rows = this.db
        .prepare(`SELECT id FROM jobs WHERE status = 'queued' AND created_at <= ?`)
        .all(threshold) as Array<{ id: string }>;
      if (rows.length === 0) return [];

      const transitioned: string[] = [];
      for (const { id } of rows) {
        const result = this.db
          .prepare(
            `UPDATE jobs SET status = 'expired',
               error = 'queued too long — no executor claimed it (process may have died before claiming)'
             WHERE id = ? AND status = 'queued'`,
          )
          .run(id);
        if (result.changes === 1) {
          this.appendEventSync(id, 'expired', {});
          transitioned.push(id);
        }
      }
      return transitioned;
    })();

    return ids.map((id) => this.getSync(id)).filter((j): j is BackgroundJob => j !== null);
  }

  async listRunningRemote(): Promise<BackgroundJob[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE status = 'running' AND remote_job_id IS NOT NULL
         ORDER BY created_at ASC`,
      )
      .all() as JobRow[];
    return rows.map(rowToJob);
  }

  async listUndelivered(originBotKeys: string[]): Promise<BackgroundJob[]> {
    if (originBotKeys.length === 0) return [];
    // Only `done`/`failed` are announceable — `aborted` is user-requested and
    // stays silent, and `stale`/`expired` have no result worth waking anyone
    // for. Narrowing here (rather than at the caller) is also what keeps this
    // query's result set bounded: an un-announceable row is never scanned again.
    const placeholders = originBotKeys.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE status IN ('done','failed')
           AND delivered_at IS NULL
           AND origin_bot_key IN (${placeholders})
           AND origin_platform IS NOT NULL
           AND origin_chat_id IS NOT NULL
         ORDER BY COALESCE(finished_at, created_at) ASC, rowid ASC`,
      )
      .all(...originBotKeys) as JobRow[];
    return rows.map(rowToJob);
  }

  async claimDelivery(id: string): Promise<boolean> {
    const result = this.db
      .prepare('UPDATE jobs SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL')
      .run(Date.now(), id);
    return result.changes === 1;
  }

  async releaseDelivery(id: string): Promise<void> {
    this.db.prepare('UPDATE jobs SET delivered_at = NULL WHERE id = ?').run(id);
  }

  async pruneTerminal(cutoffMs: number): Promise<number> {
    const prune = this.db.transaction((): number => {
      // Delete events first to respect the FK (foreign_keys is ON), matching on
      // the same terminal + age predicate as the jobs delete.
      this.db
        .prepare(
          `DELETE FROM job_events WHERE job_id IN (
             SELECT id FROM jobs
             WHERE status IN ${TERMINAL_STATUSES}
               AND COALESCE(finished_at, created_at) < ?
           )`,
        )
        .run(cutoffMs);

      const result = this.db
        .prepare(
          `DELETE FROM jobs
           WHERE status IN ${TERMINAL_STATUSES}
             AND COALESCE(finished_at, created_at) < ?`,
        )
        .run(cutoffMs);
      return result.changes;
    });
    return prune();
  }

  async appendEvent(
    jobId: string,
    eventType: BackgroundJobEventType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    this.appendEventSync(jobId, eventType, payload);
  }

  private appendEventSync(
    jobId: string,
    eventType: BackgroundJobEventType,
    payload: Record<string, unknown>,
  ): void {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      const maxRow = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM job_events WHERE job_id = ?')
        .get(jobId) as { max_seq: number };
      const nextSeq = maxRow.max_seq + 1;
      this.db
        .prepare(
          `INSERT INTO job_events (job_id, seq, event_type, payload, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(jobId, nextSeq, eventType, JSON.stringify(payload), now);
    });
    tx();
  }

  async getEvents(jobId: string): Promise<BackgroundJobEvent[]> {
    const rows = this.db
      .prepare('SELECT * FROM job_events WHERE job_id = ? ORDER BY seq ASC')
      .all(jobId) as JobEventRow[];
    return rows.map(rowToEvent);
  }

  close(): void {
    this.db.close();
  }
}
