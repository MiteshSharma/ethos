import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import type {
  ContextInjector,
  InjectionResult,
  PersonalityRegistry,
  PromptContext,
  Storage,
} from '@ethosagent/types';
import { sanitize } from './prompt-injection-guard';
import { applySubstitutions, parseSkillFrontmatter, shouldInject } from './skill-compat';

interface CacheEntry {
  mtime: number;
  content: string;
}

export interface SkillsInjectorOptions {
  globalSkillsDir?: string;
  /** Called when a skill is skipped because of OpenClaw `requires`/`os` rules. */
  onSkip?: (skillId: string, reason: string) => void;
  /** Storage backend. Defaults to FsStorage. */
  storage?: Storage;
}

export class SkillsInjector implements ContextInjector {
  readonly id = 'skills';
  readonly priority = 100;

  private readonly personalities: PersonalityRegistry;
  private readonly globalSkillsDir: string;
  private readonly onSkip?: (skillId: string, reason: string) => void;
  private readonly storage: Storage;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(personalities: PersonalityRegistry, optionsOrDir?: string | SkillsInjectorOptions) {
    this.personalities = personalities;
    const opts: SkillsInjectorOptions =
      typeof optionsOrDir === 'string' ? { globalSkillsDir: optionsOrDir } : (optionsOrDir ?? {});
    this.globalSkillsDir = opts.globalSkillsDir ?? join(homedir(), '.ethos', 'skills');
    this.onSkip = opts.onSkip;
    this.storage = opts.storage ?? new FsStorage();
  }

  async inject(ctx: PromptContext): Promise<InjectionResult | null> {
    const personality = ctx.personalityId
      ? (this.personalities.get(ctx.personalityId) ?? this.personalities.getDefault())
      : this.personalities.getDefault();

    const skillDirs = [...new Set([...(personality.skillsDirs ?? []), this.globalSkillsDir])];

    const sections: string[] = [];
    const fileNames: string[] = [];

    for (const dir of skillDirs) {
      const loaded = await this.loadSkillsFromDir(dir, ctx);
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
    ctx: PromptContext,
  ): Promise<Array<{ content: string; fileName: string }>> {
    const skillFiles = await this.discoverSkillFiles(dir);
    const skills: Array<{ content: string; fileName: string }> = [];

    for (const filePath of skillFiles) {
      const raw = await this.readCached(filePath);
      if (!raw) continue;

      const parsed = parseSkillFrontmatter(raw);
      const skillId = this.skillIdFor(filePath, dir);

      if (parsed) {
        const verdict = shouldInject(parsed.openclaw, {});
        if (!verdict.inject) {
          this.onSkip?.(skillId, verdict.reason ?? 'unknown');
          continue;
        }
      }

      const body = parsed ? parsed.body : raw;
      const skillDir = dirname(filePath);
      const substituted = applySubstitutions(body, skillDir, ctx.sessionId);

      skills.push({ content: sanitize(substituted.trim()), fileName: skillId });
    }

    return skills;
  }

  /**
   * Skill discovery rules:
   *   - Top-level `*.md` files in the dir (legacy Ethos format).
   *   - `<dir>/<slug>/SKILL.md` (OpenClaw / ClawHub layout).
   *   - `<dir>/<scope>/<slug>/SKILL.md` (e.g. `steipete/slack/SKILL.md`).
   * Files are returned in stable alphabetical order so injection order is deterministic.
   */
  private async discoverSkillFiles(dir: string): Promise<string[]> {
    const found: string[] = [];

    const entries = await this.storage.listEntries(dir);
    if (entries.length === 0) return [];

    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDir) {
        if (entry.name === 'pending' || entry.name.startsWith('.')) continue;
        const subPath = join(dir, entry.name);
        // Direct SKILL.md
        const skillMd = join(subPath, 'SKILL.md');
        if (await this.fileExists(skillMd)) {
          found.push(skillMd);
          continue;
        }
        // Scoped: <dir>/<scope>/<slug>/SKILL.md
        const inner = await this.storage.listEntries(subPath);
        for (const child of [...inner].sort((a, b) => a.name.localeCompare(b.name))) {
          if (!child.isDir) continue;
          const nested = join(subPath, child.name, 'SKILL.md');
          if (await this.fileExists(nested)) found.push(nested);
        }
      } else if (entry.name.endsWith('.md')) {
        found.push(join(dir, entry.name));
      }
    }

    return found;
  }

  private skillIdFor(filePath: string, rootDir: string): string {
    if (basename(filePath) !== 'SKILL.md') return basename(filePath);
    const parentDir = dirname(filePath);
    const grandparent = dirname(parentDir);
    if (grandparent === rootDir) return basename(parentDir);
    return `${basename(grandparent)}/${basename(parentDir)}`;
  }

  private async readCached(filePath: string): Promise<string | null> {
    const mtimeMs = await this.storage.mtime(filePath);
    if (mtimeMs === null) return null;
    const cached = this.cache.get(filePath);
    if (cached && cached.mtime === mtimeMs) return cached.content;

    const content = await this.storage.read(filePath);
    if (content === null) return null;
    this.cache.set(filePath, { mtime: mtimeMs, content });
    return content;
  }

  private async fileExists(path: string): Promise<boolean> {
    // Need to distinguish file from directory — listEntries on the parent
    // would work but is expensive. mtime returning a number means "exists",
    // and SKILL.md candidates aren't directories in any sane layout.
    const t = await this.storage.mtime(path);
    return t !== null;
  }
}
