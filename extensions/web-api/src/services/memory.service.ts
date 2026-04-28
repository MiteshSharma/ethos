import type { MemoryFile, MemoryStoreId } from '@ethosagent/web-contracts';
import type { MemoryRepository } from '../repositories/memory.repository';

// Memory service. Three reads and one write — list, get, write. The
// repository handles the FS round-trips; this layer is a pass-through
// today, but the seam is in place for the v1.x evolution that adds:
//   • per-personality scope (read from
//     `~/.ethos/personalities/<id>/MEMORY.md` when the active
//     personality has `memoryScope: 'per-personality'`)
//   • vector-mode chunk CRUD (over the SQLite store memory-vector
//     populates).

export interface MemoryServiceOptions {
  repo: MemoryRepository;
}

export class MemoryService {
  constructor(private readonly opts: MemoryServiceOptions) {}

  async list(): Promise<{ files: MemoryFile[] }> {
    const [memory, user] = await Promise.all([
      this.opts.repo.read('memory'),
      this.opts.repo.read('user'),
    ]);
    return { files: [memory, user] };
  }

  async get(store: MemoryStoreId): Promise<{ file: MemoryFile }> {
    return { file: await this.opts.repo.read(store) };
  }

  async write(store: MemoryStoreId, content: string): Promise<{ file: MemoryFile }> {
    return { file: await this.opts.repo.write(store, content) };
  }
}
