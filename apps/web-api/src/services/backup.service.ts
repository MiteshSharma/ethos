import { randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { EthosConfig } from '@ethosagent/config';
import type { CronScheduler } from '@ethosagent/cron';
import { defaultAlwaysDeny, ScopedStorage } from '@ethosagent/storage-fs';
import { BoundaryError, EthosError, type SecretsResolver, type Storage } from '@ethosagent/types';
import type {
  BackupArchive,
  BackupCreateResult,
  BackupRestoreResult,
  BackupStatus,
  BackupStoreRow,
} from '@ethosagent/web-contracts';
import {
  acquireBackupLock,
  createBackup,
  type RestoreReport,
  resolveBackupSettings,
  restoreBackup,
  SCHEDULED_ARCHIVE_RE,
  type ScopeName,
  WAL_STORES,
} from '@ethosagent/wiring';
import type { ConfigRepository } from '../repositories/config.repository';

// The web half of `ethos backup` (plan/phases/agent-state-backup.md §5).
//
// Three things this service does that the CLI does not have to:
//
//  1. `snapshot: 'backup'` is not a preference here, it is the only legal
//     value (D2). This runs inside the process serving chat turns, voice
//     frames and HTTP; `VACUUM INTO` is synchronous in `@ethosagent/sqlite`
//     and would stall the event loop for the length of the copy.
//  2. It takes `backups/.lock` for the duration of a create, exactly as the
//     scheduled job and the CLI do. A web-triggered backup that skipped it
//     would put two writers on the same databases and the same directory —
//     the race the sentinel exists to close. Released in a `finally`. On top
//     of that it holds ONE in-process operation lock across create AND
//     restore (`claim`), because those two rewrite the same files and their
//     own sentinels sit in different directories and never see each other.
//  3. It restores `identity` and NOTHING else (D6). A live server holds every
//     database open, so a `state` restore cannot pass the core's in-use lock
//     gate; offering it would produce a refusal the user cannot act on without
//     stopping the server. The refusal is HERE, in the service — omitting a
//     button from a pane is not a control.
//
// Archive bytes never move through this service. Download is
// `GET /backup/download`, a raw cookie-authed streaming route; this service
// only resolves and vouches for the path it may stream (`resolveDownload`).

/** How the pane learns a store's file moved since the last archive. */
type StoreChanged = BackupStoreRow['changed'];

/** Archives are `.tar.gz`; nothing else in the backup directory is servable. */
const ARCHIVE_SUFFIX = '.tar.gz';

export interface BackupServiceOptions {
  /**
   * `~/.ethos` for THIS service. Every path it creates, restores, lists or
   * vouches for is rooted here — including, since it reads `backup.*` through
   * a repository rooted at the same directory, the backup directory and the
   * schedule it reports.
   */
  dataDir: string;
  storage: Storage;
  /**
   * `<dataDir>/config.yaml`, read through the repository that is already
   * rooted there.
   *
   * Deliberately NOT `readConfig()` from `@ethosagent/config`: that resolves
   * against the process-global `ethosDir()`, so a service holding both would
   * archive and restore under `dataDir` while deriving the backup directory
   * and the schedule from whatever `ETHOS_STATE_DIR` happened to say. One
   * service, two roots — and a caller that passes `dataDir` without also
   * setting the env (an embedding, a test harness, a migration, a second
   * server instance) would list, create, download and restore against the
   * wrong tree. `ConfigService` reads the same flat passthrough map for the
   * same reason.
   */
  config: ConfigRepository;
  /** Enumerated for the archive's secrets manifest — never for its values. */
  secrets: SecretsResolver;
  /**
   * Reads the `backup` system cron job for `nextRunAt` / `lastRunAt` /
   * `lastError`. Absent in deployments with no scheduler, where the schedule
   * block reports nulls rather than inventing a next run.
   */
  scheduler?: CronScheduler;
  /** Boot time of this process. Injected by tests; defaults to construction. */
  startedAt?: Date;
}

export class BackupService {
  private readonly startedAt: string;
  /**
   * The tree-rewriting operation in flight in THIS process, or null. See
   * `claim` — one lock, covering create AND restore.
   */
  private inFlight: 'create' | 'restore' | null = null;
  /**
   * The last create this process attempted, when it FAILED. A failure writes
   * no archive, so the directory listing cannot report it and the header would
   * otherwise show the previous success as if nothing had gone wrong.
   */
  private lastFailure: { at: string; error: string } | null = null;

  constructor(private readonly opts: BackupServiceOptions) {
    this.startedAt = (opts.startedAt ?? new Date()).toISOString();
  }

  /**
   * Everything the Backup pane's header, store rows and archive rows render,
   * in one call. `downloadAvailable` is decided by the caller because only the
   * RPC layer knows how this request authenticated.
   */
  async status(input: { downloadAvailable: boolean }): Promise<BackupStatus> {
    const settings = await this.settings();
    const archives = await this.listArchives(settings.dir);
    const job = await this.readScheduleJob();
    const newest = archives[0] ?? null;

    return {
      directory: settings.dir,
      serverStartedAt: this.startedAt,
      // The contract's `running` is specifically "a create is in flight"; a
      // restore is not a create and must not be reported as one.
      running: this.inFlight === 'create',
      downloadAvailable: input.downloadAvailable,
      schedule: {
        enabled: settings.enabled,
        cron: settings.cron,
        scopes: settings.scopes,
        keep: settings.keep,
        nextRunAt: job?.nextRunAt ?? null,
        lastRunAt: job?.lastRunAt ?? null,
        lastError: job?.lastError ?? null,
      },
      lastBackup: this.lastRun(newest, job),
      archives,
      stores: await this.storeRows(settings.scopes, newest),
    };
  }

  /**
   * Create one archive in the backup directory, under the operation lock and
   * then the `.lock`.
   *
   * A concurrent create — or a create raced against a restore — is refused
   * rather than queued: `acquireBackupLock` would block for its timeout and
   * then throw, and a second in-process operation has no reason to wait at all.
   * The pane disables its button while `status.running` is true; this is the
   * server-side half of that, and the half that is actually the guarantee.
   */
  async create(input: { scopes?: ScopeName[] }): Promise<BackupCreateResult> {
    // Claimed FIRST, before any `await`: the claim is what serialises this
    // against a restore, and a check that straddles a suspension point is not
    // a claim at all — two creates arriving together would both pass it.
    const done = this.claim('create');
    let release: (() => void) | undefined;
    try {
      const settings = await this.settings();
      const scopes = input.scopes ?? settings.scopes;
      const outPath = join(settings.dir, webArchiveName(new Date()));

      release = await acquireBackupLock(settings.dir);
      const result = await createBackup({
        dataDir: this.opts.dataDir,
        outPath,
        scopes,
        // MANDATORY (D2) — this is a serving process.
        snapshot: 'backup',
        secrets: this.opts.secrets,
      });
      this.lastFailure = null;
      const name = basename(result.path);
      const listed = (await this.listArchives(settings.dir)).find((a) => a.name === name);
      return {
        archive: {
          name,
          // Compressed size on disk, from the same listing `status` reads, so
          // the row the pane appends matches the row its next refresh brings.
          bytes: listed?.bytes ?? 0,
          createdAt: result.manifest.createdAt,
          scheduled: false,
        },
        scopes: result.scopes,
        fileCount: result.fileCount,
        uncompressedBytes: result.bytes,
        skipped: result.skippedFiles.map((s) => ({ path: s.path, reason: s.reason })),
        unclassifiedDatabases: result.unclassifiedDatabases,
      };
    } catch (err) {
      // Recorded so the next `status` says the last attempt failed instead of
      // showing the previous archive as the current state of the world.
      this.lastFailure = { at: new Date().toISOString(), error: messageOf(err) };
      throw err;
    } finally {
      release?.();
      done();
    }
  }

  /**
   * Restore `identity` from an archive already in the backup directory.
   *
   * D6, enforced twice on purpose: any scope other than `identity` is refused
   * with a reason the pane can render, AND the call into the core names
   * `['identity']` literally, so a future edit to the guard cannot widen what
   * actually runs.
   *
   * Takes the same operation lock `create` does — see `claim`. A DRY RUN does
   * not: it renames nothing, claims no `.restore-in-progress` sentinel and
   * writes no file, so there is nothing for a concurrent create to collide
   * with, and blocking a read-only preview behind a running backup would be a
   * refusal with no hazard behind it.
   */
  async restoreIdentity(input: {
    name: string;
    scopes?: ScopeName[];
    dryRun?: boolean;
  }): Promise<BackupRestoreResult> {
    assertIdentityOnly(input.scopes);
    // Claimed before the first `await`, for the reason spelled out in `create`.
    const done = input.dryRun ? NO_CLAIM : this.claim('restore');
    try {
      const settings = await this.settings();
      const { absolutePath: archivePath } = await this.reachable(settings.dir, input.name);

      const report = await restoreBackup({
        dataDir: this.opts.dataDir,
        archivePath,
        scopes: ['identity'],
        ...(input.dryRun ? { dryRun: true } : {}),
      });
      return toRestoreOutput(report);
    } finally {
      done();
    }
  }

  /**
   * Vouch for one archive path so `GET /backup/download` can stream it. Bytes
   * are NOT read here — a multi-hundred-megabyte archive must never land in
   * the server's heap on its way to the browser.
   */
  async resolveDownload(name: string): Promise<{
    absolutePath: string;
    filename: string;
    size: number;
  }> {
    const settings = await this.settings();
    const { absolutePath, size } = await this.reachable(settings.dir, name);
    return { absolutePath, filename: basename(absolutePath), size };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Claim this process for one tree-rewriting operation, and return its
   * release.
   *
   * ONE lock covering BOTH create and restore, because they rewrite the same
   * files: a create archives `config.yaml` and `personalities/` while a
   * restore renames those very paths into and out of `.pre-restore/`. Their
   * own sentinels do not see each other — `backups/.lock` guards the backup
   * directory, `.restore-in-progress` guards the data directory — so without
   * this, two web requests produce an archive that is internally mixed, or one
   * that omits files enumerated a moment earlier, or a create that fails
   * half-way through a rename. A single lock is also why there is no lock
   * ORDER to get wrong here.
   *
   * In-process only, and that is the whole scope of the claim: this is a
   * guarantee about two HTTP requests hitting one server, not about the CLI.
   * The cross-process create-vs-restore race stays open and stays recorded —
   * closing it means widening `.restore-in-progress`'s contract, which raises
   * the undecided question of what `ethos import --force` should then mean.
   * There is no `--force` on this path and no second process in the way, so
   * the service can serialise its own two callers unambiguously.
   */
  private claim(op: 'create' | 'restore'): () => void {
    const busy = this.inFlight;
    if (busy !== null) {
      throw new EthosError({
        code: 'FORBIDDEN',
        cause: `A ${busy === 'create' ? 'backup' : 'restore'} is already running on this server.`,
        action: 'Wait for it to finish, then try again.',
      });
    }
    this.inFlight = op;
    return () => {
      this.inFlight = null;
    };
  }

  /**
   * `backup.*` from `<dataDir>/config.yaml`. A config that is absent entirely
   * (a deployment that never ran setup) resolves to the same defaults the
   * scheduled job would use, which is what the pane should show.
   */
  private async settings(): Promise<{
    dir: string;
    enabled: boolean;
    cron: string;
    scopes: ScopeName[];
    keep: number;
  }> {
    const raw = await this.opts.config.read();
    const backup = backupBlock(raw?.passthrough ?? {});
    // A deployment that never ran setup has no config.yaml at all. The
    // defaults are still the right answer for the pane — they are exactly what
    // the scheduled job would use — and `resolveBackupSettings` reads nothing
    // but `backup.*`, so the placeholder identity fields below are never seen.
    const resolved = resolveBackupSettings({ ...UNCONFIGURED, backup });
    return {
      // NOT `resolved.dir`: `backupDirectory()` in `@ethosagent/wiring`
      // resolves `backup.dir` against `ethosDir()`, which is the only root the
      // CLI and the scheduled job have. This service was handed one.
      dir: this.backupDir(backup.dir),
      enabled: resolved.enabled,
      cron: resolved.cron,
      scopes: resolved.scopes,
      keep: resolved.keep,
    };
  }

  /** `backup.dir`, defaulted and resolved against THIS service's data dir. */
  private backupDir(configured: string | undefined): string {
    if (!configured) return join(this.opts.dataDir, 'backups');
    return isAbsolute(configured) ? configured : join(this.opts.dataDir, configured);
  }

  /** Newest first. Only `.tar.gz` files — the directory also holds `.lock`. */
  private async listArchives(dir: string): Promise<BackupArchive[]> {
    const entries = await this.opts.storage.listEntries(dir);
    return entries
      .filter((e) => !e.isDir && e.name.endsWith(ARCHIVE_SUFFIX))
      .map((e) => ({
        name: e.name,
        bytes: e.size ?? 0,
        createdAt: new Date(e.mtimeMs ?? 0).toISOString(),
        scheduled: SCHEDULED_ARCHIVE_RE.test(e.name),
      }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  /** The `backup` system cron job, or null when there is no scheduler. */
  private async readScheduleJob(): Promise<{
    nextRunAt: string | null;
    lastRunAt: string | null;
    lastError: string | null;
  } | null> {
    if (!this.opts.scheduler) return null;
    const job = await this.opts.scheduler.getJob('backup').catch(() => null);
    if (!job) return null;
    return {
      nextRunAt: job.nextRunAt ?? null,
      lastRunAt: job.lastRunAt ?? null,
      lastError: job.lastError ?? null,
    };
  }

  /**
   * The header's "last backup". Three things can be the most recent attempt —
   * the newest archive on disk, a scheduled run that ended in `lastError`, and
   * a web-triggered create that threw in this process — and the latest of them
   * wins. A failure never carries an archive: it did not write one.
   */
  private lastRun(
    newest: BackupArchive | null,
    job: { lastRunAt: string | null; lastError: string | null } | null,
  ): BackupStatus['lastBackup'] {
    const candidates: NonNullable<BackupStatus['lastBackup']>[] = [];
    if (newest) {
      candidates.push({ ok: true, at: newest.createdAt, archive: newest, error: null });
    }
    if (job?.lastError && job.lastRunAt) {
      candidates.push({ ok: false, at: job.lastRunAt, archive: null, error: job.lastError });
    }
    if (this.lastFailure) {
      candidates.push({
        ok: false,
        at: this.lastFailure.at,
        archive: null,
        error: this.lastFailure.error,
      });
    }
    return candidates.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0] ?? null;
  }

  /**
   * One row per distinct database in `WAL_STORES`. That registry is drift-
   * gated (`scopes.test.ts` fails when the repo grows a WAL store it does not
   * classify), so this list cannot silently go stale.
   *
   * `sessions.db` has FIVE tenants and `pairing.db` two, all agreeing on the
   * scope; the rows are deduped by database file, which is what the operator
   * is looking at.
   *
   * Five, not four, and the difference is that tenants are not modules:
   * `extensions/session-sqlite/src/index.ts` holds two of them — the session
   * store and the key/value store `createKvStoreFactory` opens, both pointed at
   * the same path by `session-sqlite/src/compose.ts`. Counting the four MODULES
   * that name the file is what makes it look like four.
   */
  private async storeRows(
    scopes: readonly ScopeName[],
    newest: BackupArchive | null,
  ): Promise<BackupStoreRow[]> {
    const since = newest ? Date.parse(newest.createdAt) : null;
    const seen = new Set<string>();
    const rows: BackupStoreRow[] = [];
    for (const record of WAL_STORES) {
      if (seen.has(record.database)) continue;
      seen.add(record.database);
      const mtimeMs = await this.opts.storage.mtime(join(this.opts.dataDir, record.database));
      rows.push({
        database: record.database,
        scope: record.scope,
        included: record.scope !== null && scopes.includes(record.scope),
        reason: record.reason,
        changed: changedSince(mtimeMs, since),
      });
    }
    return rows;
  }

  /**
   * Turn a caller-supplied archive name into an absolute path that is both
   * inside the backup directory and free of symlinks.
   *
   * Containment is REUSED, not rewritten — the same two-part gate
   * `DocumentsService.reachable` uses, for the same reason: `ScopedStorage`
   * resolves before its prefix test (so `..` and absolute paths land outside
   * the allowlist and are refused), and a raw `lstat` refuses symlinks, which
   * `Storage` follows and cannot see. A single path SEGMENT is required on top
   * of that, because an archive name is a filename and nothing in this
   * directory is addressed any other way.
   */
  private async reachable(
    dir: string,
    name: string,
  ): Promise<{ absolutePath: string; size: number }> {
    if (name !== basename(name) || name === '.' || name === '..') {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: 'An archive is named by its filename, not by a path.',
        action: 'Use a `name` from backup.status.',
      });
    }
    if (!name.endsWith(ARCHIVE_SUFFIX)) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `Only \`${ARCHIVE_SUFFIX}\` archives are served from the backup directory.`,
        action: 'Use a `name` from backup.status.',
      });
    }
    const scoped = new ScopedStorage(this.opts.storage, {
      read: [dir],
      write: [],
      alwaysDeny: defaultAlwaysDeny(),
    });
    const target = resolve(dir, name);
    try {
      // Let ScopedStorage judge containment before any lstat touches the path.
      await scoped.exists(target);
    } catch (err) {
      if (err instanceof BoundaryError) {
        throw new EthosError({
          code: 'FORBIDDEN',
          cause: 'That path is outside the backup directory.',
          action: 'Use a `name` from backup.status.',
        });
      }
      throw err;
    }
    const st = await lstat(target).catch(() => null);
    if (!st) throw archiveNotFound(name);
    if (st.isSymbolicLink()) {
      throw new EthosError({
        code: 'FORBIDDEN',
        cause: 'That archive is a symbolic link.',
        action: 'Symlinks are not served — they can point outside the backup directory.',
      });
    }
    if (!st.isFile()) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: 'That name is not a file.',
        action: 'Use a `name` from backup.status.',
      });
    }
    return { absolutePath: target, size: st.size };
  }
}

