import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database, { backup } from '@ethosagent/sqlite';
import { afterEach, describe, expect, it } from 'vitest';

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'sqlite-test-'));
}

describe('Constructor', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('opens a database and creates a table', () => {
    dir = makeTmpDir();
    const db = new Database(join(dir, 'test.db'));
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
    db.prepare('INSERT INTO t (val) VALUES (?)').run('hello');
    const row = db.prepare('SELECT val FROM t').get();
    expect(row).toEqual({ val: 'hello' });
    db.close();
  });

  it('readonly option prevents writes', () => {
    dir = makeTmpDir();
    const dbPath = join(dir, 'ro.db');
    const rw = new Database(dbPath);
    rw.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    rw.close();

    const ro = new Database(dbPath, { readonly: true });
    expect(() => ro.exec('INSERT INTO t (id) VALUES (1)')).toThrow();
    ro.close();
  });
});

describe('prepare/run/get/all', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('INSERT returns changes and lastInsertRowid as numbers', () => {
    dir = makeTmpDir();
    const db = new Database(join(dir, 'test.db'));
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    const result = db.prepare('INSERT INTO t (name) VALUES (?)').run('alice');
    expect(result.changes).toBe(1);
    expect(typeof result.changes).toBe('number');
    expect(typeof result.lastInsertRowid).toBe('number');
    expect(result.lastInsertRowid).toBeGreaterThan(0);
    db.close();
  });

  it('GET returns row or undefined', () => {
    dir = makeTmpDir();
    const db = new Database(join(dir, 'test.db'));
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    db.prepare('INSERT INTO t (name) VALUES (?)').run('bob');
    const row = db.prepare('SELECT * FROM t WHERE name = ?').get('bob');
    expect(row).toBeDefined();
    expect((row as Record<string, unknown>).name).toBe('bob');
    const missing = db.prepare('SELECT * FROM t WHERE name = ?').get('nobody');
    expect(missing).toBeUndefined();
    db.close();
  });

  it('ALL returns array of rows', () => {
    dir = makeTmpDir();
    const db = new Database(join(dir, 'test.db'));
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    db.prepare('INSERT INTO t (name) VALUES (?)').run('a');
    db.prepare('INSERT INTO t (name) VALUES (?)').run('b');
    const rows = db.prepare('SELECT * FROM t ORDER BY id').all();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.name).toBe('a');
    expect(rows[1]?.name).toBe('b');
    db.close();
  });
});

describe('exec', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('multi-statement exec creates tables', () => {
    dir = makeTmpDir();
    const db = new Database(join(dir, 'test.db'));
    db.exec(`
      CREATE TABLE a (id INTEGER PRIMARY KEY);
      CREATE TABLE b (id INTEGER PRIMARY KEY);
    `);
    db.prepare('INSERT INTO a (id) VALUES (1)').run();
    db.prepare('INSERT INTO b (id) VALUES (2)').run();
    expect(db.prepare('SELECT id FROM a').get()).toEqual({ id: 1 });
    expect(db.prepare('SELECT id FROM b').get()).toEqual({ id: 2 });
    db.close();
  });
});

describe('pragma', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('SET pragma returns undefined', () => {
    dir = makeTmpDir();
    const db = new Database(join(dir, 'test.db'));
    const result = db.pragma('journal_mode = WAL');
    expect(result).toBeUndefined();
    db.close();
  });

  it('READ pragma user_version returns rows', () => {
    dir = makeTmpDir();
    const db = new Database(join(dir, 'test.db'));
    const result = db.pragma('user_version') as Record<string, unknown>[];
    expect(result).toEqual([{ user_version: 0 }]);
    db.close();
  });

  it('READ pragma table_info returns column info', () => {
    dir = makeTmpDir();
    const db = new Database(join(dir, 'test.db'));
    db.exec('CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT)');
    const result = db.pragma('table_info(test_table)') as Record<string, unknown>[];
    expect(result.length).toBeGreaterThanOrEqual(2);
    const names = result.map((r) => r.name);
    expect(names).toContain('id');
    expect(names).toContain('name');
    db.close();
  });
});

