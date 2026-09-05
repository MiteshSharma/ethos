// Build an archive: enumerate, snapshot, stream, manifest last.
//
// Ordering matters and is not negotiable. Every per-file sha256 is computed
// while the bytes stream past, so the manifest cannot be written until the
// last file has been. `restore.ts` relies on that: it reads the manifest in a
// full pre-pass and trusts nothing until every hash matches.
//
// Databases never enter the archive as live files. Each is snapshotted into a
// staging directory first (D2), because a WAL database's committed data is
// split between the main file and an uncheckpointed `-wal` — streaming the
// main file alone silently drops everything since the last checkpoint.
//
// The archive is written to a temporary file and renamed onto `outPath` only
// once it is complete. Opening `outPath` directly would truncate whatever is
// already there before the first byte of the replacement exists, so a snapshot,
// stream, gzip or disk failure part-way through would destroy the previous good
// backup — the one thing a failed backup must never do, and the exact case
// rotation (`backup.keep`) walks into by pointing run after run at one
// directory.
//
// Raw `node:fs` here is the documented Storage carve-out (AGENTS.md).

import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { SecretsResolver } from '@ethosagent/types';
import { type BackupManifest, writeManifest } from './manifest';
import { type BackupEntry, DEFAULT_SCOPES, enumerateBackupEntries, type ScopeName } from './scopes';
import { buildSecretsManifest, SECRETS_MANIFEST_PATH } from './secrets-manifest';
import { type SnapshotMode, snapshotSqlite } from './snapshot';
import { createTarGzWriter, type TarFileRecord, type TarSkip, type TarWriter } from './tar';

export interface CreateBackupOptions {
  /** `~/.ethos` (or an `ETHOS_STATE_DIR` override). */
  dataDir: string;
  /** Destination `.tar.gz`. Its parent directory is created if missing. */
  outPath: string;
  /** Defaults to `identity` + `state` (D1). */
  scopes?: readonly ScopeName[];
  /**
   * `'backup'` (async online copy) is MANDATORY in a serving process; the CLI
   * may pass `'vacuum'`. Defaults to `'backup'` — the safe one to get wrong.
   */
  snapshot?: SnapshotMode;
  /**
   * Vault to enumerate for the secrets manifest. Omit and the archive carries
   * no manifest — appropriate only where there is no vault.
   */
  secrets?: SecretsResolver;
  /** Staging root for database snapshots. Defaults to a fresh temp dir. */
  stagingDir?: string;
}

export interface BackupResult {
  path: string;
  scopes: ScopeName[];
  manifest: BackupManifest;
  /** Archived files, excluding the two meta entries. */
  fileCount: number;
  /** Uncompressed bytes of everything archived. */
  bytes: number;
  /** Databases under `dataDir` that no `WAL_STORES` entry accounts for. */
  unclassifiedDatabases: string[];
  /**
   * Files enumerated for the archive that could not be encoded into a tar
   * entry, with the reason. Reported rather than fatal — one unarchivable
   * filename must not cost the whole backup — but a silent drop would be just
   * as bad, so a caller MUST surface these.
   */
  skippedFiles: TarSkip[];
}

/** Where a database's snapshot lands under the staging root. */
function stagingPathFor(stagingRoot: string, entry: BackupEntry): string {
  const dest = join(stagingRoot, entry.path);
  mkdirSync(dirname(dest), { recursive: true });
  return dest;
}

export async function createBackup(opts: CreateBackupOptions): Promise<BackupResult> {
  const scopes = [...(opts.scopes ?? DEFAULT_SCOPES)];
  const mode = opts.snapshot ?? 'backup';
  const { entries, unclassifiedDatabases, strippedMcpTokens } = enumerateBackupEntries(
    opts.dataDir,
    scopes,
  );

  const stagingRoot = opts.stagingDir ?? mkdtempSync(join(tmpdir(), 'ethos-backup-'));
  mkdirSync(stagingRoot, { recursive: true });

  // The partial archive is written INSIDE the destination directory, so
  // finishing it is a rename — atomic, and no second copy of a multi-hundred-MB
  // archive across a filesystem boundary. `mkdtempSync` is what makes the name
  // unique: two backups aimed at one path must not write the same temporary
  // file, and a guessable name is a file another process can already hold.
  const outDir = dirname(opts.outPath);
  mkdirSync(outDir, { recursive: true });
  const tempDir = mkdtempSync(join(outDir, '.ethos-backup-partial-'));
  const tempPath = join(tempDir, basename(opts.outPath));

  const records: TarFileRecord[] = [];
  let bytes = 0;
  // Held outside the `try` so the failure path can tear it down: from
  // `createTarGzWriter` on there is a gzip piped into an open file, and every
  // way this can fail afterwards — a file that changed size mid-stream, a
  // secrets vault that throws, a full disk — used to jump straight to the
  // `finally`, which removes the temp directory and leaves those streams live.
  let writer: TarWriter | undefined;
  try {
    // Snapshot first, in full, before a byte reaches the archive: a database
    // that fails to snapshot must not leave a half-written archive behind.
    const sources = new Map<string, string>();
    for (const entry of entries) {
      if (!entry.database) continue;
      const dest = stagingPathFor(stagingRoot, entry);
      await snapshotSqlite(entry.sourcePath, dest, mode);
      sources.set(entry.path, dest);
    }

    writer = createTarGzWriter(tempPath);
    for (const entry of entries) {
      const source = sources.get(entry.path) ?? entry.sourcePath;
      const record = await writer.addFileFromDisk(entry.path, source);
      if (record === null) continue; // unarchivable name; reported via `skippedFiles`
      records.push(record);
      bytes += record.size;
    }
    if (opts.secrets) {
      const manifestText = await buildSecretsManifest({
        secrets: opts.secrets,
        strippedMcpTokens,
      });
      const record = await writer.addFile(SECRETS_MANIFEST_PATH, Buffer.from(manifestText, 'utf8'));
      records.push(record);
    }
    const manifest = await writeManifest(writer, { scopes, files: records });
    await writer.finish();
    // Complete, closed, and only now the archive at `outPath`.
    renameSync(tempPath, opts.outPath);
    return {
      path: opts.outPath,
      scopes,
      manifest,
      fileCount: entries.length - writer.skipped.length,
      bytes,
      unclassifiedDatabases,
      skippedFiles: [...writer.skipped],
    };
  } catch (err) {
    // Close the pipeline before the temp directory goes, so the descriptors
    // and gzip buffers are released with it. `abort()` neither throws nor
    // reports, so `err` — the reason the backup failed, which is what the
    // operator needs — reaches the caller unchanged.
    await writer?.abort();
    throw err;
  } finally {
    // A partial archive is worse than none: it looks restorable until
    // `verifyArchive` reaches a missing `backup.manifest.json`. It never had a
    // name anyone would restore from, and it goes with the temp directory —
    // whatever already sits at `outPath` is untouched by a failed run.
    rmSync(tempDir, { recursive: true, force: true });
    if (!opts.stagingDir) rmSync(stagingRoot, { recursive: true, force: true });
  }
}
