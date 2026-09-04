// Backup manifest — written LAST, read by a full pre-pass (plan D3).
//
// The per-file sha256 hashes are computed while the archive streams, so the
// manifest cannot exist until every other entry has been written. That
// ordering is the whole reason restore needs `verifyArchive`: a full pass over
// the archive, hashing as it goes, before a single byte is trusted or written
// anywhere. A truncated archive loses the manifest (or dies mid-entry) and is
// refused; a tampered one fails its hashes and is refused.
//
// JSON, matching the ETHOS.md bundle manifest that already ships in this repo.

import { createHash } from 'node:crypto';
import { EthosError } from '@ethosagent/types';
import { readTarGz, type TarFileRecord, type TarWriter } from './tar';

/** Archive-relative path of the manifest entry. Always the last entry. */
export const MANIFEST_PATH = 'backup.manifest.json';
export const MANIFEST_VERSION = 1;

/** A manifest is metadata; a larger entry under that name is not one. */
const MANIFEST_MAX_BYTES = 16 * 1024 * 1024;

export interface BackupManifest {
  /** Manifest format version, not the Ethos version. */
  version: number;
  /** ISO-8601. */
  createdAt: string;
  /** The scopes the archive was built with, e.g. ['identity', 'state']. */
  scopes: string[];
  /** Every other entry in the archive, in the order it was written. */
  files: TarFileRecord[];
}

function corrupt(detail: string): EthosError {
  return new EthosError({
    code: 'IMPORT_BLOCKED',
    cause: `Backup archive is corrupt: ${detail}`,
    action: 'Restore from a different backup — this archive cannot be trusted.',
  });
}

/**
 * Append the manifest as the final entry. Call after every file has been
 * added and before `writer.finish()`.
 */
export async function writeManifest(
  writer: TarWriter,
  init: { scopes: string[]; files: TarFileRecord[] },
): Promise<BackupManifest> {
  const manifest: BackupManifest = {
    version: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    scopes: [...init.scopes],
    files: [...init.files],
  };
  await writer.addFile(
    MANIFEST_PATH,
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
  );
  return manifest;
}

export function parseManifest(raw: string): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corrupt(`${MANIFEST_PATH} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null) throw corrupt(`${MANIFEST_PATH} is malformed`);
  const obj: Record<string, unknown> = { ...parsed };
  const { version, createdAt, scopes, files } = obj;
  if (typeof version !== 'number' || typeof createdAt !== 'string') {
    throw corrupt(`${MANIFEST_PATH} is missing version or createdAt`);
  }
  if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === 'string')) {
    throw corrupt(`${MANIFEST_PATH} has no readable scope list`);
  }
  if (!Array.isArray(files)) throw corrupt(`${MANIFEST_PATH} has no file list`);
  const records: TarFileRecord[] = [];
  for (const entry of files) {
    if (typeof entry !== 'object' || entry === null)
      throw corrupt(`${MANIFEST_PATH} has a malformed file entry`);
    const { path, size, sha256 } = entry as Record<string, unknown>;
    if (typeof path !== 'string' || typeof size !== 'number' || typeof sha256 !== 'string') {
      throw corrupt(`${MANIFEST_PATH} has a malformed file entry`);
    }
    records.push({ path, size, sha256 });
  }
  return { version, createdAt, scopes, files: records };
}

/**
 * The restore pre-pass: stream the whole archive, hash every entry, and check
 * the result against the manifest. Returns the manifest only if the archive is
 * complete, correctly ordered and byte-for-byte what was written.
 *
 * Hashing happens inside the stream, so this never buffers more than one chunk
 * per entry (plus the manifest itself, which is metadata).
 */
export async function verifyArchive(archivePath: string): Promise<BackupManifest> {
  const seen = new Map<string, { size: number; sha256: string }>();
  let manifestRaw: string | undefined;
  let entriesAfterManifest = 0;

  await readTarGz(archivePath, async (entry, body) => {
    if (entry.path === MANIFEST_PATH) {
      // A second manifest would silently replace the first, and the archive
      // would verify against whichever one the attacker put last.
      if (manifestRaw !== undefined) throw corrupt(`${MANIFEST_PATH} appears more than once`);
      if (entry.size > MANIFEST_MAX_BYTES) throw corrupt(`${MANIFEST_PATH} is implausibly large`);
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(chunk);
      manifestRaw = Buffer.concat(chunks).toString('utf8');
      entriesAfterManifest = 0;
      return;
    }
    // Two entries under one path: `seen` would keep the last, the archive
    // would still verify, and restore would write that destination twice —
    // once with content nothing checked.
    if (seen.has(entry.path)) {
      throw corrupt(`"${entry.path}" appears more than once in the archive`);
    }
    if (manifestRaw !== undefined) entriesAfterManifest++;
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of body) {
      hash.update(chunk);
      size += chunk.length;
    }
    seen.set(entry.path, { size, sha256: hash.digest('hex') });
  });

  if (manifestRaw === undefined) {
    throw corrupt(`${MANIFEST_PATH} is missing — the archive is incomplete`);
  }
  if (entriesAfterManifest > 0) {
    throw corrupt(
      `${entriesAfterManifest} entries follow ${MANIFEST_PATH}, which must be the last entry`,
    );
  }

  const manifest = parseManifest(manifestRaw);
  for (const record of manifest.files) {
    const actual = seen.get(record.path);
    if (!actual)
      throw corrupt(`"${record.path}" is listed in the manifest but missing from the archive`);
    if (actual.size !== record.size || actual.sha256 !== record.sha256) {
      throw corrupt(`"${record.path}" does not match its manifest checksum`);
    }
    seen.delete(record.path);
  }
  const extra = [...seen.keys()].sort()[0];
  if (extra !== undefined) {
    throw corrupt(`"${extra}" is in the archive but not in the manifest`);
  }
  return manifest;
}
