import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '@ethosagent/sqlite';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { RETENTION_DEFAULTS } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobStore } from '../blob-store';
import { mergeRetentionConfig, parseDuration, pruneObservability } from '../retention';

// ---------------------------------------------------------------------------
// parseDuration
// ---------------------------------------------------------------------------

describe('parseDuration', () => {
  it('parses 90d correctly', () => {
    expect(parseDuration('90d')).toBe(90 * 86_400_000);
  });

  it('returns null for "forever"', () => {
    expect(parseDuration('forever')).toBeNull();
  });

  it('parses 2w correctly', () => {
    expect(parseDuration('2w')).toBe(14 * 86_400_000);
  });

  it('parses months', () => {
    expect(parseDuration('1m')).toBe(30 * 86_400_000);
  });

  it('parses years', () => {
    expect(parseDuration('1y')).toBe(365 * 86_400_000);
  });

  it('throws on invalid duration string', () => {
    expect(() => parseDuration('invalid')).toThrow('Invalid duration: "invalid"');
  });

  it('throws on unsupported unit', () => {
    expect(() => parseDuration('10h')).toThrow('Invalid duration');
  });
});

// ---------------------------------------------------------------------------
// mergeRetentionConfig
// ---------------------------------------------------------------------------

describe('mergeRetentionConfig', () => {
  it('returns global config unchanged when no override', () => {
    const merged = mergeRetentionConfig(RETENTION_DEFAULTS);
    expect(merged.messages).toBe('365d');
    expect(merged.traces).toBe('90d');
  });

  it('override replaces specified fields only', () => {
    const merged = mergeRetentionConfig(RETENTION_DEFAULTS, { messages: '730d', blobs: '30d' });
    expect(merged.messages).toBe('730d');
    expect(merged.blobs).toBe('30d');
    expect(merged.traces).toBe('90d');
  });

  it('deep-merges events sub-block', () => {
    const merged = mergeRetentionConfig(RETENTION_DEFAULTS, {
      events: { audit: '1825d' },
    });
    expect(merged.events?.audit).toBe('1825d');
    expect(merged.events?.error).toBe('90d');
    expect(merged.events?.install).toBe('forever');
  });
});

// ---------------------------------------------------------------------------
// pruneObservability
// ---------------------------------------------------------------------------

