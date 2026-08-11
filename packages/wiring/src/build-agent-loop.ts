import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { backgroundDefaults } from '@ethosagent/config';
import {
  AgentLoop,
  EagerPrefetchPolicy,
  parseSmallWindowToolset,
  SimpleCompletionImpl,
} from '@ethosagent/core';
import { registerBuiltinExtractors } from '@ethosagent/document-extractors';
import { GoalRunner } from '@ethosagent/goal-runner';
import { BackgroundExecutor } from '@ethosagent/job-runner';
import { SQLiteJobStore } from '@ethosagent/job-store';
import { PendingMemoryStore, TombstoneStore } from '@ethosagent/memory-approval';
import {
  type ConsolidateFn,
  MemoryCaptureRunner,
  type ProposeFn,
} from '@ethosagent/memory-capture';
import { withHistory } from '@ethosagent/memory-history';
import { buildConsolidationUpdates, consolidateMemory } from '@ethosagent/nightly-loop';
import { sanitize } from '@ethosagent/safety-injection';
import { FsStorage } from '@ethosagent/storage-fs';
import {
  type BackgroundToolDeps,
  createDelegationTools,
  MeshProxyReconciler,
} from '@ethosagent/tools-delegation';
import { createMemoryTools } from '@ethosagent/tools-memory';
import { createVisionTools } from '@ethosagent/tools-vision';
import { createWebTools } from '@ethosagent/tools-web';
import type {
  LLMProvider,
  MemoryContext,
  MemoryProvider,
  RequestDumpStore,
} from '@ethosagent/types';
import type { InfrastructureResult } from './build-infrastructure';
import type { ComposeToolsResult, GatewaySendRef } from './compose-tools';
import type {
  CreateAgentLoopOptions,
  CreateAgentLoopResult,
  WiringConfig,
  WiringProfile,
} from './index';
import type { LoadPluginsResult } from './load-plugins';
import { detectLocalRuntime } from './local-models';
import { createUndecoratedBackend } from './memory-backend';
import {
  lookupProfile,
  mergeModelProfile,
  resolveCompactionGate,
  resolveDefaultContextEngine,
  resolveSmallWindowMode,
  scaleHistoryLimit,
} from './model-catalog';
import {
  evaluateContextFit,
  evaluateToolPayloadGuard,
  evaluateToolSchemaBudget,
  measureStaticFloor,
  RESULT_BUDGET_CEILING_CHARS,
  resolveResultBudgetGate,
} from './static-floor';
import { evaluateTierMismatch } from './tier-diagnostics';
import type { WiringContext } from './types';
import { buildVoiceStack } from './voice-stack';

export interface BuildAgentLoopDeps {
  infra: InfrastructureResult;
  toolsResult: ComposeToolsResult;
  pluginsResult: LoadPluginsResult;
  llm: LLMProvider;
  profile: WiringProfile;
}

/**
 * Final assembly phase: resolve memory, wire vision tools, wire the improvement
 * fork and safety subsystems, construct AgentLoop, register delegation tools,
 * validate tool capabilities, and return the CreateAgentLoopResult.
 */
