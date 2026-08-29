import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { migrate } from '@ethosagent/sqlite';

// ---------------------------------------------------------------------------
// Durable call history for telephony (plan/phases/voice-v4-telephony.md)
//
// A phone call leaves nothing behind on its own. The lane it ran in is
// in-memory, the audio is transient, and the session store keeps the turns
// without the call FACTS around them — who rang, from which number, whether the
// screener refused it, what it cost. So "show me the calls" has no answer, and
// neither does "is a call happening right now".
//
// This is a SEPARATE database file from sessions.db, for the same reason
// session-cards is: a call is a surface-level record with its own lifecycle and
// its own retention, and pushing it into the STRICT table the LLM history is
// read from would couple a UI concern to the schema the agent loop depends on.
//
// The one invariant worth stating up front: `ringing` and `live` rows are LIVE
// STATE, not history. Nothing here deletes them, however old they look — an old
// ringing row is a call that is still up (or a call whose hang-up was lost,
// which is a bug to see, not a row to silently drop).
// ---------------------------------------------------------------------------

export type CallDirection = 'inbound' | 'outbound';

/**
 * Where a call is in its life.
 *
 * `screened` and `refused` are distinct from `failed` on purpose: the first two
 * are decisions Ethos made (the caller was not allowlisted, the budget was
 * spent), the third is the network or the provider letting us down. An operator
 * reading a call list needs to tell "we said no" from "it broke".
 */
export type CallStatus = 'ringing' | 'live' | 'completed' | 'screened' | 'refused' | 'failed';

/** Which voice stack served the call — the pipeline (STT→LLM→TTS) or a
 *  provider-native realtime session. */
export type CallTier = 'pipeline' | 'realtime';

export interface CallRecord {
  /** Caller-supplied and stable for the life of the call — the provider's call
   *  id, so a hang-up webhook can find the row it opened. */
  id: string;
  botKey: string;
  /** `voice:<botKey>:sip:<callerId>` — the same lane the turns ran in, so a
   *  call row and its transcript can be joined back together. */
  laneKey: string;
  direction: CallDirection;
  fromNumber: string;
  toNumber: string;
  personalityId?: string;
  tier?: CallTier;
  status: CallStatus;
  /** Epoch ms. */
  startedAt: number;
  endedAt?: number;
  /**
   * Why a call was screened/refused: `'not_allowlisted'`, `'over_concurrency'`,
   * `'rate_limited'`, `'over_budget'`, `'no_bot_match'`, or free text.
   *
   * Deliberately not an enum — a refusal reason is shown to a human, and a
   * closed set here would force every new guard to ship a schema change.
   */
  reason?: string;
  summary?: string;
  transcript?: string;
  costUsd?: number;
}

/**
 * What is known when the row is opened.
 *
 * Every field beyond the identifying six is optional because the two shapes of
 * call open differently: a real call arrives as `ringing` and learns its tier,
 * personality, summary and cost later, while a screened one is born terminal —
 * status, reason and `endedAt` are all known at the instant it is refused, and
 * making the guard write them in a second call would only invite a crash
 * between the two.
 */
export interface StartCallInput {
  id: string;
  botKey: string;
  laneKey: string;
  direction: CallDirection;
  fromNumber: string;
  toNumber: string;
  personalityId?: string;
  tier?: CallTier;
  /** Defaults to `'ringing'`. */
  status?: CallStatus;
  /** Defaults to now. */
  startedAt?: number;
  endedAt?: number;
  reason?: string;
  summary?: string;
  transcript?: string;
  costUsd?: number;
}

/** Fields a call learns after it is opened. An absent key is left alone — this
 *  is a patch, not a replacement. */
export interface UpdateCallInput {
  status?: CallStatus;
  tier?: CallTier;
  personalityId?: string;
  reason?: string;
  summary?: string;
  transcript?: string;
  costUsd?: number;
  endedAt?: number;
}

/** Widest window {@link CallLog.listRecent} will open. */
export const MAX_RECENT_CALLS = 200;

const DEFAULT_RECENT_CALLS = 50;

/** Rows a call can never leave — the only ones {@link CallLog.pruneEnded} may
 *  delete. `ringing` and `live` are absent by design. */
