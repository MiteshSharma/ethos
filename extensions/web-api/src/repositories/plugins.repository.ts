import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { EthosPluginPackageJson } from '@ethosagent/plugin-contract';
import type { PluginInfo, PluginSource } from '@ethosagent/web-contracts';

// File-backed inventory of installed plugins. Mirrors the discovery
// chain @ethosagent/plugin-loader walks, but only reads metadata —
// we don't activate anything. The web tab shows what's *installable*
// at this moment; live registries (declared tools etc) come from the
// agent loop, not from disk.
//
// Discovery order (per plugin-loader):
//   1. user      — ~/.ethos/plugins/<id>/
//   2. project   — <cwd>/.ethos/plugins/<id>/
//   3. npm       — node_modules dirs whose package.json has `ethos.type === 'plugin'`
//
// For v1 the user dir is the surface that matters most (single-user
// install). Project + npm sources land later when there's UX to
// distinguish them; for now we stop at user.

export interface PluginsRepositoryOptions {
  /** Root data dir — `~/.ethos/`. */
  dataDir: string;
  /** Working dir for the optional project-level plugin scan. */
  workingDir?: string;
}

export class PluginsRepository {
  constructor(private readonly opts: PluginsRepositoryOptions) {}

  async listPlugins(): Promise<PluginInfo[]> {
    const out: PluginInfo[] = [];
    out.push(...(await this.scan(join(this.opts.dataDir, 'plugins'), 'user')));
    if (this.opts.workingDir) {
      out.push(...(await this.scan(join(this.opts.workingDir, '.ethos', 'plugins'), 'project')));
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  private async scan(dir: string, source: PluginSource): Promise<PluginInfo[]> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    const out: PluginInfo[] = [];
    for (const name of entries) {
      const pluginDir = join(dir, name);
      try {
        const stats = await stat(pluginDir);
        if (!stats.isDirectory()) continue;
        const manifest = await this.readManifest(pluginDir);
        if (!manifest) continue;
        out.push({
          id: manifest.ethos?.id ?? manifest.name,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description ?? null,
          source,
          path: pluginDir,
          pluginContractMajor: manifest.ethos?.pluginContractMajor ?? null,
        });
      } catch {
        // Skip unreadable dirs rather than failing the whole list.
      }
    }
    return out;
  }

  private async readManifest(pluginDir: string): Promise<EthosPluginPackageJson | null> {
    let raw: string;
    try {
      raw = await readFile(join(pluginDir, 'package.json'), 'utf-8');
    } catch {
      return null;
    }
    let parsed: EthosPluginPackageJson;
    try {
      parsed = JSON.parse(raw) as EthosPluginPackageJson;
    } catch {
      return null;
    }
    // Honour the same gate the loader uses — only surface manifests
    // explicitly declaring themselves Ethos plugins. Otherwise random
    // npm packages on the path would show up as plugins.
    if (parsed.ethos?.type !== 'plugin') return null;
    return parsed;
  }
}
