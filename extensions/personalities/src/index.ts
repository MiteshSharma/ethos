import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import type { PersonalityConfig, PersonalityRegistry, Storage } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// YAML parsers — no external dependency, handles the subset we need
// ---------------------------------------------------------------------------

function parseConfigYaml(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of src.split('\n')) {
    const m = line.match(/^(\w+):\s*(.+)$/);
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

export class FilePersonalityRegistry implements PersonalityRegistry {
  private readonly personalities = new Map<string, PersonalityConfig>();
  // dir → fingerprint of config.yaml + ETHOS.md + toolset.yaml mtimes
  private readonly fingerprintCache = new Map<string, string>();
  private defaultId = 'researcher';
  private readonly storage: Storage;

  constructor(storage: Storage = new FsStorage()) {
    this.storage = storage;
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
  storage?: Storage,
): Promise<FilePersonalityRegistry> {
  const registry = new FilePersonalityRegistry(storage);
  await registry.loadBuiltins();
  return registry;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
