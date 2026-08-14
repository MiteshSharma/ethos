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
 * - `abandoned` — given up on by its owner after `abandonStale`. A terminal
 *   state that is NOT delivery: it records that the reply was owed and never
 *   arrived, which is a different fact from `delivered` and worth keeping
 *   distinct until retention removes both.
 */
export type DeliveryStatus = 'pending' | 'redelivering' | 'delivered' | 'abandoned';

/**
 * What the obligation owes the user.
 *
 * The distinction is not cosmetic: a `voice` obligation's payload is an
 * artifact on disk, so redelivering it means re-sending bytes rather than
 * re-sending a string, and abandoning it means someone has to release those
 * bytes.
 */
export type DeliveryKind = 'text' | 'voice';

export interface DeliveryObligation {
  id: string;
  botKey: string;
  platform: string;
  chatId: string;
  sessionId: string;
  /**
   * The thread the reply belonged to, or `undefined` for the root chat.
   *
   * Not decoration: Ethos's own lane key is
   * `${platform}:${botKey}:${chatId}[:${threadId}]`, so a chat and a thread
   * inside it are different conversations. Redelivering without it puts a
   * resurrected answer in the root channel — right audience, wrong place, and
   * stripped of the context that made it legible.
   */
  threadId?: string;
  /** sha256 hex of `content` — safe to log; the plaintext is not. */
  contentHash: string;
  content: string;
  createdAt: number;
  status: DeliveryStatus;
  /** `text` for a written reply, `voice` for a synthesized voice note. Rows
   *  written before v3 read as `text`, which is what they were. */
  kind: DeliveryKind;
  /**
   * Artifact key for a `voice` obligation — redelivery RE-SENDS the stored
   * artifact rather than re-synthesizing, so a redelivered voice note is
   * byte-identical to the one the user did not receive.
   *
   * `content` stays populated alongside it, holding the SPOKEN TEXT: the row
   * stays human-readable in the DB, still hashes to a dedup-comparable value,
   * and a voice row whose artifact has vanished is still diagnosable.
   */
  artifactRef?: string;
  /** The `VoiceAudioFormat` the artifact holds, so redelivery re-sends it
   *  without re-deriving the format from the bytes. */
  mediaFormat?: string;
}

export interface RecordDeliveryInput {
  botKey: string;
  platform: string;
  chatId: string;
  sessionId: string;
  /** Empty string is normalized to "no thread" — it carries no routing signal. */
  threadId?: string;
  /** For a `voice` obligation this is the spoken text, not a placeholder. */
  content: string;
  /** Defaults to `'text'`. */
  kind?: DeliveryKind;
  artifactRef?: string;
  mediaFormat?: string;
}

/** Row counts per {@link DeliveryStatus}. */
export interface DeliveryStatusCounts {
  pending: number;
  redelivering: number;
  delivered: number;
  abandoned: number;
}

/**
 * Ledger counts for an operator display.
 *
 * `voice` repeats the same four counts over `kind = 'voice'` rows only, because
 * "17 pending" answers a different question depending on whether those are text
 * replies or synthesized artifacts still sitting on disk.
 */
export interface DeliveryStats extends DeliveryStatusCounts {
  voice: DeliveryStatusCounts;
}

