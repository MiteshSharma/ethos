import type {
  CliSubcommandContext,
  CommandDefinition,
  ContextEngine,
  ContextEngineRegistry,
  ContextInjector,
  DiagnosticsEmitter,
  ExecutionBackendFactory,
  ExecutionBackendRegistry,
  HookRegistry,
  LLMProviderFactory,
  LLMProviderRegistry,
  MemoryProviderFactory,
  MemoryProviderRegistry,
  ModifyingHooks,
  NotificationRouter,
  NotifyOptions,
  OAuthConfig,
  PersonalityConfig,
  PersonalityRegistry,
  PlatformAdapterFactory,
  PluginHealthCheck,
  PluginMonitorDef,
  PluginPageSpec,
  PluginRendererSpec,
  PostTurnEvaluator,
  SecretsResolver,
  SlashCommandContext,
  Storage,
  StorageFactory,
  StorageRegistry,
  SttProviderFactory,
  SttProviderRegistry,
  Tool,
  ToolInvocationFilter,
  ToolRegistry,
  TtsProviderFactory,
  TtsProviderRegistry,
  VoidHooks,
} from '@ethosagent/types';
import { isValidSecretName } from '@ethosagent/types';
import { pluginCredentialPrefix, pluginCredentialRef } from './credentials';
import type { DiagnosticStore } from './diagnostic-store';
import { PluginMonitorRunner } from './monitor-runner';

/**
 * Intersect a command's allowedTools with the personality toolset.
 * Returns the narrower set — tools allowed by both.
 */
export function intersectToolGrants(
  commandTools: string[] | undefined,
  personalityToolset: string[] | undefined,
): string[] | undefined {
  if (!commandTools) return personalityToolset;
  if (!personalityToolset) return commandTools;
  const allowed = new Set(personalityToolset);
  return commandTools.filter((t) => allowed.has(t));
}

// ---------------------------------------------------------------------------
// CredentialStorage — Storage + synchronous existence check
// ---------------------------------------------------------------------------

/**
 * @deprecated Nothing in the SDK needs `existsSync` any more. `hasSecret` used
 * to stat a credential file through it; credentials now live in the
 * `SecretsResolver` vault and `hasSecret` answers from a primed in-memory set
 * (see `PluginApiImpl.primeSecrets`). Kept because this package is published —
 * removing an exported interface is a break for anyone who imported it. Pass a
 * plain `Storage` instead; `PluginLoaderOptions.credentialStorage` accepts one.
 */
export interface CredentialStorage extends Storage {
  existsSync(path: string): boolean;
}

// ---------------------------------------------------------------------------
// Plugin credentials
// ---------------------------------------------------------------------------

export interface PluginCredentialOptions {
  /**
   * The vault. G-SEC: the sole storage and retrieval path for this plugin's
   * credential material. Refs are `plugins/<pluginId>/<key>`.
   */
  secrets: SecretsResolver;
  /**
   * Storage for the `<key>.meta` sidecar — an `updatedAt` timestamp, no
   * credential material. The operator UI reads it for rotation hints.
   */
  storage: Storage;
  /** `<dataDir>/plugins/<pluginId>` — the sidecars live under `credentials/`. */
  basePath: string;
}

// ---------------------------------------------------------------------------
// HTTP route types — plugin-registered API endpoints
// ---------------------------------------------------------------------------

export interface PluginHttpRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | string;
  query: Record<string, string>;
}

export interface PluginHttpResponse {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface PluginRouteEntry {
  pluginId: string;
  method: string;
  path: string;
  handler: (req: PluginHttpRequest) => Promise<PluginHttpResponse>;
}

// ---------------------------------------------------------------------------
// PluginEventBus — lightweight pub/sub for inter-plugin communication
// ---------------------------------------------------------------------------

export class PluginEventBus {
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();

  emit(event: string, payload: unknown): void {
    const set = this.handlers.get(event);
    if (set) {
      for (const h of set) {
        // Fail-open: handler errors must not block other handlers or the emitter.
        // Matches the void-hook execution model in HookRegistry.
        try {
          h(payload);
        } catch {
          /* fail-open by design */
        }
      }
    }
  }

  on(event: string, handler: (payload: unknown) => void): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    const set = this.handlers.get(event);
    if (set) set.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }
}

// ---------------------------------------------------------------------------
// OAuth types — OAuthConfig moved to @ethosagent/types; coordinator stays here
// ---------------------------------------------------------------------------

export interface OAuthCoordinator {
  beginFlow(opts: {
    pluginId: string;
    sessionKey: string;
    config: OAuthConfig;
    pendingUserMessage: string;
    redirectUri: string;
  }): string;
  handleCallback(
    code: string,
    state: string,
    notificationRouter: import('@ethosagent/types').NotificationRouter,
  ): Promise<void>;
  cancelAll(pluginId: string): void;
}

// ---------------------------------------------------------------------------
// Plugin module shape — what every plugin file must export
// ---------------------------------------------------------------------------

