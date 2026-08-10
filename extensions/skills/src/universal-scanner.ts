import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { canInstall, scanSkillMd, type TrustTier } from '@ethosagent/safety-scanner';
import type { Skill, Storage } from '@ethosagent/types';
import matter from 'gray-matter';
import { canParse as canParseAgentSkills, parseAgentSkills } from './dialects/agentskills';
import { canParse as canParseHermes, parseHermes } from './dialects/hermes';
import { canParse as canParseOpenClaw, parseOpenClaw } from './dialects/openclaw';

export interface ScanSource {
  /** Label used in qualified names: `<source>/<name>`. */
  label: string;
  /** Absolute path to scan. */
  dir: string;
}

export interface UniversalScannerOptions {
  /**
   * Untrusted extension point — additional source directories beyond the
   * built-in defaults. Skills loaded from these sources are ALWAYS gated
   * at the `community` tier (red AND yellow safety findings block) so a
   * caller cannot escalate trust by passing in a custom directory.
   */
  extraSources?: ScanSource[];
  /**
   * First-party extension point — for content shipped inside Ethos itself
   * (the bundled coding skills package, future bundled skill packs). Skills
   * loaded from these sources are gated at the `trusted-repo` tier (red
   * still blocks; yellow is auto-acknowledged) so legitimate mentions of
   * `bash`, `gh`, `curl`, etc. in skill bodies don't trip the scanner.
   *
   * IMPORTANT: only callers that ship code as part of Ethos (i.e. live in
   * this monorepo) should populate this. User config / plugins / MCP / any
   * caller-controlled list goes through `extraSources`.
   */
  trustedFirstPartySources?: ScanSource[];
  /**
   * Override ALL default sources. Use in tests to avoid scanning real
   * ~/.ethos/skills/, ~/.claude/skills/, etc. Each entry is gated at the
   * `community` tier — callers that want trusted-tier sources in tests
   * combine this with `trustedFirstPartySources`.
   */
  sources?: ScanSource[];
  /** Storage backend. Injected by the composition root; required — never
   *  falls back to raw disk. */
  storage: Storage;
  /** Called when a skill is rejected by the safety scan. */
  onSkip?: (qualifiedName: string, reason: string) => void;
}

interface ResolvedSource extends ScanSource {
  trustTier: TrustTier;
}

interface CacheEntry {
  mtime: number;
  skill: Skill;
}

/**
 * Default skill discovery sources.
 * Only ethos-managed directories are on by default. External tool home-dirs
 * (~/.claude/skills, ~/.openclaw/skills, etc.) are opt-in via extraSources
 * because they can contain hundreds of files not intended for ethos.
 */
function defaultTrustedSources(): ScanSource[] {
  // ~/.ethos/skills/ is user-managed local content. We treat it as
  // trusted-repo so the user's own skills aren't blocked by yellow findings
  // (legitimate mentions of bash, curl, etc.). Red findings (prompt
  // injection) still block.
  return [{ label: 'ethos', dir: join(homedir(), '.ethos', 'skills') }];
}

function defaultCommunitySources(): ScanSource[] {
  const home = homedir();
  const cwd = process.cwd();
  return [
    { label: 'claude-code', dir: join(home, '.claude', 'skills') },
    { label: 'claude-code-project', dir: join(cwd, '.claude', 'skills') },
    { label: 'opencode-project', dir: join(cwd, '.opencode', 'skills') },
  ];
}

/** Pre-built source descriptors for external tools — add to extraSources to opt in. */
export function externalSources(): ScanSource[] {
  const home = homedir();
  return [
    { label: 'claude-code', dir: join(home, '.claude', 'skills') },
    { label: 'openclaw', dir: join(home, '.openclaw', 'skills') },
    { label: 'opencode', dir: join(home, '.config', 'opencode', 'skills') },
    { label: 'hermes', dir: join(home, '.hermes', 'skills') },
  ];
}

/**
 * Scans multiple source directories, parses all skill files using dialect
 * detection, and returns a deduped pool keyed by `qualifiedName`.
 * First source wins on name collisions.
 *
 * Trust tier is set by which option a source arrives through, never by
 * the caller — `extraSources` is always `community`, `trustedFirstParty
 * Sources` is always `trusted-repo`. There is no way for an untrusted
 * caller to claim trust by guessing a privileged label.
 */
export class UniversalScanner {
  private readonly sources: ResolvedSource[];
  private readonly storage: Storage;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly onSkip?: (qualifiedName: string, reason: string) => void;

  constructor(opts: UniversalScannerOptions) {
    this.storage = opts.storage;
    const trustedDefaults = opts.sources ? [] : defaultTrustedSources();
    const communityDefaults = opts.sources ?? defaultCommunitySources();
    this.sources = [
      ...trustedDefaults.map((s) => withTier(s, 'trusted-repo')),
      ...(opts.trustedFirstPartySources ?? []).map((s) => withTier(s, 'trusted-repo')),
      ...communityDefaults.map((s) => withTier(s, 'community')),
      ...(opts.extraSources ?? []).map((s) => withTier(s, 'community')),
    ];
    this.onSkip = opts.onSkip;
  }

