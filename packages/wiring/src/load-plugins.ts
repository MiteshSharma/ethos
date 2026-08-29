import { join } from 'node:path';
import { DefaultNotificationRouter } from '@ethosagent/core';
import { DefaultOAuthRegistry } from '@ethosagent/oauth';
import { type InstalledPluginManifest, PluginLoader } from '@ethosagent/plugin-loader';
import {
  DiagnosticStore,
  OAuthCoordinatorImpl,
  PluginEventBus,
  type PluginRouteEntry,
} from '@ethosagent/plugin-sdk';
import { UniversalScanner } from '@ethosagent/skills';
import { FsStorage } from '@ethosagent/storage-fs';
import type {
  ContextEngineLLMHandle,
  ContextInjector,
  HookRegistry,
  LLMProviderRegistry,
  MemoryProviderRegistry,
  PersonalityConfig,
  PostTurnEvaluator,
  Skill,
  ToolInvocationFilter,
  ToolRegistry,
} from '@ethosagent/types';
import type { InfrastructureResult } from './build-infrastructure';
import type { CreateAgentLoopOptions, WiringConfig, WiringSlashRegistry } from './index';
import type { WiringContext } from './types';

export interface LoadPluginsResult {
  pluginLoader: PluginLoader;
  pluginRegistries: import('@ethosagent/plugin-sdk').PluginRegistries;
  notificationRouter: DefaultNotificationRouter;
  pluginDiagnostics: DiagnosticStore;
  injectorPluginIds: Map<ContextInjector, string>;
  pluginFilters: ToolInvocationFilter[];
  pluginEvaluators: PostTurnEvaluator[];
  pluginRoutes: PluginRouteEntry[];
  /** P2.6/S7 — plugins that failed to load (rejected/missing dep/activate threw), with reasons. */
  pluginFailures: InstalledPluginManifest[];
  contextEngines: import('@ethosagent/core').DefaultContextEngineRegistry;
  /** LLM handle for context engines — wraps the compression summarizer. */
  llmHandle?: ContextEngineLLMHandle;
  documentExtractors: import('@ethosagent/core').DefaultDocumentExtractorRegistry;
}

export interface LoadPluginsDeps {
  tools: ToolRegistry;
  hooks: HookRegistry;
  injectors: ContextInjector[];
  personalities: InfrastructureResult['personalities'];
  llmProviders: LLMProviderRegistry;
  memoryProviders: MemoryProviderRegistry;
  storageBackends?: import('@ethosagent/types').StorageRegistry;
  executionBackends?: import('@ethosagent/types').ExecutionBackendRegistry;
  sttProviders?: import('@ethosagent/types').SttProviderRegistry;
  ttsProviders?: import('@ethosagent/types').TtsProviderRegistry;
  activePerson: PersonalityConfig;
  skillScanner: UniversalScanner;
  skillPool: Map<string, Skill>;
  buildCompressionSummarizer: () => import('@ethosagent/core').SummarizerFn | undefined;
  slashRegistry?: WiringSlashRegistry;
  cliSubcommandRegistry?: import('@ethosagent/plugin-sdk').PluginRegistries['cliSubcommandRegistry'];
}

/**
 * Set up the context-engine registry and load all plugins into their registries.
 * Also merges plugin-contributed skill sources into the live scanner and skill pool.
 */
