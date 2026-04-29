import { homedir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import type {
  MemoryContext,
  MemoryLoadContext,
  MemoryProvider,
  MemoryUpdate,
  Storage,
} from '@ethosagent/types';

const MAX_CHARS = 20_000;

export interface MarkdownMemoryConfig {
  /** Directory containing MEMORY.md and USER.md. Defaults to ~/.ethos */
  dir?: string;
  /** Maximum characters returned by prefetch before truncation. Defaults to 20000 */
  maxChars?: number;
  /** Storage backend. Defaults to FsStorage. Inject InMemoryStorage in tests. */
  storage?: Storage;
}

export class MarkdownFileMemoryProvider implements MemoryProvider {
  private readonly dir: string;
  private readonly maxChars: number;
  private readonly storage: Storage;

  constructor(config: MarkdownMemoryConfig = {}) {
    this.dir = config.dir ?? join(homedir(), '.ethos');
    this.maxChars = config.maxChars ?? MAX_CHARS;
    this.storage = config.storage ?? new FsStorage();
  }

  /**
   * Resolve the directory MEMORY.md/USER.md live in for this turn.
   * - 'global' (or unset) → the shared root
   * - 'per-personality' with a valid id → `<root>/personalities/<id>/`
   * USER.md always lives in the shared root — it describes the human, not the agent.
   */
  private resolveMemoryDir(ctx: MemoryLoadContext): string {
    if (ctx.memoryScope !== 'per-personality') return this.dir;
    const id = ctx.personalityId;
    if (!id || !isSafePersonalityId(id)) return this.dir;
    return join(this.dir, 'personalities', id);
  }

  async prefetch(ctx: MemoryLoadContext): Promise<MemoryContext | null> {
    const parts: string[] = [];

    // USER.md is always shared — it's about the person, not the personality
    const userContent = await this.storage.read(join(this.dir, 'USER.md'));
    if (userContent) parts.push(`## About You\n\n${userContent.trim()}`);

    const memoryDir = this.resolveMemoryDir(ctx);
    const memoryContent = await this.storage.read(join(memoryDir, 'MEMORY.md'));
    if (memoryContent) parts.push(`## Memory\n\n${memoryContent.trim()}`);

    if (parts.length === 0) return null;

    let content = parts.join('\n\n');
    const truncated = content.length > this.maxChars;
    if (truncated) {
      // Keep the tail — most recent memory is at the end
      content = `[...truncated]\n\n${content.slice(-this.maxChars)}`;
    }

    return { content, source: 'markdown', truncated };
  }

  /**
   * Direct read of a single global file (`MEMORY.md` or `USER.md`) for
   * the web-api Memory tab. Returns content, the absolute path, and the
   * file's modification time as ISO-8601 (or null if the file doesn't
   * exist yet — the editor hydrates with an empty body in that case).
   */
  async readGlobalFile(
    store: 'memory' | 'user',
  ): Promise<{ content: string; path: string; modifiedAt: string | null }> {
    const path = this.globalPath(store);
    const content = (await this.storage.read(path)) ?? '';
    const mtime = await this.storage.mtime(path);
    return {
      content,
      path,
      modifiedAt: mtime !== null ? new Date(mtime).toISOString() : null,
    };
  }

  /** Direct write of a single global file (`MEMORY.md` or `USER.md`). */
  async writeGlobalFile(
    store: 'memory' | 'user',
    content: string,
  ): Promise<{ content: string; path: string; modifiedAt: string | null }> {
    await this.storage.mkdir(this.dir);
    const path = this.globalPath(store);
    await this.storage.write(path, content);
    return this.readGlobalFile(store);
  }

  private globalPath(store: 'memory' | 'user'): string {
    return join(this.dir, store === 'memory' ? 'MEMORY.md' : 'USER.md');
  }

  async sync(ctx: MemoryLoadContext, updates: MemoryUpdate[]): Promise<void> {
    if (updates.length === 0) return;

    const memoryDir = this.resolveMemoryDir(ctx);
    await this.storage.mkdir(memoryDir);
    if (memoryDir !== this.dir) await this.storage.mkdir(this.dir);

    const byStore = new Map<'memory' | 'user', MemoryUpdate[]>();
    for (const u of updates) {
      const list = byStore.get(u.store) ?? [];
      list.push(u);
      byStore.set(u.store, list);
    }

    const tasks: Promise<void>[] = [];
    const memoryUpdates = byStore.get('memory');
    const userUpdates = byStore.get('user');
    if (memoryUpdates) {
      // 'memory' store routes by personality scope
      tasks.push(this.applyUpdates(join(memoryDir, 'MEMORY.md'), memoryUpdates));
    }
    if (userUpdates) {
      // 'user' store always shared — about the human
      tasks.push(this.applyUpdates(join(this.dir, 'USER.md'), userUpdates));
    }

    await Promise.all(tasks);
  }

  private async applyUpdates(filePath: string, updates: MemoryUpdate[]): Promise<void> {
    let content = (await this.storage.read(filePath)) ?? '';

    for (const update of updates) {
      switch (update.action) {
        case 'add':
          content = content
            ? `${content.trimEnd()}\n\n${update.content.trim()}\n`
            : `${update.content.trim()}\n`;
          break;

        case 'replace':
          content = `${update.content.trim()}\n`;
          break;

        case 'remove': {
          const match = update.substringMatch;
          if (!match) break;
          const lines = content.split('\n');
          content = `${lines
            .filter((line) => !line.includes(match))
            .join('\n')
            .trimEnd()}\n`;
          break;
        }
      }
    }

    await this.storage.write(filePath, content);
  }
}

// Reject ids with path separators, parent traversal, leading dots, or anything
// outside [a-zA-Z0-9_-]. Belt-and-suspenders — the personality loader uses
// directory names which are already constrained, but this is a security
// boundary we don't want to depend on a caller upholding.
function isSafePersonalityId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}