export async function buildAgentLoop(
  wiringCtx: WiringContext,
  config: WiringConfig,
  opts: CreateAgentLoopOptions,
  deps: BuildAgentLoopDeps,
): Promise<CreateAgentLoopResult> {
  const { dataDir, log } = wiringCtx;
  const { infra, toolsResult, pluginsResult, llm, profile } = deps;
  const { memoryProviders, personalities, hooks, sessionCompose, tools } = infra;
  const { gatewaySendRef, goalStore, goalRunnerRef, injectors, mcpManager, skillsInjector } =
    toolsResult;
  const {
    pluginLoader,
    pluginRegistries,
    pluginDiagnostics,
    injectorPluginIds,
    contextEngines,
    notificationRouter,
    llmHandle,
    documentExtractors,
  } = pluginsResult;

  const NOOP_SECRETS = {
    get: async () => null as null,
    set: async () => {},
    delete: async () => {},
    list: async () => [] as string[],
  };

  // -------------------------------------------------------------------------
  // Wire llmFactory now that the LLM provider is resolved.
  // -------------------------------------------------------------------------

  pluginRegistries.llmFactory = () =>
    new SimpleCompletionImpl(llm, config.model, ({ input, output }) => {
      pluginDiagnostics.pushMetric({
        pluginId: 'framework',
        name: 'monitor_llm_usage',
        value: output,
        labels: { type: 'output_tokens', input_tokens: String(input) },
        timestamp: new Date().toISOString(),
      });
    });

  // -------------------------------------------------------------------------
  // Memory provider
  // -------------------------------------------------------------------------

  const session = sessionCompose.sessionStore;
  const memoryName = config.memory ?? 'markdown';
  const memoryFactory = memoryProviders.get(memoryName);
  if (!memoryFactory) {
    throw new Error(
      `Memory provider "${memoryName}" is not registered. ` +
        `Available: ${memoryProviders.list().join(', ')}`,
    );
  }
  const memory = new EagerPrefetchPolicy(
    await memoryFactory({
      config: {},
      dataDir,
      secrets: config.secretsResolver ?? NOOP_SECRETS,
      logger: log,
    }),
  );
  for (const tool of createMemoryTools(memory, session)) tools.register(tool);

  // -------------------------------------------------------------------------
  // Vision tools (registered here because they need `llm`)
  // -------------------------------------------------------------------------

  const auxVisionConfig = config.auxiliaryVision;
  const auxVisionCollidesWithPrimary =
    auxVisionConfig !== undefined && auxVisionConfig.model === config.model;
  if (
    auxVisionConfig &&
    auxVisionCollidesWithPrimary &&
    (auxVisionConfig.provider !== undefined ||
      auxVisionConfig.apiKey !== undefined ||
      auxVisionConfig.baseUrl !== undefined)
  ) {
    log.warn(
      `auxiliary.vision.model ("${auxVisionConfig.model}") matches the primary model; ` +
        'auxiliary.vision.provider/apiKey/baseUrl overrides will be ignored. ' +
        'Either change the model id or drop the overrides.',
    );
  }
  let auxVisionProvider: LLMProvider | null = null;
  if (auxVisionConfig && !auxVisionCollidesWithPrimary) {
    const auxProviderName = auxVisionConfig.provider ?? config.provider;
    const auxFactory = infra.llmProviders.get(auxProviderName);
    if (auxFactory) {
      auxVisionProvider = await auxFactory({
        config: {
          provider: auxProviderName,
          model: auxVisionConfig.model,
          apiKey: auxVisionConfig.apiKey ?? config.apiKey,
          ...((auxVisionConfig.baseUrl ?? config.baseUrl)
            ? { baseUrl: auxVisionConfig.baseUrl ?? config.baseUrl }
            : {}),
          ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
        },
        secrets: config.secretsResolver ?? NOOP_SECRETS,
        logger: log,
      });
    } else {
      log.warn(
        `auxiliary.vision provider "${auxProviderName}" not registered; ` +
          `vision_analyze won't use auxiliary model`,
      );
    }
  }
  for (const tool of createVisionTools({
    resolveProvider: (model) => {
      if (model === config.model) return llm;
      if (auxVisionProvider && auxVisionConfig && model === auxVisionConfig.model) {
        return auxVisionProvider;
      }
      return null;
    },
    defaultModel: config.model,
    ...(auxVisionConfig && !auxVisionCollidesWithPrimary
      ? { auxiliaryVisionModel: auxVisionConfig.model }
      : {}),
  })) {
    tools.register(tool);
  }

  // -------------------------------------------------------------------------
  // Web tools (registered here because web_extract summarization needs `llm`)
  // -------------------------------------------------------------------------
  const auxWebConfig = config.auxiliaryWeb;
  let auxWebProvider: LLMProvider | null = null;
  if (auxWebConfig && auxWebConfig.model !== config.model) {
    const auxProviderName = auxWebConfig.provider ?? config.provider;
    const auxFactory = infra.llmProviders.get(auxProviderName);
    if (auxFactory) {
      auxWebProvider = await auxFactory({
        config: {
          provider: auxProviderName,
          model: auxWebConfig.model,
          apiKey: auxWebConfig.apiKey ?? config.apiKey,
          ...((auxWebConfig.baseUrl ?? config.baseUrl)
            ? { baseUrl: auxWebConfig.baseUrl ?? config.baseUrl }
            : {}),
          ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
        },
        secrets: config.secretsResolver ?? NOOP_SECRETS,
        logger: log,
      });
    } else {
      log.warn(
        `auxiliary.web provider "${auxProviderName}" not registered; web_extract won't summarize`,
      );
    }
  }
  for (const tool of createWebTools({
    ...(config.webSearchBackend ? { searchBackend: config.webSearchBackend } : {}),
    // Personality tools.yaml is the source of truth; config.toolSettings is
    // the global fallback layer. The tool resolves both by ctx.personalityId.
    resolvePersonalitySetting: (personalityId) =>
      personalities.getToolsConfig(personalityId)?.web_search,
    ...(config.toolSettings ? { toolSettings: config.toolSettings } : {}),
    ...(auxWebConfig ? { auxModel: auxWebConfig.model } : {}),
    resolveProvider: (model) => {
      if (model === config.model) return llm;
      if (auxWebProvider && auxWebConfig && model === auxWebConfig.model) return auxWebProvider;
      return null;
    },
  })) {
    tools.register(tool);
  }

  // -------------------------------------------------------------------------
  // Ch.6a — In-process watcher
  // -------------------------------------------------------------------------

  const { Watcher: WatcherClass, defaultRules: watcherDefaultRules } = await import(
    '@ethosagent/safety-watcher'
  );
  const watcher = new WatcherClass({
    rules: watcherDefaultRules(),
    ...(opts.observability ? { observability: opts.observability } : {}),
  });

  // -------------------------------------------------------------------------
  // Ch.3c Tier-2 — LLM injection classifier
  // -------------------------------------------------------------------------

  const { createLLMClassifier } = await import('@ethosagent/safety-injection');
  const injectionClassifier = createLLMClassifier({ llm });

  // -------------------------------------------------------------------------
  // Phase 2 — Build the AgentSafety bundle for core's injected safety path.
  // -------------------------------------------------------------------------

  const {
    INJECTION_DEFENSE_PRELUDE: prelude,
    INJECTION_DEFENSE_PRELUDE_COMPACT: preludeCompact,
    DOWNGRADE_REJECTION_MESSAGE: downgradeRejectionMessage,
    sanitize: sanitizeFn,
    wrapUntrusted: wrapUntrustedFn,
    shortPatternCheck: shortPatternCheckFn,
    c2PatternCheck: c2PatternCheckFn,
    resolveDowngradedTools: resolveDowngradedToolsFn,
  } = await import('@ethosagent/safety-injection');
  const {
    redactPii: redactPiiFn,
    redactString: redactStringFn,
    detectSecrets: detectSecretsFn,
  } = await import('@ethosagent/safety-redact');
  const { ScopedStorage: ScopedStorageCls, defaultAlwaysDeny: defaultAlwaysDenyFn } = await import(
    '@ethosagent/storage-fs'
  );

  const safety: import('@ethosagent/types').AgentSafety = {
    injection: {
      prelude,
      preludeCompact,
      downgradeRejectionMessage,
      sanitize: sanitizeFn,
      wrapUntrusted: wrapUntrustedFn,
      shortPatternCheck: shortPatternCheckFn,
      c2PatternCheck: c2PatternCheckFn,
      resolveDowngradedTools: resolveDowngradedToolsFn,
      classifier: injectionClassifier,
    },
    redaction: {
      redactPii: redactPiiFn,
      redactString: redactStringFn,
      detectSecrets: detectSecretsFn,
    },
    scopedStorageFactory: (base, scope) =>
      new ScopedStorageCls(base, { ...scope, alwaysDeny: defaultAlwaysDenyFn() }),
    watcher,
  };

  // -------------------------------------------------------------------------
  // E3 — improvement fork
  // -------------------------------------------------------------------------

  let onSkillProposedFn: ((skillId: string, personalityId: string) => void) | undefined;
  let onSkillAppliedFn: ((skillId: string, personalityId: string) => void) | undefined;

  const { ImprovementFork, loadEvolveConfig: loadEvolveConfigFn } = await import(
    '@ethosagent/skill-evolver'
  );
  const evolveConfigPath = join(dataDir, 'evolve-config.json');
  const wiringStorage = new FsStorage();
  const improvementFork = new ImprovementFork({
    hooks,
    runtime: {
      llm,
      model: config.model,
      memoryProvider: memory,
      sessionStore: session,
      safety,
    },
    personalities,
    dataDir,
    storage: wiringStorage,
    onSkillProposed: (skillId, personalityId) => {
      onSkillProposedFn?.(skillId, personalityId);
    },
    autoApprove: () => {
      return autoApproveCache;
    },
    onSkillApplied: (skillId, personalityId) => {
      onSkillAppliedFn?.(skillId, personalityId);
    },
  });
  improvementFork.register();

  let autoApproveCache = false;
  (async () => {
    try {
      const cfg = await loadEvolveConfigFn(evolveConfigPath, wiringStorage);
      autoApproveCache = cfg.autoApprove;
    } catch {
      // Non-fatal — keep the default.
    }
  })();

  hooks.registerVoid('agent_done', async () => {
    try {
      const cfg = await loadEvolveConfigFn(evolveConfigPath, wiringStorage);
      autoApproveCache = cfg.autoApprove;
    } catch {
      // Non-fatal.
    }
  });

  // -------------------------------------------------------------------------
  // Gap 10 — process_complete notification via notificationRouter
  // -------------------------------------------------------------------------

  hooks.registerVoid('process_complete', async (event) => {
    const elapsed = `${Math.round(event.durationMs / 1000)}s`;
    const summary =
      event.exitCode === 0
        ? `Process \`${event.processId}\` complete (${elapsed})`
        : `Process \`${event.processId}\` failed (exit ${event.exitCode}, ${elapsed})`;
    const details = event.exitCode !== 0 ? `\n\`\`\`\n${event.stderr.slice(-1000)}\n\`\`\`` : '';
    await notificationRouter.route('process_complete', {
      sessionKey: event.sessionKey,
      message: `${summary}${details}`,
    });
  });

  // -------------------------------------------------------------------------
  // P3 observability — request dump store
  // -------------------------------------------------------------------------

  let requestDumpStore: RequestDumpStore | undefined;
  if (config.observabilityRequestDump?.enabled) {
    const { JsonlRequestDumpStore } = await import('@ethosagent/request-dump');
    const dumpDir = config.observabilityRequestDump.dir ?? join(dataDir, 'request-dumps');
    requestDumpStore = new JsonlRequestDumpStore({
      dir: dumpDir,
      maxBytes: config.observabilityRequestDump.rotation?.maxBytes,
    });
  }

  // -------------------------------------------------------------------------
  // Memory provider map (AgentLoop shape)
  // -------------------------------------------------------------------------

  const memoryProviderMap = new Map<
    string,
    (options?: Record<string, unknown>) => MemoryProvider | Promise<MemoryProvider>
  >();
  for (const name of memoryProviders.list()) {
    const factory = memoryProviders.get(name);
    if (factory) {
      memoryProviderMap.set(name, (options) =>
        factory({
          config: options ?? {},
          dataDir,
          secrets: config.secretsResolver ?? NOOP_SECRETS,
          logger: log,
        }),
      );
    }
  }

  registerBuiltinExtractors(documentExtractors);

  // -------------------------------------------------------------------------
  // AgentLoop construction
  // -------------------------------------------------------------------------

  const activePerson = infra.activePerson;
  const activeMcpPolicy = personalities.getMcpPolicy(activePerson.id);
  const workingDir = wiringCtx.workingDir;

  // §7 — resolve the primary model's effective profile (config override OVER
  // catalog) once and thread its loop-facing fields in. streamStep applies each
  // sampling value only when the per-call RunOptions value is undefined, so
  // precedence is per-call > config override > catalog > provider default. No
  // profile → undefined → no defaults applied (behavior byte-identical to today).
  const resolvedProfile = mergeModelProfile(
    lookupProfile(config.provider, config.model),
    config.models?.[`${config.provider}/${config.model}`],
  );
  const modelSampling = resolvedProfile?.sampling;

  // §5 — resolve the effective compaction gate config: per-model profile OVER
  // global `compaction:` config (charsPerToken is per-model only). All absent →
  // undefined → the gate behaves exactly as it does today.
  const compactionGate = resolveCompactionGate(resolvedProfile, config.compaction);
  // Phase 1c — `gateDelta` is global-only (a token headroom, not a fraction);
  // merge it onto the resolved gate so the loop's actuals-first gate can use it.
  const gateDelta = config.compaction?.gateDelta;

  // Phase 3 — per-model-class default engine (frontier + summarizer wired →
  // semantic_summary; else drop_oldest) plus the turn-end auto-compact and
  // overflow-retry flags. These only apply when the personality declares no
  // `context_engine`; a personality override always wins.
  const summarizerWired = llmHandle?.summarize !== undefined;
  const defaultEngine = resolveDefaultContextEngine(llm.maxContextTokens, summarizerWired);
  const autoCompact = config.compaction?.autoCompact;
  const retryOnOverflow = config.compaction?.retryOnOverflow;
  // Item 7 — global-only knobs (no per-model layer, since that would mean a
  // `packages/types` change): the absolute context-token ceiling that lowers
  // BOTH gates, and the guaranteed verbatim user tail.
  const maxContextTokens = config.compaction?.maxContextTokens;
  const minTailUserMessages = config.compaction?.minTailUserMessages;
  const compaction = {
    ...(compactionGate ?? {}),
    ...(gateDelta !== undefined ? { gateDelta } : {}),
    ...(autoCompact !== undefined ? { autoCompact } : {}),
    ...(retryOnOverflow !== undefined ? { retryOnOverflow } : {}),
    ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
    ...(minTailUserMessages !== undefined ? { minTailUserMessages } : {}),
    defaultEngine,
  };
  const memoryConsolidation = config.memoryConsolidation;

  // §2 — the resolved profile's prompt-economy knobs (compact prelude, memory
  // cap, guidance suppression). Absent → context assembly unchanged.
  const profilePromptBudget = resolvedProfile?.promptBudget;

  // Phase 4 — small-window mode. Resolved ONCE here (never per turn) from static
  // inputs so the prompt prefix stays byte-stable. Triggers on a small window
  // (≤32k) OR when the measured static overhead (SOUL + prelude + tool schemas)
  // exceeds 40% of the window. When active, it forces the compact prelude,
  // index-not-content personality memory, index-mode skills, and a scaled
  // history limit. A config `compaction.smallWindow` (auto|on|off) overrides the
  // triggers. NOTE: tool schemas registered AFTER loop construction (delegation,
  // goal, MCP) are not counted in the static estimate — the estimate is
  // best-effort and biases slightly low; the window trigger is exact.
  let soulChars = 0;
  if (activePerson.soulFile) {
    try {
      soulChars = (await wiringStorage.read(activePerson.soulFile))?.length ?? 0;
    } catch {
      soulChars = 0;
    }
  }
  const toolDefinitions = tools.toDefinitions(activePerson.toolset);
  const toolSchemaChars = JSON.stringify(toolDefinitions).length;
  const preludeChars = (profilePromptBudget?.compactPrelude ? preludeCompact : prelude).length;
  // D8 — the ONE static-floor arithmetic, shared with `ethos bench context`
  // and the Lane 1(b) startup diagnostic below. Same number as the previous
  // inline `ceil((soul + schemas + prelude) / 4)` estimate.
  const staticFloor = measureStaticFloor({
    soulChars,
    toolSchemaChars,
    toolCount: toolDefinitions.length,
    preludeChars,
  });
  const staticTokens = staticFloor.tokens;
  const smallWindow = resolveSmallWindowMode({
    contextWindow: llm.maxContextTokens,
    staticTokens,
    ...(config.compaction?.smallWindow ? { override: config.compaction.smallWindow } : {}),
  });
  // Small-window defaults first, then let any explicit profile knobs win.
  const promptBudget = smallWindow
    ? {
        compactPrelude: true,
        suppressMemoryGuidance: true,
        memoryIndexMode: true,
        skillsIndexMode: true,
        memorySnapshotCap: 4_000,
        ...profilePromptBudget,
      }
    : profilePromptBudget;
  const historyLimit = smallWindow ? scaleHistoryLimit(llm.maxContextTokens) : undefined;

  // Lane 1(b) — startup floor check, WARN-FIRST (plan risk note: some configs
  // that "work" today only work because the server silently truncates; refuse
  // only after a release of warning). `evaluateContextFit` produces the
  // message so Lane 6's fit verdict reuses the identical diagnostic.
  const contextFit = evaluateContextFit({
    personalityId: activePerson.id,
    model: config.model,
    windowTokens: llm.maxContextTokens,
    floor: staticFloor,
  });
  if (contextFit.message) log.warn(contextFit.message);

  // Lane 5(i) — tier-mismatch startup diagnostic. Any loaded personality can
  // take a turn on this loop, and each one's tier map faces the same
  // provider-match guard against the same active LLM, so every loaded
  // personality is checked — not just the active one. The guard in
  // resolveModelWithTier stays; this only makes the silent drop visible.
  for (const p of personalities.list()) {
    const tierWarning = evaluateTierMismatch(p, llm.name);
    if (tierWarning) log.warn(tierWarning);
  }

  // Lane 3(b) — declared small-window toolset narrowing (D20). The narrowing
  // itself is enforced in the loop's turn setup (per-turn personality, gating
  // BOTH toDefinitions and executeParallel); here wiring makes it VISIBLE —
  // a startup diagnostic naming the personality and the surviving tools — and
  // measures the guard/budget below against the EFFECTIVE (narrowed) payload.
  const declaredSmallSet = parseSmallWindowToolset(
    activePerson.context_engine_options?.small_window_toolset,
  );
  const narrowedToolset =
    smallWindow && declaredSmallSet
      ? activePerson.toolset
        ? activePerson.toolset.filter((t) => declaredSmallSet.includes(t))
        : declaredSmallSet
      : undefined;
  if (narrowedToolset) {
    log.info(
      `small-window mode narrows personality \`${activePerson.id}\` to its declared ` +
        `small_window_toolset — surviving tools: ${narrowedToolset.join(', ') || '(none)'}`,
    );
  }
  const effectiveToolDefinitions = narrowedToolset
    ? tools.toDefinitions(narrowedToolset)
    : toolDefinitions;

  // Post-review FIX 2 — ONE hardened local-runtime classification for this
  // loop's provider endpoint, shared by the payload guard below and the
  // FIX 1 result-budget gate. Known hosted aliases never classify as local.
  const localRuntime = detectLocalRuntime(config.provider, config.baseUrl ?? '') !== undefined;

  // Lane 3(a) — total serialized tool-payload guard. On a local dialect an
  // over-limit payload FAILS startup (llamacpp-class runtimes lose tool
  // calling entirely — the failure this prevents); hosted dialects WARN. In
  // neither case is the problem deferred to the first tool call.
  const payloadGuard = evaluateToolPayloadGuard({
    toolDefinitions: effectiveToolDefinitions,
    localDialect: localRuntime,
    ...(config.toolPayloadLimitChars !== undefined
      ? { limitChars: config.toolPayloadLimitChars }
      : {}),
  });
  if (payloadGuard.message) {
    if (payloadGuard.severity === 'fail') throw new Error(payloadGuard.message);
    log.warn(payloadGuard.message);
  }

  // Lane 3(b) — per-personality tool-schema budget warning. Same chars/4
  // numbers `measureStaticFloor` / `ethos bench context` report (D8); default
  // threshold reuses SMALL_WINDOW_STATIC_RATIO (0.4). A personality that
  // declared a small-window toolset is measured on its narrowed payload; one
  // that declared nothing keeps its full toolset and gets this warning.
  const budgetRatio = activePerson.context_engine_options?.tool_schema_budget_ratio;
  const schemaBudget = evaluateToolSchemaBudget({
    personalityId: activePerson.id,
    windowTokens: llm.maxContextTokens,
    toolDefinitions: effectiveToolDefinitions,
    ...(typeof budgetRatio === 'number' && budgetRatio > 0 ? { ratio: budgetRatio } : {}),
  });
  if (schemaBudget.message) log.warn(schemaBudget.message);

  // Lane 1(c)+(e) — scale the per-turn tool-result budget DOWN with the served
  // window; never UP (the flat 80k default is the ceiling, #111762). An
  // explicit per-personality `context_engine_options.resultBudgetChars` may
  // lower it further, never raise it past the ceiling. Post-review FIX 1: the
  // scaling engages ONLY on a detected local runtime or that explicit knob —
  // hosted providers with small catalog windows keep the flat 80k default and
  // no gate-reserve term (the hosted-parity law).
  const rawResultBudget = activePerson.context_engine_options?.resultBudgetChars;
  const { resultBudgetChars, maxSingleToolResultTokens } = resolveResultBudgetGate({
    windowTokens: llm.maxContextTokens,
    staticFloorTokens: staticFloor.tokens,
    localRuntime,
    ...(typeof rawResultBudget === 'number' && rawResultBudget > 0
      ? { configured: rawResultBudget }
      : {}),
  });

  const loop = new AgentLoop({
    llm,
    tools,
    session,
    memory,
    personalities,
    injectors,
    injectorPluginIds,
    hooks,
    storage: new FsStorage(),
    attachmentCache: infra.capabilityBackends.attachmentCache,
    dataDir,
    modelRouting: config.modelRouting,
    ...(modelSampling ? { modelSampling } : {}),
    compaction: {
      ...compaction,
      ...(maxSingleToolResultTokens !== undefined ? { maxSingleToolResultTokens } : {}),
    },
    ...(memoryConsolidation ? { memoryConsolidation } : {}),
    ...(promptBudget ? { promptBudget } : {}),
    memoryProviders: memoryProviderMap,
    safety,
    documentExtractors,
    contextEngines,
    ...(llmHandle ? { llmHandle } : {}),
    clarifyBridge: infra.clarifyBridge,
    ...(config.teamName ? { teamId: config.teamName } : {}),
    ...(opts.observability ? { observability: opts.observability } : {}),
    ...(requestDumpStore ? { requestDumpStore } : {}),
    ...(activeMcpPolicy ? { mcpPolicy: activeMcpPolicy } : {}),
    onToolMetric: (metric) => {
      pluginDiagnostics.pushEvent({
        pluginId: metric.pluginId,
        level: 'info',
        message: 'tool_invocation',
        timestamp: new Date().toISOString(),
        data: {
          toolName: metric.toolName,
          ok: metric.ok,
          durationMs: metric.durationMs,
        },
        sessionId: metric.sessionId,
        turnId: metric.turnId,
      });
    },
    options: {
      platform: profile,
      workingDir,
      ...(historyLimit !== undefined ? { historyLimit } : {}),
      // Lane 1(c) — only passed when scaling engaged; at the ceiling the loop
      // default (80k) applies and the config is byte-identical to today.
      ...(resultBudgetChars < RESULT_BUDGET_CEILING_CHARS ? { resultBudgetChars } : {}),
      // Lane 3(b) — only passed when small-window mode is active, so hosted
      // frontier-window loop options stay byte-identical to today.
      ...(smallWindow ? { smallWindow } : {}),
    },
  });

  // --- Background sub-agent engine (durable spawn-and-continue) ---
  const bg = { ...backgroundDefaults(), ...(config.background ?? {}) };
  // Default ON for long-lived surfaces; OFF for one-shot CLI invocations that exit
  // immediately (a job spawned in a dying process would never run). An explicit
  // config.background.enabled always wins.
  const backgroundEnabled = config.background?.enabled ?? !(opts.oneShot ?? false);

  let jobStore: SQLiteJobStore | undefined;
  let backgroundExecutor: BackgroundExecutor | undefined;
  let backgroundDeps: BackgroundToolDeps | undefined;
  let meshProxyReconciler: MeshProxyReconciler | undefined;
  if (backgroundEnabled) {
    jobStore = new SQLiteJobStore(join(dataDir, 'jobs.db'));
    // Owner is unique per executor instance so multiple loops in one process
    // (multi-bot gateway) never race on claimNextQueued and each runs only its
    // own jobs. randomBytes suffix distinguishes same-profile same-pid instances.
    const owner = `${profile}:${process.pid}:${randomBytes(3).toString('hex')}`;
    backgroundExecutor = new BackgroundExecutor({
      store: jobStore,
      loop,
      owner,
      config: {
        maxConcurrentJobs: bg.maxConcurrentJobs,
        staleMs: bg.staleMs,
        heartbeatMs: bg.heartbeatMs,
        queuedTtlMs: bg.queuedTtlMs,
        maxRootBackgroundUsd: bg.maxRootBackgroundUsd,
        retentionMs: bg.retentionDays * 86_400_000,
      },
      log: (msg) => log.info(`[background] ${msg}`),
    });
    backgroundExecutor.start();
    backgroundDeps = {
      store: jobStore,
      nudge: () => backgroundExecutor?.nudge(),
      owner,
      defaultMaxCostUsd: bg.defaultMaxCostUsd,
      maxJobsPerRoot: bg.maxJobsPerRoot,
      maxJobsPerPersonality: bg.maxJobsPerPersonality,
      staleMs: bg.staleMs,
      ...(opts.originBotKey ? { originBotKey: opts.originBotKey } : {}),
      ...(opts.resolveOriginThreadId ? { resolveOriginThreadId: opts.resolveOriginThreadId } : {}),
    };

    // Mesh proxy reconciler — polls peers for background jobs spawned via
    // route_to_agent(background:true) and mirrors their status onto local proxy
    // rows. Uses plain globalThis.fetch: it runs OUTSIDE any turn and only
    // contacts mesh peers from the registry, so it bypasses per-personality
    // network policy by design.
    meshProxyReconciler = new MeshProxyReconciler({
      store: jobStore,
      fetchImpl: (url, init) => globalThis.fetch(url, init),
      log: (m) => log.info(`[mesh-reconciler] ${m}`),
    });
    meshProxyReconciler.start();
  }

  // Delegation tools need the loop reference; register after loop creation.
  for (const tool of createDelegationTools(
    loop,
    wiringStorage,
    opts.meshRegistryPath,
    backgroundDeps,
  ))
    tools.register(tool);

  // Goal runner — loop-bearing, constructed after the loop exists (mirrors
  // createDelegationTools handing the loop to tools post-construction). Shares
  // the single goalStore from tool composition via goalRunnerRef late-binding.
  // Always built so web-created goals execute for any personality, regardless of
  // whether the personality exposes goal_* tools.
  // Interactive tools that break goal autonomy: a fire-and-forget goal run has no
  // user to answer them, so a call would hang the run forever. Stripped from the
  // goal session's effective toolset. Extend this set as new interactive tools land.
  const GOAL_EXCLUDED_TOOLS = new Set(['clarify']);
  // Read-only planning toolset. The Tool contract carries no read-only/mutates
  // signal (only `toolset` groups), so planning is gated by an explicit allowlist
  // of known non-mutating tool names, intersected with the personality's toolset.
  // This deliberately excludes goal_complete and every mutating/execution tool:
  // the planning turn investigates and writes a plan, it must not change state.
  // When the personality toolset can't be resolved the intersection is empty
  // (planning still produces a plan from the goal text) — never the full toolset.
  const GOAL_PLAN_READONLY_TOOLS = new Set([
    'read_file',
    'search_files',
    'web_search',
    'web_extract',
    'memory_read',
    'session_search',
    'session_list_by_date',
    'team_memory_read',
    'team_memory_search',
  ]);
  const goalRunner = new GoalRunner({
    store: goalStore,
    hooks,
    runAttempt: (sessionKey, firstMessage, o) => {
      const ptoolset = o.personalityId ? personalities.get(o.personalityId)?.toolset : undefined;
      const toolsetOverride = ptoolset?.filter((t) => !GOAL_EXCLUDED_TOOLS.has(t));
      return loop.run(firstMessage, {
        sessionKey,
        abortSignal: o.abortSignal,
        ...(o.steerSink ? { steerSink: o.steerSink } : {}),
        ...(o.personalityId ? { personalityId: o.personalityId } : {}),
        ...(o.userId ? { userId: o.userId } : {}),
        ...(o.maxToolCallsPerTurn != null ? { maxToolCallsPerTurn: o.maxToolCallsPerTurn } : {}),
        ...(o.maxIdenticalToolCalls != null
          ? { maxIdenticalToolCalls: o.maxIdenticalToolCalls }
          : {}),
        ...(o.allowDangerousToolCalls ? { allowDangerousToolCalls: true } : {}),
        ...(toolsetOverride ? { toolsetOverride } : {}),
      });
    },
    runPlan: (sessionKey, firstMessage, o) => {
      const ptoolset = o.personalityId ? personalities.get(o.personalityId)?.toolset : undefined;
      const readOnlyToolset = (ptoolset ?? []).filter((t) => GOAL_PLAN_READONLY_TOOLS.has(t));
      return loop.run(firstMessage, {
        sessionKey,
        abortSignal: o.abortSignal,
        ...(o.personalityId ? { personalityId: o.personalityId } : {}),
        ...(o.userId ? { userId: o.userId } : {}),
        toolsetOverride: readOnlyToolset,
      });
    },
  });
  goalRunner.recoverOrphans();
  goalRunnerRef.runner = goalRunner;

  // Phase tool-cap P1 — fail-loud-at-boot validation.
  const validationErrors = tools.validateToolsForPersonality(activePerson);
  if (validationErrors.length > 0) {
    const summary = validationErrors
      .map((e) => `  ${e.tool} [${e.capability}]: ${e.message}`)
      .join('\n');
    throw new Error(
      `Tool capability validation failed for personality "${activePerson.id}":\n${summary}\n` +
        `Adjust the personality's safety.network.allow / fs_reach, or remove the tool from toolset.yaml.`,
    );
  }

  const ref: GatewaySendRef = gatewaySendRef;

  // -------------------------------------------------------------------------
  // memory-experience pillar B — proactive capture (default-off, §3)
  // -------------------------------------------------------------------------
  let onMemoryCapturedFn:
    | ((cb: (n: { sessionId: string; scopeId: string; summary: string }) => void) => () => void)
    | undefined;
  if (config.memoryCapture?.enabled && (memoryName === 'markdown' || memoryName === 'vault')) {
    const captureConfig = config.memoryCapture;
    // Undecorated write provider + its own HistoryStore: the runner records
    // history itself (with hint + capture hashes), so it must not double-record
    // through a decorated handle. Backend-aware: under `memory: vault` the base
    // is a ScopedStorage-confined VaultMemoryProvider and the history roots at
    // the vault's `.ethos-meta`; tombstones (below) stay at ~/.ethos.
    const { base: captureBase, history: captureHistory } = createUndecoratedBackend({
      selection: config,
      dataDir,
      storage: wiringCtx.storage,
      logger: log,
    });

    // Extraction model: dedicated cheap aux model when configured, else reuse
    // the primary provider (open-question 2 — zero-config installs pay primary).
    let captureLlm: LLMProvider = llm;
    if (captureConfig.model && captureConfig.model !== config.model) {
      const auxProviderName = captureConfig.provider ?? config.provider;
      const auxFactory = infra.llmProviders.get(auxProviderName);
      if (auxFactory) {
        captureLlm = await auxFactory({
          config: {
            provider: auxProviderName,
            model: captureConfig.model,
            apiKey: captureConfig.apiKey ?? config.apiKey,
            ...((captureConfig.baseUrl ?? config.baseUrl)
              ? { baseUrl: captureConfig.baseUrl ?? config.baseUrl }
              : {}),
            ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
          },
          secrets: config.secretsResolver ?? NOOP_SECRETS,
          logger: log,
        });
      } else {
        log.warn(
          `memoryCapture provider "${auxProviderName}" not registered; ` +
            'capture extraction will reuse the primary model',
        );
      }
    }

    // Inline consolidation fallback (§3.5): only when no macro-loop is
    // configured. Reuses the pure consolidateMemory(); the consolidation write
    // is recorded through a history-decorated handle so it lands as
    // `source: 'consolidation'`.
    const nightlyConfigured = config.nightlyPass?.enabled === true;
    const consolidationHandle = withHistory(captureBase, captureHistory, {
      source: 'consolidation',
    });
    const consolidate: ConsolidateFn = async ({ ctx }) => {
      const memBefore = (await captureBase.read('MEMORY.md', ctx))?.content ?? '';
      const userBefore = (await captureBase.read('USER.md', ctx))?.content ?? '';
      const result = await consolidateMemory(
        { memory: memBefore, user: userBefore, recentContext: '' },
        llm,
      );
      const updates = buildConsolidationUpdates({ memory: memBefore, user: userBefore }, result);
      if (updates.length > 0) await consolidationHandle.sync(updates, ctx);
    };

    // Approve-before-store gate (memory-lifecycle L2). When approval gates the
    // `capture` source, the runner PROPOSES each fresh fact to the pending queue
    // (with its exact fact-hash) instead of writing durably; approval replays it
    // through the history-recording path. The tombstone store is passed
    // unconditionally so a fact rejected while gating was on stays skipped even
    // if approval is later disabled.
    const approvalMode = config.memoryApproval?.mode ?? 'off';
    const captureGated = approvalMode === 'automated' || approvalMode === 'all';
    const captureTombstones = new TombstoneStore({ storage: wiringCtx.storage, dataDir });
    let capturePropose: ProposeFn | undefined;
    if (captureGated) {
      const DAY_MS = 24 * 60 * 60 * 1000;
      const pending = new PendingMemoryStore({
        storage: wiringCtx.storage,
        dataDir,
        tombstones: captureTombstones,
        ...(config.memoryApproval?.cap !== undefined ? { cap: config.memoryApproval.cap } : {}),
        ...(config.memoryApproval?.ttlDays !== undefined
          ? { ttlMs: config.memoryApproval.ttlDays * DAY_MS }
          : {}),
        // Cap drops must be audible (Curator lesson, plan §3b) — same seam as
        // the build-infrastructure write path.
        observability: {
          onCapExceeded: (info) => {
            log.warn(
              `memory pending queue at cap (${info.cap}) for ${info.scopeId} — dropped oldest candidate ${info.droppedId}`,
            );
            opts.observability?.recordMemoryPendingCapDrop({ details: { ...info } });
          },
        },
        apply: async (entry, approvedBy) => {
          const handle = withHistory(captureBase, captureHistory, {
            source: entry.source,
            approvedBy,
          });
          const ctx: MemoryContext = {
            scopeId: entry.scopeId,
            sessionId: entry.sessionId ?? '',
            sessionKey: entry.sessionKey ?? 'cli',
            platform: 'cli',
            workingDir: '',
          };
          await handle.sync([entry.update], ctx);
        },
      });
      capturePropose = async (proposal) => {
        await pending.propose(proposal);
      };
    }

    const captureRunner = new MemoryCaptureRunner({
      provider: captureBase,
      history: captureHistory,
      session,
      llm: captureLlm,
      sanitize,
      logger: log,
      nightlyConfigured,
      consolidate,
      tombstones: captureTombstones,
      ...(capturePropose ? { propose: capturePropose } : {}),
      config: {
        ...(captureConfig.maxPerHour !== undefined ? { maxPerHour: captureConfig.maxPerHour } : {}),
        ...(captureConfig.maxPerDay !== undefined ? { maxPerDay: captureConfig.maxPerDay } : {}),
      },
      workingDir: wiringCtx.dataDir,
    });
    captureRunner.registerHook(hooks);
    onMemoryCapturedFn = (cb) => captureRunner.onCaptured(cb);
  }

  // Real-time voice stack. Null (a clean no-op) unless `config.voice.*` is
  // configured; LiveKit/SIP transports additionally need their app-supplied
  // native bindings, which no in-repo caller passes yet.
  const voiceStack = await buildVoiceStack({
    config,
    storage: wiringCtx.storage,
    dataDir,
    sttProviders: infra.sttProviders,
    ttsProviders: infra.ttsProviders,
    ...(config.secretsResolver ? { secrets: config.secretsResolver } : {}),
    logger: log,
    ...(opts.observability ? { observability: opts.observability } : {}),
  });

  return {
    loop,
    toolRegistry: tools,
    // Lane 3(b) — the served window of the primary provider, exposed so
    // `ethos bench context` divides by the SAME denominator the schema-budget
    // warning uses (no second measurement path).
    contextWindow: llm.maxContextTokens,
    mcpManager,
    skillsInjector,
    setMessagingSend: (fn) => {
      ref.fn = fn;
    },
    setOnSkillProposed: (fn) => {
      onSkillProposedFn = fn;
    },
    setOnSkillApplied: (fn) => {
      onSkillAppliedFn = fn;
    },
    ...(onMemoryCapturedFn ? { onMemoryCaptured: onMemoryCapturedFn } : {}),
    notificationRouter,
    pluginLoader,
    goalRunner,
    ...(jobStore ? { jobStore } : {}),
    ...(backgroundExecutor ? { backgroundExecutor } : {}),
    ...(meshProxyReconciler ? { meshProxyReconciler } : {}),
    activePersonality: activePerson,
    refreshPersonalities: () => personalities.loadFromDirectory(join(dataDir, 'personalities')),
    sttProviders: infra.sttProviders,
    ttsProviders: infra.ttsProviders,
    ...(voiceStack ? { voiceStack } : {}),
    voiceConfig: {
      sttProviderName: config.auxiliaryAsr?.provider,
      sttProviderConfig: config.auxiliaryAsr
        ? {
            apiKey: config.auxiliaryAsr.apiKey,
            model: config.auxiliaryAsr.model,
            baseUrl: config.auxiliaryAsr.baseUrl,
            command: config.auxiliaryAsr.command,
          }
        : {},
      ttsProviderName: config.auxiliaryTts?.provider,
      ttsProviderConfig: config.auxiliaryTts
        ? {
            apiKey: config.auxiliaryTts.apiKey,
            model: config.auxiliaryTts.model,
            voice: config.auxiliaryTts.voice,
            baseUrl: config.auxiliaryTts.baseUrl,
            command: config.auxiliaryTts.command,
          }
        : {},
      secretsResolver:
        config.secretsResolver ?? (NOOP_SECRETS as import('@ethosagent/types').SecretsResolver),
      // Armed only when `voice.trustedPlugins` is declared. Computed once here
      // so every surface enforces the SAME allowlist instead of each deriving
      // its own notion of "trusted".
      ...(config.voice?.trustedPlugins
        ? { trustedVoicePlugins: new Set(config.voice.trustedPlugins) }
        : {}),
    },
  };
}
