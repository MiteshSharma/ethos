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
