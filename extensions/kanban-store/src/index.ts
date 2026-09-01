import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from '@ethosagent/sqlite';

export {
  type AutonomyTier,
  autonomyTier,
  type TrustPolicy,
  tierMaxRetries,
} from './autonomy-tier';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus =
  | 'todo'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'done'
  | 'archived'
  | 'scheduled'
  | 'failed'
  | 'needs_revision';

export type WorkspaceMode = 'scratch' | 'worktree' | 'dir';

/**
 * Why a task was blocked, distinct from the free-text `reason`. Used by the
 * unblock-loop breaker (see `blockRun`) to detect consecutive blocks for the
 * *same underlying reason* even when the free-text wording differs run to run.
 */
export type BlockKind = 'dependency' | 'needs_input' | 'capability' | 'transient';

/** Default for `KanbanStoreOptions.blockRecurrenceLimit`. See `blockRun`. */
export const DEFAULT_BLOCK_RECURRENCE_LIMIT = 2;

export type RunOutcome = 'completed' | 'blocked' | 'stalled' | 'cancelled';

export type EventKind =
  | 'created'
  | 'status_changed'
  | 'commented'
  | 'assigned'
  | 'linked'
  | 'unlinked'
  | 'run_started'
  | 'run_completed'
  | 'heartbeat'
  | 'archived';

export interface Task {
  id: string;
  title: string;
  body: string;
  assignee: string | null;
  status: TaskStatus;
  priority: number;
  workspaceMode: WorkspaceMode;
  workspacePath: string | null;
  scheduledFor: number | null;
  idempotencyKey: string | null;
  currentRunId: string | null;
  /** Retry budget. `null` = unlimited (the default). */
  maxRetries: number | null;
  /** Times this task has been re-claimed after a prior run ended. Starts at 0. */
  retryCount: number;
  /** Optional acceptance criteria a `before_ticket_complete` verifier checks. `null` = none set. */
  acceptanceCriteria: string | null;
  /** `kind` of the most recent block, or `null` if the task has never been blocked
   *  (or was blocked without a `kind`) since its last successful completion. */
  blockKind: BlockKind | null;
  /** Consecutive blocks landed with the *same* `blockKind` in a row, with no
   *  successful completion in between. Reset to 0 on `completeRun`. See `blockRun`. */
  blockRecurrenceCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface TaskComment {
  id: string;
  taskId: string;
  author: string;
  body: string;
  createdAt: number;
}

export interface TaskLink {
  parentId: string;
  childId: string;
}

export interface TaskRun {
  id: string;
  taskId: string;
  startedAt: number;
  endedAt: number | null;
  outcome: RunOutcome | null;
  summary: string | null;
  lastHeartbeatAt: number;
  completedBy: { id: string; name: string } | null;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  kind: EventKind;
  actor: string;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface CreateTaskInput {
  title: string;
  body?: string;
  assignee?: string | null;
  priority?: number;
  parents?: string[];
  workspaceMode?: WorkspaceMode;
  scheduledFor?: number | null;
  idempotencyKey?: string | null;
  /** Retry budget. `null` (the default) = unlimited. `retryCount` always starts at 0. */
  maxRetries?: number | null;
  /** Optional acceptance criteria. `null`/omitted = none set. */
  acceptanceCriteria?: string | null;
  actor?: string;
}

export interface ListTasksFilter {
  assignee?: string;
  status?: TaskStatus;
  parentId?: string;
  q?: string;
  limit?: number;
}

/** One worker slot in `createSwarm`'s input — a personality plus its work prompt. */
export interface SwarmWorkerInput {
  personality: string;
  prompt: string;
}

/**
 * Input to `createSwarm` (Lane A Phase 5) — the atomic root/blackboard + N
 * workers + optional verifier + optional synthesizer DAG. See `createSwarm`
 * for how each optional tier collapses when omitted.
 */
export interface CreateSwarmInput {
  /** Shared context for the swarm. Becomes the root/blackboard task's body. */
  goal: string;
  workers: SwarmWorkerInput[];
  /** Omit to skip the verifier tier entirely. */
  verifierPersonality?: string;
  /** Omit to skip the synthesizer tier entirely. */
  synthesizerPersonality?: string;
}

/** Ids of every task `createSwarm` created. */
export interface SwarmResult {
  rootId: string;
  workerIds: string[];
  verifierId: string | null;
  synthesizerId: string | null;
}

/**
 * Per-member work outcome counters for one team board. Maintained by the store
 * itself: each terminal task transition (`done`, `failed`/`needs_revision`,
 * orphan-reclaim) bumps the matching counter in the same transaction as the
 * transition, so the stats are a reconstructable function of board content
 * rather than a separate ledger the supervisor has to keep in sync.
 */
export interface TeamMemberStats {
  teamId: string;
  memberId: string;
  /** Tasks this member completed (`done` via `completeRun`). */
  ticketsCompleted: number;
  /** Tasks that ended `failed` or `needs_revision` while claimed by this member. */
  ticketsFailed: number;
  /** Tasks whose claim by this member was reclaimed by another agent. */
  ticketsOrphaned: number;
  /** Epoch-ms of the most recent counter bump. */
  lastUpdatedAt: number;
}

export interface KanbanStoreOptions {
  /**
   * The team this board belongs to. When set, terminal task transitions record
   * per-member outcome counters in `team_member_stats`. Unset on solo
   * personality boards — stats are skipped entirely.
   */
  teamId?: string;
  /**
   * How many consecutive `blockRun` calls with the same `kind` a task tolerates
   * before the unblock-loop breaker routes it to `needs_revision` instead of
   * `blocked`. Defaults to `DEFAULT_BLOCK_RECURRENCE_LIMIT` (2). Exposed as a
   * constructor option (mirroring `dispatcher.ts`'s `pollMs`) so tests and
   * unusual deployments can tune it without a global constant.
   */
  blockRecurrenceLimit?: number;
  /**
   * Board-wide work-in-progress cap: how many tasks may sit in `running` at
   * once. Unset (the default) means no cap — today's behaviour. Enforced on the
   * transition INTO `running`, the only transition that opens a run.
   */
  maxInProgress?: number;
  /**
   * Same cap, per assignee (the profile/personality claiming the task). Unset
   * means no cap. A task with no assignee is never counted against it.
   */
  maxInProgressPerProfile?: number;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    body            TEXT NOT NULL DEFAULT '',
    assignee        TEXT,
    status          TEXT NOT NULL
                    CHECK (status IN ('todo','ready','running','blocked','done','archived','scheduled','failed','needs_revision')),
    priority        INTEGER NOT NULL DEFAULT 0,
    workspace_mode  TEXT NOT NULL DEFAULT 'scratch'
                    CHECK (workspace_mode IN ('scratch','worktree','dir')),
    workspace_path  TEXT,
    scheduled_for   INTEGER,
    idempotency_key TEXT,
    current_run_id  TEXT,
    max_retries     INTEGER CHECK (max_retries IS NULL OR max_retries >= 0),
    retry_count     INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    acceptance_criteria TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    block_kind      TEXT CHECK (block_kind IS NULL OR block_kind IN ('dependency','needs_input','capability','transient')),
    block_recurrence_count INTEGER NOT NULL DEFAULT 0 CHECK (block_recurrence_count >= 0)
  ) STRICT;

  CREATE UNIQUE INDEX IF NOT EXISTS tasks_idem ON tasks(idempotency_key)
    WHERE idempotency_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS tasks_status_assignee ON tasks(status, assignee);
  CREATE INDEX IF NOT EXISTS tasks_scheduled ON tasks(scheduled_for)
    WHERE scheduled_for IS NOT NULL;

