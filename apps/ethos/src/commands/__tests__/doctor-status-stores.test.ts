// The store-health half of `ethos doctor` and the two `ethos status` facts that
// were wrong or missing (plan/phases/agent-state-backup.md §3–§4).

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '@ethosagent/sqlite';
import { WAL_STORES } from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkDatabaseIntegrity,
  checkSecretsDirMode,
  checkSkillsDir,
  checkTeamsDir,
  computeDoctorExit,
  describeSecretsDirMode,
} from '../doctor';
import { backupDir, countCronJobs, lastBackup } from '../status';

let stateDir: string;
let prevStateDir: string | undefined;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'ethos-doctor-stores-'));
  prevStateDir = process.env.ETHOS_STATE_DIR;
  process.env.ETHOS_STATE_DIR = stateDir;
});

afterEach(async () => {
  if (prevStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
  else process.env.ETHOS_STATE_DIR = prevStateDir;
  await rm(stateDir, { recursive: true, force: true });
});

function makeDb(path: string): void {
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE t (a TEXT)');
  db.prepare('INSERT INTO t (a) VALUES (?)').run('x');
  db.close();
}

describe('doctor — PRAGMA integrity_check per store', () => {
  it('reports every registered store, absent ones included', async () => {
    const results = await checkDatabaseIntegrity(stateDir);
    const registered = new Set(WAL_STORES.map((s) => s.database).filter((d) => !d.includes('*')));
    for (const database of registered) {
      expect(results.map((r) => r.database)).toContain(database);
    }
    expect(results.every((r) => r.status === 'absent')).toBe(true);
  });

  it('passes a healthy database', async () => {
    makeDb(join(stateDir, 'sessions.db'));
    const results = await checkDatabaseIntegrity(stateDir);
    expect(results.find((r) => r.database === 'sessions.db')).toEqual({
      database: 'sessions.db',
      status: 'ok',
    });
  });

  it('fails a database that is not one', async () => {
    await writeFile(join(stateDir, 'goals.db'), 'this is not a SQLite file');
    const results = await checkDatabaseIntegrity(stateDir);
    const row = results.find((r) => r.database === 'goals.db');
    expect(row?.status).toBe('failed');
    expect(row?.detail).toBeTruthy();
  });

  it('expands the per-team board pattern from the registry, not a hardcoded name', async () => {
    await mkdir(join(stateDir, 'teams', 'atlas'), { recursive: true });
    makeDb(join(stateDir, 'teams', 'atlas', 'board.db'));
    const results = await checkDatabaseIntegrity(stateDir);
    expect(results.find((r) => r.database === 'teams/atlas/board.db')?.status).toBe('ok');
  });

  it('reports a pattern directory it cannot enumerate instead of dropping it', async () => {
    // `teams/` exists but is not a directory: `readdir` fails with ENOTDIR, so
    // the per-team boards cannot be listed. "I could not look" must not be
    // reported as "there is nothing there" — a diagnostic that hides the
    // stores it failed to reach lets `doctor` pass without checking them.
    await writeFile(join(stateDir, 'teams'), 'not a directory');
    const results = await checkDatabaseIntegrity(stateDir);
    const row = results.find((r) => r.database.includes('teams/*'));
    expect(row?.status).toBe('failed');
    expect(row?.detail).toContain('ENOTDIR');
    // And it counts toward the exit code, like any other integrity failure.
    expect(results.some((r) => r.status === 'failed')).toBe(true);
  });

  it('still expands a genuinely absent directory to nothing', async () => {
    const results = await checkDatabaseIntegrity(stateDir);
    expect(results.some((r) => r.database.includes('*'))).toBe(false);
  });

  it('makes an integrity failure a hard exit', () => {
    const base = {
      coreFailure: false,
      configuredMissing: false,
      awsFailed: false,
      requiredSecretMissing: false,
      dbUnopenable: false,
      gatewayStale: false,
      channelRejected: false,
      channelUnreachable: false,
    };
    expect(computeDoctorExit(base)).toBe(0);
    expect(computeDoctorExit({ ...base, dbIntegrityFailed: true })).toBe(1);
    expect(computeDoctorExit({ ...base, secretsDirTooOpen: true })).toBe(1);
  });
});

describe('doctor — secrets/ mode', () => {
  it('is silent when the vault does not exist yet', () => {
    expect(checkSecretsDirMode(stateDir)).toMatchObject({ present: false, tooOpen: false });
  });

  it('accepts 0700', async () => {
    await mkdir(join(stateDir, 'secrets'), { recursive: true, mode: 0o700 });
    await chmod(join(stateDir, 'secrets'), 0o700);
    expect(checkSecretsDirMode(stateDir)).toMatchObject({ mode: '700', tooOpen: false });
  });

  it('flags a vault group or other can reach', async () => {
    await mkdir(join(stateDir, 'secrets'), { recursive: true });
    await chmod(join(stateDir, 'secrets'), 0o755);
    expect(checkSecretsDirMode(stateDir)).toMatchObject({ mode: '755', tooOpen: true });
  });

  it('does not flag a mode that is TIGHTER than 0700', async () => {
    await mkdir(join(stateDir, 'secrets'), { recursive: true });
    await chmod(join(stateDir, 'secrets'), 0o500);
    expect(checkSecretsDirMode(stateDir).tooOpen).toBe(false);
  });
});

describe('doctor — the mode line', () => {
  it('names the mode it actually read, not a constant 0700', async () => {
    await mkdir(join(stateDir, 'secrets'), { recursive: true });
    await chmod(join(stateDir, 'secrets'), 0o500);
    const line = describeSecretsDirMode(checkSecretsDirMode(stateDir));
    expect(line).toContain('500');
    expect(line).toContain('owner only');
    expect(line).not.toContain('700');
  });

  it('says 700 when the mode is 700', async () => {
    await mkdir(join(stateDir, 'secrets'), { recursive: true });
    await chmod(join(stateDir, 'secrets'), 0o700);
    expect(describeSecretsDirMode(checkSecretsDirMode(stateDir))).toBe(
      'secrets/ is mode 700 (owner only)',
    );
  });
});

describe('doctor — skills/ and teams/ sanity', () => {
  it('accepts both skill layouts', async () => {
    await mkdir(join(stateDir, 'skills', 'greet'), { recursive: true });
    await writeFile(join(stateDir, 'skills', 'greet', 'SKILL.md'), 'name: greet\n');
    await mkdir(join(stateDir, 'skills', 'scope', 'nested'), { recursive: true });
    await writeFile(join(stateDir, 'skills', 'scope', 'nested', 'SKILL.md'), 'name: nested\n');
    expect(checkSkillsDir(stateDir)).toEqual([]);
  });

  it('names a skill directory with no SKILL.md anywhere', async () => {
    await mkdir(join(stateDir, 'skills', 'broken'), { recursive: true });
    const issues = checkSkillsDir(stateDir);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('skills/broken');
  });

  it('names a team data directory with no manifest beside it', async () => {
    await mkdir(join(stateDir, 'teams', 'atlas'), { recursive: true });
    await mkdir(join(stateDir, 'teams', 'orphan'), { recursive: true });
    await writeFile(join(stateDir, 'teams', 'atlas.yaml'), 'name: atlas\n');
    const issues = checkTeamsDir(stateDir);
    expect(issues.map((i) => i.path)).toEqual(['teams/orphan']);
  });
});

describe('status — cron store', () => {
  it('reports the store as absent when there is none (never `jobs.db`)', () => {
    expect(countCronJobs()).toEqual({ status: 'absent' });
  });

  it('counts jobs in cron/jobs.json, the file the scheduler actually writes', async () => {
    await mkdir(join(stateDir, 'cron'), { recursive: true });
    await writeFile(
      join(stateDir, 'cron', 'jobs.json'),
      JSON.stringify([{ id: 'a' }, { id: 'b', enabled: false }, { id: 'c', enabled: true }]),
    );
    expect(countCronJobs()).toEqual({ status: 'ok', total: 3, enabled: 2 });
  });

  it('reports a malformed store as unknown, not as zero jobs', async () => {
    await mkdir(join(stateDir, 'cron'), { recursive: true });
    await writeFile(join(stateDir, 'cron', 'jobs.json'), 'not json');
    const state = countCronJobs();
    // Still does not throw — but `0 jobs` is a confident false statement about
    // a store nothing could read.
    expect(state.status).toBe('unreadable');
    expect(state).not.toMatchObject({ total: 0 });
  });

  it('reports a store that parses but is not a job list as unknown too', async () => {
    await mkdir(join(stateDir, 'cron'), { recursive: true });
    await writeFile(join(stateDir, 'cron', 'jobs.json'), '{"jobs":[]}');
    expect(countCronJobs().status).toBe('unreadable');
  });

  it('ignores a jobs.db, which nothing in the repo writes', async () => {
    await mkdir(join(stateDir, 'cron'), { recursive: true });
    await writeFile(join(stateDir, 'cron', 'jobs.db'), 'x');
    expect(countCronJobs()).toEqual({ status: 'absent' });
  });
});

describe('status — last backup', () => {
  it('reports none before the first backup', () => {
    expect(backupDir()).toBe(join(stateDir, 'backups'));
    expect(lastBackup()).toBeNull();
  });

  it('picks the newest archive and counts what is kept', async () => {
    await mkdir(backupDir(), { recursive: true });
    await writeFile(join(backupDir(), 'older.tar.gz'), 'a');
    await writeFile(join(backupDir(), 'newer.tar.gz'), 'bb');
    const { utimes } = await import('node:fs/promises');
    await utimes(join(backupDir(), 'older.tar.gz'), new Date(1000), new Date(1000));
    const last = lastBackup();
    expect(last?.name).toBe('newer.tar.gz');
    expect(last?.count).toBe(2);
    expect(last?.size).toBe(2);
  });

  it('ignores files that are not archives', async () => {
    await mkdir(backupDir(), { recursive: true });
    await writeFile(join(backupDir(), '.lock'), '');
    expect(lastBackup()).toBeNull();
  });
});
