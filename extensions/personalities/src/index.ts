import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import { EthosError, type PersonalityConfig, type PersonalityRegistry, type Storage } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// YAML parsers — no external dependency, handles the subset we need
// ---------------------------------------------------------------------------

function parseConfigYaml(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of src.split('\n')) {
    // Allow dotted keys (e.g. `fs_reach.read`) so nested config can land
    // in the flat parser without escaping.
    const m = line.match(/^([\w.]+):\s*(.+)$/);
    if (m) out[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function parseToolsetYaml(src: string): string[] {
  return src
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// FilePersonalityRegistry
// ---------------------------------------------------------------------------

export interface DescribedPersonality {
  config: PersonalityConfig;
  /** True if the personality is loaded from the package's bundled data dir
   *  (read-only); false if it lives under the user's writable
   *  `<userPersonalitiesDir>/<id>/`. */
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

export class FilePersonalityRegistry implements PersonalityRegistry {
  private readonly personalities = new Map<string, PersonalityConfig>();
  // dir → fingerprint of config.yaml + ETHOS.md + toolset.yaml mtimes
  private readonly fingerprintCache = new Map<string, string>();
  private defaultId = 'researcher';
  private readonly storage: Storage;
  /** Directory holding user-created personalities (mutable). When unset,
   *  CRUD methods (create/update/delete/duplicate) are unavailable. */
  private readonly userDir: string | undefined;

  constructor(storage: Storage = new FsStorage(), userPersonalitiesDir?: string) {
    this.storage = storage;
    this.userDir = userPersonalitiesDir ? join(userPersonalitiesDir, 'personalities') : undefined;
  }

  // -------------------------------------------------------------------------
  // Interface methods
  // -------------------------------------------------------------------------

  define(config: PersonalityConfig): void {
    this.personalities.set(config.id, config);
  }

  get(id: string): PersonalityConfig | undefined {
    return this.personalities.get(id);
  }

  list(): PersonalityConfig[] {
    return [...this.personalities.values()];
  }

  getDefault(): PersonalityConfig {
    return (
      this.personalities.get(this.defaultId) ??
      this.personalities.values().next().value ?? {
        id: 'default',
        name: 'Default',
      }
    );
  }

  setDefault(id: string): void {
    if (!this.personalities.has(id)) throw new Error(`Unknown personality: ${id}`);
    this.defaultId = id;
  }

  remove(id: string): void {
    this.personalities.delete(id);
    // Also drop fingerprint entries for that id's directory so a
    // subsequent re-create with the same id rebuilds cleanly. We
    // don't know the dir from the id alone, so iterate.
    for (const [dir] of this.fingerprintCache) {
      if (dir.endsWith(`/${id}`)) {
        this.fingerprintCache.delete(dir);
        break;
      }
    }
  }

  async loadFromDirectory(dir: string): Promise<void> {
    const entries = await this.storage.list(dir);
    if (entries.length === 0) return;

    await Promise.all(
      entries.map(async (entry) => {
        const personalityDir = join(dir, entry);
        await this.loadOne(personalityDir, entry);
      }),
    );
  }

  // -------------------------------------------------------------------------
  // CRUD — only available when `userPersonalitiesDir` was passed to the
  // constructor. Built-ins live in the package's bundled `data/` dir and
  // cannot be modified directly; clone via `duplicate` then edit the copy.
  // -------------------------------------------------------------------------

  /** Absolute path of the user-personality directory, even if it doesn't
   *  exist yet. Throws when no user dir was configured. */
  userPathFor(id: string): string {
    if (!this.userDir) {
      throw new Error(
        'FilePersonalityRegistry: userPathFor() requires a userPersonalitiesDir at construction time.',
      );
    }
    return join(this.userDir, id);
  }

  describe(id: string): DescribedPersonality | null {
    const config = this.personalities.get(id);
    return config ? this.toDescribed(config) : null;
  }

  describeAll(): DescribedPersonality[] {
    return [...this.personalities.values()].map((c) => this.toDescribed(c));
  }

  /**
   * Read the ETHOS.md body for a personality. Returns `''` if the
   * personality has no `ethosFile` (config-only personalities) or if the
   * file isn't readable.
   */
  async readEthosMd(id: string): Promise<string> {
    const config = this.personalities.get(id);
    if (!config?.ethosFile) return '';
    return (await this.storage.read(config.ethosFile)) ?? '';
  }

  async create(input: CreatePersonalityInput): Promise<DescribedPersonality> {
    if (this.personalities.get(input.id)) {
      throw new EthosError({
        code: 'PERSONALITY_EXISTS',
        cause: `Personality "${input.id}" already exists.`,
        action: 'Pick a different id, or open the existing one to edit it.',
      });
    }
    const dir = this.userPathFor(input.id);
    await this.storage.mkdir(dir);
    await this.storage.write(join(dir, 'config.yaml'), renderConfigYaml(input));
    await this.storage.write(join(dir, 'toolset.yaml'), renderToolsetYaml(input.toolset));
    await this.storage.write(join(dir, 'ETHOS.md'), input.ethosMd);
    await this.refreshUserDir();
    const created = this.describe(input.id);
    if (!created) {
      throw new EthosError({
        code: 'INTERNAL',
        cause: `Created personality "${input.id}" but registry refresh did not pick it up.`,
        action: 'Restart the server to recover.',
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
      await this.storage.write(join(dir, 'config.yaml'), renderConfigYaml(merged));
    }
    if (patch.toolset !== undefined) {
      await this.storage.write(join(dir, 'toolset.yaml'), renderToolsetYaml(patch.toolset));
    }
    if (patch.ethosMd !== undefined) {
      await this.storage.write(join(dir, 'ETHOS.md'), patch.ethosMd);
    }
    await this.refreshUserDir();
    const refreshed = this.describe(id);
    if (!refreshed) {
      throw new EthosError({
        code: 'INTERNAL',
        cause: `Updated personality "${id}" but registry refresh did not pick it up.`,
        action: 'Restart the server to recover.',
      });
    }
    return refreshed;
  }

  async deletePersonality(id: string): Promise<void> {
    const existing = this.requireMutable(id);
    const dir = this.dirOf(existing);
    await this.storage.remove(dir, { recursive: true });
    this.remove(id);
  }

  /**
   * Copy a built-in (or any other) personality directory into the user
   * dir under a new id. The duplicate's `name:` line is rewritten to
   * "<original> (copy)" so the editor opens with a distinct identity
   * ready to be edited.
   */
  async duplicate(id: string, newId: string): Promise<DescribedPersonality> {
    if (this.personalities.get(newId)) {
      throw new EthosError({
        code: 'PERSONALITY_EXISTS',
        cause: `Personality "${newId}" already exists.`,
        action: 'Pick a different id for the duplicate.',
      });
    }
    const src = this.personalities.get(id);
    if (!src) {
      throw new EthosError({
        code: 'PERSONALITY_NOT_FOUND',
        cause: `Personality "${id}" not found.`,
        action: 'Use list() to see available ids.',
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
    if (!this.userDir) throw new Error('userDir undefined after userPathFor() call');
    await this.storage.mkdir(this.userDir);
    await copyTree(this.storage, sourceDir, destDir);
    await this.bumpDuplicateName(destDir, newId, src.name);
    await this.refreshUserDir();
    const created = this.describe(newId);
    if (!created) {
      throw new EthosError({
        code: 'INTERNAL',
        cause: `Duplicated "${id}" → "${newId}" but registry refresh did not pick it up.`,
        action: 'Restart the server to recover.',
      });
    }
    return created;
  }

  // -------------------------------------------------------------------------
  // CRUD internals
  // -------------------------------------------------------------------------

  private requireMutable(id: string): DescribedPersonality {
    const existing = this.describe(id);
    if (!existing) {
      throw new EthosError({
        code: 'PERSONALITY_NOT_FOUND',
        cause: `Personality "${id}" not found.`,
        action: 'Use list() to see available ids.',
      });
    }
    if (existing.builtin) {
      throw new EthosError({
        code: 'PERSONALITY_READ_ONLY',
        cause: `Personality "${id}" is built-in and cannot be modified directly.`,
        action: 'Duplicate it via duplicate(), then edit the copy.',
      });
    }
    return existing;
  }

  private toDescribed(config: PersonalityConfig): DescribedPersonality {
    const ethosFile = config.ethosFile;
    const userPrefix = this.userDir ? `${this.userDir}/` : null;
    const builtin = userPrefix && ethosFile ? !ethosFile.startsWith(userPrefix) : true;
    return { config, builtin };
  }

  private dirOf(p: DescribedPersonality): string {
    const ethosFile = p.config.ethosFile;
    if (ethosFile) return ethosFile.replace(/\/ETHOS\.md$/, '');
    return this.userPathFor(p.config.id);
  }

  private async refreshUserDir(): Promise<void> {
    if (!this.userDir) return;
    await this.loadFromDirectory(this.userDir);
  }

  private async bumpDuplicateName(
    dir: string,
    newId: string,
    sourceName: string | undefined,
  ): Promise<void> {
    const path = join(dir, 'config.yaml');
    const raw = await this.storage.read(path);
    if (raw === null) return;
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
    await this.storage.write(path, lines.join('\n'));
  }

  // -------------------------------------------------------------------------
  // Built-in loader
  // -------------------------------------------------------------------------

  async loadBuiltins(): Promise<void> {
    // import.meta.dirname is the extensions/personalities/src directory
    const dataDir = join(import.meta.dirname, '..', 'data');
    await this.loadFromDirectory(dataDir);
    // Ensure researcher is the default if present
    if (this.personalities.has('researcher')) this.defaultId = 'researcher';
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async loadOne(dir: string, id: string): Promise<void> {
    // Fingerprint guard — invalidate when any of the three personality files change.
    // mtime alone is enough: filesystems we run on (APFS / ext4 / NTFS) all
    // expose sub-millisecond mtime, so two writes within the same tick
    // is vanishingly unlikely for personality files (humans editing config).
    const fingerprint = await this.fileFingerprint([
      join(dir, 'config.yaml'),
      join(dir, 'ETHOS.md'),
      join(dir, 'toolset.yaml'),
    ]);
    if (this.fingerprintCache.get(dir) === fingerprint) return;
    this.fingerprintCache.set(dir, fingerprint);

    const config = await this.buildConfig(dir, id);
    if (config) this.define(config);
  }

  private async buildConfig(dir: string, id: string): Promise<PersonalityConfig | null> {
    // Must have at least config.yaml or ETHOS.md to be considered a personality
    const [configSrc, toolsetSrc, ethosExists, skillsExists] = await Promise.all([
      this.storage.read(join(dir, 'config.yaml')),
      this.storage.read(join(dir, 'toolset.yaml')),
      this.storage.exists(join(dir, 'ETHOS.md')),
      this.storage.exists(join(dir, 'skills')),
    ]);

    if (!configSrc && !ethosExists) return null;

    const cfg = configSrc ? parseConfigYaml(configSrc) : {};

    const capabilities = cfg.capabilities
      ? cfg.capabilities
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    const streamingTimeoutMs =
      cfg.streamingTimeoutMs && /^\d+$/.test(cfg.streamingTimeoutMs)
        ? Number.parseInt(cfg.streamingTimeoutMs, 10)
        : undefined;

    // fs_reach.read / fs_reach.write are comma-separated path lists.
    // Substitutions (${ETHOS_HOME}, ${self}, ${CWD}) are resolved by
    // the AgentLoop at turn construction time — the registry only
    // surfaces the raw strings.
    const fsReachRead = parseCsv(cfg['fs_reach.read']);
    const fsReachWrite = parseCsv(cfg['fs_reach.write']);
    const fsReach: PersonalityConfig['fs_reach'] | undefined =
      fsReachRead || fsReachWrite
        ? {
            ...(fsReachRead ? { read: fsReachRead } : {}),
            ...(fsReachWrite ? { write: fsReachWrite } : {}),
          }
        : undefined;

    const config: PersonalityConfig = {
      id,
      name: cfg.name ?? titleCase(id),
      description: cfg.description,
      model: cfg.model,
      provider: cfg.provider,
      platform: cfg.platform,
      memoryScope: (cfg.memoryScope as PersonalityConfig['memoryScope']) ?? 'global',
      ...(capabilities?.length ? { capabilities } : {}),
      ...(ethosExists ? { ethosFile: join(dir, 'ETHOS.md') } : {}),
      ...(skillsExists ? { skillsDirs: [join(dir, 'skills')] } : {}),
      ...(toolsetSrc ? { toolset: parseToolsetYaml(toolsetSrc) } : {}),
      ...(streamingTimeoutMs !== undefined ? { streamingTimeoutMs } : {}),
      ...(fsReach ? { fs_reach: fsReach } : {}),
    };

    return config;
  }

  private async fileFingerprint(paths: string[]): Promise<string> {
    const parts = await Promise.all(
      paths.map(async (p) => {
        const t = await this.storage.mtime(p);
        return t === null ? 'missing' : String(t);
      }),
    );
    return parts.join('|');
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createPersonalityRegistry(
  storageOrOpts?: Storage | { storage?: Storage; userPersonalitiesDir?: string },
): Promise<FilePersonalityRegistry> {
  // Backwards-compatible: original signature took a single Storage argument.
  // New callers can pass { storage, userPersonalitiesDir } to enable CRUD.
  let storage: Storage | undefined;
  let userDir: string | undefined;
  if (storageOrOpts && isStorageLike(storageOrOpts)) {
    storage = storageOrOpts;
  } else if (storageOrOpts) {
    storage = storageOrOpts.storage;
    userDir = storageOrOpts.userPersonalitiesDir;
  }
  const registry = new FilePersonalityRegistry(storage, userDir);
  await registry.loadBuiltins();
  return registry;
}

function isStorageLike(v: unknown): v is Storage {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as { read?: unknown }).read === 'function' &&
    typeof (v as { write?: unknown }).write === 'function'
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function renderConfigYaml(input: CreatePersonalityInput): string {
  const lines: string[] = [`name: ${input.name}`];
  if (input.description) lines.push(`description: ${input.description}`);
  if (input.model) lines.push(`model: ${input.model}`);
  if (input.memoryScope) lines.push(`memoryScope: ${input.memoryScope}`);
  return `${lines.join('\n')}\n`;
}

function renderToolsetYaml(toolset: string[]): string {
  if (toolset.length === 0) return '# No tools enabled — agent runs without external action.\n';
  return `${toolset.map((t) => `- ${t}`).join('\n')}\n`;
}

async function copyTree(storage: Storage, source: string, dest: string): Promise<void> {
  await storage.mkdir(dest);
  const entries = await storage.listEntries(source);
  for (const entry of entries) {
    const sp = join(source, entry.name);
    const dp = join(dest, entry.name);
    if (entry.isDir) {
      await copyTree(storage, sp, dp);
    } else {
      const content = await storage.read(sp);
      if (content !== null) await storage.write(dp, content);
    }
  }
}
