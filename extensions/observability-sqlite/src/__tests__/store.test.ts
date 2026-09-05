import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ObsEvent, Span, Trace } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteObservabilityStore } from '../store';

function tmpDb(): string {
  return join(tmpdir(), `obs-test-${randomUUID()}.db`);
}

describe('SQLiteObservabilityStore', () => {
  let store: SQLiteObservabilityStore;

  beforeEach(() => {
    store = new SQLiteObservabilityStore(tmpDb());
  });

  afterEach(() => {
    store.close();
  });

  // -----------------------------------------------------------------------
  // Traces
  // -----------------------------------------------------------------------

  it('inserts and retrieves a trace', () => {
    const trace: Trace = {
      traceId: randomUUID(),
      sessionId: 'sess-1',
      kind: 'turn',
      startTs: Date.now(),
    };
    store.insertTrace(trace);
    const got = store.getTrace(trace.traceId);
    expect(got).not.toBeNull();
    expect(got?.traceId).toBe(trace.traceId);
    expect(got?.sessionId).toBe('sess-1');
    expect(got?.kind).toBe('turn');
  });

  it('returns null for unknown trace', () => {
    expect(store.getTrace(randomUUID())).toBeNull();
  });

  it('closes a trace with status', () => {
    const trace: Trace = {
      traceId: randomUUID(),
      kind: 'turn',
      startTs: Date.now(),
    };
    store.insertTrace(trace);
    store.closeTrace(trace.traceId, 'ok');
    const got = store.getTrace(trace.traceId);
    expect(got?.status).toBe('ok');
    expect(got?.endTs).toBeGreaterThan(0);
  });

  it('getRecentTraces returns traces newest first', () => {
    const t1: Trace = { traceId: randomUUID(), kind: 'turn', startTs: 1000 };
    const t2: Trace = { traceId: randomUUID(), kind: 'turn', startTs: 2000 };
    store.insertTrace(t1);
    store.insertTrace(t2);
    const recent = store.getRecentTraces(10);
    expect(recent[0]?.startTs).toBeGreaterThanOrEqual(recent[1]?.startTs ?? 0);
  });

  it('redacts credentials in attrs before storing', () => {
    const awsKey = `AKIA${'A'.repeat(16)}`;
    const trace: Trace = {
      traceId: randomUUID(),
      kind: 'turn',
      startTs: Date.now(),
      attrs: { apiKey: awsKey },
    };
    store.insertTrace(trace);
    const got = store.getTrace(trace.traceId);
    expect(got?.attrs?.apiKey).toBe('[REDACTED:aws-key]');
  });

  it('insertTrace is idempotent (INSERT OR IGNORE)', () => {
    const trace: Trace = { traceId: randomUUID(), kind: 'turn', startTs: 1000 };
    store.insertTrace(trace);
    // Should not throw on duplicate insert.
    expect(() => store.insertTrace(trace)).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // Spans
  // -----------------------------------------------------------------------

  it('inserts and retrieves spans for a trace', () => {
    const traceId = randomUUID();
    const span: Span = {
      spanId: randomUUID(),
      traceId,
      kind: 'tool_call',
      name: 'read_file',
      startTs: Date.now(),
    };
    store.insertSpan(span);
    const spans = store.getSpans(traceId);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('read_file');
  });

  it('closes a span with status', () => {
    const traceId = randomUUID();
    const span: Span = {
      spanId: randomUUID(),
      traceId,
      kind: 'llm_call',
      name: 'anthropic.complete',
      startTs: Date.now(),
    };
    store.insertSpan(span);
    store.closeSpan(span.spanId, 'ok');
    const spans = store.getSpans(traceId);
    expect(spans[0]?.status).toBe('ok');
    expect(spans[0]?.endTs).toBeGreaterThan(0);
  });

  it('returns empty array for trace with no spans', () => {
    expect(store.getSpans(randomUUID())).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------------

  it('inserts and retrieves events', () => {
    const traceId = randomUUID();
    const event: ObsEvent = {
      eventId: randomUUID(),
      traceId,
      ts: Date.now(),
      category: 'error',
      severity: 'error',
      code: 'TOOL_FAILED',
      cause: 'timeout',
    };
    store.insertEvent(event);
    const events = store.getEvents({ traceId });
    expect(events).toHaveLength(1);
    expect(events[0]?.code).toBe('TOOL_FAILED');
    expect(events[0]?.cause).toBe('timeout');
  });

  it('filters events by category', () => {
    const e1: ObsEvent = {
      eventId: randomUUID(),
      ts: 1000,
      category: 'error',
      severity: 'error',
    };
    const e2: ObsEvent = {
      eventId: randomUUID(),
      ts: 2000,
      category: 'audit.transition',
      severity: 'info',
    };
    store.insertEvent(e1);
    store.insertEvent(e2);
    const errors = store.getEvents({ category: 'error' });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.category).toBe('error');
  });

  it('filters events by since timestamp', () => {
    const e1: ObsEvent = { eventId: randomUUID(), ts: 1000, category: 'error', severity: 'error' };
    const e2: ObsEvent = { eventId: randomUUID(), ts: 3000, category: 'error', severity: 'error' };
    store.insertEvent(e1);
    store.insertEvent(e2);
    const recent = store.getEvents({ since: 2000 });
    expect(recent).toHaveLength(1);
    expect(recent[0]?.ts).toBe(3000);
  });

  it('redacts credentials in cause string', () => {
    const awsKey = `AKIA${'B'.repeat(16)}`;
    const event: ObsEvent = {
      eventId: randomUUID(),
      ts: Date.now(),
      category: 'error',
      severity: 'error',
      cause: `Auth failed with key ${awsKey}`,
    };
    store.insertEvent(event);
    const events = store.getEvents({});
    expect(events[0]?.cause).toContain('[REDACTED:aws-key]');
    expect(events[0]?.cause).not.toContain(awsKey);
  });

  // -----------------------------------------------------------------------
  // Snapshots
  // -----------------------------------------------------------------------

  it('inserts a snapshot without error', () => {
    expect(() =>
      store.insertSnapshot({
        snapshotId: randomUUID(),
        takenAt: Date.now(),
        subjectId: 'assistant',
        body: 'name: assistant\ntoolset: [read_file]',
      }),
    ).not.toThrow();
  });
});

describe('SQLiteObservabilityStore schema versioning', () => {
  it('stamps a fresh db to user_version 3', async () => {
    const path = tmpDb();
    const s = new SQLiteObservabilityStore(path);
    s.close();

    const Database = (await import('@ethosagent/sqlite')).default;
    const db = new Database(path);
    const rows = db.pragma('user_version') as Array<{ user_version: number }>;
    db.close();
    expect(rows[0]?.user_version).toBe(3);
  });

  it('reopening a populated db preserves rows and keeps user_version at 3', async () => {
    const path = tmpDb();
    const trace: Trace = { traceId: randomUUID(), kind: 'turn', startTs: Date.now() };

    const s1 = new SQLiteObservabilityStore(path);
    s1.insertTrace(trace);
    s1.close();

    const s2 = new SQLiteObservabilityStore(path);
    const got = s2.getTrace(trace.traceId);
    s2.close();
    expect(got?.traceId).toBe(trace.traceId);

    const Database = (await import('@ethosagent/sqlite')).default;
    const db = new Database(path);
    const rows = db.pragma('user_version') as Array<{ user_version: number }>;
    db.close();
    expect(rows[0]?.user_version).toBe(3);
  });

  it('refuses to open a db whose user_version is newer than the code', async () => {
    const path = tmpDb();
    const Database = (await import('@ethosagent/sqlite')).default;
    const raw = new Database(path);
    raw.pragma('user_version = 4');
    raw.close();

    expect(() => new SQLiteObservabilityStore(path)).toThrow(/refusing to open to avoid downgrade/);
  });
});

// ---------------------------------------------------------------------------
// Durability posture (see the `synchronous = NORMAL` note in the constructor)
// ---------------------------------------------------------------------------

/** Reads `PRAGMA synchronous` off the store's OWN handle — it is a
 *  per-connection setting, so a second connection to the same file would
 *  report its own default and prove nothing. 2 = FULL (SQLite's default),
 *  1 = NORMAL. */
function syncPragma(store: unknown): number {
  const rows = (store as { db: { pragma(s: string): unknown } }).db.pragma('synchronous');
  return (rows as Array<{ synchronous: number }>)[0]?.synchronous ?? -1;
}

describe('SQLiteObservabilityStore — durability posture', () => {
  let store: SQLiteObservabilityStore;

  beforeEach(() => {
    store = new SQLiteObservabilityStore(tmpDb());
  });

  afterEach(() => {
    store.close();
  });

  it('opens at synchronous = NORMAL', () => {
    // Telemetry with a retention window: the tail a power cut can drop belongs
    // to a turn that did not finish either. Asserted against the opened
    // database, not the source text.
    expect(syncPragma(store)).toBe(1);
  });

  it('still opens in WAL mode', () => {
    // NORMAL is only corruption-safe in WAL. If journal_mode regressed, the
    // setting above would stop being the trade it is documented as.
    const rows = (store as unknown as { db: { pragma(s: string): unknown } }).db.pragma(
      'journal_mode',
    );
    expect((rows as Array<{ journal_mode: string }>)[0]?.journal_mode).toBe('wal');
  });

  it('still enforces STRICT column types', () => {
    const db = (
      store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }
    ).db;
    // `start_ts` is INTEGER in a STRICT table and 'soon' has no lossless
    // conversion, so the row must be rejected rather than coerced.
    expect(() =>
      db
        .prepare('INSERT INTO traces (trace_id, kind, start_ts) VALUES (?, ?, ?)')
        .run(randomUUID(), 'turn', 'soon'),
    ).toThrow();
  });
});
