import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  checkPluginContractMajor,
  type EthosPluginPackageJson,
  isEthosPlugin,
} from '@ethosagent/plugin-contract';
import type { EthosPlugin, PluginRegistries } from '@ethosagent/plugin-sdk';
import { PluginApiImpl } from '@ethosagent/plugin-sdk';
import {
  createOpenClawApiShim,
  extractOpenClawRegister,
  isOpenClawPackageJson,
  type OpenClawCompatCallbacks,
} from '@ethosagent/openclaw-compat';
import { FsStorage } from '@ethosagent/storage-fs';
import type { MemoryProvider, PlatformAdapter, Storage } from '@ethosagent/types';

export interface InstalledPluginManifest {
  /** The plugin's id — `ethos.id` if declared, else `name`. */
  id: string;
  name: string;
  version: string;
  description: string | null;
  /** Where the plugin was discovered. */
  source: 'user' | 'project' | 'npm';
  /** Absolute path to the plugin's directory. */
  path: string;
  /** The contract major declared in the manifest, if any. */
  pluginContractMajor: number | null;
  /** Plugin dialect — ethos-native or openclaw compat shim. */
  dialect: 'ethos' | 'openclaw';
}

// ---------------------------------------------------------------------------
// PluginLoader
// ---------------------------------------------------------------------------

export interface PluginLoaderOptions {
  /** Storage backend. Defaults to FsStorage. */
  storage?: Storage;
  /**
   * Called when an OpenClaw memory plugin registers a MemoryProvider.
   * The wiring layer uses this to slot the provider into the memory pipeline.
   */
  onMemoryProviderRegistered?: (pluginId: string, provider: MemoryProvider) => void;
  /**
   * Called when an OpenClaw channel plugin registers a PlatformAdapter.
   * The wiring layer uses this to register the adapter with the Gateway.
   */
  onPlatformAdapterRegistered?: (pluginId: string, adapter: PlatformAdapter) => void;
}

export class PluginLoader {
  private readonly registries: PluginRegistries;
  private readonly storage: Storage;
  private readonly apis = new Map<string, PluginApiImpl>();
  private readonly plugins = new Map<string, EthosPlugin>();
  private readonly compatCallbacks: OpenClawCompatCallbacks;

