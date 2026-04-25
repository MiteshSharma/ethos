import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  MemoryContext,
  MemoryLoadContext,
  MemoryProvider,
  MemoryUpdate,
} from '@ethosagent/types';

const MAX_CHARS = 20_000;

export interface MarkdownMemoryConfig {
  /** Directory containing MEMORY.md and USER.md. Defaults to ~/.ethos */
  dir?: string;
  /** Maximum characters returned by prefetch before truncation. Defaults to 20000 */
  maxChars?: number;
}

export class MarkdownFileMemoryProvider implements MemoryProvider {
  private readonly dir: string;
  private readonly maxChars: number;

  constructor(config: MarkdownMemoryConfig = {}) {
    this.dir = config.dir ?? join(homedir(), '.ethos');
    this.maxChars = config.maxChars ?? MAX_CHARS;
  }

  async prefetch(_ctx: MemoryLoadContext): Promise<MemoryContext | null> {
    const parts: string[] = [];

    const userContent = await readSafe(join(this.dir, 'USER.md'));
    if (userContent) parts.push(`## About You\n\n${userContent.trim()}`);

    const memoryContent = await readSafe(join(this.dir, 'MEMORY.md'));
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

  async sync(_ctx: MemoryLoadContext, updates: MemoryUpdate[]): Promise<void> {
    if (updates.length === 0) return;

    await mkdir(this.dir, { recursive: true });

    const byStore = new Map<'memory' | 'user', MemoryUpdate[]>();
    for (const u of updates) {
      const list = byStore.get(u.store) ?? [];
      list.push(u);
      byStore.set(u.store, list);
    }

    const tasks: Promise<void>[] = [];
    const memoryUpdates = byStore.get('memory');
    const userUpdates = byStore.get('user');
    if (memoryUpdates) tasks.push(this.applyUpdates(join(this.dir, 'MEMORY.md'), memoryUpdates));
    if (userUpdates) tasks.push(this.applyUpdates(join(this.dir, 'USER.md'), userUpdates));

    await Promise.all(tasks);
  }

  private async applyUpdates(filePath: string, updates: MemoryUpdate[]): Promise<void> {
    let content = (await readSafe(filePath)) ?? '';

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

    await writeFile(filePath, content, 'utf-8');
  }
}

async function readSafe(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}
