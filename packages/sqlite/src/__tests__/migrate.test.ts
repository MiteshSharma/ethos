import { type EthosError, isEthosError } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import Database, { migrate } from '../index';

function userVersion(db: Database.Database): number {
  const rows = db.pragma('user_version') as Array<{ user_version: number }>;
  return rows[0]?.user_version ?? 0;
}

const BASELINE = `
  CREATE TABLE IF NOT EXISTS items (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL
  ) STRICT;
`;

describe('migrate', () => {
  it('stamps a fresh in-memory DB to the target version', () => {
    const db = new Database(':memory:');
    migrate(db, { name: 'test', targetVersion: 1, baseline: BASELINE, migrations: {} });
    expect(userVersion(db)).toBe(1);
    // Baseline ran: the table exists and is writable.
    db.prepare('INSERT INTO items (name) VALUES (?)').run('a');
    expect(db.prepare('SELECT COUNT(*) AS n FROM items').get()).toEqual({ n: 1 });
    db.close();
  });

  it('throws when the DB version is newer than the code', () => {
    const db = new Database(':memory:');
    db.pragma('user_version = 2');
    expect(() =>
      migrate(db, { name: 'test', targetVersion: 1, baseline: BASELINE, migrations: {} }),
    ).toThrow(/user_version=2 is newer than code \(1\); refusing to open to avoid downgrade/);
    db.close();
  });

  it('refuses a downgrade with a typed IMPORT_NEWER_SCHEMA error', () => {
    const db = new Database(':memory:');
    db.pragma('user_version = 2');
    let thrown: unknown;
    try {
      migrate(db, { name: 'test', targetVersion: 1, baseline: BASELINE, migrations: {} });
    } catch (err) {
      thrown = err;
    }
    expect(isEthosError(thrown)).toBe(true);
    const err = thrown as EthosError;
    expect(err.code).toBe('IMPORT_NEWER_SCHEMA');
    expect(err.action).toMatch(/Upgrade Ethos/);
    // The refusal still refuses: the baseline never ran, so the table is absent.
    expect(() => db.prepare('SELECT COUNT(*) AS n FROM items').get()).toThrow();
    db.close();
  });

  it('runs a 2-step chain in order, each step visible via user_version', () => {
    const db = new Database(':memory:');
    db.exec(BASELINE);
    db.pragma('user_version = 1');

    const order: number[] = [];
    migrate(db, {
      name: 'test',
      targetVersion: 3,
      baseline: BASELINE,
      migrations: {
        2: (d) => {
          order.push(2);
          d.exec('CREATE TABLE step2 (id INTEGER PRIMARY KEY)');
        },
        3: (d) => {
          order.push(3);
          d.exec('CREATE TABLE step3 (id INTEGER PRIMARY KEY)');
        },
      },
    });

    expect(order).toEqual([2, 3]);
    expect(userVersion(db)).toBe(3);
    // Both migration tables exist.
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='step2'").get(),
    ).toBeTruthy();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='step3'").get(),
    ).toBeTruthy();
    db.close();
  });

  it('rolls a failing step back atomically — version unchanged, table absent', () => {
    const db = new Database(':memory:');
    db.exec(BASELINE);
    db.pragma('user_version = 1');

    expect(() =>
      migrate(db, {
        name: 'test',
        targetVersion: 2,
        baseline: BASELINE,
        migrations: {
          2: (d) => {
            d.exec('CREATE TABLE doomed (id INTEGER PRIMARY KEY)');
            throw new Error('boom');
          },
        },
      }),
    ).toThrow('boom');

    // The whole step rolled back: version stays at 1 and the table is gone.
    expect(userVersion(db)).toBe(1);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='doomed'").get(),
    ).toBeUndefined();
    db.close();
  });

  it('is idempotent: re-running preserves rows and version', () => {
    const db = new Database(':memory:');
    migrate(db, { name: 'test', targetVersion: 1, baseline: BASELINE, migrations: {} });
    db.prepare('INSERT INTO items (name) VALUES (?)').run('keep-me');

    // Second run on the same DB is a no-op — baseline is IF NOT EXISTS.
    migrate(db, { name: 'test', targetVersion: 1, baseline: BASELINE, migrations: {} });

    expect(userVersion(db)).toBe(1);
    expect(db.prepare('SELECT name FROM items').get()).toEqual({ name: 'keep-me' });
    db.close();
  });
});
