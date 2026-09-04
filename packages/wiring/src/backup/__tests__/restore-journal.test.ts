// A restore that is killed part-way must not be able to make itself permanent.
//
// The install phase is exception-safe: a thrown error unwinds through a `catch`
// that puts every rename back from the in-memory `moved`/`installed` lists. A
// `SIGKILL`, the OOM killer or a power cut runs none of that, and the lists die
// with the process — leaving the live tree holding an arbitrary mixture of old
// and restored files with nothing on disk saying which is which. The recovery
// path then made it permanent: a sentinel past the stale threshold was unlinked
// and the next restore proceeded on top of the half-rewritten tree, its
// predecessor's recovery copies orphaned under `.pre-restore/`.
//
// So the install phase writes a journal beside those copies, fsynced before
// each rename it describes, and a restore that takes a stale sentinel over
// rolls the dead one back from it first.
//
// SIMULATING THE CRASH: no in-process test can be `SIGKILL`ed and still make
// assertions, so the two things a killed process does not do are suppressed
// instead — `renameSync` starts throwing part-way through the install (nothing
// after the kill happens) and `rmSync` stops working for the duration (a killed
// process cleans nothing up: not the journal, not the staging tree). What is
// left on disk afterwards is what a kill leaves. The sentinel is re-created by
// the test with an old mtime, which is the state the stale rule reads.
//
// ASSERTING "RECOVERED BEFORE PROCEEDING": the second restore is made to refuse
// at the in-use gate — a database is held open — which sits AFTER the sentinel
// claim and before anything is written. Whatever the tree looks like when that
// refusal lands is exactly what recovery produced, with nothing of the new
// restore mixed into it.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import Database from '@ethosagent/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackup } from '../create';
import { restoreBackup } from '../restore';

const crash = vi.hoisted(() => ({ armed: false, failAfter: 0, renames: 0 }));
const spy = vi.hoisted(() => ({
  armed: false,
  marker: '',
  calls: [] as Array<{ from: string; to: string; journal: string[] }>,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { join: joinPath } = await import('node:path');

  /** Every journal line currently on disk, across every displacement directory. */
  function journalLines(marker: string): string[] {
    const base = marker.slice(0, -1);
    if (!actual.existsSync(base)) return [];
    const out: string[] = [];
    for (const entry of actual.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = joinPath(base, entry.name, 'journal.jsonl');
      if (!actual.existsSync(path)) continue;
      out.push(...actual.readFileSync(path, 'utf8').split('\n').filter(Boolean));
    }
    return out;
  }

  return {
    ...actual,
    default: actual,
    renameSync: (from: string, to: string) => {
      if (spy.armed) spy.calls.push({ from, to, journal: journalLines(spy.marker) });
      if (crash.armed) {
        if (crash.renames >= crash.failAfter) throw new Error('simulated crash');
        crash.renames++;
      }
      return actual.renameSync(from, to);
    },
    rmSync: (path: string, options?: Parameters<typeof actual.rmSync>[1]) => {
      if (crash.armed) return;
      return actual.rmSync(path, options);
    },
  };
});

let root: string;
let dataDir: string;
let out: string;

const V2 = {
  'config.yaml': 'provider: openai\n',
  'MEMORY.md': '# edited since the backup\n',
  'skills/pdf/SKILL.md': '# PDF skill, edited\n',
} as const;

/** The archive's copy of each file — what a completed restore would install. */
const V1 = {
  'config.yaml': 'provider: anthropic\n',
  'MEMORY.md': '# project\n',
  'skills/pdf/SKILL.md': '# PDF skill\n',
} as const;

function write(rel: string, text: string): void {
  writeFileSync(join(dataDir, rel), text);
}

function readTree(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const rel of Object.keys(V1)) {
    const path = join(dataDir, rel);
    out[rel] = existsSync(path) ? readFileSync(path, 'utf8') : null;
  }
  return out;
}

/** Every `.pre-restore/<dir>/journal.jsonl` that exists, as parsed records. */
function journals(): Array<{ dir: string; records: unknown[] }> {
  const preRestore = join(dataDir, '.pre-restore');
  if (!existsSync(preRestore)) return [];
  const out: Array<{ dir: string; records: unknown[] }> = [];
  for (const entry of readdirSync(preRestore, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(preRestore, entry.name, 'journal.jsonl');
    if (!existsSync(path)) continue;
    out.push({
      dir: entry.name,
      records: readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    });
  }
  return out;
}

/** The state a crashed restore leaves: a sentinel nothing will ever release. */
function plantStaleSentinel(): void {
  const path = join(dataDir, '.restore-in-progress');
  writeFileSync(path, '424242 crashed\n');
  const past = new Date(Date.now() - 6 * 60 * 60 * 1000);
  utimesSync(path, past, past);
}

/**
 * Hold `sessions.db` so the next restore refuses at the in-use gate. An open
 * write transaction, because that is the one hold every journal mode honours —
 * a restored database is not necessarily still in WAL.
 */
function holdDatabase(): Database.Database {
  const db = new Database(join(dataDir, 'sessions.db'));
  db.exec('BEGIN IMMEDIATE');
  return db;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ethos-restore-journal-'));
  dataDir = join(root, 'home');
  out = join(root, 'archive.tar.gz');
  mkdirSync(join(dataDir, 'skills', 'pdf'), { recursive: true });
  for (const [rel, text] of Object.entries(V1)) write(rel, text);

  const db = new Database(join(dataDir, 'sessions.db'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY) STRICT');
  db.prepare('INSERT INTO messages VALUES (?)').run('m1');
  db.close();

  await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });

  crash.armed = false;
  crash.failAfter = 0;
  crash.renames = 0;
  spy.armed = false;
  spy.marker = `${join(dataDir, '.pre-restore')}${sep}`;
  spy.calls.length = 0;
});