describe('transaction', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('commit path: inserts are visible after', () => {
    dir = makeTmpDir();
    const db = new Database(join(dir, 'test.db'));
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
    const insert = db.transaction(() => {
      db.prepare('INSERT INTO t (val) VALUES (?)').run('x');
      db.prepare('INSERT INTO t (val) VALUES (?)').run('y');
    });
    insert();
    const rows = db.prepare('SELECT * FROM t').all();
    expect(rows).toHaveLength(2);
    db.close();
  });

  it('rollback path: throw rolls back and re-throws', () => {
    dir = makeTmpDir();
    const db = new Database(join(dir, 'test.db'));
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
    const failing = db.transaction(() => {
      db.prepare('INSERT INTO t (val) VALUES (?)').run('z');
      throw new Error('boom');
    });
    expect(() => failing()).toThrow('boom');
    const rows = db.prepare('SELECT * FROM t').all();
    expect(rows).toHaveLength(0);
    db.close();
  });

  it('nesting: inner rollback does not affect outer', () => {
    dir = makeTmpDir();
    const db = new Database(join(dir, 'test.db'));
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
    const outer = db.transaction(() => {
      db.prepare('INSERT INTO t (val) VALUES (?)').run('outer');
      const inner = db.transaction(() => {
        db.prepare('INSERT INTO t (val) VALUES (?)').run('inner');
        throw new Error('inner fail');
      });
      try {
        inner();
      } catch {
        // inner rolled back, outer continues
      }
    });
    outer();
    const rows = db.prepare('SELECT * FROM t').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.val).toBe('outer');
    db.close();
  });

  it('returns fn return value', () => {
    dir = makeTmpDir();
    const db = new Database(join(dir, 'test.db'));
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    const getThing = db.transaction(() => 42);
    expect(getThing()).toBe(42);
    db.close();
  });

  it('immediate variant uses BEGIN IMMEDIATE', () => {
    dir = makeTmpDir();
    const db = new Database(join(dir, 'test.db'));
    db.exec('CREATE TABLE test_table (name TEXT)');
    const tx = db.transaction((val: string) => {
      db.prepare('INSERT INTO test_table (name) VALUES (?)').run(val);
      return 'ok';
    });
    expect(tx.immediate('immediate-test')).toBe('ok');
    const row = db.prepare('SELECT name FROM test_table WHERE name = ?').get('immediate-test');
    expect(row).toEqual({ name: 'immediate-test' });
    db.close();
  });
});

describe('Integer types', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lastInsertRowid is typeof number', () => {
    dir = makeTmpDir();
    const db = new Database(join(dir, 'test.db'));
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
    const result = db.prepare('INSERT INTO t (val) VALUES (?)').run('test');
    expect(typeof result.lastInsertRowid).toBe('number');
    db.close();
  });

  it('timestamp values round-trip as typeof number', () => {
    dir = makeTmpDir();
    const db = new Database(join(dir, 'test.db'));
    db.exec('CREATE TABLE t (ts INTEGER)');
    const now = Date.now();
    db.prepare('INSERT INTO t (ts) VALUES (?)').run(now);
    const row = db.prepare('SELECT ts FROM t').get() as Record<string, unknown>;
    expect(typeof row.ts).toBe('number');
    expect(row.ts).toBe(now);
    db.close();
  });
});

describe('WAL mode', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('sets and reads back WAL mode', () => {
    dir = makeTmpDir();
    const db = new Database(join(dir, 'test.db'));
    db.pragma('journal_mode = WAL');
    const result = db.pragma('journal_mode') as Record<string, unknown>[];
    expect(result[0]?.journal_mode).toBe('wal');
    db.close();
  });
});

describe('FTS5', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates FTS5 table, inserts, and MATCH queries work', () => {
    dir = makeTmpDir();
    const db = new Database(join(dir, 'test.db'));
    db.exec('CREATE VIRTUAL TABLE docs USING fts5(title, body)');
    db.prepare('INSERT INTO docs (title, body) VALUES (?, ?)').run('hello', 'world of testing');
    db.prepare('INSERT INTO docs (title, body) VALUES (?, ?)').run('goodbye', 'cruel world');
    const rows = db.prepare('SELECT * FROM docs WHERE docs MATCH ?').all('world');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    db.close();
  });
});