  /**
   * Returns the global skill pool as a map of qualifiedName → Skill.
   * Logs a one-line boot summary to stdout.
   */
  async scan(): Promise<Map<string, Skill>> {
    const pool = new Map<string, Skill>();

    for (const source of this.sources) {
      const files = await this.discoverFiles(source.dir);
      for (const filePath of files) {
        const skill = await this.loadSkill(filePath, source);
        if (!skill) continue;
        // First source wins on name collision
        if (!pool.has(skill.qualifiedName)) {
          pool.set(skill.qualifiedName, skill);
        }
      }
    }

    return pool;
  }

  /**
   * Add extra community-tier sources after construction. Called by wiring
   * after plugin loading to inject plugin-declared skill directories into
   * the live scanner without rebuilding it.
   */
  addExtraSources(sources: ScanSource[]): void {
    for (const s of sources) {
      this.sources.push(withTier(s, 'community'));
    }
  }

  private async discoverFiles(dir: string): Promise<string[]> {
    let entries: Awaited<ReturnType<Storage['listEntries']>>;
    try {
      entries = await this.storage.listEntries(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
      this.onSkip?.(dir, `skill source not readable (${code}) — skipped`);
      return [];
    }
    if (entries.length === 0) return [];

    const found: string[] = [];
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name === 'pending') continue;
      if (entry.isDir) {
        const subPath = join(dir, entry.name);
        const skillMd = join(subPath, 'SKILL.md');
        if ((await this.storage.mtime(skillMd)) !== null) {
          found.push(skillMd);
          continue;
        }
        // Scoped: <dir>/<scope>/<slug>/SKILL.md
        let inner: Awaited<ReturnType<Storage['listEntries']>>;
        try {
          inner = await this.storage.listEntries(subPath);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
          this.onSkip?.(subPath, `skill source not readable (${code}) — skipped`);
          continue;
        }
        for (const child of [...inner].sort((a, b) => a.name.localeCompare(b.name))) {
          if (!child.isDir) continue;
          const nested = join(subPath, child.name, 'SKILL.md');
          if ((await this.storage.mtime(nested)) !== null) found.push(nested);
        }
      } else if (entry.name.endsWith('.md')) {
        found.push(join(dir, entry.name));
      }
    }
    return found;
  }

  private skillNameFor(filePath: string, sourceDir: string): string {
    const b = basename(filePath);
    if (b !== 'SKILL.md') return b.replace(/\.md$/, '');
    const parentDir = dirname(filePath);
    const grandparent = dirname(parentDir);
    if (grandparent === sourceDir) return basename(parentDir);
    return `${basename(grandparent)}/${basename(parentDir)}`;
  }

  private async loadSkill(filePath: string, source: ResolvedSource): Promise<Skill | null> {
    const mtimeMs = await this.storage.mtime(filePath);
    if (mtimeMs === null) return null;

    const cached = this.cache.get(filePath);
    if (cached && cached.mtime === mtimeMs) return cached.skill;

    const raw = await this.storage.read(filePath);
    if (!raw) return null;

    const name = this.skillNameFor(filePath, source.dir);
    const qualifiedName = `${source.label}/${name}`;

    const skill = this.parseWithDialect(raw, filePath, source.label, name, qualifiedName, mtimeMs);
    if (!skill) return null;

    // Trust tier is fixed by which option the source arrived through —
    // `extraSources` always lands on `community`, `trustedFirstParty
    // Sources` on `trusted-repo`. Callers cannot self-escalate.
    const scanResult = scanSkillMd(raw, filePath);
    const decision = canInstall(scanResult, source.trustTier);
    if (!decision.allowed) {
      this.onSkip?.(qualifiedName, `safety scan: ${decision.blockedBy}`);
      return null;
    }

    this.cache.set(filePath, { mtime: mtimeMs, skill });
    return skill;
  }

  /**
   * Returns null when the file's frontmatter is unparseable. gray-matter
   * parses YAML strictly, so an agent-authored skill with (say) an unquoted
   * `": "` in its description throws here — and this runs at startup, before
   * any port is bound. One bad file must cost one skill, not the process.
   */
  private parseWithDialect(
    raw: string,
    filePath: string,
    source: string,
    name: string,
    qualifiedName: string,
    mtimeMs: number,
  ): Skill | null {
    let fm: Record<string, unknown>;
    let content: string;
    try {
      // `{}` bypasses gray-matter's module-global cache, which is populated
      // BEFORE parsing — a throw leaves a half-built entry behind, so the same
      // bad file would parse "successfully" into garbage on the next scan.
      const file = matter(raw, {});
      fm = file.data as Record<string, unknown>;
      content = file.content;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.onSkip?.(qualifiedName, `invalid frontmatter: ${message.split('\n')[0] ?? message}`);
      return null;
    }

    let partial: Omit<Skill, 'qualifiedName'> | null = null;

    if (canParseOpenClaw(fm)) {
      partial = parseOpenClaw(raw, filePath, source, name, mtimeMs);
    } else if (canParseAgentSkills(fm)) {
      partial = parseAgentSkills(raw, filePath, source, name, mtimeMs);
    } else if (canParseHermes(fm)) {
      partial = parseHermes(raw, filePath, source, name, mtimeMs);
    }

    if (partial) return { ...partial, qualifiedName };

    // Legacy: plain markdown with no recognized frontmatter
    return {
      qualifiedName,
      name,
      source,
      filePath,
      body: content.trim() || raw,
      rawFrontmatter: fm,
      dialect: 'legacy',
      mtimeMs,
    };
  }
}

function withTier(source: ScanSource, trustTier: TrustTier): ResolvedSource {
  return { ...source, trustTier };
}
