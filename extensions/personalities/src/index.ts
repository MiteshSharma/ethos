import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { PersonalityConfig, PersonalityRegistry } from '@ethosagent/types';

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
  private readonly mtimeCache = new Map<string, number>(); // dir → config.yaml mtime
  private defaultId = 'researcher';

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

  async loadFromDirectory(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return; // directory doesn't exist yet — fine
    }

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
    const configPath = join(dir, 'config.yaml');

    // mtime guard — skip if nothing changed
    const mtime = await statMtime(configPath);
    if (mtime !== null && this.mtimeCache.get(dir) === mtime) return;
    if (mtime !== null) this.mtimeCache.set(dir, mtime);

    const config = await buildConfig(dir, id);
    if (config) this.define(config);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createPersonalityRegistry(): Promise<FilePersonalityRegistry> {
  const registry = new FilePersonalityRegistry();
  await registry.loadBuiltins();
  return registry;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildConfig(dir: string, id: string): Promise<PersonalityConfig | null> {
  // Must have at least config.yaml or ETHOS.md to be considered a personality
  const [configSrc, toolsetSrc, ethosExists, skillsExists] = await Promise.all([
    readSafe(join(dir, 'config.yaml')),
    readSafe(join(dir, 'toolset.yaml')),
    exists(join(dir, 'ETHOS.md')),
    exists(join(dir, 'skills')),
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

async function readSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function statMtime(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
