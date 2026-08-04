import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { migrate } from '@ethosagent/sqlite';

// ---------------------------------------------------------------------------
// Durable delivery-obligation ledger
//
// The gateway's `MessageDedupCache` prevents DOUBLE sends. It records no
// durable obligation, so a crash between generating a reply and confirming
// platform delivery loses the turn silently — after the user already paid for
// the tokens. Dedup and durability are orthogonal; this is the durability half.
//
// Two-phase around every covered outbound send:
//   1. `record()` writes a `pending` row BEFORE the platform call.
//   2. `markDelivered()` flips it to `delivered` only once the adapter
//      CONFIRMED (`DeliveryResult.ok === true`).
//   3. On boot the gateway sweeps `pending` rows it owns and redelivers them.
//
// "Confirmed" deliberately does NOT mean "the promise resolved". Every real
// adapter catches platform failures and returns `{ ok: false }` rather than
// throwing, so a ledger keyed on "did not throw" would mark exactly the
// failures it exists to catch as delivered.
//
// At-least-once, not exactly-once: a reply that WAS delivered but crashed
// before the confirm write is sent again on the next sweep. That is the correct
// trade against silent loss.
// ---------------------------------------------------------------------------

/**
 * Lifecycle of one obligation.
 *
 * - `pending` — written, not yet confirmed by the platform. Eligible for a
 *   redelivery sweep by whichever process owns its `botKey`.
 * - `redelivering` — atomically claimed by exactly one sweeping process.
 * - `delivered` — the adapter confirmed. Prunable once past retention.
 */
export type DeliveryStatus = 'pending' | 'redelivering' | 'delivered';

export interface DeliveryObligation {
  id: string;
  botKey: string;
  platform: string;
  chatId: string;
  sessionId: string;
  /** sha256 hex of `content` — safe to log; the plaintext is not. */
  contentHash: string;
  content: string;
  createdAt: number;
  status: DeliveryStatus;
}

export interface RecordDeliveryInput {
  botKey: string;
  platform: string;
  chatId: string;
  sessionId: string;
  content: string;
}

/**
 * The contract the gateway codes against, so surfaces can inject a fake
 * without a SQLite file. `SQLiteDeliveryLedger` is the only shipped
 * implementation.
 */
