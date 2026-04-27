import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MarkdownFileMemoryProvider } from '../index';

const ctx = {
  sessionId: 'test',
  sessionKey: 'cli:test',
  platform: 'cli',
};

let testDir: string;
let provider: MarkdownFileMemoryProvider;

beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-memory-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
  provider = new MarkdownFileMemoryProvider({ dir: testDir });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('MarkdownFileMemoryProvider', () => {
  describe('prefetch', () => {
    it('returns null when no files exist', async () => {
      expect(await provider.prefetch(ctx)).toBeNull();
    });

    it('returns USER.md content when present', async () => {
      await writeFile(join(testDir, 'USER.md'), 'I am a senior engineer.');
      const result = await provider.prefetch(ctx);
      expect(result).not.toBeNull();
      expect(result?.content).toContain('senior engineer');
      expect(result?.source).toBe('markdown');
      expect(result?.truncated).toBe(false);
    });

    it('returns MEMORY.md content when present', async () => {
      await writeFile(join(testDir, 'MEMORY.md'), 'Working on ethos project.');
      const result = await provider.prefetch(ctx);
      expect(result?.content).toContain('Working on ethos project');
    });

    it('combines both files with section headers', async () => {
      await writeFile(join(testDir, 'USER.md'), 'Senior engineer.');
      await writeFile(join(testDir, 'MEMORY.md'), 'Working on ethos.');
      const result = await provider.prefetch(ctx);
      expect(result?.content).toContain('## About You');
      expect(result?.content).toContain('## Memory');
      expect(result?.content).toContain('Senior engineer');
      expect(result?.content).toContain('Working on ethos');
    });

    it('truncates and marks truncated=true when content exceeds maxChars', async () => {
      const longContent = 'x'.repeat(500);
      await writeFile(join(testDir, 'MEMORY.md'), longContent);
      const smallProvider = new MarkdownFileMemoryProvider({ dir: testDir, maxChars: 100 });
      const result = await smallProvider.prefetch(ctx);
      expect(result?.truncated).toBe(true);
      expect(result?.content.length).toBeLessThanOrEqual(120); // truncated marker + tail
    });
  });

  describe('sync — add', () => {
    it('creates MEMORY.md and appends content', async () => {
      await provider.sync(ctx, [{ store: 'memory', action: 'add', content: 'Fact one.' }]);
      const content = await readFile(join(testDir, 'MEMORY.md'), 'utf-8');
      expect(content).toContain('Fact one.');
    });

    it('appends to existing content without destroying it', async () => {
      await writeFile(join(testDir, 'MEMORY.md'), 'Existing fact.\n');
      await provider.sync(ctx, [{ store: 'memory', action: 'add', content: 'New fact.' }]);
      const content = await readFile(join(testDir, 'MEMORY.md'), 'utf-8');
      expect(content).toContain('Existing fact.');
      expect(content).toContain('New fact.');
    });

    it('writes USER.md for user store', async () => {
      await provider.sync(ctx, [{ store: 'user', action: 'add', content: 'Prefers TypeScript.' }]);
      const content = await readFile(join(testDir, 'USER.md'), 'utf-8');
      expect(content).toContain('Prefers TypeScript.');
    });

    it('processes multiple updates in order', async () => {
      await provider.sync(ctx, [
        { store: 'memory', action: 'add', content: 'First.' },
        { store: 'memory', action: 'add', content: 'Second.' },
      ]);
      const content = await readFile(join(testDir, 'MEMORY.md'), 'utf-8');
      expect(content.indexOf('First.')).toBeLessThan(content.indexOf('Second.'));
    });
  });

  describe('sync — replace', () => {
    it('replaces entire file content', async () => {
      await writeFile(join(testDir, 'MEMORY.md'), 'Old content.\n');
      await provider.sync(ctx, [{ store: 'memory', action: 'replace', content: 'Brand new.' }]);
      const content = await readFile(join(testDir, 'MEMORY.md'), 'utf-8');
      expect(content.trim()).toBe('Brand new.');
    });
  });

  describe('sync — remove', () => {
    it('removes lines containing substringMatch', async () => {
      await writeFile(
        join(testDir, 'MEMORY.md'),
        'Keep this line.\nRemove this specific line.\nKeep this too.\n',
      );
      await provider.sync(ctx, [
        { store: 'memory', action: 'remove', content: '', substringMatch: 'specific' },
      ]);
      const content = await readFile(join(testDir, 'MEMORY.md'), 'utf-8');
      expect(content).toContain('Keep this line.');
      expect(content).not.toContain('Remove this specific line.');
      expect(content).toContain('Keep this too.');
    });
  });

  // Memory scope isolation — see plan/IMPROVEMENT.md P2-1.
  // The "memory scope per personality" promise on the landing page depends on
  // these tests. If any of them break, a personality marked `per-personality`
  // is leaking into the global pool.

  describe('memoryScope: per-personality', () => {
    const reviewerCtx = {
      ...ctx,
      personalityId: 'reviewer',
      memoryScope: 'per-personality' as const,
    };
    const operatorCtx = {
      ...ctx,
      personalityId: 'operator',
      memoryScope: 'per-personality' as const,
    };
    const coachCtx = {
      ...ctx,
      personalityId: 'coach',
      memoryScope: 'global' as const,
    };

    it('writes per-personality MEMORY.md to the personality subdirectory', async () => {
      await provider.sync(reviewerCtx, [
        { store: 'memory', action: 'add', content: 'Reviewer-only fact.' },
      ]);
      const personalityFile = await readFile(
        join(testDir, 'personalities', 'reviewer', 'MEMORY.md'),
        'utf-8',
      );
      expect(personalityFile).toContain('Reviewer-only fact.');
    });

    it('per-personality writes never appear in the shared MEMORY.md', async () => {
      await provider.sync(reviewerCtx, [
        { store: 'memory', action: 'add', content: 'Reviewer-only fact.' },
      ]);
      // Shared MEMORY.md should not exist or should not contain the reviewer fact
      const sharedExists = await readFile(join(testDir, 'MEMORY.md'), 'utf-8').catch(() => null);
      if (sharedExists !== null) {
        expect(sharedExists).not.toContain('Reviewer-only fact.');
      }
    });

    it('two per-personality scopes do not cross-contaminate', async () => {
      await provider.sync(reviewerCtx, [
        { store: 'memory', action: 'add', content: 'Reviewer fact.' },
      ]);
      await provider.sync(operatorCtx, [
        { store: 'memory', action: 'add', content: 'Operator fact.' },
      ]);

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

    it('global personality writes still go to the shared MEMORY.md', async () => {
      await provider.sync(coachCtx, [
        { store: 'memory', action: 'add', content: 'Coach observation.' },
      ]);
      const shared = await readFile(join(testDir, 'MEMORY.md'), 'utf-8');
      expect(shared).toContain('Coach observation.');
    });

    it('per-personality prefetch reads only that personality plus shared USER.md', async () => {
      // Seed: reviewer's per-personality memory + a global memory + a shared user file
      await provider.sync(reviewerCtx, [
        { store: 'memory', action: 'add', content: 'Reviewer-only fact.' },
      ]);
      await provider.sync(coachCtx, [
        { store: 'memory', action: 'add', content: 'Global coach fact.' },
      ]);
      await writeFile(join(testDir, 'USER.md'), 'I prefer TypeScript.');

      const result = await provider.prefetch(reviewerCtx);
      expect(result?.content).toContain('Reviewer-only fact.');
      expect(result?.content).not.toContain('Global coach fact.');
      expect(result?.content).toContain('I prefer TypeScript.');
    });

    it('USER.md is shared even for per-personality scope (it describes the human)', async () => {
      await provider.sync(reviewerCtx, [
        { store: 'user', action: 'add', content: 'Senior engineer.' },
      ]);
      // Should land in shared USER.md, not in the personality subdirectory
      const sharedUser = await readFile(join(testDir, 'USER.md'), 'utf-8');
      expect(sharedUser).toContain('Senior engineer.');
      const isolatedUser = await readFile(
        join(testDir, 'personalities', 'reviewer', 'USER.md'),
        'utf-8',
      ).catch(() => null);
      expect(isolatedUser).toBeNull();
    });

    it('rejects unsafe personality ids by falling back to the shared root (no path traversal)', async () => {
      const evilCtx = {
        ...ctx,
        personalityId: '../etc/passwd',
        memoryScope: 'per-personality' as const,
      };
      await provider.sync(evilCtx, [{ store: 'memory', action: 'add', content: 'Evil fact.' }]);
      // Must NOT have created files outside testDir
      const escaped = await readFile(
        join(testDir, '..', 'etc', 'passwd', 'MEMORY.md'),
        'utf-8',
      ).catch(() => null);
      expect(escaped).toBeNull();
      // Falls back to shared (safer than silently dropping the write)
      const shared = await readFile(join(testDir, 'MEMORY.md'), 'utf-8');
      expect(shared).toContain('Evil fact.');
    });
  });
});
