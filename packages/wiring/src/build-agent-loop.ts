import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { backgroundDefaults } from '@ethosagent/config';
import {
  AgentLoop,
  type ClarifyOriginLane,
  DefaultJobRunnerRegistry,
  deriveFsReachPaths,
  EagerPrefetchPolicy,
  parseSmallWindowToolset,
  resolveSttProvider,
  SimpleCompletionImpl,
} from '@ethosagent/core';
import { registerBuiltinExtractors } from '@ethosagent/document-extractors';
import { createRouterGate, PI_RUNNER_NAME, PiJobRunner } from '@ethosagent/execution-pi';
import { GoalRunner } from '@ethosagent/goal-runner';
import { BackgroundExecutor, ETHOS_RUNNER_NAME, EthosJobRunner } from '@ethosagent/job-runner';
import { SQLiteJobStore } from '@ethosagent/job-store';
import { PendingMemoryStore, TombstoneStore } from '@ethosagent/memory-approval';
import {
  type ConsolidateFn,
  MemoryCaptureRunner,
  type ProposeFn,
} from '@ethosagent/memory-capture';
import { withHistory } from '@ethosagent/memory-history';
import { buildConsolidationUpdates, consolidateMemory } from '@ethosagent/nightly-loop';
import type { Speaker, TranscriptEntry } from '@ethosagent/platform-callcapture';
import { MicCapture, TapCapture } from '@ethosagent/platform-callcapture';
import { sanitize } from '@ethosagent/safety-injection';
import { defaultAlwaysDeny, FsStorage, ScopedStorage } from '@ethosagent/storage-fs';
import { type CallCaptureToolsOptions, runCallCapture } from '@ethosagent/tools-callcapture';
import {
  type BackgroundToolDeps,
  createDelegationTools,
  MeshProxyReconciler,
} from '@ethosagent/tools-delegation';
import { createMemoryTools } from '@ethosagent/tools-memory';
import { createVisionTools } from '@ethosagent/tools-vision';
import { createAgentConsultTool } from '@ethosagent/tools-voice';
import { createWebTools } from '@ethosagent/tools-web';
import type {
  BackgroundJob,
  ClarifySurfaceType,
  LLMProvider,
  MemoryContext,
  MemoryProvider,
  RequestDumpStore,
} from '@ethosagent/types';
import {
  createClarifyEscalator,
  createSecretHandler,
  InteractionRouter,
  SECRET_KIND,
} from '@ethosagent/worker-router';
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
 * Call-capture's registration gate (plan/phases/call-capture-extension.md —
 * macOS-only, opt-in via `callCapture.personalityId`). Extracted as a pure
 * function so the gate itself is unit-testable without invoking the full
 * `buildAgentLoop` composition root (which opens SQLite stores, constructs an
 * LLM provider, loads plugins, and reads `~/.ethos/` — impractical to
 * construct in a focused test, per the same rationale
 * `safety-conformance-wiring.test.ts` documents for `buildAgentLoop`).
 */
export function isCallCaptureToolsEnabled(
  platform: NodeJS.Platform,
  config: Pick<WiringConfig, 'callCapture'>,
): boolean {
  return platform === 'darwin' && Boolean(config.callCapture?.personalityId);
}

/**
 * Resolve the Documents-tab mirror target for one call-capture invocation
 * (plan/phases/call-capture-desktop-ux.md, P4). Only personalities that
 * DECLARE `fs_reach.workdir` get a mirror target — `deriveFsReachPaths`
 * itself falls back to `cwd` when undeclared (so a personality's file tools
 * still get a workdir), but applying that same fallback here would silently
 * mirror call-capture transcripts into the process's cwd for every
 * personality with no declared workdir. Checking `fs_reach?.workdir` first
 * mirrors the same guard `personalityAssetDir` (`@ethosagent/core`) uses for
 * the same reason.
 *
 * Extracted as a pure function for the same testability reason
 * `isCallCaptureToolsEnabled` above is — `buildAgentLoop` is a full
 * composition root, impractical to construct in a focused test.
 */
export function resolveCallCaptureDocumentsWorkdir(
  personality: import('@ethosagent/types').PersonalityConfig | undefined,
  vars: Parameters<typeof deriveFsReachPaths>[1],
): string | undefined {
  return personality?.fs_reach?.workdir ? deriveFsReachPaths(personality, vars).workdir : undefined;
}

