import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import type { MemoryContext } from '@ethosagent/types';
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

const ctx: MemoryContext = {
  scopeId: 'global',
  sessionId: 'test',
  sessionKey: 'cli:test',
  platform: 'cli',
  workingDir: '/tmp',
};

let testDir: string;
let provider: VectorMemoryProvider;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `ethos-vector-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(testDir, { recursive: true });
  provider = new VectorMemoryProvider({
    dir: testDir,
    embedFn: fakeEmbed,
    storage: new FsStorage(),
  });
});

afterEach(async () => {
  provider.close();
  await rm(testDir, { recursive: true, force: true });
});

describe('VectorMemoryProvider', () => {
  describe('prefetch', () => {
    it('returns null (vector store is search-driven, not bulk-read)', async () => {
      await provider.sync([{ action: 'add', key: 'fact', content: 'TypeScript project.' }], ctx);
      expect(await provider.prefetch(ctx)).toBeNull();
    });
  });

  describe('read', () => {
    it('returns null when the key is missing', async () => {
      expect(await provider.read('missing', ctx)).toBeNull();
    });

    it('returns the stored entry', async () => {
      await provider.sync([{ action: 'add', key: 'fact', content: 'TypeScript' }], ctx);
      const entry = await provider.read('fact', ctx);
      expect(entry?.key).toBe('fact');
      expect(entry?.content).toBe('TypeScript');
    });

    it('does not cross scope boundaries', async () => {
      await provider.sync([{ action: 'add', key: 'fact', content: 'A' }], {
        ...ctx,
        scopeId: 'team:alpha',
      });
      expect(await provider.read('fact', ctx)).toBeNull();
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      await provider.sync(
        [
          { action: 'add', key: 'lang', content: 'TypeScript uses static typing.' },
          { action: 'add', key: 'sky', content: 'The sky is blue today.' },
        ],
        ctx,
      );
    });

    it('returns at most `limit` semantic results', async () => {
      const results = await provider.search('programming language', ctx, { limit: 1 });
      expect(results.length).toBe(1);
    });

    it('keyword mode does literal substring match', async () => {
      const results = await provider.search('static', ctx, { mode: 'keyword' });
      expect(results.length).toBe(1);
      expect(results[0]?.content).toContain('static');
    });

    it('hybrid mode unions semantic + keyword and dedupes by key', async () => {
      const results = await provider.search('static', ctx, { mode: 'hybrid', limit: 5 });
      const keys = results.map((r) => r.key);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('returns [] for empty query', async () => {
      expect(await provider.search('   ', ctx)).toEqual([]);
    });
  });

  describe('list', () => {
    it('returns entry refs ordered by insertion', async () => {
      await provider.sync([{ action: 'add', key: 'one', content: 'first' }], ctx);
      await provider.sync([{ action: 'add', key: 'two', content: 'second' }], ctx);
      const refs = await provider.list(ctx);
      expect(refs.map((r) => r.key)).toEqual(['one', 'two']);
    });

    it('honors limit', async () => {
      for (let i = 0; i < 5; i++) {
        await provider.sync([{ action: 'add', key: `k${i}`, content: `c${i}` }], ctx);
      }
      const refs = await provider.list(ctx, { limit: 2 });
      expect(refs.length).toBe(2);
    });

    it('attaches summaries when requested', async () => {
      await provider.sync(
        [{ action: 'add', key: 'doc', content: 'Heading paragraph.\n\nDetails.' }],
        ctx,
      );
      const refs = await provider.list(ctx, { withSummaries: true });
      expect(refs[0]?.summary).toBe('Heading paragraph.');
    });
  });

  describe('sync — add/replace', () => {
    it('add inserts a row', async () => {
      await provider.sync([{ action: 'add', key: 'k1', content: 'first' }], ctx);
      expect(provider.count()).toBe(1);
    });

    it('add appends to existing content', async () => {
      await provider.sync([{ action: 'add', key: 'k1', content: 'line one' }], ctx);
      await provider.sync([{ action: 'add', key: 'k1', content: 'line two' }], ctx);
      const entry = await provider.read('k1', ctx);
      expect(entry?.content).toBe('line one\nline two');
      expect(provider.count()).toBe(1);
    });

    it('replace upserts the existing row', async () => {
      await provider.sync([{ action: 'add', key: 'k1', content: 'first' }], ctx);
      await provider.sync([{ action: 'replace', key: 'k1', content: 'replaced' }], ctx);
      const entry = await provider.read('k1', ctx);
      expect(entry?.content).toBe('replaced');
      expect(provider.count()).toBe(1);
    });
  });

  describe('sync — remove', () => {
    it('removes matching lines but keeps the rest', async () => {
      await provider.sync(
        [{ action: 'add', key: 'k1', content: 'keep this\nremove specific line\nalso keep' }],
        ctx,
      );
      await provider.sync([{ action: 'remove', key: 'k1', substringMatch: 'specific' }], ctx);
      const entry = await provider.read('k1', ctx);
      expect(entry?.content).toBe('keep this\nalso keep');
    });

    it('deletes the entry when all lines match', async () => {
      await provider.sync([{ action: 'add', key: 'k1', content: 'remove specific chunk' }], ctx);
      await provider.sync([{ action: 'remove', key: 'k1', substringMatch: 'specific' }], ctx);
      expect(await provider.read('k1', ctx)).toBeNull();
    });

    it('leaves the row alone when substringMatch misses', async () => {
      await provider.sync([{ action: 'add', key: 'k1', content: 'keep this' }], ctx);
      await provider.sync([{ action: 'remove', key: 'k1', substringMatch: 'missing' }], ctx);
      expect(await provider.read('k1', ctx)).not.toBeNull();
    });
  });

  describe('sync — delete', () => {
    it('removes the row with the exact key', async () => {
      await provider.sync([{ action: 'add', key: 'k1', content: 'bye' }], ctx);
      await provider.sync([{ action: 'delete', key: 'k1' }], ctx);
      expect(await provider.read('k1', ctx)).toBeNull();
    });
  });

  describe('add()', () => {
    it('inserts an entry under an auto-generated key', async () => {
      const n = await provider.add('Quick add to memory.', 'memory');
      expect(n).toBe(1);
      expect(provider.count()).toBe(1);
    });
  });

  describe('showRecent()', () => {
    it('returns entries ordered by recency', async () => {
      await provider.add('First.', 'memory');
      await provider.add('Second.', 'memory');
      const records = provider.showRecent(10);
      expect(records.length).toBe(2);
      expect(records[0]?.content).toBe('Second.');
    });
  });

  describe('clear()', () => {
    it('removes all entries', async () => {
      await provider.add('To be cleared.', 'memory');
      provider.clear();
      expect(provider.count()).toBe(0);
    });
  });

  describe('exportAll()', () => {
    it('writes a markdown file with all entries', async () => {
      await provider.add('Export test fact.', 'memory');
      const outPath = join(testDir, 'export.md');
      const n = await provider.exportAll(outPath);
      expect(n).toBe(1);
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
      await writeFile(join(testDir, 'MEMORY.md'), 'Existing memory.');
      await writeFile(join(testDir, 'USER.md'), 'I am a developer.');

      const result = await provider.migrateFromMarkdown();
      expect(result.migrated).toBe(true);
      expect(result.memoryChunks).toBe(1);
      expect(result.userChunks).toBe(1);

      const { stat } = await import('node:fs/promises');
      await expect(stat(join(testDir, 'MEMORY.md.bak'))).resolves.toBeTruthy();
      await expect(stat(join(testDir, 'USER.md.bak'))).resolves.toBeTruthy();
      await expect(stat(join(testDir, 'MEMORY.md'))).rejects.toThrow();
    });

    it('does not migrate when entries already exist', async () => {
      await writeFile(join(testDir, 'MEMORY.md'), 'Should not migrate.');
      await provider.add('Already have data.', 'memory');

      const result = await provider.migrateFromMarkdown();
      expect(result.migrated).toBe(false);
    });

    it('handles missing files gracefully', async () => {
      const result = await provider.migrateFromMarkdown();
      expect(result.migrated).toBe(false);
    });
  });

  describe('legacy memory_chunks migration', () => {
    it('migrates rows from the old schema into memory_entries scope=global', async () => {
      // Close the auto-opened db so we can seed the legacy table cleanly.
      provider.close();
      const dbPath = join(testDir, 'memory.db');
      const { default: Database } = await import('@ethosagent/sqlite');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE memory_chunks (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          store       TEXT NOT NULL,
          content     TEXT NOT NULL,
          embedding   BLOB NOT NULL,
          created_at  TEXT NOT NULL
        ) STRICT;
      `);
      // Seed two legacy rows with non-empty embedding buffers.
      const emb = Buffer.from(new Uint8Array(384 * 4));
      legacyDb
        .prepare(
          'INSERT INTO memory_chunks (store, content, embedding, created_at) VALUES (?, ?, ?, ?)',
        )
        .run('memory', 'legacy fact one', emb, '2025-01-01T00:00:00Z');
      legacyDb
        .prepare(
          'INSERT INTO memory_chunks (store, content, embedding, created_at) VALUES (?, ?, ?, ?)',
        )
        .run('user', 'legacy user fact', emb, '2025-01-02T00:00:00Z');
      legacyDb.close();

      // Re-open via VectorMemoryProvider — migration fires in the constructor.
      provider = new VectorMemoryProvider({
        dir: testDir,
        embedFn: fakeEmbed,
        storage: new FsStorage(),
      });
      expect(provider.count()).toBe(2);
      const refs = await provider.list({ ...ctx, scopeId: 'global' });
      expect(refs.map((r) => r.key).sort()).toEqual(['legacy-memory-1', 'legacy-user-2']);

      // Legacy table must be gone after a successful migration.
      const tableCheck = await import('@ethosagent/sqlite').then(({ default: Db }) => {
        const probe = new Db(dbPath, { readonly: true });
        const row = probe
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_chunks'")
          .get();
        probe.close();
        return row;
      });
      expect(tableCheck).toBeUndefined();
    });
  });

  describe('scale', () => {
    it('handles 100 entries and returns top-K results', async () => {
      for (let i = 0; i < 100; i++) {
        await provider.sync(
          [
            {
              action: 'add',
              key: `k${i}`,
              content: `Memory entry number ${i}: some content about topic ${i % 10}.`,
            },
          ],
          ctx,
        );
      }
      expect(provider.count()).toBe(100);

      const results = await provider.search('topic 3', ctx, { limit: 5 });
      expect(results.length).toBeLessThanOrEqual(5);
    });
  });

  describe('schema versioning', () => {
    async function freshDir(): Promise<string> {
      const dir = join(
        tmpdir(),
        `ethos-vector-version-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      await mkdir(dir, { recursive: true });
      return dir;
    }

    it('stamps a fresh db to user_version 1', async () => {
      const dir = await freshDir();
      const p = new VectorMemoryProvider({ dir, embedFn: fakeEmbed, storage: new FsStorage() });
      p.close();

      const Database = (await import('@ethosagent/sqlite')).default;
      const db = new Database(join(dir, 'memory.db'));
      const rows = db.pragma('user_version') as Array<{ user_version: number }>;
      db.close();
      expect(rows[0]?.user_version).toBe(1);
      await rm(dir, { recursive: true, force: true });
    });

    it('reopening a populated db preserves rows and keeps user_version at 1', async () => {
      const dir = await freshDir();
      const p1 = new VectorMemoryProvider({ dir, embedFn: fakeEmbed, storage: new FsStorage() });
      await p1.sync([{ action: 'add', key: 'fact', content: 'TypeScript' }], ctx);
      p1.close();

      const p2 = new VectorMemoryProvider({ dir, embedFn: fakeEmbed, storage: new FsStorage() });
      const entry = await p2.read('fact', ctx);
      p2.close();
      expect(entry?.content).toBe('TypeScript');

      const Database = (await import('@ethosagent/sqlite')).default;
      const db = new Database(join(dir, 'memory.db'));
      const rows = db.pragma('user_version') as Array<{ user_version: number }>;
      db.close();
      expect(rows[0]?.user_version).toBe(1);
      await rm(dir, { recursive: true, force: true });
    });

    it('refuses to open a db whose user_version is newer than the code', async () => {
      const dir = await freshDir();
      const Database = (await import('@ethosagent/sqlite')).default;
      const raw = new Database(join(dir, 'memory.db'));
      raw.pragma('user_version = 2');
      raw.close();

      expect(
        () => new VectorMemoryProvider({ dir, embedFn: fakeEmbed, storage: new FsStorage() }),
      ).toThrow(/refusing to open to avoid downgrade/);
      await rm(dir, { recursive: true, force: true });
    });
  });
});

// ---------------------------------------------------------------------------
// Durability posture — see AGENTS.md's SQLite store roster.
// ---------------------------------------------------------------------------

/** Reads `PRAGMA synchronous` off the provider's OWN handle — it is a
 *  per-connection setting, so a second connection to the same file would
 *  report its own default and prove nothing. 2 = FULL (SQLite's default),
 *  1 = NORMAL. */
function syncPragma(store: unknown): number {
  const rows = (store as { db: { pragma(s: string): unknown } }).db.pragma('synchronous');
  return (rows as Array<{ synchronous: number }>)[0]?.synchronous ?? -1;
}

describe('VectorMemoryProvider — durability posture', () => {
  it('stays at synchronous = FULL', () => {
    // NOT a candidate for `synchronous = NORMAL` — pinned so a later blanket
    // sweep cannot take it silently.
    //
    // memory.db is the SOURCE OF TRUTH for memory content here, not an index
    // over it: `exportTo` writes markdown, but that is an export, and nothing
    // rebuilds this table from it. A rolled-back tail is a thing the agent was
    // told to remember and then didn't. Separately, every write is gated
    // behind an embedding forward pass, so a 4.5ms fsync is not the cost on
    // this path even if the risk were acceptable.
    //
    // Asserted against the opened database, not the source text.
    expect(syncPragma(provider)).toBe(2);
  });
});