export interface EthosPlugin {
  activate(api: EthosPluginApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// EthosPluginApi — passed to activate()
// ---------------------------------------------------------------------------

export interface EthosPluginApi {
  /** Unique identifier for this plugin instance. */
  readonly pluginId: string;

  /** Register a tool that will appear in the LLM's tool list. */
  registerTool(tool: Tool): void;

  /** Register a void hook (fire-and-forget, runs in parallel). */
  registerVoidHook<K extends keyof VoidHooks>(
    name: K,
    handler: (payload: VoidHooks[K]) => Promise<void>,
  ): void;

  /** Register a modifying hook (sequential, can amend prompt/args). */
  registerModifyingHook<K extends keyof ModifyingHooks>(
    name: K,
    handler: (payload: ModifyingHooks[K][0]) => Promise<Partial<ModifyingHooks[K][1]> | null>,
  ): void;

  /** Register a context injector (adds content to the system prompt). */
  registerInjector(injector: ContextInjector): void;

  /** Register a custom personality. */
  registerPersonality(config: PersonalityConfig): void;

  /** E4 — register a custom context-compaction engine. The engine becomes
   *  selectable via `personality.context_engine: <engine.name>`. */
  registerContextEngine(engine: ContextEngine): void;

  /** Register a named LLM provider factory. Usable in config.yaml via
   *  `provider: <name>` or in personality-level model routing. */
  registerLLMProvider(name: string, factory: LLMProviderFactory): void;

  /** Register a named memory provider factory. Personalities opt in via
   *  `memory.provider: <name>` in their config.yaml. */
  registerMemoryProvider(name: string, factory: MemoryProviderFactory): void;

  /** Register a named storage backend factory. Deployments select it via
   *  `config.storage.backend: <name>`. */
  registerStorage(name: string, factory: StorageFactory): void;

  /** Register a named execution backend factory. Personalities select it via
   *  their `execution:` posture. HIGHEST-privilege class — runs model-directed
   *  code. Subject to trusted-plugin allowlist in the wiring layer. */
  registerExecutionBackend(name: string, factory: ExecutionBackendFactory): void;

  /** Register a platform adapter factory. Teams opt in via `channels:` block
   *  in their manifest. */
  registerPlatformAdapter(name: string, factory: PlatformAdapterFactory): void;

  /** Register a named STT provider factory. Selected via
   *  `auxiliary.asr.provider: <name>` in config.yaml. */
  registerSttProvider(name: string, factory: SttProviderFactory): void;

  /** Register a named TTS provider factory. Selected via
   *  `auxiliary.tts.provider: <name>` in config.yaml. */
  registerTtsProvider(name: string, factory: TtsProviderFactory): void;

  /** Check whether a secret exists (synchronous). Answered from the key set
   *  loaded when the plugin was activated, plus every `setSecret` since — a
   *  credential written by another process afterwards reads as absent until
   *  the plugin reloads. `getSecret` is the authoritative check. */
  hasSecret(key: string): boolean;

  /** Read a secret value. Returns null if the secret doesn't exist or no
   *  credential storage is configured. Throws if `key` is not a plain name
   *  (alphanumeric, underscores, hyphens). */
  getSecret(key: string): Promise<string | null>;

  /** Write a secret value + metadata. Throws if no credential storage is
   *  configured, or if `key` is not a plain name. */
  setSecret(key: string, value: string): Promise<void>;

  /** Register a handler called after `setSecret`. Returns an unsubscribe fn. */
  onCredentialUpdate(handler: (key: string) => void | Promise<void>): () => void;

  /** Register a tool invocation filter (v2). */
  registerToolFilter(filter: ToolInvocationFilter): void;

  /** Register a post-turn evaluator (v2). */
  registerEvaluator(evaluator: PostTurnEvaluator): void;

  /** Register an HTTP route served by the host. */
  registerRoute(opts: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    handler: (req: PluginHttpRequest) => Promise<PluginHttpResponse>;
  }): void;

  /** Emit an event on the shared event bus. */
  emit(event: string, payload: unknown): void;

  /** Subscribe to an event on the shared event bus. Returns an unsubscribe fn. */
  on(event: string, handler: (payload: unknown) => void): () => void;

  /** Register an OAuth config for this plugin (v2.2 implementation). */
  registerOAuth(config: OAuthConfig): void;
  /** Register an OAuth provider profile (v2.3). */
  registerOAuthProfile(profile: import('@ethosagent/oauth-core').OAuthProviderProfile): void;
  /** Register a custom OAuth flow provider (v2.3). */
  registerCustomOAuthFlow(provider: import('@ethosagent/oauth-core').CustomFlowProvider): void;

  /** Return the host's base URL, if configured. */
  getBaseUrl(): string | undefined;

  /** Register a monitor definition (v2.2). */
  registerMonitor(def: PluginMonitorDef): void;

  /** Start a registered monitor by name. */
  startMonitor(name: string, params?: Record<string, unknown>): void;

  /** Stop a running monitor by name. */
  stopMonitor(name: string): void;

  /** Send a notification through the notification router (v2.2). */
  notify(opts: NotifyOptions): Promise<void>;

  /** Register a health check for this plugin (v2.2 diagnostics). */
  registerHealthCheck(check: PluginHealthCheck): void;

  /** Register a plugin page (v2.3 — plugin UI). */
  registerPluginPage(spec: PluginPageSpec): void;

  /** Register a custom renderer (v2.3 — plugin UI). */
  registerRenderer(spec: PluginRendererSpec): void;

  /** Register a SQLite data source by id and file path. */
  registerDataSource(id: string, path: string): void;

  /** Register a plugin slash command (v3 — dynamic command registration). */
  registerSlashCommand(cmd: {
    name: string;
    description: string;
    usage: string;
    handler: (args: string, ctx: SlashCommandContext) => Promise<string>;
  }): void;

  /** Register a CLI subcommand — plugins can extend `ethos <name>`. */
  registerCliSubcommand(cmd: {
    name: string;
    description: string;
    handler: (ctx: CliSubcommandContext) => Promise<number>;
  }): void;

  /** Register a command via the unified CommandDefinition.
   *  Exactly one of `prompt` or `run` must be set.
   *  - `prompt` → registers as a slash command (prompt-mediated).
   *  - `run` → registers as both a slash command and a CLI subcommand (code handler). */
  registerCommand(def: CommandDefinition): void;

  /** Diagnostics emitter for structured logging and metrics (v2.2). */
  readonly diagnostics: DiagnosticsEmitter;
  /** Register a document extractor for text extraction from uploaded files. */
  registerDocumentExtractor(extractor: import('@ethosagent/types').DocumentExtractor): void;
}

// ---------------------------------------------------------------------------
// PluginRegistries — injected into PluginApiImpl by the loader
// ---------------------------------------------------------------------------

export interface PluginRegistries {
  tools: ToolRegistry;
  hooks: HookRegistry;
  /** Flat injector list shared with AgentLoop. Plugin-registered entries are
   *  also tracked in `injectorPluginIds` so AgentLoop can gate by personality. */
  injectors: ContextInjector[];
  /** Maps each plugin-registered injector to its plugin id.
   *  Built-in injectors are absent from this map (they always fire). */
  injectorPluginIds: Map<ContextInjector, string>;
  personalities: PersonalityRegistry;
  /** E4 — Optional context-engine registry. When present, plugins can
   *  contribute custom engines via `registerContextEngine`. Wiring layers
   *  that don't expose a registry leave this undefined; calls to
   *  `registerContextEngine` then no-op with a clear error. */
  contextEngines?: ContextEngineRegistry;
  /** LLM provider registry. Plugins contribute custom providers via
   *  `registerLLMProvider`. Required in v2 hosts. */
  llmProviders: LLMProviderRegistry;
  /** Memory provider registry. Plugins contribute custom backends via
   *  `registerMemoryProvider`. Required in v2 hosts. */
  memoryProviders: MemoryProviderRegistry;
  storageBackends?: StorageRegistry;
  executionBackends?: ExecutionBackendRegistry;
  /** Platform adapter registry. Maps adapter names to factories. */
  platformAdapters?: Map<string, PlatformAdapterFactory>;
  /** Voice STT provider registry. Plugins contribute providers via
   *  `registerSttProvider`. */
  sttProviders?: SttProviderRegistry;
  /** Voice TTS provider registry. Plugins contribute providers via
   *  `registerTtsProvider`. */
  ttsProviders?: TtsProviderRegistry;
  /** v2 — Tool invocation filters. Plugins register filters that can
   *  approve/deny/modify tool calls before execution. */
  filters?: ToolInvocationFilter[];
  /** v2 — Post-turn evaluators. Plugins register evaluators that run
   *  after the LLM turn to check output quality or trigger follow-ups. */
  evaluators?: PostTurnEvaluator[];
  /** v2 — Plugin-registered HTTP routes. The host serves these. */
  routes?: PluginRouteEntry[];
  /** Called when a plugin registers a new HTTP route. */
  onRouteRegistered?: (entry: PluginRouteEntry) => void;
  /** v2 — Shared event bus for inter-plugin communication. */
  eventBus?: PluginEventBus;
  /** v2 — OAuth coordinator. When present, plugins can register OAuth
   *  configs and the host will drive the auth flow. */
  oauthCoordinator?: OAuthCoordinator;
  /** v2.3 — OAuth provider registry. When present, plugins can register
   *  provider profiles and custom flows. */
  oauthRegistry?: import('@ethosagent/oauth-core').OAuthRegistry;
  /** v2 — Host base URL for building callback URLs, webhook endpoints, etc. */
  baseUrl?: string;
  /** v2.2 — Notification router for monitor → surface delivery. */
  notificationRouter?: NotificationRouter;
  /** v2.2 — Diagnostic event/metric store for plugin health and telemetry. */
  diagnostics?: DiagnosticStore;
  /** v2.2 — Factory for creating SimpleCompletion instances for monitors.
   *  Wiring provides this so monitors can make LLM calls without the plugin-sdk
   *  depending on core. */
  llmFactory?: () => import('@ethosagent/types').SimpleCompletion;
  /** v2.3 — Plugin-registered pages. One page per plugin. */
  pluginPages?: Map<string, PluginPageSpec>;
  /** v2.3 — Plugin-registered renderers. Keyed by renderer type. */
  renderers?: Map<string, PluginRendererSpec>;
  /** pluginId → sourceId → resolvedPath. Populated by registerDataSource calls. */
  dataSources?: Map<string, Map<string, string>>;
  /** v3 — Slash command registry. When present, plugins can register dynamic
   *  commands visible in the CLI and exposed via the web API. */
  slashRegistry?: {
    register(cmd: { name: string; description: string; usage: string; prefix?: string }): void;
    get(name: string): { description?: string; usage?: string } | undefined;
  };
  /** v3 — CLI subcommand registry. When present, plugins can register
   *  subcommands that extend `ethos <name>`. */
  cliSubcommandRegistry?: {
    register(cmd: {
      name: string;
      description: string;
      handler?: (ctx: CliSubcommandContext) => Promise<number>;
      pluginId?: string;
    }): void;
    get(name: string):
      | {
          name: string;
          description: string;
          handler?: (ctx: CliSubcommandContext) => Promise<number>;
          pluginId?: string;
        }
      | undefined;
    getAll(): {
      name: string;
      description: string;
      handler?: (ctx: CliSubcommandContext) => Promise<number>;
      pluginId?: string;
    }[];
  };
  /** v3 -- Document extractor registry. When present, plugins can register
   *  custom extractors for document text extraction. */
  documentExtractors?: import('@ethosagent/types').DocumentExtractorRegistry;
}

// ---------------------------------------------------------------------------
// PluginApiImpl — concrete implementation given to each plugin
// ---------------------------------------------------------------------------

export class PluginApiImpl implements EthosPluginApi {
  readonly pluginId: string;