const TERMINAL_STATUSES: readonly CallStatus[] = ['completed', 'screened', 'refused', 'failed'];

/**
 * The contract the gateway and web-api code against, so surfaces can inject a
 * fake without a SQLite file. {@link SQLiteCallLog} is the durable
 * implementation; {@link InMemoryCallLog} is the test one.
 */
export interface CallLog {
  /**
   * Open a row for a call. Returns its id.
   *
   * Re-starting an existing id REJECTS rather than overwriting: two calls
   * claiming one id is a routing bug, and silently replacing the first would
   * destroy the transcript of a call that actually happened.
   */
  start(input: StartCallInput): Promise<string>;
  /**
   * Patch the supplied fields; leave the rest as they are.
   *
   * An unknown id is a NO-OP, not an error. Hang-up and post-call summary
   * handlers run long after `pruneEnded` may have removed the row, and a
   * pruned row must not turn a clean hang-up into a thrown exception on a live
   * call path.
   */
  update(id: string, patch: UpdateCallInput): Promise<void>;
  get(id: string): Promise<CallRecord | null>;
  /**
   * Newest first. `limit` defaults to {@link DEFAULT_RECENT_CALLS} and is
   * clamped to {@link MAX_RECENT_CALLS} — rows carry whole transcripts, so an
   * unbounded read is a memory hazard rather than a feature.
   *
   * `botKeys` filters to those bots; omitted means every bot in the file.
   */
  listRecent(opts?: { limit?: number; botKeys?: readonly string[] }): Promise<CallRecord[]>;
  /** Calls that are up right now (`ringing` or `live`), oldest first — the
   *  order a "calls in progress" indicator wants. */
  listLive(botKeys?: readonly string[]): Promise<CallRecord[]>;
  /**
   * Delete TERMINAL rows that ended before `cutoffMs`. Returns rows removed.
   *
   * `ringing` and `live` rows are never pruned at any age. They are live state,
   * and age is not evidence about them: a long call is still a call, and a
   * ringing row stuck past the cutoff is a lost hang-up worth seeing.
   */
  pruneEnded(cutoffMs: number): Promise<number>;
  close(): void;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS calls (
    id             TEXT PRIMARY KEY,
    bot_key        TEXT NOT NULL,
    lane_key       TEXT NOT NULL,
    direction      TEXT NOT NULL,
    from_number    TEXT NOT NULL,
    to_number      TEXT NOT NULL,
    personality_id TEXT,
    tier           TEXT,
    status         TEXT NOT NULL,
    started_at     INTEGER NOT NULL,
    ended_at       INTEGER,
    reason         TEXT,
    summary        TEXT,
    transcript     TEXT,
    cost_usd       REAL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS calls_status_started ON calls(status, started_at);
  CREATE INDEX IF NOT EXISTS calls_bot_started ON calls(bot_key, started_at);
`;

const CALL_LOG_SCHEMA_VERSION = 1;

interface CallRow {
  id: string;
  bot_key: string;
  lane_key: string;
  direction: string;
  from_number: string;
  to_number: string;
  personality_id: string | null;
  tier: string | null;
  status: string;
  started_at: number;
  ended_at: number | null;
  reason: string | null;
  summary: string | null;
  transcript: string | null;
  cost_usd: number | null;
}

function rowToCall(r: CallRow): CallRecord {
  return {
    id: r.id,
    botKey: r.bot_key,
    laneKey: r.lane_key,
    direction: r.direction as CallDirection,
    fromNumber: r.from_number,
    toNumber: r.to_number,
    personalityId: r.personality_id ?? undefined,
    tier: (r.tier ?? undefined) as CallTier | undefined,
    status: r.status as CallStatus,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? undefined,
    reason: r.reason ?? undefined,
    summary: r.summary ?? undefined,
    transcript: r.transcript ?? undefined,
    costUsd: r.cost_usd ?? undefined,
  };
}

/** Patch key → column. Also the allowlist: a key absent here is not writable,
 *  so a caller cannot rewrite a call's identity through `update`. */
const UPDATABLE_COLUMNS: Record<keyof UpdateCallInput, string> = {
  status: 'status',
  tier: 'tier',
  personalityId: 'personality_id',
  reason: 'reason',
  summary: 'summary',
  transcript: 'transcript',
  costUsd: 'cost_usd',
  endedAt: 'ended_at',
};

/** Clamp rather than throw — a display asking for too much should get a page,
 *  not a failure. A non-integer or absent limit falls back to the default. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit)) return DEFAULT_RECENT_CALLS;
  return Math.min(MAX_RECENT_CALLS, Math.max(1, limit));
}

function isLive(status: CallStatus): boolean {
  return status === 'ringing' || status === 'live';
}

// ---------------------------------------------------------------------------
// SQLiteCallLog
// ---------------------------------------------------------------------------

export class SQLiteCallLog implements CallLog {
  private readonly db: Database.Database;

  constructor(opts: { path: string }) {
    // mkdir -p the parent directory — the same raw-fs exception the other
    // SQLite stores use for path setup (Storage covers ~/.ethos/ data IO, not
    // bootstrapping the DB file's enclosing directory). `:memory:` has no
    // parent path, so skip.
    if (opts.path !== ':memory:') {
      mkdirSync(dirname(opts.path), { recursive: true });
    }
    this.db = new Database(opts.path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    // One calls.db is shared cross-process (gateway writes it, serve reads it).
    // An explicit busy timeout makes concurrent writes wait instead of throwing
    // SQLITE_BUSY.
    this.db.pragma('busy_timeout = 5000');

    migrate(this.db, {
      name: 'call-log',
      targetVersion: CALL_LOG_SCHEMA_VERSION,
      baseline: SCHEMA,
    });
  }

  async start(input: StartCallInput): Promise<string> {
    // The PRIMARY KEY does the rejecting: a duplicate id raises a UNIQUE
    // constraint error rather than replacing a call already on record.
    this.db
      .prepare(
        `INSERT INTO calls
         (id, bot_key, lane_key, direction, from_number, to_number, personality_id, tier,
          status, started_at, ended_at, reason, summary, transcript, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.botKey,
        input.laneKey,
        input.direction,
        input.fromNumber,
        input.toNumber,
        input.personalityId ?? null,
        input.tier ?? null,
        input.status ?? 'ringing',
        input.startedAt ?? Date.now(),
        input.endedAt ?? null,
        input.reason ?? null,
        input.summary ?? null,
        input.transcript ?? null,
        input.costUsd ?? null,
      );
    return input.id;
  }

