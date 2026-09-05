import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSecretsResolver, FsStorage } from '@ethosagent/storage-fs';
import { isEthosError } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `@ethosagent/wiring` is wrapped rather than replaced: every call still runs
// the real `createBackup` / `acquireBackupLock`, and the wrapper only records
// what it was asked for. Two of this service's hard requirements are about the
// ARGUMENTS it passes (`snapshot: 'backup'`, plan D2) and about a call it must
// not skip (the shared `backups/.lock`), neither of which is visible in the
// result — so they are observed here and the behaviour underneath stays real.
const spy = vi.hoisted(() => ({
  createOpts: [] as Array<{ snapshot?: string; dataDir: string; outPath: string }>,
  lockDirs: [] as string[],
  releases: 0,
  failNextCreate: null as string | null,
  // Gates that hold an operation open mid-flight, so the OTHER operation can
  // be attempted while it is genuinely running. Without them a create and a
  // restore driven from one test never overlap, and the serialisation the
  // service now performs would be untestable.
  holdCreate: null as Promise<void> | null,
  holdRestore: null as Promise<void> | null,
}));

vi.mock('@ethosagent/wiring', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ethosagent/wiring')>();
  return {
    ...actual,
    createBackup: async (opts: Parameters<typeof actual.createBackup>[0]) => {
      spy.createOpts.push(opts);
      if (spy.holdCreate) await spy.holdCreate;
      if (spy.failNextCreate !== null) {
        const message = spy.failNextCreate;
        spy.failNextCreate = null;
        throw new Error(message);
      }
      return actual.createBackup(opts);
    },
    restoreBackup: async (opts: Parameters<typeof actual.restoreBackup>[0]) => {
      if (spy.holdRestore) await spy.holdRestore;
      return actual.restoreBackup(opts);
    },
    acquireBackupLock: async (dir: string, opts?: { timeoutMs?: number }) => {
      spy.lockDirs.push(dir);
      const release = await actual.acquireBackupLock(dir, opts ?? {});
      return () => {
        spy.releases += 1;
        release();
      };
    },
  };
});

const { ConfigRepository } = await import('../../repositories/config.repository');
const { BackupService } = await import('../../services/backup.service');

