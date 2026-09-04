// Databases are installed last, and the reason is not tidiness.
//
// The gate-4 lock is held on the LIVE database file. `renameSync` moves that
// file — inode and lock together — into `.pre-restore/`, and the staged
// replacement that takes its pathname is a new inode nothing holds: from the
// moment it lands, any process that opens that path gets it. The lock cannot
// cover that, so the only thing this package can do is make the interval short
// — every non-database file is already in place before the first database
// moves, so a process that does open the restored database sees it beside a
// complete tree rather than a half-installed one.
//
// Install order is not visible in the result, so this watches the renames.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '@ethosagent/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackup } from '../create';
import { restoreBackup } from '../restore';

const renames = vi.hoisted(() => ({ pairs: [] as Array<[string, string]> }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    renameSync: (from: string, to: string) => {
      renames.pairs.push([from, to]);
      return actual.renameSync(from, to);
    },
  };
});

let root: string;
let dataDir: string;
let out: string;

/** A database file or one of its sidecars, by name. */
function isDatabase(path: string): boolean {
  return path.endsWith('.db') || /\.db-(wal|shm|journal)$/.test(path);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ethos-backup-order-'));
  dataDir = join(root, 'home');
  out = join(root, 'archive.tar.gz');
  mkdirSync(join(dataDir, 'skills', 'pdf'), { recursive: true });
  writeFileSync(join(dataDir, 'config.yaml'), 'provider: anthropic\n');
  writeFileSync(join(dataDir, 'MEMORY.md'), '# project\n');
  // Sorts AFTER sessions.db, so a single-pass install puts the database in
  // place while files are still missing.
  writeFileSync(join(dataDir, 'skills', 'pdf', 'SKILL.md'), '# PDF skill\n');

  const db = new Database(join(dataDir, 'sessions.db'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY) STRICT');
  db.prepare('INSERT INTO messages VALUES (?)').run('m1');
  db.close();

  renames.pairs.length = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('restore install order', () => {
  it('puts every ordinary file in place before the first database', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    const report = await restoreBackup({ dataDir, archivePath: out, force: true });
    expect(report.restored).toContain('sessions.db');
    expect(report.restored).toContain('skills/pdf/SKILL.md');

    // Installs are the renames INTO the live tree; the others move a live file
    // out to `.pre-restore/`.
    const installs = renames.pairs
      .filter(([, to]) => !to.includes('.pre-restore'))
      .map(([, to]) => (isDatabase(to) ? 'database' : 'file'));

    expect(installs).toContain('file');
    expect(installs).toContain('database');
    expect(installs.lastIndexOf('file')).toBeLessThan(installs.indexOf('database'));
  });
});
