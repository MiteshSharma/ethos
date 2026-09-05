import Database from '@ethosagent/sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
        content TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL,
        thread_id TEXT
      ) STRICT;
      INSERT INTO delivery_obligations
      VALUES ('x','bot-a','telegram','c','s','h','body',1,'pending',NULL);
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
    expect(version[0]?.user_version).toBe(3);

    // STRICT enforcement is real: a TEXT into an INTEGER column throws.
    expect(() =>
      db
        .prepare(
          `INSERT INTO delivery_obligations
           (id, bot_key, platform, chat_id, session_id, content_hash, content, created_at, status)
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

  it('round-trips the thread a reply belonged to', async () => {
    const store = ledger();
    const threaded = await store.record(input({ threadId: 'thread-7' }));
    const rootChat = await store.record(input({ content: 'root reply' }));

    expect((await store.get(threaded))?.threadId).toBe('thread-7');
    // Absent, not '' and not the string 'null' — an adapter would forward
    // either of those to the platform verbatim.
    expect((await store.get(rootChat))?.threadId).toBeUndefined();

    const pending = await store.listPending(['bot-a']);
    expect(pending.map((o) => o.threadId)).toEqual(['thread-7', undefined]);
  });

  it('normalizes an empty-string threadId to no thread', async () => {
    const store = ledger();
    const id = await store.record(input({ threadId: '' }));
    expect((await store.get(id))?.threadId).toBeUndefined();
    // NULL in the column, not ''.
    const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
    const row = db.prepare('SELECT thread_id FROM delivery_obligations WHERE id = ?').get(id) as {
      thread_id: string | null;
    };
    expect(row.thread_id).toBeNull();
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

// ---------------------------------------------------------------------------
// v1 → v3 migration
//
// The shipped v1 table had no `thread_id`. Nothing has run it in production,
// but the migration PATH is the thing under test: a table that can only be
// created fresh is a table whose migration story is untested. A v1 file now
// also has to survive the v3 step, so this covers the whole chain in one hop —
// the case a long-idle deployment actually hits.
// ---------------------------------------------------------------------------

/** The exact v1 schema, stamped at user_version = 1. */
const V1_SCHEMA = `
  CREATE TABLE delivery_obligations (
    id           TEXT PRIMARY KEY,
    bot_key      TEXT NOT NULL,
    platform     TEXT NOT NULL,
    chat_id      TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    content      TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending'
  ) STRICT;

  CREATE INDEX delivery_status_bot ON delivery_obligations(status, bot_key);
  CREATE INDEX delivery_status_created ON delivery_obligations(status, created_at);
`;

describe('SQLiteDeliveryLedger — v1 → v3 migration', () => {
  let dir: string;
  let path: string;
  let rm: (p: string, o: { recursive: boolean; force: boolean }) => void;

  beforeEach(async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    rm = rmSync;
    dir = mkdtempSync(join(tmpdir(), 'delivery-ledger-v1-'));
    path = join(dir, 'delivery.db');

    // A v1 ledger with two rows already in it.
    const db = new Database(path);
    db.exec(V1_SCHEMA);
    db.pragma('user_version = 1');
    db.prepare(
      `INSERT INTO delivery_obligations
       (id, bot_key, platform, chat_id, session_id, content_hash, content, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('old-1', 'bot-a', 'telegram', 'chat-1', 'sess-1', 'hash-1', 'survivor', 1, 'pending');
    db.prepare(
      `INSERT INTO delivery_obligations
       (id, bot_key, platform, chat_id, session_id, content_hash, content, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('old-2', 'bot-a', 'telegram', 'chat-2', 'sess-2', 'hash-2', 'confirmed', 2, 'delivered');
    db.close();
  });

  afterEach(() => {
    rm(dir, { recursive: true, force: true });
  });

  it('upgrades to v3 without losing pre-existing rows', async () => {
    const store = new SQLiteDeliveryLedger(path);
    try {
      const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
      const version = db.pragma('user_version') as Array<{ user_version: number }>;
      expect(version[0]?.user_version).toBe(3);

      const survivor = await store.get('old-1');
      expect(survivor?.content).toBe('survivor');
      expect(survivor?.status).toBe('pending');
      expect(await store.get('old-2')).not.toBeNull();
    } finally {
      store.close();
    }
  });

  it('gives pre-existing rows a null threadId, so they redeliver to the root chat', async () => {
    const store = new SQLiteDeliveryLedger(path);
    try {
      // Still sweepable, and with no thread claim it could not honour.
      const pending = await store.listPending(['bot-a']);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.id).toBe('old-1');
      expect(pending[0]?.threadId).toBeUndefined();

      const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
      const raw = db
        .prepare(`SELECT thread_id FROM delivery_obligations WHERE id = 'old-1'`)
        .get() as { thread_id: string | null };
      expect(raw.thread_id).toBeNull();
    } finally {
      store.close();
    }
  });

  it('keeps the table STRICT after the migration', async () => {
    const store = new SQLiteDeliveryLedger(path);
    try {
      const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
      const sql = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='delivery_obligations'`)
        .get() as { sql: string };
      expect(sql.sql).toMatch(/STRICT/);
      expect(sql.sql).toMatch(/thread_id/);

      // Enforcement is real, not just the keyword surviving in the DDL text.
      expect(() =>
        db
          .prepare(
            `INSERT INTO delivery_obligations
             (id, bot_key, platform, chat_id, session_id, content_hash, content, created_at,
              status, thread_id)
             VALUES ('bad','b','p','c','s','h','x','not-a-number','pending',NULL)`,
          )
          .run(),
      ).toThrow();
      // ...including on the column the migration added. (A number would be
      // losslessly coerced to TEXT even under STRICT; a BLOB is what STRICT
      // actually refuses.)
      expect(() =>
        db
          .prepare(`UPDATE delivery_obligations SET thread_id = x'deadbeef' WHERE id = 'old-1'`)
          .run(),
      ).toThrow();
    } finally {
      store.close();
    }
  });

  it('a migrated ledger accepts new threaded writes', async () => {
    const store = new SQLiteDeliveryLedger(path);
    try {
      const id = await store.record({
        botKey: 'bot-a',
        platform: 'slack',
        chatId: 'C1',
        sessionId: 'slack:bot-a:C1:1700.1',
        threadId: '1700.1',
        content: 'threaded after upgrade',
      });
      expect((await store.get(id))?.threadId).toBe('1700.1');
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Voice obligations (v3)
// ---------------------------------------------------------------------------

describe('SQLiteDeliveryLedger — voice obligations', () => {
  it('round-trips a voice obligation through get and listPending', async () => {
    const store = ledger();
    const id = await store.record(
      input({
        content: 'the spoken words',
        kind: 'voice',
        artifactRef: 'voice/2026-08-14/abc.ogg',
        mediaFormat: 'ogg_opus',
      }),
    );

    const row = await store.get(id);
    expect(row?.kind).toBe('voice');
    expect(row?.artifactRef).toBe('voice/2026-08-14/abc.ogg');
    expect(row?.mediaFormat).toBe('ogg_opus');
    // The spoken text is stored, not a placeholder: the row stays readable and
    // still hashes to something a dedup comparison can use.
    expect(row?.content).toBe('the spoken words');
    expect(row?.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const pending = await store.listPending(['bot-a']);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.artifactRef).toBe('voice/2026-08-14/abc.ogg');
    expect(pending[0]?.mediaFormat).toBe('ogg_opus');
  });

  it('defaults an obligation with no kind to text, with no media fields', async () => {
    const store = ledger();
    const id = await store.record(input());
    const row = await store.get(id);
    expect(row?.kind).toBe('text');
    // Absent, not '' — a caller that forwarded '' to an artifact store would
    // fail late and confusingly.
    expect(row?.artifactRef).toBeUndefined();
    expect(row?.mediaFormat).toBeUndefined();

    const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
    const raw = db
      .prepare('SELECT artifact_ref, media_format FROM delivery_obligations WHERE id = ?')
      .get(id) as { artifact_ref: string | null; media_format: string | null };
    expect(raw.artifact_ref).toBeNull();
    expect(raw.media_format).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// v2 → v3 migration
//
// The v2 shape is the one deployments actually have on disk today, so this is
// the upgrade that has to be right.
// ---------------------------------------------------------------------------

/** The exact v2 schema, stamped at user_version = 2. */
const V2_SCHEMA = `
  CREATE TABLE delivery_obligations (
    id           TEXT PRIMARY KEY,
    bot_key      TEXT NOT NULL,
    platform     TEXT NOT NULL,
    chat_id      TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    content      TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    thread_id    TEXT
  ) STRICT;

  CREATE INDEX delivery_status_bot ON delivery_obligations(status, bot_key);
  CREATE INDEX delivery_status_created ON delivery_obligations(status, created_at);
`;

describe('SQLiteDeliveryLedger — v2 → v3 migration', () => {
  let dir: string;
  let path: string;
  let rm: (p: string, o: { recursive: boolean; force: boolean }) => void;

  beforeEach(async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    rm = rmSync;
    dir = mkdtempSync(join(tmpdir(), 'delivery-ledger-v2-'));
    path = join(dir, 'delivery.db');

    const db = new Database(path);
    db.exec(V2_SCHEMA);
    db.pragma('user_version = 2');
    db.prepare(
      `INSERT INTO delivery_obligations
       (id, bot_key, platform, chat_id, session_id, content_hash, content, created_at, status,
        thread_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'v2-1',
      'bot-a',
      'slack',
      'C1',
      'sess-1',
      'hash-1',
      'written before voice existed',
      1,
      'pending',
      '1700.1',
    );
    db.close();
  });

  afterEach(() => {
    rm(dir, { recursive: true, force: true });
  });

  it('carries the pre-v3 row forward and reads it as text', async () => {
    const store = new SQLiteDeliveryLedger(path);
    try {
      const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
      const version = db.pragma('user_version') as Array<{ user_version: number }>;
      expect(version[0]?.user_version).toBe(3);

      const row = await store.get('v2-1');
      expect(row?.content).toBe('written before voice existed');
      expect(row?.threadId).toBe('1700.1');
      // NULL in the column, 'text' on read — which is what the row was.
      expect(row?.kind).toBe('text');
      expect(row?.artifactRef).toBeUndefined();
      const raw = db.prepare(`SELECT kind FROM delivery_obligations WHERE id = 'v2-1'`).get() as {
        kind: string | null;
      };
      expect(raw.kind).toBeNull();

      // Still sweepable after the upgrade.
      expect((await store.listPending(['bot-a']))[0]?.id).toBe('v2-1');
    } finally {
      store.close();
    }
  });

  it('a migrated ledger accepts voice writes and stays STRICT', async () => {
    const store = new SQLiteDeliveryLedger(path);
    try {
      const id = await store.record({
        botKey: 'bot-a',
        platform: 'telegram',
        chatId: 'chat-1',
        sessionId: 'telegram:bot-a:chat-1',
        content: 'spoken after upgrade',
        kind: 'voice',
        artifactRef: 'voice/xyz.ogg',
        mediaFormat: 'ogg_opus',
      });
      expect((await store.get(id))?.kind).toBe('voice');

      const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
      const sql = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='delivery_obligations'`)
        .get() as { sql: string };
      expect(sql.sql).toMatch(/STRICT/);
      // Enforcement is real on the added columns, not just the keyword
      // surviving in the DDL text. (A number coerces losslessly to TEXT even
      // under STRICT; a BLOB is what STRICT actually refuses.)
      expect(() =>
        db.prepare(`UPDATE delivery_obligations SET kind = x'deadbeef' WHERE id = 'v2-1'`).run(),
      ).toThrow();
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Abandonment
// ---------------------------------------------------------------------------

describe('SQLiteDeliveryLedger — abandonStale', () => {
  const DAY = 86_400_000;

  /** Backdate rows so they sit on the far side of the cutoff. */
  function backdate(store: SQLiteDeliveryLedger, ids: string[], at: number) {
    const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
    for (const id of ids) {
      db.prepare('UPDATE delivery_obligations SET created_at = ? WHERE id = ?').run(at, id);
    }
  }

  it('abandons only owned, only old, only live rows — and returns them', async () => {
    const store = ledger();
    const stale = await store.record(input({ content: 'stale pending' }));
    const staleClaimed = await store.record(input({ content: 'stale claimed' }));
    const fresh = await store.record(input({ content: 'fresh pending' }));
    const otherBot = await store.record(input({ botKey: 'bot-z', content: 'not ours' }));
    const staleDelivered = await store.record(input({ content: 'already delivered' }));
    await store.claim(staleClaimed);
    await store.markDelivered(staleDelivered);
    backdate(store, [stale, staleClaimed, otherBot, staleDelivered], Date.now() - 30 * DAY);

    const abandoned = await store.abandonStale(['bot-a'], Date.now() - 7 * DAY);

    // A process that claimed a row and died leaves it 'redelivering' forever;
    // that is exactly the state the backstop exists for, so it is swept too.
    expect(abandoned.map((o) => o.id).sort()).toEqual([stale, staleClaimed].sort());
    expect(abandoned.every((o) => o.status === 'abandoned')).toBe(true);

    expect((await store.get(stale))?.status).toBe('abandoned');
    expect((await store.get(staleClaimed))?.status).toBe('abandoned');
    // Young enough to still belong to a live send.
    expect((await store.get(fresh))?.status).toBe('pending');
    // Old, but a peer process owns bot-z and gets to make its own call.
    expect((await store.get(otherBot))?.status).toBe('pending');
    // Terminal already; abandonment is not a re-decision.
    expect((await store.get(staleDelivered))?.status).toBe('delivered');
  });

  it('returns a voice obligation with the artifact the caller has to release', async () => {
    const store = ledger();
    const id = await store.record(
      input({ kind: 'voice', artifactRef: 'voice/old.ogg', mediaFormat: 'ogg_opus' }),
    );
    backdate(store, [id], Date.now() - 30 * DAY);

    const [abandoned] = await store.abandonStale(['bot-a'], Date.now() - 7 * DAY);
    expect(abandoned?.kind).toBe('voice');
    expect(abandoned?.artifactRef).toBe('voice/old.ogg');
  });

  it('removes abandoned rows from the redelivery pool for good', async () => {
    const store = ledger();
    const id = await store.record(input());
    backdate(store, [id], 0);
    await store.abandonStale(['bot-a'], Date.now());

    expect(await store.listPending(['bot-a'])).toHaveLength(0);
    // Not claimable either — abandonment is terminal, not a pause.
    expect(await store.claim(id)).toBe(false);
    // And release() cannot walk it back: its guard is 'redelivering'.
    await store.release(id);
    expect((await store.get(id))?.status).toBe('abandoned');
  });

  it('a process owning no bots abandons nothing', async () => {
    const store = ledger();
    const id = await store.record(input());
    backdate(store, [id], 0);
    expect(await store.abandonStale([], Date.now())).toEqual([]);
    expect((await store.get(id))?.status).toBe('pending');
  });

  it('prunes abandoned rows alongside delivered ones', async () => {
    const store = ledger();
    const abandoned = await store.record(input({ content: 'gave up' }));
    const delivered = await store.record(input({ content: 'confirmed' }));
    const stuck = await store.record(input({ content: 'still owed' }));
    const claimed = await store.record(input({ content: 'mid-send' }));
    await store.markDelivered(delivered);
    await store.claim(claimed);
    backdate(store, [abandoned, delivered, stuck, claimed], 0);
    await store.abandonStale(['bot-a'], 1);

    // abandonStale swept `stuck` and `claimed` too — re-pend them so the prune
    // is tested against live rows that are just as old as the terminal ones.
    const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
    db.prepare(`UPDATE delivery_obligations SET status = 'pending' WHERE id = ?`).run(stuck);
    db.prepare(`UPDATE delivery_obligations SET status = 'redelivering' WHERE id = ?`).run(claimed);

    expect(await store.pruneDelivered(Date.now())).toBe(2);
    expect(await store.get(abandoned)).toBeNull();
    expect(await store.get(delivered)).toBeNull();
    expect((await store.get(stuck))?.status).toBe('pending');
    expect((await store.get(claimed))?.status).toBe('redelivering');
  });
});

describe('SQLiteDeliveryLedger — operator reads', () => {
  /** Move a row's created_at so ordering is deterministic in-test. */
  function backdate(store: SQLiteDeliveryLedger, id: string, at: number) {
    const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
    db.prepare('UPDATE delivery_obligations SET created_at = ? WHERE id = ?').run(at, id);
  }

  it('stats counts every status, with voice rows also counted separately', async () => {
    const store = ledger();
    await store.record(input({ content: 'text pending' }));
    const textDelivered = await store.record(input({ content: 'text delivered' }));
    await store.markDelivered(textDelivered);
    await store.record(input({ kind: 'voice', artifactRef: 'a1', content: 'voice pending' }));
    const voiceDelivered = await store.record(
      input({ kind: 'voice', artifactRef: 'a2', content: 'voice delivered' }),
    );
    await store.markDelivered(voiceDelivered);
    const claimed = await store.record(input({ kind: 'voice', content: 'voice claimed' }));
    await store.claim(claimed);

    expect(await store.stats()).toEqual({
      pending: 2,
      redelivering: 1,
      delivered: 2,
      abandoned: 0,
      voice: { pending: 1, redelivering: 1, delivered: 1, abandoned: 0 },
    });
  });

  it('stats counts abandoned rows and reports zeros for an empty ledger', async () => {
    const store = ledger();
    expect(await store.stats()).toEqual({
      pending: 0,
      redelivering: 0,
      delivered: 0,
      abandoned: 0,
      voice: { pending: 0, redelivering: 0, delivered: 0, abandoned: 0 },
    });
    const id = await store.record(input({ kind: 'voice', content: 'gave up' }));
    backdate(store, id, 0);
    await store.abandonStale(['bot-a'], 1);
    const stats = await store.stats();
    expect(stats.abandoned).toBe(1);
    expect(stats.voice.abandoned).toBe(1);
  });

  it('counts a pre-v3 row (kind IS NULL) as text, never as voice', async () => {
    const store = ledger();
    const id = await store.record(input());
    const db = (store as unknown as { db: InstanceType<typeof Database> }).db;
    db.prepare('UPDATE delivery_obligations SET kind = NULL WHERE id = ?').run(id);
    const stats = await store.stats();
    expect(stats.pending).toBe(1);
    expect(stats.voice.pending).toBe(0);
  });

  it('listRecent returns newest first, across every botKey', async () => {
    const store = ledger();
    const oldest = await store.record(input({ botKey: 'bot-a', content: 'first' }));
    const middle = await store.record(input({ botKey: 'bot-z', content: 'second' }));
    const newest = await store.record(input({ botKey: 'bot-a', content: 'third' }));
    backdate(store, oldest, 1000);
    backdate(store, middle, 2000);
    backdate(store, newest, 3000);

    // Not ownership-filtered: an operator reading one file sees the whole file.
    expect((await store.listRecent(10)).map((o) => o.id)).toEqual([newest, middle, oldest]);
  });

  it('listRecent clamps the limit to 1-200 instead of throwing', async () => {
    const store = ledger();
    for (let i = 0; i < 3; i++) await store.record(input({ content: `n${i}` }));
    expect(await store.listRecent(0)).toHaveLength(1);
    expect(await store.listRecent(-5)).toHaveLength(1);
    expect(await store.listRecent(1000)).toHaveLength(3);
    expect(await store.listRecent(Number.NaN)).toHaveLength(3);
  });

  it('listRecent carries the voice fields a display needs', async () => {
    const store = ledger();
    await store.record(
      input({
        kind: 'voice',
        artifactRef: 'artifacts/abc.opus',
        mediaFormat: 'opus',
        threadId: 'thread-7',
        content: 'the spoken text',
      }),
    );
    const [row] = await store.listRecent(1);
    expect(row?.kind).toBe('voice');
    expect(row?.artifactRef).toBe('artifacts/abc.opus');
    expect(row?.mediaFormat).toBe('opus');
    expect(row?.threadId).toBe('thread-7');
    expect(row?.content).toBe('the spoken text');
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

describe('SQLiteDeliveryLedger — durability posture', () => {
  it('stays at synchronous = FULL', () => {
    // NOT a candidate for `synchronous = NORMAL`, and this pin is here so a
    // later blanket sweep of the SQLite stores cannot take it silently.
    //
    // This ledger exists SPECIFICALLY to survive a crash: an obligation is
    // written `pending` BEFORE the platform call and marked `delivered` only
    // after it is confirmed, so that `sweepPendingDeliveries()` can redeliver
    // whatever is still pending. Under NORMAL a power loss can roll back the
    // last commits — which is exactly the `pending` row for the reply that was
    // in flight when the power went. The sweep would then find nothing and the
    // reply is lost for good, the one outcome this file was built to prevent.
    // The write path is ~2 commits per reply on a human-conversation cadence,
    // so FULL costs roughly 9ms against a multi-second turn.
    const store = new SQLiteDeliveryLedger(':memory:');
    // Asserted against the opened database, not the source text.
    expect(syncPragma(store)).toBe(2);
    store.close();
  });
});
