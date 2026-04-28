import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EthosError, type PersonalityConfig, type PersonalityRegistry } from '@ethosagent/types';

// Wraps `@ethosagent/personalities`'s registry. Stays thin — the registry
// already handles directory loading + mtime cache. We add:
//   • `builtin` flag derived from where ethosFile lives
//   • `readEthosMd` so the service doesn't reach into node:fs
//   • CRUD primitives for the v1 Personalities tab — write the per-
//     personality files and refresh the registry so subsequent reads
//     see the change without a server restart.
//
// Built-ins live in the package's bundled `data/` dir (read-only); only
// personalities under `<dataDir>/personalities/<id>/` can be mutated.
// `requireMutable` enforces this.

export interface PersonalityRepositoryOptions {
  registry: PersonalityRegistry;
  /** User data directory (typically `~/.ethos`). Personalities under
   *  `<dataDir>/personalities/` are user-created (mutable); anything else
   *  came from the package's bundled built-ins. */
  userPersonalitiesDir: string;
}

export interface DescribedPersonality {
  config: PersonalityConfig;
  builtin: boolean;
}

export interface CreatePersonalityInput {
  id: string;
  name: string;
  description?: string;
  model?: string;
  toolset: string[];
  ethosMd: string;
  memoryScope?: 'global' | 'per-personality';
}

export interface UpdatePersonalityPatch {
  name?: string;
  description?: string;
  model?: string;
  toolset?: string[];
  ethosMd?: string;
  memoryScope?: 'global' | 'per-personality';
}

export class PersonalityRepository {
  private readonly userDir: string;
  private readonly userDirPrefix: string;

  constructor(private readonly opts: PersonalityRepositoryOptions) {
    this.userDir = join(opts.userPersonalitiesDir, 'personalities');
    this.userDirPrefix = `${this.userDir}/`;
  }

  list(): DescribedPersonality[] {
    return this.opts.registry.list().map((config) => this.describe(config));
  }

  get(id: string): DescribedPersonality | null {
    const config = this.opts.registry.get(id);
    return config ? this.describe(config) : null;
  }

  defaultId(): string {
    return this.opts.registry.getDefault().id;
  }

  /** Absolute path of the user-personality directory, even if it doesn't exist yet. */
  userPathFor(id: string): string {
    return join(this.userDir, id);
  }

  /**
   * Read the ETHOS.md body for a personality. Returns `''` if the
   * personality has no `ethosFile` (config-only personalities) or if the
   * file isn't readable for any reason.
   */
  async readEthosMd(id: string): Promise<string> {
    const config = this.opts.registry.get(id);
    if (!config?.ethosFile) return '';
    try {
      return await readFile(config.ethosFile, 'utf-8');
    } catch {
      return '';
    }
  }

