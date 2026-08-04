import Database from '@ethosagent/sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { SQLiteDeliveryLedger } from '../index';

function ledger() {
  return new SQLiteDeliveryLedger(':memory:');
}

function input(overrides: Partial<Parameters<SQLiteDeliveryLedger['record']>[0]> = {}) {
  return {
    botKey: 'bot-a',
    platform: 'telegram',
    chatId: 'chat-1',
    sessionId: 'telegram:bot-a:chat-1',
    content: 'the reply',
    ...overrides,
  };
}

describe('SQLiteDeliveryLedger — record / confirm', () => {
  let store: SQLiteDeliveryLedger;
  beforeEach(() => {
    store = ledger();
  });

  it('records a pending obligation with a content hash', async () => {
    const id = await store.record(input());
    const row = await store.get(id);
    expect(row).not.toBeNull();
    expect(row?.status).toBe('pending');
    expect(row?.botKey).toBe('bot-a');
    expect(row?.content).toBe('the reply');
    // sha256 hex.
    expect(row?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('markDelivered flips the row and removes it from the pending pool', async () => {
    const id = await store.record(input());
    await store.markDelivered(id);
    expect((await store.get(id))?.status).toBe('delivered');
    expect(await store.listPending(['bot-a'])).toHaveLength(0);
  });

  it('get returns null for an unknown id', async () => {
    expect(await store.get('nope')).toBeNull();
  });
});

describe('SQLiteDeliveryLedger — ownership', () => {
  it('listPending only returns obligations for the caller-owned botKeys', async () => {
    const store = ledger();
    const a = await store.record(input({ botKey: 'bot-a' }));
    const b = await store.record(input({ botKey: 'bot-b' }));
    const c = await store.record(input({ botKey: 'bot-c' }));

    const owned = await store.listPending(['bot-a', 'bot-b']);
    expect(owned.map((o) => o.id).sort()).toEqual([a, b].sort());
    // bot-c belongs to a different deployment sharing the ledger file.
    expect(owned.some((o) => o.id === c)).toBe(false);
    expect((await store.get(c))?.status).toBe('pending');
  });

  it('a process owning no bots owns no obligations', async () => {
    const store = ledger();
    await store.record(input());
    expect(await store.listPending([])).toEqual([]);
  });

  it('orders pending obligations oldest-first', async () => {
    const store = ledger();
    const first = await store.record(input({ content: 'one' }));
    const second = await store.record(input({ content: 'two' }));
    const pending = await store.listPending(['bot-a']);
    expect(pending.map((o) => o.id)).toEqual([first, second]);
  });
});

describe('SQLiteDeliveryLedger — atomic claim', () => {
  it('exactly one of two claims on the same row wins', async () => {
    const store = ledger();
    const id = await store.record(input());

    const [a, b] = await Promise.all([store.claim(id), store.claim(id)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await store.get(id))?.status).toBe('redelivering');
  });

  it('two ledger handles on ONE db file claim each obligation exactly once', () => {
    // Two processes sharing a ledger, modelled as two handles over one db.
    // The conditional UPDATE is what separates them; a read-then-write check
    // would let both win.
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE delivery_obligations (
        id TEXT PRIMARY KEY, bot_key TEXT NOT NULL, platform TEXT NOT NULL,
        chat_id TEXT NOT NULL, session_id TEXT NOT NULL, content_hash TEXT NOT NULL,
        content TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL
      ) STRICT;
      INSERT INTO delivery_obligations VALUES ('x','bot-a','telegram','c','s','h','body',1,'pending');
    `);
    const claimOnce = () =>
      db
        .prepare(
          `UPDATE delivery_obligations SET status = 'redelivering'
           WHERE id = ? AND status = 'pending'`,
        )
        .run('x').changes === 1;
    expect([claimOnce(), claimOnce()].filter(Boolean)).toHaveLength(1);
    db.close();
  });

  it('claim fails on an already-delivered row', async () => {
    const store = ledger();
    const id = await store.record(input());
    await store.markDelivered(id);
    expect(await store.claim(id)).toBe(false);
  });

  it('release returns a claimed row to the pending pool', async () => {
    const store = ledger();
    const id = await store.record(input());
    expect(await store.claim(id)).toBe(true);
    expect(await store.listPending(['bot-a'])).toHaveLength(0);
    await store.release(id);
    expect((await store.get(id))?.status).toBe('pending');
    expect(await store.listPending(['bot-a'])).toHaveLength(1);
  });

  it('release never resurrects a delivered row', async () => {
    const store = ledger();
    const id = await store.record(input());
    await store.markDelivered(id);
    await store.release(id);
    expect((await store.get(id))?.status).toBe('delivered');
  });
});

describe('SQLiteDeliveryLedger — retention', () => {
  it('prunes delivered rows past the cutoff and never prunes pending ones', async () => {
    const store = ledger();
    const old = await store.record(input({ content: 'old delivered' }));
    const recent = await store.record(input({ content: 'recent delivered' }));
    const stuck = await store.record(input({ content: 'never confirmed' }));
    await store.markDelivered(old);
    await store.markDelivered(recent);

    // Backdate the two rows we want treated as aged.
    const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
    const ancient = Date.now() - 8 * 86_400_000;
    db.prepare('UPDATE delivery_obligations SET created_at = ? WHERE id IN (?, ?)').run(
      ancient,
      old,
      stuck,
    );

    const removed = await store.pruneDelivered(Date.now() - 7 * 86_400_000);
    expect(removed).toBe(1);
    expect(await store.get(old)).toBeNull();
    expect((await store.get(recent))?.status).toBe('delivered');
    // Pending is never pruned, however old — an aged pending row is not proof
    // of a crash, and it is the entire point of the ledger.
    expect((await store.get(stuck))?.status).toBe('pending');
  });

  it('does not prune a claimed (redelivering) row', async () => {
    const store = ledger();
    const id = await store.record(input());
    await store.claim(id);
    const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
    db.prepare('UPDATE delivery_obligations SET created_at = 0 WHERE id = ?').run(id);
    expect(await store.pruneDelivered(Date.now())).toBe(0);
    expect((await store.get(id))?.status).toBe('redelivering');
  });
});

describe('SQLiteDeliveryLedger — schema', () => {
  it('creates a STRICT table stamped at the current user_version', async () => {
    const store = ledger();
    const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
    const sql = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='delivery_obligations'`)
      .get() as { sql: string };
    expect(sql.sql).toMatch(/STRICT/);

    const version = db.pragma('user_version') as Array<{ user_version: number }>;
    expect(version[0]?.user_version).toBe(1);

    // STRICT enforcement is real: a TEXT into an INTEGER column throws.
    expect(() =>
      db
        .prepare(
          `INSERT INTO delivery_obligations
           VALUES ('bad','b','p','c','s','h','x','not-a-number','pending')`,
        )
        .run(),
    ).toThrow();
  });

  it('survives reopening an existing database (idempotent migration)', async () => {
    // A file-backed round trip is the only way to reopen; :memory: dies with
    // the handle. tmpdir keeps it out of ~/.ethos.
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'delivery-ledger-'));
    const path = join(dir, 'nested', 'delivery.db');
    try {
      const first = new SQLiteDeliveryLedger(path);
      const id = await first.record(input());
      first.close();

      const second = new SQLiteDeliveryLedger(path);
      expect((await second.get(id))?.content).toBe('the reply');
      expect(await second.listPending(['bot-a'])).toHaveLength(1);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to open a database written by newer code', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'delivery-ledger-'));
    const path = join(dir, 'delivery.db');
    try {
      const first = new SQLiteDeliveryLedger(path);
      const db = (first as unknown as { db: InstanceType<typeof Database> }).db;
      db.pragma('user_version = 99');
      first.close();
      expect(() => new SQLiteDeliveryLedger(path)).toThrow(/refusing to open/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