/**
 * Stand-in for a machine with no `config.yaml`. Only `backup.*` is ever read
 * off it (see `settings`); the four required identity fields are structural.
 */
const UNCONFIGURED: EthosConfig = { provider: '', model: '', apiKey: '', personality: '' };

/** The release a dry-run restore holds: it claims nothing, so it frees nothing. */
const NO_CLAIM = (): void => {};

/**
 * The `backup.*` block, read off the raw passthrough map of
 * `<dataDir>/config.yaml`.
 *
 * Flat keys rather than the typed `EthosConfig.backup` for one reason: the
 * typed reader (`readConfig` / `readRawConfig`) resolves its path against the
 * process-global `ethosDir()`, and this service must read the config of the
 * data directory it was given. `ConfigService` reads `display.voice_*` and
 * `auxiliary.*` the same way, for the same reason.
 *
 * This is the mapping ONLY. Every default and the scope validation stay in
 * `resolveBackupSettings`, so there is one place that decides what an unset
 * `backup.*` means. Mirrors `buildBackupConfig` in `@ethosagent/config`,
 * including its whole-string integer test — `parseInt` would take "7days" as
 * 7 — with one deliberate difference: a `keep` that fails the test is left
 * UNSET here instead of throwing. That file is unloadable for the CLI either
 * way; a Settings pane that 500s tells the operator less than one that renders
 * the default it would actually get.
 */
