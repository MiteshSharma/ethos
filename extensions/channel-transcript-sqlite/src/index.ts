import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildLaneKey } from '@ethosagent/core';
import { redactString } from '@ethosagent/safety-redact';
import Database, { migrate } from '@ethosagent/sqlite';
import type {
  ChannelLaneListOptions,
  ChannelLaneSummary,
  ChannelTranscriptMessage,
  ChannelTranscriptPage,
  ChannelTranscriptReadOptions,
  ChannelTranscriptRecord,
  ChannelTranscriptStore,
} from '@ethosagent/types';

// ---------------------------------------------------------------------------
// The observe-mode transcript store
//
// Where the gateway writes every message it watched but did not answer, and
// where the nightly digest reads. The contract, and what it is NOT, is in
// `packages/types/src/channel-transcript.ts`.
//
// Same shape as the other SQLite-backed stores here (job-store,
// delivery-ledger, session-cards, call-log, inbound-dedup, notify-queue): raw
// `node:fs` only to mkdir -p the database file's parent directory, then
// `@ethosagent/sqlite` opens the path directly. Storage covers ~/.ethos/ data
// IO, not bootstrapping a DB file's enclosing directory.
// ---------------------------------------------------------------------------

/**
 * Cap on one `readSince` page. R9's number: the digest turn reads at most 500
 * messages per lane and says how many earlier ones it left out.
 */
export const DEFAULT_READ_LIMIT = 500;

/**
 * Every column but `id`, shared between the baseline and the v2 migration's
 * replacement table so the two cannot drift apart. Order matters: the
 * migration copies with `SELECT *`, which is only correct because both tables
 * are generated from this same list behind the same leading `id`.
 */
const COLUMNS = `
    lane_key    TEXT NOT NULL,
    platform    TEXT NOT NULL,
    bot_key     TEXT NOT NULL,
    chat_id     TEXT NOT NULL,
    thread_id   TEXT,
    sender_id   TEXT NOT NULL,
    sender_name TEXT,
    text        TEXT NOT NULL,
    message_id  TEXT,
    sent_at     INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL`;

