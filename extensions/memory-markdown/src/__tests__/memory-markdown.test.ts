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
});
