import { readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  MemoryContext,
  MemoryLoadContext,
  MemoryProvider,
  MemoryStore,
  MemoryUpdate,
} from '@ethosagent/types';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOP_K = 5;
const EMBED_DIM = 384;
const LRU_MAX = 50;
const CHUNK_MAX_CHARS = 500;
const CHUNK_MIN_CHARS = 20;

// ---------------------------------------------------------------------------
// Lazy singleton embedding pipeline
// ---------------------------------------------------------------------------

type EmbedPipeline = (
  text: string,
  opts: Record<string, unknown>,
) => Promise<{ data: Float32Array }>;

let _pipeline: EmbedPipeline | null = null;
let _pipelinePromise: Promise<EmbedPipeline> | null = null;

async function getDefaultEmbedder(): Promise<EmbedPipeline> {
  if (_pipeline) return _pipeline;
  if (!_pipelinePromise) {
    _pipelinePromise = (async () => {
      const { pipeline } = await import('@xenova/transformers');
      // biome-ignore lint/suspicious/noExplicitAny: @xenova/transformers pipeline return type is not exported
      _pipeline = (await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')) as any;
      return _pipeline as EmbedPipeline;
    })();
  }
  return _pipelinePromise;
}

// ---------------------------------------------------------------------------
// Cosine similarity (pure float arithmetic)
// ---------------------------------------------------------------------------

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------------------------------------------------------------------------
// Text chunking
// ---------------------------------------------------------------------------

function chunkText(text: string): string[] {
  // Drop empty/whitespace-only paragraphs but keep short ones — a 12-char
  // user fact ("First fact.") is still a memory worth storing. The
  // CHUNK_MIN_CHARS threshold is for the long-paragraph sub-chunking
  // logic below (don't split an oversized paragraph into tiny fragments).
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  for (const para of paragraphs) {
    if (para.length <= CHUNK_MAX_CHARS) {
      chunks.push(para);
    } else {
      // Split long paragraphs by sentence boundaries
      const sentences = para.split(/(?<=[.!?])\s+/);
      let current = '';
      for (const s of sentences) {
        if (current.length + s.length + 1 > CHUNK_MAX_CHARS && current.length >= CHUNK_MIN_CHARS) {
          chunks.push(current.trim());
          current = s;
        } else {
          current = current ? `${current} ${s}` : s;
        }
      }
      if (current.trim().length >= CHUNK_MIN_CHARS) chunks.push(current.trim());
    }
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VectorMemoryConfig {
  /** Directory containing memory.db, MEMORY.md, USER.md. Defaults to ~/.ethos */
  dir?: string;
  /** Number of top chunks returned by prefetch. Defaults to 5 */
  topK?: number;
  /**
   * Custom embedding function — used in tests to avoid downloading the model.
   * Must return a normalized Float32Array of length 384.
   */
  embedFn?: (text: string) => Promise<Float32Array>;
}

interface ChunkRow {
  id: number;
  store: string;
  content: string;
  embedding: Buffer;
  created_at: string;
}

export interface ChunkRecord {
  id: number;
  store: MemoryStore;
  content: string;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// VectorMemoryProvider
// ---------------------------------------------------------------------------

export class VectorMemoryProvider implements MemoryProvider {
  private readonly db: Database.Database;
  private readonly dir: string;
  private readonly topK: number;
  private readonly embedFn: ((text: string) => Promise<Float32Array>) | undefined;
  // LRU cache: query string → MemoryContext (Map preserves insertion order)
  private readonly cache = new Map<string, MemoryContext>();

  constructor(config: VectorMemoryConfig = {}) {
    this.dir = config.dir ?? join(homedir(), '.ethos');
    this.topK = config.topK ?? TOP_K;
    this.embedFn = config.embedFn;
    this.db = new Database(join(this.dir, 'memory.db'));
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_chunks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        store       TEXT NOT NULL,
        content     TEXT NOT NULL,
        embedding   BLOB NOT NULL,
        created_at  TEXT NOT NULL
      ) STRICT;
    `);
  }

  // ---------------------------------------------------------------------------
  // MemoryProvider interface
  // ---------------------------------------------------------------------------

  async prefetch(ctx: MemoryLoadContext): Promise<MemoryContext | null> {
    const query = ctx.query ?? '';

    // LRU cache hit
    if (this.cache.has(query)) {
      const hit = this.cache.get(query) as MemoryContext;
      this.cache.delete(query);
      this.cache.set(query, hit);
      return hit;
    }

    const total = (
      this.db.prepare('SELECT COUNT(*) AS n FROM memory_chunks').get() as { n: number }
    ).n;
    if (total === 0) return null;

    let chunks: string[];

    if (query) {
      const queryEmb = await this.embed(query);
      const rows = this.db.prepare('SELECT content, embedding FROM memory_chunks').all() as Pick<
        ChunkRow,
        'content' | 'embedding'
      >[];

      const scored = rows.map((row) => {
        // Reconstruct Float32Array from the buffer stored in SQLite
        const raw = new Uint8Array(row.embedding);
        const rowEmb = new Float32Array(raw.buffer, raw.byteOffset, EMBED_DIM);
        return { content: row.content, score: cosine(queryEmb, rowEmb) };
      });

      scored.sort((a, b) => b.score - a.score);
      chunks = scored.slice(0, this.topK).map((s) => s.content);
    } else {
      // No query — return most-recent K chunks in chronological order
      const rows = this.db
        .prepare('SELECT content FROM memory_chunks ORDER BY id DESC LIMIT ?')
        .all(this.topK) as Pick<ChunkRow, 'content'>[];
      chunks = rows.map((r) => r.content).reverse();
    }

    if (chunks.length === 0) return null;

    const result: MemoryContext = {
      content: chunks.join('\n\n'),
      source: 'vector',
      truncated: false,
    };

    // Update LRU cache
    if (this.cache.size >= LRU_MAX) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(query, result);

    return result;
  }

  async sync(_ctx: MemoryLoadContext, updates: MemoryUpdate[]): Promise<void> {
    if (updates.length === 0) return;

    for (const update of updates) {
      switch (update.action) {
        case 'add': {
          await this.insertChunks(update.store, update.content);
          break;
        }
        case 'replace': {
          this.db.prepare('DELETE FROM memory_chunks WHERE store = ?').run(update.store);
          if (update.content.trim()) {
            await this.insertChunks(update.store, update.content);
          }
          break;
        }
        case 'remove': {
          const match = update.substringMatch;
          if (!match) break;
          this.db
            .prepare("DELETE FROM memory_chunks WHERE store = ? AND content LIKE '%' || ? || '%'")
            .run(update.store, match);
          break;
        }
      }
    }

    this.cache.clear();
  }

  // ---------------------------------------------------------------------------
  // Manual memory management (called by CLI)
  // ---------------------------------------------------------------------------

  async add(content: string, store: MemoryStore = 'memory'): Promise<number> {
    const n = await this.insertChunks(store, content);
    this.cache.clear();
    return n;
  }

  showRecent(limit = 20): ChunkRecord[] {
    const rows = this.db
      .prepare('SELECT id, store, content, created_at FROM memory_chunks ORDER BY id DESC LIMIT ?')
      .all(limit) as ChunkRow[];
    return rows.map((r) => ({
      id: r.id,
      store: r.store as MemoryStore,
      content: r.content,
      createdAt: new Date(r.created_at),
    }));
  }

  async exportAll(outputPath: string): Promise<number> {
    const rows = this.db
      .prepare('SELECT id, store, content, created_at FROM memory_chunks ORDER BY id ASC')
      .all() as ChunkRow[];

    if (rows.length === 0) return 0;

    const lines: string[] = [`# Memory Export — ${new Date().toISOString()}`, ''];
    for (const row of rows) {
      lines.push(`## [${row.store}] ${row.created_at.slice(0, 16)}`);
      lines.push('');
      lines.push(row.content);
      lines.push('');
    }

    await writeFile(outputPath, lines.join('\n'), 'utf-8');
    return rows.length;
  }

  clear(): void {
    this.db.prepare('DELETE FROM memory_chunks').run();
    this.cache.clear();
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM memory_chunks').get() as { n: number }).n;
  }

  // ---------------------------------------------------------------------------
  // Migration from MEMORY.md / USER.md
  // ---------------------------------------------------------------------------

  async migrateFromMarkdown(): Promise<{
    migrated: boolean;
    memoryChunks: number;
    userChunks: number;
  }> {
    if (this.count() > 0) return { migrated: false, memoryChunks: 0, userChunks: 0 };

    let memoryChunks = 0;
    let userChunks = 0;
    let didMigrate = false;

    const memPath = join(this.dir, 'MEMORY.md');
    const userPath = join(this.dir, 'USER.md');

    const memContent = await readSafe(memPath);
    if (memContent) {
      memoryChunks = await this.insertChunks('memory', memContent);
      if (memoryChunks > 0) {
        await rename(memPath, `${memPath}.bak`);
        didMigrate = true;
      }
    }

    const userContent = await readSafe(userPath);
    if (userContent) {
      userChunks = await this.insertChunks('user', userContent);
      if (userChunks > 0) {
        await rename(userPath, `${userPath}.bak`);
        didMigrate = true;
      }
    }

    return { migrated: didMigrate, memoryChunks, userChunks };
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async embed(text: string): Promise<Float32Array> {
    if (this.embedFn) return this.embedFn(text);
    const embedder = await getDefaultEmbedder();
    const result = await embedder(text, { pooling: 'mean', normalize: true });
    // result.data may be a view into a larger ArrayBuffer — copy to own buffer
    return new Float32Array(result.data);
  }

  private async insertChunks(store: MemoryStore, text: string): Promise<number> {
    const chunks = chunkText(text);
    if (chunks.length === 0) return 0;

    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      'INSERT INTO memory_chunks (store, content, embedding, created_at) VALUES (?, ?, ?, ?)',
    );

    for (const chunk of chunks) {
      const emb = await this.embed(chunk);
      // Copy Float32Array bytes into a Buffer (BLOB) for SQLite storage
      const blob = Buffer.from(new Uint8Array(emb.buffer, emb.byteOffset, emb.byteLength));
      stmt.run(store, chunk, blob, now);
    }

    return chunks.length;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readSafe(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}