function backupBlock(passthrough: Record<string, string>): NonNullable<EthosConfig['backup']> {
  const enabled = passthrough['backup.enabled'];
  const cron = passthrough['backup.cron'];
  const keepRaw = passthrough['backup.keep'];
  const keep = keepRaw !== undefined && /^\d+$/.test(keepRaw) ? Number(keepRaw) : Number.NaN;
  const scope = (passthrough['backup.scope'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const dir = passthrough['backup.dir'];
  return {
    ...(enabled !== undefined ? { enabled: enabled === 'true' } : {}),
    ...(cron ? { cron } : {}),
    ...(scope.length > 0 ? { scope } : {}),
    ...(Number.isSafeInteger(keep) && keep >= 1 ? { keep } : {}),
    ...(dir ? { dir } : {}),
  };
}

/**
 * D6. `state` and `telemetry` are refused with a reason rather than dropped by
 * the schema, so the pane can say WHY instead of showing a validation error.
 */
function assertIdentityOnly(scopes: readonly ScopeName[] | undefined): void {
  const asked = scopes ?? ['identity'];
  const extra = asked.filter((s) => s !== 'identity');
  if (extra.length === 0) return;
  throw new EthosError({
    code: 'FORBIDDEN',
    cause:
      `Only the \`identity\` scope can be restored from the web (asked for ${extra.join(', ')}). ` +
      'A running server holds every database open, so a `state` restore cannot pass the ' +
      'in-use check and would be refused half-way.',
    action: 'Stop Ethos and run `ethos import <archive> --scope state` from the CLI.',
  });
}

/** Wire shape for a `RestoreReport`. Optional fields become explicit nulls. */
function toRestoreOutput(report: RestoreReport): BackupRestoreResult {
  return {
    dryRun: report.dryRun,
    scopes: report.scopes,
    createdAt: report.createdAt,
    restored: report.restored,
    displaced: report.displaced,
    displacedTo: report.displacedTo ?? null,
    inUseCheck: report.inUseCheck,
    lockedDatabases: report.lockedDatabases,
    restartRequired: report.restartRequired,
    warnings: report.warnings.map((w) => ({ kind: w.kind, path: w.path, message: w.message })),
    // Operator instructions read out of someone else's archive. Passed through
    // verbatim as TEXT — the contract says so too — and never interpreted here.
    secretsManifest: report.secretsManifest ?? null,
  };
}

function changedSince(mtimeMs: number | null, since: number | null): StoreChanged {
  if (mtimeMs === null) return 'absent';
  if (since === null || Number.isNaN(since)) return 'unknown';
  return mtimeMs > since ? 'changed' : 'unchanged';
}

/**
 * `ethos-web-<iso>-<hex>.tar.gz` — distinct from `ethos-scheduled-*`, which is
 * the only name rotation will ever delete. A web backup is not rotated away.
 *
 * The random suffix is what makes the name UNIQUE, and it is not decoration.
 * The timestamp has one-second resolution and the name is computed BEFORE the
 * `.lock` is taken, so two creates a fraction of a second apart — this process
 * and a peer sharing the backup directory, or a retry after the first call's
 * response was lost — precompute the same path, and the second `createBackup`
 * renames its finished archive over an archive the first one just wrote. That
 * is silent: the caller is handed a name, the listing shows one row, and one of
 * the two backups is simply not there. `defaultArchiveName` in
 * `apps/ethos/src/commands/backup.ts` answers it the same way, and the two
 * names must stay the same shape for exactly that reason.
 */
function webArchiveName(now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `ethos-web-${stamp}Z-${randomBytes(4).toString('hex')}.tar.gz`;
}

function archiveNotFound(name: string): EthosError {
  return new EthosError({
    code: 'FILE_NOT_FOUND',
    cause: `No backup archive named "${name}".`,
    action: 'Call backup.status for the archives this machine holds.',
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