function makeTestDb(): Database.Database {
  const db = new Database(join(tmpdir(), `obs-retention-test-${Date.now()}.db`));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS traces (
      trace_id        TEXT PRIMARY KEY,
      session_id      TEXT,
      kind            TEXT NOT NULL,
      start_ts        INTEGER NOT NULL,
      end_ts          INTEGER,
      status          TEXT,
      subject_id      TEXT,
      snapshot_id     TEXT,
      attrs           TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS spans (
      span_id         TEXT PRIMARY KEY,
      trace_id        TEXT NOT NULL,
      parent_span_id  TEXT,
      kind            TEXT NOT NULL,
      name            TEXT NOT NULL,
      start_ts        INTEGER NOT NULL,
      end_ts          INTEGER,
      status          TEXT,
      attrs           TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS events (
      event_id        TEXT PRIMARY KEY,
      trace_id        TEXT,
      span_id         TEXT,
      ts              INTEGER NOT NULL,
      category        TEXT NOT NULL,
      severity        TEXT NOT NULL,
      code            TEXT,
      cause           TEXT,
      details         TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS snapshots (
      snapshot_id     TEXT PRIMARY KEY,
      taken_at        INTEGER NOT NULL,
      subject_id      TEXT NOT NULL,
      body            TEXT NOT NULL
    ) STRICT;
  `);
  return db;
}

let db: Database.Database;

beforeEach(() => {
  db = makeTestDb();
});

afterEach(() => {
  db.close();
});

const NOW = 1_000_000_000_000; // fixed reference point
const OLD = NOW - 100 * 86_400_000; // 100 days ago — past 90d cutoff
const RECENT = NOW - 10 * 86_400_000; // 10 days ago — within 90d

function insertTrace(id: string, startTs: number): void {
  db.prepare(`INSERT INTO traces (trace_id, kind, start_ts) VALUES (?, 'turn', ?)`).run(
    id,
    startTs,
  );
}

function insertSpan(id: string, traceId: string, startTs: number): void {
  db.prepare(
    `INSERT INTO spans (span_id, trace_id, kind, name, start_ts) VALUES (?, ?, 'internal', 'test', ?)`,
  ).run(id, traceId, startTs);
}

function insertEvent(id: string, category: string, ts: number): void {
  db.prepare(`INSERT INTO events (event_id, category, severity, ts) VALUES (?, ?, 'info', ?)`).run(
    id,
    category,
    ts,
  );
}

describe('pruneObservability', () => {
  it('dry-run returns correct counts without deleting', () => {
    insertTrace('old-trace', OLD);
    insertTrace('new-trace', RECENT);
    insertSpan('old-span', 'old-trace', OLD);
    insertSpan('new-span', 'new-trace', RECENT);
    insertEvent('old-error', 'error', OLD);
    insertEvent('new-error', 'error', RECENT);

    const result = pruneObservability(db, RETENTION_DEFAULTS, { dryRun: true, now: NOW });

    expect(result.traces).toBe(1);
    expect(result.spans).toBe(1);
    expect(result.events).toBe(1);

    // Nothing actually deleted
    const traceCount = (db.prepare('SELECT COUNT(*) as n FROM traces').get() as { n: number }).n;
    expect(traceCount).toBe(2);
  });

  it('actually deletes old rows and keeps recent ones', () => {
    insertTrace('old-trace', OLD);
    insertTrace('new-trace', RECENT);
    insertSpan('old-span', 'old-trace', OLD);
    insertSpan('new-span', 'new-trace', RECENT);
    insertEvent('old-error', 'error', OLD);
    insertEvent('new-error', 'error', RECENT);

    const result = pruneObservability(db, RETENTION_DEFAULTS, { dryRun: false, now: NOW });

    expect(result.traces).toBe(1);
    expect(result.spans).toBe(1);
    expect(result.events).toBe(1);

    const remainingTraces = (db.prepare('SELECT COUNT(*) as n FROM traces').get() as { n: number })
      .n;
    const remainingSpans = (db.prepare('SELECT COUNT(*) as n FROM spans').get() as { n: number }).n;
    const remainingEvents = (db.prepare('SELECT COUNT(*) as n FROM events').get() as { n: number })
      .n;

    expect(remainingTraces).toBe(1);
    expect(remainingSpans).toBe(1);
    expect(remainingEvents).toBe(1);
  });

  it('respects "forever" — install events are never deleted', () => {
    insertEvent('old-install', 'install.setup', OLD);
    insertEvent('new-install', 'install.setup', RECENT);

    const result = pruneObservability(db, RETENTION_DEFAULTS, { dryRun: false, now: NOW });

    expect(result.events).toBe(0); // install.% is forever

    const remaining = (db.prepare('SELECT COUNT(*) as n FROM events').get() as { n: number }).n;
    expect(remaining).toBe(2);
  });

  it('funnel.* events are exempt from pruning — they survive any TTL (W4.2)', () => {
    // 10x older than every enumerated TTL. `funnel.%` is intentionally not in
    // the retention category list, so these must survive `doctor --funnel`
    // months (or years) later.
    const ancient = NOW - 4000 * 86_400_000;
    insertEvent('funnel-setup', 'funnel.setup_completed', ancient);
    insertEvent('funnel-first', 'funnel.first_reply', ancient);
    insertEvent('funnel-channel', 'funnel.channel_first_reply', ancient);
    insertEvent('old-error', 'error', ancient); // control: this one IS pruned

    const result = pruneObservability(db, RETENTION_DEFAULTS, { dryRun: false, now: NOW });

    expect(result.events).toBe(1); // only the control error event
    const remaining = db
      .prepare("SELECT event_id FROM events WHERE category LIKE 'funnel.%' ORDER BY event_id")
      .all() as Array<{ event_id: string }>;
    expect(remaining.map((r) => r.event_id)).toEqual([
      'funnel-channel',
      'funnel-first',
      'funnel-setup',
    ]);
  });

  it('prunes audit events past their TTL', () => {
    // Old enough to be past 365d audit TTL
    const veryOld = NOW - 400 * 86_400_000;
    insertEvent('old-audit', 'audit.tool_call', veryOld);
    insertEvent('new-audit', 'audit.tool_call', RECENT);

    const result = pruneObservability(db, RETENTION_DEFAULTS, { dryRun: false, now: NOW });

    expect(result.events).toBe(1);
    const remaining = (db.prepare('SELECT COUNT(*) as n FROM events').get() as { n: number }).n;
    expect(remaining).toBe(1);
  });

  it('orphaned snapshots are pruned; snapshots referenced by surviving traces are kept', () => {
    // snap-A is referenced by an old trace that will be pruned
    // snap-B is referenced by a recent trace that survives
    // snap-C is orphaned (no trace references it)
    db.prepare(
      `INSERT INTO traces (trace_id, kind, start_ts, snapshot_id) VALUES (?, 'turn', ?, ?)`,
    ).run('old-trace', OLD, 'snap-A');
    db.prepare(
      `INSERT INTO traces (trace_id, kind, start_ts, snapshot_id) VALUES (?, 'turn', ?, ?)`,
    ).run('new-trace', RECENT, 'snap-B');
    for (const [id] of [['snap-A'], ['snap-B'], ['snap-C']]) {
      db.prepare(
        `INSERT INTO snapshots (snapshot_id, taken_at, subject_id, body) VALUES (?, ?, 'eng', '{}')`,
      ).run(id, RECENT);
    }

    const result = pruneObservability(db, RETENTION_DEFAULTS, { dryRun: false, now: NOW });

    expect(result.traces).toBe(1); // old-trace pruned
    expect(result.snapshots).toBe(2); // snap-A (now orphaned) + snap-C (always orphaned)

    const snaps = (
      db.prepare('SELECT snapshot_id FROM snapshots').all() as { snapshot_id: string }[]
    ).map((r) => r.snapshot_id);
    expect(snaps).toEqual(['snap-B']); // only the referenced survivor remains
  });

  it('per-subject retention override: longer TTL prevents pruning', () => {
    // OLD trace is 100 days old — past the 90d default but within a 200d override
    insertTrace('old-trace', OLD);

    const override = mergeRetentionConfig(RETENTION_DEFAULTS, { traces: '200d', spans: '200d' });
    const result = pruneObservability(db, override, { dryRun: false, now: NOW });

    expect(result.traces).toBe(0); // NOT pruned under 200d TTL
    const remaining = (db.prepare('SELECT COUNT(*) as n FROM traces').get() as { n: number }).n;
    expect(remaining).toBe(1);
  });

  it('per-subject retention override: shorter TTL prunes more aggressively', () => {
    // RECENT trace is 10 days old — within 90d default but past a 7d override
    insertTrace('recent-trace', RECENT);

    const override = mergeRetentionConfig(RETENTION_DEFAULTS, { traces: '7d', spans: '7d' });
    const result = pruneObservability(db, override, { dryRun: false, now: NOW });

    expect(result.traces).toBe(1); // pruned under 7d TTL
    const remaining = (db.prepare('SELECT COUNT(*) as n FROM traces').get() as { n: number }).n;
    expect(remaining).toBe(0);
  });

  it('excludeSubjectIds: global pass does not delete rows belonging to excluded subjects', () => {
    // subject-A trace is 100 days old (past 90d global) but should survive because
    // subject A is excluded from the global pass (it has its own longer-TTL pass).
    db.prepare(
      `INSERT INTO traces (trace_id, kind, start_ts, subject_id) VALUES (?, 'turn', ?, ?)`,
    ).run('a-trace', OLD, 'subject-a');
    // Unscoped trace of the same age — no subject, should be pruned by global pass.
    insertTrace('global-trace', OLD);

    const result = pruneObservability(db, RETENTION_DEFAULTS, {
      dryRun: false,
      now: NOW,
      excludeSubjectIds: ['subject-a'],
    });

    expect(result.traces).toBe(1); // only global-trace pruned
    const remaining = (
      db.prepare('SELECT trace_id FROM traces').all() as { trace_id: string }[]
    ).map((r) => r.trace_id);
    expect(remaining).toEqual(['a-trace']); // subject-a row survives
  });

  it('messages pruning uses ISO timestamp column and prunes old messages', () => {
    const sessDb = makeSessDb();

    // Messages retention default is 365d. Use 400d-old message to cross the cutoff.
    const oldIso = new Date(NOW - 400 * 86_400_000).toISOString();
    const recentIso = new Date(RECENT).toISOString();
    insertMessage(sessDb, 's1', 'old msg', oldIso);
    insertMessage(sessDb, 's1', 'recent msg', recentIso);

    const result = pruneObservability(db, RETENTION_DEFAULTS, {
      dryRun: false,
      now: NOW,
      sessDb,
    });

    expect(result.messages).toBe(1); // old message pruned
    const remaining = (sessDb.prepare('SELECT COUNT(*) as n FROM messages').get() as { n: number })
      .n;
    expect(remaining).toBe(1); // recent message kept
    sessDb.close();
  });

  // A1a — `ethos data prune` opens sessions.db raw, without running the store's
  // migrations, so the file may predate the usage rollup entirely. Pruning
  // messages is the primary job: a rollup that cannot be maintained is skipped,
  // never allowed to block the delete.
  it('prunes messages on a sessions.db with no sessions table', () => {
    const sessDb = new Database(':memory:');
    sessDb.exec(`
      CREATE TABLE messages (
        id         INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        content    TEXT NOT NULL,
        timestamp  TEXT NOT NULL
      ) STRICT;
    `);
    insertMinimalMessage(sessDb, 's1', 'old', new Date(NOW - 400 * 86_400_000).toISOString());
    insertMinimalMessage(sessDb, 's1', 'recent', new Date(RECENT).toISOString());

    const result = pruneObservability(db, RETENTION_DEFAULTS, {
      dryRun: false,
      now: NOW,
      sessDb,
    });

    expect(result.messages).toBe(1);
    const remaining = (sessDb.prepare('SELECT COUNT(*) as n FROM messages').get() as { n: number })
      .n;
    expect(remaining).toBe(1);
    sessDb.close();
  });

  it('prunes messages when the sessions table lacks the usage columns', () => {
    const sessDb = new Database(':memory:');
    sessDb.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, key TEXT NOT NULL) STRICT;

      CREATE TABLE messages (
        id         INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        content    TEXT NOT NULL,
        timestamp  TEXT NOT NULL
      ) STRICT;
    `);
    sessDb.prepare('INSERT INTO sessions (id, key) VALUES (?, ?)').run('s1', 'cli:old');
    insertMinimalMessage(sessDb, 's1', 'old', new Date(NOW - 400 * 86_400_000).toISOString());
    insertMinimalMessage(sessDb, 's1', 'recent', new Date(RECENT).toISOString());

    const result = pruneObservability(db, RETENTION_DEFAULTS, {
      dryRun: false,
      now: NOW,
      sessDb,
    });

    expect(result.messages).toBe(1);
    const remaining = (sessDb.prepare('SELECT COUNT(*) as n FROM messages').get() as { n: number })
      .n;
    expect(remaining).toBe(1);
    sessDb.close();
  });

  // A1 / analytics decision 9 — the session rollup columns are a derived cache
  // of the surviving `messages` rows, so a prune has to take the pruned rows'
  // usage back out of them.
  it('keeps the session rollup equal to SUM(messages) after pruning', () => {
    const sessDb = makeSessDb();
    const oldIso = new Date(NOW - 400 * 86_400_000).toISOString();
    const recentIso = new Date(RECENT).toISOString();

    // s1: one pruned turn (100/20/0.01) + one surviving turn (7/3/0.002).
    insertSession(sessDb, 's1', {
      inputTokens: 107,
      outputTokens: 23,
      estimatedCostUsd: 0.012,
    });
    insertMessage(sessDb, 's1', 'old', oldIso, {
      inputTokens: 100,
      outputTokens: 20,
      estimatedCostUsd: 0.01,
    });
    insertMessage(sessDb, 's1', 'recent', recentIso, {
      inputTokens: 7,
      outputTokens: 3,
      estimatedCostUsd: 0.002,
    });
    // s2 has nothing old — its rollup must not move.
    insertSession(sessDb, 's2', { inputTokens: 40, outputTokens: 4, estimatedCostUsd: 0.004 });
    insertMessage(sessDb, 's2', 'recent', recentIso, {
      inputTokens: 40,
      outputTokens: 4,
      estimatedCostUsd: 0.004,
    });

    const result = pruneObservability(db, RETENTION_DEFAULTS, {
      dryRun: false,
      now: NOW,
      sessDb,
    });
    expect(result.messages).toBe(1);

    const rows = sessDb
      .prepare(
        `SELECT s.id,
                s.input_tokens, s.output_tokens, s.estimated_cost_usd,
                COALESCE((SELECT SUM(m.input_tokens) FROM messages m WHERE m.session_id = s.id), 0)       AS sum_input,
                COALESCE((SELECT SUM(m.output_tokens) FROM messages m WHERE m.session_id = s.id), 0)      AS sum_output,
                COALESCE((SELECT SUM(m.estimated_cost_usd) FROM messages m WHERE m.session_id = s.id), 0) AS sum_cost
         FROM sessions s ORDER BY s.id`,
      )
      .all() as Array<Record<string, number>>;

    for (const r of rows) {
      expect(r.input_tokens).toBe(r.sum_input);
      expect(r.output_tokens).toBe(r.sum_output);
      expect(r.estimated_cost_usd).toBeCloseTo(r.sum_cost ?? 0, 10);
    }
    expect(rows[0]?.input_tokens).toBe(7);
    expect(rows[1]?.input_tokens).toBe(40);
    sessDb.close();
  });

  it('does not double-subtract usage already removed by an undo', () => {
    const sessDb = makeSessDb();
    const oldIso = new Date(NOW - 400 * 86_400_000).toISOString();

    // The old row was soft-deleted (undone), which already subtracted its usage.
    // The rollup reflects only the surviving message, and hard-pruning the
    // undone row must leave it untouched.
    insertSession(sessDb, 's1', { inputTokens: 50, outputTokens: 5, estimatedCostUsd: 0.003 });
    insertMessage(
      sessDb,
      's1',
      'undone',
      oldIso,
      { inputTokens: 100, outputTokens: 20, estimatedCostUsd: 0.01 },
      oldIso,
    );
    insertMessage(sessDb, 's1', 'recent', new Date(RECENT).toISOString(), {
      inputTokens: 50,
      outputTokens: 5,
      estimatedCostUsd: 0.003,
    });

    expect(
      pruneObservability(db, RETENTION_DEFAULTS, { dryRun: false, now: NOW, sessDb }).messages,
    ).toBe(1);

    const row = sessDb.prepare('SELECT * FROM sessions WHERE id = ?').get('s1') as {
      input_tokens: number;
      output_tokens: number;
      estimated_cost_usd: number;
    };
    expect(row.input_tokens).toBe(50);
    expect(row.output_tokens).toBe(5);
    expect(row.estimated_cost_usd).toBeCloseTo(0.003, 10);
    sessDb.close();
  });

  // The subtraction is one grouped pass joined back onto `sessions`, so a wrong
  // join key would still look right with a single session. Pin the per-session
  // attribution: each session gets its own total, and one with nothing to prune
  // is left alone.
  it('subtracts per-session totals when several sessions are pruned in one call', () => {
    const sessDb = makeSessDb();
    const oldIso = new Date(NOW - 400 * 86_400_000).toISOString();
    const recentIso = new Date(RECENT).toISOString();

    // s1: two pruned turns + one surviving turn.
    insertSession(sessDb, 's1', { inputTokens: 130, outputTokens: 27, estimatedCostUsd: 0.016 });
    insertMessage(sessDb, 's1', 'old-a', oldIso, {
      inputTokens: 100,
      outputTokens: 20,
      estimatedCostUsd: 0.01,
    });
    insertMessage(sessDb, 's1', 'old-b', oldIso, {
      inputTokens: 23,
      outputTokens: 4,
      estimatedCostUsd: 0.004,
    });
    insertMessage(sessDb, 's1', 'recent', recentIso, {
      inputTokens: 7,
      outputTokens: 3,
      estimatedCostUsd: 0.002,
    });
    // s2: a different total, entirely prunable.
    insertSession(sessDb, 's2', { inputTokens: 60, outputTokens: 11, estimatedCostUsd: 0.009 });
    insertMessage(sessDb, 's2', 'old', oldIso, {
      inputTokens: 60,
      outputTokens: 11,
      estimatedCostUsd: 0.009,
    });
    // s3: nothing prunable — must not be touched by s1/s2's subtraction.
    insertSession(sessDb, 's3', { inputTokens: 40, outputTokens: 4, estimatedCostUsd: 0.004 });
    insertMessage(sessDb, 's3', 'recent', recentIso, {
      inputTokens: 40,
      outputTokens: 4,
      estimatedCostUsd: 0.004,
    });

    expect(
      pruneObservability(db, RETENTION_DEFAULTS, { dryRun: false, now: NOW, sessDb }).messages,
    ).toBe(3);

    const rows = sessDb
      .prepare(
        'SELECT id, input_tokens, output_tokens, estimated_cost_usd FROM sessions ORDER BY id',
      )
      .all() as Array<{
      id: string;
      input_tokens: number;
      output_tokens: number;
      estimated_cost_usd: number;
    }>;

    expect(rows.map((r) => [r.id, r.input_tokens, r.output_tokens])).toEqual([
      ['s1', 7, 3],
      ['s2', 0, 0],
      ['s3', 40, 4],
    ]);
    expect(rows[0]?.estimated_cost_usd).toBeCloseTo(0.002, 10);
    expect(rows[1]?.estimated_cost_usd).toBeCloseTo(0, 10);
    expect(rows[2]?.estimated_cost_usd).toBeCloseTo(0.004, 10);
    sessDb.close();
  });
});

