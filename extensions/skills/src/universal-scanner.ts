import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
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
  /** Extra source directories beyond the built-in defaults. */
  extraSources?: ScanSource[];
  /**
   * Override ALL sources (skips defaultSources). Use in tests to avoid
   * scanning real ~/.ethos/skills/, ~/.claude/skills/, etc.
   */
  sources?: ScanSource[];
  storage?: Storage;
}

interface CacheEntry {
  mtime: number;
  skill: Skill;
}

/** Default skill discovery sources in priority order. */
function defaultSources(): ScanSource[] {
  const home = homedir();
  const cwd = process.cwd();
  return [
    { label: 'ethos', dir: join(home, '.ethos', 'skills') },
    { label: 'claude-code', dir: join(home, '.claude', 'skills') },
    { label: 'claude-code-project', dir: join(cwd, '.claude', 'skills') },
    { label: 'openclaw', dir: join(home, '.openclaw', 'skills') },
    { label: 'opencode', dir: join(home, '.config', 'opencode', 'skills') },
    { label: 'opencode-project', dir: join(cwd, '.opencode', 'skills') },
    { label: 'hermes', dir: join(home, '.hermes', 'skills') },
  ];
}

/**
 * Scans multiple source directories, parses all skill files using dialect
 * detection, and returns a deduped pool keyed by `qualifiedName`.
 * First source wins on name collisions.
 */
export class UniversalScanner {
  private readonly sources: ScanSource[];
  private readonly storage: Storage;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: UniversalScannerOptions = {}) {
    this.storage = opts.storage ?? new FsStorage();
    this.sources = opts.sources
      ? opts.sources
      : [...defaultSources(), ...(opts.extraSources ?? [])];
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
        const skill = await this.loadSkill(filePath, source.label);
        if (!skill) continue;
        // First source wins on name collision
        if (!pool.has(skill.qualifiedName)) {
          pool.set(skill.qualifiedName, skill);
        }
      }
    }

    return pool;
  }

  private async discoverFiles(dir: string): Promise<string[]> {
    const entries = await this.storage.listEntries(dir);
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
        const inner = await this.storage.listEntries(subPath);
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

  private async loadSkill(filePath: string, sourceLabel: string): Promise<Skill | null> {
    const mtimeMs = await this.storage.mtime(filePath);
    if (mtimeMs === null) return null;

    const cached = this.cache.get(filePath);
    if (cached && cached.mtime === mtimeMs) return cached.skill;

    const raw = await this.storage.read(filePath);
    if (!raw) return null;

    const sourceDir =
      this.sources.find((s) => filePath.startsWith(s.dir + '/'))?.dir ?? dirname(filePath);
    const name = this.skillNameFor(filePath, sourceDir);
    const qualifiedName = `${sourceLabel}/${name}`;

    const skill = this.parseWithDialect(raw, filePath, sourceLabel, name, qualifiedName, mtimeMs);
    this.cache.set(filePath, { mtime: mtimeMs, skill });
    return skill;
  }

  private parseWithDialect(
    raw: string,
    filePath: string,
    source: string,
    name: string,
    qualifiedName: string,
    mtimeMs: number,
  ): Skill {
    const { data } = matter(raw);
    const fm = data as Record<string, unknown>;

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
    const { content } = matter(raw);
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
