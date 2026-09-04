import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { assertWithinBase } from '@ethosagent/core';
import { noopLogger } from '@ethosagent/logger';
import {
  createOpenClawApiShim,
  extractOpenClawRegister,
  isOpenClawPackageJson,
  type OpenClawCompatCallbacks,
} from '@ethosagent/openclaw-compat';
import {
  type CredentialDeclaration,
  checkPluginContractMajor,
  type EthosPluginPackageJson,
  isEthosPlugin,
  PLUGIN_CONTRACT_MAJOR,
} from '@ethosagent/plugin-contract';
import type { EthosPlugin, PluginRegistries, PluginRouteEntry } from '@ethosagent/plugin-sdk';
import {
  migrateLegacyPluginCredentials,
  PluginApiImpl,
  pluginCredentialPrefix,
  pluginCredentialRef,
} from '@ethosagent/plugin-sdk';
import {
  canInstall,
  deriveTier,
  type PluginScanPermissions,
  type ScanFinding,
  scanPluginCode,
  type TrustTier,
} from '@ethosagent/safety-scanner';
import { FileSecretsResolver } from '@ethosagent/storage-fs';
import type {
  HealthCheckResult,
  Logger,
  PlatformAdapter,
  SecretsResolver,
  Storage,
} from '@ethosagent/types';
import { isValidSecretName } from '@ethosagent/types';
import { derivePluginId, isGrantRevoked, readGrants } from './grants';
import {
  DEFAULT_REGISTRY,
  isValidPluginId,
  type PluginLockEntry,
  type PluginLockfile,
  readLockfile,
} from './lockfile';

// Plugin credential refs — re-exported so the CLI writer mints refs from the
// same definition the loader and `PluginApiImpl` use, instead of a second copy.
export {
  migrateLegacyPluginCredentials,
  pluginCredentialPrefix,
  pluginCredentialRef,
} from '@ethosagent/plugin-sdk';
export type {
  PluginGrant,
  PluginGrantCapabilities,
  PluginGrantScan,
  PluginGrants,
} from './grants';
export {
  derivePluginId,
  grantsPath,
  isGrantRevoked,
  readGrants,
  recordGrant,
  revokeGrant,
  writeGrants,
} from './grants';
export type { PluginLockEntry, PluginLockfile } from './lockfile';
export {
  computeIntegrity,
  isExactVersion,
  isValidNpmPackageName,
  isValidPluginId,
  readLockfile,
  verifyIntegrity,
  writeLockfile,
} from './lockfile';
export { loadWidgetTemplates } from './widgets-loader';

/**
 * One safety-scan finding retained from load, plus the file it came from.
 * `ScanFinding` has no file field — the scanner reads a source string, not a
 * tree — so the loader attaches the path while it aggregates.
 */
export interface PluginScanFindingRecord extends ScanFinding {
  /** Path of the scanned file, relative to the plugin directory. */
  file?: string;
}

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
  /** Whether the plugin ships a Home panel. */
  hasHomePanel?: boolean;
  /** Credential declarations from the plugin's `ethos.credentials` manifest field. */
  credentials: CredentialDeclaration[];
  /** IDs of registered data sources. */
  dataSources: string[];
  /** Whether widgets.yaml exists in the plugin directory. */
  hasWidgets: boolean;
  /** Activation status — set after activate() runs. */
  status?: 'loaded' | 'failed';
  /** Error message when status is 'failed'. */
  error?: string;
  /**
   * Safety-scan findings retained from load. Yellow findings do not block —
   * they surface in the Plugins UI so the operator can see what was found.
   * Red findings block the load and appear here too, alongside `error`.
   */
  scanFindings?: PluginScanFindingRecord[];
}

/**
 * A credential request named a plugin id or a credential whose shape is not a
 * single safe path segment. Thrown, not swallowed: `null` would read as "no
 * such credential" and make a traversal attempt indistinguishable from a miss.
 */
export class CredentialPathError extends Error {
  readonly code = 'invalid-credential-path' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CredentialPathError';
  }
}

// ---------------------------------------------------------------------------
// PluginLoader
// ---------------------------------------------------------------------------

export interface PluginLoaderOptions {
  /** Storage backend. Injected by the composition root; required. */
  storage: Storage;
  /** Logger for load-time failures. Defaults to a silent NoopLogger. */
  logger?: Logger;
  /**
   * Called when an OpenClaw channel plugin registers a PlatformAdapter.
   * The wiring layer uses this to register the adapter with the Gateway.
   */
  onPlatformAdapterRegistered?: (pluginId: string, adapter: PlatformAdapter) => void;
  /** Storage for credential METADATA — the `<key>.meta` sidecars, which carry
   *  an `updatedAt` timestamp and no credential material. Defaults to the
   *  injected `storage`. */
  credentialStorage?: Storage;
  /**
   * Vault for plugin credential material. G-SEC: the sole storage and
   * retrieval path for credentials — refs are `plugins/<pluginId>/<key>`.
   * Defaults to a `FileSecretsResolver` rooted at `<dataDir>/secrets`, the
   * same directory the CLI and web-api resolvers use. Hosts that already
   * built a resolver (env / AWS chain) should inject it.
   */
  secrets?: SecretsResolver;
  /** Ethos data directory (e.g. `~/.ethos`). Credential metadata is stored
   *  under `<dataDir>/plugins/<pluginId>/credentials/`, and the default vault
   *  under `<dataDir>/secrets`. Defaults to `$HOME/.ethos`. Override in tests
   *  with a temporary directory. */
  dataDir?: string;
  /** Called when a plugin registers an HTTP route. */
  onRouteRegistered?: (entry: PluginRouteEntry) => void;
}

export class PluginLoader {
  private readonly registries: PluginRegistries;
  private readonly storage: Storage;
  private readonly logger: Logger;
  private readonly apis = new Map<string, PluginApiImpl>();
  private readonly pluginSkillSources: { label: string; dir: string }[] = [];
  private readonly plugins = new Map<string, EthosPlugin>();
  private readonly compatCallbacks: OpenClawCompatCallbacks;
  private readonly credentialStorage: Storage;
  private readonly secrets: SecretsResolver;
  /** Plugin ids whose legacy on-disk credentials have already been migrated. */
  private readonly migratedCredentials = new Set<string>();
  private readonly dataDir: string;
  private readonly manifests = new Map<string, EthosPluginPackageJson>();
  private readonly onRouteRegistered?: (entry: PluginRouteEntry) => void;
  private readonly loadedManifests = new Map<string, InstalledPluginManifest>();
  private readonly pluginPaths = new Map<string, string>();
  private readonly pluginHasWidgets = new Map<string, boolean>();
  private readonly pluginScanFindings = new Map<string, PluginScanFindingRecord[]>();