export interface DeliveryLedger {
  /** Write a `pending` obligation. Returns its id. */
  record(input: RecordDeliveryInput): Promise<string>;
  /** Every `pending` obligation whose `botKey` is in `botKeys`. Empty list in
   *  → empty list out (a process owning no bots owns no obligations). */
  listPending(botKeys: readonly string[]): Promise<DeliveryObligation[]>;
  /** Atomically move `pending` → `redelivering`. `false` means a peer won. */
  claim(id: string): Promise<boolean>;
  /** Mark confirmed. */
  markDelivered(id: string): Promise<void>;
  /** Put a claimed-but-undelivered obligation back in the `pending` pool. */
  release(id: string): Promise<void>;
  get(id: string): Promise<DeliveryObligation | null>;
  /** Delete `delivered` rows created before `cutoffMs`. Returns rows removed. */
  pruneDelivered(cutoffMs: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS delivery_obligations (
    id           TEXT PRIMARY KEY,
    bot_key      TEXT NOT NULL,
    platform     TEXT NOT NULL,
    chat_id      TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    content      TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending'
  ) STRICT;

  CREATE INDEX IF NOT EXISTS delivery_status_bot ON delivery_obligations(status, bot_key);
  CREATE INDEX IF NOT EXISTS delivery_status_created ON delivery_obligations(status, created_at);
`;

interface ObligationRow {
  id: string;
  bot_key: string;
  platform: string;
  chat_id: string;
  session_id: string;
  content_hash: string;
  content: string;
  created_at: number;
  status: string;
}

function rowToObligation(r: ObligationRow): DeliveryObligation {
  return {
    id: r.id,
    botKey: r.bot_key,
    platform: r.platform,
    chatId: r.chat_id,
    sessionId: r.session_id,
    contentHash: r.content_hash,
    content: r.content,
    createdAt: r.created_at,
    status: r.status as DeliveryStatus,
  };
}

// ---------------------------------------------------------------------------
// SQLiteDeliveryLedger
// ---------------------------------------------------------------------------

export class SQLiteDeliveryLedger implements DeliveryLedger {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    // mkdir -p the parent directory — the same raw-fs exception the other
    // SQLite stores use for path setup (Storage covers ~/.ethos/ data IO, not
    // bootstrapping the DB file's enclosing directory). `:memory:` has no
    // parent path, so skip. Permissions are umask default, matching jobs.db
    // and sessions.db; this file holds the same sensitivity class of content
    // as sessions.db, and tightening one without the other buys nothing.
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    // One ledger file is shared cross-process (gateway + serve). An explicit
    // busy timeout makes concurrent opens/writes wait instead of throwing
    // SQLITE_BUSY.
    this.db.pragma('busy_timeout = 5000');

    migrate(this.db, {
      name: 'delivery-ledger',
      targetVersion: 1,
      baseline: SCHEMA,
    });
  }

  async record(input: RecordDeliveryInput): Promise<string> {
    const id = randomUUID();
    const hash = createHash('sha256').update(input.content).digest('hex');
    this.db
      .prepare(
        `INSERT INTO delivery_obligations
         (id, bot_key, platform, chat_id, session_id, content_hash, content, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(
        id,
        input.botKey,
        input.platform,
        input.chatId,
        input.sessionId,
        hash,
        input.content,
        Date.now(),
      );
    return id;
  }

  async listPending(botKeys: readonly string[]): Promise<DeliveryObligation[]> {
    if (botKeys.length === 0) return [];
    // Ownership filter. A deployment configured with bots {A, B} must leave a
    // bot-C row for whichever process actually owns bot C — sharing a ledger
    // file must never mean redelivering someone else's traffic.
    const placeholders = botKeys.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM delivery_obligations
         WHERE status = 'pending' AND bot_key IN (${placeholders})
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(...botKeys) as ObligationRow[];
    return rows.map(rowToObligation);
  }

  async claim(id: string): Promise<boolean> {
    // Conditional update inside a transaction — the same idiom job-store uses
    // for `claimNextQueued`. Two processes sweeping one ledger both see the
    // row in `listPending`; only the one whose UPDATE changes a row proceeds,
    // so each obligation is redelivered exactly once. A read-then-write check
    // would race here.
    const claim = this.db.transaction((): boolean => {
      const result = this.db
        .prepare(
          `UPDATE delivery_obligations SET status = 'redelivering'
           WHERE id = ? AND status = 'pending'`,
        )
        .run(id);
      return result.changes === 1;
    });
    return claim();
  }

  async markDelivered(id: string): Promise<void> {
    this.db.prepare(`UPDATE delivery_obligations SET status = 'delivered' WHERE id = ?`).run(id);
  }

  async release(id: string): Promise<void> {
    // Only a row THIS process claimed can go back to the pool; the status
    // guard keeps a release from resurrecting an already-delivered row.
    this.db
      .prepare(
        `UPDATE delivery_obligations SET status = 'pending'
         WHERE id = ? AND status = 'redelivering'`,
      )
      .run(id);
  }

  async get(id: string): Promise<DeliveryObligation | null> {
    const row = this.db.prepare('SELECT * FROM delivery_obligations WHERE id = ?').get(id) as
      | ObligationRow
      | undefined;
    return row ? rowToObligation(row) : null;
  }

  async pruneDelivered(cutoffMs: number): Promise<number> {
    // ONLY `delivered`. A `pending` row is the whole point of the ledger and is
    // never pruned, however old — an aged pending row is not proof of a crash
    // (it may belong to a live peer), so age can never authorize deleting it.
    // `redelivering` is likewise left alone: it is by definition claimed.
    const result = this.db
      .prepare(`DELETE FROM delivery_obligations WHERE status = 'delivered' AND created_at < ?`)
      .run(cutoffMs);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