// Every channel adapter that sets `InboundMessage.platform` (and therefore
// `BackgroundJob.originPlatform`, copied from it at spawn) with a live clarify
// surface. `BackgroundJob.originPlatform` is a plain string — other origins
// (email, mcp, webhook, cron) carry values with no clarify surface at all.
const CLARIFY_SURFACE_TYPES = new Set<ClarifySurfaceType>([
  'tui',
  'cli',
  'web',
  'telegram',
  'slack',
  'discord',
  'whatsapp',
]);

function isClarifySurfaceType(platform: string): platform is ClarifySurfaceType {
  return CLARIFY_SURFACE_TYPES.has(platform as ClarifySurfaceType);
}

/**
 * D7/G2/G3 (plan/phases/pi-delegation.md §5/§6) — maps a background job's
 * recorded origin (the Phase-B lane-resolution columns on `BackgroundJob`) to
 * the `ClarifyOriginLane` `ClarifyBridge.setOriginResolver` expects. `null`
 * when the job has no recorded origin platform, or that platform has no
 * clarify surface — the bridge's `resolveRouting()` then falls back to the
 * request's own `surfaceType` (today's behaviour). `surfaceContext` reuses
 * the same `chatId`/`botKey`/`threadId` keys the per-platform
 * `clarify-surface.ts` files (Telegram/Slack/Discord/WhatsApp) write onto a
 * presented row's `surfaceContext`.
 *
 * Extracted as a pure function for the same testability reason
 * `isCallCaptureToolsEnabled` above is — `buildAgentLoop` is a full
 * composition root, impractical to construct in a focused test.
 */
