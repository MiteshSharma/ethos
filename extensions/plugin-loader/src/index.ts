import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkPluginContractMajor, isEthosPlugin } from '@ethosagent/plugin-contract';
import type { EthosPlugin, PluginRegistries } from '@ethosagent/plugin-sdk';
import { PluginApiImpl } from '@ethosagent/plugin-sdk';

// ---------------------------------------------------------------------------
// PluginLoader
// ---------------------------------------------------------------------------

export class PluginLoader {
  private readonly registries: PluginRegistries;
  private readonly apis = new Map<string, PluginApiImpl>();
  private readonly plugins = new Map<string, EthosPlugin>();

  constructor(registries: PluginRegistries) {
    this.registries = registries;
  }

  // ---------------------------------------------------------------------------
  // Discovery + loading
  // ---------------------------------------------------------------------------

  /**
   * Run the full discovery chain and load all plugins found.
   * Order: user (~/.ethos/plugins/) → project (.ethos/plugins/) → npm
   * Later sources with the same id override earlier ones.
   */
  async loadAll(): Promise<void> {
    const dirs = [join(homedir(), '.ethos', 'plugins'), join(process.cwd(), '.ethos', 'plugins')];

    for (const dir of dirs) {
      await this.loadFromDirectory(dir);
    }

    await this.loadFromNodeModules();
  }

  /**
   * Load all plugins from a directory. Each subdirectory is one plugin.
   * Silently skips directories that don't look like plugins.
   */
  async loadFromDirectory(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return; // directory doesn't exist — fine
    }

