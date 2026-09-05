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
// each rename it describes, and every restore that claims the data directory
// replays whatever journals it finds before it touches the tree.
//
// KEYED OFF THE JOURNAL, NOT THE SENTINEL. Recovery used to hang off one branch
// of the sentinel logic — taking a STALE sentinel over — which the path an
// operator actually walks does not go through. A restore killed mid-install
// leaves the tree half-rewritten; the retry inside the stale hour is refused;
// the refusal says to delete `.restore-in-progress`; deleting it makes the next
// `wx` create succeed, so recovery never ran and the new restore went in on top
// of the wreckage with the old journal left armed behind it. The sentinel is
// mutual exclusion, and an operator is told to delete it. The journal is the
// evidence, and only an unfinished install writes one.
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

import { spawnSync } from 'node:child_process';
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
import { EthosError } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackup } from '../create';
import { currentBootId } from '../holder-identity';
import { restoreBackup } from '../restore';

// `blockRm` is what makes the crash a KILL rather than a throw: a killed
// process cleans nothing up. A test that wants the real `finally` to run — the
// rollback-failure one, which is about what that `finally` decides to keep —
// turns it off and keeps only the failing renames.
const crash = vi.hoisted(() => ({ armed: false, failAfter: 0, renames: 0, blockRm: true }));
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
      if (crash.armed && crash.blockRm) return;
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

/** Every `.pre-restore/<ts>-<uniq>-staging/` still on disk. */
function stagingDirs(): string[] {
  const preRestore = join(dataDir, '.pre-restore');
  if (!existsSync(preRestore)) return [];
  return readdirSync(preRestore).filter((name) => name.endsWith('-staging'));
}

const sentinelPath = (): string => join(dataDir, '.restore-in-progress');

/**
 * Plant a `.pre-restore/<name>/journal.jsonl` with exact bytes, the way a
 * killed process leaves one. Returns the directory's `dataDir`-relative name,
 * which is what a `begin` record has to agree with.
 */
function plantJournal(name: string, body: string): string {
  const dirRel = join('.pre-restore', name);
  mkdirSync(join(dataDir, dirRel), { recursive: true });
  writeFileSync(join(dataDir, dirRel, 'journal.jsonl'), body);
  return dirRel;
}

/** A pid that is certainly not running: a process spawned and waited on. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  if (child.pid === undefined) throw new Error('could not spawn a process to kill');
  return child.pid;
}

/** Plant a sentinel with an exact body and an exact age. */
function plantSentinel(body: string, ageMs: number): void {
  writeFileSync(sentinelPath(), body);
  const when = new Date(Date.now() - ageMs);
  utimesSync(sentinelPath(), when, when);
}

/**
 * A boot identity of the same SHAPE this machine writes, naming a different
 * boot. Built from the real one because the shape is platform-specific: a
 * `boot-id:` body means nothing to a machine that stamps `boot-epoch:`, and a
 * mismatched shape is deliberately read as "cannot prove a different boot".
 *
 * `null` where the platform has no boot identity at all — there the takeover
 * cannot be proven and the tests that need one do not apply.
 */
function foreignBootId(): string | null {
  const current = currentBootId();
  if (current === null) return null;
  if (current.startsWith('boot-id:')) return 'boot-id:00000000-0000-0000-0000-000000000000';
  const [kind = '', value = ''] = current.split(':');
  return `${kind}:${Number(value) - 24 * 60 * 60}`;
}

/** The state a crashed restore leaves: a sentinel nothing will ever release. */
function plantStaleSentinel(): void {
  writeFileSync(sentinelPath(), '424242 crashed\n');
  const past = new Date(Date.now() - 6 * 60 * 60 * 1000);
  utimesSync(sentinelPath(), past, past);
}

/**
 * A sentinel that refuses: fresh, and naming a process that is really there.
 * This is what an operator meets when they retry while a restore is running —
 * and, before the pid was read, what a killed restore's leftover looked like
 * for an hour.
 */
function plantFreshSentinel(): void {
  writeFileSync(sentinelPath(), `${process.pid} restoring\n`);
}