describe('BackupService', () => {
  let dataDir: string;
  let backupDir: string;
  // A SECOND, fully furnished `~/.ethos` that `ETHOS_STATE_DIR` points at for
  // the whole suite — and that this service must never touch. It used to be
  // `dataDir` itself, which meant the injected root and the process-global one
  // agreed and no assertion here could tell them apart; the service read its
  // config and computed its backup directory through `ethosDir()` while
  // creating and restoring under `dataDir`, and the test proved nothing about
  // which of the two it was using. Pointing the env at a decoy is what makes
  // every `expect(...).toBe(backupDir)` below a rooting assertion — and it
  // still keeps the suite off the developer's real `~/.ethos`, which is what
  // the env mutation was originally for.
  let decoyDir: string;
  let prevStateDir: string | undefined;
  let service: InstanceType<typeof BackupService>;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-backup-service-'));
    decoyDir = await mkdtemp(join(tmpdir(), 'ethos-backup-decoy-'));
    backupDir = join(dataDir, 'backups');
    prevStateDir = process.env.ETHOS_STATE_DIR;
    process.env.ETHOS_STATE_DIR = decoyDir;

    // The decoy carries a config that disagrees with the real one on every
    // `backup.*` key, so reading the wrong file is visible rather than silent.
    await writeFile(
      join(decoyDir, 'config.yaml'),
      'schemaVersion: 1\npersonality: architect\nbackup.cron: 0 9 * * *\nbackup.keep: 99\nbackup.dir: decoy-backups\n',
    );

    await writeFile(join(dataDir, 'config.yaml'), 'schemaVersion: 1\npersonality: architect\n');
    await mkdir(join(dataDir, 'personalities', 'architect'), { recursive: true });
    await writeFile(join(dataDir, 'personalities', 'architect', 'SOUL.md'), '# I am here\n');

    const storage = new FsStorage();
    const secrets = new FileSecretsResolver({ dir: join(dataDir, 'secrets'), storage });
    service = new BackupService({
      dataDir,
      storage,
      // Rooted at `dataDir`, like every other path this service handles.
      config: new ConfigRepository({ dataDir, storage, secrets }),
      secrets,
      startedAt: new Date('2026-09-05T00:00:00.000Z'),
    });

    spy.createOpts.length = 0;
    spy.lockDirs.length = 0;
    spy.releases = 0;
    spy.failNextCreate = null;
    spy.holdCreate = null;
    spy.holdRestore = null;
  });

  afterEach(async () => {
    if (prevStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
    else process.env.ETHOS_STATE_DIR = prevStateDir;
    await rm(dataDir, { recursive: true, force: true });
    await rm(decoyDir, { recursive: true, force: true });
  });

  it('creates the archive with the async snapshot mode (D2)', async () => {
    const result = await service.create({});

    expect(spy.createOpts).toHaveLength(1);
    expect(spy.createOpts[0]?.snapshot).toBe('backup');
    expect(spy.createOpts[0]?.dataDir).toBe(dataDir);
    expect(result.archive.name).toMatch(/^ethos-web-.*\.tar\.gz$/);
    expect(existsSync(join(backupDir, result.archive.name))).toBe(true);
  });

  it('takes the shared backup lock and releases it', async () => {
    await service.create({});

    expect(spy.lockDirs).toEqual([backupDir]);
    expect(spy.releases).toBe(1);
    // Released, not merely acquired: a lock left behind blocks the scheduled
    // job and every later `ethos backup` on this machine.
    expect(existsSync(join(backupDir, '.lock'))).toBe(false);

    // And the next create can therefore take it again.
    await service.create({});
    expect(spy.lockDirs).toEqual([backupDir, backupDir]);
    expect(spy.releases).toBe(2);
  });

  it('gives two creates inside one second two different archives', async () => {
    // The archive name is computed BEFORE the lock is taken and the timestamp
    // has one-second resolution, so without a unique component both calls
    // resolve to the same path and the second `createBackup` renames its
    // finished archive over the first one's. Silently: the caller is handed a
    // name, the listing shows one row, and one of the two backups is gone.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-05T04:00:00.000Z'));
    try {
      const first = await service.create({});
      const second = await service.create({});

      expect(second.archive.name).not.toBe(first.archive.name);
      expect(existsSync(join(backupDir, first.archive.name))).toBe(true);
      expect(existsSync(join(backupDir, second.archive.name))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the lock and reports the failure when a create throws', async () => {
    spy.failNextCreate = 'no space left on device';

    await expect(service.create({})).rejects.toThrow('no space left on device');

    expect(spy.releases).toBe(1);
    expect(existsSync(join(backupDir, '.lock'))).toBe(false);

    const status = await service.status({ downloadAvailable: true });
    expect(status.running).toBe(false);
    expect(status.lastBackup).toMatchObject({
      ok: false,
      archive: null,
      error: 'no space left on device',
    });
  });

  it('prefers the newest archive over an older failure in `lastBackup`', async () => {
    spy.failNextCreate = 'transient';
    await expect(service.create({})).rejects.toThrow('transient');
    await service.create({});

    const status = await service.status({ downloadAvailable: true });
    expect(status.lastBackup?.ok).toBe(true);
    expect(status.lastBackup?.archive?.name).toMatch(/^ethos-web-/);
  });

  it('refuses a `state` restore server-side (D6)', async () => {
    const { archive } = await service.create({});

    await expect(
      service.restoreIdentity({ name: archive.name, scopes: ['state'] }),
    ).rejects.toSatisfy(
      (err: unknown) => isEthosError(err) && err.code === 'FORBIDDEN' && /identity/.test(err.cause),
    );
  });

  it('refuses `telemetry` too — identity is the only restorable scope', async () => {
    const { archive } = await service.create({});

    await expect(
      service.restoreIdentity({ name: archive.name, scopes: ['identity', 'telemetry'] }),
    ).rejects.toSatisfy((err: unknown) => isEthosError(err) && err.code === 'FORBIDDEN');
  });

  it('reports `inUseCheck` and `restartRequired` on a dry-run identity restore', async () => {
    const { archive } = await service.create({});

    const report = await service.restoreIdentity({ name: archive.name, dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.scopes).toEqual(['identity']);
    // A dry run makes NO in-use check; an empty `lockedDatabases` under this
    // value must never be read as "nothing was running".
    expect(report.inUseCheck).toBe('skipped_dry_run');
    expect(report.lockedDatabases).toEqual([]);
    expect(typeof report.restartRequired).toBe('boolean');
    expect(report.restored).toContain('config.yaml');
    // config.yaml is restored, so a restart is genuinely required.
    expect(report.restartRequired).toBe(true);
  });

  it('lists archives newest first and reports per-store rows', async () => {
    await service.create({});
    const status = await service.status({ downloadAvailable: false });

    expect(status.directory).toBe(backupDir);
    expect(status.serverStartedAt).toBe('2026-09-05T00:00:00.000Z');
    expect(status.downloadAvailable).toBe(false);
    expect(status.archives).toHaveLength(1);
    expect(status.archives[0]?.scheduled).toBe(false);

    // From the drift-gated `WAL_STORES` registry, deduped by database file.
    const names = status.stores.map((s) => s.database);
    expect(names).toContain('sessions.db');
    expect(names).toContain('observability.db');
    expect(new Set(names).size).toBe(names.length);

    const sessions = status.stores.find((s) => s.database === 'sessions.db');
    expect(sessions).toMatchObject({ scope: 'state', included: true, changed: 'absent' });
    const ledger = status.stores.find((s) => s.database === 'delivery-ledger.db');
    expect(ledger).toMatchObject({ scope: null, included: false });
  });

  it('defaults the schedule block when no scheduler is wired', async () => {
    const status = await service.status({ downloadAvailable: true });

    expect(status.schedule).toMatchObject({
      enabled: true,
      cron: '0 4 * * *',
      scopes: ['identity', 'state'],
      keep: 7,
      nextRunAt: null,
      lastRunAt: null,
      lastError: null,
    });
    expect(status.lastBackup).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Rooting
  // -------------------------------------------------------------------------

  describe('rooted in the injected data directory', () => {
    it('reads `backup.*` from `<dataDir>/config.yaml`, not from `ETHOS_STATE_DIR`', async () => {
      await writeFile(
        join(dataDir, 'config.yaml'),
        'schemaVersion: 1\npersonality: architect\nbackup.cron: 0 5 * * *\nbackup.keep: 3\nbackup.scope: identity\n',
      );

      const status = await service.status({ downloadAvailable: true });

      // The decoy `config.yaml` says `0 9 * * *` / 99 / two scopes.
      expect(status.schedule.cron).toBe('0 5 * * *');
      expect(status.schedule.keep).toBe(3);
      expect(status.schedule.scopes).toEqual(['identity']);
    });

    it('resolves a relative `backup.dir` against the injected data directory', async () => {
      await writeFile(
        join(dataDir, 'config.yaml'),
        'schemaVersion: 1\npersonality: architect\nbackup.dir: snapshots\n',
      );

      const status = await service.status({ downloadAvailable: true });
      expect(status.directory).toBe(join(dataDir, 'snapshots'));

      const { archive } = await service.create({});
      expect(spy.lockDirs).toEqual([join(dataDir, 'snapshots')]);
      expect(existsSync(join(dataDir, 'snapshots', archive.name))).toBe(true);
      // And nothing was created under the tree `ETHOS_STATE_DIR` names.
      expect(existsSync(join(decoyDir, 'snapshots'))).toBe(false);
      expect(existsSync(join(decoyDir, 'decoy-backups'))).toBe(false);
      expect(existsSync(join(decoyDir, 'backups'))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Create vs restore
  // -------------------------------------------------------------------------

  describe('create and restore are serialised against each other', () => {
    /** Hold one operation open, and return the release that lets it finish. */
    const gate = (which: 'holdCreate' | 'holdRestore'): (() => void) => {
      let open!: () => void;
      spy[which] = new Promise<void>((resolve) => {
        open = resolve;
      });
      return open;
    };

    it('refuses a create while a restore is running, naming the restore', async () => {
      const { archive } = await service.create({});
      const open = gate('holdRestore');
      const restoring = service.restoreIdentity({ name: archive.name });

      await expect(service.create({})).rejects.toSatisfy(
        (err: unknown) =>
          isEthosError(err) &&
          err.code === 'FORBIDDEN' &&
          /restore is already running/.test(err.cause),
      );

      open();
      const report = await restoring;
      expect(report.restored).toContain('config.yaml');
      // The refusal did not leave the service wedged.
      await service.create({});
    });

    it('refuses a restore while a create is running, naming the backup', async () => {
      const { archive } = await service.create({});
      const open = gate('holdCreate');
      const creating = service.create({});

      await expect(service.restoreIdentity({ name: archive.name })).rejects.toSatisfy(
        (err: unknown) =>
          isEthosError(err) &&
          err.code === 'FORBIDDEN' &&
          /backup is already running/.test(err.cause),
      );

      open();
      await creating;
    });

    it('lets a DRY RUN through while a create is running — it rewrites nothing', async () => {
      const { archive } = await service.create({});
      const open = gate('holdCreate');
      const creating = service.create({});

      const report = await service.restoreIdentity({ name: archive.name, dryRun: true });
      expect(report.dryRun).toBe(true);

      open();
      await creating;
    });
  });

  describe('download containment', () => {
    const refused = (name: string, code: string) =>
      expect(service.resolveDownload(name)).rejects.toSatisfy(
        (err: unknown) => isEthosError(err) && err.code === code,
      );

    it('refuses a traversal path', async () => {
      await refused('../../etc/passwd', 'INVALID_INPUT');
    });

    it('refuses an absolute path', async () => {
      await refused('/etc/passwd', 'INVALID_INPUT');
    });

    it('refuses a nested path inside the backup directory', async () => {
      await mkdir(join(backupDir, 'nested'), { recursive: true });
      await writeFile(join(backupDir, 'nested', 'inner.tar.gz'), 'x');
      await refused('nested/inner.tar.gz', 'INVALID_INPUT');
    });

    it('refuses a file that is not an archive', async () => {
      await mkdir(backupDir, { recursive: true });
      await writeFile(join(backupDir, '.lock'), '{}');
      await refused('.lock', 'INVALID_INPUT');
    });

    it('refuses a symlink, even one named like an archive', async () => {
      await mkdir(backupDir, { recursive: true });
      const secret = join(dataDir, 'secrets-outside.txt');
      await writeFile(secret, 'do not leak');
      await symlink(secret, join(backupDir, 'sneaky.tar.gz'));
      await refused('sneaky.tar.gz', 'FORBIDDEN');
    });

    it('refuses a name that does not exist', async () => {
      await mkdir(backupDir, { recursive: true });
      await refused('ethos-web-nope.tar.gz', 'FILE_NOT_FOUND');
    });

    it('resolves a real archive to a path inside the backup directory', async () => {
      const { archive } = await service.create({});

      const file = await service.resolveDownload(archive.name);
      expect(file.absolutePath).toBe(join(backupDir, archive.name));
      expect(file.filename).toBe(archive.name);
      expect(file.size).toBeGreaterThan(0);
    });
  });
});