/** Widest window {@link DeliveryLedger.listRecent} will open. */
const MAX_RECENT = 200;

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
  /**
   * Give up on obligations older than `cutoffMs` that this process OWNS, and
   * return them so the caller can release whatever they hold (a voice
   * obligation's artifact).
   *
   * The ledger's standing rule is that age alone never authorizes touching a
   * `pending` row — an old row may belong to a live peer mid-send. That rule is
   * about REDELIVERY, which must not double-send; abandonment is the opposite
   * decision and needs the same ownership filter plus a cutoff far longer than
   * any real send. The default the gateway passes is days, not minutes.
   *
   * `redelivering` rows are swept too: a process that claimed a row and then
   * died leaves it claimed forever, and that is exactly the state that needs a
   * backstop.
   */
  abandonStale(botKeys: readonly string[], cutoffMs: number): Promise<DeliveryObligation[]>;
  /**
   * Delete terminal rows — `delivered` and `abandoned` — created before
   * `cutoffMs`. Returns rows removed.
   *
   * `pending` and `redelivering` are never age-pruned: they are live
   * obligations, and age is not evidence about them. They become prunable only
   * by first passing through `abandonStale`, which is an ownership-filtered
   * decision rather than a deletion driven by the clock alone.
   */
  pruneDelivered(cutoffMs: number): Promise<number>;
  /** Counts by status, and by status for `kind = 'voice'`. Read-only. */
  stats(): Promise<DeliveryStats>;
  /**
   * Most recent obligations, newest first. Read-only; for operator display.
   *
   * NOT ownership-filtered, unlike `listPending`: that filter exists so a
   * process never REDELIVERS a peer's traffic, and nothing here sends anything.
   * An operator looking at one ledger file should see the whole file.
   *
   * `limit` is clamped to 1–{@link MAX_RECENT} — an unbounded read of a table
   * whose rows hold full reply text is a memory hazard, not a feature.
   */
  listRecent(limit: number): Promise<DeliveryObligation[]>;
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
    status       TEXT NOT NULL DEFAULT 'pending',
    -- v2. Declared LAST so a freshly-created table and a v1 table upgraded by
    -- ALTER TABLE ADD COLUMN end up with identical column order. Nullable:
    -- most replies have no thread, and NULL is the honest encoding of that.
    thread_id    TEXT,
    -- v3, appended after thread_id for the same reason. All three nullable and
    -- WITHOUT a DEFAULT: a row written before these columns existed genuinely
    -- has no value for them, and NULL says so. kind is normalized to 'text' on
    -- read instead, which is the truth about every pre-v3 row.
    kind         TEXT,
    artifact_ref TEXT,
    media_format TEXT
  ) STRICT;

  CREATE INDEX IF NOT EXISTS delivery_status_bot ON delivery_obligations(status, bot_key);
  CREATE INDEX IF NOT EXISTS delivery_status_created ON delivery_obligations(status, created_at);