  CREATE TABLE IF NOT EXISTS task_comments (
    id         TEXT PRIMARY KEY,
    task_id    TEXT NOT NULL,
    author     TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX IF NOT EXISTS task_comments_task ON task_comments(task_id, created_at);

  CREATE TABLE IF NOT EXISTS task_links (
    parent_id TEXT NOT NULL,
    child_id  TEXT NOT NULL,
    PRIMARY KEY (parent_id, child_id),
    FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (child_id)  REFERENCES tasks(id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX IF NOT EXISTS task_links_child ON task_links(child_id);

  CREATE TABLE IF NOT EXISTS task_runs (
    id                TEXT PRIMARY KEY,
    task_id           TEXT NOT NULL,
    started_at        INTEGER NOT NULL,
    ended_at          INTEGER,
    outcome           TEXT CHECK (outcome IS NULL OR outcome IN ('completed','blocked','stalled','cancelled')),
    summary           TEXT,
    last_heartbeat_at INTEGER NOT NULL,
    completed_by_id   TEXT,
    completed_by_name TEXT,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX IF NOT EXISTS task_runs_task ON task_runs(task_id, started_at);
  CREATE UNIQUE INDEX IF NOT EXISTS task_runs_open_one ON task_runs(task_id)
    WHERE ended_at IS NULL;

  CREATE TABLE IF NOT EXISTS task_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    kind       TEXT NOT NULL
               CHECK (kind IN ('created','status_changed','commented','assigned','linked','unlinked','run_started','run_completed','heartbeat','archived')),
    actor      TEXT NOT NULL,
    data_json  TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, created_at);
  CREATE INDEX IF NOT EXISTS task_events_recent ON task_events(created_at);

  -- task_fts is a hand-maintained denormalized search index over task title/body plus
  -- aggregated comment bodies. Comments are append-only at the API surface (no
  -- updateComment / deleteComment methods), so we only need INSERT triggers to keep
  -- task_fts.comments fresh. If a future schema ever adds comment update/delete paths,
  -- it MUST add the matching task_comments UPDATE/DELETE triggers below to keep
  -- search consistent.
  CREATE VIRTUAL TABLE IF NOT EXISTS task_fts USING fts5(
    task_id UNINDEXED,
    title,
    body,
    comments,
    tokenize = 'porter'
  );

  CREATE TRIGGER IF NOT EXISTS tasks_fts_ai AFTER INSERT ON tasks BEGIN
    INSERT INTO task_fts(task_id, title, body, comments)
    VALUES (new.id, new.title, new.body, '');
  END;

  CREATE TRIGGER IF NOT EXISTS tasks_fts_au AFTER UPDATE OF title, body ON tasks BEGIN
    UPDATE task_fts SET title = new.title, body = new.body
    WHERE task_id = new.id;
  END;

  CREATE TRIGGER IF NOT EXISTS tasks_fts_ad AFTER DELETE ON tasks BEGIN
    DELETE FROM task_fts WHERE task_id = old.id;
  END;

  CREATE TRIGGER IF NOT EXISTS comments_fts_ai AFTER INSERT ON task_comments BEGIN
    UPDATE task_fts
    SET comments = (
      SELECT COALESCE(GROUP_CONCAT(body, ' '), '')
      FROM task_comments WHERE task_id = new.task_id
    )
    WHERE task_id = new.task_id;
  END;

  -- team_member_stats: per-member work outcome counters for a team board.
  -- Purely additive — CREATE TABLE IF NOT EXISTS is safe on every DB version,
  -- so the v3 to v4 bump needs no table rebuild. The store updates these rows
  -- atomically inside each terminal-transition transaction.
  CREATE TABLE IF NOT EXISTS team_member_stats (
    team_id           TEXT NOT NULL,
    member_id         TEXT NOT NULL,
    tickets_completed INTEGER NOT NULL DEFAULT 0 CHECK (tickets_completed >= 0),
    tickets_failed    INTEGER NOT NULL DEFAULT 0 CHECK (tickets_failed >= 0),
    tickets_orphaned  INTEGER NOT NULL DEFAULT 0 CHECK (tickets_orphaned >= 0),
    last_updated_at   INTEGER NOT NULL,
    PRIMARY KEY (team_id, member_id)
  ) STRICT;
`;

// ---------------------------------------------------------------------------
// KanbanStore
// ---------------------------------------------------------------------------

export class KanbanStore {
  private readonly db: Database.Database;
  /**
   * Team this board belongs to, or `null` for a solo personality board. When
   * `null`, terminal transitions skip the `team_member_stats` update entirely.
   */
  private readonly teamId: string | null;
  private readonly blockRecurrenceLimit: number;
  /** WIP caps; `null` = uncapped. See `KanbanStoreOptions.maxInProgress`. */
  private readonly maxInProgress: number | null;
  private readonly maxInProgressPerProfile: number | null;

  constructor(dbPath: string, opts: KanbanStoreOptions = {}) {
    this.teamId = opts.teamId ?? null;
    this.blockRecurrenceLimit = opts.blockRecurrenceLimit ?? DEFAULT_BLOCK_RECURRENCE_LIMIT;
    this.maxInProgress = opts.maxInProgress ?? null;
    this.maxInProgressPerProfile = opts.maxInProgressPerProfile ?? null;
    // mkdir -p the parent directory. Same raw-fs exception that session-sqlite uses
    // for path setup (the `Storage` abstraction is for ~/.ethos/ data IO, not for
    // bootstrapping the SQLite file's enclosing directory). `:memory:` has no
    // parent path, so skip.
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    // Version check FIRST — refuse to touch a DB whose schema is newer than this code.
    const versionRows = this.db.pragma('user_version') as Array<{ user_version: number }>;
    const currentVersion = versionRows[0]?.user_version ?? 0;
    if (currentVersion > 6) {
      throw new Error(
        `kanban-store: database user_version=${currentVersion} is newer than code (6); refusing to open to avoid downgrade`,
      );
    }
    // SCHEMA describes the current (v4) shape. A fresh DB (user_version=0) gets it
    // directly via CREATE TABLE IF NOT EXISTS; an existing v1/v2/v3 DB skips the
    // table creation (IF NOT EXISTS) and is brought forward by the migration chain
    // below. The v3→v4 step is purely additive — `team_member_stats` is created by
    // `exec(SCHEMA)` above on every version, so v3 needs only the version bump.
    this.db.exec(SCHEMA);
    if (currentVersion === 0) {
      this.db.pragma('user_version = 6');
    } else {
      // Stepwise migration chain: a v1 DB runs v1->v2->v2->v3 then the v3->v4
      // bump; a v2 DB runs v2->v3 then the bump; a v3 DB just bumps. The v1ToV2
      // and v2ToV3 migrators bump user_version inside their own transactions;
      // the v3->v4 step is just `pragma user_version = 4` since the additive
      // table is already created by `exec(SCHEMA)`.
      if (currentVersion === 1) {
        this.migrateV1ToV2();
      }
      if (currentVersion <= 2) {
        this.migrateV2ToV3();
      }
      if (currentVersion <= 3) {
        this.db.pragma('user_version = 4');
      }
      if (currentVersion <= 4) {
        this.migrateV4ToV5();
      }
      if (currentVersion <= 5) {
        this.migrateV5ToV6();
      }
    }
  }

  /**
   * Bring a v1 board forward to v2: add the `max_retries` / `retry_count` columns
   * and widen the `tasks.status` CHECK to include `'failed'`.
   *
   * `ALTER TABLE ADD COLUMN` handles the new columns even on a STRICT table (the
   * NOT NULL column carries a DEFAULT). Widening a CHECK constraint, though, is
   * not something SQLite can ALTER — it needs the standard table-rebuild dance:
   * build the new table, copy rows, drop the old one, rename, then recreate the
   * indexes and FTS triggers that referenced `tasks`.
   *
   * The ADD COLUMN steps, the table rebuild, and the `user_version` bump all run
   * inside ONE transaction so the migration is atomic: a failure anywhere rolls
   * the whole thing back, leaving a clean v1 DB the next open can retry. (Only
   * `PRAGMA foreign_keys` is set outside — it is a no-op inside a transaction —
   * and is needed off because task_comments/task_links/task_runs/task_events all
   * FK onto tasks(id); a `foreign_key_check` runs before commit.)
   */
  private migrateV1ToV2(): void {
    this.db.pragma('foreign_keys = OFF');
    try {
      const rebuild = this.db.transaction(() => {
        this.db.exec(`
          ALTER TABLE tasks ADD COLUMN max_retries INTEGER;
          ALTER TABLE tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;

          DROP TRIGGER IF EXISTS tasks_fts_ai;
          DROP TRIGGER IF EXISTS tasks_fts_au;
          DROP TRIGGER IF EXISTS tasks_fts_ad;
          DROP INDEX IF EXISTS tasks_idem;
          DROP INDEX IF EXISTS tasks_status_assignee;
          DROP INDEX IF EXISTS tasks_scheduled;

          CREATE TABLE tasks_new (
            id              TEXT PRIMARY KEY,
            title           TEXT NOT NULL,
            body            TEXT NOT NULL DEFAULT '',
            assignee        TEXT,
            status          TEXT NOT NULL
                            CHECK (status IN ('todo','ready','running','blocked','done','archived','scheduled','failed')),
            priority        INTEGER NOT NULL DEFAULT 0,
            workspace_mode  TEXT NOT NULL DEFAULT 'scratch'
                            CHECK (workspace_mode IN ('scratch','worktree','dir')),
            workspace_path  TEXT,
            scheduled_for   INTEGER,
            idempotency_key TEXT,
            current_run_id  TEXT,
            max_retries     INTEGER CHECK (max_retries IS NULL OR max_retries >= 0),
            retry_count     INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL
          ) STRICT;

          INSERT INTO tasks_new
            SELECT id, title, body, assignee, status, priority, workspace_mode,
                   workspace_path, scheduled_for, idempotency_key, current_run_id,
                   max_retries, retry_count, created_at, updated_at
            FROM tasks;

          DROP TABLE tasks;
          ALTER TABLE tasks_new RENAME TO tasks;

          CREATE UNIQUE INDEX tasks_idem ON tasks(idempotency_key)
            WHERE idempotency_key IS NOT NULL;
          CREATE INDEX tasks_status_assignee ON tasks(status, assignee);
          CREATE INDEX tasks_scheduled ON tasks(scheduled_for)
            WHERE scheduled_for IS NOT NULL;

          CREATE TRIGGER tasks_fts_ai AFTER INSERT ON tasks BEGIN
            INSERT INTO task_fts(task_id, title, body, comments)
            VALUES (new.id, new.title, new.body, '');
          END;

          CREATE TRIGGER tasks_fts_au AFTER UPDATE OF title, body ON tasks BEGIN
            UPDATE task_fts SET title = new.title, body = new.body
            WHERE task_id = new.id;
          END;

          CREATE TRIGGER tasks_fts_ad AFTER DELETE ON tasks BEGIN
            DELETE FROM task_fts WHERE task_id = old.id;
          END;
        `);
        const violations = this.db.pragma('foreign_key_check') as unknown[];
        if (violations.length > 0) {
          throw new Error(
            `kanban-store: v1→v2 migration left ${violations.length} foreign-key violation(s)`,
          );
        }
        // Bump inside the transaction so version and schema move together: a
        // rollback leaves a clean v1 DB, never a v1-versioned DB with v2 columns.
        this.db.pragma('user_version = 2');
      });
      rebuild();
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
  }

  /**
   * Bring a v2 board forward to v3: add the `acceptance_criteria` column and
   * widen the `tasks.status` CHECK to include `'needs_revision'`.
   *
   * Modelled exactly on `migrateV1ToV2`: `ALTER TABLE ADD COLUMN` handles the
   * new nullable column, but widening a CHECK constraint needs the standard
   * SQLite table-rebuild dance — build the new table, copy rows, drop the old
   * one, rename, then recreate the indexes and FTS triggers that referenced
   * `tasks`. The ADD COLUMN, the rebuild, and the `user_version` bump all run
   * inside ONE transaction so the migration is atomic. `PRAGMA foreign_keys`
   * is set OFF outside (it is a no-op inside a transaction); a
   * `foreign_key_check` runs before commit.
   */
  private migrateV2ToV3(): void {
    this.db.pragma('foreign_keys = OFF');
    try {
      const rebuild = this.db.transaction(() => {
        this.db.exec(`
          ALTER TABLE tasks ADD COLUMN acceptance_criteria TEXT;

          DROP TRIGGER IF EXISTS tasks_fts_ai;
          DROP TRIGGER IF EXISTS tasks_fts_au;
          DROP TRIGGER IF EXISTS tasks_fts_ad;
          DROP INDEX IF EXISTS tasks_idem;
          DROP INDEX IF EXISTS tasks_status_assignee;
          DROP INDEX IF EXISTS tasks_scheduled;

          CREATE TABLE tasks_new (
            id              TEXT PRIMARY KEY,
            title           TEXT NOT NULL,
            body            TEXT NOT NULL DEFAULT '',
            assignee        TEXT,
            status          TEXT NOT NULL
                            CHECK (status IN ('todo','ready','running','blocked','done','archived','scheduled','failed','needs_revision')),
            priority        INTEGER NOT NULL DEFAULT 0,
            workspace_mode  TEXT NOT NULL DEFAULT 'scratch'
                            CHECK (workspace_mode IN ('scratch','worktree','dir')),
            workspace_path  TEXT,
            scheduled_for   INTEGER,
            idempotency_key TEXT,
            current_run_id  TEXT,
            max_retries     INTEGER CHECK (max_retries IS NULL OR max_retries >= 0),
            retry_count     INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
            acceptance_criteria TEXT,
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL
          ) STRICT;

          INSERT INTO tasks_new
            SELECT id, title, body, assignee, status, priority, workspace_mode,
                   workspace_path, scheduled_for, idempotency_key, current_run_id,
                   max_retries, retry_count, acceptance_criteria, created_at, updated_at
            FROM tasks;

          DROP TABLE tasks;
          ALTER TABLE tasks_new RENAME TO tasks;

          CREATE UNIQUE INDEX tasks_idem ON tasks(idempotency_key)
            WHERE idempotency_key IS NOT NULL;
          CREATE INDEX tasks_status_assignee ON tasks(status, assignee);
          CREATE INDEX tasks_scheduled ON tasks(scheduled_for)
            WHERE scheduled_for IS NOT NULL;

          CREATE TRIGGER tasks_fts_ai AFTER INSERT ON tasks BEGIN
            INSERT INTO task_fts(task_id, title, body, comments)
            VALUES (new.id, new.title, new.body, '');
          END;

          CREATE TRIGGER tasks_fts_au AFTER UPDATE OF title, body ON tasks BEGIN
            UPDATE task_fts SET title = new.title, body = new.body
            WHERE task_id = new.id;
          END;

          CREATE TRIGGER tasks_fts_ad AFTER DELETE ON tasks BEGIN
            DELETE FROM task_fts WHERE task_id = old.id;
          END;
        `);
        const violations = this.db.pragma('foreign_key_check') as unknown[];
        if (violations.length > 0) {
          throw new Error(
            `kanban-store: v2→v3 migration left ${violations.length} foreign-key violation(s)`,
          );
        }
        // Bump inside the transaction so version and schema move together: a
        // rollback leaves a clean v2 DB, never a v2-versioned DB with v3 columns.
        this.db.pragma('user_version = 3');
      });
      rebuild();
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
  }

  private migrateV4ToV5(): void {
    try {
      this.db.exec(`
        ALTER TABLE task_runs ADD COLUMN completed_by_id TEXT;
        ALTER TABLE task_runs ADD COLUMN completed_by_name TEXT;
      `);
    } catch (_e) {
      // Columns may already exist on a fresh DB where exec(SCHEMA) created
      // them via CREATE TABLE IF NOT EXISTS. Ignore duplicate-column errors.
    }
    this.db.pragma('user_version = 5');
  }

  /**
   * Bring a v5 board forward to v6: add `block_kind` / `block_recurrence_count`
   * to `tasks` for the unblock-loop breaker (see `blockRun`).
   *
   * Unlike `migrateV4ToV5` (plain `ALTER TABLE ADD COLUMN` on `task_runs`), this
   * uses the full table-rebuild dance from `migrateV1ToV2`/`migrateV2ToV3` even
   * though no CHECK constraint needs widening (`tasks.status` already allows
   * `needs_revision` since v3). Reason: `updated_at` is `tasks`' last column with
   * no trailing table-level constraint after it, so a plain ADD COLUMN would be
   * appended past the position SQLite's DDL-text reconstruction expects — it
   * reuses the original trailing whitespace before the old closing paren as a
   * separator, producing a schema string that's syntactically fine but NOT
   * byte-identical (post-whitespace-normalization) to a fresh `CREATE TABLE`
   * with the same final columns — which is exactly what the
   * "fully-migrated DB is structurally identical to a fresh DB" convergence
   * test (and the invariant it's guarding) checks. The rebuild sidesteps that
   * entirely: `tasks_new` is created with the literal final shape, so its
   * stored SQL always matches SCHEMA's.
   */
  private migrateV5ToV6(): void {
    this.db.pragma('foreign_keys = OFF');
    try {
      const rebuild = this.db.transaction(() => {
        this.db.exec(`
          DROP TRIGGER IF EXISTS tasks_fts_ai;
          DROP TRIGGER IF EXISTS tasks_fts_au;
          DROP TRIGGER IF EXISTS tasks_fts_ad;
          DROP INDEX IF EXISTS tasks_idem;
          DROP INDEX IF EXISTS tasks_status_assignee;
          DROP INDEX IF EXISTS tasks_scheduled;

          CREATE TABLE tasks_new (
            id              TEXT PRIMARY KEY,
            title           TEXT NOT NULL,
            body            TEXT NOT NULL DEFAULT '',
            assignee        TEXT,
            status          TEXT NOT NULL
                            CHECK (status IN ('todo','ready','running','blocked','done','archived','scheduled','failed','needs_revision')),
            priority        INTEGER NOT NULL DEFAULT 0,
            workspace_mode  TEXT NOT NULL DEFAULT 'scratch'
                            CHECK (workspace_mode IN ('scratch','worktree','dir')),
            workspace_path  TEXT,
            scheduled_for   INTEGER,
            idempotency_key TEXT,
            current_run_id  TEXT,
            max_retries     INTEGER CHECK (max_retries IS NULL OR max_retries >= 0),
            retry_count     INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
            acceptance_criteria TEXT,
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL,
            block_kind      TEXT CHECK (block_kind IS NULL OR block_kind IN ('dependency','needs_input','capability','transient')),
            block_recurrence_count INTEGER NOT NULL DEFAULT 0 CHECK (block_recurrence_count >= 0)
          ) STRICT;

          INSERT INTO tasks_new
            (id, title, body, assignee, status, priority, workspace_mode, workspace_path,
             scheduled_for, idempotency_key, current_run_id, max_retries, retry_count,
             acceptance_criteria, created_at, updated_at)
            SELECT id, title, body, assignee, status, priority, workspace_mode,
                   workspace_path, scheduled_for, idempotency_key, current_run_id,
                   max_retries, retry_count, acceptance_criteria, created_at, updated_at
            FROM tasks;

          DROP TABLE tasks;
          ALTER TABLE tasks_new RENAME TO tasks;

          CREATE UNIQUE INDEX tasks_idem ON tasks(idempotency_key)
            WHERE idempotency_key IS NOT NULL;
          CREATE INDEX tasks_status_assignee ON tasks(status, assignee);
          CREATE INDEX tasks_scheduled ON tasks(scheduled_for)
            WHERE scheduled_for IS NOT NULL;

          CREATE TRIGGER tasks_fts_ai AFTER INSERT ON tasks BEGIN
            INSERT INTO task_fts(task_id, title, body, comments)
            VALUES (new.id, new.title, new.body, '');
          END;

          CREATE TRIGGER tasks_fts_au AFTER UPDATE OF title, body ON tasks BEGIN
            UPDATE task_fts SET title = new.title, body = new.body
            WHERE task_id = new.id;
          END;

          CREATE TRIGGER tasks_fts_ad AFTER DELETE ON tasks BEGIN
            DELETE FROM task_fts WHERE task_id = old.id;
          END;
        `);
        const violations = this.db.pragma('foreign_key_check') as unknown[];
        if (violations.length > 0) {
          throw new Error(
            `kanban-store: v5→v6 migration left ${violations.length} foreign-key violation(s)`,
          );
        }
        // Bump inside the transaction so version and schema move together: a
        // rollback leaves a clean v5 DB, never a v5-versioned DB with v6 columns.
        this.db.pragma('user_version = 6');
      });
      rebuild();
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
  }

  createTask(input: CreateTaskInput): Task {
    const idempotencyKey = input.idempotencyKey ?? null;
    const id = newTaskId();
    const now = Date.now();
    const body = input.body ?? '';
    const assignee = input.assignee ?? null;
    const priority = input.priority ?? 0;
    const workspaceMode: WorkspaceMode = input.workspaceMode ?? 'scratch';
    const scheduledFor = input.scheduledFor ?? null;
    const status: TaskStatus = scheduledFor !== null ? 'scheduled' : 'todo';
    const maxRetries = input.maxRetries ?? null;
    if (maxRetries !== null && (!Number.isInteger(maxRetries) || maxRetries < 0)) {
      throw new Error(`createTask: maxRetries must be a non-negative integer or null`);
    }
    const acceptanceCriteria = input.acceptanceCriteria ?? null;
    const parents = input.parents ?? [];
    const actor = input.actor ?? 'system';

    const insertTask = this.db.prepare(
      `INSERT INTO tasks
       (id, title, body, assignee, status, priority, workspace_mode, workspace_path,
        scheduled_for, idempotency_key, current_run_id, max_retries, retry_count,
        acceptance_criteria, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );

    const tx = this.db.transaction((): string => {
      // Race-safe idempotency: try insert, catch unique constraint, then look up.
      // The catch path covers two scenarios:
      // (1) a concurrent caller raced us between any SELECT-then-INSERT
      // (2) this createTask is nested inside another transaction where
      //     tx.immediate() degrades to a SAVEPOINT and won't acquire the write lock at BEGIN
      if (idempotencyKey !== null) {
        const existing = this.db
          .prepare('SELECT id FROM tasks WHERE idempotency_key = ?')
          .get(idempotencyKey) as { id: string } | undefined;
        if (existing) return existing.id;
      }

      try {
        insertTask.run(
          id,
          input.title,
          body,
          assignee,
          status,
          priority,
          workspaceMode,
          null,
          scheduledFor,
          idempotencyKey,
          null,
          maxRetries,
          0,
          acceptanceCriteria,
          now,
          now,
        );
      } catch (err) {
        // If we raced another caller with the same idempotency_key, return their row.
        const msg = err instanceof Error ? err.message : String(err);
        if (
          idempotencyKey !== null &&
          /UNIQUE constraint failed: tasks\.idempotency_key/.test(msg)
        ) {
          const winner = this.db
            .prepare('SELECT id FROM tasks WHERE idempotency_key = ?')
            .get(idempotencyKey) as { id: string } | undefined;
          if (winner) return winner.id;
        }
        throw err;
      }
      this.emit(id, 'created', actor, { status });
      // Route parent links through the same cycle-checked path as `link()` so we have
      // one code path for the invariant. The check is trivially true for a fresh task
      // (no descendants yet), but we want a single owner of the rule.
      for (const parentId of parents) {
        this.link(parentId, id, actor);
      }
      return id;
    });
    const finalId = tx.immediate();

    const task = this.getTask(finalId);
    if (!task) throw new Error(`createTask: inserted task ${finalId} not found`);
    return task;
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  listTasks(filter: ListTasksFilter = {}): Task[] {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let join = '';

    if (filter.q !== undefined) {
      join += ' JOIN task_fts ON task_fts.task_id = t.id';
      conditions.push('task_fts MATCH ?');
      values.push(escapeFtsQuery(filter.q));
    }
    if (filter.status !== undefined) {
      conditions.push('t.status = ?');
      values.push(filter.status);
    }
    if (filter.assignee !== undefined) {
      conditions.push('t.assignee = ?');
      values.push(filter.assignee);
    }
    if (filter.parentId !== undefined) {
      join += ' JOIN task_links l ON l.child_id = t.id';
      conditions.push('l.parent_id = ?');
      values.push(filter.parentId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit ?? -1;
    const order = filter.q !== undefined ? 'bm25(task_fts)' : 't.priority DESC, t.created_at DESC';

    // DISTINCT defends against any future case where joins (FTS shadow table or
    // task_links) could multiply rows — the public API returns tasks, not joined rows.
    const rows = this.db
      .prepare(`SELECT DISTINCT t.* FROM tasks t${join} ${where} ORDER BY ${order} LIMIT ?`)
      .all(...values, limit) as TaskRow[];
    return rows.map(rowToTask);
  }

  /**
   * Refuse a claim that would exceed the configured WIP caps. Throws — the same
   * rejection channel `updateStatus` already uses for an unknown task id, which
   * the kanban tools turn into a tool error via `storeError`. Unset caps never
   * throw. The claiming task is excluded from the count so a re-claim of a task
   * already marked `running` is not blocked by itself.
   */
  private assertWipCapacity(taskId: string, assignee: string | null): void {
    if (this.maxInProgress !== null) {
      const row = this.db
        .prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'running' AND id != ?")
        .get(taskId) as { n: number };
      if (row.n >= this.maxInProgress) {
        throw new Error(
          `kanban WIP limit reached: ${row.n} task(s) already running (maxInProgress=${this.maxInProgress})`,
        );
      }
    }
    if (this.maxInProgressPerProfile !== null && assignee !== null) {
      const row = this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM tasks WHERE status = 'running' AND assignee = ? AND id != ?",
        )
        .get(assignee, taskId) as { n: number };
      if (row.n >= this.maxInProgressPerProfile) {
        throw new Error(
          `kanban WIP limit reached for ${assignee}: ${row.n} task(s) already running (maxInProgressPerProfile=${this.maxInProgressPerProfile})`,
        );
      }
    }
  }

  updateStatus(taskId: string, status: TaskStatus, reason?: string, actor = 'system'): Task {
    const now = Date.now();

    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare(
          'SELECT status, assignee, current_run_id, max_retries, retry_count FROM tasks WHERE id = ?',
        )
        .get(taskId) as
        | {
            status: TaskStatus;
            assignee: string | null;
            current_run_id: string | null;
            max_retries: number | null;
            retry_count: number;
          }
        | undefined;
      if (!row) throw new Error(`updateStatus: task ${taskId} not found`);
      const oldStatus = row.status;
      const oldRunId = row.current_run_id;
      // The actual status this transition lands on. Normally `status`, but a
      // re-claim that blows the retry budget is forced to 'failed' below.
      let effectiveStatus = status;
      let effectiveReason = reason ?? null;

      let runStarted = false;
      let runCancelled = false;

      if (status === 'running' && oldRunId === null) {
        // WIP caps first: a claim that would push the board (or the assignee)
        // past its limit is refused before anything is written. Inside the same
        // transaction as the run INSERT, so two concurrent claims cannot both
        // read "one slot left" and both take it.
        this.assertWipCapacity(taskId, row.assignee);
        // Open a new run as a side-effect of the status flip. If the task already
        // has an ended run, opening another is a "re-claim" (the prior attempt
        // failed or was reclaimed) — bump retry_count.
        //
        // Budget enforcement lives HERE, in the same transaction as the increment,
        // so the retry budget is a store invariant rather than a discipline every
        // caller has to remember: a re-claim that would push retry_count past
        // max_retries fails the task instead of opening another run.
        const priorRuns = this.db
          .prepare('SELECT COUNT(*) AS n FROM task_runs WHERE task_id = ?')
          .get(taskId) as { n: number };
        const reclaimed = priorRuns.n > 0;
        const nextRetryCount = row.retry_count + (reclaimed ? 1 : 0);
        const budgetExhausted = row.max_retries !== null && nextRetryCount > row.max_retries;

        if (budgetExhausted) {
          // No new run — the task is done retrying. Record the bumped count so
          // the board shows how far past budget it got, then fail it.
          this.db
            .prepare('UPDATE tasks SET status = ?, retry_count = ?, updated_at = ? WHERE id = ?')
            .run('failed', nextRetryCount, now, taskId);
          effectiveStatus = 'failed';
          effectiveReason = 'retry_budget_exhausted';
        } else {
          const runId = newRunId();
          this.db
            .prepare(
              `INSERT INTO task_runs (id, task_id, started_at, last_heartbeat_at)
               VALUES (?, ?, ?, ?)`,
            )
            .run(runId, taskId, now, now);
          this.db
            .prepare(
              'UPDATE tasks SET status = ?, current_run_id = ?, retry_count = ?, updated_at = ? WHERE id = ?',
            )
            .run('running', runId, nextRetryCount, now, taskId);
          runStarted = true;
        }
      } else if (oldStatus === 'running' && status !== 'running' && oldRunId !== null) {
        // Caller is leaving 'running' without going through completeRun/blockRun.
        // Auto-cancel the open run so task status and run state stay consistent.
        const result = this.db
          .prepare(
            `UPDATE task_runs SET ended_at = ?, outcome = ?
             WHERE id = ? AND ended_at IS NULL`,
          )
          .run(now, 'cancelled', oldRunId);
        this.db
          .prepare(
            'UPDATE tasks SET status = ?, current_run_id = NULL, updated_at = ? WHERE id = ?',
          )
          .run(status, now, taskId);
        runCancelled = result.changes === 1;
      } else {
        this.db
          .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
          .run(status, now, taskId);
      }

      if (oldStatus !== effectiveStatus) {
        this.emit(taskId, 'status_changed', actor, {
          from: oldStatus,
          to: effectiveStatus,
          reason: effectiveReason,
        });
        // Terminal-failure transitions credit the assignee's failed counter.
        // Both Phase 1's budget-exhaustion `failed` and Phase 3's hook-rejection
        // `needs_revision` flow through here. Gated on an actual status change so
        // a redundant updateStatus(failed) on an already-failed task is a no-op.
        if (effectiveStatus === 'failed' || effectiveStatus === 'needs_revision') {
          this.bumpMemberStat(row.assignee, 'tickets_failed');
        }
      }
      if (runStarted) this.emit(taskId, 'run_started', actor, {});
      if (runCancelled) {
        this.emit(taskId, 'run_completed', actor, { outcome: 'cancelled', summary: null });
      }
    });
    tx();

    return this.getTask(taskId) as Task;
  }

  completeRun(
    taskId: string,
    summary: string,
    actor = 'system',
    completedBy?: { id: string; name: string },
  ): Task {
    return this.endRun(taskId, 'done', 'completed', summary, actor, { completedBy });
  }

  /**
   * End the open run as blocked. `kind` (optional) categorizes *why*, distinct from
   * the free-text `reason` — it's what the unblock-loop breaker compares run to run.
   *
   * Breaker semantics: if this block's `kind` matches the task's previous `blockKind`
   * (both must be set — an unspecified `kind` never counts as a repeat), the
   * consecutive-same-kind counter increments; otherwise it resets to 1 (or 0 if no
   * `kind` was given at all, since an unlabelled block carries no recurrence signal).
   * Once the counter reaches `blockRecurrenceLimit`, this call lands the task on
   * `needs_revision` (per plan D1) instead of `blocked` — same atomic transition,
   * so the check can never race a concurrent re-claim. The counter (and `blockKind`)
   * resets to 0/null on the next `completeRun`, matching "no successful completion
   * in between" from the plan; it is untouched by `kanban_unblock` (a plain
   * `updateStatus`, not `endRun`), so an unblock-then-reblock streak still counts.
   */
  blockRun(taskId: string, reason: string, actor = 'system', kind?: BlockKind): Task {
    // The reason is captured both on the run (summary column) and as a comment so
    // it shows up in the human-readable thread. Atomic with the block transition.
    return this.endRun(taskId, 'blocked', 'blocked', reason, actor, { comment: reason, kind });
  }

  private endRun(
    taskId: string,
    newStatus: TaskStatus,
    outcome: RunOutcome,
    summary: string | null,
    actor: string,
    opts: {
      comment?: string;
      completedBy?: { id: string; name: string };
      kind?: BlockKind;
    } = {},
  ): Task {
    const now = Date.now();
    // The whole "claim the run and end it" sequence runs inside one transaction so that
    // a concurrent writer can't end the same run between our read and our write.
    const tx = this.db.transaction((): Task => {
      const row = this.db
        .prepare(
          'SELECT status, assignee, current_run_id, block_kind, block_recurrence_count FROM tasks WHERE id = ?',
        )
        .get(taskId) as
        | {
            status: TaskStatus;
            assignee: string | null;
            current_run_id: string | null;
            block_kind: BlockKind | null;
            block_recurrence_count: number;
          }
        | undefined;
      if (!row) throw new Error(`endRun: task ${taskId} not found`);
      if (row.current_run_id === null) {
        throw new Error(`no open run: task ${taskId} has no current run to end`);
      }
      const result = this.db
        .prepare(
          `UPDATE task_runs SET ended_at = ?, outcome = ?, summary = ?, completed_by_id = ?, completed_by_name = ?
           WHERE id = ? AND ended_at IS NULL`,
        )
        .run(
          now,
          outcome,
          summary,
          opts.completedBy?.id ?? null,
          opts.completedBy?.name ?? null,
          row.current_run_id,
        );
      if (result.changes !== 1) {
        throw new Error(`no open run: race ended run ${row.current_run_id} concurrently`);
      }

      // The unblock-loop breaker: only the blocked path tracks/consults it, and
      // only `done` clears it (see the doc comment on `blockRun`).
      let effectiveStatus = newStatus;
      let nextBlockKind = row.block_kind;
      let nextBlockRecurrenceCount = row.block_recurrence_count;
      let breached = false;
      if (newStatus === 'blocked') {
        nextBlockKind = opts.kind ?? null;
        nextBlockRecurrenceCount =
          opts.kind !== undefined && opts.kind === row.block_kind
            ? row.block_recurrence_count + 1
            : opts.kind !== undefined
              ? 1
              : 0;
        if (nextBlockRecurrenceCount >= this.blockRecurrenceLimit) {
          effectiveStatus = 'needs_revision';
          breached = true;
        }
      } else if (newStatus === 'done') {
        nextBlockKind = null;
        nextBlockRecurrenceCount = 0;
      }

      this.db
        .prepare(
          `UPDATE tasks
           SET status = ?, current_run_id = NULL, block_kind = ?, block_recurrence_count = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(effectiveStatus, nextBlockKind, nextBlockRecurrenceCount, now, taskId);
      // Terminal transition: a `done` landing credits the assignee's completed
      // counter; a breaker-forced `needs_revision` counts the same as any other
      // failed-transition (mirrors `updateStatus`'s retry-budget-exhaustion path).
      // `blocked` on its own is not terminal for stats — the task can be reclaimed
      // and retried — so only these two bump here.
      if (effectiveStatus === 'done') {
        this.bumpMemberStat(row.assignee, 'tickets_completed');
      } else if (effectiveStatus === 'needs_revision') {
        this.bumpMemberStat(row.assignee, 'tickets_failed');
      }
      if (opts.comment !== undefined) {
        const commentId = newCommentId();
        this.db
          .prepare(
            'INSERT INTO task_comments (id, task_id, author, body, created_at) VALUES (?,?,?,?,?)',
          )
          .run(commentId, taskId, actor, opts.comment, now);
        this.emit(taskId, 'commented', actor, { commentId });
      }
      this.emit(taskId, 'run_completed', actor, {
        outcome,
        summary,
        completedBy: opts.completedBy ?? null,
      });
      if (row.status !== effectiveStatus) {
        this.emit(taskId, 'status_changed', actor, {
          from: row.status,
          to: effectiveStatus,
          ...(breached ? { reason: 'block_recurrence_limit' } : {}),
        });
      }
      return this.getTask(taskId) as Task;
    });
    return tx();
  }

  heartbeatRun(taskId: string, note?: string, actor = 'system'): void {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      const row = this.db.prepare('SELECT current_run_id FROM tasks WHERE id = ?').get(taskId) as
        | { current_run_id: string | null }
        | undefined;
      if (!row) throw new Error(`heartbeatRun: task ${taskId} not found`);
      if (row.current_run_id === null) {
        throw new Error(`no open run: task ${taskId} has no current run to heartbeat`);
      }
      const result = this.db
        .prepare('UPDATE task_runs SET last_heartbeat_at = ? WHERE id = ? AND ended_at IS NULL')
        .run(now, row.current_run_id);
      if (result.changes !== 1) {
        throw new Error(`no open run: race ended run ${row.current_run_id} concurrently`);
      }
      // Bump the task's `updated_at` too so it tracks "last activity" — a
      // healthy long-running task that heartbeats stays fresh, while a stuck
      // agent that stopped heartbeating goes stale. The staleness-reclaim path
      // (findStaleRunningTasks) relies on this.
      this.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, taskId);
      this.emit(taskId, 'heartbeat', actor, { note: note ?? null });
    });
    tx();
  }

  listRuns(taskId: string): TaskRun[] {
    // rowid tie-breaks same-millisecond inserts; same trick the session-sqlite store uses.
    const rows = this.db
      .prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at ASC, rowid ASC')
      .all(taskId) as TaskRunRow[];
    return rows.map(rowToRun);
  }

  addComment(taskId: string, author: string, body: string): TaskComment {
    const id = newCommentId();
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO task_comments (id, task_id, author, body, created_at) VALUES (?,?,?,?,?)',
        )
        .run(id, taskId, author, body, now);
      this.emit(taskId, 'commented', author, { commentId: id });
    });
    tx();
    return { id, taskId, author, body, createdAt: now };
  }

  listComments(taskId: string): TaskComment[] {
    const rows = this.db
      .prepare('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(taskId) as TaskCommentRow[];
    return rows.map(rowToComment);
  }

  assign(taskId: string, assignee: string | null, actor = 'system'): Task {
    const now = Date.now();
    const tx = this.db.transaction((): Task => {
      const result = this.db
        .prepare('UPDATE tasks SET assignee = ?, updated_at = ? WHERE id = ?')
        .run(assignee, now, taskId);
      if (result.changes === 0) {
        throw new Error(`assign: task ${taskId} not found`);
      }
      this.emit(taskId, 'assigned', actor, { assignee });
      return this.getTask(taskId) as Task;
    });
    return tx();
  }

  archive(taskId: string, actor = 'system'): Task {
    // updateStatus owns run + status changes (auto-cancels an open run if any).
    // We wrap it in an outer tx so the 'archived' event lands atomically with the change.
    const tx = this.db.transaction((): Task => {
      const updated = this.updateStatus(taskId, 'archived', undefined, actor);
      this.emit(taskId, 'archived', actor, {});
      return updated;
    });
    return tx();
  }

  // One outer transaction wrapping N per-task updateStatus calls: any invalid
  // id anywhere in taskIds throws and rolls back the whole batch, not just
  // the tasks up to that point (same nested-transaction idiom as archive()).
  bulkUpdateStatus(taskIds: string[], status: TaskStatus, actor = 'system'): Task[] {
    const tx = this.db.transaction((): Task[] => {
      return taskIds.map((id) => this.updateStatus(id, status, undefined, actor));
    });
    return tx();
  }

  // Same all-or-nothing shape as bulkUpdateStatus, composed over assign().
  bulkAssign(taskIds: string[], assignee: string | null, actor = 'system'): Task[] {
    const tx = this.db.transaction((): Task[] => {
      return taskIds.map((id) => this.assign(id, assignee, actor));
    });
    return tx();
  }

  /**
   * Atomically create a root/blackboard task + N worker tasks + an optional
   * verifier task + an optional synthesizer task (Lane A Phase 5's swarm-graph
   * primitive). One outer transaction wraps every `createTask`/`updateStatus`
   * call below — same nested-transaction idiom as `bulkUpdateStatus`/`archive`
   * — so a failure partway through (a bad worker, a store error) rolls back
   * the whole graph: no orphan root/worker tasks survive.
   *
   * The root is created via the normal `createTask` path (which always starts
   * a fresh task at `todo`/`scheduled` — `CreateTaskInput` has no `status`
   * field) then immediately transitioned to `done` in this same transaction.
   * Because both calls run inside one transaction, no external reader ever
   * observes the root at `todo`: the graph commits as a unit with the root
   * already done, so `promoteReady()` sees every worker as promotable on its
   * very next dispatcher tick.
   *
   * The root's assignee is left `null` — the same "transparent container"
   * rule `kanban_create_goal` relies on (see `promoteReady`'s doc comment):
   * a parent with no assignee never gates its children regardless of its own
   * status. Marking it `done` immediately is board hygiene, not a promotion
   * requirement — there is no assignee who could ever transition it otherwise.
   *
   * Worker/verifier/synthesizer parent edges are set via `createTask`'s own
   * `parents` option, which routes through `link()` internally (see the
   * comment in `createTask`) — not raw SQL.
   *
   * `verifierPersonality`/`synthesizerPersonality` are each optional; omitting
   * a tier collapses the chain past it: with no verifier, the synthesizer (if
   * any) parents directly off every worker instead of off a verifier task.
   */
  createSwarm(input: CreateSwarmInput, actor = 'system'): SwarmResult {
    const tx = this.db.transaction((): SwarmResult => {
      const root = this.createTask({
        title: `Swarm goal: ${truncateForTitle(input.goal)}`,
        body: input.goal,
        assignee: null,
        actor,
      });
      this.updateStatus(root.id, 'done', 'swarm root — shared context', actor);

      const workers = input.workers.map((w) =>
        this.createTask({
          title: `Swarm worker (${w.personality}): ${truncateForTitle(w.prompt)}`,
          body: w.prompt,
          assignee: w.personality,
          parents: [root.id],
          actor,
        }),
      );
      const workerIds = workers.map((w) => w.id);

      let verifierId: string | null = null;
      if (input.verifierPersonality) {
        const verifier = this.createTask({
          title: 'Verify swarm worker output',
          body: `Verify the worker results below against this goal:\n\n${input.goal}`,
          assignee: input.verifierPersonality,
          parents: workerIds,
          actor,
        });
        verifierId = verifier.id;
      }

      let synthesizerId: string | null = null;
      if (input.synthesizerPersonality) {
        const synthesizer = this.createTask({
          title: 'Synthesize swarm results',
          body: `Synthesize the final result for this goal:\n\n${input.goal}`,
          assignee: input.synthesizerPersonality,
          parents: verifierId !== null ? [verifierId] : workerIds,
          actor,
        });
        synthesizerId = synthesizer.id;
      }

      return { rootId: root.id, workerIds, verifierId, synthesizerId };
    });
    return tx();
  }

  link(parentId: string, childId: string, actor = 'system'): void {
    if (parentId === childId) {
      throw new Error(`cycle: ${childId} cannot be its own parent`);
    }
    // Cycle check is a recursive walk over task_links — O(graph_size) per insert.
    // Plan A targets per-personality boards (≲ low thousands of tasks); if Plan B
    // scales to large shared boards, swap this for a closure-table maintained on link.
    // Check + insert in one transaction so concurrent writers can't both pass
    // the check and then both insert edges that close a cycle.
    const tx = this.db.transaction(() => {
      const ancestor = this.db
        .prepare(
          `WITH RECURSIVE ancestors(id) AS (
             SELECT parent_id FROM task_links WHERE child_id = ?
             UNION
             SELECT l.parent_id FROM task_links l JOIN ancestors a ON l.child_id = a.id
           )
           SELECT 1 AS hit FROM ancestors WHERE id = ? LIMIT 1`,
        )
        .get(parentId, childId) as { hit: number } | undefined;
      if (ancestor) {
        throw new Error(`cycle: ${childId} is already a transitive parent of ${parentId}`);
      }
      try {
        this.db
          .prepare('INSERT INTO task_links (parent_id, child_id) VALUES (?, ?)')
          .run(parentId, childId);
        this.emit(parentId, 'linked', actor, { parentId, childId });
        this.emit(childId, 'linked', actor, { parentId, childId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/FOREIGN KEY/i.test(msg)) {
          throw new Error(
            `not found: parent or child task does not exist (${parentId} -> ${childId})`,
          );
        }
        if (/UNIQUE constraint failed: task_links/.test(msg)) {
          // Idempotent: the edge already exists. No event, no error.
          return;
        }
        throw err;
      }
    });
    tx.immediate();
  }

  getParents(childId: string): Task[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tasks t
         JOIN task_links l ON l.parent_id = t.id
         WHERE l.child_id = ?
         ORDER BY t.created_at ASC`,
      )
      .all(childId) as TaskRow[];
    return rows.map(rowToTask);
  }

  // ---------------------------------------------------------------------------
  // Plan B dispatcher helpers — promote / reclaim / dispatch queries
  // ---------------------------------------------------------------------------

  /**
   * Promote `todo` tasks whose blocking parents are all `done` to `ready`.
   *
   * A "blocking parent" is a parent with a real assignee. Parents created via
   * `kanban_create_goal` carry `assignee=NULL` and are treated as transparent
   * containers — they organize tasks without gating them. Without that rule,
   * a coordinator's `kanban_create_goal` + `kanban_create(parents=[goal])`
   * flow deadlocks: the goal has no assignee, so nothing closes it, so the
   * child never promotes.
   *
   * Archived parents stay as blockers (archive = abandoned, not satisfied),
   * matching the same semantics `kanban_unblock` uses.
   */
  promoteReady(actor = 'system'): string[] {
    const candidates = this.db
      .prepare(
        `SELECT t.id FROM tasks t
         WHERE t.status = 'todo'
           AND NOT EXISTS (
             SELECT 1 FROM task_links l
             JOIN tasks p ON p.id = l.parent_id
             WHERE l.child_id = t.id
               AND p.assignee IS NOT NULL
               AND p.status != 'done'
           )`,
      )
      .all() as Array<{ id: string }>;
    for (const c of candidates) {
      this.updateStatus(c.id, 'ready', 'parents done', actor);
    }
    return candidates.map((c) => c.id);
  }

  /**
   * Promote `scheduled` tasks whose `scheduled_for` is in the past to `ready`.
   * Returns the promoted task ids.
   */
  promoteScheduled(nowMs: number = Date.now(), actor = 'system'): string[] {
    const candidates = this.db
      .prepare(
        `SELECT id FROM tasks WHERE status = 'scheduled' AND scheduled_for IS NOT NULL
         AND scheduled_for <= ?`,
      )
      .all(nowMs) as Array<{ id: string }>;
    for (const c of candidates) {
      this.updateStatus(c.id, 'ready', 'scheduled time reached', actor);
    }
    return candidates.map((c) => c.id);
  }

  /**
   * Discount a host pause from every active run's and running task's liveness
   * clock.
   *
   * A run that was genuinely alive across a VM suspend wrote no heartbeat while
   * the host was stopped, so the first post-resume sweep reads the pause as a
   * stuck agent: `findStalledRuns` blocks the run, and `findStaleRunningTasks`
   * feeds `reclaimTask`, whose re-claim through `updateStatus('running')`
   * increments `retry_count` — burning real budget out of `max_retries` for
   * time nobody was running. Advancing both liveness columns by the pause
   * duration — once, at the resume boundary, before either gate compares again
   * — corrects the timestamps without touching the gates: a run that really
   * went quiet is still past its cutoff afterwards.
   *
   * Both columns move together, the same pairing `heartbeatRun` writes.
   *
   * Returns the total rows bumped (runs + tasks). A non-positive or non-finite
   * duration writes nothing.
   */
  bumpActiveHeartbeats(pauseDurationMs: number): number {
    // Both columns are INTEGER in STRICT tables — a fractional offset would
    // make the sum a REAL and the write would throw.
    const offset = Math.round(pauseDurationMs);
    if (!Number.isFinite(pauseDurationMs) || offset <= 0) return 0;
    const tx = this.db.transaction((): number => {
      const runs = this.db
        .prepare(
          'UPDATE task_runs SET last_heartbeat_at = last_heartbeat_at + ? WHERE ended_at IS NULL',
        )
        .run(offset);
      const tasks = this.db
        .prepare(`UPDATE tasks SET updated_at = updated_at + ? WHERE status = 'running'`)
        .run(offset);
      return runs.changes + tasks.changes;
    });
    return tx();
  }

  /**
   * Find open runs whose `last_heartbeat_at` is older than `cutoffMs` ago.
   * The caller (typically the dispatcher) decides what to do — usually
   * `blockRun(id, 'stalled')`.
   */
  findStalledRuns(cutoffMs: number, nowMs: number = Date.now()): TaskRun[] {
    const threshold = nowMs - cutoffMs;
    const rows = this.db
      .prepare(
        `SELECT * FROM task_runs WHERE ended_at IS NULL AND last_heartbeat_at < ?
         ORDER BY last_heartbeat_at ASC`,
      )
      .all(threshold) as TaskRunRow[];
    return rows.map(rowToRun);
  }

  /**
   * Find `running` tasks whose `updated_at` is older than `thresholdMs` ago.
   * `updated_at` tracks last activity (`heartbeatRun` bumps it), so a stale
   * task is one whose owner stopped making progress. The caller (the
   * dispatcher) decides what to do — usually `reclaimTask(id, 'orphan_stale')`.
   */
  findStaleRunningTasks(thresholdMs: number, nowMs: number = Date.now()): Task[] {
    const threshold = nowMs - thresholdMs;
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE status = 'running' AND updated_at < ?
         ORDER BY updated_at ASC`,
      )
      .all(threshold) as TaskRow[];
    return rows.map(rowToTask);
  }

  /**
   * Reclaim a stuck `running` task: cancel its open run (if any) and put the
   * task back to `ready` so the dispatcher's normal dispatch loop re-claims it.
   * The re-claim goes through `updateStatus('running')`, which owns the
   * retry-budget invariant — so the retry_count increment happens there, not
   * here.
   *
   * `reason` distinguishes why the task was reclaimed (`orphan_stale` =
   * heartbeat went quiet; `orphan_no_owner` = the assignee process is gone).
   * It lands in the `status_changed` audit event's `data.reason` so the team
   * can see why work was re-queued. A task with no open run is reclaimed
   * gracefully — just the status flip + event.
   */
  reclaimTask(taskId: string, reason: 'orphan_stale' | 'orphan_no_owner', actor = 'system'): Task {
    const now = Date.now();
    const tx = this.db.transaction((): Task => {
      const row = this.db
        .prepare('SELECT status, assignee, current_run_id FROM tasks WHERE id = ?')
        .get(taskId) as
        | { status: TaskStatus; assignee: string | null; current_run_id: string | null }
        | undefined;
      if (!row) throw new Error(`reclaimTask: task ${taskId} not found`);
      let runCancelled = false;
      if (row.current_run_id !== null) {
        const result = this.db
          .prepare(
            `UPDATE task_runs SET ended_at = ?, outcome = ?
             WHERE id = ? AND ended_at IS NULL`,
          )
          .run(now, 'cancelled', row.current_run_id);
        runCancelled = result.changes === 1;
      }
      this.db
        .prepare('UPDATE tasks SET status = ?, current_run_id = NULL, updated_at = ? WHERE id = ?')
        .run('ready', now, taskId);
      // The member whose claim was just reclaimed gets an orphaned tally — but
      // only when the task was actually `running`. A reclaim of a task in any
      // other status is a re-queue, not a real orphan; counting it would
      // inflate the member's failure rate. The task keeps its `assignee` across
      // a reclaim (the dispatcher re-POSTs to the same member), so `row.assignee`
      // is the member that lost the claim. Gating on `row.status` keeps the
      // invariant local — it doesn't depend on the caller only passing
      // `running` tasks.
      if (row.status === 'running') {
        this.bumpMemberStat(row.assignee, 'tickets_orphaned');
      }
      if (runCancelled) {
        this.emit(taskId, 'run_completed', actor, { outcome: 'cancelled', summary: null });
      }
      this.emit(taskId, 'status_changed', actor, { from: row.status, to: 'ready', reason });
      return this.getTask(taskId) as Task;
    });
    return tx();
  }

  /**
   * Roll up completed goals: any task with assignee=NULL and at least one child
   * where every non-archived child is `done` flips to `done` itself. This is
   * the goal-as-parent-task pattern's closure step — without it, a coordinator's
   * `kanban_create_goal` + `kanban_create(parents=[goal])` flow leaves the goal
   * stuck at `ready` forever, even after every sub-task completes.
   *
   * Refuses to complete a goal whose every child was archived: that would
   * silently swallow the case where a coordinator removed all the work.
   */
  rollupCompletedGoals(actor = 'system'): string[] {
    const candidates = this.db
      .prepare(
        `SELECT g.id FROM tasks g
         WHERE g.assignee IS NULL
           AND g.status NOT IN ('done', 'archived')
           AND EXISTS (
             SELECT 1 FROM task_links l
             JOIN tasks c ON c.id = l.child_id
             WHERE l.parent_id = g.id AND c.status = 'done'
           )
           AND NOT EXISTS (
             SELECT 1 FROM task_links l
             JOIN tasks c ON c.id = l.child_id
             WHERE l.parent_id = g.id AND c.status NOT IN ('done', 'archived')
           )`,
      )
      .all() as Array<{ id: string }>;
    for (const c of candidates) {
      this.updateStatus(c.id, 'done', 'all children done', actor);
    }
    return candidates.map((c) => c.id);
  }

  /**
   * Adopt orphan tickets — non-goal tasks left without an assignee — into the
   * coordinator's queue so the coordinator can decide where they belong.
   *
   * Definition of an orphan:
   *   - `assignee IS NULL`
   *   - Has NO children — this excludes the goal pattern, where
   *     `assignee=null + has children` is load-bearing for rollupCompletedGoals.
   *     A "leaf" with no assignee is hanging work; a parent with no assignee
   *     is a goal in progress.
   *   - Not yet `done` or `archived` — closed work doesn't need a triage owner.
   *   - Older than `gracePeriodMs` — protects the very common pattern of
   *     `kanban_create_goal` immediately followed by `kanban_create` children.
   *     Without this, a goal can be adopted in the few ms between creating it
   *     and adding its first child, breaking the goal-as-parent-task pattern.
   *
   * Returns the ids that were reassigned (empty when nothing matched).
   */
  adoptOrphanTickets(
    coordinator: string,
    opts: { gracePeriodMs?: number; actor?: string } = {},
  ): string[] {
    const gracePeriodMs = opts.gracePeriodMs ?? 60_000;
    const actor = opts.actor ?? 'system';
    const ageThreshold = Date.now() - gracePeriodMs;
    const candidates = this.db
      .prepare(
        `SELECT t.id FROM tasks t
         WHERE t.assignee IS NULL
           AND t.status NOT IN ('done', 'archived')
           AND t.created_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM task_links l WHERE l.parent_id = t.id
           )`,
      )
      .all(ageThreshold) as Array<{ id: string }>;
    for (const c of candidates) {
      this.assign(c.id, coordinator, actor);
    }
    return candidates.map((c) => c.id);
  }

  /**
   * Tasks ready for the dispatcher to claim: status=ready, an assignee is set,
   * and there is no current run yet.
   */
  findReadyToDispatch(): Task[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status = 'ready' AND assignee IS NOT NULL AND current_run_id IS NULL
         ORDER BY priority DESC, created_at ASC`,
      )
      .all() as TaskRow[];
    return rows.map(rowToTask);
  }

  listEvents(taskId: string): TaskEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC, id ASC')
      .all(taskId) as TaskEventRow[];
    return rows.map(rowToEvent);
  }

  private emit(
    taskId: string,
    kind: EventKind,
    actor: string,
    data: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        'INSERT INTO task_events (task_id, kind, actor, data_json, created_at) VALUES (?,?,?,?,?)',
      )
      .run(taskId, kind, actor, JSON.stringify(data), Date.now());
  }

