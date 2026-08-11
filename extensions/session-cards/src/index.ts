import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { noopLogger } from '@ethosagent/logger';
import Database from '@ethosagent/sqlite';
import type { Logger } from '@ethosagent/types';
import { type CardEnvelope, CardEnvelopeSchema, type SessionCard } from '@ethosagent/web-contracts';

// ---------------------------------------------------------------------------
// Durable store for typed UI cards (plan/phases/ui-cards-canvas.md B2)
//
// A card envelope reaches the browser as `tool_end.structured.card`. Nothing
// downstream keeps it: the agent loop persists tool results as plain strings
// (`StoredMessage.content`), the wire `StoredMessage` schema has no
// `structured` field, and the only other copy lives in the in-memory
// `SessionStreamBuffer` — which is reaped ~5 minutes after the last SSE
// client disconnects. So a reload after that window renders a transcript with
// the cards missing.
//
// This is a SEPARATE database file, deliberately. The alternative was a
// `structured` column on the STRICT `messages` table in sessions.db, which
// would push a UI concern into the schema the LLM history is read from and
// force a migration on every card-shape change.
//
// Envelopes are stored as JSON text and re-validated on read, never on the
// way out of the reader's hands: a row written under an older spec version
// that no longer parses is SKIPPED, so a schema change degrades one card
// rather than breaking a whole session load.
// ---------------------------------------------------------------------------

/**
 * The contract web-api codes against, so surfaces can inject a fake without a
 * SQLite file. `SQLiteCardStore` is the only shipped implementation.
 *
 * Synchronous by design — `@ethosagent/sqlite` is synchronous, and pretending
 * otherwise would only add `await`s that never yield.
 */
export interface CardStore {
  /**
   * Persist one card for a tool call. Returns its per-session `seq`.
   *
   * Idempotent on `(sessionId, toolCallId)`: an SSE-replayed or retried
   * `tool_end` returns the seq already assigned instead of inserting a second
   * row or advancing the counter.
   */
  append(sessionId: string, toolCallId: string, envelope: CardEnvelope): number;
  /** Every still-valid card for a session, in emission order. */
  list(sessionId: string): SessionCard[];
  /** Copy a session's cards onto another session, appended in source order. */
  copySession(fromSessionId: string, toSessionId: string): void;
  /** Drop every card for a session. */
  deleteSession(sessionId: string): void;
  close(): void;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS session_cards (
    session_id   TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    envelope     TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (session_id, tool_call_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS session_cards_seq ON session_cards(session_id, seq);
`;

interface CardRow {
  tool_call_id: string;
  seq: number;
  envelope: string;
}

export interface CardStoreOptions {
  /** Where invalid-on-read rows are reported. Defaults to silence. */
  logger?: Logger;
}

export class SQLiteCardStore implements CardStore {
  private readonly db: Database.Database;
  private readonly logger: Logger;

  constructor(dbPath: string, options: CardStoreOptions = {}) {
    // mkdir -p the parent directory — the same raw-fs exception the other
    // SQLite stores use for path setup (Storage covers ~/.ethos/ data IO, not
    // bootstrapping the DB file's enclosing directory). `:memory:` has no
    // parent path, so skip.
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
    this.logger = options.logger ?? noopLogger;
  }

  append(sessionId: string, toolCallId: string, envelope: CardEnvelope): number {
    // seq is derived and written inside one transaction so two concurrent
    // appends on the same session cannot read the same MAX(seq).
    const insert = this.db.transaction((): number => {
      const assigned = this.insertRow(sessionId, toolCallId, JSON.stringify(envelope));
      if (assigned !== null) return assigned;
      // PK conflict — this tool call already has a card (SSE replay, retry).
      const existing = this.db
        .prepare('SELECT seq FROM session_cards WHERE session_id = ? AND tool_call_id = ?')
        .get(sessionId, toolCallId) as { seq: number } | undefined;
      // The conflict proves the row is there; the fallback keeps the return
      // type honest rather than asserting non-null.
      return existing ? existing.seq : this.nextSeq(sessionId);
    });
    return insert();
  }

  list(sessionId: string): SessionCard[] {
    const rows = this.db
      .prepare(
        'SELECT tool_call_id, seq, envelope FROM session_cards WHERE session_id = ? ORDER BY seq ASC',
      )
      .all(sessionId) as CardRow[];

    const cards: SessionCard[] = [];
    for (const row of rows) {
      const envelope = this.parseEnvelope(row.envelope);
      if (!envelope) {
        this.logger.warn('skipping card that no longer validates', {
          component: 'session-cards',
          sessionId,
          toolCallId: row.tool_call_id,
        });
        continue;
      }
      cards.push({ toolCallId: row.tool_call_id, seq: row.seq, envelope });
    }
    return cards;
  }

  copySession(fromSessionId: string, toSessionId: string): void {
    // Session fork replays the source's whole message history into the new
    // session, tool messages and their `toolCallId`s included. Leaving the
    // cards behind would render that identical history one card poorer, so a
    // fork carries them too. Envelopes move as raw JSON — `list()` is the
    // single validation point, and re-validating here would drop rows the
    // source still shows.
    const rows = this.db
      .prepare(
        'SELECT tool_call_id, envelope FROM session_cards WHERE session_id = ? ORDER BY seq ASC',
      )
      .all(fromSessionId) as Array<{ tool_call_id: string; envelope: string }>;
    if (rows.length === 0) return;

    const copy = this.db.transaction((): void => {
      for (const row of rows) {
        this.insertRow(toSessionId, row.tool_call_id, row.envelope);
      }
    });
    copy();
  }

  deleteSession(sessionId: string): void {
    this.db.prepare('DELETE FROM session_cards WHERE session_id = ?').run(sessionId);
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Internals — callers hold the transaction, so these never open one.
  // -------------------------------------------------------------------------

  /** Insert at the session's next seq. Returns null when the PK already exists. */
  private insertRow(sessionId: string, toolCallId: string, envelopeJson: string): number | null {
    const seq = this.nextSeq(sessionId);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO session_cards
           (session_id, tool_call_id, seq, envelope, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sessionId, toolCallId, seq, envelopeJson, Date.now());
    return result.changes === 1 ? seq : null;
  }

  private nextSeq(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM session_cards WHERE session_id = ?')
      .get(sessionId) as { next: number };
    return row.next;
  }

  private parseEnvelope(json: string): CardEnvelope | null {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      return null;
    }
    const parsed = CardEnvelopeSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }
}
