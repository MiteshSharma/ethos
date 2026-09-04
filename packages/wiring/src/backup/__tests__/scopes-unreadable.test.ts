// An unreadable directory must not become an empty one.
//
// `enumerateBackupEntries` swallows ENOENT, and only ENOENT: a directory that
// is not there has nothing to archive. A directory that IS there and cannot be
// read — EACCES, EIO, EMFILE, a corrupt filesystem — is a different fact, and
// treating it as empty produces an archive that completes successfully while
// silently missing everything under it. Nobody learns that until a restore.
//
// The failure is provoked through a `node:fs` mock rather than `chmod 000`:
// mode bits do not stop root, so a suite that runs as root (containers, some
// CI images) would pass the test without ever exercising the path.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackup } from '../create';
import { enumerateBackupEntries } from '../scopes';

/** The one directory the mocked `readdirSync` refuses, by name. */
const UNREADABLE = 'unreadable-team';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: (path: Parameters<typeof actual.readdirSync>[0], options?: unknown) => {
      if (typeof path === 'string' && path.endsWith(UNREADABLE)) {
        const err: NodeJS.ErrnoException = new Error(
          `EACCES: permission denied, scandir '${path}'`,
        );
        err.code = 'EACCES';
        throw err;
      }
      // biome-ignore lint/suspicious/noExplicitAny: passthrough of an overloaded builtin
      return actual.readdirSync(path, options as any);
    },
  };
});

let root: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ethos-backup-unreadable-'));
  dataDir = join(root, 'home');
  mkdirSync(join(dataDir, 'teams', UNREADABLE), { recursive: true });
  writeFileSync(join(dataDir, 'config.yaml'), 'provider: anthropic\n');
  writeFileSync(join(dataDir, 'teams', UNREADABLE, 'manifest.yaml'), 'name: atlas\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('enumerateBackupEntries on a directory it cannot read', () => {
  it('refuses, naming the directory and the error, instead of archiving nothing', () => {
    expect(() => enumerateBackupEntries(dataDir)).toThrowError(
      new RegExp(`Cannot read .*${UNREADABLE}.*EACCES`),
    );
  });

  it('still treats an absent directory as an empty one', () => {
    const result = enumerateBackupEntries(join(root, 'no-such-home'));
    expect(result.entries).toEqual([]);
    expect(result.unclassifiedDatabases).toEqual([]);
  });
});

describe('createBackup on a directory it cannot read', () => {
  it('fails without publishing an archive, leaving the previous one untouched', async () => {
    const out = join(root, 'archive.tar.gz');
    writeFileSync(out, 'the previous good backup');

    await expect(createBackup({ dataDir, outPath: out, snapshot: 'vacuum' })).rejects.toThrow(
      /Cannot read/,
    );

    expect(readFileSync(out, 'utf8')).toBe('the previous good backup');
    expect(existsSync(join(root, 'archive.tar.gz.tmp'))).toBe(false);
  });
});