  /**
   * Bump one `team_member_stats` counter for `(this.teamId, memberId)`.
   *
   * No-op when this board has no `teamId` (solo personality board) or when the
   * transitioning task had a `null` assignee — there is no member to credit.
   * Callers invoke this inside their own transaction so the counter moves
   * atomically with the terminal transition that triggered it. UPSERT so the
   * first outcome for a member creates the row.
   */
  private bumpMemberStat(
    memberId: string | null,
    column: 'tickets_completed' | 'tickets_failed' | 'tickets_orphaned',
  ): void {
    if (this.teamId === null || memberId === null) return;
    this.db
      .prepare(
        `INSERT INTO team_member_stats (team_id, member_id, ${column}, last_updated_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(team_id, member_id)
         DO UPDATE SET ${column} = ${column} + 1, last_updated_at = excluded.last_updated_at`,
      )
      .run(this.teamId, memberId, Date.now());
  }

  /**
   * Per-member outcome counters for this board's team, keyed by `member_id`.
   * Empty when this board has no `teamId` or no terminal transitions have been
   * recorded yet. Read-only — the rows are maintained by the terminal-transition
   * methods themselves.
   */
  getMemberStats(): Map<string, TeamMemberStats> {
    const out = new Map<string, TeamMemberStats>();
    if (this.teamId === null) return out;
    const rows = this.db
      .prepare(
        `SELECT team_id, member_id, tickets_completed, tickets_failed, tickets_orphaned,
                last_updated_at
         FROM team_member_stats WHERE team_id = ?`,
      )
      .all(this.teamId) as Array<{
      team_id: string;
      member_id: string;
      tickets_completed: number;
      tickets_failed: number;
      tickets_orphaned: number;
      last_updated_at: number;
    }>;
    for (const r of rows) {
      out.set(r.member_id, {
        teamId: r.team_id,
        memberId: r.member_id,
        ticketsCompleted: r.tickets_completed,
        ticketsFailed: r.tickets_failed,
        ticketsOrphaned: r.tickets_orphaned,
        lastUpdatedAt: r.last_updated_at,
      });
    }
    return out;
  }

