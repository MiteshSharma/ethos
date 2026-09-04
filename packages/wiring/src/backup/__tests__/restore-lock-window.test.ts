// The restore's database lock must be a HOLD, not a probe.
//
// A probe that opens the database, checks it is idle and closes again proves
// only that nothing held it at that instant. Everything dangerous — the
// displacement and the install — happens afterwards, and any process that
// opens the file in between (`ethos chat` at a prompt, a serve process coming
// back up) is exactly what the gate exists to catch. Checking several
// databases in sequence widens that window with every one.
//
// The window is not observable from outside `restoreBackup`, so this test
// reaches into the one seam that brackets it: `readTarGz` is called twice —
// once by `verifyArchive`, before the gate, and once by the restore itself,
// after it. Probing the LIVE database at each call answers "was the lock held
// yet" and "is it still held", which is the whole property.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '@ethosagent/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackup } from '../create';
import { restoreBackup } from '../restore';

const probe = vi.hoisted(() => ({
  dbPath: '',
  results: [] as Array<'free' | 'in use'>,
  sentinelPath: '',
  sentinel: [] as boolean[],
}));

vi.mock('../tar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tar')>();
  const { default: Sqlite } = await import('@ethosagent/sqlite');
  return {
    ...actual,
    readTarGz: async (archivePath: string, visit: Parameters<typeof actual.readTarGz>[1]) => {
      if (probe.sentinelPath) probe.sentinel.push(existsSync(probe.sentinelPath));
      if (probe.dbPath) {
        let db: InstanceType<typeof Sqlite> | undefined;
        try {
          db = new Sqlite(probe.dbPath);
          db.exec('PRAGMA locking_mode = EXCLUSIVE');
          db.exec('BEGIN IMMEDIATE');
          db.exec('COMMIT');
          probe.results.push('free');
        } catch {
          probe.results.push('in use');
        } finally {
          db?.close();
        }
      }
      return actual.readTarGz(archivePath, visit);
    },
  };
});

let root: string;
let dataDir: string;
let out: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ethos-backup-lock-'));
  dataDir = join(root, 'home');
  out = join(root, 'archive.tar.gz');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'config.yaml'), 'provider: anthropic\n');

  const db = new Database(join(dataDir, 'sessions.db'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY) STRICT');
  db.prepare('INSERT INTO messages VALUES (?)').run('m1');
  db.close();

  probe.dbPath = '';
  probe.results.length = 0;
  probe.sentinelPath = '';
  probe.sentinel.length = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('restore lock lifetime', () => {
  it('still holds the database lock when it starts writing', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    probe.dbPath = join(dataDir, 'sessions.db');

    const report = await restoreBackup({ dataDir, archivePath: out });

    // Pass 1 is `verifyArchive`, before the gate: the database is free, which
    // is what makes the second answer meaningful rather than trivially true.
    // Pass 2 is the restore's own read, after the gate and before a single
    // file has moved — nothing else may open the database from here on.
    expect(probe.results).toEqual(['free', 'in use']);
    expect(report.lockedDatabases).toEqual(['sessions.db']);
  });

  it('releases every lock once the restore is done', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    await restoreBackup({ dataDir, archivePath: out });

    const db = new Database(join(dataDir, 'sessions.db'));
    try {
      db.exec('PRAGMA locking_mode = EXCLUSIVE');
      db.exec('BEGIN IMMEDIATE');
      db.exec('COMMIT');
      expect(db.prepare('SELECT count(*) AS c FROM messages').get()?.c).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('restore sentinel lifetime', () => {
  it('holds .restore-in-progress across the extraction and clears it afterwards', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    const sentinel = join(dataDir, '.restore-in-progress');
    probe.sentinelPath = sentinel;

    await restoreBackup({ dataDir, archivePath: out });

    // Pass 1 is `verifyArchive`, before the claim; pass 2 is the restore's own
    // read, with the data directory claimed for the whole dangerous phase.
    expect(probe.sentinel).toEqual([false, true]);
    expect(existsSync(sentinel)).toBe(false);
  });
});