/** Crash an install after `failAfter` renames have gone through. */
async function crashInstall(failAfter: number, blockRm = true): Promise<unknown> {
  crash.armed = true;
  crash.failAfter = failAfter;
  crash.renames = 0;
  crash.blockRm = blockRm;
  const err = await restoreBackup({ dataDir, archivePath: out, force: true }).catch(
    (e: unknown) => e,
  );
  crash.armed = false;
  crash.blockRm = true;
  return err;
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
  crash.blockRm = true;
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

  it('recovers when the operator deletes the sentinel and retries — the path they are told to take', async () => {
    for (const [rel, text] of Object.entries(V2)) write(rel, text);

    const err = await crashInstall(4);
    expect(err).toBeInstanceOf(Error);
    expect(journals()).toHaveLength(1);
    expect(readTree()).not.toEqual(V2);

    // The dead restore's sentinel, still well inside the stale hour, so the
    // takeover branch is not reachable at all.
    plantFreshSentinel();
    const refusal = await restoreBackup({ dataDir, archivePath: out, force: true }).catch(
      (e: unknown) => e,
    );
    expect(refusal).toBeInstanceOf(EthosError);
    if (!(refusal instanceof EthosError)) return;
    expect(refusal.message).toMatch(/Another restore is already running/);
    expect(refusal.action).toMatch(/\.restore-in-progress/);

    // The operator does exactly what that action says.
    rmSync(sentinelPath());

    // The retry now claims the directory on the FIRST attempt — no stale
    // sentinel, nothing to take over — and must still find the journal.
    const held = holdDatabase();
    try {
      await expect(restoreBackup({ dataDir, archivePath: out })).rejects.toThrow(/in use/);
    } finally {
      held.close();
    }

    expect(readTree()).toEqual(V2);
    expect(journals()).toEqual([]);
  });

  // The crashed restore releases its own sentinel on the way out (`unlinkSync`,
  // which a kill would not run either), so this is the same discovery problem
  // with no sentinel involved at all — and three different crash points, since
  // one is not evidence that recovery is driven by the journal's contents.
  for (const failAfter of [1, 3, 6]) {
    it(`recovers a crash after ${failAfter} renames with no sentinel left behind`, async () => {
      for (const [rel, text] of Object.entries(V2)) write(rel, text);

      const err = await crashInstall(failAfter);
      expect(err).toBeInstanceOf(Error);
      expect(existsSync(sentinelPath())).toBe(false);
      expect(journals()).toHaveLength(1);

      const held = holdDatabase();
      try {
        await expect(restoreBackup({ dataDir, archivePath: out })).rejects.toThrow(/in use/);
      } finally {
        held.close();
      }

      expect(readTree()).toEqual(V2);
      expect(journals()).toEqual([]);
    });
  }

  it('cannot replay an abandoned journal over files a later restore does not cover', async () => {
    for (const [rel, text] of Object.entries(V2)) write(rel, text);

    const err = await crashInstall(4);
    expect(err).toBeInstanceOf(Error);
    // The premise: `skills/` is in the `state` scope, and the crash left it as
    // neither version. A restore of `identity` alone never writes to it, so
    // nothing but recovery can put it back.
    expect(readTree()['skills/pdf/SKILL.md']).not.toBe(V2['skills/pdf/SKILL.md']);

    const report = await restoreBackup({
      dataDir,
      archivePath: out,
      scopes: ['identity'],
      force: true,
    });
    expect(report.restored).toContain('config.yaml');
    expect(report.restored).not.toContain('skills/pdf/SKILL.md');

    // `skills/` is exactly as the operator had it — recovered, then left alone.
    // The two `identity` files are the archive's, because this restore covered
    // them.
    expect(readTree()).toEqual({
      'config.yaml': V1['config.yaml'],
      'MEMORY.md': V1['MEMORY.md'],
      'skills/pdf/SKILL.md': V2['skills/pdf/SKILL.md'],
    });
    // And the record is spent, so no restore weeks from now can replay it.
    expect(journals()).toEqual([]);
  });

  it('keeps the journal when the rollback fails, and the next restore uses it', async () => {
    for (const [rel, text] of Object.entries(V2)) write(rel, text);

    // Not a kill: `rmSync` works, so the install phase's own `finally` runs and
    // decides for itself whether the record survives. Every rename past the
    // fourth throws, which is what the rollback needs to make.
    const err = await crashInstall(4, false);
    expect(err).toBeInstanceOf(EthosError);
    if (!(err instanceof EthosError)) return;
    expect(err.message).toMatch(/HALF-RESTORED/);
    expect(err.details).toMatchObject({ rolledBack: false });

    const [journal] = journals();
    expect(journal?.records[0]).toMatchObject({ op: 'begin' });

    const held = holdDatabase();
    try {
      await expect(restoreBackup({ dataDir, archivePath: out })).rejects.toThrow(/in use/);
    } finally {
      held.close();
    }

    expect(readTree()).toEqual(V2);
    expect(journals()).toEqual([]);
  });

  it('reclaims the staging tree a killed restore abandoned', async () => {
    for (const [rel, text] of Object.entries(V2)) write(rel, text);

    const err = await crashInstall(4);
    expect(err).toBeInstanceOf(Error);
    // A full extracted copy of the archive — conversation history included —
    // that nothing used to reclaim.
    expect(stagingDirs()).toHaveLength(1);

    const held = holdDatabase();
    try {
      await expect(restoreBackup({ dataDir, archivePath: out })).rejects.toThrow(/in use/);
    } finally {
      held.close();
    }

    expect(stagingDirs()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // A journal that says nothing must not brick the data directory
  //
  // `openJournal` creates the file with `wx` and fsyncs `begin` into it a moment
  // later, so a kill in between leaves an empty journal — and a power cut can
  // tear the very line it was writing. Every record is fsynced BEFORE the rename
  // it describes, so either file names no rename and describes none. Refusing
  // them was survivable while only a stale takeover read journals; now that
  // every restore does, it would lock the data directory permanently over a
  // record that says nothing happened.
  // -------------------------------------------------------------------------

  it('recovers from a zero-length journal and lets the restore proceed', async () => {
    plantJournal('2020-01-01T00-00-00-aaa', '');

    const report = await restoreBackup({ dataDir, archivePath: out, force: true });

    expect(report.restored).toContain('config.yaml');
    expect(journals()).toEqual([]);
  });

  it('recovers from a journal holding only a torn partial line', async () => {
    plantJournal('2020-01-01T00-00-00-bbb', '{"op":"beg');

    const report = await restoreBackup({ dataDir, archivePath: out, force: true });

    expect(report.restored).toContain('config.yaml');
    expect(journals()).toEqual([]);
  });

  it('drops a torn FINAL line and still rolls back the records before it', async () => {
    // What a power cut mid-write leaves: a good `begin`, a good `displace`, and
    // the record it was fsyncing when the lights went out.
    const dirRel = plantJournal(
      '2020-01-01T00-00-00-ccc',
      `${JSON.stringify({ op: 'begin', dir: join('.pre-restore', '2020-01-01T00-00-00-ccc') })}\n${JSON.stringify({ op: 'displace', rel: 'MEMORY.md' })}\n{"op":"inst`,
    );
    // The recovery copy that `displace` moved aside, and the half-restored file
    // sitting at the live name.
    writeFileSync(join(dataDir, dirRel, 'MEMORY.md'), V2['MEMORY.md']);
    write('MEMORY.md', '# neither version\n');

    const held = holdDatabase();
    try {
      await expect(restoreBackup({ dataDir, archivePath: out })).rejects.toThrow(/in use/);
    } finally {
      held.close();
    }

    expect(readFileSync(join(dataDir, 'MEMORY.md'), 'utf8')).toBe(V2['MEMORY.md']);
    expect(journals()).toEqual([]);
  });

  it('still refuses a journal whose begin names another directory', async () => {
    // Not tornness — a journal in the wrong place. Replaying it would move some
    // other restore's copies over this tree.
    plantJournal(
      '2020-01-01T00-00-00-ddd',
      `${JSON.stringify({ op: 'begin', dir: join('.pre-restore', 'somewhere-else') })}\n`,
    );

    const err = await restoreBackup({ dataDir, archivePath: out, force: true }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EthosError);
    if (!(err instanceof EthosError)) return;
    expect(err.code).toBe('IMPORT_BLOCKED');
    expect(err.message).toMatch(/belongs to/);
    // Refused, and the evidence kept: nothing restored on top of it.
    expect(journals()).toHaveLength(1);
    expect(readFileSync(join(dataDir, 'config.yaml'), 'utf8')).toBe(V1['config.yaml']);
  });

  it('refuses a journal with several lines and nothing usable in any of them', async () => {
    // Only the LAST write can be torn. Several unreadable lines is corruption
    // or a foreign writer, and is not something to delete and carry on from.
    const dirRel = plantJournal('2020-01-01T00-00-00-eee', 'garbage\nmore garbage\n');

    await expect(restoreBackup({ dataDir, archivePath: out, force: true })).rejects.toThrow(
      /unusable/,
    );
    // Kept: `journals()` cannot parse it, which is the point.
    expect(existsSync(join(dataDir, dirRel, 'journal.jsonl'))).toBe(true);
  });

  it('refuses a journal whose unreadable record is not its last line', async () => {
    // The middle-of-the-journal case, which dropping unparseable lines got
    // silently wrong: a good `begin`, a record nothing can read, and a good
    // `displace` after it. Replaying only what parses rolls SOME of the dead
    // restore back and then deletes the journal — so the move the unreadable
    // line named is never undone and nothing on disk records that it happened.
    const name = '2020-01-01T00-00-00-fff';
    const dirRel = plantJournal(
      name,
      `${JSON.stringify({ op: 'begin', dir: join('.pre-restore', name) })}\n` +
        '{"op":"displ\n' +
        `${JSON.stringify({ op: 'displace', rel: 'MEMORY.md' })}\n`,
    );
    // What that readable `displace` would replay: a recovery copy waiting to be
    // moved back over a half-restored live file.
    writeFileSync(join(dataDir, dirRel, 'MEMORY.md'), V2['MEMORY.md']);
    write('MEMORY.md', '# neither version\n');

    const err = await restoreBackup({ dataDir, archivePath: out, force: true }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EthosError);
    if (!(err instanceof EthosError)) return;
    expect(err.code).toBe('IMPORT_BLOCKED');
    expect(err.message).toMatch(/unusable/);

    // Nothing replayed, and the evidence kept: the copy is where the dead
    // restore left it and the journal is still there to be read by hand.
    expect(readFileSync(join(dataDir, dirRel, 'MEMORY.md'), 'utf8')).toBe(V2['MEMORY.md']);
    expect(readFileSync(join(dataDir, 'MEMORY.md'), 'utf8')).toBe('# neither version\n');
    expect(existsSync(join(dataDir, dirRel, 'journal.jsonl'))).toBe(true);
  });

  it('refuses a journal with a BLANK interior line, and replays nothing', async () => {
    // The same middle-of-the-journal case, in the shape that survived the first
    // fix: the positional rule was applied to a list with the empty lines
    // already filtered OUT, so a blank line in the middle shifted every record
    // after it down one and the journal read as "valid begin, valid displace".
    // It replayed, then deleted the only record of what it had not replayed.
    // `record()` writes `JSON.stringify(entry)` and a newline, so it cannot
    // produce a blank line at all: one in the middle is corruption, and the
    // interior rule has to see it there.
    const name = '2020-01-01T00-00-00-ggg';
    const dirRel = plantJournal(
      name,
      `${JSON.stringify({ op: 'begin', dir: join('.pre-restore', name) })}\n` +
        '\n' +
        `${JSON.stringify({ op: 'displace', rel: 'MEMORY.md' })}\n`,
    );
    writeFileSync(join(dataDir, dirRel, 'MEMORY.md'), V2['MEMORY.md']);
    write('MEMORY.md', '# neither version\n');

    const err = await restoreBackup({ dataDir, archivePath: out, force: true }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EthosError);
    if (!(err instanceof EthosError)) return;
    expect(err.code).toBe('IMPORT_BLOCKED');
    expect(err.message).toMatch(/unusable/);

    // Nothing replayed, and the evidence kept.
    expect(readFileSync(join(dataDir, dirRel, 'MEMORY.md'), 'utf8')).toBe(V2['MEMORY.md']);
    expect(readFileSync(join(dataDir, 'MEMORY.md'), 'utf8')).toBe('# neither version\n');
    expect(existsSync(join(dataDir, dirRel, 'journal.jsonl'))).toBe(true);
  });

  it('still replays a journal whose every line is terminated, as the writer leaves it', async () => {
    // The other side of the position rule: stripping the terminal delimiter is
    // not the same as filtering empties, and a normal journal — every record
    // written by `record()`, trailing newline and all — must still roll back.
    const name = '2020-01-01T00-00-00-hhh';
    const dirRel = plantJournal(
      name,
      `${JSON.stringify({ op: 'begin', dir: join('.pre-restore', name) })}\n` +
        `${JSON.stringify({ op: 'displace', rel: 'MEMORY.md' })}\n`,
    );
    writeFileSync(join(dataDir, dirRel, 'MEMORY.md'), V2['MEMORY.md']);
    write('MEMORY.md', '# neither version\n');

    const held = holdDatabase();
    try {
      await expect(restoreBackup({ dataDir, archivePath: out })).rejects.toThrow(/in use/);
    } finally {
      held.close();
    }

    expect(readFileSync(join(dataDir, 'MEMORY.md'), 'utf8')).toBe(V2['MEMORY.md']);
    expect(journals()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The sentinel is judged by the process it names, not by the clock
  //
  // A one-hour wall clock was a nuisance while a mistaken takeover only meant a
  // concurrent restore. Now the taker-over replays the live restore's journal —
  // rolling back renames it is still making — so a large archive on slow
  // storage overrunning the hour is a data-loss path.
  // -------------------------------------------------------------------------

  it('does not take a sentinel over while the process holding it is alive', async () => {
    plantSentinel(`${process.pid} restoring\n`, 6 * 60 * 60 * 1000);

    const err = await restoreBackup({ dataDir, archivePath: out, force: true }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EthosError);
    if (!(err instanceof EthosError)) return;
    expect(err.message).toMatch(/Another restore is already running/);
    expect(err.details).toMatchObject({ pid: process.pid });
    // Six hours past the old rule, and the holder's file is left alone.
    expect(existsSync(sentinelPath())).toBe(true);
    expect(readTree()).toEqual(V1);
  });

  it('takes a sentinel over at once when the process holding it is gone', async () => {
    plantSentinel(`${deadPid()} restoring\n`, 0);

    const report = await restoreBackup({ dataDir, archivePath: out, force: true });

    // No waiting out an hour for an answer the pid already gave.
    expect(report.restored).toContain('config.yaml');
    expect(existsSync(sentinelPath())).toBe(false);
  });

  it('never takes a live pid over, however implausibly old the sentinel is', async () => {
    // This replaces a test that asserted the opposite: past a 24-hour bound a
    // sentinel used to be taken over whatever its pid said. That bound was a
    // guess about "too long", and being wrong about it means replaying a
    // RUNNING restore's journal — rolling back renames it is still making. The
    // recycled pid it was there for is answered by boot identity below instead.
    plantSentinel(`${process.pid} restoring ${currentBootId() ?? ''}\n`, 48 * 60 * 60 * 1000);

    const err = await restoreBackup({ dataDir, archivePath: out, force: true }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EthosError);
    if (!(err instanceof EthosError)) return;
    expect(err.message).toMatch(/Another restore is already running/);
    // The refusal is now the operator's only way out, so it has to carry the
    // whole recovery: which process, how to check it, and what it costs to be
    // wrong about it.
    expect(err.action).toMatch(new RegExp(`ps -p ${process.pid}`));
    expect(err.action).toMatch(/\.restore-in-progress/);
    expect(existsSync(sentinelPath())).toBe(true);
    expect(readTree()).toEqual(V1);
  });

  it.skipIf(foreignBootId() === null)(
    'takes a sentinel over when its pid belongs to an earlier boot',
    async () => {
      // The recycled-pid case, settled by identity rather than by a clock: the
      // pid is this very worker and provably alive, but the sentinel says it was
      // written before the machine rebooted, so it cannot be the same process.
      plantSentinel(`${process.pid} restoring ${foreignBootId() ?? ''}\n`, 0);

      const report = await restoreBackup({ dataDir, archivePath: out, force: true });

      expect(report.restored).toContain('config.yaml');
      expect(existsSync(sentinelPath())).toBe(false);
    },
  );

  it('holds against a sentinel from this boot even when it is fresh', async () => {
    // The other half: same live pid, same boot — held, and the file untouched.
    plantSentinel(`${process.pid} restoring ${currentBootId() ?? ''}\n`, 0);

    await expect(restoreBackup({ dataDir, archivePath: out, force: true })).rejects.toThrow(
      /Another restore is already running/,
    );
    expect(existsSync(sentinelPath())).toBe(true);
  });

  it('falls back to the clock when the sentinel carries no readable pid', async () => {
    plantSentinel('written by something else\n', 0);
    await expect(restoreBackup({ dataDir, archivePath: out, force: true })).rejects.toThrow(
      /Another restore is already running/,
    );

    plantSentinel('written by something else\n', 6 * 60 * 60 * 1000);
    const report = await restoreBackup({ dataDir, archivePath: out, force: true });
    expect(report.restored).toContain('config.yaml');
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
