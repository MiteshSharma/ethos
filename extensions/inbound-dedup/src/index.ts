import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { migrate } from '@ethosagent/sqlite';

// ---------------------------------------------------------------------------
// Durable inbound-message dedup
//
// The Gateway's in-memory `Set` of recently-seen `(platform, botKey, chatId,
// messageId)` keys prevents a redelivered inbound message from being processed
// — and billed — twice. A process restart empties it.
//
// Under webhook mode with scale-to-zero, that restart stops being a rare
// crash/deploy event and becomes routine: the process is expected to exit and
// be re-invoked. A platform retry landing on a freshly-started process finds an
// empty `Set` and gets fully reprocessed — exactly the double-billing bug the
// `Set` exists to prevent, now made routine instead of rare.
//
// This store is the durable half. It is a BACKSTOP, not a replacement: the
// Gateway keeps its `Set` as the fast path and only consults this on a miss,
// so a continuously-running process pays no SQLite read per inbound message.
//
// Same shape as the other SQLite-backed stores in this repo (delivery-ledger,
// job-store, session-cards, call-log, notify-queue): raw `node:fs` only to
// mkdir -p the database file's parent directory, then `@ethosagent/sqlite`
// opens the path directly. Storage covers ~/.ethos/ data IO, not bootstrapping
// a DB file's enclosing directory.
// ---------------------------------------------------------------------------

/**
 * Durable equivalent of the Gateway's `Set.has()` / `Set.add()` pair.
 *
 * Deliberately synchronous: the Gateway's dedup check runs inline on the
 * inbound path, before any other work, and making it async would reorder the
 * message pipeline. `@ethosagent/sqlite` is a synchronous API, so there is
 * nothing to await.
 */
export interface InboundDedupStore {
  /**
   * Record a sighting of this inbound-message key and report whether it had
   * already been seen inside the TTL window.
   *
   * Check and record are one statement — a read-then-write would race two
   * processes sharing the file (webhook retries can land concurrently).
   *
   * @returns `true` if the key was already recorded (a duplicate), `false` on
   *          first sighting.
   */
  seen(platform: string, botKey: string, chatId: string, messageId: string): boolean;
  close(): void;
}

/**
 * How long a sighting suppresses redeliveries of the same key.
 *
 * Sized against platform retry behaviour: Slack's practical retry tail is
 * reported at roughly 5 minutes (3 retries), Telegram publishes no SLA and can
 * duplicate even after a 200 OK. Both figures are external platform lore from
 * the research behind plan/phases/telegram-slack-webhook-mode.md §5 — not
 * documented guarantees, and not verifiable from this codebase — so the window
 * is sized generously above them rather than tuned to them.
 */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/**
 * Pruning is done on write rather than by a background sweep (§5: "no separate
 * background sweep needed at this scale"). Rate-limiting it to once a minute
 * keeps a busy process from issuing a DELETE per inbound message; the table
 * still cannot outgrow one TTL window plus one minute of traffic.
 */
const PRUNE_INTERVAL_MS = 60 * 1000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS inbound_seen (
    platform   TEXT NOT NULL,
    bot_key    TEXT NOT NULL,
    chat_id    TEXT NOT NULL,
    message_id TEXT NOT NULL,
    seen_at    INTEGER NOT NULL,
    PRIMARY KEY (platform, bot_key, chat_id, message_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS inbound_seen_at ON inbound_seen(seen_at);
`;

export interface InboundDedupOptions {
  /** Defaults to {@link DEFAULT_TTL_MS} (60 minutes). */
  ttlMs?: number;
  /** Clock seam, for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export class SQLiteInboundDedupStore implements InboundDedupStore {
  private readonly db: Database.Database;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private lastPrunedAt = 0;

  constructor(dbPath: string, options: InboundDedupOptions = {}) {
    // mkdir -p the parent directory — the same raw-fs exception the other
    // SQLite stores use for path setup. `:memory:` has no parent path.
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    // The file is shared cross-process (gateway + serve). An explicit busy
    // timeout makes concurrent writes wait instead of throwing SQLITE_BUSY.
    this.db.pragma('busy_timeout = 5000');

    migrate(this.db, {
      name: 'inbound-dedup',
      targetVersion: 1,
      baseline: SCHEMA,
      migrations: {},
    });

    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  seen(platform: string, botKey: string, chatId: string, messageId: string): boolean {
    const at = this.now();
    // Prune BEFORE the insert: an expired row must be gone so the same key
    // arriving after the TTL is treated as new rather than as a duplicate.
    this.prune(at);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO inbound_seen (platform, bot_key, chat_id, message_id, seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(platform, botKey, chatId, messageId, at);
    // No row inserted => the key was already there => duplicate. The existing
    // row's `seen_at` is deliberately NOT refreshed: the TTL runs from first
    // sighting, matching `Set` semantics.
    return result.changes === 0;
  }

  private prune(at: number): void {
    if (at - this.lastPrunedAt < PRUNE_INTERVAL_MS) return;
    this.lastPrunedAt = at;
    this.db.prepare('DELETE FROM inbound_seen WHERE seen_at <= ?').run(at - this.ttlMs);
  }

  close(): void {
    this.db.close();
  }
}
