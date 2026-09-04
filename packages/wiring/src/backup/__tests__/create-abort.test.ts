// A failed backup must not leak the gzip → file pipeline.
//
// `createBackup` opens a gzip stream piped into the partial archive, and every
// failure after that point — a file that changed size mid-stream, a secrets
// vault that throws, a full disk — used to jump to the `finally`, which only
// removed the temp directory. The streams were never ended or destroyed, so
// the file descriptor and the gzip's internal buffers stayed live until GC, if
// ever. T4 runs `createBackup` from a nightly scheduled job: a recurring
// failure leaks once a night for the life of the process.
//
// A destroyed stream is a closed descriptor, so that is what this observes,
// through the `createWriteStream` the writer opens.

import { mkdirSync, mkdtempSync, rmSync, type WriteStream, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SecretsResolver } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackup } from '../create';

const opened = vi.hoisted(() => [] as WriteStream[]);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createWriteStream: (
      path: Parameters<typeof actual.createWriteStream>[0],
      options?: Parameters<typeof actual.createWriteStream>[1],
    ) => {
      const stream = actual.createWriteStream(path, options);
      opened.push(stream);
      return stream;
    },
  };
});

/** A vault that fails the way a real one can: after the archive is open. */
const failingSecrets: SecretsResolver = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  list: async () => {
    throw new Error('vault unavailable');
  },
};

let root: string;
let dataDir: string;
let out: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ethos-backup-abort-'));
  dataDir = join(root, 'home');
  out = join(root, 'archive.tar.gz');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'config.yaml'), 'provider: anthropic\n');
  writeFileSync(join(dataDir, 'MEMORY.md'), '# project\n');
  opened.length = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('createBackup when it fails part-way', () => {
  it('closes the archive pipeline it opened, and still reports the original failure', async () => {
    // The rejection is the vault's, not one manufactured by the teardown: the
    // error the operator needs is the reason the backup failed.
    await expect(
      createBackup({ dataDir, outPath: out, snapshot: 'vacuum', secrets: failingSecrets }),
    ).rejects.toThrow('vault unavailable');

    // The partial archive was opened, and nothing is still holding it.
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.filter((stream) => !stream.destroyed)).toEqual([]);
  });
});
