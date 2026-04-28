import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Read/write `~/.ethos/config.yaml` from the web side. The file is shared
// with the CLI (`apps/ethos/src/config.ts`), so any web-driven update must
// PRESERVE keys this layer doesn't know about (telegramToken, slack*,
// email*, etc.) — otherwise switching personalities or rotating an API key
// from the web would silently delete the user's gateway tokens.
//
// The format is the same flat `key: value` shape the CLI parser expects,
// plus `modelRouting.<id>: <model>` for per-personality overrides. We don't
// pull in a YAML library — the CLI already proved the regex parser is
// enough for this surface, and zero deps keeps install size small.

export interface ConfigRepositoryOptions {
  /** Where `~/.ethos` lives. config.yaml is `<dataDir>/config.yaml`. */
  dataDir: string;
}

/** Parsed shape — only the fields the web surface reads. Unknown keys are
 *  retained internally on the `_raw` map so writes preserve them. */
export interface RawConfig {
  provider?: string;
  model?: string;
  apiKey?: string;
  personality?: string;
  memory?: 'markdown' | 'vector';
  baseUrl?: string;
  modelRouting: Record<string, string>;
  /** Every other top-level key the file contained (telegramToken etc.).
   *  Round-tripped through writes verbatim. */
  passthrough: Record<string, string>;
}

export class ConfigRepository {
  private readonly path: string;

  constructor(opts: ConfigRepositoryOptions) {
    this.path = join(opts.dataDir, 'config.yaml');
  }

  async exists(): Promise<boolean> {
    try {
      await readFile(this.path, 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  async read(): Promise<RawConfig | null> {
    let src: string;
    try {
      src = await readFile(this.path, 'utf-8');
    } catch {
      return null;
    }

    const known = new Set(['provider', 'model', 'apiKey', 'personality', 'memory', 'baseUrl']);
    const config: RawConfig = { modelRouting: {}, passthrough: {} };

    for (const line of src.split('\n')) {
      // `modelRouting.<id>: <model>` — per-personality overrides
      const mr = line.match(/^modelRouting\.(\S+):\s*(.+)$/);
      if (mr) {
        const id = mr[1]?.trim();
        const value = mr[2]?.trim();
        if (id && value) config.modelRouting[id] = stripQuotes(value);
        continue;
      }
      const kv = line.match(/^(\w+):\s*(.+)$/);
      if (!kv) continue;
      const key = kv[1]?.trim();
      const value = kv[2] !== undefined ? stripQuotes(kv[2].trim()) : '';
      if (!key) continue;

      if (known.has(key)) {
        switch (key) {
          case 'provider':
            config.provider = value;
            break;
          case 'model':
            config.model = value;
            break;
          case 'apiKey':
            config.apiKey = value;
            break;
          case 'personality':
            config.personality = value;
            break;
          case 'memory':
            config.memory = value === 'vector' ? 'vector' : 'markdown';
            break;
          case 'baseUrl':
            config.baseUrl = value;
            break;
        }
      } else {
        config.passthrough[key] = value;
      }
    }
    return config;
  }

  /**
   * Apply a partial update. Reads the existing file, merges the patch in
   * place, writes back preserving order-of-keys for known fields and the
   * raw passthrough block beneath. New file (no prior config) is created
   * with just the provided keys.
   *
   * NOTE: `passthrough` merges on top of current — this method can only
   * ADD or OVERWRITE keys, never delete. Use `deletePassthroughKeys` for
   * deletion (e.g. clearing a platform's tokens).
   */
  async update(patch: Partial<RawConfig>): Promise<RawConfig> {
    const current: RawConfig = (await this.read()) ?? { modelRouting: {}, passthrough: {} };
    const next: RawConfig = {
      ...current,
      ...patch,
      modelRouting: { ...current.modelRouting, ...(patch.modelRouting ?? {}) },
      passthrough: { ...current.passthrough, ...(patch.passthrough ?? {}) },
    };
    await this.write(next);
    return next;
  }

  /**
   * Drop the named keys from the passthrough block and write the file
   * back. Used by the Communications tab's "Clear" action when a user
   * wants to disconnect a platform — the merge in `update` can't
   * delete keys, so this is the dedicated path.
   */
  async deletePassthroughKeys(keys: string[]): Promise<RawConfig> {
    const current: RawConfig = (await this.read()) ?? { modelRouting: {}, passthrough: {} };
    for (const key of keys) delete current.passthrough[key];
    await this.write(current);
    return current;
  }

  private async write(config: RawConfig): Promise<void> {
    await mkdir(dataDirOf(this.path), { recursive: true });

    const lines: string[] = [];
    if (config.provider) lines.push(`provider: ${config.provider}`);
    if (config.model) lines.push(`model: ${config.model}`);
    if (config.apiKey) lines.push(`apiKey: ${config.apiKey}`);
    if (config.personality) lines.push(`personality: ${config.personality}`);
    if (config.memory) lines.push(`memory: ${config.memory}`);
    if (config.baseUrl) lines.push(`baseUrl: ${config.baseUrl}`);
    for (const [id, model] of Object.entries(config.modelRouting)) {
      lines.push(`modelRouting.${id}: ${model}`);
    }
    // Stable-order passthrough — keep keys the CLI cares about across
    // round-trips even if it adds new ones in the future.
    for (const key of Object.keys(config.passthrough).sort()) {
      lines.push(`${key}: ${config.passthrough[key]}`);
    }
    await writeFile(this.path, `${lines.join('\n')}\n`, 'utf-8');
  }
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

function dataDirOf(filePath: string): string {
  // The path always ends in `/config.yaml`; chop it to get `~/.ethos`.
  const idx = filePath.lastIndexOf('/');
  return idx > 0 ? filePath.slice(0, idx) : '.';
}