  private readonly registries: PluginRegistries;
  private readonly registeredTools: string[] = [];
  private readonly registeredLLMProviders: string[] = [];
  private readonly registeredMemoryProviders: string[] = [];
  private readonly registeredStorageBackends: string[] = [];
  private readonly registeredExecutionBackends: string[] = [];
  private readonly registeredPlatformAdapters: string[] = [];
  private readonly registeredSttProviders: string[] = [];
  private readonly registeredTtsProviders: string[] = [];
  private readonly registeredInjectors: ContextInjector[] = [];
  private readonly registeredPersonalities: string[] = [];
  private readonly secrets: SecretsResolver | null;
  private readonly credentialStorage: Storage | null;
  private readonly credentialBasePath: string | null;
  /** Keys known to exist in the vault. Backs the synchronous `hasSecret`. */
  private readonly knownSecretKeys = new Set<string>();
  private readonly credentialUpdateHandlers: Array<(key: string) => void | Promise<void>> = [];
  private readonly registeredFilters: ToolInvocationFilter[] = [];
  private readonly registeredEvaluators: PostTurnEvaluator[] = [];
  private readonly eventUnsubscribers: Array<() => void> = [];
  private readonly monitorRunner = new PluginMonitorRunner();
  private readonly healthChecks: PluginHealthCheck[] = [];
  private registeredRendererTypes: string[] = [];
  private readonly registeredDataSources = new Map<string, string>();
  private readonly slashHandlers = new Map<
    string,
    {
      name: string;
      description: string;
      usage: string;
      handler: (args: string, ctx: SlashCommandContext) => Promise<string>;
    }
  >();
  private readonly cliSubcommandHandlers = new Map<
    string,
    {
      name: string;
      description: string;
      handler: (ctx: CliSubcommandContext) => Promise<number>;
    }
  >();
  private readonly commandDefinitions = new Map<string, CommandDefinition>();
  private oauthConfig?: OAuthConfig;

