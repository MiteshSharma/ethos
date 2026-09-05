// The scheduled backup: settings resolution, the `.lock` sentinel, rotation.
//
// Rotation deletes files, so most of what is asserted here is what it must NOT
// delete. A backup directory is a place operators park things.

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
import { basename, join } from 'node:path';
import type { EthosConfig } from '@ethosagent/config';
import Database from '@ethosagent/sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentBootId } from '../backup/holder-identity';
import {
  acquireBackupLock,
  backupLockPath,
  DEFAULT_BACKUP_CRON,
  DEFAULT_BACKUP_KEEP,
  resolveBackupSettings,
  rotateBackups,
  runScheduledBackup,
  SCHEDULED_ARCHIVE_RE,
  scheduledArchiveName,
  summarizeScheduledBackup,
} from '../backup-schedule';

let root: string;
let dataDir: string;
let dir: string;
const storage = new FsStorage();
let priorStateDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ethos-backup-sched-'));
  dataDir = join(root, 'ethos');
  dir = join(root, 'backups');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  priorStateDir = process.env.ETHOS_STATE_DIR;
  process.env.ETHOS_STATE_DIR = dataDir;
});

afterEach(() => {
  if (priorStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
  else process.env.ETHOS_STATE_DIR = priorStateDir;
  rmSync(root, { recursive: true, force: true });
});

function makeConfig(over: Partial<EthosConfig> = {}): EthosConfig {
  return { provider: 'anthropic', model: 'm', apiKey: 'sk', personality: 'researcher', ...over };
}

/**
 * A boot identity of the same SHAPE this machine writes, naming a different
 * boot. Built from the real one because the shape is platform-specific, and a
 * mismatched shape is deliberately read as "cannot prove a different boot".
 * `null` where the platform has no boot identity at all.
 */
function foreignBootId(): string | null {
  const current = currentBootId();
  if (current === null) return null;
  if (current.startsWith('boot-id:')) return 'boot-id:00000000-0000-0000-0000-000000000000';
  const [kind = '', value = ''] = current.split(':');
  return `${kind}:${Number(value) - 24 * 60 * 60}`;
}

/** A pid that is definitely not running, so a lock naming it is provably stale. */
function deadPid(): number {
  for (let p = 4_000_000; p > 100_000; p -= 7919) {
    try {
      process.kill(p, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return p;
    }
  }
  throw new Error('could not find a dead pid');
}

function archive(name: string): void {
  writeFileSync(join(dir, name), 'not really a tarball');
}

function names(): string[] {
  return readdirSync(dir).sort();
}

// ---------------------------------------------------------------------------

describe('resolveBackupSettings', () => {
  it('defaults everything when no backup.* key is set', () => {
    const s = resolveBackupSettings(makeConfig());
    expect(s).toEqual({
      enabled: true,
      cron: DEFAULT_BACKUP_CRON,
      scopes: ['identity', 'state'],
      keep: DEFAULT_BACKUP_KEEP,
      dir: join(dataDir, 'backups'),
    });
  });

  it('takes the operator values when set', () => {
    const s = resolveBackupSettings(
      makeConfig({
        backup: {
          enabled: false,
          cron: '15 1 * * *',
          scope: ['identity'],
          keep: 2,
          dir: '/mnt/snapshots',
        },
      }),
    );
    expect(s).toEqual({
      enabled: false,
      cron: '15 1 * * *',
      scopes: ['identity'],
      keep: 2,
      dir: '/mnt/snapshots',
    });
  });

  it('resolves a relative backup.dir under the data dir, not the process cwd', () => {
    const s = resolveBackupSettings(makeConfig({ backup: { dir: 'snapshots' } }));
    expect(s.dir).toBe(join(dataDir, 'snapshots'));
  });

  it('refuses an unknown scope name, and says which one', () => {
    expect(() =>
      resolveBackupSettings(makeConfig({ backup: { scope: ['identity', 'nonsense'] } })),
    ).toThrow(/nonsense/);
  });
});

// ---------------------------------------------------------------------------

describe('rotateBackups', () => {
  it('keeps exactly `keep` archives and deletes the oldest first', async () => {
    for (const day of ['01', '02', '03', '04', '05']) {
      archive(`ethos-scheduled-2026-09-${day}T04-00-00Z.tar.gz`);
    }
    const removed = await rotateBackups(storage, dir, 2);
    expect(removed).toEqual([
      'ethos-scheduled-2026-09-01T04-00-00Z.tar.gz',
      'ethos-scheduled-2026-09-02T04-00-00Z.tar.gz',
      'ethos-scheduled-2026-09-03T04-00-00Z.tar.gz',
    ]);
    expect(names()).toEqual([
      'ethos-scheduled-2026-09-04T04-00-00Z.tar.gz',
      'ethos-scheduled-2026-09-05T04-00-00Z.tar.gz',
    ]);
  });

  it('deletes nothing it did not create', async () => {
    archive('ethos-scheduled-2026-09-01T04-00-00Z.tar.gz');
    archive('ethos-scheduled-2026-09-02T04-00-00Z.tar.gz');
    // A manual `ethos backup` archive, a hand-named copy, an unrelated tarball,
    // and the sentinel itself: all `*.tar.gz`-adjacent, none of them ours.
    archive('ethos-backup-2026-09-01T04-00-00-a1b2c3d4.tar.gz');
    archive('before-upgrade.tar.gz');
    archive('ethos-scheduled-manual.tar.gz');
    archive('ethos-scheduled-2026-09-01T04-00-00Z.tar.gz.bak');
    // And two that sit against the uniqueness suffix specifically: a word where
    // the hex goes, and hex of the wrong length. The suffix widened the shape
    // rotation accepts, so it has to be as literal as the timestamp is.
    archive('ethos-scheduled-2026-09-01T04-00-00Z-final.tar.gz');
    archive('ethos-scheduled-2026-09-01T04-00-00Z-a1b2c3d4e5.tar.gz');
    writeFileSync(backupLockPath(dir), '');
    mkdirSync(join(dir, 'ethos-scheduled-2026-01-01T00-00-00Z.tar.gz-dir'));

    const removed = await rotateBackups(storage, dir, 1);
    expect(removed).toEqual(['ethos-scheduled-2026-09-01T04-00-00Z.tar.gz']);
    expect(names()).toEqual([
      '.lock',
      'before-upgrade.tar.gz',
      'ethos-backup-2026-09-01T04-00-00-a1b2c3d4.tar.gz',
      'ethos-scheduled-2026-01-01T00-00-00Z.tar.gz-dir',
      'ethos-scheduled-2026-09-01T04-00-00Z-a1b2c3d4e5.tar.gz',
      'ethos-scheduled-2026-09-01T04-00-00Z-final.tar.gz',
      'ethos-scheduled-2026-09-01T04-00-00Z.tar.gz.bak',
      'ethos-scheduled-2026-09-02T04-00-00Z.tar.gz',
      'ethos-scheduled-manual.tar.gz',
    ]);
  });

  it('is a no-op when there are fewer archives than the limit', async () => {
    archive('ethos-scheduled-2026-09-01T04-00-00Z.tar.gz');
    expect(await rotateBackups(storage, dir, 7)).toEqual([]);
    expect(names()).toHaveLength(1);
  });

  it('names an archive in the shape rotation recognises', async () => {
    const name = scheduledArchiveName(new Date('2026-09-04T04:00:00.000Z'));
    // The timestamp is still literal and still leads; the suffix follows it.
    // Asserted as a pattern rather than a constant because the suffix is random
    // — which is the whole point of it.
    expect(name).toMatch(/^ethos-scheduled-2026-09-04T04-00-00Z-[0-9a-f]{8}\.tar\.gz$/);
    expect(name).toMatch(SCHEDULED_ARCHIVE_RE);
    archive(name);
    expect(await rotateBackups(storage, dir, 0)).toEqual([]);
    expect(await rotateBackups(storage, dir, 1)).toEqual([]);
    archive(scheduledArchiveName(new Date('2026-09-05T04:00:00.000Z')));
    expect(await rotateBackups(storage, dir, 1)).toEqual([name]);
  });

  it('gives two names in the same second different suffixes', () => {
    const now = new Date('2026-09-04T04:00:00.000Z');
    expect(scheduledArchiveName(now)).not.toBe(scheduledArchiveName(now));
  });

  it('orders by the timestamp across a second boundary, whatever the suffixes', async () => {
    // The suffix must never get a vote on which archive is older. These two are
    // one second apart and their suffixes are the extremes of the hex range, so
    // a sort that reached the suffix at all would invert them and rotation
    // would delete the NEWER archive.
    const older = 'ethos-scheduled-2026-09-04T04-00-00Z-ffffffff.tar.gz';
    const newer = 'ethos-scheduled-2026-09-04T04-00-01Z-00000000.tar.gz';
    archive(newer);
    archive(older);
    expect(await rotateBackups(storage, dir, 1)).toEqual([older]);
    expect(names()).toEqual([newer]);
  });

  it('still rotates un-suffixed archives written before the suffix existed', async () => {
    // An upgraded deployment's backup directory holds both shapes. If rotation
    // stopped recognising the old one, the pre-upgrade set would sit there for
    // good — bounded, but never collected, and these are whole-state tarballs.
    archive('ethos-scheduled-2026-09-04T04-00-00Z.tar.gz');
    const suffixed = scheduledArchiveName(new Date('2026-09-05T04:00:00.000Z'));
    archive(suffixed);
    expect(await rotateBackups(storage, dir, 1)).toEqual([
      'ethos-scheduled-2026-09-04T04-00-00Z.tar.gz',
    ]);
    expect(names()).toEqual([suffixed]);
  });
});

// ---------------------------------------------------------------------------

describe('the .lock sentinel', () => {
  it('blocks a second backup while one is running', async () => {
    const release = await acquireBackupLock(dir);
    await expect(acquireBackupLock(dir, { timeoutMs: 50 })).rejects.toThrow(
      /another backup is already in progress/,
    );
    release();
    // And the directory is usable again once released.
    (await acquireBackupLock(dir, { timeoutMs: 50 }))();
    expect(names()).toEqual([]);
  });

  it('blocks a scheduled run while a manual backup holds the lock', async () => {
    const release = await acquireBackupLock(dir);
    await expect(
      runScheduledBackup({
        dataDir,
        settings: resolveBackupSettings(makeConfig({ backup: { dir } })),
        storage,
        lockTimeoutMs: 50,
      }),
    ).rejects.toThrow(/another backup is already in progress/);
    release();
  });

  it('reclaims a lock left behind by a killed process', async () => {
    writeFileSync(backupLockPath(dir), JSON.stringify({ pid: deadPid() }));
    const release = await acquireBackupLock(dir, { timeoutMs: 50 });
    release();
    expect(names()).toEqual([]);
  });

  it('reclaims an unreadable lock once it is older than the stale window', async () => {
    const lock = backupLockPath(dir);
    writeFileSync(lock, 'garbage, not json');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(lock, twoHoursAgo, twoHoursAgo);
    (await acquireBackupLock(dir, { timeoutMs: 50 }))();
    expect(names()).toEqual([]);
  });

  it('respects a fresh unreadable lock — age is the only signal left', async () => {
    writeFileSync(backupLockPath(dir), 'garbage, not json');
    await expect(acquireBackupLock(dir, { timeoutMs: 50 })).rejects.toThrow(/already in progress/);
  });

  // --- the recycled-pid guard: a live pid holds, but not forever -------------

  it('holds a lock naming a live pid well past the unreadable-lock clock', async () => {
    // `process.pid` is this very worker, so the holder is provably alive. Two
    // hours is past LOCK_STALE_MS and nowhere near the abandoned bound: the
    // clock must not get a vote while a pid answers the question.
    const lock = backupLockPath(dir);
    writeFileSync(lock, JSON.stringify({ token: 'live', pid: process.pid }));
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(lock, twoHoursAgo, twoHoursAgo);
    await expect(acquireBackupLock(dir, { timeoutMs: 50 })).rejects.toThrow(/already in progress/);
    expect(existsSync(lock)).toBe(true);
  });

  it('never reclaims a live pid, however old the lock is', async () => {
    // This replaces a test that asserted the opposite: past a 36-hour bound the
    // lock used to be taken over whatever its pid said. Being wrong about that
    // guess puts two writers on the same databases and two rotations deleting
    // against each other's archives. The recycled pid the bound existed for is
    // answered by boot identity below instead.
    const lock = backupLockPath(dir);
    writeFileSync(lock, JSON.stringify({ token: 'live', pid: process.pid, boot: currentBootId() }));
    const longAgo = new Date(Date.now() - 37 * 60 * 60 * 1000);
    utimesSync(lock, longAgo, longAgo);

    await expect(acquireBackupLock(dir, { timeoutMs: 50 })).rejects.toThrow(/already in progress/);
    expect(existsSync(lock)).toBe(true);
  });

  it.skipIf(foreignBootId() === null)(
    'reclaims a lock whose pid belongs to an earlier boot',
    async () => {
      // Power fails at 04:00 with the lock held, the box reboots, and the pid in
      // the body now belongs to something unrelated and alive — here, this
      // worker. The body says which boot wrote it, so the pid it names cannot be
      // the process holding the lock, whatever `kill(pid, 0)` answers.
      const lock = backupLockPath(dir);
      writeFileSync(
        lock,
        JSON.stringify({ token: 'recycled', pid: process.pid, boot: foreignBootId() }),
      );

      (await acquireBackupLock(dir, { timeoutMs: 50 }))();
      expect(names()).toEqual([]);
    },
  );

  it('tells the operator how to check the pid before clearing the lock', async () => {
    // Clearing the lock by hand is now the ONLY way past a live holder, so the
    // refusal has to say how to be sure it is safe.
    const release = await acquireBackupLock(dir);
    const err = await acquireBackupLock(dir, { timeoutMs: 50 }).catch((e: unknown) => e);
    release();
    expect(err).toBeInstanceOf(Error);
    if (!(err instanceof Error)) return;
    expect(err.message).toMatch(new RegExp(`ps -p ${process.pid}`));
    expect(err.message).toContain(backupLockPath(dir));
  });

  it('names the holding pid when it refuses', async () => {
    // "Is anything actually running?" has to be answerable from the message.
    const release = await acquireBackupLock(dir);
    await expect(acquireBackupLock(dir, { timeoutMs: 50 })).rejects.toThrow(
      new RegExp(`held by process ${process.pid}\\.`),
    );
    release();
  });

  // --- FIX B: the lock is owned, so no unlink is unconditional --------------

  it('stamps a unique token in the body, so two holds are never byte-equal', async () => {
    const release = await acquireBackupLock(dir);
    const first: unknown = JSON.parse(readFileSync(backupLockPath(dir), 'utf-8'));
    release();
    const release2 = await acquireBackupLock(dir);
    const second: unknown = JSON.parse(readFileSync(backupLockPath(dir), 'utf-8'));
    release2();

    const tokenOf = (body: unknown): unknown =>
      typeof body === 'object' && body !== null && 'token' in body
        ? (body as { token: unknown }).token
        : undefined;
    expect(typeof tokenOf(first)).toBe('string');
    expect(tokenOf(first)).not.toBe(tokenOf(second));
  });

  it('release does not delete a successor lock that replaced ours', async () => {
    const release = await acquireBackupLock(dir);
    // Our hold overran and was reclaimed as stale; the winner installed its own.
    const successor = JSON.stringify({ token: 'successor', pid: process.pid });
    writeFileSync(backupLockPath(dir), successor);

    release();

    // An unconditional unlink here frees a lock a live backup is holding, and
    // the next contender walks straight in beside it.
    expect(existsSync(backupLockPath(dir))).toBe(true);
    expect(readFileSync(backupLockPath(dir), 'utf-8')).toBe(successor);
  });

  it('takeover does not delete a lock that was replaced after we judged it stale', async () => {
    const lock = backupLockPath(dir);
    const gone = deadPid();
    writeFileSync(lock, JSON.stringify({ token: 'abandoned', pid: gone }));
    const successor = JSON.stringify({ token: 'successor', pid: process.pid });

    // The interleave: a peer contender classified the same abandoned lock as
    // stale one instant earlier and has already installed its own LIVE lock by
    // the time we finish classifying. Injected at the liveness probe because
    // that is exactly where the two contenders' windows overlap.
    let firstProbe = true;
    const probe = vi.spyOn(process, 'kill').mockImplementation((): true => {
      if (!firstProbe) return true;
      firstProbe = false;
      writeFileSync(lock, successor);
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    try {
      await expect(acquireBackupLock(dir, { timeoutMs: 50 })).rejects.toThrow(
        /already in progress/,
      );
      expect(readFileSync(lock, 'utf-8')).toBe(successor);
    } finally {
      probe.mockRestore();
    }
  });

  // --- FIX C: the compare is not the guarantee; the post-create confirm is ---
  //
  // The two tests below interleave a replacement into the window a byte
  // comparison cannot cover: AFTER the final ownership read, BEFORE the unlink.
  // `vi.spyOn` cannot reach it — a node builtin's ESM namespace is not
  // configurable, so patching `node:fs` in place throws — so each one runs
  // against a private copy of the module loaded under `vi.doMock`, which keeps
  // the mocked `node:fs` to the single test that asks for it.

  it('does not hand out a release closure for a lock a racing takeover unlinked', async () => {
    const lock = backupLockPath(dir);
    const successor = JSON.stringify({ token: 'successor', pid: process.pid });

    // The interleave, seen from the losing side: our exclusive create succeeds
    // — we won the atomic step — and a peer that had already judged the lock we
    // displaced as stale unlinks OURS and installs its own before we get to
    // look at what we created. Injected at `writeFileSync`, the only point
    // between the create and the confirmation read that this otherwise
    // synchronous stretch passes through.
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const real = await vi.importActual<typeof import('node:fs')>('node:fs');
      let raced = false;
      return {
        ...real,
        default: real,
        writeFileSync: (...args: Parameters<typeof real.writeFileSync>) => {
          real.writeFileSync(...args);
          if (raced) return;
          raced = true;
          real.unlinkSync(lock);
          real.writeFileSync(lock, successor);
        },
      };
    });

    try {
      const mod = await import('../backup-schedule');
      // Without the confirmation read this resolves, and the caller backs up
      // alongside the peer while holding a closure over the peer's file.
      await expect(mod.acquireBackupLock(dir, { timeoutMs: 50 })).rejects.toThrow(
        /already in progress/,
      );
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }

    // We walked away with nothing, and the peer's live lock is untouched.
    expect(readFileSync(lock, 'utf-8')).toBe(successor);
  });

  it('takeover still unlinks a lock installed after its final ownership read', async () => {
    // The residual, stated rather than papered over: `unlink` names a path, not
    // the inode that was read, so a replacement landing between the comparison
    // and the unlink is removed anyway. No ordering of reads closes this. What
    // saves the pair is the displaced peer's own post-create confirmation —
    // the test above — which is why that is the guarantee and this is not.
    const lock = backupLockPath(dir);
    writeFileSync(lock, JSON.stringify({ token: 'abandoned', pid: deadPid() }));
    const successor = JSON.stringify({ token: 'successor', pid: process.pid });

    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const real = await vi.importActual<typeof import('node:fs')>('node:fs');
      let raced = false;
      return {
        ...real,
        default: real,
        unlinkSync: (...args: Parameters<typeof real.unlinkSync>) => {
          if (!raced) {
            raced = true;
            // A peer took the abandoned lock over one instant ago and its live
            // lock is now at the path we are about to remove.
            real.writeFileSync(lock, successor);
          }
          real.unlinkSync(...args);
        },
      };
    });

    let heldBody = '';
    try {
      const mod = await import('../backup-schedule');
      const release = await mod.acquireBackupLock(dir, { timeoutMs: 50 });
      heldBody = readFileSync(lock, 'utf-8');
      release();
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }

    // We hold our OWN body — the `wx` create is what decided that, and our
    // confirmation read agreed. The successor's bytes are gone: the residual.
    expect(heldBody).not.toBe(successor);
    expect(heldBody).toContain(`"pid":${process.pid}`);
    expect(names()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('runScheduledBackup', () => {
  it('writes an archive, then rotates to `keep`', async () => {
    // A live WAL database with uncheckpointed rows — the case the async
    // `backup()` snapshot exists for.
    const db = new Database(join(dataDir, 'sessions.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 0');
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY) STRICT');
    db.prepare('INSERT INTO sessions VALUES (?)').run('s1');
    db.close();
    writeFileSync(join(dataDir, 'config.yaml'), 'provider: anthropic\n');

    for (const day of ['01', '02']) {
      archive(`ethos-scheduled-2026-09-${day}T04-00-00Z.tar.gz`);
    }

    const settings = resolveBackupSettings(makeConfig({ backup: { dir, keep: 2 } }));
    const result = await runScheduledBackup({ dataDir, settings, storage });

    expect(result.path).toMatch(/ethos-scheduled-.*\.tar\.gz$/);
    expect(result.fileCount).toBeGreaterThan(0);
    expect(result.scopes).toEqual(['identity', 'state']);
    expect(result.rotated).toEqual(['ethos-scheduled-2026-09-01T04-00-00Z.tar.gz']);
    expect(names()).toHaveLength(2);
    // The lock is released even on the happy path.
    expect(names()).not.toContain('.lock');
  });

  // A file the writer cannot encode is skipped rather than fatal. On the
  // scheduled path that trade is the whole risk: nobody is watching, `origin`
  // is unset so nothing is delivered, and `lastError` has no reader — the
  // persisted `cron/output/backup/<ts>.md` body is the only surface a skip can
  // reach. If it is not in the summary string, it is invisible forever.
  it('carries a skipped file into the summary the cron output file keeps', async () => {
    writeFileSync(join(dataDir, 'config.yaml'), 'provider: anthropic\n');
    mkdirSync(join(dataDir, 'skills', 'greet'), { recursive: true });
    // Legal on POSIX, a path separator to a Windows extractor — cannot round-trip.
    writeFileSync(join(dataDir, 'skills', 'greet', 'back\\slash.md'), 'nope\n');

    const settings = resolveBackupSettings(makeConfig({ backup: { dir } }));
    const result = await runScheduledBackup({ dataDir, settings, storage });

    expect(result.skippedFiles).toEqual([
      {
        path: 'skills/greet/back\\slash.md',
        reason:
          'the name holds a backslash, which a restore must refuse as a Windows path separator',
      },
    ]);

    const summary = summarizeScheduledBackup(result);
    // Not a failure — the archive is real and named. But the first line must
    // stop it reading as a clean run, and the file must be named with its reason.
    expect(summary).toContain('Backup INCOMPLETE — 1 file(s) could not be archived');
    expect(summary).toContain(`Backup written to ${result.path}`);
    expect(summary).toContain(
      '⚠ skills/greet/back\\slash.md — the name holds a backslash, which a restore must refuse as a Windows path separator',
    );
  });

  it('says nothing about skips when there were none', async () => {
    writeFileSync(join(dataDir, 'config.yaml'), 'provider: anthropic\n');
    const settings = resolveBackupSettings(makeConfig({ backup: { dir } }));
    const result = await runScheduledBackup({ dataDir, settings, storage });

    expect(result.skippedFiles).toEqual([]);
    const summary = summarizeScheduledBackup(result);
    expect(summary).toBe(
      `Backup written to ${result.path} (${result.fileCount} files, ${result.bytes} bytes, scopes: identity+state)`,
    );
    expect(summary).not.toContain('INCOMPLETE');
  });

  it('writes two archives when two runs land in the same second', async () => {
    // The collision this suffix exists for: two schedulers sharing one backup
    // directory — `ethos serve` and `ethos gateway` on one machine, both
    // ticking at 04:00 — where the second takes the `.lock` inside the same
    // second the first released it. The name is computed after the lock, so
    // the lock does not separate them; only the name does. `now` is pinned to
    // one instant to make that second deterministic.
    writeFileSync(join(dataDir, 'config.yaml'), 'provider: anthropic\n');
    const now = new Date('2026-09-04T04:00:00.000Z');
    const settings = resolveBackupSettings(makeConfig({ backup: { dir } }));

    const first = await runScheduledBackup({ dataDir, settings, storage, now });
    const second = await runScheduledBackup({ dataDir, settings, storage, now });

    // Without the suffix these are one path, and the second `createBackup`
    // renames its archive over the first — silently, because POSIX `rename`
    // replaces its destination.
    expect(second.path).not.toBe(first.path);
    expect(first.rotated).toEqual([]);
    expect(second.rotated).toEqual([]);
    expect(names()).toEqual([basename(first.path), basename(second.path)].sort());
    expect(names()).toHaveLength(2);
    for (const name of names()) expect(name).toMatch(SCHEDULED_ARCHIVE_RE);
  });

  it('releases the lock when the backup fails', async () => {
    // A file that claims to be a database and is not: the snapshot throws, and
    // the throw is what makes a failed scheduled backup visible (the cron tick
    // logs it and stamps `lastError`). The lock must not survive it.
    writeFileSync(join(dataDir, 'sessions.db'), 'this is not a sqlite file');
    const settings = resolveBackupSettings(makeConfig({ backup: { dir } }));
    await expect(runScheduledBackup({ dataDir, settings, storage })).rejects.toThrow();
    expect(names()).not.toContain('.lock');
  });
});
