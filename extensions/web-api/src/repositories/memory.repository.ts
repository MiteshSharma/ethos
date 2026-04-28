import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MemoryFile, MemoryStoreId } from '@ethosagent/web-contracts';

// File-backed repository for the two MarkdownFileMemoryProvider files:
//
//   ~/.ethos/MEMORY.md   — rolling project context
//   ~/.ethos/USER.md     — who-you-are notes, persistent across sessions
//
// Per-personality scope (the provider's `memoryScope: 'per-personality'`
// branch routes writes to `~/.ethos/personalities/<id>/`) is out of
// scope for the v1 Memory tab — that belongs in the v1 Personalities
// tab when the per-personality editor lands. The global files are the
// only thing this repository surfaces.

const FILENAME_BY_STORE: Record<MemoryStoreId, string> = {
  memory: 'MEMORY.md',
  user: 'USER.md',
};

export interface MemoryRepositoryOptions {
  /** Root data dir — `~/.ethos/`. */
  dataDir: string;
}

export class MemoryRepository {
  constructor(private readonly opts: MemoryRepositoryOptions) {}

  async read(store: MemoryStoreId): Promise<MemoryFile> {
    const path = this.pathFor(store);
    let content = '';
    let modifiedAt: string | null = null;
    try {
      content = await readFile(path, 'utf-8');
      const s = await stat(path);
      modifiedAt = s.mtime.toISOString();
    } catch {
      // File hasn't been written yet — return an empty body so the editor
      // can hydrate and the user can start fresh.
    }
    return { store, content, path, modifiedAt };
  }

  async write(store: MemoryStoreId, content: string): Promise<MemoryFile> {
    await mkdir(this.opts.dataDir, { recursive: true });
    const path = this.pathFor(store);
    await writeFile(path, content, 'utf-8');
    return this.read(store);
  }

  private pathFor(store: MemoryStoreId): string {
    return join(this.opts.dataDir, FILENAME_BY_STORE[store]);
  }
}
