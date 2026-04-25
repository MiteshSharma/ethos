import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContextInjector, InjectionResult, PromptContext } from '@ethosagent/types';
import { sanitize } from './prompt-injection-guard';

// Files checked in order — first match wins
const CONTEXT_FILES = ['AGENTS.md', 'CLAUDE.md', 'SOUL.md'];

interface CacheEntry {
  mtime: number;
  content: string;
}

export class FileContextInjector implements ContextInjector {
  readonly id = 'file-context';
  readonly priority = 90;

  private readonly cache = new Map<string, CacheEntry>();

  async inject(ctx: PromptContext): Promise<InjectionResult | null> {
    const cwd = ctx.workingDir;
    if (!cwd) return null;

    const sections: string[] = [];

    for (const filename of CONTEXT_FILES) {
      const content = await this.readCached(join(cwd, filename));
      if (content) {
        sections.push(`### ${filename}\n\n${sanitize(content.trim())}`);
      }
    }

    if (sections.length === 0) return null;

    return {
      content: `## Project Context\n\n${sections.join('\n\n')}`,
      position: 'append',
    };
  }

  private async readCached(filePath: string): Promise<string | null> {
    try {
      const { mtimeMs } = await stat(filePath);
      const cached = this.cache.get(filePath);
      if (cached && cached.mtime === mtimeMs) return cached.content;

      const content = await readFile(filePath, 'utf-8');
      this.cache.set(filePath, { mtime: mtimeMs, content });
      return content;
    } catch {
      return null;
    }
  }
}
