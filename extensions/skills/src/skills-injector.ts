import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type {
  ContextInjector,
  InjectionResult,
  PersonalityConfig,
  PersonalityRegistry,
  PromptContext,
  Skill,
  Storage,
} from '@ethosagent/types';
import { parseEthosRenders } from './dialects/ethos-namespace';
import { filterSkill, warnMissingAllowList } from './ingest-filter';
import { sanitize } from './prompt-injection-guard';
import {
  applySubstitutions,
  checkRequirements,
  parseSkillFrontmatter,
  shouldInject,
} from './skill-compat';
import { UniversalScanner } from './universal-scanner';

interface CacheEntry {
  mtime: number;
  content: string;
}

export interface SkillsInjectorOptions {
  globalSkillsDir?: string;
  /** Called when a skill is skipped because of OpenClaw `requires`/`os` rules. */
  onSkip?: (skillId: string, reason: string) => void;
  /** Storage backend. Injected by the composition root; required — never
   *  falls back to raw disk. */
  storage: Storage;
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

/**
 * A skill admitted into a personality's effective set, before any prompt
 * content is built. `personality` skills carry their on-disk `filePath`;
 * `global` skills carry the parsed `Skill` from the universal scanner.
 * Produced by `SkillsInjector.resolveSkills` — the single eligibility
 * decision both `inject()` and read-only surfaces consume.
 */
export type ResolvedSkill =
  | { id: string; source: 'personality'; filePath: string }
  | { id: string; source: 'global'; skill: Skill };

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

  constructor(personalities: PersonalityRegistry, opts: SkillsInjectorOptions) {
    this.personalities = personalities;
    this.globalSkillsDir = opts.globalSkillsDir ?? join(homedir(), '.ethos', 'skills');
    this.onSkip = opts.onSkip;
    this.storage = opts.storage;
    this.toolNamesForPersonality = opts.toolNamesForPersonality;
    this.maxInjectionChars = opts.maxInjectionChars ?? 40_000;
    // Pass onSkip through so scan-time rejections (unparseable frontmatter,
    // safety findings) reach the same reporting seam as filter-time ones,
    // rather than vanishing.
    this.scanner =
      opts.scanner ?? new UniversalScanner({ storage: this.storage, onSkip: this.onSkip });
  }

