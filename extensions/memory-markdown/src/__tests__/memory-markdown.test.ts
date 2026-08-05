import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import type { MemoryContext } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MarkdownFileMemoryProvider } from '../index';

const globalCtx: MemoryContext = {
  scopeId: 'personality:test',
  sessionId: 'test',
  sessionKey: 'cli:test',
  platform: 'cli',
  workingDir: '/tmp',
};

let testDir: string;
/** The scoped directory where personality:test files live. */
let scopeDir: string;
let provider: MarkdownFileMemoryProvider;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `ethos-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  scopeDir = join(testDir, 'personalities', 'test');
  await mkdir(scopeDir, { recursive: true });
  provider = new MarkdownFileMemoryProvider({ dir: testDir, storage: new FsStorage() });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('MarkdownFileMemoryProvider', () => {
  describe('prefetch', () => {
    it('returns null when no files exist', async () => {
      expect(await provider.prefetch(globalCtx)).toBeNull();
    });

    it('returns USER.md as an entry when present', async () => {
      await writeFile(join(scopeDir, 'USER.md'), 'I am a senior engineer.');
      const result = await provider.prefetch(globalCtx);
      expect(result).not.toBeNull();
      const userEntry = result?.entries.find((e) => e.key === 'USER.md');
      expect(userEntry?.content).toContain('senior engineer');
    });

    it('returns MEMORY.md as an entry when present', async () => {
      await writeFile(join(scopeDir, 'MEMORY.md'), 'Working on ethos project.');
      const result = await provider.prefetch(globalCtx);
      const memEntry = result?.entries.find((e) => e.key === 'MEMORY.md');
      expect(memEntry?.content).toContain('Working on ethos project');
    });

    it('returns both files as separate entries when present', async () => {
      await writeFile(join(scopeDir, 'USER.md'), 'Senior engineer.');
      await writeFile(join(scopeDir, 'MEMORY.md'), 'Working on ethos.');
      const result = await provider.prefetch(globalCtx);
      expect(result?.entries.length).toBe(2);
      expect(result?.entries.map((e) => e.key).sort()).toEqual(['MEMORY.md', 'USER.md']);
    });

    it('skips empty/whitespace-only files', async () => {
      await writeFile(join(scopeDir, 'MEMORY.md'), '   \n\n');
      expect(await provider.prefetch(globalCtx)).toBeNull();
    });
  });

  describe('read', () => {
    it('returns null when the key is missing', async () => {
      expect(await provider.read('MEMORY.md', globalCtx)).toBeNull();
    });

    it('returns the entry when the key exists', async () => {
      await writeFile(join(scopeDir, 'MEMORY.md'), 'cached fact');
      const entry = await provider.read('MEMORY.md', globalCtx);
      expect(entry?.key).toBe('MEMORY.md');
      expect(entry?.content).toContain('cached fact');
      expect(typeof entry?.metadata?.lastUpdatedAt).toBe('number');
    });

    it('rejects unsafe keys', async () => {
      expect(await provider.read('../etc/passwd', globalCtx)).toBeNull();
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      await writeFile(join(scopeDir, 'MEMORY.md'), 'TypeScript is great\nUse Biome for linting');
      await writeFile(join(scopeDir, 'USER.md'), 'I love TypeScript');
    });

    it('returns matching entries (case-insensitive substring)', async () => {
      const matches = await provider.search('typescript', globalCtx);
      expect(matches.length).toBe(2);
    });

    it('honors limit', async () => {
      const matches = await provider.search('typescript', globalCtx, { limit: 1 });
      expect(matches.length).toBe(1);
    });

    it('returns [] for semantic mode (not supported)', async () => {
      expect(await provider.search('typescript', globalCtx, { mode: 'semantic' })).toEqual([]);
    });

    it('returns [] for empty query', async () => {
      expect(await provider.search('   ', globalCtx)).toEqual([]);
    });
  });

  describe('list', () => {
    it('returns refs for all .md files in the scope dir', async () => {
      await writeFile(join(scopeDir, 'USER.md'), 'about me');
      await writeFile(join(scopeDir, 'MEMORY.md'), 'memory');
      await writeFile(join(scopeDir, 'NOTES.md'), 'notes');
      const refs = await provider.list(globalCtx);
      const keys = refs.map((r) => r.key).sort();
      expect(keys).toEqual(['MEMORY.md', 'NOTES.md', 'USER.md']);
    });

    it('attaches summaries when withSummaries is true', async () => {
      await writeFile(join(scopeDir, 'MEMORY.md'), 'First paragraph.\n\nSecond paragraph.');
      const refs = await provider.list(globalCtx, { withSummaries: true });
      const memRef = refs.find((r) => r.key === 'MEMORY.md');
      expect(memRef?.summary).toBe('First paragraph.');
    });

    it('honors limit', async () => {
      await writeFile(join(scopeDir, 'A.md'), 'a');
      await writeFile(join(scopeDir, 'B.md'), 'b');
      await writeFile(join(scopeDir, 'C.md'), 'c');
      const refs = await provider.list(globalCtx, { limit: 2 });
      expect(refs.length).toBe(2);
    });
  });

  describe('sync — add', () => {
    it('creates MEMORY.md and appends content', async () => {
      await provider.sync([{ action: 'add', key: 'MEMORY.md', content: 'Fact one.' }], globalCtx);
      const content = await readFile(join(scopeDir, 'MEMORY.md'), 'utf-8');
      expect(content).toContain('Fact one.');
    });

    it('appends to existing content without destroying it', async () => {
      await writeFile(join(scopeDir, 'MEMORY.md'), 'Existing fact.\n');
      await provider.sync([{ action: 'add', key: 'MEMORY.md', content: 'New fact.' }], globalCtx);
      const content = await readFile(join(scopeDir, 'MEMORY.md'), 'utf-8');
      expect(content).toContain('Existing fact.');
      expect(content).toContain('New fact.');
    });

    it('writes USER.md to the scope directory', async () => {
      await provider.sync(
        [{ action: 'add', key: 'USER.md', content: 'Prefers TypeScript.' }],
        globalCtx,
      );
      const content = await readFile(join(scopeDir, 'USER.md'), 'utf-8');
      expect(content).toContain('Prefers TypeScript.');
    });

    it('processes multiple updates in order', async () => {
      await provider.sync(
        [
          { action: 'add', key: 'MEMORY.md', content: 'First.' },
          { action: 'add', key: 'MEMORY.md', content: 'Second.' },
        ],
        globalCtx,
      );
      const content = await readFile(join(scopeDir, 'MEMORY.md'), 'utf-8');
      expect(content.indexOf('First.')).toBeLessThan(content.indexOf('Second.'));
    });
  });

  describe('sync — replace', () => {
    it('replaces entire file content', async () => {
      await writeFile(join(scopeDir, 'MEMORY.md'), 'Old content.\n');
      await provider.sync(
        [{ action: 'replace', key: 'MEMORY.md', content: 'Brand new.' }],
        globalCtx,
      );
      const content = await readFile(join(scopeDir, 'MEMORY.md'), 'utf-8');
      expect(content.trim()).toBe('Brand new.');
    });
  });

  describe('sync — remove', () => {
    it('removes lines containing substringMatch', async () => {
      await writeFile(
        join(scopeDir, 'MEMORY.md'),
        'Keep this line.\nRemove this specific line.\nKeep this too.\n',
      );
      await provider.sync(
        [{ action: 'remove', key: 'MEMORY.md', substringMatch: 'specific' }],
        globalCtx,
      );
      const content = await readFile(join(scopeDir, 'MEMORY.md'), 'utf-8');
      expect(content).toContain('Keep this line.');
      expect(content).not.toContain('Remove this specific line.');
      expect(content).toContain('Keep this too.');
    });
  });

  describe('sync — delete', () => {
    it('removes the file entirely', async () => {
      await writeFile(join(scopeDir, 'MEMORY.md'), 'goodbye');
      await provider.sync([{ action: 'delete', key: 'MEMORY.md' }], globalCtx);
      const exists = await readFile(join(scopeDir, 'MEMORY.md'), 'utf-8').catch(() => null);
      expect(exists).toBeNull();
    });
  });

  describe('sync — unsafe keys', () => {
    it('throws instead of silently dropping a key with a path separator', async () => {
      await expect(
        provider.sync([{ action: 'replace', key: 'postmortems/abc.md', content: 'x' }], globalCtx),
      ).rejects.toThrow(/unsafe memory key/);
    });

    it('does not write any key in the batch when one key is unsafe', async () => {
      await expect(
        provider.sync(
          [
            { action: 'replace', key: 'MEMORY.md', content: 'safe' },
            { action: 'replace', key: '../escape.md', content: 'unsafe' },
          ],
          globalCtx,
        ),
      ).rejects.toThrow(/unsafe memory key/);
      const written = await readFile(join(scopeDir, 'MEMORY.md'), 'utf-8').catch(() => null);
      expect(written).toBeNull();
    });

    it('accepts a flat postmortem key', async () => {
      await provider.sync(
        [{ action: 'replace', key: 'postmortem-bda3f812.md', content: '# bounced' }],
        globalCtx,
      );
      const content = await readFile(join(scopeDir, 'postmortem-bda3f812.md'), 'utf-8');
      expect(content).toContain('# bounced');
    });
  });

  // Memory scope isolation — see plan/IMPROVEMENT.md P2-1.
  // The "memory scope per personality" promise on the landing page depends on
  // these tests. If any of them break, a personality marked `per-personality`
  // is leaking into the global pool.

  describe('scope: personality:<id>', () => {
    const reviewerCtx: MemoryContext = {
      ...globalCtx,
      scopeId: 'personality:reviewer',
    };
    const operatorCtx: MemoryContext = {
      ...globalCtx,
      scopeId: 'personality:operator',
    };
    const coachCtx: MemoryContext = {
      ...globalCtx,
      scopeId: 'personality:coach',
    };

    it('writes per-personality MEMORY.md to the personality subdirectory', async () => {
      await provider.sync(
        [{ action: 'add', key: 'MEMORY.md', content: 'Reviewer-only fact.' }],
        reviewerCtx,
      );
      const personalityFile = await readFile(
        join(testDir, 'personalities', 'reviewer', 'MEMORY.md'),
        'utf-8',
      );
      expect(personalityFile).toContain('Reviewer-only fact.');
    });

    it('per-personality writes never appear in another personality scope', async () => {
      await provider.sync(
        [{ action: 'add', key: 'MEMORY.md', content: 'Reviewer-only fact.' }],
        reviewerCtx,
      );
      const coachEntry = await provider.read('MEMORY.md', coachCtx);
      expect(coachEntry).toBeNull();
    });

    it('two per-personality scopes do not cross-contaminate', async () => {
      await provider.sync(
        [{ action: 'add', key: 'MEMORY.md', content: 'Reviewer fact.' }],
        reviewerCtx,
      );
      await provider.sync(
        [{ action: 'add', key: 'MEMORY.md', content: 'Operator fact.' }],
        operatorCtx,
      );

      const reviewerFile = await readFile(
        join(testDir, 'personalities', 'reviewer', 'MEMORY.md'),
        'utf-8',
      );
      const operatorFile = await readFile(
        join(testDir, 'personalities', 'operator', 'MEMORY.md'),
        'utf-8',
      );

      expect(reviewerFile).toContain('Reviewer fact.');
      expect(reviewerFile).not.toContain('Operator fact.');
      expect(operatorFile).toContain('Operator fact.');
      expect(operatorFile).not.toContain('Reviewer fact.');
    });

    it('per-personality prefetch reads only that personality scope', async () => {
      await provider.sync(
        [{ action: 'add', key: 'MEMORY.md', content: 'Reviewer-only fact.' }],
        reviewerCtx,
      );
      await provider.sync([{ action: 'add', key: 'MEMORY.md', content: 'Coach fact.' }], coachCtx);

      const result = await provider.prefetch(reviewerCtx);
      const all = result?.entries.map((e) => e.content).join('\n') ?? '';
      expect(all).toContain('Reviewer-only fact.');
      expect(all).not.toContain('Coach fact.');
    });

    it('USER.md is scoped per-personality (lives in personality subdirectory)', async () => {
      await provider.sync(
        [{ action: 'add', key: 'USER.md', content: 'Senior engineer.' }],
        reviewerCtx,
      );
      const personalityUser = await readFile(
        join(testDir, 'personalities', 'reviewer', 'USER.md'),
        'utf-8',
      );
      expect(personalityUser).toContain('Senior engineer.');
      // Should NOT be in the shared root
      const sharedUser = await readFile(join(testDir, 'USER.md'), 'utf-8').catch(() => null);
      expect(sharedUser).toBeNull();
    });

    it('rejects unsafe personality ids with an error (no path traversal)', async () => {
      const evilCtx: MemoryContext = {
        ...globalCtx,
        scopeId: 'personality:../etc/passwd',
      };
      await expect(
        provider.sync([{ action: 'add', key: 'MEMORY.md', content: 'Evil fact.' }], evilCtx),
      ).rejects.toThrow('unrecognised memory scope');
      const escaped = await readFile(
        join(testDir, '..', 'etc', 'passwd', 'MEMORY.md'),
        'utf-8',
      ).catch(() => null);
      expect(escaped).toBeNull();
    });

    it('unrecognised scope prefix throws', async () => {
      const badCtx: MemoryContext = {
        ...globalCtx,
        scopeId: 'global',
      };
      await expect(
        provider.sync([{ action: 'add', key: 'MEMORY.md', content: 'Bad.' }], badCtx),
      ).rejects.toThrow('unrecognised memory scope');
    });
  });
});