describe('BLOB roundtrip', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('inserts and reads back a buffer', () => {
    dir = makeTmpDir();
    const db = new Database(join(dir, 'test.db'));
    db.exec('CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB)');
    const buf = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    db.prepare('INSERT INTO blobs (data) VALUES (?)').run(buf);
    const row = db.prepare('SELECT data FROM blobs WHERE id = 1').get() as Record<string, unknown>;
    const retrieved = row.data;
    expect(retrieved).toBeInstanceOf(Uint8Array);
    const bytes = new Uint8Array(retrieved as ArrayBuffer);
    expect(bytes[0]).toBe(0xde);
    expect(bytes[1]).toBe(0xad);
    expect(bytes[2]).toBe(0xbe);
    expect(bytes[3]).toBe(0xef);
    db.close();
  });
});

describe('Param binding', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('positional params', () => {
    dir = makeTmpDir();
    const db = new Database(join(dir, 'test.db'));
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    db.prepare('INSERT INTO t (id, name) VALUES (?, ?)').run(1, 'hello');
    const row = db.prepare('SELECT * FROM t WHERE id = ?').get(1) as Record<string, unknown>;
    expect(row.name).toBe('hello');
    db.close();
  });

  it('named params object', () => {
    dir = makeTmpDir();
    const db = new Database(join(dir, 'test.db'));
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    db.prepare('INSERT INTO t (id, name) VALUES ($id, $name)').run({ $id: 1, $name: 'hello' });
    const row = db.prepare('SELECT * FROM t WHERE id = $id').get({ $id: 1 }) as Record<
      string,
      unknown
    >;
    expect(row.name).toBe('hello');
    db.close();
  });

  it('NULL handling', () => {
    dir = makeTmpDir();
    const db = new Database(join(dir, 'test.db'));
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
    db.prepare('INSERT INTO t (id, val) VALUES (?, ?)').run(1, null);
    const row = db.prepare('SELECT * FROM t WHERE id = ?').get(1) as Record<string, unknown>;
    expect(row.val).toBeNull();
    db.close();
  });
});

describe('Database.Database type alias', () => {
  it('Database.Database is the same as Database', () => {
    expect(Database.Database).toBe(Database);
  });
});

describe('STRICT tables', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('enforces type constraints', () => {
    dir = makeTmpDir();
    const db = new Database(join(dir, 'test.db'));
    db.exec('CREATE TABLE strict_t (id INTEGER PRIMARY KEY, val TEXT) STRICT');
    db.prepare('INSERT INTO strict_t (id, val) VALUES (?, ?)').run(1, 'valid');
    expect(() =>
      db.prepare('INSERT INTO strict_t (id, val) VALUES (?, ?)').run('not_an_int', 'oops'),
    ).toThrow();
    db.close();
  });
});

describe('backup', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('copies a WAL database with pending writes, and the copy reads back the same rows', async () => {
    dir = makeTmpDir();
    const src = new Database(join(dir, 'src.db'));
    src.pragma('journal_mode = WAL');
    src.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT) STRICT');
    const insert = src.prepare('INSERT INTO t (val) VALUES (?)');
    for (let i = 0; i < 500; i++) insert.run(`row-${i}`);

    // Uncheckpointed: the rows above still live in the -wal file, which is the
    // case a naive file copy of src.db alone gets wrong.
    const walMode = src.pragma('journal_mode') as Record<string, unknown>[];
    expect(walMode[0]?.journal_mode).toBe('wal');
    expect(statSync(join(dir, 'src.db-wal')).size).toBeGreaterThan(
      statSync(join(dir, 'src.db')).size,
    );

    const destPath = join(dir, 'copy.db');
    const pages = await backup(src, destPath);
    expect(pages).toBeGreaterThan(0);

    const copy = new Database(destPath, { readonly: true });
    expect(copy.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 500 });
    expect(copy.prepare('SELECT val FROM t WHERE id = ?').get(499)).toEqual({ val: 'row-498' });
    copy.close();
    src.close();
  });

  it('reports progress and leaves the source usable afterwards', async () => {
    dir = makeTmpDir();
    const src = new Database(join(dir, 'src.db'));
    src.pragma('journal_mode = WAL');
    src.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT) STRICT');
    const insert = src.prepare('INSERT INTO t (val) VALUES (?)');
    for (let i = 0; i < 500; i++) insert.run(`row-${i}`);

    const seen: number[] = [];
    await backup(src, join(dir, 'copy.db'), {
      rate: 1,
      progress: ({ remainingPages }) => seen.push(remainingPages),
    });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1] ?? -1).toBeLessThan(seen[0] ?? 0);

    src.prepare('INSERT INTO t (val) VALUES (?)').run('after');
    expect(src.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 501 });
    src.close();
  });
});