// Mirrors the columns of the real sessions.db that retention pruning touches.
function makeSessDb(): Database.Database {
  const sessDb = new Database(':memory:');
  sessDb.exec(`
      CREATE TABLE sessions (
        id                    TEXT PRIMARY KEY,
        input_tokens          INTEGER NOT NULL DEFAULT 0,
        output_tokens         INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd    REAL NOT NULL DEFAULT 0
      ) STRICT;

      CREATE TABLE messages (
        id       INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        content    TEXT NOT NULL,
        timestamp  TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_creation_tokens INTEGER,
        estimated_cost_usd REAL,
        deleted_at TEXT
      ) STRICT;
    `);
  return sessDb;
}

function insertSession(
  sessDb: Database.Database,
  id: string,
  usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number },
): void {
  sessDb
    .prepare(
      'INSERT INTO sessions (id, input_tokens, output_tokens, estimated_cost_usd) VALUES (?, ?, ?, ?)',
    )
    .run(id, usage.inputTokens, usage.outputTokens, usage.estimatedCostUsd);
}

/** Insert into a pre-usage-columns `messages` table (id/session_id/content/timestamp only). */
function insertMinimalMessage(
  sessDb: Database.Database,
  sessionId: string,
  content: string,
  timestamp: string,
): void {
  sessDb
    .prepare('INSERT INTO messages (session_id, content, timestamp) VALUES (?, ?, ?)')
    .run(sessionId, content, timestamp);
}

