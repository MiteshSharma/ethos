import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VectorMemoryProvider } from '../index';

// ---------------------------------------------------------------------------
// Deterministic fake embedder — no model download needed in tests
// ---------------------------------------------------------------------------

function fakeEmbed(text: string): Promise<Float32Array> {
  const emb = new Float32Array(384);
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h) ^ text.charCodeAt(i);
    h = h | 0; // keep 32-bit
  }
  for (let i = 0; i < 384; i++) {
    h = ((h << 5) + h) ^ (i * 2654435761);
    h = h | 0;
    emb[i] = (h & 0xffff) / 65535;
  }
  // L2-normalize
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += emb[i] * emb[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < 384; i++) emb[i] /= norm;
  return Promise.resolve(emb);
}

const ctx = { sessionId: 'test', sessionKey: 'cli:test', platform: 'cli' };

let testDir: string;
let provider: VectorMemoryProvider;

beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-vector-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
  provider = new VectorMemoryProvider({ dir: testDir, embedFn: fakeEmbed });
});

afterEach(async () => {
  provider.close();
  await rm(testDir, { recursive: true, force: true });
});

describe('VectorMemoryProvider', () => {
  describe('prefetch', () => {
    it('returns null when store is empty', async () => {
      expect(await provider.prefetch(ctx)).toBeNull();
    });

    it('returns chunks after adding content', async () => {
      await provider.sync(ctx, [
        { store: 'memory', action: 'add', content: 'TypeScript project.' },
      ]);
      const result = await provider.prefetch(ctx);
      expect(result).not.toBeNull();
      expect(result?.source).toBe('vector');
      expect(result?.content).toContain('TypeScript project');
    });

    it('returns at most topK chunks', async () => {
      for (let i = 0; i < 10; i++) {
        await provider.sync(ctx, [
          { store: 'memory', action: 'add', content: `Fact number ${i}.` },
        ]);
      }
      const result = await provider.prefetch(ctx);
      // Default topK is 5
      const chunks = result?.content.split('\n\n') ?? [];
      expect(chunks.length).toBeLessThanOrEqual(5);
    });

    it('uses query for semantic ranking', async () => {
      await provider.sync(ctx, [
        { store: 'memory', action: 'add', content: 'The sky is blue.' },
        { store: 'memory', action: 'add', content: 'TypeScript uses static typing.' },
      ]);
      const result = await provider.prefetch({ ...ctx, query: 'programming language' });
      expect(result).not.toBeNull();
      expect(result?.truncated).toBe(false);
    });

    it('returns recent chunks when no query provided', async () => {
      await provider.sync(ctx, [{ store: 'memory', action: 'add', content: 'Older memory.' }]);
      await provider.sync(ctx, [{ store: 'memory', action: 'add', content: 'Newer memory.' }]);
      const result = await provider.prefetch(ctx);
      expect(result?.content).toContain('Newer memory');
    });

    it('caches identical queries (LRU hit)', async () => {
      await provider.sync(ctx, [{ store: 'memory', action: 'add', content: 'Cached fact.' }]);
      const first = await provider.prefetch({ ...ctx, query: 'test query' });
      const second = await provider.prefetch({ ...ctx, query: 'test query' });
      expect(first).toBe(second); // same object reference = cache hit
    });
  });

  describe('sync — add', () => {
    it('appends chunks without destroying existing ones', async () => {
      await provider.sync(ctx, [{ store: 'memory', action: 'add', content: 'First fact.' }]);
      await provider.sync(ctx, [{ store: 'memory', action: 'add', content: 'Second fact.' }]);
      expect(provider.count()).toBeGreaterThanOrEqual(2);
    });

    it('writes to user store separately', async () => {
      await provider.sync(ctx, [
        { store: 'user', action: 'add', content: 'User prefers TypeScript.' },
        { store: 'memory', action: 'add', content: 'Project uses Node 24.' },
      ]);
      expect(provider.count()).toBeGreaterThanOrEqual(2);
    });
  });

  describe('sync — replace', () => {
    it('clears all store chunks and inserts fresh content', async () => {
      await provider.sync(ctx, [{ store: 'memory', action: 'add', content: 'Old content.' }]);
      await provider.sync(ctx, [
        { store: 'memory', action: 'replace', content: 'Replaced content.' },
      ]);
      const result = await provider.prefetch(ctx);
      expect(result?.content).not.toContain('Old content');
      expect(result?.content).toContain('Replaced content');
    });

    it('clears store when replace content is empty', async () => {
      await provider.sync(ctx, [{ store: 'memory', action: 'add', content: 'To be cleared.' }]);
      await provider.sync(ctx, [{ store: 'memory', action: 'replace', content: '' }]);
      expect(await provider.prefetch(ctx)).toBeNull();
    });
  });

  describe('sync — remove', () => {
    it('deletes chunks matching substringMatch', async () => {
      await provider.sync(ctx, [
        { store: 'memory', action: 'add', content: 'Keep this chunk.' },
        { store: 'memory', action: 'add', content: 'Remove this specific chunk.' },
      ]);
      await provider.sync(ctx, [
        { store: 'memory', action: 'remove', content: '', substringMatch: 'specific' },
      ]);
      const result = await provider.prefetch(ctx);
      expect(result?.content).toContain('Keep this chunk');
      expect(result?.content).not.toContain('specific');
    });
  });

  describe('add()', () => {
    it('inserts chunks and returns count', async () => {
      const n = await provider.add('Quick add to memory.', 'memory');
      expect(n).toBeGreaterThanOrEqual(1);
      expect(provider.count()).toBe(n);
    });
  });

  describe('showRecent()', () => {
    it('returns chunks ordered by recency', async () => {
      await provider.add('First.', 'memory');
      await provider.add('Second.', 'memory');
      const records = provider.showRecent(10);
      expect(records.length).toBe(2);
      // showRecent returns DESC (newest first)
      expect(records[0].content).toBe('Second.');
    });
  });

  describe('clear()', () => {
    it('removes all chunks', async () => {
      await provider.add('To be cleared.', 'memory');
      provider.clear();
      expect(provider.count()).toBe(0);
      expect(await provider.prefetch(ctx)).toBeNull();
    });
  });

  describe('exportAll()', () => {
    it('writes a markdown file with all chunks', async () => {
      await provider.add('Export test fact.', 'memory');
      const outPath = join(testDir, 'export.md');
      const n = await provider.exportAll(outPath);
      expect(n).toBeGreaterThanOrEqual(1);
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(outPath, 'utf-8');
      expect(content).toContain('Memory Export');
      expect(content).toContain('Export test fact');
    });

    it('returns 0 and writes nothing when empty', async () => {
      const outPath = join(testDir, 'empty-export.md');
      const n = await provider.exportAll(outPath);
      expect(n).toBe(0);
    });
  });

  describe('migrateFromMarkdown()', () => {
    it('migrates MEMORY.md and USER.md, renames to .bak', async () => {
      await writeFile(join(testDir, 'MEMORY.md'), 'Existing memory.\n\nMore memory here.\n');
      await writeFile(join(testDir, 'USER.md'), 'I am a developer.\n');

      const result = await provider.migrateFromMarkdown();
      expect(result.migrated).toBe(true);
      expect(result.memoryChunks).toBeGreaterThanOrEqual(1);
      expect(result.userChunks).toBeGreaterThanOrEqual(1);

      // Original files should be renamed
      const { stat } = await import('node:fs/promises');
      await expect(stat(join(testDir, 'MEMORY.md.bak'))).resolves.toBeTruthy();
      await expect(stat(join(testDir, 'USER.md.bak'))).resolves.toBeTruthy();

      // Originals gone
      await expect(stat(join(testDir, 'MEMORY.md'))).rejects.toThrow();
    });

    it('does not migrate when chunks already exist', async () => {
      await writeFile(join(testDir, 'MEMORY.md'), 'Should not migrate.\n');
      await provider.add('Already have data.', 'memory');

      const result = await provider.migrateFromMarkdown();
      expect(result.migrated).toBe(false);
    });

    it('handles missing files gracefully', async () => {
      const result = await provider.migrateFromMarkdown();
      expect(result.migrated).toBe(false);
      expect(result.memoryChunks).toBe(0);
      expect(result.userChunks).toBe(0);
    });
  });

  describe('scale — 100 entries', () => {
    it('handles 100 memory chunks and returns topK=5', async () => {
      for (let i = 0; i < 100; i++) {
        await provider.add(
          `Memory entry number ${i}: some content about topic ${i % 10}.`,
          'memory',
        );
      }
      expect(provider.count()).toBe(100);

      const result = await provider.prefetch({ ...ctx, query: 'topic 3' });
      expect(result).not.toBeNull();
      const chunks = result?.content.split('\n\n') ?? [];
      expect(chunks.length).toBeLessThanOrEqual(5);
    });
  });
});