export function resolveJobClarifyOrigin(
  job: Pick<
    BackgroundJob,
    'originPlatform' | 'originBotKey' | 'originChatId' | 'originThreadId'
  > | null,
): ClarifyOriginLane | null {
  const platform = job?.originPlatform;
  if (!platform || !isClarifySurfaceType(platform)) return null;
  return {
    surfaceType: platform,
    surfaceContext: {
      ...(job?.originChatId ? { chatId: job.originChatId } : {}),
      ...(job?.originBotKey ? { botKey: job.originBotKey } : {}),
      ...(job?.originThreadId ? { threadId: job.originThreadId } : {}),
    },
  };
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
  // Call-capture (built here, not registered as a tool, because it needs
  // `llm` and `memory` — the same reason the vision and web tools above
  // construct here rather than in compose-tools.ts). macOS-only per
  // plan/phases/call-capture-extension.md — a complete no-op (no
  // construction, no behavior change) for every deployment that hasn't set
  // `callCapture.personalityId`. `runCallCapture` is never registered as a
  // `Tool` — it is not LLM-reachable from any chat turn; the only caller is
  // `CallCaptureDaemon`'s accept-gated `runCapture`, bound below into
  // `runCallCaptureFn` and threaded out through `CreateAgentLoopResult`
  // (see `apps/ethos/src/commands/serve.ts`). Decision 7 of the plan requires
  // an LLM content-summarization step over the finished transcript (not the
  // plain participant/line-count roll-up `buildTranscriptArtifact` produces
  // on its own), so `getSummaryProvider` is wired here rather than left
  // absent — leaving it absent would silently downgrade every capture to the
  // plain roll-up.
  // -------------------------------------------------------------------------

  let runCallCaptureFn:
    | ((
        personalityId: string,
        opts: {
          source?: string;
          abortSignal: AbortSignal;
          onEntry?: (entry: TranscriptEntry) => void;
          onAudioLevel?: (speaker: Speaker, level: number, at: number) => void;
        },
      ) => Promise<import('@ethosagent/tools-callcapture').CallCaptureResult>)
    | undefined;
  if (isCallCaptureToolsEnabled(process.platform, config)) {
    const sttResolution = await resolveSttProvider({
      registry: infra.sttProviders,
      providerName: config.auxiliaryAsr?.provider,
      providerConfig: { ...config.auxiliaryAsr },
    });
    if (!sttResolution.ok) {
      log.warn(
        `call-capture: STT unavailable (${sttResolution.error}) — call capture will report itself unavailable`,
      );
    }
    // When `wiringCtx.callCaptureNativeDir` is set (bundled callers only —
    // see `types.ts`), override each binary's default `import.meta.dirname`-
    // relative path with one resolved under the real native dir. Absent, both
    // constructors fall back to their own unchanged defaults.
    const tapCaptureOpts = wiringCtx.callCaptureNativeDir
      ? { binaryPath: join(wiringCtx.callCaptureNativeDir, 'vendor', 'audiotee', 'audiotee') }
      : {};
    const micCaptureOpts = wiringCtx.callCaptureNativeDir
      ? { binaryPath: join(wiringCtx.callCaptureNativeDir, 'bin', 'mic-capture') }
      : {};
    const baseCallCaptureOpts: CallCaptureToolsOptions = {
      tapCapture: new TapCapture(tapCaptureOpts),
      micCapture: new MicCapture(micCaptureOpts),
      ...(sttResolution.ok ? { sttProvider: sttResolution.provider } : {}),
      memory,
      getSummaryProvider: async () => llm,
    };
    runCallCaptureFn = (personalityId, { source, abortSignal, onEntry, onAudioLevel }) => {
      // Stable per-personality key (mirrors this repo's `cli:<cwd-basename>`
      // session-key convention and the daemon's prior sessionKey construction,
      // relocated here since there is no longer a live turn to carry it).
      const sessionKey = `callcapture:${personalityId}`;
      // Documents-tab mirror target (P4): resolved PER INVOCATION, not once at
      // wiring time — `personalityId` is a runtime parameter (the daemon binds
      // whichever personality accepted the call), so the workdir it maps to can
      // only be known here.
      const documentsWorkdir = resolveCallCaptureDocumentsWorkdir(
        personalities.get(personalityId),
        {
          ethosHome: dataDir,
          self: personalityId,
          cwd: wiringCtx.workingDir,
        },
      );
      // Documents-tab mirror storage boundary: `wiringCtx.storage` is the
      // raw, process-wide Storage — it must never reach `runCallCapture`
      // unscoped. Confine it to this personality's own `fs_reach.workdir`
      // via `ScopedStorage`, the same boundary `DocumentsService`
      // (apps/web-api/src/services/documents.service.ts) enforces for reads
      // of this same directory. Constructed here, per invocation, because
      // `documentsWorkdir` itself is only known per invocation.
      const callCaptureOpts: CallCaptureToolsOptions = {
        ...baseCallCaptureOpts,
        ...(documentsWorkdir
          ? {
              documentsWorkdir,
              storage: new ScopedStorage(wiringCtx.storage, {
                read: [documentsWorkdir],
                write: [documentsWorkdir],
                alwaysDeny: defaultAlwaysDeny(),
              }),
            }
          : {}),
      };
      return runCallCapture(callCaptureOpts, {
        source,
        scopeId: `personality:${personalityId}`,
        sessionId: sessionKey,
        sessionKey,
        platform: 'callcapture',
        workingDir: wiringCtx.workingDir,
        abortSignal,
        ...(onEntry ? { onEntry } : {}),
        ...(onAudioLevel ? { onAudioLevel } : {}),
      });
    };
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
    // G4 — this composition root gates tool calls behind the danger predicate
    // (`./danger-predicate`, reached via the `before_tool_call` modifying hooks
    // each surface registers). Declaring it makes core verify the claim at the
    // first tool dispatch instead of assuming it.
    approvalPosture: { kind: 'gated', policy: 'danger-predicate' },
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
    logger: log,
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
    // G2/G3/D7 — a background job's clarify routes to wherever a live human
    // is currently present (see `ClarifyBridge.resolveRouting`), falling back
    // to the job's own origin lane. That fallback needs to look the job up;
    // only wired here, where a `JobStore` actually exists (no jobs, no
    // resolver to ask about them).
    const jobStoreForClarify = jobStore;
    infra.clarifyBridge.setOriginResolver(async (jobId) => {
      const job = await jobStoreForClarify.get(jobId);
      return resolveJobClarifyOrigin(job);
    });
    // Owner is unique per executor instance so multiple loops in one process
    // (multi-bot gateway) never race on claimNextQueued and each runs only its
    // own jobs. randomBytes suffix distinguishes same-profile same-pid instances.
    const owner = `${profile}:${process.pid}:${randomBytes(3).toString('hex')}`;
    // Runner seam. `ethos` — the in-process AgentLoop path — is the default and
    // the only runner registered here; an out-of-process harness registers its
    // own factory and nothing else in this file changes. Resolved eagerly
    // because both the executor and `delegate_task` read instances, not
    // factories.
    const jobRunners = new DefaultJobRunnerRegistry();
    jobRunners.register(ETHOS_RUNNER_NAME, () => new EthosJobRunner(loop));
    await jobRunners.resolve(ETHOS_RUNNER_NAME, { logger: log });
    // Pi — out-of-process, in a container. Registered only when the deployment
    // names a digest-pinned image (there is nothing sane to default to), so an
    // un-provisioned machine answers `not_available` rather than failing at
    // spawn time. The docker backend comes from the SAME registry (and, by its
    // cache, is the SAME instance) exec tools use: D4's containment claim rests
    // on one mount derivation, not two.
    const piConfig = config.background?.pi;
    let interactionRouter: InteractionRouter | undefined;
    if (piConfig?.image) {
      // Phase 4 — every gated Pi tool call goes through the runner-agnostic
      // router: cached answer (D17), auto-resolving capability (D16), or the
      // existing clarify chain. `secret` is registered so a runner that ever
      // emits that kind fails closed instead of writing secret material into a
      // persisted clarify row (§4.5); no runner emits it today.
      const router = new InteractionRouter({
        escalate: createClarifyEscalator({
          bridge: infra.clarifyBridge,
          jobs: jobStoreForClarify,
          // I11 — a run parked on a human question is `blocked`, not `running`:
          // its heartbeat pauses so the stale sweep leaves it alone, and the
          // card can say why it is sitting there. The executor is constructed
          // below, so this reads it late through the same `let` binding
          // `backgroundDeps.nudge` uses — the closure only fires when a worker
          // actually asks something, long after assignment.
          blocking: {
            block: async (id, requestId) => {
              await backgroundExecutor?.markJobBlocked(id, requestId);
            },
            resume: async (id) => {
              await backgroundExecutor?.resumeJob(id);
            },
          },
          // Only the bridge's last-resort route: a background clarify resolves
          // its real destination from the job's origin lane + presence
          // (G2/G3/D7), which is wired above.
          ...(isClarifySurfaceType(profile) ? { fallbackSurfaceType: profile } : {}),
        }),
        logger: log,
      });
      router.registry.register(SECRET_KIND, createSecretHandler());
      interactionRouter = router;
      const piBackend = await infra.executionBackends.resolve('docker', {
        config: {
          substitutionVars: { ethosHome: dataDir, cwd: wiringCtx.workingDir },
          constitution: infra.constitution,
        },
        secrets: config.secretsResolver ?? NOOP_SECRETS,
        logger: log,
      });
      jobRunners.register(
        PI_RUNNER_NAME,
        () =>
          new PiJobRunner({
            backend: piBackend,
            resolvePersonality: (id) => personalities.get(id),
            ethosHome: dataDir,
            cwd: wiringCtx.workingDir,
            image: piConfig.image,
            ...(piConfig.memoryMb !== undefined ? { memoryMb: piConfig.memoryMb } : {}),
            ...(piConfig.configDir ? { piConfigDir: piConfig.configDir } : {}),
            gate: createRouterGate(router, log),
            logger: log,
          }),
      );
      await jobRunners.resolve(PI_RUNNER_NAME, { logger: log });
    }
    backgroundExecutor = new BackgroundExecutor({
      store: jobStore,
      loop,
      runners: jobRunners,
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
      // Phase 5 — cancelling a run withdraws whatever question it is parked
      // on. Without this, `task_cancel` on a `blocked` job aborts the run but
      // leaves its clarify live on someone's phone for the rest of its window
      // (now up to the 24 h park), and the escalator's `resume` — which
      // un-pauses the heartbeat — never runs because `request()` never settles.
      cancelInteractions: async (jobId) => {
        await infra.clarifyBridge.cancelJob(jobId);
      },
    });
    backgroundExecutor.start();
    if (interactionRouter) {
      // D17 — a run's remembered allowances die with the run. `onComplete`
      // fires on every terminal transition, which is exactly the boundary
      // "allow for this run" was scoped to.
      const router = interactionRouter;
      backgroundExecutor.onComplete((job) => router.forgetJob(job.id));
    }
    backgroundDeps = {
      store: jobStore,
      nudge: () => backgroundExecutor?.nudge(),
      runners: jobRunners,
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

  // `agent_consult` — the hosted-realtime voice surface's one call back into
  // the agent. Loop-bearing for the same reason the delegation tools are, so it
  // registers here rather than in `compose-tools`. Registered UNCONDITIONALLY:
  // the realtime seam advertises what the registry actually holds
  // (`deriveRealtimeToolset`), so a conditional registration would silently
  // produce a session that offers nothing and a model that stops asking.
  //
  // The voice origin is fixed to browser talk-mode because that is the only
  // surface whose realtime session opens behind the operator's own credentials —
  // `voice.realtimeToken` mints behind the web-api session cookie.
  //
  // A PHONE CALL MUST NOT USE THIS INSTANCE. V4's call path builds its own via
  // `createFarEndConsultTool` (`./far-end-consult`), which pins
  // `speaker: 'far_end'` and, for a screened caller, the receptionist
  // personality. The spoken-confirmation gate refuses a far-end caller BEFORE
  // consulting any confirmation record, and that refusal keys on exactly this
  // field — so reusing the owner's instance on a call would promote every
  // stranger to the operator.
  tools.register(
    createAgentConsultTool(loop, {
      voiceOrigin: { transport: 'browser-talk-mode', speaker: 'owner' },
    }),
  );

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
  // configured. The SIP trunk and the LiveKit token minter now build themselves
  // from config inside `buildVoiceStack`; what still needs an app-supplied
  // binding is the room MEDIA client (`@livekit/rtc-node`), which callers pass
  // as `livekit.createClient` — absent, the transports degrade to unavailable
  // and everything else in the stack still works. `apps/ethos` supplies it from
  // `resolveLiveKitMedia()` when telephony is configured; nothing else does.
  const voiceStack = await buildVoiceStack({
    config,
    sttProviders: infra.sttProviders,
    ttsProviders: infra.ttsProviders,
    ...(config.secretsResolver ? { secrets: config.secretsResolver } : {}),
    logger: log,
    ...(opts.observability ? { observability: opts.observability } : {}),
    ...(opts.livekit ? { livekit: opts.livekit } : {}),
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
    ...(runCallCaptureFn ? { runCallCapture: runCallCaptureFn } : {}),
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
    realtimeProviders: infra.realtimeProviders,
    ...(voiceStack ? { voiceStack } : {}),
    voiceConfig: {
      sttProviderName: config.auxiliaryAsr?.provider,
      sttProviderConfig: config.auxiliaryAsr
        ? {
            apiKey: config.auxiliaryAsr.apiKey,
            model: config.auxiliaryAsr.model,
            baseUrl: config.auxiliaryAsr.baseUrl,
            command: config.auxiliaryAsr.command,
            timeout: config.auxiliaryAsr.timeout,
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
            outputFormat: config.auxiliaryTts.outputFormat,
            timeout: config.auxiliaryTts.timeout,
            maxTextLength: config.auxiliaryTts.maxTextLength,
          }
        : {},
      // The named rosters (`voice.tts.providers.*` / `voice.stt.providers.*`).
      // `auxiliary.tts` / `auxiliary.asr` above stay the default entries; these
      // are what a personality's `voice.tts_provider` / `voice.stt_provider` can
      // name instead.
      ...(config.voice?.tts?.providers ? { ttsRoster: config.voice.tts.providers } : {}),
      ...(config.voice?.stt?.providers ? { sttRoster: config.voice.stt.providers } : {}),
      // The realtime roster (`voice.realtime.providers.*`) plus the two keys
      // that decide whether the realtime tier runs at all: which entry a
      // personality that names none gets, and the deployment's tier default.
      ...(config.voice?.realtime?.providers
        ? { realtimeRoster: config.voice.realtime.providers }
        : {}),
      ...(config.voice?.realtime?.default
        ? { realtimeDefault: config.voice.realtime.default }
        : {}),
      ...(config.voice?.tier ? { tier: config.voice.tier } : {}),
      // The cap on ONE realtime call. Forwarded here rather than left to
      // web-api's live-config read alone — that read is optional, and a
      // deployment whose cap depends on an optional code path does not have a
      // cap, it has a coincidence.
      ...(config.voice?.realtime?.sessionBudgetUsd !== undefined
        ? { realtimeSessionBudgetUsd: config.voice.realtime.sessionBudgetUsd }
        : {}),
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