  constructor(
    pluginId: string,
    registries: PluginRegistries,
    credentialOpts?: PluginCredentialOptions,
  ) {
    this.pluginId = pluginId;
    this.registries = registries;
    this.secrets = credentialOpts?.secrets ?? null;
    this.credentialStorage = credentialOpts?.storage ?? null;
    this.credentialBasePath = credentialOpts?.basePath ?? null;
  }

  registerTool(tool: Tool): void {
    // Tag the tool with this plugin's id so AgentLoop can gate it per personality.
    this.registries.tools.register(tool, { pluginId: this.pluginId });
    this.registeredTools.push(tool.name);
  }

  registerVoidHook<K extends keyof VoidHooks>(
    name: K,
    handler: (payload: VoidHooks[K]) => Promise<void>,
  ): void {
    this.registries.hooks.registerVoid(name, handler, { pluginId: this.pluginId });
  }

  registerModifyingHook<K extends keyof ModifyingHooks>(
    name: K,
    handler: (payload: ModifyingHooks[K][0]) => Promise<Partial<ModifyingHooks[K][1]> | null>,
  ): void {
    this.registries.hooks.registerModifying(name, handler, { pluginId: this.pluginId });
  }

  registerInjector(injector: ContextInjector): void {
    this.registries.injectors.push(injector);
    this.registries.injectorPluginIds.set(injector, this.pluginId);
    this.registeredInjectors.push(injector);
  }

  registerPersonality(config: PersonalityConfig): void {
    this.registries.personalities.define(config);
    this.registeredPersonalities.push(config.id);
  }

  registerContextEngine(engine: ContextEngine): void {
    if (!this.registries.contextEngines) {
      throw new Error(
        `Plugin "${this.pluginId}" called registerContextEngine but the host wiring did not expose a ContextEngineRegistry.`,
      );
    }
    this.registries.contextEngines.register(engine);
  }

  registerLLMProvider(name: string, factory: LLMProviderFactory): void {
    const qualifiedName = name.includes('/') ? name : `${this.pluginId}/${name}`;
    if (name.includes('/') && !name.startsWith(`${this.pluginId}/`)) {
      throw new Error(
        `Plugin "${this.pluginId}" cannot register LLM provider "${name}": ` +
          `namespaced names must start with the plugin id ("${this.pluginId}/").`,
      );
    }
    this.registries.llmProviders.register(qualifiedName, factory);
    this.registeredLLMProviders.push(qualifiedName);
  }

  registerMemoryProvider(name: string, factory: MemoryProviderFactory): void {
    const qualifiedName = name.includes('/') ? name : `${this.pluginId}/${name}`;
    if (name.includes('/') && !name.startsWith(`${this.pluginId}/`)) {
      throw new Error(
        `Plugin "${this.pluginId}" cannot register memory provider "${name}": ` +
          `namespaced names must start with the plugin id ("${this.pluginId}/").`,
      );
    }
    this.registries.memoryProviders.register(qualifiedName, factory);
    this.registeredMemoryProviders.push(qualifiedName);
  }

  registerPlatformAdapter(name: string, factory: PlatformAdapterFactory): void {
    if (!this.registries.platformAdapters) {
      throw new Error(
        `Plugin "${this.pluginId}" called registerPlatformAdapter but the host wiring did not expose an adapter registry.`,
      );
    }
    const qualifiedName = name.includes('/') ? name : `${this.pluginId}/${name}`;
    if (name.includes('/') && !name.startsWith(`${this.pluginId}/`)) {
      throw new Error(
        `Plugin "${this.pluginId}" cannot register platform adapter "${name}": ` +
          `namespaced names must start with the plugin id ("${this.pluginId}/").`,
      );
    }
    this.registries.platformAdapters.set(qualifiedName, factory);
    this.registeredPlatformAdapters.push(qualifiedName);
  }

  registerSttProvider(name: string, factory: SttProviderFactory): void {
    if (!this.registries.sttProviders) {
      throw new Error(
        `Plugin "${this.pluginId}" called registerSttProvider but the host wiring did not expose an SttProviderRegistry.`,
      );
    }
    const qualifiedName = name.includes('/') ? name : `${this.pluginId}/${name}`;
    if (name.includes('/') && !name.startsWith(`${this.pluginId}/`)) {
      throw new Error(
        `Plugin "${this.pluginId}" cannot register STT provider "${name}": ` +
          `namespaced names must start with the plugin id ("${this.pluginId}/").`,
      );
    }
    this.registries.sttProviders.register(qualifiedName, factory);
    this.registeredSttProviders.push(qualifiedName);
  }

