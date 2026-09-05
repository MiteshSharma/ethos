import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '@ethosagent/sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteInboundDedupStore } from '../index';

const TTL = 60 * 60 * 1000;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratchDb(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'inbound-dedup-'));
  dirs.push(dir);
  return join(dir, name);
}

describe('SQLiteInboundDedupStore — seen()', () => {
  it('reports first sighting as new and the immediate re-sighting as a duplicate', () => {
    const store = new SQLiteInboundDedupStore(':memory:');
    expect(store.seen('telegram', 'bot-a', 'chat-1', 'msg-1')).toBe(false);
    expect(store.seen('telegram', 'bot-a', 'chat-1', 'msg-1')).toBe(true);
    store.close();
  });

  it('treats platform / botKey / chatId / messageId as four distinct key segments', () => {
    const store = new SQLiteInboundDedupStore(':memory:');
    expect(store.seen('telegram', 'bot-a', 'chat-1', 'msg-1')).toBe(false);
    // A collision on any one of these would cross-suppress genuinely different
    // inbound messages between platforms, bots, or chats.
    expect(store.seen('slack', 'bot-a', 'chat-1', 'msg-1')).toBe(false);
    expect(store.seen('telegram', 'bot-b', 'chat-1', 'msg-1')).toBe(false);
    expect(store.seen('telegram', 'bot-a', 'chat-2', 'msg-1')).toBe(false);
    expect(store.seen('telegram', 'bot-a', 'chat-1', 'msg-2')).toBe(false);
    store.close();
  });

  it('still reports a duplicate just inside the TTL window', () => {
    let clock = 1_000_000;
    const store = new SQLiteInboundDedupStore(':memory:', { ttlMs: TTL, now: () => clock });
    expect(store.seen('slack', 'bot-a', 'chat-1', 'msg-1')).toBe(false);
    clock += TTL - 1000;
    expect(store.seen('slack', 'bot-a', 'chat-1', 'msg-1')).toBe(true);
    store.close();
  });

  it('treats a key seen again after the TTL as new, and prunes the expired rows', () => {
    const path = scratchDb('ttl.db');
    let clock = 1_000_000;
    const store = new SQLiteInboundDedupStore(path, { ttlMs: TTL, now: () => clock });

    for (let i = 0; i < 20; i++) {
      expect(store.seen('slack', 'bot-a', 'chat-1', `msg-${i}`)).toBe(false);
    }

    clock += TTL + 1;
    expect(store.seen('slack', 'bot-a', 'chat-1', 'msg-0')).toBe(false);

    // Bounds check: the 20 expired rows are gone, leaving only the re-sighting.
    // Without pruning the table would grow without limit.
    const reader = new Database(path);
    const row = reader.prepare('SELECT COUNT(*) AS n FROM inbound_seen').get() as { n: number };
    expect(row.n).toBe(1);
    reader.close();
    store.close();
  });

  it('remembers a key across close() and reopen on the same file', () => {
    const path = scratchDb('persist.db');
    const first = new SQLiteInboundDedupStore(path);
    expect(first.seen('telegram', 'bot-a', 'chat-1', 'msg-1')).toBe(false);
    first.close();

    // The whole point of the store: a process restart must not forget.
    const second = new SQLiteInboundDedupStore(path);
    expect(second.seen('telegram', 'bot-a', 'chat-1', 'msg-1')).toBe(true);
    second.close();
  });
});

// ---------------------------------------------------------------------------
// Durability posture — see AGENTS.md's SQLite store roster.
// ---------------------------------------------------------------------------

/** Reads `PRAGMA synchronous` off the store's OWN handle — it is a
 *  per-connection setting, so a second connection to the same file would
 *  report its own default and prove nothing. 2 = FULL (SQLite's default),
 *  1 = NORMAL. */
function syncPragma(store: unknown): number {
  const rows = (store as { db: { pragma(s: string): unknown } }).db.pragma('synchronous');
  return (rows as Array<{ synchronous: number }>)[0]?.synchronous ?? -1;
}

describe('SQLiteInboundDedupStore — durability posture', () => {
  it('stays at synchronous = FULL', () => {
    // NOT a candidate for `synchronous = NORMAL` — pinned so a later blanket
    // sweep cannot take it silently, even though NORMAL would be ~330x faster
    // on this INSERT.
    //
    // This store is the DURABLE half of inbound dedup; the Gateway's in-memory
    // Set is the fast path and this is what survives a restart. A power cut IS
    // a restart, and it is the one restart that can roll back the last
    // sightings under NORMAL. A platform retry landing afterwards would then be
    // fully reprocessed — a second LLM turn, billed again, replying again to a
    // message that was already answered. That is precisely the bug this file
    // exists to prevent, so it pays the fsync.
    //
    // The path is not hot in practice: `seen()` is consulted only on a Set
    // miss, so it is one commit per NEW inbound message, at conversation
    // rate.
    const store = new SQLiteInboundDedupStore(':memory:');
    // Asserted against the opened database, not the source text.
    expect(syncPragma(store)).toBe(2);
    store.close();
  });
});