  constructor(registries: PluginRegistries, opts: PluginLoaderOptions) {
    this.registries = registries;
    this.storage = opts.storage;
    this.credentialStorage = opts.credentialStorage ?? opts.storage;
    this.dataDir = opts.dataDir ?? join(homedir(), '.ethos');
    this.secrets =
      opts.secrets ??
      new FileSecretsResolver({ dir: join(this.dataDir, 'secrets'), storage: opts.storage });
    this.logger = opts.logger ?? noopLogger;
    this.compatCallbacks = {
      onPlatformAdapter: opts.onPlatformAdapterRegistered,
    };
    this.onRouteRegistered = opts.onRouteRegistered;
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
    // Packages the user intentionally placed in ~/.ethos/plugins/ are treated as
    // trusted-repo — the user made an explicit install decision.
    const isUserPluginsDir = dir === join(homedir(), '.ethos', 'plugins');
    const tierOverride: TrustTier | undefined = isUserPluginsDir ? 'trusted-repo' : undefined;
    const entries = await this.storage.listEntries(dir);
    for (const entry of entries) {
      if (!entry.isDir) continue;
      const pluginDir = join(dir, entry.name);
      try {
        await this.loadFromPluginDir(pluginDir, entry.name, tierOverride);
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
  async loadFromPluginDir(dir: string, pluginId?: string, tierOverride?: TrustTier): Promise<void> {
    const id = pluginId ?? dir.split('/').pop() ?? 'unknown';

    // Read package.json once — used for skills_dir discovery, contract check, and permissions.
    const pkgSrc = await this.storage.read(join(dir, 'package.json'));
    const pkgJson = pkgSrc ? (JSON.parse(pkgSrc) as Record<string, unknown>) : {};

    this.pluginPaths.set(id, dir);

    // Store manifest for credential declaration lookups
    if (pkgSrc) {
      this.manifests.set(id, pkgJson as unknown as EthosPluginPackageJson);
    }

    const ethosField = pkgJson.ethos as Record<string, unknown> | undefined;

    // G5 — the operator withdrew consent for this plugin. Refuse before any of
    // its code or skills reach the process. This is a load-time refusal, not
    // containment: it stops the next import, not anything a previous one did.
    const declaredId = typeof ethosField?.id === 'string' ? ethosField.id : undefined;
    const revoked = await this.revokedGrantId([id, declaredId]);
    if (revoked) {
      const reason = `Plugin "${id}" has a revoked capability grant (${revoked}) — not loaded. Re-install it to grant again.`;
      this.logger.warn(`[plugin-loader] ${reason}`, { component: 'plugin-loader', pluginId: id });
      this.trackManifestStatus(id, 'failed', reason);
      return;
    }

    // Skills-dir: any package declaring ethos.skills_dir contributes skills
    // without needing an activate() entry point.
    const skillsDirRel = ethosField?.skills_dir;
    if (typeof skillsDirRel === 'string') {
      this.pluginSkillSources.push({ label: id, dir: resolve(dir, skillsDirRel) });
    }

    // Phase 30.6 — gate on declared plugin contract major *before* importing.
    // We don't want a stale plugin's top-level code to run if its contract
    // declaration is incompatible.
    const reject = await checkContractMajorFromDir(this.storage, dir, id);
    if (reject) {
      this.logger.warn(`[plugin-loader] ${reject}`, { component: 'plugin-loader', pluginId: id });
      this.trackManifestStatus(id, 'failed', reject);
      return;
    }

    // Resolve entry point — skills-only packages (no activate()) stop here.
    const entry = await resolveEntry(this.storage, dir);
    if (!entry) return;

    // Safety scan the entire plugin source tree before executing any code.
    const permissions = readPluginPermissions(pkgJson);
    const tier = tierOverride ?? deriveTier(dir);
    const scanResult = await scanPluginTree(this.storage, dir, permissions);
    this.pluginScanFindings.set(id, scanResult.findings);
    const decision = canInstall(scanResult, tier);
    // Red blocks, exactly as before. Yellow no longer does: the operator
    // installed this deliberately, so the findings are surfaced (retained
    // above, rendered in the Plugins UI) instead of silently refusing.
    if (!decision.allowed && scanResult.hasRed) {
      const reason = `Blocked by safety scan: ${decision.blockedBy}`;
      this.logger.warn(`[plugin-loader] "${id}" blocked by safety scan: ${decision.blockedBy}`, {
        component: 'plugin-loader',
        pluginId: id,
        blockedBy: decision.blockedBy,
      });
      this.trackManifestStatus(id, 'failed', reason);
      return;
    }
    this.logYellowNotes(id, scanResult);

    // Check for widgets.yaml before activation (while we have the dir)
    this.pluginHasWidgets.set(id, await this.storage.exists(join(dir, 'widgets.yaml')));

    // Dynamic import the plugin module — stays raw `import()`. Per
    // plan/storage_abstraction.md, dynamic import is a process operation,
    // not a fs read; Storage doesn't model it.
    let mod: unknown;
    try {
      mod = await import(entry);
    } catch (err) {
      this.logger.warn(`[plugin-loader] Failed to load plugin "${id}": ${String(err)}`, {
        component: 'plugin-loader',
        pluginId: id,
        error: String(err),
      });
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
    const pluginsNmDir = join(homedir(), '.ethos', 'plugins', 'node_modules');
    const dirs = dir ? [dir] : [resolve('node_modules'), pluginsNmDir];
    for (const nmDir of dirs) {
      await this.scanNodeModulesDir(nmDir, { allowAll: nmDir === pluginsNmDir });
    }
  }

  private async scanNodeModulesDir(
    nmDir: string,
    opts: { allowAll?: boolean } = {},
  ): Promise<void> {
    const entries = await this.storage.list(nmDir);
    if (entries.length === 0) return;

    // listEntries returns scope dirs (e.g. `@ethos-plugins`) without their packages,
    // so scoped names need a second list to surface `@ethos-plugins/foo`.
    const candidates: string[] = [];
    if (opts.allowAll) {
      // User's intentional plugin install dir — pick up ALL packages regardless of name/scope.
      for (const entry of entries) {
        if (entry === 'node_modules' || entry === '.bin') continue;
        if (entry.startsWith('@')) {
          const scopedEntries = await this.storage.list(join(nmDir, entry));
          for (const sub of scopedEntries) {
            candidates.push(`${entry}/${sub}`);
          }
        } else {
          candidates.push(entry);
        }
      }
    } else {
      // Project node_modules — keep strict name filter for performance.
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
        if (entry === '@ethosagent') {
          const scopedEntries = await this.storage.list(join(nmDir, entry));
          for (const sub of scopedEntries) {
            candidates.push(`${entry}/${sub}`);
          }
        }
      }
    }

    for (const name of candidates) {
      const pkgPath = join(nmDir, name, 'package.json');
      try {
        const src = await this.storage.read(pkgPath);
        if (!src) continue;
        const raw = JSON.parse(src);

        const ethosNm = (raw as Record<string, unknown>).ethos as
          | Record<string, unknown>
          | undefined;
        const isEthos = isEthosPlugin(raw);
        const isOpenClaw = isOpenClawPackageJson(raw);

        // G5 — the operator withdrew consent for this package. Refuse before
        // its skills or its code reach the process. Load-time refusal only;
        // it undoes nothing an earlier load already did.
        const nmPluginId = derivePluginId(raw, name);
        const nmRevoked = await this.revokedGrantId([nmPluginId]);
        if (nmRevoked) {
          const reason = `Plugin "${nmPluginId}" has a revoked capability grant — not loaded. Re-install it to grant again.`;
          this.logger.warn(`[plugin-loader] ${reason}`, {
            component: 'plugin-loader',
            pluginId: nmPluginId,
          });
          if (isEthos || isOpenClaw) {
            this.manifests.set(nmPluginId, raw as EthosPluginPackageJson);
            this.pluginPaths.set(nmPluginId, join(nmDir, name));
            this.trackManifestStatus(nmPluginId, 'failed', reason);
          }
          continue;
        }

        // Skills-dir: any package declaring ethos.skills_dir contributes skills.
        const skillsDirNm = ethosNm?.skills_dir;
        if (typeof skillsDirNm === 'string') {
          this.pluginSkillSources.push({
            label: name,
            dir: resolve(join(nmDir, name), String(skillsDirNm)),
          });
        }

        if (!isEthos && !isOpenClaw) continue;

        if (isEthos) {
          // Phase 30.6 + P2.6/S8 — reject an incompatible OR undeclared contract
          // major before import, so a stale/unknown plugin's top-level code never runs.
          const declared = (raw as { ethos?: { pluginContractMajor?: number } }).ethos
            ?.pluginContractMajor;
          const reject = rejectionForDeclaredMajor(declared, name);
          if (reject) {
            const declaredId = ethosNm?.id as string | undefined;
            const rejectedId = declaredId ?? name.replace(/^@[^/]+\//, '');
            this.logger.warn(`[plugin-loader] ${reject}`, {
              component: 'plugin-loader',
              pluginId: rejectedId,
            });
            // Register manifest + path so the failure surfaces via listManifests()/getFailures().
            this.manifests.set(rejectedId, raw as EthosPluginPackageJson);
            this.pluginPaths.set(rejectedId, join(nmDir, name));
            this.trackManifestStatus(rejectedId, 'failed', reject);
            continue;
          }
        }

        const entry = resolveNpmEntry(raw, join(nmDir, name));
        if (!entry) continue;

        // Safety scan the entire npm package source tree before executing any code.
        // User plugins dir is treated as trusted-repo — user made a deliberate install decision.
        const permissions = readPluginPermissions(raw as Record<string, unknown>);
        const tier: TrustTier = opts.allowAll ? 'trusted-repo' : deriveTier(name);
        const scanResult = await scanPluginTree(this.storage, join(nmDir, name), permissions);
        this.pluginScanFindings.set(nmPluginId, scanResult.findings);
        const decision = canInstall(scanResult, tier);
        // Red blocks, exactly as before. Yellow no longer does — see the same
        // rule in `loadFromPluginDir`.
        if (!decision.allowed && scanResult.hasRed) {
          const reason = `Blocked by safety scan: ${decision.blockedBy}`;
          this.logger.warn(
            `[plugin-loader] "${name}" blocked by safety scan: ${decision.blockedBy}`,
            { component: 'plugin-loader', pluginId: nmPluginId, blockedBy: decision.blockedBy },
          );
          this.manifests.set(nmPluginId, raw as EthosPluginPackageJson);
          this.pluginPaths.set(nmPluginId, join(nmDir, name));
          this.trackManifestStatus(nmPluginId, 'failed', reason);
          continue;
        }
        this.logYellowNotes(nmPluginId, scanResult);

        const mod = await import(entry);
        // Use ethos.id if declared, otherwise strip @scope/ so the plugin ID
        // matches what users write in personality config.yaml (e.g. `tools-nse-market-data`
        // not `@ethosagent/tools-nse-market-data`).
        const declaredId = ethosNm?.id as string | undefined;
        const pluginId = declaredId ?? name.replace(/^@[^/]+\//, '');
        this.manifests.set(pluginId, raw as EthosPluginPackageJson);
        this.pluginPaths.set(pluginId, join(nmDir, name));
        this.pluginHasWidgets.set(
          pluginId,
          await this.storage.exists(join(nmDir, name, 'widgets.yaml')),
        );
        await this.activatePlugin(pluginId, mod);
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

  async resolveFromLockfile(
    personalityDir: string,
    pluginIds: string[],
    opts: { dryRun?: boolean; autoInstall?: boolean } = {},
  ): Promise<Array<PluginLockEntry & { id: string }>> {
    // A hostile or corrupt lockfile throws (see `readLockfile`). Refuse the
    // whole auto-install for this personality rather than letting the throw
    // escape into wiring and take the agent down — installing nothing is the
    // fail-closed outcome, and the warning names the file so tampering is not
    // mistaken for "this personality pins nothing".
    let lockfile: PluginLockfile;
    try {
      lockfile = await readLockfile(this.storage, personalityDir, {
        onReject: (id, reason) =>
          this.logger.warn(`[plugin-loader] Ignoring plugins.lock entry "${id}" — ${reason}`, {
            component: 'plugin-loader',
            pluginId: id,
          }),
      });
    } catch (err) {
      this.logger.error(
        `[plugin-loader] Refusing to auto-install from ${personalityDir}: ${err instanceof Error ? err.message : String(err)}`,
        { component: 'plugin-loader' },
      );
      return [];
    }
    if (Object.keys(lockfile).length === 0) return [];

    const missing: Array<PluginLockEntry & { id: string }> = [];
    for (const id of pluginIds) {
      if (this.isLoaded(id)) continue;
      const entry = lockfile[id];
      if (!entry) continue;
      missing.push({ id, ...entry });
    }

    if (missing.length === 0 || opts.dryRun) return missing;

    if (opts.autoInstall === false) {
      this.logger.warn(
        `[plugin-loader] Skipping auto-install of ${missing.length} plugin(s) — plugins.auto_install is false`,
        { component: 'plugin-loader' },
      );
      return missing;
    }

    for (const entry of missing) {
      await this.installFromLockEntry(entry);
    }

    return missing;
  }

  private async installFromLockEntry(entry: PluginLockEntry & { id: string }): Promise<void> {
    const { execFileSync } = await import('node:child_process');
    const pluginsDir = join(this.dataDir, 'plugins');
    const exactSpec = `${entry.package}@${entry.version}`;

    // G5 — auto-install fetches code from a registry and imports it into this
    // process with nobody at the keyboard. A lockfile entry is a pin, not the
    // operator's consent: a personality bundle carried to a new machine brings
    // the pin along, and the operator on THIS machine never agreed to anything.
    // Refuse rather than manufacture a grant. Already-installed plugins are
    // unaffected — this gate is only on fetching something new.
    const grants = await readGrants(this.storage, pluginsDir, {
      onReject: (id, reason) =>
        this.logger.warn(`[plugin-loader] Ignoring grant record "${id}" — ${reason}.`, {
          component: 'plugin-loader',
          pluginId: id,
        }),
    });
    const grant = grants[entry.id];
    if (!grant || grant.revokedAt) {
      const why = grant ? 'its capability grant was revoked' : 'no capability grant is recorded';
      this.logger.warn(
        `[plugin-loader] Not auto-installing ${entry.id} (${exactSpec}) — ${why}. Run: ethos plugin install ${entry.package}`,
        { component: 'plugin-loader', pluginId: entry.id },
      );
      return;
    }
    // npm is invoked with an ARGV ARRAY through `execFileSync` — no shell, so
    // no field here can be quoted or escaped out of. Every field additionally
    // passed `validateLockEntry` on the way out of `readLockfile`; the argv
    // array is the second half of the defence, not the only half.
    const args = ['install', '--prefix', pluginsDir, '--ignore-scripts', '--no-audit'];
    if (entry.registry !== DEFAULT_REGISTRY) args.push('--registry', entry.registry);
    args.push(exactSpec);

    try {
      execFileSync('npm', args, { stdio: 'pipe', timeout: 60_000 });

      // No `npm rebuild` here, deliberately. `npm rebuild` re-runs the
      // preinstall/install/postinstall scripts that `--ignore-scripts`
      // suppressed on the line above — verified on npm 11.12.1 — and it ran
      // BEFORE `loadFromNodeModules`'s safety scan, inverting this loader's own
      // "scan before executing any code" ordering. `npm rebuild
      // --ignore-scripts` is not an alternative: those scripts ARE how a native
      // addon compiles, so with the flag the rebuild recompiles nothing.
      // Trade-off, stated rather than hidden: a lockfile plugin shipping a
      // native addon (e.g. argon2) now loads without its compiled binding until
      // the operator rebuilds it deliberately. The two sibling install paths
      // (`ethos plugin install`, personality import) never rebuilt either.
      this.logger.info(
        `[plugin-loader] Auto-installed plugin ${entry.id} (${exactSpec}) — lifecycle scripts were not run; if it ships a native addon, run: npm rebuild --prefix ${pluginsDir} ${entry.package}`,
        { component: 'plugin-loader', pluginId: entry.id },
      );

      await this.loadFromNodeModules(join(pluginsDir, 'node_modules'));
    } catch (err) {
      this.logger.warn(
        `[plugin-loader] Failed to auto-install plugin ${entry.id}: ${err instanceof Error ? err.message : String(err)}`,
        { component: 'plugin-loader', pluginId: entry.id },
      );
    }
  }

  /** Skill source directories declared by loaded packages via `ethos.skills_dir`. */
  getPluginSkillSources(): { label: string; dir: string }[] {
    return [...this.pluginSkillSources];
  }

  /** Return all loaded/failed plugin manifests with status info. */
  listManifests(): InstalledPluginManifest[] {
    return [...this.loadedManifests.values()];
  }

  /**
   * Return manifests for plugins that failed to load (rejected contract major,
   * missing dependency, or an `activate()` that threw), each carrying its
   * `error` reason. P2.6/S7 — the caller inspects this to escalate per-plugin
   * load failures instead of leaving them buried in the logs.
   */
  getFailures(): InstalledPluginManifest[] {
    return [...this.loadedManifests.values()].filter((m) => m.status === 'failed');
  }

  getDataSourcePath(pluginId: string, sourceId: string): string | null {
    return this.registries.dataSources?.get(pluginId)?.get(sourceId) ?? null;
  }

  getPluginPath(pluginId: string): string | null {
    return this.pluginPaths.get(pluginId) ?? null;
  }

  getSlashHandler(
    name: string,
  ):
    | ((args: string, ctx: import('@ethosagent/types').SlashCommandContext) => Promise<string>)
    | undefined {
    for (const api of this.apis.values()) {
      const handler = api.getSlashHandler(name);
      if (handler) return handler;
    }
    return undefined;
  }

  getAllSlashCommands(): { name: string; description: string; usage: string }[] {
    const result: { name: string; description: string; usage: string }[] = [];
    for (const api of this.apis.values()) {
      result.push(...api.getAllSlashCommands());
    }
    return result;
  }

  getPlatformAdapters(): Map<string, import('@ethosagent/types').PlatformAdapterFactory> {
    return this.registries.platformAdapters ?? new Map();
  }

  getCliSubcommandHandler(
    name: string,
  ): ((ctx: import('@ethosagent/types').CliSubcommandContext) => Promise<number>) | undefined {
    for (const api of this.apis.values()) {
      const handler = api.getCliSubcommandHandler(name);
      if (handler) return handler;
    }
    return undefined;
  }

  getAllCliSubcommands(): { name: string; description: string }[] {
    const result: { name: string; description: string }[] = [];
    for (const api of this.apis.values()) {
      result.push(...api.getAllCliSubcommands());
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Health checks
  // ---------------------------------------------------------------------------

  /** Run health checks for one or all plugins. Results sorted by severity. */
  async runHealthChecks(pluginId?: string): Promise<
    Array<{
      pluginId: string;
      checkName: string;
      description: string;
      result: HealthCheckResult;
    }>
  > {
    const results: Array<{
      pluginId: string;
      checkName: string;
      description: string;
      result: HealthCheckResult;
    }> = [];

    const targets = pluginId ? [this.apis.get(pluginId)].filter(Boolean) : [...this.apis.values()];

    for (const api of targets) {
      if (!api) continue;
      const checks = api.getHealthChecks();
      for (const check of checks) {
        const start = performance.now();
        let result: HealthCheckResult;
        try {
          result = await Promise.race([
            check.run(),
            new Promise<HealthCheckResult>((_, reject) =>
              setTimeout(() => reject(new Error('Health check timed out after 5000ms')), 5000),
            ),
          ]);
        } catch (err) {
          result = { status: 'error', message: err instanceof Error ? err.message : String(err) };
        }
        result.durationMs = performance.now() - start;
        results.push({
          pluginId: api.pluginId,
          checkName: check.name,
          description: check.description,
          result,
        });
      }

      // v2.2 — synthetic health checks for crashed monitors
      const crashedMonitors = api.getCrashedMonitors();
      for (const monitorName of crashedMonitors) {
        results.push({
          pluginId: api.pluginId,
          checkName: `monitor:${monitorName}`,
          description: `Monitor '${monitorName}' runtime status`,
          result: {
            status: 'error',
            message: `Monitor crashed — see: ethos doctor ${api.pluginId} --logs --level error`,
          },
        });
      }
    }

    return results.sort((a, b) => {
      const order = { error: 0, warn: 1, ok: 2 };
      return order[a.result.status] - order[b.result.status];
    });
  }

  // ---------------------------------------------------------------------------
  // Credential management
  // ---------------------------------------------------------------------------
  //
  // `pluginId` and the credential name arrive from the `plugins.*` RPC, whose
  // wire schemas constrain them to `z.string().min(1)` — nothing upstream of
  // here checks either. `join()` NORMALISES `..`, so an unchecked name is an
  // arbitrary path: a read (`getCredentialValue`), a delete (`clearCredential`)
  // and a stat (`getCredentialMeta`) over the whole filesystem the agent user
  // can reach, against a bare `FsStorage` with no `ScopedStorage` under it.
  //
  // Both path builders below therefore validate the SEGMENT before joining and
  // then assert containment of the result, and every credential method goes
  // through them. Refusal is a thrown typed error, never `null`: a null here is
  // indistinguishable from "no such credential", which would hide the attempt
  // from the operator and from the logs.

  /** Refuse a plugin id that is not a plain identifier. Returns it unchanged. */
  private assertPluginId(pluginId: string): string {
    if (!isValidPluginId(pluginId)) {
      throw new CredentialPathError(`Invalid plugin id "${pluginId}"`);
    }
    return pluginId;
  }

  /** The credential metadata directory for a plugin. Throws if `pluginId` is not a plain id. */
  private credentialsDir(pluginId: string): string {
    this.assertPluginId(pluginId);
    const pluginsBase = join(this.dataDir, 'plugins');
    const dir = join(pluginsBase, pluginId, 'credentials');
    assertWithinBase(pluginsBase, dir);
    return dir;
  }

  /** Path to one credential's metadata sidecar. Throws if either segment is unsafe. */
  private credentialMetaFile(pluginId: string, name: string): string {
    const dir = this.credentialsDir(pluginId);
    if (!isValidSecretName(name)) {
      throw new CredentialPathError(`Invalid credential name "${name}"`);
    }
    const path = join(dir, `${name}.meta`);
    assertWithinBase(dir, path);
    return path;
  }

  /** The vault ref for one credential. Throws if either segment is unsafe. */
  private credentialRef(pluginId: string, name: string): string {
    this.assertPluginId(pluginId);
    if (!isValidSecretName(name)) {
      throw new CredentialPathError(`Invalid credential name "${name}"`);
    }
    return pluginCredentialRef(pluginId, name);
  }

  /**
   * Move this plugin's pre-vault credentials into the `SecretsResolver`, once
   * per process. Runs before every credential read/write and before a plugin
   * is activated, so an install that predates the vault keeps working with no
   * operator action.
   */
  private async ensureCredentialsMigrated(pluginId: string): Promise<void> {
    if (this.migratedCredentials.has(pluginId)) return;
    // Claimed before the await so two concurrent callers cannot both migrate.
    this.migratedCredentials.add(pluginId);
    try {
      await migrateLegacyPluginCredentials({
        secrets: this.secrets,
        storage: this.credentialStorage,
        pluginId,
        legacyDir: this.credentialsDir(pluginId),
      });
    } catch (err) {
      this.migratedCredentials.delete(pluginId);
      throw err;
    }
  }

  /** Set a credential value for a loaded plugin. Throws if the plugin is not loaded. */
  async setCredential(pluginId: string, key: string, value: string): Promise<void> {
    // Validate at this boundary — the RPC entry point — before anything is
    // read, written or migrated, so a hostile key is refused on the same rule
    // as the reads and never reaches storage.
    this.credentialRef(pluginId, key);
    await this.ensureCredentialsMigrated(pluginId);
    const impl = this.apis.get(pluginId);
    if (!impl) throw new Error(`Plugin "${pluginId}" is not loaded`);
    await impl.setSecret(key, value);
  }

  /** Read credential metadata (updatedAt timestamp). Returns null if unset. */
  async getCredentialMeta(pluginId: string, key: string): Promise<{ updatedAt: string } | null> {
    const raw = await this.credentialStorage.read(this.credentialMetaFile(pluginId, key));
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as { updatedAt: string };
    } catch {
      return null;
    }
  }

  /** Remove a credential and its metadata for a plugin. */
  async clearCredential(pluginId: string, key: string): Promise<void> {
    const ref = this.credentialRef(pluginId, key);
    const metaPath = this.credentialMetaFile(pluginId, key);
    await this.ensureCredentialsMigrated(pluginId);
    await this.secrets.delete(ref);
    await this.credentialStorage.remove(metaPath).catch(() => {});
    // A loaded plugin's `hasSecret` answers from a primed set — without this
    // it would keep reporting a credential the operator just cleared.
    this.apis.get(pluginId)?.forgetSecret(key);
  }

  /** Read the raw credential value. Returns null if unset. */
  async getCredentialValue(pluginId: string, ref: string): Promise<string | null> {
    const vaultRef = this.credentialRef(pluginId, ref);
    await this.ensureCredentialsMigrated(pluginId);
    return this.secrets.get(vaultRef);
  }

  /** Return a redacted preview of a credential (first 4 + last 4 chars).
   *  Returns null when the credential is not set. */
  async getCredentialPreview(pluginId: string, ref: string): Promise<string | null> {
    const raw = await this.getCredentialValue(pluginId, ref);
    if (raw === null) return null;
    if (raw.length <= 8) return '****';
    return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
  }

  /**
   * List all credential keys for a plugin, merging manifest declarations
   * with on-disk credential state. Returns declared credentials (from
   * `ethos.credentials` in package.json) enriched with `isSet` / `updatedAt`,
   * plus any undeclared keys found on disk.
   */
  async listCredentialKeys(pluginId: string): Promise<
    Array<{
      key: string;
      isSet: boolean;
      updatedAt: string | null;
      label: string;
      type: 'secret' | 'text';
      description?: string;
      refreshHint?: 'daily' | 'weekly' | 'manual';
      required?: boolean;
    }>
  > {
    const declared = this.readDeclaredCredentials(pluginId);
    const prefix = pluginCredentialPrefix(this.assertPluginId(pluginId));
    await this.ensureCredentialsMigrated(pluginId);
    const setKeys = new Set(
      (await this.secrets.list(prefix)).map((ref) => ref.slice(prefix.length)),
    );

    const result: Array<{
      key: string;
      isSet: boolean;
      updatedAt: string | null;
      label: string;
      type: 'secret' | 'text';
      description?: string;
      refreshHint?: 'daily' | 'weekly' | 'manual';
      required?: boolean;
    }> = [];

    const seenKeys = new Set<string>();

    for (const cred of declared) {
      // A key the credential API cannot address is a key nothing can ever set
      // or read, so listing it would only offer the operator a dead control.
      // Skipped rather than thrown: one bad declaration must not blank the
      // whole panel for a plugin whose other credentials are fine.
      if (!isValidSecretName(cred.key)) {
        this.logger.warn(
          `[plugin-loader] Plugin "${pluginId}" declares credential key "${cred.key}", which is not a plain name — skipping.`,
          { component: 'plugin-loader', pluginId },
        );
        continue;
      }
      seenKeys.add(cred.key);
      const meta = await this.getCredentialMeta(pluginId, cred.key);
      result.push({
        key: cred.key,
        isSet: setKeys.has(cred.key),
        updatedAt: meta?.updatedAt ?? null,
        label: cred.label,
        type: cred.type,
        description: cred.description,
        refreshHint: cred.refreshHint,
        required: cred.required,
      });
    }

    // Scan the vault for credentials the manifest never declared
    for (const name of setKeys) {
      if (seenKeys.has(name)) continue;
      if (!isValidSecretName(name)) continue;
      const meta = await this.getCredentialMeta(pluginId, name);
      result.push({
        key: name,
        isSet: true,
        updatedAt: meta?.updatedAt ?? null,
        label: name,
        type: 'text',
      });
    }

    return result;
  }

  private readDeclaredCredentials(pluginId: string): CredentialDeclaration[] {
    const manifest = this.manifests.get(pluginId);
    return manifest?.ethos?.credentials ?? [];
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * Return the id whose capability grant has been revoked, or `null` when none
   * of `ids` is revoked.
   *
   * Read fresh from disk on every check — an `ethos plugin revoke` in another
   * process must take effect on the next load, not after a restart. This is a
   * consent check, not a sandbox: it decides whether we import the plugin at
   * all. Once imported, a plugin is unconstrained, and revoking afterwards
   * cannot undo what it did.
   */
  private async revokedGrantId(ids: Array<string | undefined>): Promise<string | null> {
    const grants = await readGrants(this.storage, join(this.dataDir, 'plugins'), {
      onReject: (id, reason) =>
        this.logger.warn(`[plugin-loader] Ignoring grant record "${id}" — ${reason}.`, {
          component: 'plugin-loader',
          pluginId: id,
        }),
    });
    for (const id of ids) {
      if (id && isGrantRevoked(grants, id)) return id;
    }
    return null;
  }

  /**
   * Note yellow findings on a plugin that is being loaded anyway. This is not
   * a block and must not read like one — the findings are retained on the
   * manifest and shown in the Plugins UI, and this line is the log-side echo.
   */
  private logYellowNotes(id: string, scan: { hasYellow: boolean; findings: ScanFinding[] }): void {
    if (!scan.hasYellow) return;
    const yellow = scan.findings.filter((f) => f.severity === 'yellow');
    const rules = [...new Set(yellow.map((f) => f.rule))].join(', ');
    this.logger.info(
      `[plugin-loader] "${id}" loaded with ${yellow.length} safety note(s) (${rules}) — review them in the Plugins tab.`,
      { component: 'plugin-loader', pluginId: id, findingCount: yellow.length },
    );
  }

  /** Record activation status for a plugin in the loadedManifests map. */
  private trackManifestStatus(
    id: string,
    status: 'loaded' | 'failed',
    error?: string,
    dialect: 'ethos' | 'openclaw' = 'ethos',
  ): void {
    const pkgJson = this.manifests.get(id);
    const path = this.pluginPaths.get(id) ?? '';
    const source: 'user' | 'project' | 'npm' = path.includes('node_modules') ? 'npm' : 'user';
    const dsMap = this.registries.dataSources?.get(id);
    const dataSources = dsMap ? [...dsMap.keys()] : [];
    const hasWidgets = this.pluginHasWidgets.get(id) ?? false;
    const scanFindings = this.pluginScanFindings.get(id) ?? [];
    const entry: InstalledPluginManifest = {
      id,
      name: pkgJson?.name ?? id,
      version: pkgJson?.version ?? '0.0.0',
      description: pkgJson?.description ?? null,
      source,
      path,
      pluginContractMajor: pkgJson?.ethos?.pluginContractMajor ?? null,
      dialect,
      credentials: pkgJson?.ethos?.credentials ?? [],
      dataSources,
      hasWidgets,
      status,
      error,
      ...(scanFindings.length > 0 ? { scanFindings } : {}),
    };
    this.loadedManifests.set(id, entry);
  }

  /** Build the api object handed to one plugin. */
  private makeApi(id: string): PluginApiImpl {
    return new PluginApiImpl(id, this.registries, {
      secrets: this.secrets,
      storage: this.credentialStorage,
      basePath: join(this.dataDir, 'plugins', id),
    });
  }

  /**
   * Migrate this plugin's legacy on-disk credentials into the vault and prime
   * the api's key set, so the synchronous `hasSecret` is answerable from the
   * first call. Returns an error message when it failed — the caller aborts
   * the load rather than handing the plugin an api whose credential view is
   * silently empty.
   */
  private async initCredentials(id: string, api: PluginApiImpl): Promise<string | null> {
    try {
      await this.ensureCredentialsMigrated(id);
      await api.primeSecrets();
      return null;
    } catch (err) {
      const message = `Credential init failed: ${String(err)}`;
      this.logger.warn(`[plugin-loader] Plugin "${id}" ${message}`, {
        component: 'plugin-loader',
        pluginId: id,
        error: String(err),
      });
      return message;
    }
  }

  private async activatePlugin(id: string, mod: unknown): Promise<void> {
    // Validate declared dependencies are loaded before activation
    const manifest = this.manifests.get(id);
    const deps = manifest?.ethos?.dependencies;
    if (Array.isArray(deps)) {
      for (const dep of deps) {
        if (typeof dep === 'string' && !this.plugins.has(dep)) {
          this.logger.warn(
            `[plugin-loader] Plugin "${id}" requires "${dep}" but it is not loaded — skipping`,
            { component: 'plugin-loader', pluginId: id },
          );
          this.trackManifestStatus(id, 'failed', `Missing dependency: ${dep}`);
          return;
        }
      }
    }

    // Try OpenClaw dialect first — register(api) export pattern
    const openclawRegister = extractOpenClawRegister(mod);
    if (openclawRegister && !isPluginModule(mod)) {
      await this.activateOpenClawPlugin(id, openclawRegister);
      return;
    }

    // Ethos-native dialect — activate(api) export pattern
    if (!isPluginModule(mod)) {
      this.logger.warn(
        `[plugin-loader] "${id}" has no activate() or register() export — skipping`,
        { component: 'plugin-loader', pluginId: id },
      );
      return;
    }

    // Unload existing version if reloading
    if (this.plugins.has(id)) {
      await this.unload(id);
    }

    const api = this.makeApi(id);
    const credentialError = await this.initCredentials(id, api);
    if (credentialError) {
      this.trackManifestStatus(id, 'failed', credentialError);
      api.cleanup();
      return;
    }

    try {
      await mod.activate(api);
    } catch (err) {
      this.logger.warn(`[plugin-loader] Plugin "${id}" activate() threw: ${String(err)}`, {
        component: 'plugin-loader',
        pluginId: id,
        error: String(err),
      });
      this.trackManifestStatus(id, 'failed', String(err));
      api.cleanup();
      return;
    }

    this.trackManifestStatus(id, 'loaded');
    this.apis.set(id, api);
    this.plugins.set(id, mod);
  }

  private async activateOpenClawPlugin(
    id: string,
    registerFn: (...args: unknown[]) => unknown,
  ): Promise<void> {
    const ethosApi = this.makeApi(id);
    const credentialError = await this.initCredentials(id, ethosApi);
    if (credentialError) {
      this.logger.warn(`[plugin-loader] OpenClaw plugin "${id}": ${credentialError}`, {
        component: 'plugin-loader',
        pluginId: id,
      });
      ethosApi.cleanup();
      return;
    }
    const shim = createOpenClawApiShim(id, ethosApi, this.compatCallbacks);

    try {
      await registerFn(shim);
    } catch (err) {
      this.logger.warn(`[plugin-loader] OpenClaw plugin "${id}" register() threw: ${String(err)}`, {
        component: 'plugin-loader',
        pluginId: id,
        error: String(err),
      });
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
// Dependency ordering + priority sort
// ---------------------------------------------------------------------------

/**
 * Topological sort of plugin manifests by dependency order, with priority
 * tie-breaking. Throws on circular dependencies.
 */
export function topologicalSort<
  T extends { id: string; dependencies?: string[]; priority?: number },
>(manifests: T[]): T[] {
  const graph = new Map<string, string[]>();
  const ids = new Set(manifests.map((m) => m.id));

  for (const m of manifests) {
    graph.set(
      m.id,
      (m.dependencies ?? []).filter((d) => ids.has(d)),
    );
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];

  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(`Circular plugin dependency detected: ${[...visiting, id].join(' → ')}`);
    }
    visiting.add(id);
    const deps = graph.get(id) ?? [];
    for (const dep of deps) visit(dep);
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  }

  // Sort by priority (descending) before visiting so that ties are broken by priority
  const sorted = [...manifests].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  for (const m of sorted) visit(m.id);

  const idxMap = new Map(order.map((id, i) => [id, i]));
  return [...manifests].sort((a, b) => (idxMap.get(a.id) ?? 0) - (idxMap.get(b.id) ?? 0));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Safety-scan helpers
// ---------------------------------------------------------------------------

/** Extract declared permissions from an already-parsed package.json object. */
function readPluginPermissions(pkgJson: Record<string, unknown>): PluginScanPermissions {
  const ethos = pkgJson.ethos;
  if (typeof ethos !== 'object' || ethos === null || Array.isArray(ethos)) return {};
  const perms = (ethos as Record<string, unknown>).permissions;
  if (typeof perms !== 'object' || perms === null || Array.isArray(perms)) return {};
  const p = perms as Record<string, unknown>;
  const result: PluginScanPermissions = {};
  if (p.shell === true) result.shell = true;
  if (Array.isArray(p.network)) {
    result.network = p.network.filter((x): x is string => typeof x === 'string');
  } else if (p.network === true) {
    result.network = []; // declared but no host restriction
  }
  return result;
}

/**
 * Recursively scan all .js/.ts source files under `dir`, aggregating findings.
 * Skips node_modules to avoid scanning thousands of dependency files.
 */
async function scanPluginTree(
  storage: Storage,
  dir: string,
  permissions: PluginScanPermissions,
): Promise<{ hasRed: boolean; hasYellow: boolean; findings: PluginScanFindingRecord[] }> {
  const findings: PluginScanFindingRecord[] = [];
  await collectFindings(storage, dir, permissions, findings, dir);
  return {
    findings,
    hasRed: findings.some((f) => f.severity === 'red'),
    hasYellow: findings.some((f) => f.severity === 'yellow'),
  };
}

async function collectFindings(
  storage: Storage,
  dir: string,
  permissions: PluginScanPermissions,
  out: PluginScanFindingRecord[],
  rootDir: string,
): Promise<void> {
  const entries = await storage.listEntries(dir).catch(() => []);
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDir) {
      if (entry.name === 'node_modules') continue; // skip dep trees
      await collectFindings(storage, fullPath, permissions, out, rootDir);
    } else if (
      /\.[jt]sx?$|\.(?:cjs|mjs)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.d.cts') &&
      !entry.name.endsWith('.d.mts')
    ) {
      const src = await storage.read(fullPath);
      if (!src) continue;
      const file = relative(rootDir, fullPath);
      for (const finding of scanPluginCode(src, permissions).findings) {
        out.push({ ...finding, file });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Installed plugin manifest discovery
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
  storage: Storage;
}): Promise<InstalledPluginManifest[]> {
  const storage = opts.storage;
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
    isOpenClawPackageJson(manifest) && !manifest.ethos ? 'openclaw' : 'ethos';
  const id =
    dialect === 'ethos'
      ? (manifest.ethos?.id ?? manifest.name)
      : (((manifest.openclaw?.channel as Record<string, unknown> | undefined)?.id as
          | string
          | undefined) ?? manifest.name);
  return {
    id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description ?? null,
    source,
    path: pluginDir,
    pluginContractMajor: manifest.ethos?.pluginContractMajor ?? null,
    dialect,
    hasHomePanel: manifest.ethos?.hasHomePanel ?? false,
    credentials: manifest.ethos?.credentials ?? [],
    dataSources: [],
    hasWidgets: false,
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
  // Accept any package with an ethos field, or OpenClaw plugins (openclaw block present)
  if (!parsed.ethos && !isOpenClawPackageJson(parsed)) return null;
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
 * incompatible with — or (P2.6/S8) absent from — the current contract. Returns
 * `null` to allow the load.
 *
 * Only Ethos-native plugins (`ethos.type === 'plugin'`) are gated. Packages
 * without a package.json (loader-only/dev plugins), OpenClaw plugins, and
 * skills-only packages declare no contract major and are not subject to this
 * check.
 */
async function checkContractMajorFromDir(
  storage: Storage,
  dir: string,
  id: string,
): Promise<string | null> {
  const src = await storage.read(join(dir, 'package.json'));
  if (!src) return null; // no package.json — loader-only/dev plugin, not contract-gated
  let raw: unknown;
  try {
    raw = JSON.parse(src);
  } catch {
    return null;
  }
  if (!isEthosPlugin(raw)) return null; // not an Ethos-native plugin — not gated
  const declared = (raw as { ethos?: { pluginContractMajor?: number } }).ethos?.pluginContractMajor;
  return rejectionForDeclaredMajor(declared, id);
}

/**
 * Phase P2.6 (S8) — an Ethos plugin that declares NO `ethos.pluginContractMajor`
 * has an unknown contract; we cannot verify compatibility, so we refuse to run
 * its top-level code. This is the same enforcement as an incompatible-major
 * rejection (logged + status-tracked + not imported by the caller). Returns a
 * rejection string, or `null` when the declared major is compatible.
 */
function rejectionForDeclaredMajor(declared: number | undefined, id: string): string | null {
  if (declared === undefined) {
    return `Plugin "${id}" declares no ethos.pluginContractMajor; its plugin contract is unknown and cannot be verified (current contract major is ${PLUGIN_CONTRACT_MAJOR}). Declare ethos.pluginContractMajor in package.json. See https://github.com/ethosdev/ethos/blob/main/packages/plugin-contract/MIGRATIONS.md`;
  }
  const result = checkPluginContractMajor(declared, undefined, id);
  return result.ok ? null : (result.reason ?? `Plugin "${id}" rejected`);
}

/**
 * Returns true when `candidate` resolves to a path inside `container`.
 * Prevents path-traversal attacks via entries like `"main": "../../evil.js"`.
 */
function isContainedIn(candidate: string, container: string): boolean {
  const resolved = resolve(candidate);
  const base = resolve(container);
  return resolved === base || resolved.startsWith(`${base}/`);
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
      if (!isContainedIn(candidate, dir)) return null;
      if (await storage.exists(candidate)) return candidate;
    }
  } catch {
    // no parseable package.json
  }

  return null;
}

function resolveNpmEntry(pkg: Record<string, unknown>, dir: string): string | null {
  const main = pkg.main as string | undefined;
  if (main) {
    const candidate = join(dir, main);
    return isContainedIn(candidate, dir) ? candidate : null;
  }

  const exports = pkg.exports as Record<string, unknown> | undefined;
  if (exports?.['.']) {
    const exp = exports['.'];
    if (typeof exp === 'string') {
      const candidate = join(dir, exp);
      return isContainedIn(candidate, dir) ? candidate : null;
    }
    if (typeof exp === 'object' && exp !== null) {
      const sub = exp as Record<string, string>;
      const raw = sub.import ?? sub.default ?? sub.require ?? '';
      if (!raw) return null;
      const candidate = join(dir, raw);
      return isContainedIn(candidate, dir) ? candidate : null;
    }
  }

  return join(dir, 'index.js');
}