  async update(id: string, patch: UpdateCallInput): Promise<void> {
    const sets: string[] = [];
    const values: Array<string | number> = [];
    for (const [key, column] of Object.entries(UPDATABLE_COLUMNS)) {
      const value = patch[key as keyof UpdateCallInput];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(value);
    }
    if (sets.length === 0) return;
    // An id that matches nothing simply changes no rows — the no-op the
    // interface promises, without a prior existence read.
    this.db.prepare(`UPDATE calls SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }

  async get(id: string): Promise<CallRecord | null> {
    const row = this.db.prepare('SELECT * FROM calls WHERE id = ?').get(id) as CallRow | undefined;
    return row ? rowToCall(row) : null;
  }

  async listRecent(opts?: { limit?: number; botKeys?: readonly string[] }): Promise<CallRecord[]> {
    const botKeys = opts?.botKeys;
    if (botKeys && botKeys.length === 0) return [];
    const where = botKeys ? `WHERE bot_key IN (${botKeys.map(() => '?').join(', ')})` : '';
    // The rowid tie-break is not decoration: calls opened inside one
    // millisecond otherwise come back in an arbitrary order, and a list that
    // reshuffles between two reads is unusable as a UI.
    const rows = this.db
      .prepare(
        `SELECT * FROM calls ${where}
         ORDER BY started_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(...(botKeys ?? []), clampLimit(opts?.limit)) as CallRow[];
    return rows.map(rowToCall);
  }

  async listLive(botKeys?: readonly string[]): Promise<CallRecord[]> {
    if (botKeys && botKeys.length === 0) return [];
    const botFilter = botKeys ? `AND bot_key IN (${botKeys.map(() => '?').join(', ')})` : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM calls
         WHERE status IN ('ringing', 'live') ${botFilter}
         ORDER BY started_at ASC, rowid ASC`,
      )
      .all(...(botKeys ?? [])) as CallRow[];
    return rows.map(rowToCall);
  }

  async pruneEnded(cutoffMs: number): Promise<number> {
    // COALESCE, because a terminal row can lack `ended_at` — a screened call
    // written in one shot, or a crash between the status write and the hang-up.
    // Its start time is then the only timestamp it has, and pruning by "no end
    // time, so never old" would keep those rows forever.
    const placeholders = TERMINAL_STATUSES.map(() => '?').join(', ');
    const result = this.db
      .prepare(
        `DELETE FROM calls
         WHERE status IN (${placeholders})
           AND COALESCE(ended_at, started_at) < ?`,
      )
      .run(...TERMINAL_STATUSES, cutoffMs);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// InMemoryCallLog
// ---------------------------------------------------------------------------

/**
 * Disk-free {@link CallLog} for tests.
 *
 * Insertion order into the Map stands in for SQLite's rowid — it is monotonic
 * for the same reason (rows are only ever appended or deleted), which is what
 * lets the two implementations agree on the same-millisecond tie-break.
 */
export class InMemoryCallLog implements CallLog {
  private readonly rows = new Map<string, CallRecord>();

  async start(input: StartCallInput): Promise<string> {
    if (this.rows.has(input.id)) {
      throw new Error(`call-log: call ${input.id} already started`);
    }
    const record: CallRecord = {
      id: input.id,
      botKey: input.botKey,
      laneKey: input.laneKey,
      direction: input.direction,
      fromNumber: input.fromNumber,
      toNumber: input.toNumber,
      personalityId: input.personalityId,
      tier: input.tier,
      status: input.status ?? 'ringing',
      startedAt: input.startedAt ?? Date.now(),
      endedAt: input.endedAt,
      reason: input.reason,
      summary: input.summary,
      transcript: input.transcript,
      costUsd: input.costUsd,
    };
    this.rows.set(input.id, record);
    return input.id;
  }

  async update(id: string, patch: UpdateCallInput): Promise<void> {
    const current = this.rows.get(id);
    if (!current) return;
    // Drop explicitly-undefined keys before the spread, so `{ summary:
    // undefined }` leaves the summary alone rather than blanking it — the same
    // thing the SQL side's "skip undefined" loop does.
    const defined = { ...patch };
    for (const key of Object.keys(defined) as Array<keyof UpdateCallInput>) {
      if (defined[key] === undefined) delete defined[key];
    }
    this.rows.set(id, { ...current, ...defined });
  }

  async get(id: string): Promise<CallRecord | null> {
    const row = this.rows.get(id);
    // A copy — the SQLite store hands back a fresh object every read, and a
    // fake a caller can mutate in place would hide that difference.
    return row ? { ...row } : null;
  }

  async listRecent(opts?: { limit?: number; botKeys?: readonly string[] }): Promise<CallRecord[]> {
    const botKeys = opts?.botKeys;
    if (botKeys && botKeys.length === 0) return [];
    const allowed = botKeys ? new Set(botKeys) : null;
    const matching = [...this.rows.values()].filter((r) => !allowed || allowed.has(r.botKey));
    // Reverse first, then a STABLE sort on startedAt: ties keep the reversed
    // insertion order, which is SQLite's `rowid DESC`.
    matching.reverse();
    matching.sort((a, b) => b.startedAt - a.startedAt);
    return matching.slice(0, clampLimit(opts?.limit)).map((r) => ({ ...r }));
  }

  async listLive(botKeys?: readonly string[]): Promise<CallRecord[]> {
    if (botKeys && botKeys.length === 0) return [];
    const allowed = botKeys ? new Set(botKeys) : null;
    const matching = [...this.rows.values()].filter(
      (r) => isLive(r.status) && (!allowed || allowed.has(r.botKey)),
    );
    // Insertion order is already `rowid ASC`, so a stable sort leaves ties in it.
    matching.sort((a, b) => a.startedAt - b.startedAt);
    return matching.map((r) => ({ ...r }));
  }

  async pruneEnded(cutoffMs: number): Promise<number> {
    let removed = 0;
    for (const [id, row] of this.rows) {
      if (isLive(row.status)) continue;
      if ((row.endedAt ?? row.startedAt) >= cutoffMs) continue;
      this.rows.delete(id);
      removed++;
    }
    return removed;
  }

  close(): void {
    // Nothing to release.
  }
}
