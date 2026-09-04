// The install phase either finishes or puts everything back.
//
// The failure is provoked through a `node:fs` mock rather than by making one
// destination impossible on disk. It used to be the latter — a FILE at
// `<dataDir>/skills` so that creating `skills/pdf/` failed part-way — but gate
// 3's containment walk now refuses that archive before a byte moves: `lstat` of
// `skills/pdf` raises ENOTDIR and the walk propagates it instead of swallowing
// it. That is the correct place for a destination that cannot exist to be
// caught, and it leaves this test with nothing to trigger. What remains able to
// stop the install half-way is what always could — a rename that fails at the
// moment it runs (ENOSPC, a permission changed underneath, a race) — and a mock
// is the only deterministic way to ask for one. Mode bits would not do it: they
// do not stop root, so a suite running as root would pass without exercising
// the path.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '@ethosagent/sqlite';
import { EthosError } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackup } from '../create';
import { restoreBackup } from '../restore';

/** The one install rename the mocked `renameSync` refuses. */
const DOOMED = join('skills', 'pdf', 'SKILL.md');

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      // Only the INSTALL rename: its source is the staging tree. The
      // displacement that precedes it and the rollback that follows both move
      // the same destination name and must be left alone.
      if (String(from).includes('-staging') && String(to).endsWith(DOOMED)) {
        const err: NodeJS.ErrnoException = new Error(`EACCES: permission denied, rename '${to}'`);
        err.code = 'EACCES';
        throw err;
      }
      return actual.renameSync(from, to);
    },
  };
});

let root: string;
let dataDir: string;
let out: string;

function write(rel: string, body: string): void {
  const full = join(dataDir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
}

function count(path: string, table: string): number | string {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.prepare(`SELECT count(*) AS c FROM ${table}`).get();
    return typeof row?.c === 'number' ? row.c : 'unreadable';
  } finally {
    db.close();
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ethos-backup-install-fail-'));
  dataDir = join(root, 'home');
  out = join(root, 'archive.tar.gz');
  mkdirSync(dataDir, { recursive: true });

  write('config.yaml', 'provider: anthropic\n');
  write('cron/jobs.json', '[{"id":"daily"}]');
  write(DOOMED, '# PDF skill\n');

  const db = new Database(join(dataDir, 'sessions.db'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT');
  const insert = db.prepare('INSERT INTO messages VALUES (?, ?)');
  for (let i = 0; i < 120; i++) insert.run(`m-${i}`, `body ${i}`);
  db.close();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('restore install failure', () => {
  it('rolls back to exactly the state it started in', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    write('config.yaml', 'provider: openai\n');
    write(DOOMED, 'the local skill\n');

    const err = await restoreBackup({ dataDir, archivePath: out }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EthosError);
    if (!(err instanceof EthosError)) return;
    expect(err.code).toBe('IMPORT_BLOCKED');
    expect(err.message).toMatch(/Restore failed while installing/);
    expect(err.message).toMatch(/\.pre-restore\//);
    expect(err.details).toMatchObject({ rolledBack: true });

    // The installation is the one that existed before the restore, not a
    // half-restored mixture of the two.
    expect(readFileSync(join(dataDir, 'config.yaml'), 'utf8')).toBe('provider: openai\n');
    expect(readFileSync(join(dataDir, DOOMED), 'utf8')).toBe('the local skill\n');
    expect(count(join(dataDir, 'sessions.db'), 'messages')).toBe(120);
    expect(readFileSync(join(dataDir, 'cron/jobs.json'), 'utf8')).toBe('[{"id":"daily"}]');
    // The staging tree is not left behind either.
    const leftovers = existsSync(join(dataDir, '.pre-restore'))
      ? readdirSync(join(dataDir, '.pre-restore'))
      : [];
    expect(leftovers.filter((name) => name.endsWith('-staging'))).toEqual([]);
  });
});
