import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  ContextInjector,
  InjectionResult,
  PersonalityRegistry,
  PromptContext,
} from '@ethosagent/types';
import { sanitize } from './prompt-injection-guard';

interface CacheEntry {
  mtime: number;
  content: string;
}

export class SkillsInjector implements ContextInjector {
  readonly id = 'skills';
  readonly priority = 100;

  private readonly personalities: PersonalityRegistry;
  private readonly globalSkillsDir: string;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(personalities: PersonalityRegistry, globalSkillsDir?: string) {
    this.personalities = personalities;
    this.globalSkillsDir = globalSkillsDir ?? join(homedir(), '.ethos', 'skills');
  }

  async inject(ctx: PromptContext): Promise<InjectionResult | null> {
    const personality = ctx.personalityId
      ? (this.personalities.get(ctx.personalityId) ?? this.personalities.getDefault())
      : this.personalities.getDefault();

    const skillDirs = [...(personality.skillsDirs ?? []), this.globalSkillsDir];

    const sections: string[] = [];
    const fileNames: string[] = [];

    for (const dir of skillDirs) {
      const loaded = await this.loadSkillsFromDir(dir);
      for (const { content, fileName } of loaded) {
        sections.push(content);
        fileNames.push(fileName);
      }
    }

    if (sections.length === 0) return null;

    ctx.meta ??= {};
    ctx.meta.skillFilesUsed = fileNames;

    return {
      content: `## Skills\n\n${sections.join('\n\n---\n\n')}`,
      position: 'append',
    };
  }

  private async loadSkillsFromDir(
    dir: string,
  ): Promise<Array<{ content: string; fileName: string }>> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }

    const mdFiles = entries
      .filter((e) => e.endsWith('.md'))
      .sort()
      .map((e) => join(dir, e));

    const skills: Array<{ content: string; fileName: string }> = [];

    for (const filePath of mdFiles) {
      const content = await this.readCached(filePath);
      if (content) skills.push({ content: sanitize(content.trim()), fileName: basename(filePath) });
    }

    return skills;
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
