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
  /**
   * Hard cap on total injected skill content in characters (≈ chars/4 tokens).
   * Only applies in full injection_mode. Defaults to 40 000 chars (~10 000 tokens).
   * Set to 0 to disable.
   */
  maxInjectionChars?: number;
  /**
   * Pre-built scanner to share with GetSkillTool. When provided, the injector
   * uses this instance instead of creating its own, so both share one mtime cache.
   */
  scanner?: import('./universal-scanner').UniversalScanner;
}

export class SkillsInjector implements ContextInjector {
  readonly id = 'skills';
  readonly priority = 100;

  private readonly personalities: PersonalityRegistry;
  private readonly globalSkillsDir: string;
  private readonly onSkip?: (skillId: string, reason: string) => void;
  private readonly storage: Storage;
  private readonly toolNamesForPersonality?: (p: PersonalityConfig) => Set<string>;
  private readonly maxInjectionChars: number;
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
    this.maxInjectionChars = opts.maxInjectionChars ?? 40_000;
    this.scanner = opts.scanner ?? new UniversalScanner({ storage: this.storage });
  }

  async inject(ctx: PromptContext): Promise<InjectionResult | null> {
    const personality = ctx.personalityId
      ? (this.personalities.get(ctx.personalityId) ?? this.personalities.getDefault())
      : this.personalities.getDefault();

    const sections: string[] = [];
    const fileNames: string[] = [];
    let totalChars = 0;
    const budget = this.maxInjectionChars;

    function addSection(content: string, name: string): boolean {
      if (budget > 0 && totalChars + content.length > budget) return false;
      sections.push(content);
      fileNames.push(name);
      totalChars += content.length;
      return true;
    }

    // 1. Per-personality skills/ dirs — always loaded unfiltered (hand-curated library)
    const perPersonalityDirs = personality.skillsDirs ?? [];
    for (const dir of perPersonalityDirs) {
      const loaded = await this.loadSkillsFromDir(dir, ctx);
      for (const { content, fileName } of loaded) {
        addSection(content, fileName);
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

    // Determine injection mode for global-pool skills.
    // 'index' (default) injects a compact table; 'full' injects complete bodies.
    const injectionMode: 'full' | 'index' = personality.skills?.injection_mode ?? 'index';

    // Collect skills that pass all filters
    const eligibleGlobal: import('@ethosagent/types').Skill[] = [];
    for (const [, skill] of globalPool) {
      if (perPersonalityDirs.some((d) => skill.filePath.startsWith(d))) continue;

      const result = filterSkill(skill, personality, toolNames, (msg) =>
        process.stdout.write(msg + '\n'),
      );
      if (!result.include) {
        this.onSkip?.(skill.qualifiedName, result.reason);
        continue;
      }

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

      eligibleGlobal.push(skill);
    }

    if (injectionMode === 'index') {
      // Phase 1: compact index table — the LLM calls get_skill() for full bodies
      if (eligibleGlobal.length > 0) {
        const rows = eligibleGlobal
          .map((s) => {
            const desc = (s.rawFrontmatter.description as string | undefined) ?? '—';
            return `| \`${s.qualifiedName}\` | ${desc} |`;
          })
          .join('\n');
        const indexBlock =
          `## Available Skills\n\n` +
          `Call \`get_skill(name)\` to load full instructions before using any skill.\n\n` +
          `| Skill | Description |\n` +
          `|---|---|\n` +
          rows;
        sections.push(indexBlock);
        fileNames.push('__skill_index__');
      }
    } else {
      // Phase 1 (full mode): inject complete bodies, respecting budget
      let budgetExceeded = false;
      for (const skill of eligibleGlobal) {
        const substituted = applySubstitutions(skill.body, dirname(skill.filePath), ctx.sessionId);
        const content = sanitize(substituted.trim());
        if (!addSection(content, skill.qualifiedName)) {
          budgetExceeded = true;
          this.onSkip?.(skill.qualifiedName, 'injection budget exceeded');
        }
      }
      if (budgetExceeded) {
        process.stdout.write(
          `[skills] injection budget (${budget} chars) reached — some global-pool skills were skipped. ` +
            `Switch to injection_mode: index or use skills.global_ingest.mode: explicit to pin specific skills.\n`,
        );
      }
    }

    if (sections.length === 0) return null;

    ctx.meta ??= {};
    ctx.meta.skillFilesUsed = fileNames.filter((n) => n !== '__skill_index__');

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
