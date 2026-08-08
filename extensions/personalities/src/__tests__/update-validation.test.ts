import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilePersonalityRegistry } from '../index';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-validate-${Date.now()}-${randomBytes(4).toString('hex')}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function seedPersonality(id: string): Promise<void> {
  const dir = join(testDir, 'personalities', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'config.yaml'), `name: ${id}\n`);
  await writeFile(join(dir, 'SOUL.md'), `# ${id}\n\nIdentity.\n`);
  await writeFile(join(dir, 'toolset.yaml'), '- read_file\n');
}

function makeRegistry(): FilePersonalityRegistry {
  return new FilePersonalityRegistry(new FsStorage(), testDir);
}

describe('update validation rejects bad inputs', () => {
  describe('fs_reach validation', () => {
    it('rejects path traversal (..) in fs_reach', async () => {
      await seedPersonality('v-dotdot');
      const registry = makeRegistry();
      await registry.loadFromDirectory(join(testDir, 'personalities'));

      await expect(registry.update('v-dotdot', { fs_reach: { read: ['..'] } })).rejects.toThrow(
        /fs_reach/,
      );
    });

    it('rejects bare root (/) in fs_reach', async () => {
      await seedPersonality('v-bare-root');
      const registry = makeRegistry();
      await registry.loadFromDirectory(join(testDir, 'personalities'));

      await expect(registry.update('v-bare-root', { fs_reach: { read: ['/'] } })).rejects.toThrow(
        /fs_reach/,
      );
    });

    it('rejects relative path without leading / or token', async () => {
      await seedPersonality('v-relative');
      const registry = makeRegistry();
      await registry.loadFromDirectory(join(testDir, 'personalities'));

      await expect(
        registry.update('v-relative', { fs_reach: { read: ['relative/path'] } }),
      ).rejects.toThrow(/fs_reach/);
    });

    it('rejects paths with newlines (YAML injection)', async () => {
      await seedPersonality('v-newline');
      const registry = makeRegistry();
      await registry.loadFromDirectory(join(testDir, 'personalities'));

      await expect(
        registry.update('v-newline', { fs_reach: { read: ['/tmp\nprovider: azure'] } }),
      ).rejects.toThrow(/invalid characters/);
    });

    it('rejects paths with commas (list separator injection)', async () => {
      await seedPersonality('v-comma');
      const registry = makeRegistry();
      await registry.loadFromDirectory(join(testDir, 'personalities'));

      await expect(
        registry.update('v-comma', { fs_reach: { read: ['/data,/etc/passwd'] } }),
      ).rejects.toThrow(/invalid characters/);
    });

    it('rejects tilde path (~) without leading / or token', async () => {
      await seedPersonality('v-tilde');
      const registry = makeRegistry();
      await registry.loadFromDirectory(join(testDir, 'personalities'));

      await expect(registry.update('v-tilde', { fs_reach: { read: ['~/home'] } })).rejects.toThrow(
        /fs_reach/,
      );
    });

    // workdir lands in both derived reach lists, so it must clear the same bar
    // as read/write — an unvalidated workdir is a hole straight through this
    // guard.
    it('rejects path traversal (..) in workdir', async () => {
      await seedPersonality('v-workdir-dotdot');
      const registry = makeRegistry();
      await registry.loadFromDirectory(join(testDir, 'personalities'));

      await expect(
        registry.update('v-workdir-dotdot', { fs_reach: { workdir: '/srv/../etc' } }),
      ).rejects.toThrow(/fs_reach/);
    });

    it('rejects null bytes in workdir', async () => {
      await seedPersonality('v-workdir-nul');
      const registry = makeRegistry();
      await registry.loadFromDirectory(join(testDir, 'personalities'));

      await expect(
        registry.update('v-workdir-nul', { fs_reach: { workdir: '/srv/documents\0/etc' } }),
      ).rejects.toThrow(/invalid characters/);
    });
  });

  describe('capabilities validation', () => {
    it('rejects tags with spaces', async () => {
      await seedPersonality('v-cap-space');
      const registry = makeRegistry();
      await registry.loadFromDirectory(join(testDir, 'personalities'));

      await expect(registry.update('v-cap-space', { capabilities: ['has space'] })).rejects.toThrow(
        /capabilities tag/,
      );
    });

    it('rejects tags with commas', async () => {
      await seedPersonality('v-cap-comma');
      const registry = makeRegistry();
      await registry.loadFromDirectory(join(testDir, 'personalities'));

      await expect(registry.update('v-cap-comma', { capabilities: ['a,b'] })).rejects.toThrow(
        /capabilities tag/,
      );
    });
  });

  describe('provider validation', () => {
    it('rejects unrecognized provider', async () => {
      await seedPersonality('v-bad-prov');
      const registry = makeRegistry();
      await registry.loadFromDirectory(join(testDir, 'personalities'));

      await expect(registry.update('v-bad-prov', { provider: 'made-up' })).rejects.toThrow(
        /provider/,
      );
    });

    it('accepts valid provider (anthropic)', async () => {
      await seedPersonality('v-good-prov');
      const registry = makeRegistry();
      await registry.loadFromDirectory(join(testDir, 'personalities'));

      await expect(
        registry.update('v-good-prov', { provider: 'anthropic' }),
      ).resolves.not.toThrow();
    });

    it('accepts empty string provider (clearing)', async () => {
      await seedPersonality('v-clear-prov');
      const registry = makeRegistry();
      await registry.loadFromDirectory(join(testDir, 'personalities'));

      await expect(registry.update('v-clear-prov', { provider: '' })).resolves.not.toThrow();
    });
  });
});
