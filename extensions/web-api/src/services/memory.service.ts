import type { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import type { MemoryFile, MemoryStoreId } from '@ethosagent/web-contracts';

// Memory service. Three reads and one write — list, get, write — all
// over the global MEMORY.md / USER.md pair. Calls into
// MarkdownFileMemoryProvider directly via its `readGlobalFile` /
// `writeGlobalFile` helpers, which sit alongside the existing
// prefetch/sync interface so per-personality + vector evolutions can
// extend without re-introducing a separate repo.

export interface MemoryServiceOptions {
  memory: MarkdownFileMemoryProvider;
}

export class MemoryService {
  constructor(private readonly opts: MemoryServiceOptions) {}

  async list(): Promise<{ files: MemoryFile[] }> {
    const [memory, user] = await Promise.all([this.read('memory'), this.read('user')]);
    return { files: [memory, user] };
  }

  async get(store: MemoryStoreId): Promise<{ file: MemoryFile }> {
    return { file: await this.read(store) };
  }

  async write(store: MemoryStoreId, content: string): Promise<{ file: MemoryFile }> {
    const out = await this.opts.memory.writeGlobalFile(store, content);
    return { file: { store, ...out } };
  }

  private async read(store: MemoryStoreId): Promise<MemoryFile> {
    const out = await this.opts.memory.readGlobalFile(store);
    return { store, ...out };
  }
}
