import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CardEnvelope } from '@ethosagent/web-contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteCardStore } from '../index';

function textCard(text: string): CardEnvelope {
  return { kind: 'text', specVersion: 1, payload: { text } };
}

describe('SQLiteCardStore', () => {
  let store: SQLiteCardStore | undefined;

  function open(): SQLiteCardStore {
    store = new SQLiteCardStore(':memory:');
    return store;
  }

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  it('assigns monotonic seqs per session, starting at 0', () => {
    const s = open();
    expect(s.append('sess-a', 'call-1', textCard('one'))).toBe(0);
    expect(s.append('sess-a', 'call-2', textCard('two'))).toBe(1);
    // A different session has its own counter.
    expect(s.append('sess-b', 'call-3', textCard('three'))).toBe(0);
  });

  it('append is idempotent on (sessionId, toolCallId)', () => {
    const s = open();
    const first = s.append('sess-a', 'call-1', textCard('one'));
    const replay = s.append('sess-a', 'call-1', textCard('one'));
    expect(replay).toBe(first);
    expect(s.list('sess-a')).toHaveLength(1);
    // The duplicate must not advance the counter either.
    expect(s.append('sess-a', 'call-2', textCard('two'))).toBe(1);
  });

  it('list returns a session own cards in seq order', () => {
    const s = open();
    s.append('sess-a', 'call-2', textCard('second'));
    s.append('sess-a', 'call-1', textCard('first'));
    s.append('sess-b', 'call-9', textCard('other session'));

    const cards = s.list('sess-a');
    expect(cards.map((c) => c.seq)).toEqual([0, 1]);
    expect(cards.map((c) => c.toolCallId)).toEqual(['call-2', 'call-1']);
    expect(s.list('sess-b')).toHaveLength(1);
    expect(s.list('unknown')).toEqual([]);
  });

  it('list round-trips every card kind', () => {
    const s = open();
    const envelopes: CardEnvelope[] = [
      { kind: 'text', specVersion: 1, payload: { text: 'hi' } },
      { kind: 'code', specVersion: 1, payload: { language: 'sql', code: 'SELECT 1' } },
      { kind: 'alert', specVersion: 1, payload: { severity: 'warning', message: 'careful' } },
      {
        kind: 'detail',
        specVersion: 1,
        payload: { title: 'Trade', fields: [{ label: 'Qty', value: '10' }] },
      },
      {
        kind: 'item_list',
        specVersion: 1,
        payload: { items: [{ id: 'a', name: 'Alpha' }] },
      },
      {
        kind: 'data_table',
        specVersion: 1,
        payload: { columns: [{ key: 'a', label: 'A' }], rows: [{ a: 1 }] },
      },
      {
        kind: 'metric_chart',
        specVersion: 1,
        payload: { series: [{ name: 'pnl', points: [{ x: 't', y: 1 }] }] },
      },
      {
        kind: 'recommend_actions',
        specVersion: 1,
        payload: { actions: [{ label: 'Go', prompt: 'go on' }] },
      },
      { kind: 'canvas', specVersion: 1, payload: { html: '<p>hi</p>' } },
    ];
    envelopes.forEach((e, i) => {
      s.append('sess-a', `call-${i}`, e);
    });
    expect(s.list('sess-a').map((c) => c.envelope)).toEqual(envelopes);
  });

  it('skips rows whose stored JSON no longer validates instead of throwing', () => {
    const s = open();
    s.append('sess-a', 'call-1', textCard('good'));
    s.append('sess-a', 'call-2', textCard('also good'));
    // Simulate a row written under an older/other spec: rewrite it in place.
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the private db is the point of this test.
    const db = (s as any).db;
    db.prepare('UPDATE session_cards SET envelope = ? WHERE tool_call_id = ?').run(
      JSON.stringify({ kind: 'text', specVersion: 99, payload: { text: 'stale' } }),
      'call-1',
    );
    db.prepare('UPDATE session_cards SET envelope = ? WHERE tool_call_id = ?').run(
      'not json at all',
      'call-2',
    );

    expect(s.list('sess-a')).toEqual([]);
    // A valid neighbour still comes back.
    s.append('sess-a', 'call-3', textCard('fresh'));
    expect(s.list('sess-a').map((c) => c.toolCallId)).toEqual(['call-3']);
  });

  it('deleteSession drops only that session cards', () => {
    const s = open();
    s.append('sess-a', 'call-1', textCard('one'));
    s.append('sess-b', 'call-2', textCard('two'));
    s.deleteSession('sess-a');
    expect(s.list('sess-a')).toEqual([]);
    expect(s.list('sess-b')).toHaveLength(1);
    // Deleting an unknown session is a no-op, not an error.
    expect(() => s.deleteSession('nope')).not.toThrow();
  });

  it('copySession appends the source cards onto the target in order', () => {
    const s = open();
    s.append('sess-a', 'call-1', textCard('one'));
    s.append('sess-a', 'call-2', textCard('two'));
    s.copySession('sess-a', 'sess-fork');

    const forked = s.list('sess-fork');
    expect(forked.map((c) => c.toolCallId)).toEqual(['call-1', 'call-2']);
    expect(forked.map((c) => c.seq)).toEqual([0, 1]);
    // The source is untouched, and the fork keeps appending after the copy.
    expect(s.list('sess-a')).toHaveLength(2);
    expect(s.append('sess-fork', 'call-3', textCard('three'))).toBe(2);
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

describe('SQLiteCardStore — durability posture', () => {
  let dir: string | undefined;
  let fileStore: SQLiteCardStore | undefined;
  let memStore: SQLiteCardStore | undefined;

  function openMem(): SQLiteCardStore {
    memStore = new SQLiteCardStore(':memory:');
    return memStore;
  }

  afterEach(() => {
    fileStore?.close();
    fileStore = undefined;
    memStore?.close();
    memStore = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('opens at synchronous = NORMAL', () => {
    // A card is a rendering of a tool result and this store already degrades
    // one card at a time by design. Asserted against the opened database, not
    // the source text.
    expect(syncPragma(openMem())).toBe(1);
  });

  it('still opens in WAL mode', () => {
    // Checked on a FILE, not ':memory:' — an in-memory database reports
    // journal_mode 'memory' and could never show a WAL regression. NORMAL is
    // only corruption-safe in WAL, so this is the other half of the trade.
    dir = mkdtempSync(join(tmpdir(), 'session-cards-sync-'));
    fileStore = new SQLiteCardStore(join(dir, 'cards.db'));
    const rows = (fileStore as unknown as { db: { pragma(s: string): unknown } }).db.pragma(
      'journal_mode',
    );
    expect((rows as Array<{ journal_mode: string }>)[0]?.journal_mode).toBe('wal');
  });

  it('still enforces STRICT column types', () => {
    const db = (
      openMem() as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }
    ).db;
    // `seq` is INTEGER in a STRICT table and 'first' has no lossless
    // conversion, so the row must be rejected rather than coerced.
    expect(() =>
      db
        .prepare(
          `INSERT INTO session_cards (session_id, tool_call_id, seq, envelope, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('sess-strict', 'call-strict', 'first', '{}', 1),
    ).toThrow();
  });
});