  /**
   * Resolve the skill set visible to a personality WITHOUT building prompt
   * content — the eligibility decision only. Two sources:
   *   1. Per-personality `skills/` dirs — always included (OpenClaw
   *      `requires`/`os` rules still apply).
   *   2. Global pool — filtered through `filterSkill` + OpenClaw rules.
   *
   * `inject()` consumes this so "which skills does personality P see" lives
   * in exactly one place. Read-only surfaces that need the list but not the
   * prompt content (e.g. the Slack `/ethos personality rich` card) call it
   * directly.
   */
  async resolveSkills(personalityId: string | undefined): Promise<ResolvedSkill[]> {
    const personality = personalityId
      ? (this.personalities.get(personalityId) ?? this.personalities.getDefault())
      : this.personalities.getDefault();

    const resolved: ResolvedSkill[] = [];

    // 1. Per-personality skills/ dirs — always loaded unfiltered (hand-curated library)
    const perPersonalityDirs = personality.skillsDirs ?? [];
    for (const dir of perPersonalityDirs) {
      for (const filePath of await this.discoverSkillFiles(dir)) {
        const raw = await this.readCached(filePath);
        if (!raw) continue;
        const skillId = this.skillIdFor(filePath, dir);
        const parsed = parseSkillFrontmatter(raw);
        if (parsed) {
          const verdict = shouldInject(parsed.openclaw, {});
          if (!verdict.inject) {
            this.onSkip?.(skillId, verdict.reason ?? 'unknown');
            continue;
          }
        }
        resolved.push({ id: skillId, source: 'personality', filePath });
      }
    }

    // 2. Global pool from universal scanner — filtered per personality
    const globalPool = await this.scanner.scan();

    // Warn about missing allow-list references
    const allow = personality.skills?.global_ingest?.allow ?? [];
    if (allow.length > 0) {
      warnMissingAllowList(personality.id, allow, globalPool, (msg) =>
        process.stdout.write(`${msg}\n`),
      );
    }

    // null = tool availability unknown (no getter wired) — checkRequirements
    // skips the tools gate instead of treating every tool as missing.
    const toolNames = this.toolNamesForPersonality
      ? this.toolNamesForPersonality(personality)
      : null;

    for (const [, skill] of globalPool) {
      if (perPersonalityDirs.some((d) => skill.filePath.startsWith(d))) continue;

      const result = filterSkill(skill, personality, toolNames ?? new Set(), (msg) =>
        process.stdout.write(`${msg}\n`),
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

      // Gap 11 — environment-gated skills: check `ethos.requires` gates.
      const reqReason = checkRequirements(skill.requires, toolNames);
      if (reqReason) {
        skill.unavailableReason = reqReason;
        this.onSkip?.(skill.qualifiedName, reqReason);
        continue;
      }

      resolved.push({ id: skill.qualifiedName, source: 'global', skill });
    }

    return resolved;
  }

  /**
   * Renderer capabilities declared by the personality's resolved skill set —
   * the `ethos.renders` union over `resolveSkills(personalityId)`, sorted and
   * deduplicated. A surface consults this to decide whether a fenced block may
   * upgrade from a code block to an interactive renderer; an empty array means
   * "code block", which is also what every failure degrades to.
   *
   * Lives here rather than in a consumer because both skill sources need the
   * injector's private state: global-source skills carry the typed
   * `Skill.renders`, while per-personality-dir skills carry only a `filePath`
   * and must be frontmatter-parsed through the same mtime-cached read the
   * prompt path uses.
   */
  async resolveRenderers(personalityId: string | undefined): Promise<string[]> {
    const resolved = await this.resolveSkills(personalityId);
    const renderers = new Set<string>();

    for (const r of resolved) {
      if (r.source === 'global') {
        for (const spec of r.skill.renders ?? []) renderers.add(spec);
        continue;
      }
      const raw = await this.readCached(r.filePath);
      if (!raw) continue;
      const parsed = parseSkillFrontmatter(raw);
      if (!parsed) continue;
      for (const spec of parseEthosRenders(parsed.raw) ?? []) renderers.add(spec);
    }

    return [...renderers].sort();
  }

  async inject(ctx: PromptContext): Promise<InjectionResult | null> {
    const personality = ctx.personalityId
      ? (this.personalities.get(ctx.personalityId) ?? this.personalities.getDefault())
      : this.personalities.getDefault();

    const resolved = await this.resolveSkills(ctx.personalityId);

    const sections: string[] = [];
    const fileNames: string[] = [];
    // Stub rows for the shared `## Available Skills` index table. Personality
    // (index mode) and global (index mode) stubs both accumulate here so a
    // single table lists everything the model can `get_skill(name)`.
    const indexRows: string[] = [];
    let totalChars = 0;
    const budget = this.maxInjectionChars;

    function addSection(content: string, name: string): boolean {
      if (budget > 0 && totalChars + content.length > budget) return false;
      sections.push(content);
      fileNames.push(name);
      totalChars += content.length;
      return true;
    }

    // Determine injection mode for global-pool skills.
    // 'index' (default) injects a compact table; 'full' injects complete bodies.
    // Phase 4 small-window mode forces index for BOTH pools regardless of the
    // personality setting — skills are a fixed cost a small window can't afford.
    const forceIndex = ctx.skillsIndexMode === true;
    const injectionMode: 'full' | 'index' = forceIndex
      ? 'index'
      : (personality.skills?.injection_mode ?? 'index');
    // Per-personality `skillsDirs` skills honor an EXPLICIT `injection_mode:
    // index` (become stubs, reachable via `get_skill`). Absent/`full` keeps the
    // historical always-inline behavior for the hand-curated library — the
    // global-pool default of `index` does not silently stub a personality's own
    // skills. `get_skill` resolves a stubbed personality skill via
    // `loadSkillBody()`.
    const personalityIndex = forceIndex || personality.skills?.injection_mode === 'index';

    // 1. Per-personality skills — hand-curated library.
    for (const r of resolved) {
      if (r.source !== 'personality') continue;
      const raw = await this.readCached(r.filePath);
      if (!raw) continue;
      const parsed = parseSkillFrontmatter(raw);
      if (personalityIndex) {
        const desc = parsed?.description ?? '—';
        indexRows.push(`| \`${r.id}\` | ${desc} |`);
        continue;
      }
      const body = parsed ? parsed.body : raw;
      const substituted = applySubstitutions(body, dirname(r.filePath), ctx.sessionId);
      addSection(sanitize(substituted.trim()), r.id);
    }

    // 2. Global pool from universal scanner — filtered per personality (resolved above)
    const eligibleGlobal = resolved.flatMap((r) => (r.source === 'global' ? [r.skill] : []));

    if (injectionMode === 'index') {
      // Phase 1: compact index table — the LLM calls get_skill() for full bodies
      for (const s of eligibleGlobal) {
        const desc = (s.rawFrontmatter.description as string | undefined) ?? '—';
        indexRows.push(`| \`${s.qualifiedName}\` | ${desc} |`);
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

    // Emit the shared index table once, if any skill was stubbed.
    if (indexRows.length > 0) {
      const indexBlock =
        `## Available Skills\n\n` +
        `Call \`get_skill(name)\` to load full instructions before using any skill.\n\n` +
        `| Skill | Description |\n` +
        `|---|---|\n` +
        indexRows.join('\n');
      sections.push(indexBlock);
      fileNames.push('__skill_index__');
    }

    if (sections.length === 0) return null;

    ctx.meta ??= {};
    ctx.meta.skillFilesUsed = fileNames.filter((n) => n !== '__skill_index__');

    return {
      content: `## Skills\n\n${sections.join('\n\n---\n\n')}`,
      position: 'append',
    };
  }

  /**
   * Resolve a single personality-`skillsDirs` skill's full body by id — the
   * on-demand counterpart to the index stub. `get_skill` calls this when the
   * global scanner pool misses, so personality skills injected as stubs in
   * `index` mode are still reachable (never stranded). Returns null when no
   * eligible personality skill matches `skillId`.
   */
  async loadSkillBody(
    personalityId: string | undefined,
    skillId: string,
    sessionId: string,
  ): Promise<string | null> {
    const resolved = await this.resolveSkills(personalityId);
    const match = resolved.find((r) => r.source === 'personality' && r.id === skillId);
    if (match?.source !== 'personality') return null;
    const raw = await this.readCached(match.filePath);
    if (!raw) return null;
    const parsed = parseSkillFrontmatter(raw);
    const body = parsed ? parsed.body : raw;
    const substituted = applySubstitutions(body, dirname(match.filePath), sessionId);
    return sanitize(substituted.trim());
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