/**
 * AUTOINCREMENT on `id` is load-bearing, not decoration.
 *
 * A plain `INTEGER PRIMARY KEY` is SQLite's rowid, and SQLite assigns the next
 * one as `max(rowid) + 1` OF THE ROWS THAT ARE STILL THERE — so it REUSES ids
 * once the highest rows are gone. `id` is the consumption cursor the digest
 * persists per lane (`readSince(lane, id > watermark)`), and retention deletes
 * by `recorded_at`, so a deployment quiet for longer than its retention window
 * has its whole transcript pruned away and the next message lands at id 1 —
 * below every stored watermark. `id > watermark` then matches nothing, for
 * good: that lane is never digested again, and nothing anywhere raises an
 * error. AUTOINCREMENT keeps the high-water mark in `sqlite_sequence`, which
 * DELETE does not touch, so an id is never handed out twice.
 *
 * Measured cost on the inbound path: negligible, but no longer invisible.
 * These figures were first taken while the commit still paid a WAL fsync,
 * which swallowed the difference whole — 4.21 ms/record plain against 4.34
 * ms/record with AUTOINCREMENT, inside the 4.11-4.43 ms spread of the runs
 * themselves. The constructor now sets `synchronous = NORMAL` (see the note
 * there), so there is no fsync left to hide behind: re-measured on the same
 * machine, 0.018 ms/record plain against 0.032 ms/record with AUTOINCREMENT.
 * The `sqlite_sequence` update is a second row written in the same commit,
 * and 14µs is what that costs. AUTOINCREMENT is here for the correctness
 * reason above, not because it was free; it is still the right call at 14µs.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS transcript (
    -- AUTOINCREMENT: retention can prune this table empty, and a reused id
    -- would fall under the digest's stored cursor. See the note above.
    id          INTEGER PRIMARY KEY AUTOINCREMENT,${COLUMNS}
  ) STRICT;

  CREATE INDEX IF NOT EXISTS transcript_lane_sent
    ON transcript(lane_key, sent_at);

  CREATE INDEX IF NOT EXISTS transcript_recorded
    ON transcript(recorded_at);

  -- The access path \`readSince\` actually uses. See the note on that method
  -- for the measurements, including the ones showing \`listLanes\` does not
  -- regress.
  CREATE INDEX IF NOT EXISTS transcript_lane_id
    ON transcript(lane_key, id);

  -- PARTIAL, so the many rows that arrive without a platform message id do not
  -- all collide on a single (lane_key, NULL) pair. SQLite requires an upsert
  -- targeting a partial index to repeat its WHERE clause; record() does.
  CREATE UNIQUE INDEX IF NOT EXISTS transcript_lane_message
    ON transcript(lane_key, message_id) WHERE message_id IS NOT NULL;
`;

/**
 * v1 -> v2: rebuild `transcript` with `id INTEGER PRIMARY KEY AUTOINCREMENT`.
 *
 * A real rebuild, because SQLite has no `ALTER TABLE` that adds AUTOINCREMENT:
 * the keyword is part of the stored `CREATE TABLE` text, and `sqlite_sequence`
 * only starts tracking a table once that text says so. Ids are copied
 * verbatim — an id IS the digest's persisted cursor, so renumbering here would
 * cause exactly the misalignment the migration exists to prevent — and
 * inserting them explicitly seeds `sqlite_sequence` to the greatest one, which
 * is where the new sequence has to continue from.
 *
 * `SELECT *` is safe here and only here: both tables put `id` first and take
 * the rest from {@link COLUMNS}, so the two column lists are the same list.
 *
 * Indexes are not carried across — `DROP TABLE` takes them with it, freeing
 * their names — so the baseline is re-executed at the end. It is idempotent,
 * and it is the one definition of what those indexes are.
 *
 * Cost is one-time, at open, and it is paid in full before the process serves
 * anything: 382 ms for a 200k-row (56 MB) file, 2413 ms for a 1.2M-row
 * (334 MB) one. `migrate` runs this inside a transaction, so an interrupted
 * upgrade leaves a v1 database, not a half-rebuilt one.
 *
 * That transaction is the one exception to the constructor's "keep them
 * single-statement" rule, and it is a knowing one: for the length of the
 * rebuild a peer process's `record()` waits on the write lock. The wait is
 * bounded by the `busy_timeout` set above, which is why the pragma is set
 * BEFORE `migrate` runs — a peer that hit this with no timeout would throw
 * `database is locked` and drop an observed message. It happens once per
 * database, on the first open by a build that ships this step.
 */
function migrateToAutoincrement(db: Database.Database): void {
  db.exec(`CREATE TABLE transcript_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,${COLUMNS}
  ) STRICT`);
  db.exec('INSERT INTO transcript_v2 SELECT * FROM transcript');
  db.exec('DROP TABLE transcript');
  db.exec('ALTER TABLE transcript_v2 RENAME TO transcript');
  db.exec(SCHEMA);
}

/** `undefined` is not a bindable SQLite value; a STRICT column wants NULL. */
function orNull(value: string | undefined): string | null {
  return value ?? null;
}