`;

/**
 * v1 → v2: carry the thread a reply belonged to.
 *
 * `ADD COLUMN` rather than a table rebuild — it preserves every existing row
 * (they get `NULL`, i.e. "root chat", which is the only truthful answer for a
 * row recorded before the column existed) and keeps the table STRICT, since
 * `ALTER TABLE ADD COLUMN` does not touch the table's STRICT-ness.
 */
/**
 * v2 → v3: let a voice note be an obligation.
 *
 * A voice reply's payload is a synthesized artifact, and re-synthesizing it on
 * redelivery would hand the user a different recording than the one that was
 * lost (a TTS pass is not deterministic, and the personality's voice may have
 * changed in between). Storing the artifact key means redelivery re-sends the
 * exact bytes that were owed.
 */
const MIGRATIONS = {
  2: (db: Database.Database): void => {
    db.exec('ALTER TABLE delivery_obligations ADD COLUMN thread_id TEXT');
  },
  3: (db: Database.Database): void => {
    db.exec('ALTER TABLE delivery_obligations ADD COLUMN kind TEXT');
    db.exec('ALTER TABLE delivery_obligations ADD COLUMN artifact_ref TEXT');
    db.exec('ALTER TABLE delivery_obligations ADD COLUMN media_format TEXT');
  },
};

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
  thread_id: string | null;
  kind: string | null;
  artifact_ref: string | null;
  media_format: string | null;
}

function rowToObligation(r: ObligationRow): DeliveryObligation {
  return {
    id: r.id,
    botKey: r.bot_key,
    platform: r.platform,
    chatId: r.chat_id,
    sessionId: r.session_id,
    threadId: r.thread_id ?? undefined,
    contentHash: r.content_hash,
    content: r.content,
    createdAt: r.created_at,
    status: r.status as DeliveryStatus,
    // NULL means "written before voice obligations existed", and every such row
    // was a text reply. Callers never have to special-case the pre-v3 shape.
    kind: (r.kind ?? 'text') as DeliveryKind,
    artifactRef: r.artifact_ref ?? undefined,
    mediaFormat: r.media_format ?? undefined,
  };
}

function emptyCounts(): DeliveryStatusCounts {
  return { pending: 0, redelivering: 0, delivered: 0, abandoned: 0 };
}

function isDeliveryStatus(v: string): v is DeliveryStatus {
  return v === 'pending' || v === 'redelivering' || v === 'delivered' || v === 'abandoned';
}

/** Clamp — never a thrown error: a display asking for too much should get a
 *  page, not a failure. A non-integer or NaN falls back to the widest window. */
function clampRecentLimit(limit: number): number {
  if (!Number.isInteger(limit)) return MAX_RECENT;
  return Math.min(MAX_RECENT, Math.max(1, limit));
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
      targetVersion: 3,
      baseline: SCHEMA,
      migrations: MIGRATIONS,
    });
  }

  async record(input: RecordDeliveryInput): Promise<string> {
    const id = randomUUID();
    const hash = createHash('sha256').update(input.content).digest('hex');
    this.db
      .prepare(
        `INSERT INTO delivery_obligations
         (id, bot_key, platform, chat_id, session_id, content_hash, content, created_at, status,
          thread_id, kind, artifact_ref, media_format)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
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
        // Normalized at the durable boundary so the sweep never has to decide
        // whether '' means a thread. NULL is the single encoding of "no thread".
        input.threadId ? input.threadId : null,
        input.kind ?? 'text',
        // Same normalization as thread_id: '' is not a smaller artifact key, it
        // is an absent one, and a sweep that tried to load it would fail late.
        input.artifactRef ? input.artifactRef : null,
        input.mediaFormat ? input.mediaFormat : null,
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

  async abandonStale(botKeys: readonly string[], cutoffMs: number): Promise<DeliveryObligation[]> {
    if (botKeys.length === 0) return [];
    const placeholders = botKeys.map(() => '?').join(', ');
    // SELECT and UPDATE in one transaction so the rows returned to the caller
    // are exactly the rows this call abandoned. Split apart, a peer could claim
    // a row between the two statements and the caller would then release an
    // artifact that a live send is still reading from.
    const abandon = this.db.transaction((): DeliveryObligation[] => {
      const rows = this.db
        .prepare(
          `SELECT * FROM delivery_obligations
           WHERE status IN ('pending', 'redelivering')
             AND bot_key IN (${placeholders})
             AND created_at < ?
           ORDER BY created_at ASC, rowid ASC`,
        )
        .all(...botKeys, cutoffMs) as ObligationRow[];
      if (rows.length === 0) return [];
      this.db
        .prepare(
          `UPDATE delivery_obligations SET status = 'abandoned'
           WHERE status IN ('pending', 'redelivering')
             AND bot_key IN (${placeholders})
             AND created_at < ?`,
        )
        .run(...botKeys, cutoffMs);
      // Report the post-update state — the caller is being handed rows it has
      // just given up on, not a snapshot of what they were a statement ago.
      return rows.map((r) => ({ ...rowToObligation(r), status: 'abandoned' as const }));
    });
    return abandon();
  }

  async pruneDelivered(cutoffMs: number): Promise<number> {
    // Terminal rows only: `delivered` and `abandoned`. A `pending` row is the
    // whole point of the ledger and is never age-pruned — an aged pending row
    // is not proof of a crash (it may belong to a live peer), so age can never
    // authorize deleting it. `redelivering` is likewise left alone: it is by
    // definition claimed. Both reach this method only via `abandonStale`, which
    // filters by ownership before the clock gets a vote.
    const result = this.db
      .prepare(
        `DELETE FROM delivery_obligations
         WHERE status IN ('delivered', 'abandoned') AND created_at < ?`,
      )
      .run(cutoffMs);
    return result.changes;
  }

  async stats(): Promise<DeliveryStats> {
    // One GROUP BY over (status, kind) rather than eight COUNT(*) round trips.
    // `kind IS NULL` is a pre-v3 row, which was a text reply — the same
    // normalization `rowToObligation` applies.
    const rows = this.db
      .prepare(
        `SELECT status, COALESCE(kind, 'text') AS kind, COUNT(*) AS n
         FROM delivery_obligations
         GROUP BY status, COALESCE(kind, 'text')`,
      )
      .all() as Array<{ status: string; kind: string; n: number }>;
    const out: DeliveryStats = {
      ...emptyCounts(),
      voice: emptyCounts(),
    };
    for (const row of rows) {
      if (!isDeliveryStatus(row.status)) continue;
      out[row.status] += row.n;
      if (row.kind === 'voice') out.voice[row.status] += row.n;
    }
    return out;
  }

  async listRecent(limit: number): Promise<DeliveryObligation[]> {
    // Same rowid tie-break the session store uses: rows written inside one
    // millisecond otherwise come back in an arbitrary order.
    const rows = this.db
      .prepare(
        `SELECT * FROM delivery_obligations
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(clampRecentLimit(limit)) as ObligationRow[];
    return rows.map(rowToObligation);
  }

  close(): void {
    this.db.close();
  }
}