export async function loadPlugins(
  wiringCtx: WiringContext,
  config: WiringConfig,
  _opts: CreateAgentLoopOptions,
  deps: LoadPluginsDeps,
): Promise<LoadPluginsResult> {
  const { dataDir, log } = wiringCtx;
  const {
    tools,
    hooks,
    injectors,
    personalities,
    llmProviders,
    memoryProviders,
    activePerson,
    skillScanner,
    skillPool,
    buildCompressionSummarizer,
  } = deps;

  // E4 — context-engine registry. Built-ins register at construction; the
  // PluginLoader exposes it so plugins can contribute custom engines via
  // `EthosPluginApi.registerContextEngine`. context_compression F1 — when an
  // auxiliary compression model is configured, `semantic_summary` gets a real
  // LLM summarizer instead of the placeholder.
  const { DefaultContextEngineRegistry, DefaultDocumentExtractorRegistry } = await import(
    '@ethosagent/core'
  );
  const summarize = buildCompressionSummarizer();
  const contextEngines = new DefaultContextEngineRegistry(summarize ? { summarize } : {});
  const documentExtractors = new DefaultDocumentExtractorRegistry();

  // Discover and activate installed plugins. Plugins register tools/hooks/
  // injectors into the same registries the AgentLoop uses; the personality
  // gate (allowedPlugins) decides which actually fire per turn.
  const injectorPluginIds = new Map<ContextInjector, string>();
  const pluginFilters: ToolInvocationFilter[] = [];
  const pluginEvaluators: PostTurnEvaluator[] = [];
  const pluginRoutes: PluginRouteEntry[] = [];
  const pluginEventBus = new PluginEventBus();
  const oauthCoordinator = new OAuthCoordinatorImpl();
  const notificationRouter = new DefaultNotificationRouter();
  const pluginDiagnostics = new DiagnosticStore();
  const pluginRegistries: import('@ethosagent/plugin-sdk').PluginRegistries = {
    tools,
    hooks,
    injectors,
    injectorPluginIds,
    personalities,
    contextEngines,
    llmProviders,
    memoryProviders,
    storageBackends: deps.storageBackends,
    executionBackends: deps.executionBackends,
    sttProviders: deps.sttProviders,
    ttsProviders: deps.ttsProviders,
    filters: pluginFilters,
    evaluators: pluginEvaluators,
    routes: pluginRoutes,
    eventBus: pluginEventBus,
    oauthCoordinator,
    oauthRegistry: new DefaultOAuthRegistry(),
    notificationRouter,
    diagnostics: pluginDiagnostics,
    // v2.2 — baseUrl provided by host at runtime (Desktop/Web-API set this;
    // CLI doesn't). Plugins read it via api.getBaseUrl() for OAuth callbacks
    // and webhook endpoints.
    baseUrl: config.baseUrl,
    platformAdapters: new Map(),
    pluginPages: new Map(),
    renderers: new Map(),
    slashRegistry: deps.slashRegistry,
    cliSubcommandRegistry: deps.cliSubcommandRegistry,
    documentExtractors,
    // v2.2 — llmFactory is set after LLM resolution (below). Monitors only
    // start after full wiring, so lazy assignment is safe.
  };
  const pluginLoader = new PluginLoader(pluginRegistries, {
    storage: new FsStorage(),
    logger: log,
    // G-SEC — plugin credentials go through the same vault as every other
    // secret. Injected rather than left to the loader's default so a host that
    // built a resolver chain (file + env + AWS) resolves plugin credentials
    // through it too.
    secrets: config.secretsResolver,
  });
  await pluginLoader.loadAll();

  if (activePerson.plugins?.length) {
    const personalityDir = join(dataDir, 'personalities', activePerson.id);
    await pluginLoader.resolveFromLockfile(personalityDir, activePerson.plugins, {
      autoInstall: config.pluginsAutoInstall ?? true,
    });
  }

  // P2.6/S7 — surface per-plugin load failures to the operator. A plugin rejected
  // for a bad/undeclared contract major, a missing dependency, or an activate()
  // that threw is tracked as failed by the loader; escalate each here so a buried
  // failure is visible. Isolation holds — the sibling plugins that loaded are
  // unaffected; this only reports.
  const pluginFailures = pluginLoader.getFailures();
  for (const failure of pluginFailures) {
    log.warn(
      `[wiring] Plugin "${failure.id}" failed to load: ${failure.error ?? 'unknown error'}`,
      {
        component: 'wiring',
        pluginId: failure.id,
      },
    );
  }

  // Merge skill dirs declared by plugins/tools into the live injector scanner
  // and the boot-time skill pool (for MCP passthrough + design tools).
  const pluginSkillSources = pluginLoader.getPluginSkillSources();
  if (pluginSkillSources.length > 0) {
    skillScanner.addExtraSources(pluginSkillSources);
    const pluginSkillPool = await new UniversalScanner({
      storage: wiringCtx.storage,
      sources: pluginSkillSources,
    }).scan();
    for (const [k, v] of pluginSkillPool) skillPool.set(k, v);
  }

  // Build the ContextEngineLLMHandle from the compression summarizer so the
  // AgentLoop can thread it to engines via CompactInput.llm.
  const llmHandle: ContextEngineLLMHandle | undefined = summarize ? { summarize } : undefined;

  return {
    pluginLoader,
    pluginRegistries,
    notificationRouter,
    pluginDiagnostics,
    injectorPluginIds,
    pluginFilters,
    pluginEvaluators,
    pluginRoutes,
    pluginFailures,
    contextEngines,
    llmHandle,
    documentExtractors,
  };
}
