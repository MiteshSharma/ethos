import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MANIFEST_PATH,
  MANIFEST_VERSION,
  parseManifest,
  verifyArchive,
  writeManifest,
} from '../manifest';
import { createTarGzWriter, parseTarBuffer, type TarFileRecord } from '../tar';

let dir: string;
let n = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ethos-manifest-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Build a small archive; `mutate` can doctor the records before they are recorded. */
async function buildArchive(
  files: Array<[string, string]>,
  mutate: (records: TarFileRecord[]) => TarFileRecord[] = (r) => r,
  after: Array<[string, string]> = [],
): Promise<string> {
  const archivePath = join(dir, `archive-${n++}.tar.gz`);
  const writer = createTarGzWriter(archivePath);
  const records: TarFileRecord[] = [];
  for (const [path, content] of files) {
    records.push(await writer.addFile(path, Buffer.from(content, 'utf8')));
  }
  await writeManifest(writer, { scopes: ['identity', 'state'], files: mutate(records) });
  for (const [path, content] of after) {
    await writer.addFile(path, Buffer.from(content, 'utf8'));
  }
  await writer.finish();
  return archivePath;
}

describe('backup manifest', () => {
  it('is the last entry in the archive', async () => {
    const archivePath = await buildArchive([
      ['config.yaml', 'provider: anthropic\n'],
      ['state/sessions.db', 'SQLite format 3\0'],
    ]);
    const { gunzipSync } = await import('node:zlib');
    const entries = await parseTarBuffer(gunzipSync(readFileSync(archivePath)));
    expect(entries.map(([p]) => p)).toEqual(['config.yaml', 'state/sessions.db', MANIFEST_PATH]);
  });

  it('records version, scopes, created-at and a sha256 per file', async () => {
    const archivePath = await buildArchive([['config.yaml', 'provider: anthropic\n']]);
    const manifest = await verifyArchive(archivePath);
    expect(manifest.version).toBe(MANIFEST_VERSION);
    expect(manifest.scopes).toEqual(['identity', 'state']);
    expect(Number.isNaN(Date.parse(manifest.createdAt))).toBe(false);
    expect(manifest.files).toEqual([
      {
        path: 'config.yaml',
        size: 20,
        sha256: createHash('sha256').update('provider: anthropic\n').digest('hex'),
      },
    ]);
  });

  it('refuses an archive whose content does not match its manifest hash', async () => {
    const archivePath = await buildArchive([['config.yaml', 'provider: anthropic\n']], (records) =>
      records.map((r) => ({ ...r, sha256: 'f'.repeat(64) })),
    );
    await expect(verifyArchive(archivePath)).rejects.toThrow(
      'does not match its manifest checksum',
    );
  });

  it('refuses an archive carrying a file the manifest does not list', async () => {
    const archivePath = await buildArchive(
      [
        ['config.yaml', 'provider: anthropic\n'],
        ['smuggled.sh', 'rm -rf /\n'],
      ],
      (records) => records.filter((r) => r.path !== 'smuggled.sh'),
    );
    await expect(verifyArchive(archivePath)).rejects.toThrow(
      '"smuggled.sh" is in the archive but not in the manifest',
    );
  });

  it('refuses an archive missing a file the manifest lists', async () => {
    const archivePath = await buildArchive([['config.yaml', 'x\n']], (records) => [
      ...records,
      { path: 'MEMORY.md', size: 3, sha256: 'a'.repeat(64) },
    ]);
    await expect(verifyArchive(archivePath)).rejects.toThrow(
      'listed in the manifest but missing from the archive',
    );
  });

  it('refuses an archive with entries after the manifest', async () => {
    const archivePath = await buildArchive([['config.yaml', 'x\n']], (r) => r, [
      ['appended.md', 'late\n'],
    ]);
    await expect(verifyArchive(archivePath)).rejects.toThrow('must be the last entry');
  });

  it('refuses a truncated archive', async () => {
    const archivePath = await buildArchive([['config.yaml', 'provider: anthropic\n']]);
    const raw = readFileSync(archivePath);
    const truncated = join(dir, 'truncated.tar.gz');
    writeFileSync(truncated, raw.subarray(0, Math.floor(raw.length / 2)));
    await expect(verifyArchive(truncated)).rejects.toThrow('Backup archive is corrupt');
  });

  it('refuses an archive carrying the same path twice', async () => {
    // Both copies hash correctly and the manifest lists the path once, so
    // nothing but an explicit duplicate check catches this: restore would
    // otherwise write that destination twice, the second time with content the
    // manifest never vouched for.
    const archivePath = join(dir, 'duplicate-entry.tar.gz');
    const writer = createTarGzWriter(archivePath);
    const first = await writer.addFile('config.yaml', Buffer.from('provider: anthropic\n'));
    await writer.addFile('config.yaml', Buffer.from('provider: attacker\n'));
    await writeManifest(writer, { scopes: ['identity'], files: [first] });
    await writer.finish();
    await expect(verifyArchive(archivePath)).rejects.toThrow(
      '"config.yaml" appears more than once in the archive',
    );
  });

  it('refuses an archive carrying two manifests', async () => {
    const archivePath = join(dir, 'duplicate-manifest.tar.gz');
    const writer = createTarGzWriter(archivePath);
    const record = await writer.addFile('config.yaml', Buffer.from('provider: anthropic\n'));
    await writeManifest(writer, { scopes: ['identity'], files: [record] });
    await writeManifest(writer, { scopes: ['identity'], files: [record] });
    await writer.finish();
    await expect(verifyArchive(archivePath)).rejects.toThrow('appears more than once');
  });

  it('refuses an archive with no manifest at all', async () => {
    const archivePath = join(dir, 'no-manifest.tar.gz');
    const writer = createTarGzWriter(archivePath);
    await writer.addFile('config.yaml', Buffer.from('x\n'));
    await writer.finish();
    await expect(verifyArchive(archivePath)).rejects.toThrow(
      'is missing — the archive is incomplete',
    );
  });

  it('rejects a malformed manifest document', () => {
    expect(() => parseManifest('not json')).toThrow('not valid JSON');
    expect(() => parseManifest('{"version":1}')).toThrow('missing version or createdAt');
    expect(() => parseManifest('{"version":1,"createdAt":"now","scopes":["state"]}')).toThrow(
      'has no file list',
    );
  });
});