  registerTtsProvider(name: string, factory: TtsProviderFactory): void {
    if (!this.registries.ttsProviders) {
      throw new Error(
        `Plugin "${this.pluginId}" called registerTtsProvider but the host wiring did not expose a TtsProviderRegistry.`,
      );
    }
    const qualifiedName = name.includes('/') ? name : `${this.pluginId}/${name}`;
    if (name.includes('/') && !name.startsWith(`${this.pluginId}/`)) {
      throw new Error(
        `Plugin "${this.pluginId}" cannot register TTS provider "${name}": ` +
          `namespaced names must start with the plugin id ("${this.pluginId}/").`,
      );
    }
    this.registries.ttsProviders.register(qualifiedName, factory);
    this.registeredTtsProviders.push(qualifiedName);
  }

  registerStorage(name: string, factory: StorageFactory): void {
    if (!this.registries.storageBackends) {
      throw new Error(
        `Plugin "${this.pluginId}" called registerStorage but the host wiring did not expose a StorageRegistry.`,
      );
    }
    const qualifiedName = name.includes('/') ? name : `${this.pluginId}/${name}`;
    if (name.includes('/') && !name.startsWith(`${this.pluginId}/`)) {
      throw new Error(
        `Plugin "${this.pluginId}" cannot register storage backend "${name}": ` +
          `namespaced names must start with the plugin id ("${this.pluginId}/").`,
      );
    }
    this.registries.storageBackends.register(qualifiedName, factory);
    this.registeredStorageBackends.push(qualifiedName);
  }

  registerExecutionBackend(name: string, factory: ExecutionBackendFactory): void {
    if (!this.registries.executionBackends) {
      throw new Error(
        `Plugin "${this.pluginId}" called registerExecutionBackend but the host wiring did not expose an ExecutionBackendRegistry.`,
      );
    }
    const qualifiedName = name.includes('/') ? name : `${this.pluginId}/${name}`;
    if (name.includes('/') && !name.startsWith(`${this.pluginId}/`)) {
      throw new Error(
        `Plugin "${this.pluginId}" cannot register execution backend "${name}": ` +
          `namespaced names must start with the plugin id ("${this.pluginId}/").`,
      );
    }
    this.registries.executionBackends.register(qualifiedName, factory);
    this.registeredExecutionBackends.push(qualifiedName);
  }

  registerDocumentExtractor(extractor: import('@ethosagent/types').DocumentExtractor): void {
    if (!this.registries.documentExtractors) {
      throw new Error(
        `Plugin "${this.pluginId}" called registerDocumentExtractor but the host wiring did not expose a DocumentExtractorRegistry.`,
      );
    }
    this.registries.documentExtractors.register(extractor);
  }

  // ---- Credential methods ------------------------------------------------
  //
  // Credential VALUES live only in the `SecretsResolver` vault, under
  // `plugins/<pluginId>/<key>` (G-SEC — see ./credentials.ts). The only thing
  // this class still writes to storage is the `<key>.meta` sidecar, which
  // carries an `updatedAt` timestamp and nothing else.

  /** Path of the non-secret metadata sidecar for `key`. */
  private metaPath(key: string): string {
    return `${this.credentialBasePath}/credentials/${key}.meta`;
  }

  /**
   * Load the keys this plugin already has in the vault so the synchronous
   * `hasSecret` can answer without I/O. The host awaits this once, before it
   * hands the api to the plugin — a constructor cannot await, and `hasSecret`
   * is part of the frozen plugin contract, so it cannot become async.
   */
  async primeSecrets(): Promise<void> {
    if (!this.secrets) return;
    const prefix = pluginCredentialPrefix(this.pluginId);
    const refs = await this.secrets.list(prefix);
    this.knownSecretKeys.clear();
    for (const ref of refs) {
      const key = ref.slice(prefix.length);
      if (isValidSecretName(key)) this.knownSecretKeys.add(key);
    }
  }

  /** Drop `key` from the primed set — the host calls this after deleting a
   *  credential out from under a loaded plugin. */
  forgetSecret(key: string): void {
    this.knownSecretKeys.delete(key);
  }

  /**
   * Whether this plugin has `key` in the vault.
   *
   * Answers from the set primed at load plus every `setSecret` since, so it is
   * synchronous. That leaves a staleness window: a credential written by
   * ANOTHER process (the `ethos plugin credentials --set` CLI, or a second
   * daemon) after this plugin loaded reads as absent until the plugin is
   * reloaded. `getSecret` is async and always authoritative — treat a `false`
   * here as "not known to be set", not as proof of absence.
   */
  hasSecret(key: string): boolean {
    return this.knownSecretKeys.has(key);
  }

  async getSecret(key: string): Promise<string | null> {
    if (!this.secrets) return null;
    return this.secrets.get(pluginCredentialRef(this.pluginId, key));
  }