    for (const entry of entries) {
      const pluginDir = join(dir, entry);
      try {
        const s = await stat(pluginDir);
        if (!s.isDirectory()) continue;
        await this.loadFromPluginDir(pluginDir, entry);
      } catch {
        // skip broken plugins
      }
    }
  }

  /**
   * Load a single plugin from a directory. The directory must contain
   * either `plugin.yaml` or `package.json` (with ethos.type=plugin),
   * and an `index.ts` or `index.js` that exports `activate`.
   */
  async loadFromPluginDir(dir: string, pluginId?: string): Promise<void> {
    const id = pluginId ?? dir.split('/').pop() ?? 'unknown';

    // Phase 30.6 — gate on declared plugin contract major *before* importing.
    // We don't want a stale plugin's top-level code to run if its contract
    // declaration is incompatible.
    const reject = await checkContractMajorFromDir(dir, id);
    if (reject) {
      console.warn(`[plugin-loader] ${reject}`);
      return;
    }

    // Resolve entry point
    const entry = await resolveEntry(dir);
    if (!entry) return;

    // Dynamic import the plugin module
    let mod: unknown;
    try {
      mod = await import(entry);
    } catch (err) {
      console.warn(`[plugin-loader] Failed to load plugin "${id}": ${String(err)}`);
      return;
    }

    await this.activatePlugin(id, mod);
  }

  /**
   * Scan node_modules for packages with `ethos.type = "plugin"` in package.json.
   * Only checks packages named `ethos-plugin-*` or scoped under `@ethos-plugins/*`
   * to keep this O(n) tractable. When `dir` is provided, only that directory is
   * scanned; otherwise the project's node_modules and `~/.ethos/plugins/node_modules`
   * are scanned in order.
   */
  async loadFromNodeModules(dir?: string): Promise<void> {
    const dirs = dir
      ? [dir]
      : [resolve('node_modules'), join(homedir(), '.ethos', 'plugins', 'node_modules')];
    for (const nmDir of dirs) {
      await this.scanNodeModulesDir(nmDir);
    }
  }

  private async scanNodeModulesDir(nmDir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(nmDir);
    } catch {
      return;
    }

    // readdir returns scope dirs (e.g. `@ethos-plugins`) without their packages,
    // so scoped names need a second readdir to surface `@ethos-plugins/foo`.
    const candidates: string[] = [];
    for (const entry of entries) {
      if (entry.startsWith('ethos-plugin-')) {
        candidates.push(entry);
        continue;
      }
      if (entry === '@ethos-plugins') {
        let scopedEntries: string[];
        try {
          scopedEntries = await readdir(join(nmDir, entry));
        } catch {
          continue;
        }
        for (const sub of scopedEntries) {
          candidates.push(`${entry}/${sub}`);
        }
      }
    }

    for (const name of candidates) {
      const pkgPath = join(nmDir, name, 'package.json');
      try {
        const raw = JSON.parse(await readFile(pkgPath, 'utf-8'));
        if (!isEthosPlugin(raw)) continue;

        // Phase 30.6 — reject incompatible contract major before import.
        const declared = (raw as { ethos?: { pluginContractMajor?: number } }).ethos
          ?.pluginContractMajor;
        const compat = checkPluginContractMajor(declared, undefined, name);
        if (!compat.ok) {
          console.warn(`[plugin-loader] ${compat.reason}`);
          continue;
        }

        const entry = resolveNpmEntry(raw, join(nmDir, name));
        if (!entry) continue;

        const mod = await import(entry);
        await this.activatePlugin(name, mod);
      } catch {
        // skip
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Unload a plugin by id — calls deactivate() and removes all registrations. */
  async unload(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (plugin?.deactivate) {
      try {
        await plugin.deactivate();
      } catch {
        // swallow deactivate errors
      }
    }

    const api = this.apis.get(pluginId);
    api?.cleanup();

    this.plugins.delete(pluginId);
    this.apis.delete(pluginId);
  }

  /** Unload all plugins. */
  async unloadAll(): Promise<void> {
    for (const id of [...this.plugins.keys()]) {
      await this.unload(id);
    }
  }

  /** List ids of currently loaded plugins. */
  list(): string[] {
    return [...this.plugins.keys()];
  }

  /** Check if a plugin is loaded. */
  isLoaded(pluginId: string): boolean {
    return this.plugins.has(pluginId);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async activatePlugin(id: string, mod: unknown): Promise<void> {
    if (!isPluginModule(mod)) {
      console.warn(`[plugin-loader] "${id}" has no activate() export — skipping`);
      return;
    }

    // Unload existing version if reloading
    if (this.plugins.has(id)) {
      await this.unload(id);
    }

    const api = new PluginApiImpl(id, this.registries);

    try {
      await mod.activate(api);
    } catch (err) {
      console.warn(`[plugin-loader] Plugin "${id}" activate() threw: ${String(err)}`);
      api.cleanup();
      return;
    }

    this.apis.set(id, api);
    this.plugins.set(id, mod);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPluginModule(mod: unknown): mod is EthosPlugin {
  return (
    mod !== null &&
    typeof mod === 'object' &&
    'activate' in mod &&
    typeof (mod as Record<string, unknown>).activate === 'function'
  );
}

/**
 * Phase 30.6 — read the plugin's package.json (if present) and return a
 * rejection message string when the declared `ethos.pluginContractMajor` is
 * incompatible with the current contract. Returns `null` to allow the load.
 *
 * Plugins without a package.json or without the field are allowed (older
 * plugins predating the field; in-development plugins).
 */
async function checkContractMajorFromDir(dir: string, id: string): Promise<string | null> {
  let raw: { ethos?: { pluginContractMajor?: number } };
  try {
    raw = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8'));
  } catch {
    return null; // no package.json — allow (loader-only plugin)
  }
  const declared = raw.ethos?.pluginContractMajor;
  const result = checkPluginContractMajor(declared, undefined, id);
  return result.ok ? null : (result.reason ?? `Plugin "${id}" rejected`);
}

async function resolveEntry(dir: string): Promise<string | null> {
  for (const name of ['index.ts', 'index.js', 'src/index.ts', 'src/index.js']) {
    const candidate = join(dir, name);
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // try next
    }
  }

  // Check package.json main/exports
  try {
    const raw = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    const main = raw.main as string | undefined;
    if (main) {
      const candidate = join(dir, main);
      await stat(candidate);
      return candidate;
    }
  } catch {
    // no package.json or main
  }

  return null;
}

function resolveNpmEntry(pkg: Record<string, unknown>, dir: string): string | null {
  const main = pkg.main as string | undefined;
  if (main) return join(dir, main);

  const exports = pkg.exports as Record<string, unknown> | undefined;
  if (exports?.['.']) {
    const exp = exports['.'];
    if (typeof exp === 'string') return join(dir, exp);
    if (typeof exp === 'object' && exp !== null) {
      const sub = exp as Record<string, string>;
      return join(dir, sub.import ?? sub.default ?? sub.require ?? '');
    }
  }

  return join(dir, 'index.js');
}