function optional(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * The lane key for one watched room. Mirrors the gateway's own construction
 * (`buildLaneKey(platform, botKey, chatId[, threadId])`) so a transcript lane
 * and the conversation lane for the same room are the same string — a thread
 * is a distinct conversation, and therefore a distinct lane, in both.
 */
export function transcriptLaneKey(
  platform: string,
  botKey: string,
  chatId: string,
  threadId?: string,
): string {
  return threadId
    ? buildLaneKey(platform, botKey, chatId, threadId)
    : buildLaneKey(platform, botKey, chatId);
}

/**
 * The `laneKeyPrefix` selecting every room one bot watches.
 *
 * Not `` `${platform}:${botKey}:` `` — `buildLaneKey` URL-encodes each segment,
 * so a botKey with a reserved character in it produces a key the naive
 * template does not match, and the caller silently gets no lanes back.
 */
export function transcriptLanePrefix(platform: string, botKey: string): string {
  return `${buildLaneKey(platform, botKey)}:`;
}

interface TranscriptRow {
  id: number;
  lane_key: string;
  sender_id: string;
  sender_name: string | null;
  text: string;
  message_id: string | null;
  sent_at: number;
  recorded_at: number;
}

interface LaneRow {
  lane_key: string;
  platform: string;
  bot_key: string;
  chat_id: string;
  thread_id: string | null;
  count: number;
  last_sent_at: number;
}

export class SQLiteChannelTranscriptStore implements ChannelTranscriptStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    // mkdir -p the parent directory — the raw-fs exception the other SQLite
    // stores use for path setup. `:memory:` has no parent path.
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    // A DURABILITY TRADE, taken deliberately and only for this file.
    //
    // SQLite's default is `synchronous = FULL`: every commit fsyncs the WAL.
    // Measured on this write path, that fsync IS the write — 4.7ms per
    // `record()` against 0.07ms with NORMAL, a 71x difference and ~98% of the
    // uncontended inbound cost. It is per-COMMIT, not per-row, so it is the
    // same 4.7ms whatever the row holds.
    //
    // What NORMAL gives up is precise (sqlite.org/pragma.html#pragma_synchronous):
    // in WAL mode it is "safe from corruption" and "always consistent", but
    // "a transaction committed in WAL mode with synchronous=NORMAL might roll
    // back following a power loss or system crash". Process crashes lose
    // nothing — the OS still holds the writes. So the exposure is exactly:
    // a power cut or kernel panic can drop the last few observed messages.
    //
    // That is the right trade HERE and nowhere near automatic elsewhere. This
    // table is observational: lines other people said in a room the bot is
    // watching, kept for a retention window and pruned by cron. Losing the tail
    // of it costs a digest a few lines. Nothing reads it to decide whether work
    // still needs doing — that is what delivery-ledger, job-store, notify-queue,
    // inbound-dedup and the A2A task store are for, and they all stay at FULL.
    // See AGENTS.md's SQLite roster before copying this line into another store.
    //
    // The comment below is the other half of the argument: this write happens
    // inline on the gateway's inbound path, in a synchronous API, so every
    // millisecond here stops the whole event loop for every bot.
    this.db.pragma('synchronous = NORMAL');
    // The file is read by web-api while the gateway writes it. An explicit
    // busy timeout makes a concurrent write wait instead of throwing
    // SQLITE_BUSY on the inbound path.
    //
    // It is a CEILING, not a budget: `@ethosagent/sqlite` is synchronous, so
    // every millisecond `record()` waits here is a millisecond this process's
    // entire event loop is stopped — every bot and every channel, not just the
    // observed room. The competing writer is `pruneChannelTranscript` running
    // in a peer process (`ethos serve` and `ethos gateway` both hold the
    // `observability-prune` cron), and its DELETE holds the write lock for
    // about 4.4µs per row: measured cross-process, one inbound `record()`
    // blocked 1046ms behind a 300k-row prune and 4742ms behind a 1.2M-row one.
    //
    // 5000 is the house value across the SQLite stores and it stays. Shortening
    // it does not make the message arrive sooner — it makes it not arrive at
    // all: `record()` throws `database is locked`, the gateway reports
    // `channel.observed_failed`, and an observed message is gone for good. A
    // routine prune holds the lock for a few hundred milliseconds, so a shorter
    // ceiling would trade a rare tail stall for daily transcript loss.
    //
    // What this DOES mean: any write transaction opened against this file is a
    // stall handed straight to the inbound path. Keep them single-statement.
    this.db.pragma('busy_timeout = 5000');

    migrate(this.db, {
      name: 'channel-transcript',
      targetVersion: 2,
      baseline: SCHEMA,
      migrations: { 2: migrateToAutoincrement },
    });
  }

  async record(entry: ChannelTranscriptRecord): Promise<void> {
    const laneKey = transcriptLaneKey(entry.platform, entry.botKey, entry.chatId, entry.threadId);
    // Secrets only. NOT `redactPii`: these are people talking to each other,
    // and a digest with every name, number and address replaced by a tag is a
    // digest of nothing. Keys and tokens are different — one pasted into a
    // group chat would otherwise sit in this file for the retention window.
    const text = redactString(entry.text);
    this.db
      .prepare(
        `INSERT INTO transcript
           (lane_key, platform, bot_key, chat_id, thread_id, sender_id, sender_name,
            text, message_id, sent_at, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(lane_key, message_id) WHERE message_id IS NOT NULL
         DO UPDATE SET text = excluded.text,
                       sent_at = excluded.sent_at,
                       recorded_at = excluded.recorded_at`,
      )
      .run(
        laneKey,
        entry.platform,
        entry.botKey,
        entry.chatId,
        orNull(entry.threadId),
        entry.senderId,
        orNull(entry.senderName),
        text,
        orNull(entry.messageId),
        entry.sentAt,
        entry.recordedAt,
      );
  }

  /**
   * Everything in `laneKey` ingested after `sinceId`, in ingestion order.
   *
   * `id` — the INTEGER PRIMARY KEY, so SQLite's rowid — is the ingestion
   * sequence, and it is the only column here that can carry a consumption
   * cursor. `sent_at` cannot: the sender chooses it, it arrives out of order,
   * and a floor derived from it silently loses any message recorded long
   * enough after the moment it claims to have been sent. `recorded_at` cannot
   * either — it is a clock reading, so two rows can share one and a cursor
   * made of it either re-reads or skips the tie.
   *
   * ASCENDING, and the cap takes the FIRST `limit` rows past the cursor rather
   * than the last. This read is one step of a drain, not a tail of history:
   * its only caller advances a consumption cursor to the greatest id it was
   * handed, so every row this page leaves out has to sit ABOVE that cursor to
   * survive. Handing back the newest `limit` put the omitted rows BELOW it,
   * and the cursor then marked them consumed — a busy lane lost its oldest
   * undigested messages permanently, on every run. Oldest-first makes the cap
   * a deferral: what it leaves behind is read by the next call.
   *
   * `id` is unique, so the order is total and needs no tie-break.
   *
   * `transcript_lane_id` — `(lane_key, id)` — is the index this read wants,
   * and it was previously left out on the theory that a second
   * `lane_key`-leading index would perturb `listLanes`' loose index scan. That
   * was never measured. It has been now, at 200k rows over 200 lanes:
   *
   *   listLanes (since=now, the digest/UI call)  0.295 ms -> 0.299 ms
   *   readSince count, mid-lane cursor           0.025 ms -> 0.006 ms
   *   readSince rows,  mid-lane cursor           0.263 ms -> 0.203 ms
   *
   * `listLanes`' plan DOES change: the recursive CTE's distinct-lane walk
   * switches from `transcript_lane_sent` to `transcript_lane_id`. Both are
   * covering for `MIN(lane_key)`, the step is still
   * `SEARCH ... (lane_key>?)` — a loose index scan, not a table scan — and
   * `transcript_lane_id` is the SMALLER of the two (SQLite appends the rowid
   * to every index, so `(lane_key, id)` is `(lane_key, rowid)`, one column
   * narrower than `(lane_key, sent_at, rowid)`). The newest-row and count
   * subqueries still take `transcript_lane_sent`. Cost still tracks lane
   * count, not message count.
   *
   * What the index buys is not the 60µs above, it is the SHAPE of this read.
   * Without it the planner takes `transcript_lane_sent (lane_key=?)` and adds
   * `USE TEMP B-TREE FOR ORDER BY`, so it walks the WHOLE lane to order by
   * `id` before `LIMIT` applies — cost grows with the lane, not with the page.
   * Measured on a 200-lane table as one lane grows (first 500 past cursor 0):
   *
   *   lane rows      1k       20k      100k     300k
   *   without     0.502 ms  0.968 ms  1.602 ms  3.551 ms
   *   with        0.431 ms  0.410 ms  0.409 ms  0.420 ms
   *
   * Flat, because the index makes `id > ?` a seek and the LIMIT a stop.
   */
  async readSince(
    laneKey: string,
    sinceId: number,
    options: ChannelTranscriptReadOptions = {},
  ): Promise<ChannelTranscriptPage> {
    const limit = options.limit ?? DEFAULT_READ_LIMIT;
    const total = this.db
      .prepare('SELECT COUNT(*) AS n FROM transcript WHERE lane_key = ? AND id > ?')
      .get(laneKey, sinceId) as { n: number };

    const rows = this.db
      .prepare(
        `SELECT id, lane_key, sender_id, sender_name, text, message_id, sent_at, recorded_at
         FROM transcript
         WHERE lane_key = ? AND id > ?
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(laneKey, sinceId, limit) as TranscriptRow[];

    const messages: ChannelTranscriptMessage[] = rows.map((row) => ({
      id: row.id,
      laneKey: row.lane_key,
      senderId: row.sender_id,
      senderName: optional(row.sender_name),
      text: row.text,
      messageId: optional(row.message_id),
      sentAt: row.sent_at,
      recordedAt: row.recorded_at,
    }));

    return { messages, omittedCount: Math.max(total.n - messages.length, 0) };
  }

  async listLanes(options: ChannelLaneListOptions = {}): Promise<ChannelLaneSummary[]> {
    const prefix = options.laneKeyPrefix ?? '';
    const since = options.since ?? 0;

    // `substr(lane_key, 1, n) = prefix`, not LIKE or GLOB. Lane keys are
    // URL-encoded, so a real key can contain `%` (`%3A`) and `_` — both of
    // which are LIKE wildcards. A prefix filter that silently matched more
    // lanes than asked for would leak one bot's rooms into another's list.
    // The comparison is byte-exact and needs no escaping.
    //
    // `count` is windowed by `since` while the lane set and `lastSentAt` are
    // not: a room that recorded nothing today is still a watched room, and the
    // UI has to show it with a zero rather than drop it.
    //
    // The recursive CTE is a LOOSE INDEX SCAN, and it is the whole point of
    // this query. The obvious `GROUP BY lane_key` reads every retained row to
    // produce one line per lane, so a settings page polling every 30s costs a
    // synchronous scan of the entire transcript — and `@ethosagent/sqlite` is
    // synchronous, so that scan blocks the process handling inbound messages.
    // Instead `lane` walks only the DISTINCT lane keys, each step a single
    // `MIN(lane_key) WHERE lane_key > previous` seek into `transcript_lane_sent`,
    // and each lane's newest row is one more seek to the end of its range in
    // the same index. Cost tracks lane count, not message count. Measured on
    // 1M rows across 300 lanes: 1336ms grouped, 0.7ms here.
    //
    // `newest` supplies platform/bot_key/chat_id/thread_id because a lane key
    // is `buildLaneKey` of exactly those four, and `encodeURIComponent` makes
    // that injective — every row in a lane carries the same values, so the one
    // row already fetched for `lastSentAt` answers for all of them.
    const rows = this.db
      .prepare(
        `WITH RECURSIVE lane(lane_key) AS (
           SELECT MIN(lane_key) FROM transcript
           UNION ALL
           SELECT (SELECT MIN(n.lane_key) FROM transcript n WHERE n.lane_key > lane.lane_key)
             FROM lane WHERE lane.lane_key IS NOT NULL
         )
         SELECT newest.lane_key, newest.platform, newest.bot_key, newest.chat_id,
                newest.thread_id,
                (SELECT COUNT(*) FROM transcript c
                   WHERE c.lane_key = lane.lane_key AND c.sent_at >= ?) AS count,
                newest.sent_at AS last_sent_at
         FROM lane
         JOIN transcript newest ON newest.id = (
           SELECT m.id FROM transcript m
            WHERE m.lane_key = lane.lane_key
            ORDER BY m.sent_at DESC, m.id DESC
            LIMIT 1
         )
         WHERE lane.lane_key IS NOT NULL AND substr(lane.lane_key, 1, ?) = ?
         ORDER BY last_sent_at DESC, newest.lane_key ASC`,
      )
      .all(since, prefix.length, prefix) as LaneRow[];

    return rows.map((row) => ({
      laneKey: row.lane_key,
      platform: row.platform,
      botKey: row.bot_key,
      chatId: row.chat_id,
      threadId: optional(row.thread_id),
      count: row.count,
      lastSentAt: row.last_sent_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}

export { pruneChannelTranscript } from './retention';
