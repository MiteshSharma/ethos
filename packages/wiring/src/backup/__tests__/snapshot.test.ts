// Snapshotting a WAL database with uncheckpointed writes (plan D2).
//
// `wal_autocheckpoint = 0` makes the point exactly: with checkpointing off,
// NOTHING written after the first page reaches the main database file, so a
// byte-for-byte copy of it does not even have the schema. That is what a naive
// file copy of `~/.ethos/sessions.db` produces on a busy machine, and it is
// the failure this module exists to prevent.

import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '@ethosagent/sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshotSqlite } from '../snapshot';

const ROWS = 200;

let dir: string;
let src: string;
let live: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ethos-snapshot-'));
  src = join(dir, 'sessions.db');
  live = new Database(src);
  live.pragma('journal_mode = WAL');
  live.pragma('wal_autocheckpoint = 0');
  live.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT');
  const insert = live.prepare('INSERT INTO messages VALUES (?, ?)');
  for (let i = 0; i < ROWS; i++) insert.run(`m${i}`, `body ${i}`);
});

afterEach(() => {
  live.close();
  rmSync(dir, { recursive: true, force: true });
});

function countRows(path: string): number | string {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.prepare('SELECT count(*) AS c FROM messages').get();
    return typeof row?.c === 'number' ? row.c : 'unreadable';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    db.close();
  }
}

describe('snapshotSqlite', () => {
  it('a naive file copy loses every uncheckpointed commit — the reason this exists', () => {
    const copy = join(dir, 'naive.db');
    copyFileSync(src, copy);
    expect(countRows(copy)).toBe('no such table: messages');
  });

  it("mode 'backup' captures all committed data while the writer stays open", async () => {
    const dest = join(dir, 'backup.db');
    await snapshotSqlite(src, dest, 'backup');
    expect(countRows(dest)).toBe(ROWS);
    // The source is untouched and still usable.
    live.prepare('INSERT INTO messages VALUES (?, ?)').run('after', 'still writable');
    expect(countRows(src)).toBe(ROWS + 1);
  });

  it("mode 'vacuum' captures all committed data too", async () => {
    const dest = join(dir, 'vacuum.db');
    await snapshotSqlite(src, dest, 'vacuum');
    expect(countRows(dest)).toBe(ROWS);
  });

  it('both modes agree', async () => {
    await snapshotSqlite(src, join(dir, 'a.db'), 'backup');
    await snapshotSqlite(src, join(dir, 'b.db'), 'vacuum');
    expect(countRows(join(dir, 'a.db'))).toBe(countRows(join(dir, 'b.db')));
  });

  it('refuses to overwrite an existing destination', async () => {
    const dest = join(dir, 'twice.db');
    await snapshotSqlite(src, dest, 'vacuum');
    await expect(snapshotSqlite(src, dest, 'vacuum')).rejects.toThrow();
  });
});