  async create(input: CreatePersonalityInput): Promise<DescribedPersonality> {
    if (this.opts.registry.get(input.id)) {
      throw new EthosError({
        code: 'PERSONALITY_EXISTS',
        cause: `Personality "${input.id}" already exists.`,
        action: 'Pick a different id, or open the existing one to edit it.',
      });
    }
    const dir = this.userPathFor(input.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'config.yaml'), this.renderConfigYaml(input), 'utf-8');
    await writeFile(join(dir, 'toolset.yaml'), this.renderToolsetYaml(input.toolset), 'utf-8');
    await writeFile(join(dir, 'ETHOS.md'), input.ethosMd, 'utf-8');
    await this.refresh();
    const created = this.get(input.id);
    if (!created) {
      throw new EthosError({
        code: 'INTERNAL',
        cause: `Created personality "${input.id}" but registry refresh did not pick it up.`,
        action: 'Restart `ethos serve` to recover.',
      });
    }
    return created;
  }

  async update(id: string, patch: UpdatePersonalityPatch): Promise<DescribedPersonality> {
    const existing = this.requireMutable(id);
    const dir = this.dirOf(existing);
    if (
      patch.name !== undefined ||
      patch.description !== undefined ||
      patch.model !== undefined ||
      patch.memoryScope !== undefined
    ) {
      const config = existing.config;
      const merged: CreatePersonalityInput = {
        id: config.id,
        name: patch.name ?? config.name,
        description: patch.description ?? config.description,
        model: patch.model ?? config.model,
        toolset: patch.toolset ?? config.toolset ?? [],
        ethosMd: '',
        memoryScope: patch.memoryScope ?? config.memoryScope,
      };
      await writeFile(join(dir, 'config.yaml'), this.renderConfigYaml(merged), 'utf-8');
    }
    if (patch.toolset !== undefined) {
      await writeFile(join(dir, 'toolset.yaml'), this.renderToolsetYaml(patch.toolset), 'utf-8');
    }
    if (patch.ethosMd !== undefined) {
      await writeFile(join(dir, 'ETHOS.md'), patch.ethosMd, 'utf-8');
    }
    await this.refresh();
    const refreshed = this.get(id);
    if (!refreshed) {
      throw new EthosError({
        code: 'INTERNAL',
        cause: `Updated personality "${id}" but registry refresh did not pick it up.`,
        action: 'Restart `ethos serve` to recover.',
      });
    }
    return refreshed;
  }

  async delete(id: string): Promise<void> {
    const existing = this.requireMutable(id);
    const dir = this.dirOf(existing);
    await rm(dir, { recursive: true, force: true });
    this.opts.registry.remove(id);
  }

  /**
   * Copy a built-in (or any other) personality directory into the user
   * dir under a new id. Both source and destination are read from the
   * registry's resolved paths so the copy works regardless of where the
   * built-ins live in the package layout.
   */
  async duplicate(id: string, newId: string): Promise<DescribedPersonality> {
    if (this.opts.registry.get(newId)) {
      throw new EthosError({
        code: 'PERSONALITY_EXISTS',
        cause: `Personality "${newId}" already exists.`,
        action: 'Pick a different id for the duplicate.',
      });
    }
    const src = this.opts.registry.get(id);
    if (!src) {
      throw new EthosError({
        code: 'PERSONALITY_NOT_FOUND',
        cause: `Personality "${id}" not found.`,
        action: 'Use personalities.list to see available ids.',
      });
    }
    const sourceDir = src.ethosFile
      ? src.ethosFile.replace(/\/ETHOS\.md$/, '')
      : src.skillsDirs?.[0]?.replace(/\/skills$/, '');
    if (!sourceDir) {
      throw new EthosError({
        code: 'INTERNAL',
        cause: `Personality "${id}" has no resolvable source directory to copy.`,
        action: 'Edit the source manually, or pick a different built-in.',
      });
    }
    const destDir = this.userPathFor(newId);
    await mkdir(this.userDir, { recursive: true });
    await cp(sourceDir, destDir, { recursive: true });
    // Rewrite config.yaml's `name:` line so the duplicate has its own
    // display label — mirrors the plan's expectation that the editor
    // opens "on the copy" with a distinct identity ready to be edited.
    await this.bumpDuplicateName(destDir, newId, src.name);
    await this.refresh();
    const created = this.get(newId);
    if (!created) {
      throw new EthosError({
        code: 'INTERNAL',
        cause: `Duplicated "${id}" → "${newId}" but registry refresh did not pick it up.`,
        action: 'Restart `ethos serve` to recover.',
      });
    }
    return created;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private requireMutable(id: string): DescribedPersonality {
    const existing = this.get(id);
    if (!existing) {
      throw new EthosError({
        code: 'PERSONALITY_NOT_FOUND',
        cause: `Personality "${id}" not found.`,
        action: 'Use personalities.list to see available ids.',
      });
    }
    if (existing.builtin) {
      throw new EthosError({
        code: 'PERSONALITY_READ_ONLY',
        cause: `Personality "${id}" is built-in and cannot be modified directly.`,
        action: 'Duplicate it via personalities.duplicate, then edit the copy.',
      });
    }
    return existing;
  }

  private describe(config: PersonalityConfig): DescribedPersonality {
    const ethosFile = config.ethosFile;
    const builtin = ethosFile ? !ethosFile.startsWith(this.userDirPrefix) : true;
    return { config, builtin };
  }

  private dirOf(p: DescribedPersonality): string {
    const ethosFile = p.config.ethosFile;
    if (ethosFile) return ethosFile.replace(/\/ETHOS\.md$/, '');
    return this.userPathFor(p.config.id);
  }

  private async refresh(): Promise<void> {
    await this.opts.registry.loadFromDirectory(this.userDir);
  }

  private renderConfigYaml(input: CreatePersonalityInput): string {
    const lines: string[] = [`name: ${input.name}`];
    if (input.description) lines.push(`description: ${input.description}`);
    if (input.model) lines.push(`model: ${input.model}`);
    if (input.memoryScope) lines.push(`memoryScope: ${input.memoryScope}`);
    return `${lines.join('\n')}\n`;
  }

  private renderToolsetYaml(toolset: string[]): string {
    if (toolset.length === 0) return '# No tools enabled — agent runs without external action.\n';
    return `${toolset.map((t) => `- ${t}`).join('\n')}\n`;
  }

  private async bumpDuplicateName(
    dir: string,
    newId: string,
    sourceName: string | undefined,
  ): Promise<void> {
    const path = join(dir, 'config.yaml');
    let raw = '';
    try {
      raw = await readFile(path, 'utf-8');
    } catch {
      return;
    }
    const newName = sourceName ? `${sourceName} (copy)` : newId;
    const lines = raw.split('\n');
    let nameSet = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^name:\s*/.test(lines[i] ?? '')) {
        lines[i] = `name: ${newName}`;
        nameSet = true;
        break;
      }
    }
    if (!nameSet) lines.unshift(`name: ${newName}`);
    await writeFile(path, lines.join('\n'), 'utf-8');
  }
}