  async setSecret(key: string, value: string): Promise<void> {
    if (!this.secrets || !this.credentialStorage || !this.credentialBasePath) {
      throw new Error(`Plugin "${this.pluginId}" has no credential storage configured`);
    }
    // Throws on a key that is not a plain name — before anything is written,
    // so a traversal-shaped key cannot land somewhere else instead.
    const ref = pluginCredentialRef(this.pluginId, key);
    await this.secrets.set(ref, value);

    const dir = `${this.credentialBasePath}/credentials`;
    await this.credentialStorage.mkdir(dir);
    await this.credentialStorage.writeAtomic(
      this.metaPath(key),
      JSON.stringify({ updatedAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
    // Idempotent dir lockdown, applied on every set so a directory created
    // before this (or by another writer) ends up owner-only too — the listing
    // still reveals WHICH credentials a plugin has. Tolerated to fail on
    // backends with no POSIX permissions.
    await this.credentialStorage.chmod(dir, 0o700).catch(() => {});

    this.knownSecretKeys.add(key);
    await this.fireCredentialUpdate(key);
  }

  onCredentialUpdate(handler: (key: string) => void | Promise<void>): () => void {
    this.credentialUpdateHandlers.push(handler);
    return () => {
      const idx = this.credentialUpdateHandlers.indexOf(handler);
      if (idx >= 0) this.credentialUpdateHandlers.splice(idx, 1);
    };
  }

  private async fireCredentialUpdate(key: string): Promise<void> {
    for (const handler of this.credentialUpdateHandlers) {
      await handler(key);
    }
  }

  // ---- v2 registration methods --------------------------------------------

  registerToolFilter(filter: ToolInvocationFilter): void {
    if (!this.registries.filters) {
      throw new Error(`Plugin "${this.pluginId}": host did not expose a filters registry.`);
    }
    this.registries.filters.push(filter);
    this.registeredFilters.push(filter);
  }

  registerEvaluator(evaluator: PostTurnEvaluator): void {
    if (!this.registries.evaluators) {
      throw new Error(`Plugin "${this.pluginId}": host did not expose an evaluators registry.`);
    }
    this.registries.evaluators.push(evaluator);
    this.registeredEvaluators.push(evaluator);
  }

  registerRoute(opts: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    handler: (req: PluginHttpRequest) => Promise<PluginHttpResponse>;
  }): void {
    if (!this.registries.routes) {
      throw new Error(`Plugin "${this.pluginId}": host did not expose a route registry.`);
    }
    if (!opts.path.startsWith('/')) {
      throw new Error(
        `Plugin "${this.pluginId}": route path must start with "/", got "${opts.path}"`,
      );
    }
    const entry: PluginRouteEntry = {
      pluginId: this.pluginId,
      method: opts.method ?? 'POST',
      path: opts.path,
      handler: opts.handler,
    };
    this.registries.routes.push(entry);
    this.registries.onRouteRegistered?.(entry);
  }

  emit(event: string, payload: unknown): void {
    this.registries.eventBus?.emit(event, payload);
  }

  on(event: string, handler: (payload: unknown) => void): () => void {
    const unsub = this.registries.eventBus?.on(event, handler) ?? (() => {});
    this.eventUnsubscribers.push(unsub);
    return unsub;
  }

  registerOAuth(config: OAuthConfig): void {
    this.oauthConfig = config;
  }

  registerOAuthProfile(profile: import('@ethosagent/oauth-core').OAuthProviderProfile): void {
    if (!this.registries.oauthRegistry) {
      throw new Error(
        `Plugin "${this.pluginId}" called registerOAuthProfile but the host wiring did not expose an OAuthRegistry.`,
      );
    }
    this.registries.oauthRegistry.registerProfile(profile);
  }

  registerCustomOAuthFlow(provider: import('@ethosagent/oauth-core').CustomFlowProvider): void {
    if (!this.registries.oauthRegistry) {
      throw new Error(
        `Plugin "${this.pluginId}" called registerCustomOAuthFlow but the host wiring did not expose an OAuthRegistry.`,
      );
    }
    this.registries.oauthRegistry.registerCustomFlow(provider);
  }

  getBaseUrl(): string | undefined {
    return this.registries.baseUrl;
  }

  // ---- v2.2 monitor + notification methods --------------------------------

  registerMonitor(def: PluginMonitorDef): void {
    this.monitorRunner.registerDef(def);
  }

  startMonitor(name: string, params?: Record<string, unknown>): void {
    const store = new Map<string, string>();
    this.diagnostics.info(
      'Monitor started with ephemeral kvStore — data will not persist across restarts',
      { monitorName: name },
    );
    const llm = this.registries.llmFactory?.();
    this.monitorRunner.start(name, params ?? {}, {
      pluginId: this.pluginId,
      notify: (opts) => this.notify(opts),
      getSecret: (key) => this.getSecret(key),
      kvStore: {
        get: async (k) => store.get(k) ?? null,
        set: async (k, v) => {
          store.set(k, v);
        },
        delete: async (k) => {
          store.delete(k);
        },
        list: async (prefix) => [...store.keys()].filter((k) => k.startsWith(prefix)),
      },
      emit: (event, payload) => this.emit(event, payload),
      diagnostics: this.diagnostics,
      llm,
    });
  }

  stopMonitor(name: string): void {
    this.monitorRunner.stop(name);
  }

  async notify(opts: NotifyOptions): Promise<void> {
    if (!this.registries.notificationRouter) {
      this.diagnostics.warn(
        'notify() called but no NotificationRouter is configured — message dropped',
        { sessionKey: opts.sessionKey },
      );
      return;
    }
    await this.registries.notificationRouter.route(this.pluginId, opts);
  }

  // ---- v2.2 diagnostics methods --------------------------------------------

  readonly diagnostics: DiagnosticsEmitter = {
    debug: (message, data) => {
      this.registries.diagnostics?.pushEvent({
        pluginId: this.pluginId,
        level: 'debug',
        message,
        timestamp: new Date().toISOString(),
        data,
      });
    },
    info: (message, data) => {
      this.registries.diagnostics?.pushEvent({
        pluginId: this.pluginId,
        level: 'info',
        message,
        timestamp: new Date().toISOString(),
        data,
      });
    },
    warn: (message, data) => {
      this.registries.diagnostics?.pushEvent({
        pluginId: this.pluginId,
        level: 'warn',
        message,
        timestamp: new Date().toISOString(),
        data,
      });
    },
    error: (message, data) => {
      this.registries.diagnostics?.pushEvent({
        pluginId: this.pluginId,
        level: 'error',
        message,
        timestamp: new Date().toISOString(),
        data,
      });
    },
    metric: (name, value, labels) => {
      this.registries.diagnostics?.pushMetric({
        pluginId: this.pluginId,
        name,
        value,
        labels,
        timestamp: new Date().toISOString(),
      });
    },
  };

  registerHealthCheck(check: PluginHealthCheck): void {
    this.healthChecks.push(check);
  }

  registerPluginPage(spec: PluginPageSpec): void {
    if (!this.registries.pluginPages) {
      this.registries.pluginPages = new Map();
    }
    this.registries.pluginPages.set(this.pluginId, spec);
  }

  registerRenderer(spec: PluginRendererSpec): void {
    if (!this.registries.renderers) {
      this.registries.renderers = new Map();
    }
    const existing = this.registries.renderers.get(spec.type);
    if (existing && !this.registeredRendererTypes.includes(spec.type)) {
      throw new Error(
        `Plugin "${this.pluginId}" cannot register renderer type "${spec.type}": already registered by another plugin.`,
      );
    }
    this.registries.renderers.set(spec.type, spec);
    if (!this.registeredRendererTypes.includes(spec.type)) {
      this.registeredRendererTypes.push(spec.type);
    }
  }

  registerDataSource(id: string, path: string): void {
    this.registeredDataSources.set(id, path);
    if (!this.registries.dataSources) {
      this.registries.dataSources = new Map();
    }
    if (!this.registries.dataSources.has(this.pluginId)) {
      this.registries.dataSources.set(this.pluginId, new Map());
    }
    this.registries.dataSources.get(this.pluginId)?.set(id, path);
  }

  registerSlashCommand(cmd: {
    name: string;
    description: string;
    usage: string;
    handler: (args: string, ctx: SlashCommandContext) => Promise<string>;
  }): void {
    const lower = cmd.name.toLowerCase();
    const namespacedName = `${this.pluginId}:${lower}`;
    this.slashHandlers.set(lower, { ...cmd, name: lower });
    this.registries.slashRegistry?.register({
      name: namespacedName,
      description: cmd.description,
      usage: cmd.usage,
      prefix: `[plugin:${this.pluginId}]`,
    });
  }

  getSlashHandler(
    name: string,
  ): ((args: string, ctx: SlashCommandContext) => Promise<string>) | undefined {
    const lower = name.toLowerCase();
    const handler = this.slashHandlers.get(lower);
    if (handler) return handler.handler;
    const colonIdx = lower.indexOf(':');
    if (colonIdx >= 0) {
      return this.slashHandlers.get(lower.slice(colonIdx + 1))?.handler;
    }
    return undefined;
  }

  getAllSlashCommands(): { name: string; description: string; usage: string }[] {
    return [...this.slashHandlers.values()].map(({ name, description, usage }) => ({
      name,
      description,
      usage,
    }));
  }

  registerCliSubcommand(cmd: {
    name: string;
    description: string;
    handler: (ctx: CliSubcommandContext) => Promise<number>;
  }): void {
    const lower = cmd.name.toLowerCase();
    const namespacedName = `${this.pluginId}:${lower}`;
    this.cliSubcommandHandlers.set(lower, { ...cmd, name: lower });
    this.registries.cliSubcommandRegistry?.register({
      name: namespacedName,
      description: cmd.description,
      handler: cmd.handler,
      pluginId: this.pluginId,
    });
  }

  getCliSubcommandHandler(
    name: string,
  ): ((ctx: CliSubcommandContext) => Promise<number>) | undefined {
    const lower = name.toLowerCase();
    const handler = this.cliSubcommandHandlers.get(lower);
    if (handler) return handler.handler;
    const colonIdx = lower.indexOf(':');
    if (colonIdx >= 0) {
      return this.cliSubcommandHandlers.get(lower.slice(colonIdx + 1))?.handler;
    }
    return undefined;
  }

  getAllCliSubcommands(): { name: string; description: string }[] {
    return [...this.cliSubcommandHandlers.values()].map(({ name, description }) => ({
      name,
      description,
    }));
  }

  registerCommand(def: CommandDefinition): void {
    const hasPrompt = typeof def.prompt === 'string';
    const hasRun = typeof def.run === 'function';
    if (hasPrompt === hasRun) {
      throw new Error(`CommandDefinition "${def.name}" must have exactly one of prompt or run`);
    }

    this.commandDefinitions.set(def.name.toLowerCase(), def);

    if (hasPrompt) {
      // Prompt-mediated → slash command only
      this.registerSlashCommand({
        name: def.name,
        description: def.description,
        usage: def.argumentHint ? `/${def.name} ${def.argumentHint}` : `/${def.name}`,
        handler: async (args) => {
          // Substitute $ARGUMENTS in the prompt
          let body = def.prompt ?? '';
          body = body.replace(/\$ARGUMENTS/g, args);
          const parts = args.split(/\s+/).filter(Boolean);
          for (let i = 0; i < parts.length; i++) {
            body = body.replace(new RegExp(`\\$${i + 1}`, 'g'), parts[i] ?? '');
          }
          return body;
        },
      });
    } else {
      // Code handler → slash + CLI
      const run = def.run;
      if (!run) return;

      this.registerSlashCommand({
        name: def.name,
        description: def.description,
        usage: def.argumentHint ? `/${def.name} ${def.argumentHint}` : `/${def.name}`,
        handler: async (args, ctx) => {
          const parts = args.split(/\s+/).filter(Boolean);
          const named: Record<string, string> = {};
          const positional: string[] = [];
          for (const part of parts) {
            if (part.startsWith('--') && part.includes('=')) {
              const eqIdx = part.indexOf('=');
              named[part.slice(2, eqIdx)] = part.slice(eqIdx + 1);
            } else {
              positional.push(part);
            }
          }
          const result = await run({
            args: { raw: args, positional, named },
            personalityId: ctx.personalityId,
            sessionId: ctx.sessionId,
            emit: (text) => {
              ctx.send(text);
            },
            storage: ctx.storage,
            tools: ctx.toolRegistry,
          });
          return result.output ?? '';
        },
      });

      this.registerCliSubcommand({
        name: def.name,
        description: def.description,
        handler: async (ctx) => {
          const named: Record<string, string> = {};
          const positional: string[] = [];
          for (const arg of ctx.argv) {
            if (arg.startsWith('--') && arg.includes('=')) {
              const eqIdx = arg.indexOf('=');
              named[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
            } else {
              positional.push(arg);
            }
          }
          const result = await run({
            args: { raw: ctx.argv.join(' '), positional, named },
            sessionId: '',
            emit: (text) => {
              ctx.stdout(text);
            },
            storage: ctx.storage,
          });
          return result.exitCode;
        },
      });
    }
  }

  getCommandDefinitions(): CommandDefinition[] {
    return [...this.commandDefinitions.values()];
  }

  getHealthChecks(): PluginHealthCheck[] {
    return this.healthChecks;
  }

  /** v2.2 — Return names of monitors that have crashed. */
  getCrashedMonitors(): string[] {
    return this.monitorRunner.getCrashedMonitors();
  }

  /** Internal — used by AgentLoop for pre-turn credential check. */
  getOAuthConfig(): OAuthConfig | undefined {
    return this.oauthConfig;
  }

  /** Remove everything this plugin registered. Called by PluginLoader.unload(). */
  cleanup(): void {
    // v3 — Slash commands
    this.slashHandlers.clear();
    this.cliSubcommandHandlers.clear();

    // Monitors
    this.monitorRunner.stopAll();

    // Hooks — HookRegistry tracks by pluginId
    this.registries.hooks.unregisterPlugin(this.pluginId);

    // Tools — remove by name
    for (const name of this.registeredTools) {
      this.registries.tools.unregister(name);
    }

    // LLM providers
    for (const name of this.registeredLLMProviders) {
      this.registries.llmProviders.unregister(name);
    }

    // Memory providers
    for (const name of this.registeredMemoryProviders) {
      this.registries.memoryProviders.unregister(name);
    }

    // Storage backends
    for (const name of this.registeredStorageBackends) {
      this.registries.storageBackends?.unregister(name);
    }

    // Execution backends
    for (const name of this.registeredExecutionBackends) {
      this.registries.executionBackends?.unregister(name);
    }

    // Platform adapters (bare Map)
    for (const name of this.registeredPlatformAdapters) {
      this.registries.platformAdapters?.delete(name);
    }

    // STT providers
    for (const name of this.registeredSttProviders) {
      this.registries.sttProviders?.unregister(name);
    }

    // TTS providers (voice)
    for (const name of this.registeredTtsProviders) {
      this.registries.ttsProviders?.unregister(name);
    }

    // Injectors — remove from the shared mutable array + provenance map
    for (const inj of this.registeredInjectors) {
      const idx = this.registries.injectors.indexOf(inj);
      if (idx >= 0) this.registries.injectors.splice(idx, 1);
      this.registries.injectorPluginIds.delete(inj);
    }

    // Personalities — no unregister method; they stay (harmless)

    // Credential update handlers
    this.credentialUpdateHandlers.length = 0;

    // v2 — Filters
    for (const f of this.registeredFilters) {
      const idx = this.registries.filters?.indexOf(f) ?? -1;
      if (idx >= 0) this.registries.filters?.splice(idx, 1);
    }

    // v2 — Evaluators
    for (const e of this.registeredEvaluators) {
      const idx = this.registries.evaluators?.indexOf(e) ?? -1;
      if (idx >= 0) this.registries.evaluators?.splice(idx, 1);
    }

    // v2 — Routes
    if (this.registries.routes) {
      const keep = this.registries.routes.filter((r) => r.pluginId !== this.pluginId);
      this.registries.routes.length = 0;
      this.registries.routes.push(...keep);
    }

    // v2 — Event bus subscriptions
    for (const unsub of this.eventUnsubscribers) unsub();
    this.eventUnsubscribers.length = 0;

    // OAuth
    this.registries.oauthCoordinator?.cancelAll(this.pluginId);

    // Diagnostics
    this.registries.diagnostics?.clearPlugin(this.pluginId);
    this.healthChecks.length = 0;

    // v2.3 — Plugin pages
    this.registries.pluginPages?.delete(this.pluginId);

    // v2.3 — Renderers
    for (const type of this.registeredRendererTypes) {
      this.registries.renderers?.delete(type);
    }
    this.registeredRendererTypes.length = 0;

    // Data sources
    this.registries.dataSources?.delete(this.pluginId);
    this.registeredDataSources.clear();
  }
}

// ---------------------------------------------------------------------------
// Re-export commonly needed types for plugin authors
// ---------------------------------------------------------------------------

export type {
  CliSubcommandContext,
  CommandContext,
  CommandDefinition,
  ContextInjector,
  DiagnosticsEmitter,
  ExecutionBackendFactory,
  ExecutionBackendRegistry,
  InjectionResult,
  LLMProviderFactory,
  LLMProviderFactoryContext,
  MemoryProviderFactory,
  MemoryProviderFactoryContext,
  ModifyingHooks,
  NotifyOptions,
  OAuthConfig,
  PersonalityConfig,
  PluginHealthCheck,
  PluginMonitorDef,
  PluginPageSpec,
  PluginRendererSpec,
  PostTurnEvaluator,
  PostTurnEvaluatorPayload,
  PromptContext,
  SlashCommandContext,
  Storage,
  StorageFactory,
  StorageRegistry,
  SttProviderFactory,
  SttProviderRegistry,
  Tool,
  ToolContext,
  ToolInvocationFilter,
  ToolResult,
  TtsProviderFactory,
  TtsProviderRegistry,
  VoiceCapabilities,
  VoiceProviderFactoryContext,
  VoidHooks,
} from '@ethosagent/types';
export { ContextStore } from './context-registry';
export {
  type LegacyCredentialMigrationOptions,
  migrateLegacyPluginCredentials,
  pluginCredentialPrefix,
  pluginCredentialRef,
} from './credentials';
export { DiagnosticStore } from './diagnostic-store';
export { LocalOAuthServer } from './local-oauth-server';
export { OAuthCoordinatorImpl } from './oauth-coordinator';