  searchFts(query: string): Task[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tasks t
         JOIN task_fts ON task_fts.task_id = t.id
         WHERE task_fts MATCH ?
         ORDER BY bm25(task_fts)`,
      )
      .all(escapeFtsQuery(query)) as TaskRow[];
    return rows.map(rowToTask);
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface TaskRow {
  id: string;
  title: string;
  body: string;
  assignee: string | null;
  status: string;
  priority: number;
  workspace_mode: string;
  workspace_path: string | null;
  scheduled_for: number | null;
  idempotency_key: string | null;
  current_run_id: string | null;
  max_retries: number | null;
  retry_count: number;
  acceptance_criteria: string | null;
  block_kind: string | null;
  block_recurrence_count: number;
  created_at: number;
  updated_at: number;
}

interface TaskRunRow {
  id: string;
  task_id: string;
  started_at: number;
  ended_at: number | null;
  outcome: string | null;
  summary: string | null;
  last_heartbeat_at: number;
  completed_by_id: string | null;
  completed_by_name: string | null;
}

interface TaskCommentRow {
  id: string;
  task_id: string;
  author: string;
  body: string;
  created_at: number;
}

function rowToRun(r: TaskRunRow): TaskRun {
  return {
    id: r.id,
    taskId: r.task_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    outcome: (r.outcome as RunOutcome | null) ?? null,
    summary: r.summary,
    lastHeartbeatAt: r.last_heartbeat_at,
    completedBy:
      r.completed_by_id !== null
        ? { id: r.completed_by_id, name: r.completed_by_name ?? r.completed_by_id }
        : null,
  };
}

function rowToComment(r: TaskCommentRow): TaskComment {
  return {
    id: r.id,
    taskId: r.task_id,
    author: r.author,
    body: r.body,
    createdAt: r.created_at,
  };
}

interface TaskEventRow {
  id: number;
  task_id: string;
  kind: string;
  actor: string;
  data_json: string;
  created_at: number;
}

function rowToEvent(r: TaskEventRow): TaskEvent {
  return {
    id: r.id,
    taskId: r.task_id,
    kind: r.kind as EventKind,
    actor: r.actor,
    data: JSON.parse(r.data_json) as Record<string, unknown>,
    createdAt: r.created_at,
  };
}

function rowToTask(r: TaskRow): Task {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    assignee: r.assignee,
    status: r.status as TaskStatus,
    priority: r.priority,
    workspaceMode: r.workspace_mode as WorkspaceMode,
    workspacePath: r.workspace_path,
    scheduledFor: r.scheduled_for,
    idempotencyKey: r.idempotency_key,
    currentRunId: r.current_run_id,
    maxRetries: r.max_retries,
    retryCount: r.retry_count,
    acceptanceCriteria: r.acceptance_criteria,
    blockKind: r.block_kind as BlockKind | null,
    blockRecurrenceCount: r.block_recurrence_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ID helpers (exported for tests + potential reuse)
export function newTaskId(): string {
  return `t_${shortId()}`;
}

export function newCommentId(): string {
  return `c_${shortId()}`;
}

export function newRunId(): string {
  return `r_${shortId()}`;
}

function shortId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

// FTS5 query escaping: wrap as a quoted phrase so callers can pass arbitrary user text
// (including spaces and special FTS5 operators) without triggering a syntax error.
// Multi-word inputs match as exact phrases; single words match as tokens.
function escapeFtsQuery(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

// Collapse whitespace and cap length for a title derived from free-text body
// content (goal/prompt, which the tool layer allows up to MAX_BODY_CHARS).
// Titles have no length CHECK in the schema, but a short, single-line label
// keeps the board readable — `createSwarm` uses this for its generated tasks.
function truncateForTitle(text: string, max = 80): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return '(empty)';
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
