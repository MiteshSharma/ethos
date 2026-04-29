import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import type {
  ContextInjector,
  InjectionResult,
  PersonalityConfig,
  PersonalityRegistry,
  PromptContext,
  Skill,
  Storage,
} from '@ethosagent/types';
import { filterSkill, warnMissingAllowList } from './ingest-filter';
import { sanitize } from './prompt-injection-guard';
import { applySubstitutions, parseSkillFrontmatter, shouldInject } from './skill-compat';
import { UniversalScanner } from './universal-scanner';

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
  /**
   * Tool names reachable by a personality.
   * When provided, capability-mode filtering is applied to global-pool skills.
   * Pass `registry.toolNamesForPersonality(personality)` from wiring.
   */
  toolNamesForPersonality?: (personality: PersonalityConfig) => Set<string>;
}

export class SkillsInjector implements ContextInjector {
  readonly id = 'skills';
  readonly priority = 100;

  private readonly personalities: PersonalityRegistry;
  private readonly globalSkillsDir: string;
  private readonly onSkip?: (skillId: string, reason: string) => void;
  private readonly storage: Storage;
  private readonly toolNamesForPersonality?: (p: PersonalityConfig) => Set<string>;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly scanner: UniversalScanner;

  constructor(personalities: PersonalityRegistry, optionsOrDir?: string | SkillsInjectorOptions) {
    this.personalities = personalities;
    const opts: SkillsInjectorOptions =
      typeof optionsOrDir === 'string' ? { globalSkillsDir: optionsOrDir } : (optionsOrDir ?? {});
    this.globalSkillsDir = opts.globalSkillsDir ?? join(homedir(), '.ethos', 'skills');
    this.onSkip = opts.onSkip;
    this.storage = opts.storage ?? new FsStorage();
    this.toolNamesForPersonality = opts.toolNamesForPersonality;
    this.scanner = new UniversalScanner({ storage: this.storage });
  }

  async inject(ctx: PromptContext): Promise<InjectionResult | null> {
    const personality = ctx.personalityId
      ? (this.personalities.get(ctx.personalityId) ?? this.personalities.getDefault())
      : this.personalities.getDefault();

    const sections: string[] = [];
    const fileNames: string[] = [];

    // 1. Per-personality skills/ dirs — always loaded unfiltered (hand-curated library)
    const perPersonalityDirs = personality.skillsDirs ?? [];
    for (const dir of perPersonalityDirs) {
      const loaded = await this.loadSkillsFromDir(dir, ctx);
      for (const { content, fileName } of loaded) {
        sections.push(content);
        fileNames.push(fileName);
      }
    }

    // 2. Global pool from universal scanner — filtered per personality
    const globalPool = await this.scanner.scan();

    // Warn about missing allow-list references
    const allow = personality.skills?.global_ingest?.allow ?? [];
    if (allow.length > 0) {
      warnMissingAllowList(personality.id, allow, globalPool, (msg) =>
        process.stdout.write(msg + '\n'),
      );
    }

    const toolNames = this.toolNamesForPersonality
      ? this.toolNamesForPersonality(personality)
      : new Set<string>();

    for (const [, skill] of globalPool) {
      // Skip skills already loaded from per-personality dirs (avoid duplicates by file path)
      if (perPersonalityDirs.some((d) => skill.filePath.startsWith(d))) continue;

      const result = filterSkill(skill, personality, toolNames, (msg) =>
        process.stdout.write(msg + '\n'),
      );
      if (!result.include) {
        this.onSkip?.(skill.qualifiedName, result.reason);
        continue;
      }

      // Still apply OpenClaw shouldInject rules (env, bins, os) for openclaw dialect
      if (skill.dialect === 'openclaw') {
        const parsed = parseSkillFrontmatter(
          skill.body.length > 0
            ? `---\n${JSON.stringify(skill.rawFrontmatter)}\n---\n${skill.body}`
            : skill.body,
        );
        if (parsed) {
          const verdict = shouldInject(parsed.openclaw, {});
          if (!verdict.inject) {
            this.onSkip?.(skill.qualifiedName, verdict.reason ?? 'openclaw filter');
            continue;
          }
        }
      }

      const substituted = applySubstitutions(skill.body, dirname(skill.filePath), ctx.sessionId);
      sections.push(sanitize(substituted.trim()));
      fileNames.push(skill.qualifiedName);
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

  private async discoverSkillFiles(dir: string): Promise<string[]> {
    const found: string[] = [];

    const entries = await this.storage.listEntries(dir);
    if (entries.length === 0) return [];

    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDir) {
        if (entry.name === 'pending' || entry.name.startsWith('.')) continue;
        const subPath = join(dir, entry.name);
        const skillMd = join(subPath, 'SKILL.md');
        if (await this.fileExists(skillMd)) {
          found.push(skillMd);
          continue;
        }
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
    const t = await this.storage.mtime(path);
    return t !== null;
  }
}
