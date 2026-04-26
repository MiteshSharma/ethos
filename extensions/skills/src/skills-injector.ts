import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type {
  ContextInjector,
  InjectionResult,
  PersonalityRegistry,
  PromptContext,
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
}

export class SkillsInjector implements ContextInjector {
  readonly id = 'skills';
  readonly priority = 100;

  private readonly personalities: PersonalityRegistry;
  private readonly globalSkillsDir: string;
  private readonly onSkip?: (skillId: string, reason: string) => void;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(personalities: PersonalityRegistry, optionsOrDir?: string | SkillsInjectorOptions) {
    this.personalities = personalities;
    const opts: SkillsInjectorOptions =
      typeof optionsOrDir === 'string' ? { globalSkillsDir: optionsOrDir } : (optionsOrDir ?? {});
    this.globalSkillsDir = opts.globalSkillsDir ?? join(homedir(), '.ethos', 'skills');
    this.onSkip = opts.onSkip;
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

    let entries: Array<{ name: string; isDir: boolean }>;
    try {
      const raw = await readdir(dir, { withFileTypes: true });
      entries = raw.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    } catch {
      return [];
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDir) {
        if (entry.name === 'pending' || entry.name.startsWith('.')) continue;
        const subPath = join(dir, entry.name);
        // Direct SKILL.md
        const skillMd = join(subPath, 'SKILL.md');
        if (await fileExists(skillMd)) {
          found.push(skillMd);
          continue;
        }
        // Scoped: <dir>/<scope>/<slug>/SKILL.md
        try {
          const inner = await readdir(subPath, { withFileTypes: true });
          for (const child of inner.sort((a, b) => a.name.localeCompare(b.name))) {
            if (!child.isDirectory()) continue;
            const nested = join(subPath, child.name, 'SKILL.md');
            if (await fileExists(nested)) found.push(nested);
          }
        } catch {
          // ignore unreadable subdirs
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

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}
