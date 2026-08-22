import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { migrate } from '@ethosagent/sqlite';

// ---------------------------------------------------------------------------
// Pending-notify queue (Lane C, kanban-hooks-notify-parity, D6)
//
// A passive `notify`-mode delivery to a peer's `/notify` endpoint does not
// force a turn, so there is nowhere in the existing prompt/session machinery
// for it to land: `SessionStore` is ruled out (system-role rows are filtered
// out of history before injectors or the LLM ever see them, and a second
// consecutive stored user-role row breaks Anthropic's strict role-alternation
// contract — see the plan doc's D6 for the full argument). Instead this is a
// small standalone pending -> consumed queue, keyed by (team,
// assigneePersonalityId), following the same write-pending-then-consume
// discipline `extensions/delivery-ledger` already uses for gateway replies —
// simplified, since there is no redelivery/abandon concept here: a row is
// either unconsumed or gone.
//
// Write side: `apps/acp-server`'s `/notify` handlers, on a `notify`-mode
// delivery. Read side: the pending-notify `ContextInjector`
// (`packages/wiring/src/compose-tools.ts`), which reads and marks consumed in
// one step at inject time, at the assignee's own next turn.
// ---------------------------------------------------------------------------

export interface PendingNotify {
  id: number;
  team: string;
  assigneePersonalityId: string;
  kind: string;
  ref?: string;
  createdAt: number;
}

export interface WritePendingNotifyInput {
  team: string;
  assigneePersonalityId: string;
  kind: string;
  ref?: string;
}

export interface PendingNotifyQueue {
  /** Write a pending row. */
  write(input: WritePendingNotifyInput): Promise<void>;
  /**
   * Every unconsumed row for `(team, assigneePersonalityId)`, oldest first,
   * marked consumed atomically as part of this same call — a row is read
   * exactly once, by whichever turn's injector first asks for it.
   */
  readAndConsume(team: string, assigneePersonalityId: string): Promise<PendingNotify[]>;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS pending_notifies (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    team                    TEXT NOT NULL,
    assignee_personality_id TEXT NOT NULL,
    kind                    TEXT NOT NULL,
    ref                     TEXT,
    created_at              INTEGER NOT NULL,
    consumed                INTEGER NOT NULL DEFAULT 0
  ) STRICT;

  CREATE INDEX IF NOT EXISTS pending_notifies_lookup
    ON pending_notifies(team, assignee_personality_id, consumed);
`;

interface PendingNotifyRow {
  id: number;
  team: string;
  assignee_personality_id: string;
  kind: string;
  ref: string | null;
  created_at: number;
  consumed: number;
}

function rowToPendingNotify(r: PendingNotifyRow): PendingNotify {
  return {
    id: r.id,
    team: r.team,
    assigneePersonalityId: r.assignee_personality_id,
    kind: r.kind,
    ref: r.ref ?? undefined,
    createdAt: r.created_at,
  };
}

export class SQLiteNotifyQueue implements PendingNotifyQueue {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    // Same raw-fs carve-out the other SQLite stores use: mkdir -p the parent
    // directory before opening (Storage covers ~/.ethos/ data IO, not
    // bootstrapping the DB file's own enclosing directory). `:memory:` has no
    // parent path, so skip.
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    // The queue file is opened independently by the ACP server (writer) and
    // the wiring composition root (reader) within the same process, and can
    // also be shared cross-process the same way delivery-ledger.db is — an
    // explicit busy timeout makes a concurrent write/read wait instead of
    // throwing SQLITE_BUSY.
    this.db.pragma('busy_timeout = 5000');

    migrate(this.db, {
      name: 'notify-queue',
      targetVersion: 1,
      baseline: SCHEMA,
    });
  }

  async write(input: WritePendingNotifyInput): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO pending_notifies
         (team, assignee_personality_id, kind, ref, created_at, consumed)
         VALUES (?, ?, ?, ?, ?, 0)`,
      )
      .run(
        input.team,
        input.assigneePersonalityId,
        input.kind,
        input.ref ? input.ref : null,
        Date.now(),
      );
  }

  async readAndConsume(team: string, assigneePersonalityId: string): Promise<PendingNotify[]> {
    // SELECT then UPDATE inside one transaction so the rows returned are
    // exactly the rows this call consumed — the same shape delivery-ledger's
    // `abandonStale` uses to keep a caller from acting on a snapshot that a
    // concurrent call already changed.
    const consume = this.db.transaction((): PendingNotify[] => {
      const rows = this.db
        .prepare(
          `SELECT * FROM pending_notifies
           WHERE team = ? AND assignee_personality_id = ? AND consumed = 0
           ORDER BY created_at ASC, id ASC`,
        )
        .all(team, assigneePersonalityId) as PendingNotifyRow[];
      if (rows.length === 0) return [];
      this.db
        .prepare(
          `UPDATE pending_notifies SET consumed = 1
           WHERE team = ? AND assignee_personality_id = ? AND consumed = 0`,
        )
        .run(team, assigneePersonalityId);
      return rows.map(rowToPendingNotify);
    });
    return consume();
  }

  close(): void {
    this.db.close();
  }
}