afterEach(() => {
  crash.armed = false;
  spy.armed = false;
  rmSync(root, { recursive: true, force: true });
});

describe('restore install journal', () => {
  it('records each move before that move is observable', async () => {
    spy.armed = true;
    await restoreBackup({ dataDir, archivePath: out, force: true });
    spy.armed = false;

    const marker = spy.marker;
    const moves = spy.calls.filter((c) => c.from.startsWith(marker) || c.to.startsWith(marker));
    expect(moves.length).toBeGreaterThan(1);

    for (const move of moves) {
      // A displacement moves INTO `.pre-restore/<dir>/`; an install moves out
      // of `.pre-restore/<dir>-staging/`. Either way the relative path is what
      // follows the directory segment.
      const displacing = move.to.startsWith(marker);
      const side = displacing ? move.to : move.from;
      const rest = side.slice(marker.length);
      const rel = rest
        .slice(rest.indexOf(sep) + 1)
        .split(sep)
        .join('/');
      const expected = { op: displacing ? 'displace' : 'install', rel };

      // The record for THIS move is already on disk, and it is the newest one:
      // nothing has been renamed since it was written.
      const records = move.journal.map((line) => JSON.parse(line));
      expect(records[records.length - 1]).toEqual(expected);
      expect(records[0]).toMatchObject({ op: 'begin' });
    }
  });

  it('leaves no journal behind after a successful restore', async () => {
    const report = await restoreBackup({ dataDir, archivePath: out, force: true });

    expect(report.restored).toContain('config.yaml');
    expect(journals()).toEqual([]);
  });

  it('recovers a crashed install to exactly the pre-restore tree before proceeding', async () => {
    for (const [rel, text] of Object.entries(V2)) write(rel, text);
    const before = readTree();
    expect(before).toEqual(V2);

    // Three displacements and one install get through; the fifth rename dies,
    // and with it the process.
    crash.armed = true;
    crash.failAfter = 4;
    await expect(restoreBackup({ dataDir, archivePath: out, force: true })).rejects.toThrow();
    crash.armed = false;

    // What a kill leaves: a journal, recovery copies, and a live tree that is
    // neither the old one nor the new one.
    const [journal] = journals();
    expect(journal).toBeDefined();
    expect(journal?.records[0]).toMatchObject({ op: 'begin' });
    expect(readTree()).not.toEqual(V2);
    expect(readTree()).not.toEqual(V1);

    plantStaleSentinel();

    // The next restore takes the stale sentinel over, then refuses at the
    // in-use gate — so the tree it leaves is purely what recovery produced.
    const held = holdDatabase();
    try {
      await expect(restoreBackup({ dataDir, archivePath: out })).rejects.toThrow(/in use/);
    } finally {
      held.close();
    }

    expect(readTree()).toEqual(V2);
    expect(journals()).toEqual([]);
  });

  it('takes a stale sentinel over untouched when the dead restore left no journal', async () => {
    // A completed restore leaves `.pre-restore/` full of recovery copies and no
    // journal — the shape a crash BEFORE the install phase also leaves.
    await restoreBackup({ dataDir, archivePath: out, force: true });
    for (const [rel, text] of Object.entries(V2)) write(rel, text);
    plantStaleSentinel();

    const held = holdDatabase();
    try {
      await expect(restoreBackup({ dataDir, archivePath: out })).rejects.toThrow(/in use/);
    } finally {
      held.close();
    }

    expect(readTree()).toEqual(V2);
  });

  it('takes a stale sentinel over untouched when there is no .pre-restore at all', async () => {
    for (const [rel, text] of Object.entries(V2)) write(rel, text);
    plantStaleSentinel();
    expect(existsSync(join(dataDir, '.pre-restore'))).toBe(false);

    const held = holdDatabase();
    try {
      await expect(restoreBackup({ dataDir, archivePath: out })).rejects.toThrow(/in use/);
    } finally {
      held.close();
    }

    expect(readTree()).toEqual(V2);
    expect(existsSync(join(dataDir, '.restore-in-progress'))).toBe(false);
  });
});