  constructor(registries: PluginRegistries, opts: PluginLoaderOptions = {}) {
    this.registries = registries;
    this.storage = opts.storage ?? new FsStorage();
    this.compatCallbacks = {
      onMemoryProvider: opts.onMemoryProviderRegistered,
      onPlatformAdapter: opts.onPlatformAdapterRegistered,
    };
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
    const entries = await this.storage.listEntries(dir);
    for (const entry of entries) {
      if (!entry.isDir) continue;
      const pluginDir = join(dir, entry.name);
      try {
        await this.loadFromPluginDir(pluginDir, entry.name);
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
    const reject = await checkContractMajorFromDir(this.storage, dir, id);
    if (reject) {
      console.warn(`[plugin-loader] ${reject}`);
      return;
    }

    // Resolve entry point
    const entry = await resolveEntry(this.storage, dir);
    if (!entry) return;

    // Dynamic import the plugin module — stays raw `import()`. Per
    // plan/storage_abstraction.md, dynamic import is a process operation,
    // not a fs read; Storage doesn't model it.
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
    const entries = await this.storage.list(nmDir);
    if (entries.length === 0) return;

    // listEntries returns scope dirs (e.g. `@ethos-plugins`) without their packages,
    // so scoped names need a second list to surface `@ethos-plugins/foo`.
    const candidates: string[] = [];
    for (const entry of entries) {
      if (entry.startsWith('ethos-plugin-')) {
        candidates.push(entry);
        continue;
      }
      if (entry === '@ethos-plugins') {
        const scopedEntries = await this.storage.list(join(nmDir, entry));
        for (const sub of scopedEntries) {
          candidates.push(`${entry}/${sub}`);
        }
      }
    }

    for (const name of candidates) {
      const pkgPath = join(nmDir, name, 'package.json');
      try {
        const src = await this.storage.read(pkgPath);
        if (!src) continue;
        const raw = JSON.parse(src);
        const isEthos = isEthosPlugin(raw);
        const isOpenClaw = isOpenClawPackageJson(raw);
        if (!isEthos && !isOpenClaw) continue;

        if (isEthos) {
          // Phase 30.6 — reject incompatible contract major before import.
          const declared = (raw as { ethos?: { pluginContractMajor?: number } }).ethos
            ?.pluginContractMajor;
          const compat = checkPluginContractMajor(declared, undefined, name);
          if (!compat.ok) {
            console.warn(`[plugin-loader] ${compat.reason}`);
            continue;
          }
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
    // Try OpenClaw dialect first — register(api) export pattern
    const openclawRegister = extractOpenClawRegister(mod);
    if (openclawRegister && !isPluginModule(mod)) {
      await this.activateOpenClawPlugin(id, openclawRegister);
      return;
    }

    // Ethos-native dialect — activate(api) export pattern
    if (!isPluginModule(mod)) {
      console.warn(`[plugin-loader] "${id}" has no activate() or register() export — skipping`);
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

  private async activateOpenClawPlugin(
    id: string,
    registerFn: (...args: unknown[]) => unknown,
  ): Promise<void> {
    const ethosApi = new PluginApiImpl(id, this.registries);
    const shim = createOpenClawApiShim(id, ethosApi, this.compatCallbacks);

    try {
      await registerFn(shim);
    } catch (err) {
      console.warn(`[plugin-loader] OpenClaw plugin "${id}" register() threw: ${String(err)}`);
      ethosApi.cleanup();
      return;
    }

    this.apis.set(id, ethosApi);
    // Track in plugins map with a synthetic EthosPlugin so list()/isLoaded() work
    this.plugins.set(id, {
      activate: async () => {},
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read installed plugin manifests without activating them. Surfaces
 * what the web Plugins tab shows: name + version + path, no live
 * registry side effects. Discovery order matches `loadAll`:
 * user → project → (npm scan, deferred for now).
 *
 * Returns sorted by name for deterministic UI rendering.
 */
export async function scanInstalledPlugins(opts: {
  userDir: string;
  workingDir?: string;
  storage?: Storage;
}): Promise<InstalledPluginManifest[]> {
  const storage = opts.storage ?? new FsStorage();
  const out: InstalledPluginManifest[] = [];
  out.push(...(await scanManifestsIn(storage, join(opts.userDir, 'plugins'), 'user')));
  if (opts.workingDir) {
    out.push(
      ...(await scanManifestsIn(storage, join(opts.workingDir, '.ethos', 'plugins'), 'project')),
    );
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function scanManifestsIn(
  storage: Storage,
  dir: string,
  source: 'user' | 'project',
): Promise<InstalledPluginManifest[]> {
  const entries = await storage.listEntries(dir);
  const out: InstalledPluginManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDir) continue;
    // npm-installed plugins live under node_modules/<pkg>/ — `ethos plugin
    // install` runs `npm install --prefix <dir>`, so manual drops and
    // npm installs both need to surface here.
    if (entry.name === 'node_modules') {
      out.push(...(await scanNodeModules(storage, join(dir, 'node_modules'), source)));
      continue;
    }
    const pluginDir = join(dir, entry.name);
    const manifest = await readManifest(storage, pluginDir);
    if (!manifest) continue;
    out.push(toInstalledPluginManifest(manifest, source, pluginDir));
  }
  return out;
}

async function scanNodeModules(
  storage: Storage,
  nmDir: string,
  source: 'user' | 'project',
): Promise<InstalledPluginManifest[]> {
  const entries = await storage.listEntries(nmDir);
  const out: InstalledPluginManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDir) continue;
    if (entry.name.startsWith('.')) continue; // skip .package-lock.json etc.
    if (entry.name.startsWith('@')) {
      // scoped: walk one level deeper (@scope/<pkg>/)
      const scoped = await storage.listEntries(join(nmDir, entry.name));
      for (const s of scoped) {
        if (!s.isDir) continue;
        const pluginDir = join(nmDir, entry.name, s.name);
        const manifest = await readManifest(storage, pluginDir);
        if (!manifest) continue;
        out.push(toInstalledPluginManifest(manifest, source, pluginDir));
      }
      continue;
    }
    const pluginDir = join(nmDir, entry.name);
    const manifest = await readManifest(storage, pluginDir);
    if (!manifest) continue;
    out.push(toInstalledPluginManifest(manifest, source, pluginDir));
  }
  return out;
}

interface PluginRawManifest extends EthosPluginPackageJson {
  openclaw?: Record<string, unknown>;
}

function toInstalledPluginManifest(
  manifest: PluginRawManifest,
  source: 'user' | 'project',
  pluginDir: string,
): InstalledPluginManifest {
  const dialect: 'ethos' | 'openclaw' =
    manifest.ethos?.type === 'plugin' ? 'ethos' : 'openclaw';
  const id =
    dialect === 'ethos'
      ? (manifest.ethos?.id ?? manifest.name)
      : ((manifest.openclaw?.channel as Record<string, unknown> | undefined)?.id as string | undefined) ?? manifest.name;
  return {
    id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description ?? null,
    source,
    path: pluginDir,
    pluginContractMajor: manifest.ethos?.pluginContractMajor ?? null,
    dialect,
  };
}

async function readManifest(
  storage: Storage,
  pluginDir: string,
): Promise<PluginRawManifest | null> {
  const raw = await storage.read(join(pluginDir, 'package.json'));
  if (raw === null) return null;
  let parsed: PluginRawManifest;
  try {
    parsed = JSON.parse(raw) as PluginRawManifest;
  } catch {
    return null;
  }
  // Accept Ethos plugins (ethos.type = 'plugin') or OpenClaw plugins (openclaw block present)
  if (parsed.ethos?.type !== 'plugin' && !isOpenClawPackageJson(parsed)) return null;
  return parsed;
}

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
async function checkContractMajorFromDir(
  storage: Storage,
  dir: string,
  id: string,
): Promise<string | null> {
  const src = await storage.read(join(dir, 'package.json'));
  if (!src) return null; // no package.json — allow (loader-only plugin)
  let raw: { ethos?: { pluginContractMajor?: number } };
  try {
    raw = JSON.parse(src);
  } catch {
    return null;
  }
  const declared = raw.ethos?.pluginContractMajor;
  const result = checkPluginContractMajor(declared, undefined, id);
  return result.ok ? null : (result.reason ?? `Plugin "${id}" rejected`);
}

async function resolveEntry(storage: Storage, dir: string): Promise<string | null> {
  for (const name of ['index.ts', 'index.js', 'src/index.ts', 'src/index.js']) {
    const candidate = join(dir, name);
    if (await storage.exists(candidate)) return candidate;
  }

  // Check package.json main/exports
  const src = await storage.read(join(dir, 'package.json'));
  if (!src) return null;
  try {
    const raw = JSON.parse(src) as Record<string, unknown>;
    const main = raw.main as string | undefined;
    if (main) {
      const candidate = join(dir, main);
      if (await storage.exists(candidate)) return candidate;
    }
  } catch {
    // no parseable package.json
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