function insertMessage(
  sessDb: Database.Database,
  sessionId: string,
  content: string,
  timestamp: string,
  usage?: { inputTokens: number; outputTokens: number; estimatedCostUsd: number },
  deletedAt?: string,
): void {
  sessDb
    .prepare(
      `INSERT INTO messages (session_id, content, timestamp, input_tokens, output_tokens, estimated_cost_usd, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      content,
      timestamp,
      usage?.inputTokens ?? null,
      usage?.outputTokens ?? null,
      usage?.estimatedCostUsd ?? null,
      deletedAt ?? null,
    );
}

// ---------------------------------------------------------------------------
// G4: referenced blobs survive prune
// ---------------------------------------------------------------------------

describe('pruneObservability — referenced blobs survive', () => {
  it('prune deletes expired DB rows but does not touch blob files', async () => {
    // Set up an in-memory blob store with a single blob.
    const storage = new InMemoryStorage();
    const blobStore = new BlobStore('/blobs', storage);
    const blobKey = await blobStore.put('tool result body content');

    // Insert a span (RECENT — within 90d TTL) that references the blob.
    const dbPath = join(tmpdir(), `obs-blob-survival-${Date.now()}.db`);
    const obsDb = new Database(dbPath);
    obsDb.pragma('journal_mode = WAL');
    obsDb.exec(`
      CREATE TABLE IF NOT EXISTS traces (trace_id TEXT PRIMARY KEY, kind TEXT NOT NULL, start_ts INTEGER NOT NULL, end_ts INTEGER, status TEXT, subject_id TEXT, snapshot_id TEXT, attrs TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS spans (span_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_span_id TEXT, kind TEXT NOT NULL, name TEXT NOT NULL, start_ts INTEGER NOT NULL, end_ts INTEGER, status TEXT, attrs TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, trace_id TEXT, span_id TEXT, ts INTEGER NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL, code TEXT, cause TEXT, details TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS snapshots (snapshot_id TEXT PRIMARY KEY, taken_at INTEGER NOT NULL, subject_id TEXT NOT NULL, body TEXT NOT NULL) STRICT;
    `);

    // Old trace + span (past 90d TTL) — will be pruned.
    obsDb
      .prepare(`INSERT INTO traces (trace_id, kind, start_ts) VALUES ('old-t', 'turn', ?)`)
      .run(OLD);
    obsDb
      .prepare(
        `INSERT INTO spans (span_id, trace_id, kind, name, start_ts, attrs) VALUES ('old-s', 'old-t', 'tool_call', 'bash', ?, ?)`,
      )
      .run(OLD, JSON.stringify({ body_ref: blobKey }));

    // Recent trace + span (within 90d TTL) — survives prune.
    obsDb
      .prepare(`INSERT INTO traces (trace_id, kind, start_ts) VALUES ('new-t', 'turn', ?)`)
      .run(RECENT);
    obsDb
      .prepare(
        `INSERT INTO spans (span_id, trace_id, kind, name, start_ts, attrs) VALUES ('new-s', 'new-t', 'tool_call', 'bash', ?, ?)`,
      )
      .run(RECENT, JSON.stringify({ body_ref: blobKey }));

    const result = pruneObservability(obsDb, RETENTION_DEFAULTS, { dryRun: false, now: NOW });
    obsDb.close();

    // DB rows correctly pruned.
    expect(result.spans).toBe(1); // old-s pruned
    expect(result.traces).toBe(1); // old-t pruned

    // Blob file still exists — prune only touches DB rows, never blob files.
    const blobPath = `/blobs/${blobKey.slice(0, 2)}/${blobKey}.gz`;
    expect(await storage.exists(blobPath)).toBe(true);
  });
});
