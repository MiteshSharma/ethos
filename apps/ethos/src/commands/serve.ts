import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve as pathResolve } from 'node:path';
import {
  type A2aAuditSink,
  A2aDelegationGuard,
  type A2aTaskRunner,
  createA2aAuthRouter,
  createA2aRpcRouter,
  createA2aWellKnownRouter,
  MemoryA2aLimiter,
  MemoryA2aPreAuthLimiter,
  MemoryNonceStore,
  SQLiteA2aTaskStore,
  StorageA2aAllowlist,
  StorageA2aPeerStore,
} from '@ethosagent/a2a';
import { AcpServer } from '@ethosagent/acp-server';
import { AgentMesh, meshRegistryPath } from '@ethosagent/agent-mesh';
import {
  configParseNotices,
  type EthosConfig,
  ethosDir,
  readConfig,
  readRawConfig,
  writeConfig,
} from '@ethosagent/config';
import { type AgentLoop, scriptCallableFor, toolsDeclaringNetwork } from '@ethosagent/core';
import { buildCronTriggers, CronScheduler, type CronTriggers } from '@ethosagent/cron';
import { LocalExecutionBackend } from '@ethosagent/execution-local';
import { LangfusePollLoop } from '@ethosagent/export-langfuse';
import { IdleWatcherManager } from '@ethosagent/idle-watcher';
import { ConsoleLogger } from '@ethosagent/logger';
import { SQLiteNotifyQueue } from '@ethosagent/notify-queue';
import { computeContextAnatomy, createMetricsTextProvider } from '@ethosagent/observability-sqlite';
import {
  createPersonalityRegistry,
  PersonalityA2aIdentityProvider,
} from '@ethosagent/personalities';
import {
  CallCaptureDaemon,
  CallCaptureOwnershipManager,
  CaptureIndicator,
  callCaptureHealthPath,
  callCaptureLockPath,
  checkCallCaptureDependencies,
  type DaemonState,
  MicActivityDetector,
  NotificationGate,
} from '@ethosagent/platform-callcapture';
import { SessionLane } from '@ethosagent/session-lane';
import { SQLiteContextLog, SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { FsAttachmentCache, FsStorage } from '@ethosagent/storage-fs';
import { teamsDir } from '@ethosagent/team-supervisor';
import { createA2aTools } from '@ethosagent/tools-a2a';
import type { McpManager } from '@ethosagent/tools-mcp';
import {
  type BackgroundJob,
  EthosError,
  type RunUpdateDigest,
  type ToolRegistry,
} from '@ethosagent/types';
import { WatcherManager, type WatcherWakeEvent } from '@ethosagent/watchers';
import {
  type ChatService,
  createWebApi,
  IdempotencyStore,
  type RouteModule,
  type TeamLoopHandle,
  WebTokenRepository,
} from '@ethosagent/web-api';
import {
  APPROVAL_SURFACE_ALWAYS_ASK,
  buildA2aPeeringService,
  createApprovalDangerPredicate,
  createLazyProvider,
  createMemoryProvider,
  createSessionStore,
  IdentityMap,
  resolvePersonalityModelFit,
  sanitize,
  seedAllSystemJobs,
  systemJobProblem,
  wrapUntrusted,
} from '@ethosagent/wiring';
import { appendErrorLog } from '../error-log';
import { createAcpMcpWiring } from '../lib/acp-mcp-wiring';
import { DeferredToolRegistry } from '../lib/deferred-tool-registry';
import { bumpKanbanHeartbeats, KanbanPollLoop, writeRunActivityComments } from '../lib/kanban-poll';
import { resolveSkillsCatalogDir } from '../lib/resolve-skills-catalog-dir';
import { emitReady } from '../logger';
import { applyPauseCorrections, hasHeartbeatBump } from '../pause-corrections';
import { createPauseLifecycle } from '../pause-lifecycle';
import { notifyReady, startWatchdog } from '../sd-notify';
import {
  buildServeBusySources,
  buildSystemTaskHandlers,
  createAgentLoop,
  createLLM,
  createTeamAgentLoop,
  deriveIdleWatcherCapabilities,
  getEthosObservability,
  getFunnelTracker,
  getObservabilityStore,
  getSecretsResolver,
  getStorage,
} from '../wiring';
import { runCronTurn } from './cron-turn';
import { createA2aRunner } from './serve-a2a-runner';
import {
  a2aZeroSkillsWarning,
  parseFlagValue,
  parsePort,
  resolveAllowedOrigins,
  resolveCorsOrigins,
  resolveWebHost,
  resolveWebPort,
} from './serve-helpers';
import { formatNonLoopbackWarning, isLoopbackHost, listenWithFallback } from './serve-listen';

// `ethos serve` boots:
//   • ACP server on `--port` (default 3001) + mesh registration
//   • Web UI HTTP+SSE on `--web-port` (default 3000)
//
// Both servers share one `SessionStore` so chat from web and from ACP land
// in the same database. SIGINT / SIGTERM cleans up both before exiting.

const ACP_PORT_DEFAULT = 3001;
const WEB_PORT_FALLBACK_ATTEMPTS = 5;

// Resilience guard is installed once per process — runServe can be reached
// twice (onboarding mode then real mode), so guard against double-registration.
let resilienceGuardInstalled = false;

/** The voice slice `createAgentLoop`/`createTeamAgentLoop` hands back, as
 *  `runServe` holds it and as `buildServeWebApi` below receives it. */
type ServeVoiceConfig = {
  sttProviderName?: string;
  sttProviderConfig: Record<string, unknown>;
  ttsProviderName?: string;
  ttsProviderConfig: Record<string, unknown>;
  ttsRoster?: Record<string, import('@ethosagent/types').TtsProviderEntry>;
  sttRoster?: Record<string, import('@ethosagent/types').SttProviderEntry>;
  realtimeRoster?: Record<string, import('@ethosagent/types').RealtimeProviderEntry>;
  realtimeDefault?: string;
  tier?: 'pipeline' | 'realtime';
  realtimeSessionBudgetUsd?: number;
  trustedVoicePlugins?: ReadonlySet<string>;
};

export async function runServe(args: string[], config: EthosConfig | null): Promise<void> {
  installServeResilienceGuard();
  const acpPort = parsePort(parseFlagValue(args, ['--port']), ACP_PORT_DEFAULT);
  const webPort = resolveWebPort(args, process.env, config);
  const webHost = resolveWebHost(args, process.env, config);
  const corsOrigins = resolveCorsOrigins(process.env, config);
  const allowedOrigins = resolveAllowedOrigins(process.env);

  // WEB-006: only honor X-Forwarded-For for rate limiting behind a trusted
  // reverse proxy. Off by default — a directly-exposed server must never trust
  // the spoofable header. Opt in with ETHOS_TRUST_PROXY=1.
  const trustProxy =
    process.env.ETHOS_TRUST_PROXY === '1' || process.env.ETHOS_TRUST_PROXY === 'true';
  // WEB-010: mark the long-lived auth cookie `Secure` whenever the server is
  // reachable off-loopback (non-loopback bind) or fronted by HTTPS
  // (`webBaseUrl`). The loopback-http default (127.0.0.1 without https) keeps
  // `Secure` off so the cookie still works over plain http on localhost.
  const isLoopbackBind = isLoopbackHost(webHost);

  const dir = ethosDir();

  // System skills catalog: packaged at <pkg>/skills/ in production,
  // at <repo>/skills/ in dev. Env var overrides both.
  // Hoisted above the onboarding-mode check so both branches can use it.
  const skillsCatalogDir = resolveSkillsCatalogDir(import.meta.dirname);

  // Onboarding mode: no config yet — start the web server with a stub loop
  // so the UI can run the onboarding wizard.
  if (config === null) {
    const session = createSessionStore({ dataDir: dir });
    // No session data exists yet at this point regardless (onboarding hasn't
    // written config.yaml), so wiring this here is a harmless no-op — cheap
    // and consistent with the real path below, rather than a special case.
    const contextLog = new SQLiteContextLog(join(dir, 'sessions.db'));
    const personalities = await createPersonalityRegistry({
      storage: getStorage(),
      userPersonalitiesDir: dir,
    });
    await personalities.loadFromDirectory(join(dir, 'personalities'));
    const identityMap = new IdentityMap({ storage: new FsStorage(), dataDir: dir });
    // Lazy loader: stays as a stub until onboarding writes config, then
    // boots the real agent loop — eagerly when the wizard completes (via
    // `onSetupComplete` below), or on the first chat request — and caches it.
    let realLoop: AgentLoop | null = null;
    // Buffers createWebApi's tool registrations (dashboard tools) until
    // onboarding boots the real loop, then flushes them into its registry.
    const lazyToolRegistry = new DeferredToolRegistry();
    // Single-flight boot: concurrent callers await the same in-flight
    // attempt. Returns null while config is still missing; if the boot
    // itself throws, logs and resets so a later call can retry.
    let bootInFlight: Promise<AgentLoop | null> | null = null;
    const bootRealLoop = (): Promise<AgentLoop | null> => {
      if (realLoop) return Promise.resolve(realLoop);
      if (!bootInFlight) {
        bootInFlight = (async (): Promise<AgentLoop | null> => {
          try {
            const secrets = await getSecretsResolver();
            const loaded = await readConfig(getStorage(), secrets);
            if (!loaded) return null;
            const agentResult = await createAgentLoop(loaded);
            realLoop = agentResult.loop;
            if (agentResult.toolRegistry) lazyToolRegistry.setInner(agentResult.toolRegistry);
            return agentResult.loop;
          } catch (err) {
            console.error(
              `[serve] agent loop boot failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            return null;
          } finally {
            // No loop produced (config still missing or boot threw) —
            // clear the in-flight slot so the next call retries.
            if (!realLoop) bootInFlight = null;
          }
        })();
      }
      return bootInFlight;
    };
    const stubLoop = {
      run: async function* (text: string, opts: Record<string, unknown> = {}) {
        const loop = await bootRealLoop();
        if (loop) {
          yield* loop.run(text, opts as never);
        } else {
          yield {
            type: 'error' as const,
            error: 'Setup required — complete onboarding first.',
            code: 'SETUP_REQUIRED',
          };
        }
      },
    } as unknown as AgentLoop;

    const webDist = locateWebDist(parseFlagValue(args, ['--web-dist']));
    const attachmentCache = new FsAttachmentCache(
      new FsStorage(),
      join(dir, 'cache', 'attachments'),
    );
    void attachmentCache.pruneOlderThan(24 * 60 * 60 * 1000).catch(() => {});

    const created = createWebApi({
      dataDir: dir,
      attachmentCache,
      sessionStore: session,
      contextLog,
      memoryProvider: createMemoryProvider({
        dataDir: dir,
        storage: getStorage(),
        source: 'web-editor',
      }),
      identityMap,
      agentLoop: stubLoop,
      personalities,
      chatDefaults: { model: 'setup-required', provider: 'setup-required' },
      toolRegistry: lazyToolRegistry,
      // Eagerly boot the real loop once the wizard writes config.yaml so
      // the tool catalog and plugin tools are live before the first chat.
      onSetupComplete: () => {
        void bootRealLoop();
      },
      // W4.1 — first completed web turn stamps funnel.first_reply.
      onTurnDone: () => {
        void getFunnelTracker().recordFirstReply();
      },
      secureCookie: !isLoopbackBind,
      trustProxy,
      ...(skillsCatalogDir ? { catalogDir: skillsCatalogDir } : {}),
      ...(webDist ? { webDist } : {}),
    });
    const webApp = created.app;
    const tokens = new WebTokenRepository({ dataDir: dir, storage: getStorage() });
    const token = await tokens.getOrCreate();
    const { server, port } = await listenWithFallback(
      webApp,
      webPort,
      WEB_PORT_FALLBACK_ATTEMPTS,
      webHost,
    );
    const displayHost = webHost === '0.0.0.0' ? 'localhost' : webHost;
    console.log(`ethos web UI (onboarding mode) listening on http://${displayHost}:${port}`);
    console.log(`  admin: http://${displayHost}:${port}/admin`);
    if (webDist) {
      console.log(`  open: http://${displayHost}:${port}/auth/exchange?t=${token}`);
    } else {
      console.log(`  auth token: ${token}`);
      console.log('  no SPA build found — run `pnpm --filter @ethosagent/web dev` for HMR,');
      console.log(`    then visit http://localhost:5173/auth/exchange?t=${token}`);
    }
    // Reported against the bound port, not the requested one — listenWithFallback
    // may have walked forward on EADDRINUSE.
    const exposureWarning = formatNonLoopbackWarning(webHost, port);
    if (exposureWarning) console.warn(`\n${exposureWarning}`);

    emitReady('serve');
    notifyReady();
    const stopWatchdog = startWatchdog();

    const webShutdown = () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    const cleanup = async () => {
      if (stopWatchdog) stopWatchdog();
      // Deny + audit any suspended approval BEFORE the awaits below — the
      // auto-deny timers are unref'd and never fire on the way out.
      created.forceSettleApprovals();
      await webShutdown();
      process.exit(0);
    };
    process.on('SIGTERM', () => void cleanup());
    process.on('SIGINT', () => void cleanup());

    await new Promise(() => {});
    return;
  }

  // `serve` loads config via `readConfig`, which returns a bare `EthosConfig`
  // and no diagnostics — so every parse error and deprecation warning was
  // invisible in the one process where `cron.fireUrl` (and the rest) matters
  // most. `configParseNotices` is the read-side accessor for exactly this;
  // `ethos doctor` uses it the same way (doctor.ts).
  const configNotices = configParseNotices(config);
  for (const err of configNotices.errors) console.error(`config: ${err}`);
  for (const warn of configNotices.warnings) console.warn(`config: ${warn}`);

  const personalityOverride = parseFlagValue(args, ['--personality']);
  if (personalityOverride) config = { ...config, personality: personalityOverride };

  const modelOverride = parseFlagValue(args, ['--model']);
  if (modelOverride) config = { ...config, model: modelOverride };

  const teamFlag = parseFlagValue(args, ['--team']);
  const rawRole = parseFlagValue(args, ['--role']);
  if (rawRole !== undefined && rawRole !== 'coordinator' && rawRole !== 'member') {
    // Fail-closed: a typo in --role would otherwise silently disable the kanban
    // role gate. Better to crash the spawn loudly.
    console.error(`Invalid --role "${rawRole}". Must be "coordinator" or "member".`);
    process.exit(1);
  }
  const roleFlag: 'coordinator' | 'member' | undefined = rawRole as
    | 'coordinator'
    | 'member'
    | undefined;
  const meshName = parseFlagValue(args, ['--mesh']) ?? 'default';

  const loopProfile = 'web';

  let loop: AgentLoop;
  let toolRegistry: ToolRegistry | undefined;
  let mcpManager: McpManager | undefined;
  let pluginLoader: import('@ethosagent/plugin-loader').PluginLoader | undefined;
  let notificationRouter: import('@ethosagent/types').NotificationRouter | undefined;
  let activeMeshName: string;
  let activePersonality: string;
  let setOnSkillProposed:
    | ((fn: (skillId: string, personalityId: string) => void) => void)
    | undefined;
  let onMemoryCaptured:
    | import('@ethosagent/wiring').CreateAgentLoopResult['onMemoryCaptured']
    | undefined;
  let runCallCaptureFromLoop:
    | import('@ethosagent/wiring').CreateAgentLoopResult['runCallCapture']
    | undefined;
  let goalRunner: import('@ethosagent/goal-runner').GoalRunner | undefined;
  let jobStore: import('@ethosagent/types').JobStore | undefined;
  let backgroundExecutor:
    | import('@ethosagent/wiring').CreateAgentLoopResult['backgroundExecutor']
    | undefined;
  let jobRunners: import('@ethosagent/types').JobRunnerRegistry | undefined;
  let sttProviders: import('@ethosagent/types').SttProviderRegistry | undefined;
  let ttsProviders: import('@ethosagent/types').TtsProviderRegistry | undefined;
  let realtimeProviders: import('@ethosagent/types').RealtimeVoiceProviderRegistry | undefined;
  // Loop-registry refresh from createAgentLoop; undefined on the team-coordinator
  // path (createTeamAgentLoop has no personality registry to hot-reload).
  let refreshLoopPersonalities: (() => Promise<void>) | undefined;
  // The loop's SkillsInjector — backs `personalities.renderers`. Undefined on
  // the team-coordinator path, where the RPC degrades to no renderers.
  let skillsInjector: import('@ethosagent/skills').SkillsInjector | undefined;
  // The loop's execution-backend registry — backs the Settings Execution
  // probe. Undefined on the team-coordinator path, where the probe degrades to
  // `backend_unresolved` rather than testing a registry this process invented.
  let executionBackends: import('@ethosagent/types').ExecutionBackendRegistry | undefined;
  let voiceConfig: ServeVoiceConfig | undefined;
  // The voice stack, held only for its span writer: the browser realtime tier
  // records per-turn latency into the SAME writer the pipeline tier uses, so a
  // deployment has one voice-span buffer and one sink rather than two.
  let voiceStack: import('@ethosagent/wiring').VoiceStack | undefined;

  // Shared by the ACP server, the web API, and the cron `runJob` closure below
  // (which reads a web-origin session's bound personality before reusing its
  // key). Declared here so that closure has an in-scope binding, not a forward
  // reference to a later `const`.
  const session = createSessionStore({
    dataDir: dir,
    ...(config.retention ? { retention: config.retention } : {}),
  });

  // Phase E of plan/phases/model-visible-logged.md — fork copies context events
  // onto the child (D9). Same `sessions.db` file `session` uses, separate
  // handle — the same "same file, separate type" pattern SQLiteContextLog's own
  // file-header comment documents (WAL mode makes concurrent handles safe). Not
  // closed on SIGINT/SIGTERM below, matching `session` itself, which also isn't.
  const contextLog = new SQLiteContextLog(join(dir, 'sessions.db'));

  // Cron scheduler — hoisted ABOVE the agent-loop construction so the
  // same scheduler instance can be threaded into createAgentLoop (registers
  // agent-callable `cron` tool against it) AND drive the web Cron tab's
  // firing engine below. The `runJob` closure forward-references `loop`;
  // the scheduler doesn't fire until `.start()` later, by which point
  // `loop` is assigned.
  let cronScheduler: CronScheduler | null = null;
  // chatService is bound after createWebApi; the scheduler's `runJob`
  // closes over a holder so any cron firing before the web surface is
  // ready is a silent no-op for the SSE push.
  let chatService: ChatService | null = null;
  let cronPersonalities: Awaited<ReturnType<typeof createPersonalityRegistry>> | null = null;
  // Watcher manager — constructed BEFORE the scheduler so its systemTask
  // handler rides the scheduler's `systemTasks` config (watcher ticks
  // piggyback on the cron scheduler; no second ticker). `ethos serve` has
  // no channel adapters, so `deliver` targets are unreachable here — log
  // loudly instead of dropping silently. `wake` drives the loop directly,
  // mirroring how cron prompt jobs run in this process.
  //
  // Pulled out to a named closure (rather than inline in the WatcherManager
  // config below) so the SAME wake path can also drive the call-capture
  // daemon's audit-trail leg further down — the daemon's own
  // `CallCaptureWakeEvent` is structurally identical to `WatcherWakeEvent`
  // (plan/phases/call-capture-extension.md decision 4), so one closure serves
  // both without a second copy of this logic.
  // `logs.level` — the lowest severity every ConsoleLogger built here prints.
  const logLevel = config.logs?.level;
  const watcherLogger = new ConsoleLogger({}, logLevel);
  const watcherWake = async (event: WatcherWakeEvent): Promise<void> => {
    if (!loop) return;
    const wrapped = wrapUntrusted({
      content: event.summary,
      toolName: 'watcher',
      source: `${event.watcherId}:${event.target}`,
    });
    const prompt = sanitize(
      `${event.promptPrefix ?? 'A watcher you own detected a change.'}\n\n${wrapped.content}`,
    );
    const sessionKey = `watcher:${event.watcherId}:${new Date().toISOString()}`;
    for await (const _event of loop.run(prompt, {
      sessionKey,
      personalityId: event.personalityId,
    })) {
      // Drain — a woken agent acts through its tools; no surface consumes
      // this stream in `ethos serve`.
    }
  };
  const watcherManager = new WatcherManager({
    storage: getStorage(),
    logger: watcherLogger,
    deliver: async (target) => {
      watcherLogger.warn(
        `[watcher] deliver to ${target.platform}:${target.chatId} unavailable — 'ethos serve' has no channel adapters; run 'ethos gateway' for channel delivery`,
      );
    },
    wake: watcherWake,
  });
  cronScheduler = new CronScheduler({
    storage: getStorage(),
    logger: new ConsoleLogger({}, logLevel),
    ...(config.cron?.maxParallelJobs !== undefined
      ? { maxParallelJobs: config.cron.maxParallelJobs }
      : {}),
    // Script/precheck jobs execute through the same local backend class the
    // execution tools use — never raw child_process in the scheduler.
    executionBackend: new LocalExecutionBackend({
      config: {},
      secrets: await getSecretsResolver(),
      logger: new ConsoleLogger({}, logLevel),
    }),
    systemTasks: { ...buildSystemTaskHandlers(config), ...watcherManager.systemTasks() },
    onDecision: (job, d) => {
      try {
        getEthosObservability().recordHeartbeatDecision({
          personalityId: job.personalityId,
          jobId: job.id,
          decision: d.action,
          delivered: d.delivered,
        });
      } catch {
        // observability unavailable — audit is fail-open
      }
    },
    runJob: async (job) => {
      if (!loop) {
        throw new EthosError({
          code: 'INTERNAL',
          cause: 'Agent loop not yet initialised at cron firing time',
          action:
            'This is a wiring bug — the scheduler started before the agent loop was assigned. File an issue.',
        });
      }
      // Recursion guard: exclude 'cron' from the effective toolset so
      // cron-spawned sessions cannot schedule further cron jobs.
      // Refresh-before-use (not create-once-cache-forever) so a personality
      // created/edited after boot is honored the next time cron fires.
      if (!cronPersonalities) {
        cronPersonalities = await createPersonalityRegistry(getStorage());
      }
      await cronPersonalities.loadFromDirectory(join(ethosDir(), 'personalities'));
      const pid = job.personalityId;
      const pers = cronPersonalities.get(pid);
      const toolsetOverride = pers?.toolset?.filter((t: string) => t !== 'cron');

      const webOrigin =
        job.origin?.platform === 'web' && job.origin.chatId ? job.origin.chatId : null;
      const ranAt = new Date().toISOString();
      const { sessionKey, output, reusedWebOrigin } = await runCronTurn({
        loop,
        sessions: session,
        jobId: job.id,
        prompt: job.prompt ?? '',
        personalityId: pid,
        webOrigin,
        ...(toolsetOverride ? { toolsetOverride } : {}),
      });
      if (chatService) {
        chatService.broadcastAll({
          type: 'cron.fired',
          jobId: job.id,
          ranAt,
          outputPath: null,
          // Only point the client at the web session when the turn actually
          // ran there; a personality-mismatched firing lives elsewhere.
          ...(reusedWebOrigin && webOrigin ? { sessionKey: webOrigin } : {}),
        });
      }
      return { jobId: job.id, ranAt, output, sessionKey };
    },
  });
  // Late-bind the scheduler into the watcher manager (the manager was
  // constructed first so its systemTask handler could ride the scheduler
  // config above). Backing jobs are seeded by `watcherManager.start()` later.
  watcherManager.attachScheduler(cronScheduler);

  // Cron trigger seam (plan/phases/cron-fire-url-collapse.md). `cronScheduler`
  // is the `CronEngine`; the presence of `cron.fireUrl` is the whole mode
  // switch — absent → the in-process interval, present → external mode where
  // something outside this process drives `POST /cron/fire`. `ethos serve`
  // mounts that route, so it passes `hasHttpSurface: true` and the fire URL is
  // honoured here (D1). `external` is threaded into `createWebApi` below
  // unconditionally: config no longer gates the route, the `cron` scope on a
  // bearer key does (D2).
  const cronTriggers: CronTriggers = buildCronTriggers(cronScheduler, config.cron, {
    hasHttpSurface: true,
  });
  // Boot-log the mode notice so a remote deployment whose external caller
  // never arrives is diagnosable from its own log rather than from silence.
  for (const notice of cronTriggers.notices) console.warn(notice);
  // Late-bind the arming backend `buildCronTriggers` just produced back onto
  // the scheduler it was built from — see `CronScheduler.setArmingBackend`.
  cronScheduler.setArmingBackend(cronTriggers.arming);

  if (teamFlag && personalityOverride) {
    // Plan B member spawn — supervisor spawns each member with
    //   ethos serve --personality <member> --team <name> --role <role>
    // Keep the named personality (don't force coordinator) but apply team context
    // so the kanban store routes to the team board and the role hook fires.
    activeMeshName = meshName === 'default' ? teamFlag : meshName;
    activePersonality = personalityOverride;
    const result = await createAgentLoop(
      { ...config, teamName: teamFlag, ...(roleFlag ? { role: roleFlag } : {}) },
      {
        profile: loopProfile,
        meshRegistryPath: meshRegistryPath(activeMeshName),
        ...(cronScheduler ? { cronScheduler } : {}),
        watcherManager,
      },
    );
    loop = result.loop;
    toolRegistry = result.toolRegistry;
    mcpManager = result.mcpManager;
    pluginLoader = result.pluginLoader;
    notificationRouter = result.notificationRouter;
    setOnSkillProposed = result.setOnSkillProposed;
    onMemoryCaptured = result.onMemoryCaptured;
    runCallCaptureFromLoop = result.runCallCapture;
    goalRunner = result.goalRunner;
    jobStore = result.jobStore;
    backgroundExecutor = result.backgroundExecutor;
    jobRunners = result.jobRunners;
    sttProviders = result.sttProviders;
    ttsProviders = result.ttsProviders;
    realtimeProviders = result.realtimeProviders;
    voiceConfig = result.voiceConfig;
    voiceStack = result.voiceStack;
    refreshLoopPersonalities = result.refreshPersonalities;
    skillsInjector = result.skillsInjector;
    executionBackends = result.executionBackends;
  } else if (teamFlag) {
    // Chat UX: `ethos serve --team <name>` → run as the team's coordinator.
    const {
      loop: teamLoop,
      toolRegistry: teamToolRegistry,
      coordinatorPersonality,
      meshName: teamMesh,
      setOnSkillProposed: teamSetOnSkillProposed,
      pluginLoader: teamPluginLoader,
      notificationRouter: teamNotificationRouter,
      runCallCapture: teamRunCallCapture,
    } = await createTeamAgentLoop(config, teamFlag, {
      profile: loopProfile,
      ...(roleFlag ? { role: roleFlag } : {}),
    });
    loop = teamLoop;
    toolRegistry = teamToolRegistry;
    activeMeshName = teamMesh;
    activePersonality = coordinatorPersonality;
    setOnSkillProposed = teamSetOnSkillProposed;
    pluginLoader = teamPluginLoader;
    notificationRouter = teamNotificationRouter;
    // Round-3 Issue 2 — this branch previously never assigned
    // runCallCaptureFromLoop at all, so the daemon-construction gate below
    // (which requires it) silently skipped call capture in coordinator mode
    // even when callCapture.personalityId was configured. Threaded through
    // createTeamAgentLoop now (see apps/ethos/src/wiring.ts).
    runCallCaptureFromLoop = teamRunCallCapture;
  } else {
    activeMeshName = meshName;
    activePersonality = config.personality;
    const result = await createAgentLoop(config, {
      profile: loopProfile,
      meshRegistryPath: meshRegistryPath(activeMeshName),
      ...(cronScheduler ? { cronScheduler } : {}),
      watcherManager,
    });
    loop = result.loop;
    toolRegistry = result.toolRegistry;
    mcpManager = result.mcpManager;
    pluginLoader = result.pluginLoader;
    notificationRouter = result.notificationRouter;
    setOnSkillProposed = result.setOnSkillProposed;
    onMemoryCaptured = result.onMemoryCaptured;
    runCallCaptureFromLoop = result.runCallCapture;
    goalRunner = result.goalRunner;
    jobStore = result.jobStore;
    backgroundExecutor = result.backgroundExecutor;
    jobRunners = result.jobRunners;
    sttProviders = result.sttProviders;
    ttsProviders = result.ttsProviders;
    realtimeProviders = result.realtimeProviders;
    voiceConfig = result.voiceConfig;
    voiceStack = result.voiceStack;
    refreshLoopPersonalities = result.refreshPersonalities;
    skillsInjector = result.skillsInjector;
    executionBackends = result.executionBackends;
  }
  let titleFn: ((systemPrompt: string, userMessage: string) => Promise<string>) | undefined;
  try {
    const titleLlm = await createLLM(config);
    titleFn = async (systemPrompt: string, userMessage: string): Promise<string> => {
      let text = '';
      for await (const chunk of titleLlm.complete([{ role: 'user', content: userMessage }], [], {
        system: systemPrompt,
        maxTokens: 64,
      })) {
        if (chunk.type === 'text_delta') text += chunk.text;
      }
      return text.trim();
    };
  } catch (err) {
    console.warn('[ethos] session auto-title disabled: failed to create title LLM:', err);
  }

  const mesh = new AgentMesh(meshRegistryPath(activeMeshName), { storage: getStorage() });

  const personalities = await createPersonalityRegistry({
    storage: getStorage(),
    userPersonalitiesDir: dir,
  });
  await personalities.loadFromDirectory(join(dir, 'personalities'));

  // Team members (and team coordinators — both boot through this same shared
  // path) are dispatch targets for the team-supervisor's `Dispatcher`, which
  // authenticates to this ACP server with a bearer token resolved via
  // `SecretsResolver` (see `extensions/team-supervisor/src/dispatcher.ts`).
  // Without this, `AcpServer` still enforces a bearer token — it just falls
  // back to a fresh `randomBytes(32)` value that is never shared with
  // anyone, so a zero-config team could never actually dispatch. Generate the
  // SAME token that gets passed to the constructor below, store its value
  // via SecretsResolver (S9 — the mesh registry only ever gets the ref by
  // name), and regenerate fresh on every boot: the mesh entry itself is
  // already re-created per-process (`agentId` below is pid+uuid scoped), so
  // there is nothing relying on token stability across restarts, and
  // always-fresh avoids any "stale ref pointing at an old secret" bookkeeping.
  // Solo `ethos serve` (no `--team`) is never a Dispatcher target, so it keeps
  // the existing behavior unchanged (no ref stored, `AcpServer` self-generates).
  let teamAuthToken: string | undefined;
  let teamAuthTokenRef: string | undefined;
  if (teamFlag) {
    teamAuthToken = randomBytes(32).toString('hex');
    teamAuthTokenRef = `mesh/${activeMeshName}/${activePersonality}`;
    await (await getSecretsResolver()).set(teamAuthTokenRef, teamAuthToken);
  }

  // ACP server (existing behavior — kept first so any breakage is obvious).
  // The MCP session-grant wiring is omitted on the team-coordinator path,
  // which has no McpManager — `session/registerMcpServers` then fails closed.
  const acpServer = buildServeAcpServer({
    dir,
    loop,
    session,
    mesh,
    personalities,
    activePersonality,
    teamFlag,
    mcpManager,
    jobStore,
    backgroundExecutor,
    teamAuthToken,
  });
  acpServer.startHttp(acpPort);

  const personalityConfig = personalities.get(activePersonality);
  const capabilities = personalityConfig?.capabilities ?? [];

  const agentId = `${activePersonality}:${process.pid}:${randomUUID().slice(0, 8)}`;
  await mesh.register({
    agentId,
    capabilities,
    model: config.model, // Phase 3: already reflects any --model override applied above
    pid: process.pid,
    host: 'localhost',
    port: acpPort,
    activeSessions: 0,
    personalityId: activePersonality,
    displayName: personalityConfig?.name ?? activePersonality,
    boardSubscriptions: teamFlag ? [{ board: teamFlag }] : [{ board: 'global' }],
    ...(teamAuthTokenRef ? { authTokenRef: teamAuthTokenRef } : {}),
  });
  const stopHeartbeat = mesh.startHeartbeat(agentId, () => acpServer.activeSessionCount);

  const serveLabel = teamFlag ? `team:${teamFlag}` : activePersonality;
  console.log(`ethos ACP server listening on http://localhost:${acpPort}`);
  console.log(`  agent:        ${agentId}`);
  console.log(`  personality:  ${serveLabel}`);
  console.log(`  mesh:         ${activeMeshName}`);
  console.log(`  capabilities: ${capabilities.length > 0 ? capabilities.join(', ') : '(none)'}`);
  console.log(`  WebSocket:    ws://localhost:${acpPort}/ws`);

  // Kanban poll loop — reconcile-on-wake for missed /notify calls.
  let stopPollLoop: (() => void) | null = null;
  // Captured for the resume-boundary correction below (gates #6/#7). The poll
  // loop opens a fresh `KanbanStore` per tick rather than holding one, so the
  // board PATH is the only durable handle there is to correct against.
  let correctableBoardPath: string | undefined;
  const kanbanPollEnabled = config.kanbanPoll?.enabled !== false; // enabled by default
  if (kanbanPollEnabled) {
    const boardPath =
      config.kanbanPoll?.boardPath ??
      (teamFlag ? join(dir, 'teams', teamFlag, 'board.db') : join(dir, 'board.db'));

    if (boardPath) {
      correctableBoardPath = boardPath;
      const lane = new SessionLane();
      const pollLoop = new KanbanPollLoop({
        boardPath,
        personalityId: activePersonality,
        lane,
        runner: async (prompt, sessionKey, taskId, taskTitle) => {
          await writeRunActivityComments(
            boardPath,
            taskId,
            activePersonality,
            loop.run(prompt, { sessionKey, personalityId: activePersonality }),
            (err) => console.warn(`[kanban-poll] comment write failed: ${err.message}`),
          );
          try {
            const s = await session.getSessionByKey(sessionKey);
            if (s && !s.title) await session.updateSession(s.id, { title: taskTitle });
          } catch (err) {
            console.warn(
              `[kanban-poll] set title failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
        intervalMs: config.kanbanPoll?.intervalMs,
        onError: (err) => {
          console.warn(`[kanban-poll] tick error: ${err.message}`);
        },
      });
      pollLoop.start();
      stopPollLoop = () => pollLoop.stop();
      console.log(
        `  kanban poll:  enabled (${config.kanbanPoll?.intervalMs ?? 5000}ms, ${boardPath})`,
      );
    }
  }

  // Langfuse export poller (Part E) — opt-in, off by default.
  let stopLangfusePoll: (() => void) | null = null;
  const langfuseCfg = config.telemetry?.export?.langfuse;
  if (langfuseCfg?.enabled) {
    if (!langfuseCfg.baseUrl || !langfuseCfg.publicKey || !langfuseCfg.secretKey) {
      console.error(
        '[langfuse-export] telemetry.export.langfuse.enabled is true but baseUrl/publicKey/secretKey ' +
          'are not all set — not starting the export poller.',
      );
    } else {
      const langfusePoll = new LangfusePollLoop({
        store: getObservabilityStore(),
        baseUrl: langfuseCfg.baseUrl,
        publicKey: langfuseCfg.publicKey,
        secretKey: langfuseCfg.secretKey,
        onError: (err) => console.warn(`[langfuse-export] tick error: ${err.message}`),
      });
      langfusePoll.start();
      stopLangfusePoll = () => langfusePoll.stop();
      console.log(`  langfuse export: enabled (${langfuseCfg.baseUrl})`);
    }
  }

  // Web API — always mounts alongside the ACP server.
  let webShutdown: (() => Promise<void>) | null = null;
  const webDist = locateWebDist(parseFlagValue(args, ['--web-dist']));

  // Start the cron scheduler now — `loop` is assigned, and we'll bind
  // `chatService` to the value returned by createWebApi below.
  cronTriggers.local?.start();

  // Load watchers.json and seed the backing `source:'system'` tick jobs.
  // Idempotent — existing jobs are re-registered so interval edits apply.
  void watcherManager.start().catch((err) => {
    console.error('[watcher] failed to start watcher manager:', err);
  });

  // Reconcile the system cron jobs against config (plan D7). Not just a
  // seeder: a schedule edited in config.yaml is patched onto the existing job,
  // and a feature switched off has its job removed instead of firing forever.
  // Only the jobs in that table are touched — watcher ticks are seeded per
  // watcher by the watcher manager and are left alone.
  //
  // `'serve'` is load-bearing, not decoration. This process runs no channel
  // adapters, so `channel-digest` is absent from its roster — NOT listed
  // disabled, which would delete the job `ethos gateway` seeded, on every
  // restart of either. See `SystemJobSurface` in `@ethosagent/wiring`.
  if (cronScheduler) {
    void seedAllSystemJobs(cronScheduler, config, 'serve')
      .then((outcomes) => {
        for (const o of outcomes) {
          const problem = systemJobProblem(o);
          if (problem) console.error(`[cron] ${problem}`);
        }
      })
      .catch((err) => {
        console.error('[cron] system job reconciliation failed:', err);
      });
  }

  // OpenAI-compat surface (F1+F2). Shares sessions.db so `ethos api-key`
  // and `ethos serve` see the same rows.
  const apiKeys = new SqliteApiKeyStore(join(dir, 'sessions.db'));
  // Idempotency cache for `POST /v1/chat/completions` retries — same db,
  // same rationale.
  const idempotencyStore = new IdempotencyStore(join(dir, 'sessions.db'));

  const identityMap = new IdentityMap({ storage: new FsStorage(), dataDir: dir });
  await identityMap.resolve('desktop', 'desktop', 'Desktop');

  const attachmentCache = new FsAttachmentCache(new FsStorage(), join(dir, 'cache', 'attachments'));
  void attachmentCache.pruneOlderThan(24 * 60 * 60 * 1000).catch(() => {});

  const a2a = await buildServeA2aCore({
    config,
    dir,
    loop,
    personalities,
    activePersonality,
  });
  const { isA2aEnabled } = a2a;

  // Call-capture daemon (plan/phases/call-capture-extension.md, "Phase 4 —
  // Integration"). macOS-only, opt-in via `callCapture.personalityId` —
  // constructing nothing at all otherwise, mirroring `MicActivityDetector`'s
  // own platform guard at a higher level. `loop` is fully assigned by this
  // point (same ordering constraint `watcherWake` already relies on above —
  // it closes over `loop` too, and `wake` is only ever invoked later once a
  // real event fires). `runCallCaptureFromLoop` mirrors the same gate
  // (`isCallCaptureToolsEnabled` in `packages/wiring/src/build-agent-loop.ts`
  // is platform+config identical to the condition below), so the extra check
  // here is purely defensive: never construct the daemon with an undefined
  // `runCapture`.
  // Liveness heartbeat for `ethos doctor`'s `checkCallCaptureDaemonHealth`
  // (mirrors the gateway's own `gateway-health.json` heartbeat) — same 10s
  // cadence is reused below as the ownership-claim retry interval too (P0,
  // plan/phases/call-capture-desktop-ux.md — don't invent a second interval).
  const CALL_CAPTURE_HEARTBEAT_INTERVAL_MS = 10_000;
  let callCaptureOwnershipManager: CallCaptureOwnershipManager | undefined;
  // Last known daemon state, for the idle watcher's `callCaptureActive`
  // busy-source below — a call actually in progress right now, not a
  // permanent capability-level refusal. Stays 'idle' when no daemon is ever
  // constructed for this deployment (non-darwin, or opted out).
  let callCaptureState: DaemonState = { kind: 'idle' };
  if (
    process.platform === 'darwin' &&
    config.callCapture?.personalityId &&
    runCallCaptureFromLoop
  ) {
    // Round-3 Issue 1 — `ethos serve` and `ethos gateway` can both be
    // configured with `callCapture.personalityId` at once (e.g. one under a
    // LaunchAgent, the other under `ethos run-all`, which starts both by
    // default). At most one process may run a live `CallCaptureDaemon`, or
    // they fight over the same Process Tap/mic and stomp each other's
    // shared heartbeat file. Losing the claim is a normal, expected outcome
    // — not an error. `CallCaptureOwnershipManager` logs it and keeps
    // retrying on `CALL_CAPTURE_HEARTBEAT_INTERVAL_MS` until it wins (P0:
    // the previous single-attempt claim left a process permanently
    // daemon-less if it lost the race at launch, even after the winner
    // later exited and released the lock).
    const boundPersonalityId = config.callCapture.personalityId;
    const captureRunner = runCallCaptureFromLoop;
    callCaptureOwnershipManager = new CallCaptureOwnershipManager({
      lockPath: callCaptureLockPath(dir),
      retryIntervalMs: CALL_CAPTURE_HEARTBEAT_INTERVAL_MS,
      logger: watcherLogger,
      onOwnershipClaimed: () => {
        const callCaptureDaemon = new CallCaptureDaemon({
          detector: new MicActivityDetector(),
          notificationGate: new NotificationGate(),
          checkDependencies: checkCallCaptureDependencies,
          // No separate process-prefilter gate here — the native detector
          // (extensions/platform-callcapture/native/mic-detector.swift) only
          // ever watches known calling apps in the first place, so every
          // call_started event it produces is already scoped to one, with its
          // resolved source label riding along on the event itself. Known
          // limitation, documented in the package README: this cannot see a
          // browser-based call (e.g. Meet in Chrome).
          personalityId: boundPersonalityId,
          wake: watcherWake,
          // Floating on-screen recording indicator (plan/phases/
          // call-capture-desktop-ux.md) — the headless-CLI analog of the
          // desktop app's Electron-based pill. Fresh per ownership claim,
          // mirroring detector/notificationGate above.
          indicator: new CaptureIndicator({
            onError: (msg) => watcherLogger.warn(`call-capture: ${msg}`),
          }),
          runCapture: async (abortSignal, source, onEntry, onAudioLevel) => {
            const result = await captureRunner(boundPersonalityId, {
              abortSignal,
              source,
              onEntry,
              onAudioLevel,
            });
            if (!result.ok) {
              watcherLogger.error(`call-capture: capture failed: ${result.error}`);
              return;
            }
            if (result.warning) watcherLogger.warn(`call-capture: ${result.warning}`);
            watcherLogger.info(`call-capture: saved transcript to ${result.artifactKey}`);
          },
          logger: watcherLogger,
          onStateChange: (state) => {
            callCaptureState = state;
          },
        });
        callCaptureDaemon.start();

        const writeCallCaptureHeartbeat = async () => {
          try {
            await getStorage().writeAtomic(
              callCaptureHealthPath(dir),
              JSON.stringify({ pid: process.pid, updatedAt: new Date().toISOString() }),
            );
          } catch {
            // Best-effort — a missed tick is harmless; the consumer treats
            // stale/absent data as degraded.
          }
        };
        void writeCallCaptureHeartbeat();
        const callCaptureHeartbeatTimer = setInterval(
          () => void writeCallCaptureHeartbeat(),
          CALL_CAPTURE_HEARTBEAT_INTERVAL_MS,
        );
        callCaptureHeartbeatTimer.unref?.();

        return async () => {
          callCaptureState = { kind: 'idle' };
          callCaptureDaemon.stop();
          clearInterval(callCaptureHeartbeatTimer);
          await getStorage()
            .remove(callCaptureHealthPath(dir))
            .catch(() => {});
        };
      },
    });
    callCaptureOwnershipManager.start();
  }

  const {
    routeModules: a2aRouteModules,
    peering: a2aPeering,
    setA2aEnabled,
  } = buildServeA2aSurface({ config, core: a2a, toolRegistry });

  // P2-counters (D2/D16) — `ethos_gateway_adapter_up{adapter}` reads the same
  // heartbeat file `/healthz` does, through the same 30s staleness gate
  // (routes/index.ts) — stale ⇒ every known adapter reports 0.
  const readGatewayAdapterGauges = async () => {
    try {
      const raw = await getStorage().read(join(dir, 'gateway-health.json'));
      if (!raw) return [];
      const hb = JSON.parse(raw) as {
        updatedAt: string;
        adapters: Array<{ name: string; ok: boolean }>;
      };
      const ageSec = (Date.now() - new Date(hb.updatedAt).getTime()) / 1000;
      const stale = !Number.isFinite(ageSec) || ageSec > 30;
      return hb.adapters.map(
        (a) => ({ adapter: a.name, up: (stale ? false : a.ok) ? 1 : 0 }) as const,
      );
    } catch {
      return [];
    }
  };
  const metricsText = createMetricsTextProvider({
    store: getObservabilityStore(),
    getGatewayAdapters: readGatewayAdapterGauges,
  });
  // P2-counters — ethos_http_requests_total. A plain closure over the same
  // store `metricsText` reads from, same threading as `metricsText` itself.
  const recordHttpRequest = (method: string, status: number): void => {
    getObservabilityStore().recordHttpRequest(method, status);
  };

  // Team-scoped loops for web chat (plan/phases/teams-as-a-scope.md D4, §9).
  // web-api never composes a loop (Law 5); it asks this factory for one per
  // team, on the first turn of a personality that belongs to that team.
  //
  // ONE loop per team, built as the coordinator. The role gate
  // (`createKanbanRoleGateHook`, extensions/tools-kanban/src/role-gate.ts)
  // resolves the caller PER TURN: the loop stamps the turn's personality on
  // every `before_tool_call` payload, and `createTeamAgentLoop` hands the
  // gate the manifest's coordinator id, so a turn is authorised as
  // `coordinator` iff its personality is the coordinator, else `member`
  // (plan §9). A member completing its own ticket from the web is therefore
  // allowed, and a member's turn cannot reach coordinator-only tools. The
  // coordinator prompt (`before_prompt_build`) keys on the turn's personality
  // the same way, so member turns do not get it.
  //
  // Not threaded (same as the `--team` coordinator path above): serve's cron
  // scheduler and watcher manager, so the agent-callable `cron`/`watcher_*`
  // tools on a team loop are not bound to this process's engines.
  const createTeamLoop = async (teamName: string): Promise<TeamLoopHandle> => {
    const team = await createTeamAgentLoop(config, teamName, {
      profile: loopProfile,
      role: 'coordinator',
    });
    return {
      loop: team.loop,
      refreshPersonalities: team.refreshPersonalities,
      notificationRouter: team.notificationRouter,
    };
  };

  const created = buildServeWebApi({
    config,
    dir,
    loop,
    session,
    contextLog,
    personalities,
    identityMap,
    attachmentCache,
    apiKeys,
    idempotencyStore,
    createTeamLoop,
    // With `--team`, `loop` IS that team's loop already; keep that behaviour
    // and let the registry skip it.
    ...(teamFlag ? { mainLoopTeam: teamFlag } : {}),
    toolRegistry,
    mcpManager,
    pluginLoader,
    notificationRouter,
    cronScheduler,
    cronTriggers,
    goalRunner,
    jobStore,
    jobRunners,
    backgroundExecutor,
    setOnSkillProposed,
    onMemoryCaptured,
    refreshLoopPersonalities,
    skillsInjector,
    executionBackends,
    skillsCatalogDir,
    sttProviders,
    ttsProviders,
    realtimeProviders,
    voiceConfig,
    voiceStack,
    titleFn,
    corsOrigins,
    allowedOrigins,
    trustProxy,
    isLoopbackBind,
    webDist,
    metricsText,
    recordHttpRequest,
    a2aRouteModules,
    a2aPeering,
    isA2aEnabled,
    setA2aEnabled,
  });
  chatService = created.chatService;
  const webApp = created.app;
  const tokens = new WebTokenRepository({ dataDir: dir, storage: getStorage() });
  const token = await tokens.getOrCreate();
  const { server, port } = await listenWithFallback(
    webApp,
    webPort,
    WEB_PORT_FALLBACK_ATTEMPTS,
    webHost,
  );
  // Talk-mode's persistent binary lane (`GET /voice/ws`). Same server, same
  // auth cookie; unattached it simply 404s and the browser uses the batch RPCs.
  created.voiceSocket.attach(server);
  // The wake-satellite lane (`GET /satellite/ws`). Shares the upgrade router
  // with the voice lane above, so attach order does not matter and neither
  // path can swallow the other's upgrade.
  created.satelliteSocket.attach(server);
  console.log('');
  const displayHost = webHost === '0.0.0.0' ? 'localhost' : webHost;
  console.log(`ethos web UI listening on http://${displayHost}:${port}`);
  console.log(`  admin: http://${displayHost}:${port}/admin`);
  if (webDist) {
    console.log(`  open: http://${displayHost}:${port}/auth/exchange?t=${token}`);
    console.log('  (token rotates on first use; cookie remains the steady-state credential)');
    console.log(`  serving SPA from: ${webDist}`);
  } else {
    console.log(`  auth token: ${token}`);
    console.log('  (token rotates on first use; cookie remains the steady-state credential)');
    console.log('  no SPA build found — run `pnpm --filter @ethosagent/web dev` for HMR,');
    console.log(`    then visit http://localhost:5173/auth/exchange?t=${token}`);
    console.log('  or `pnpm --filter @ethosagent/web build` to bundle into this server.');
  }
  // Reported against the bound port, not the requested one — listenWithFallback
  // may have walked forward on EADDRINUSE.
  const exposureWarning = formatNonLoopbackWarning(webHost, port);
  if (exposureWarning) console.warn(`\n${exposureWarning}`);
  webShutdown = () =>
    Promise.all([
      created.voiceSocket.close(),
      created.satelliteSocket.close(),
      created.disposeTeamLoops(),
    ]).then(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    );

  emitReady('serve');
  notifyReady();
  const stopWatchdog = startWatchdog();

  // Idle watcher — declared here only so `cleanup` can stop its interval. It
  // is CONSTRUCTED below the signal handlers, after every subsystem it reads
  // (plan/phases/idle-watcher.md §5).
  let idleWatcher: IdleWatcherManager | undefined;

  // ONE per process (see `pause-lifecycle.ts`): a `NoopPauseLifecycle` unless
  // the operator enabled `pauseClockCorrection`, in which case it is a started
  // clock-drift detector. Declared here so `cleanup` can stop its timer.
  const pauseLifecycle = createPauseLifecycle(config);

  // Resume-boundary clock corrections (plan/phases/clock-tolerance-pass.md §3/§4).
  //
  // `runServe` never calls `runBootReconciliation`, so this registration is the
  // only thing that corrects a gate in this process — and it owns the pass's
  // highest-stakes one. §3.1: an uncorrected `findStaleRunningTasks` cancels the
  // open run and flips the task back to `ready`, and the re-claim increments
  // `retry_count`. A task near `max_retries` when the host slept can be pushed
  // into a hard failure state having done nothing wrong. The poll loop's
  // threshold is 30 min; any real pause clears it on the very next tick.
  //
  // The store is opened per correction and closed again, mirroring the poll
  // loop's own per-tick `new KanbanStore(boardPath)` — holding one open across
  // the pause would be a second long-lived writer on a file the loop already
  // reopens every second.
  pauseLifecycle.onResume?.((pauseDurationMs) => {
    const boardPath = correctableBoardPath;
    void applyPauseCorrections(
      {
        ...(hasHeartbeatBump(jobStore) ? { jobStore } : {}),
        ...(boardPath
          ? { kanbanStore: { bumpActiveHeartbeats: (ms) => bumpKanbanHeartbeats(boardPath, ms) } }
          : {}),
      },
      pauseDurationMs,
      new ConsoleLogger({}, logLevel),
    );
  });

  const cleanup = async () => {
    if (stopWatchdog) stopWatchdog();
    // Deny + audit any suspended approval FIRST, before the awaits below —
    // the auto-deny timers are unref'd and never fire on the way out, and a
    // later await that hangs must not cost the audit row.
    created.forceSettleApprovals();
    stopHeartbeat();
    stopPollLoop?.();
    stopLangfusePoll?.();
    // Stops the daemon + heartbeat (if this process ever won the ownership
    // claim, including via a later retry tick — see
    // `CallCaptureOwnershipManager`) and releases the lock so a restarted
    // process, or the other host command, can take it.
    await callCaptureOwnershipManager?.stop();
    await mesh.unregister(agentId);
    idleWatcher?.stop();
    pauseLifecycle.stop?.();
    cronTriggers.local?.stop();
    if (webShutdown) await webShutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => void cleanup());
  process.on('SIGINT', () => void cleanup());

  // Idle watcher (plan/phases/idle-watcher.md §5) — CONSTRUCTED LAST, after
  // every subsystem its sources read, and only when the operator opted in.
  // Unlike `watchers`/`cron` this is not always-constructed: on a laptop or a
  // bare-metal box there is no host to suspend into, so it should not exist at
  // all in the common case. The onboarding branch above returns before this,
  // and has no config to opt in with.
  if (config.idleWatcher?.enabled === true) {
    idleWatcher = new IdleWatcherManager({
      sources: buildServeBusySources({
        chatService: created.chatService,
        voiceSocket: created.voiceSocket,
        satelliteSocket: created.satelliteSocket,
        pendingApprovalCount: created.pendingApprovalCount,
        backgroundExecutor,
        jobStore,
        cronScheduler: cronScheduler ?? undefined,
        // Flat layout: `pidFilePath(name)` in @ethosagent/team-supervisor
        // resolves to `<teamsDir()>/<name>.pid`, so this is the dir the PID
        // files it writes actually land in.
        teamsPidDir: teamsDir(),
        acpServer,
        callCaptureActive: callCaptureOwnershipManager
          ? () => callCaptureState.kind !== 'idle'
          : undefined,
      }),
      // The one instance for this process. Its outbound half is still a no-op:
      // a real host adapter that signals a Firecracker-style control plane is a
      // later phase, so the watcher's arming gates are what matter here.
      pauseLifecycle,
      // Flips to `true` when the `pauseLifecycle` above becomes a real host
      // adapter. While it is a no-op, `signalReadyToSuspend()` resolves,
      // latches, and stops the watcher having suspended nothing — so gate 3b
      // refuses to arm rather than accept that as a handoff.
      hostSignalAvailable: pauseLifecycle.hostSignalAvailable ?? false,
      capabilities: deriveIdleWatcherCapabilities(config),
      options: config.idleWatcher,
      logger: new ConsoleLogger({}, logLevel),
      // NO pre-suspend `mesh.unregister(agentId)` here. It is DESIRABLE —
      // peers keep routing into a suspended VM until the registry's 30s
      // `STALE_MS` prunes it — but it is not safe yet, because nothing
      // re-registers after a resume: `AgentMesh.heartbeat()` only UPDATES an
      // existing entry (unknown agentId is a silent no-op) and `register()`
      // runs once at boot, which a snapshot-resumed process never re-runs. So
      // unregistering would remove this instance permanently, which is worse
      // than the self-healing 30s window. Restore it once a resume path exists
      // (`runBootReconciliation()`, plan/phases/single-process-boot-profile.md)
      // AND agent-mesh can re-register.
    });
    // Fire-and-forget: `start()` evaluates the arming gates itself and is a
    // no-op (with a logged reason) when any of them refuses.
    idleWatcher.start();
  }

  await new Promise(() => {});
}

/**
 * Install process-level resilience handlers for the long-running web/ACP
 * server. A stray rejected SSE write (e.g. writing to a stream the browser
 * aborted on tab-switch) must NOT take down the server and drop every other
 * live stream. We log-and-continue here rather than exit — this is scoped to
 * the serve path only; one-shot CLI commands still fail loudly via the
 * top-level handler. Idempotent via `resilienceGuardInstalled`.
 */
function installServeResilienceGuard(): void {
  if (resilienceGuardInstalled) return;
  resilienceGuardInstalled = true;
  process.on('unhandledRejection', (reason) => {
    const cause = reason instanceof Error ? reason.message : String(reason);
    appendErrorLog(
      new EthosError({
        code: 'INTERNAL',
        cause: `Unhandled promise rejection: ${cause}`,
        action: 'A background promise rejected and was not awaited. The server kept running.',
      }),
      { command: 'serve' },
    );
    console.error(`[serve] unhandled rejection (kept alive): ${cause}`);
  });
  process.on('uncaughtException', (err) => {
    const cause = err instanceof Error ? err.message : String(err);
    appendErrorLog(
      new EthosError({
        code: 'INTERNAL',
        cause: `Uncaught exception: ${cause}`,
        action:
          'An uncaught exception was trapped by the serve resilience guard. The server kept running.',
      }),
      { command: 'serve' },
    );
    console.error(`[serve] uncaught exception (kept alive): ${cause}`);
  });
}

/**
 * Resolve the absolute path to the built SPA. Search order:
 *   1. `--web-dist <path>` flag (explicit, wins).
 *   2. Sibling to the bundled CLI: `<cliDist>/web/index.html` (the
 *      pre-publish hook that bundles the web app drops it here, per
 *      CEO finding 9.1).
 *   3. Monorepo dev path: `apps/web/dist/index.html` resolved up from
 *      `import.meta.dirname`.
 * Returns null when no candidate exists; the server skips the static
 * mount and prints a hint pointing devs at `pnpm dev:web`.
 */
export function locateWebDist(explicit: string | undefined): string | null {
  if (explicit) {
    const abs = pathResolve(explicit);
    return existsSync(join(abs, 'index.html')) ? abs : null;
  }
  const candidates = [
    pathResolve(import.meta.dirname, '..', 'web'),
    pathResolve(import.meta.dirname, '..', '..', '..', '..', 'apps', 'web', 'dist'),
    pathResolve(import.meta.dirname, '..', '..', '..', 'apps', 'web', 'dist'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

/**
 * Enumerate registered team names for `GET /v1/models`. Scoped to the
 * `dataDir` the server is actually using (not `~/.ethos/teams` blindly),
 * so isolated/test installations report only their own teams. Manifest
 * files live at `<dataDir>/teams/<name>.yaml`; `.runtime.yaml` is the
 * supervisor's runtime state, not a manifest.
 */
function listRegisteredTeams(dataDir: string): string[] {
  const teamsPath = join(dataDir, 'teams');
  if (!existsSync(teamsPath)) return [];
  return readdirSync(teamsPath, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.yaml') && !e.name.endsWith('.runtime.yaml'))
    .map((e) => e.name.slice(0, -'.yaml'.length))
    .sort();
}

// ---------------------------------------------------------------------------
// Serve-role construction seams
// ---------------------------------------------------------------------------
//
// plan/phases/single-process-boot-profile.md §3a/§7 Phase 1: the constructor
// logic below used to sit inline inside `runServe`, which meant a third entry
// point (the merged `boot` profile of §6) could only reuse it by copy-pasting.
// Each unit is now a named, exported, individually-callable function that
// `runServe` calls in place of the inline code — behavior-identical, same
// order, same arguments.
//
// They live in THIS file rather than a sibling module because
// `packages/wiring/src/__tests__/approval-seams.test.ts` asserts against the
// SOURCE TEXT of `apps/ethos/src/commands/serve.ts` that the danger predicate
// is built with its seams (`createApprovalDangerPredicate({` …
// `alwaysAsk: APPROVAL_SURFACE_ALWAYS_ASK`) — that construction site is inside
// the web-api option assembly, so moving it to another file would break that
// gate.

type ServePersonalityRegistry = Awaited<ReturnType<typeof createPersonalityRegistry>>;
type AcpServerOptions = ConstructorParameters<typeof AcpServer>[0];

export interface BuildServeAcpServerOptions {
  /** `~/.ethos` (or the `--data-dir` override) — the notify-queue db's parent. */
  dir: string;
  loop: AcpServerOptions['runner'];
  session: AcpServerOptions['session'];
  mesh: AcpServerOptions['mesh'];
  personalities: ServePersonalityRegistry;
  activePersonality: string;
  /** `--team <name>`; absent on a solo serve. */
  teamFlag: string | undefined;
  mcpManager: McpManager | undefined;
  jobStore: AcpServerOptions['jobStore'];
  backgroundExecutor: AcpServerOptions['backgroundExecutor'];
  teamAuthToken: string | undefined;
}

/**
 * Construct the ACP server (plan §3b step 4, "ACP server construction").
 *
 * Construction only — `startHttp()` stays at the call site. `serve.ts` binds
 * ACP first on purpose ("kept first so any breakage is obvious"), and plan §3b's
 * callout / §11 Open Question 8 leaves that ordering undecided for the merged
 * profile; keeping the bind out of this function means neither answer is
 * pre-empted here.
 */
export function buildServeAcpServer(opts: BuildServeAcpServerOptions): AcpServer {
  const {
    dir,
    loop,
    session,
    mesh,
    personalities,
    activePersonality,
    teamFlag,
    mcpManager,
    jobStore,
    backgroundExecutor,
    teamAuthToken,
  } = opts;
  // The MCP session-grant wiring is omitted on the team-coordinator path,
  // which has no McpManager — `session/registerMcpServers` then fails closed.
  return new AcpServer({
    runner: loop,
    session,
    mesh,
    personalityId: activePersonality,
    // Lane C (kanban-hooks-notify-parity, Phase 2) — passive `notify`-mode
    // delivery needs somewhere to land, which only exists for a team board.
    // A solo (non-team) `ethos serve` just no-ops that path.
    ...(teamFlag
      ? { teamId: teamFlag, notifyQueue: new SQLiteNotifyQueue(join(dir, 'notify-queue.db')) }
      : {}),
    ...(mcpManager
      ? createAcpMcpWiring({ mcpManager, personalities, defaultPersonalityId: activePersonality })
      : {}),
    ...(jobStore ? { jobStore } : {}),
    ...(backgroundExecutor ? { backgroundExecutor } : {}),
    ...(teamAuthToken ? { authToken: teamAuthToken } : {}),
  });
}

export interface BuildServeA2aCoreOptions {
  config: EthosConfig;
  /** `~/.ethos` (or the `--data-dir` override) — the a2a state dir's parent. */
  dir: string;
  loop: AgentLoop;
  personalities: ServePersonalityRegistry;
  activePersonality: string;
}

/**
 * The process-scoped half of the A2A stack (plan §3b step 4, "A2A stack
 * including `SQLiteA2aTaskStore`"): identity, peer store, allowlist, the
 * SQLite task store and its boot reconciliation + retention GC, the delegation
 * guard, both limiters, and the task runner.
 *
 * Split from `buildServeA2aSurface` below — and NOT merged with it — because
 * `runServe` constructs the call-capture daemon BETWEEN the two, and folding
 * them together would reorder that construction. Phase 1 is a
 * no-behavior-change extraction, so the seam follows the existing order rather
 * than tidying it.
 */
export async function buildServeA2aCore(opts: BuildServeA2aCoreOptions): Promise<{
  state: { enabled: boolean };
  isA2aEnabled: () => boolean;
  secrets: Awaited<ReturnType<typeof getSecretsResolver>>;
  storage: ReturnType<typeof getStorage>;
  baseDir: string;
  identity: PersonalityA2aIdentityProvider;
  peerStore: StorageA2aPeerStore;
  allowlist: StorageA2aAllowlist;
  taskStore: SQLiteA2aTaskStore;
  delegationGuard: A2aDelegationGuard;
  limiter: MemoryA2aLimiter;
  preAuthLimiter: MemoryA2aPreAuthLimiter;
  runner: A2aTaskRunner;
  /** Hourly task-store retention GC. Returned so the caller owns teardown. */
  retentionTimer: NodeJS.Timeout;
}> {
  const { config, dir, loop, personalities, activePersonality } = opts;
  // A2A (Agent-to-Agent) — ALWAYS constructed, LIVE-GATED at request time so
  // `ethos a2a enable/disable` and the Settings toggle flip it WITHOUT a restart.
  // Initial state is `config.a2a.enabled`; the deprecated `ETHOS_A2A_ENABLED=1`
  // env still forces it on. Three PUBLIC RouteModules mount through the Phase-2
  // seam behind the live gate (`enabledCheck`): the well-known card (stranger
  // tier), the /a2a-auth handshake (owns its default-deny auth), and the /a2a
  // JSON-RPC endpoint (owns its token + per-request PoP + call-time scope gate).
  // While disabled each 404s as if unmounted; lazy keygen only fires on a real
  // (gated) request, so always-constructing is cheap and safe. Each is isolatable
  // (own limiter hook) per plan §12 blast-radius.
  const a2aInitiallyEnabled = config.a2a?.enabled === true || process.env.ETHOS_A2A_ENABLED === '1';
  const a2aState = { enabled: a2aInitiallyEnabled };
  const isA2aEnabled = () => a2aState.enabled;

  const a2aSecrets = await getSecretsResolver();
  const a2aStorage = getStorage();
  const a2aBaseDir = join(dir, 'a2a');
  const a2aIdentity = new PersonalityA2aIdentityProvider({
    personalities,
    secrets: a2aSecrets,
    storage: a2aStorage,
    ...(config.webBaseUrl ? { baseUrl: config.webBaseUrl } : {}),
  });
  const a2aPeerStore = new StorageA2aPeerStore(a2aStorage, a2aBaseDir);
  const a2aAllowlist = new StorageA2aAllowlist(a2aStorage, a2aBaseDir);
  // Phase 6: async task lifecycle + P8 delegation containment + real limiter.
  // The task store + delegation guard are process-scoped so async task state
  // and per-trace fan-out counters persist across requests. The limiter is
  // A2A's OWN isolatable rate + concurrency stack (plan §12 blast-radius): its
  // caps cannot take down `/rpc`.
  //
  // T1.6: SQLite-backed, not in-memory — a task's state, result, and
  // (critically) its idempotency key must survive a restart, or a peer
  // polling after a restart gets NOT_FOUND for work that completed, and a
  // retried send after a restart re-runs the loop instead of deduping.
  const a2aTaskStore = new SQLiteA2aTaskStore(join(a2aBaseDir, 'tasks.db'));
  // Boot-time reconciliation (correctness fix): `A2aAsyncManager`'s in-process
  // `running` map does not survive a restart, so any row still
  // `submitted`/`working` from before a crash is orphaned — nothing will ever
  // move it to a terminal state, and a replayed idempotency key would report
  // "still working" forever. Fail those rows explicitly BEFORE serving any
  // traffic; never silently re-run them — the prior attempt may already have
  // mutated state, so the only safe move is to record that it died.
  const a2aReconciledCount = await a2aTaskStore.failNonTerminal(
    'interrupted: server restarted before this task completed',
  );
  if (a2aReconciledCount > 0) {
    console.warn(
      `[a2a] reconciled ${a2aReconciledCount} task(s) left non-terminal by a prior restart`,
    );
  }
  // Retention GC — terminal task rows carry result/error text, so they are
  // not kept forever. Two windows: bodies clear first (shorter), the row
  // (status + idempotency key) is deleted only after the longer window,
  // because idempotency surviving a restart is the reason this store exists.
  // Prune once at boot, then hourly — same cadence every other SQLite store's
  // retention GC in this app uses.
  const A2A_TASK_BODY_RETENTION_MS = 24 * 60 * 60 * 1000;
  const A2A_TASK_ROW_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
  const pruneA2aTaskStore = () => {
    const now = Date.now();
    void a2aTaskStore
      .pruneBodies(now - A2A_TASK_BODY_RETENTION_MS)
      .catch((err) => console.warn(`[a2a] task store body prune failed: ${String(err)}`));
    void a2aTaskStore
      .pruneTerminal(now - A2A_TASK_ROW_RETENTION_MS)
      .catch((err) => console.warn(`[a2a] task store retention prune failed: ${String(err)}`));
  };
  pruneA2aTaskStore();
  const a2aTaskStoreRetentionTimer = setInterval(pruneA2aTaskStore, 3_600_000);
  a2aTaskStoreRetentionTimer.unref?.();
  const a2aDelegationGuard = new A2aDelegationGuard();
  const a2aLimiter = new MemoryA2aLimiter();
  // Pre-auth gate (plan T1.4) — cheap, keyed on remote address, checked BEFORE
  // token/PoP verification so an unauthenticated flood never reaches Ed25519.
  // Additive to `a2aLimiter` above, which is unchanged and enforces a
  // different thing (per-peer quota, post-auth).
  const a2aPreAuthLimiter = new MemoryA2aPreAuthLimiter();
  // Phase 7: forward the inbound trace into the loop as the ambient delegation
  // frame, so an onward `a2a_send` signs `depth + 1` and consumes the shared
  // per-trace fan-out budget. `reserveOutbound` binds to the SAME process guard
  // above, so inbound admissions and outbound reservations share one counter.
  // T0.2: also resolves the peer-named skill's `required_tools` and narrows
  // the turn's toolset — fail-closed, see `serve-a2a-runner.ts`.
  const a2aRunner: A2aTaskRunner = createA2aRunner({
    loop,
    personalities,
    storage: a2aStorage,
    reserveOutbound: (traceId) => a2aDelegationGuard.reserveOutbound(traceId),
  });

  // T0.1 — the zero-skills warning (the headline bug): on boot with A2A
  // enabled, an operator who has not exposed any skill gets total silent
  // inbound failure (every `message/send` returns FORBIDDEN_SCOPE) with no
  // signal anywhere that says so. Best-effort: a card-read failure here must
  // never block boot.
  if (a2aInitiallyEnabled) {
    try {
      const card = await a2aIdentity.getIdentity(activePersonality, 'trusted-peer');
      const warning = a2aZeroSkillsWarning(activePersonality, card.skills.length);
      if (warning) console.warn(`[a2a] ${warning}`);
    } catch {
      // best-effort boot warning only
    }
  }
  return {
    state: a2aState,
    isA2aEnabled,
    secrets: a2aSecrets,
    storage: a2aStorage,
    baseDir: a2aBaseDir,
    identity: a2aIdentity,
    peerStore: a2aPeerStore,
    allowlist: a2aAllowlist,
    taskStore: a2aTaskStore,
    delegationGuard: a2aDelegationGuard,
    limiter: a2aLimiter,
    preAuthLimiter: a2aPreAuthLimiter,
    runner: a2aRunner,
    retentionTimer: a2aTaskStoreRetentionTimer,
  };
}

/**
 * The request-surface half of the A2A stack: the metadata-only audit sink, the
 * peering service, the three public `RouteModule`s the web API mounts, the
 * outbound `a2a_send` tool registration, and the live enable/disable control.
 *
 * Takes the already-constructed core so calling it does not reconstruct
 * anything (plan §4b's "already-constructed objects, not config" rule applied
 * to the construction seams too).
 */
export function buildServeA2aSurface(opts: {
  config: EthosConfig;
  core: Awaited<ReturnType<typeof buildServeA2aCore>>;
  /** Absent on deployments with no tool registry — `a2a_send` is then not
   *  registered, exactly as before. */
  toolRegistry: ToolRegistry | undefined;
}): {
  routeModules: RouteModule[];
  peering: ReturnType<typeof buildA2aPeeringService>;
  setA2aEnabled: (enabled: boolean) => Promise<void>;
} {
  const { config, core, toolRegistry } = opts;
  const {
    isA2aEnabled,
    state: a2aState,
    secrets: a2aSecrets,
    storage: a2aStorage,
    baseDir: a2aBaseDir,
    identity: a2aIdentity,
    peerStore: a2aPeerStore,
    allowlist: a2aAllowlist,
    taskStore: a2aTaskStore,
    delegationGuard: a2aDelegationGuard,
    limiter: a2aLimiter,
    preAuthLimiter: a2aPreAuthLimiter,
    runner: a2aRunner,
  } = core;
  // Phase 8: metadata-only audit sink. Built HERE in the app layer so
  // `@ethosagent/a2a` types never leak into `packages/wiring`. It maps each
  // A2aAuditEntry to an ethos observability event via the escape hatch — the
  // log proves THAT an exchange happened (decision, personality, peer), NEVER
  // WHAT was said. Fail-open: a missing/failing observability sink must not
  // affect the exchange (plan §13 / O12).
  const a2aAuditCategory = { auth: 'a2a.auth', rpc: 'a2a.rpc', task: 'a2a.task' } as const;
  const a2aAuditSink: A2aAuditSink = {
    record: (e) => {
      try {
        getEthosObservability().recordEthosEvent({
          category: a2aAuditCategory[e.kind],
          severity: e.severity ?? (e.decision === 'denied' ? 'warn' : 'info'),
          code: e.event,
          ...(e.reason ? { cause: e.reason } : {}),
          details: {
            decision: e.decision,
            personalityId: e.personalityId,
            ...(e.peerFingerprint ? { peerFingerprint: e.peerFingerprint } : {}),
            ...(e.skill ? { skill: e.skill } : {}),
            ...(e.taskId ? { taskId: e.taskId } : {}),
            ...(e.traceId ? { traceId: e.traceId } : {}),
            ...(e.status ? { status: e.status } : {}),
          },
        });
      } catch {
        // observability unavailable — audit is fail-open (plan §13).
      }
    },
  };
  // Peering service — built from the SAME storage + baseDir the route modules
  // use, so the UI/RPC and the live `/a2a` handshake are ONE source of truth
  // (plan §12): approve a peer once and both surfaces see it.
  const a2aPeering = buildA2aPeeringService({
    storage: a2aStorage,
    baseDir: a2aBaseDir,
    identity: a2aIdentity,
  });
  const a2aRouteModules: RouteModule[] = [
    {
      basePath: '/',
      router: createA2aWellKnownRouter({ getIdentity: a2aIdentity }),
      auth: 'public',
      description:
        'A2A discovery — public signed Agent Card (stranger tier) at /.well-known/agent-card.json.',
      enabledCheck: isA2aEnabled,
    },
    {
      basePath: '/a2a-auth',
      router: createA2aAuthRouter({
        secrets: a2aSecrets,
        allowlist: a2aAllowlist,
        peerStore: a2aPeerStore,
        nonces: new MemoryNonceStore(),
        // Route the SIGNED auth receipt (already produced by the handshake) into
        // the audit sink so accepted/rejected handshakes are recorded + queryable.
        onReceipt: (signed) =>
          a2aAuditSink.record({
            kind: 'auth',
            event: 'a2a-auth',
            personalityId: signed.receipt.personalityId,
            peerFingerprint: signed.receipt.peerFingerprint,
            decision: signed.receipt.decision === 'accepted' ? 'accepted' : 'denied',
            ...(signed.receipt.reason ? { reason: signed.receipt.reason } : {}),
            severity: signed.receipt.decision === 'accepted' ? 'info' : 'warn',
            ts: signed.receipt.ts,
          }),
      }),
      auth: 'public',
      description:
        'A2A auth handshake — default-deny allowlist + challenge-response; mints sender-constrained tokens.',
      enabledCheck: isA2aEnabled,
    },
    {
      basePath: '/a2a',
      router: createA2aRpcRouter({
        getIdentity: a2aIdentity,
        peerStore: a2aPeerStore,
        runner: a2aRunner,
        taskStore: a2aTaskStore,
        limiter: a2aLimiter,
        preAuthLimiter: a2aPreAuthLimiter,
        delegationGuard: a2aDelegationGuard,
        auditSink: a2aAuditSink,
      }),
      auth: 'public',
      description:
        'A2A JSON-RPC message/send (sync + async) — token + PoP + P8 delegation + scope; per-peer rate/concurrency caps.',
      enabledCheck: isA2aEnabled,
    },
  ];
  // Phase 7: register the OUTBOUND `a2a_send` tool — ALWAYS registered, gated by
  // `isA2aEnabled` at execute time so live-enabling makes it work without a
  // restart (it is registered, just gated). Still gated by each personality's
  // `a2a` toolset.
  if (toolRegistry) {
    const allowSelfLoop = process.env.ETHOS_A2A_SELF_LOOP === '1';
    for (const tool of createA2aTools({
      identity: a2aIdentity,
      secrets: a2aSecrets,
      // Egress default-deny (plan §15): the SAME per-personality allowlist that
      // gates inbound peers gates outbound calls — approve a peer once, both ways.
      allowlist: a2aAllowlist,
      ...(allowSelfLoop ? { allowSelfLoop: true } : {}),
      isEnabled: isA2aEnabled,
    })) {
      toolRegistry.register(tool);
    }
  }
  // Live enable/disable control surfaced to the peering RPC (later stage). Flips
  // the in-memory gate immediately, then persists `a2a.enabled` to
  // ~/.ethos/config.yaml via the config serializer (the same readRawConfig +
  // writeConfig path the CLI uses). Persistence is best-effort — a failed write
  // must NEVER throw on the request path; the process-local toggle already took
  // effect for this run.
  const setA2aEnabled = async (enabled: boolean): Promise<void> => {
    a2aState.enabled = enabled;
    try {
      const raw = await readRawConfig(a2aStorage);
      if (raw)
        await writeConfig(a2aStorage, { ...raw, a2a: { enabled } }, await getSecretsResolver());
    } catch (err) {
      console.warn(
        `  a2a:          failed to persist a2a.enabled=${enabled} to config.yaml (toggle still applied for this process):`,
        err instanceof Error ? err.message : err,
      );
    }
  };
  console.log(
    `  a2a:          ${isA2aEnabled() ? 'enabled' : 'disabled'} (live-toggleable; ${a2aRouteModules.length} modules on the web API)`,
  );
  if (isA2aEnabled() && !config.webBaseUrl) {
    console.log(
      '  a2a warn:     webBaseUrl unset — Agent Cards will advertise the default serve port; set webBaseUrl for a stable public URL.',
    );
  }
  // Phase 8: MESH is opt-in and DEFAULT OFF. The concrete safety shipped this
  // phase is the self-loop-default-off guard above; the flag is just the opt-in
  // marker for un-advertised mesh mode (a dynamic peer registry is deferred to
  // v2). Audit fires regardless of this flag.
  if (process.env.ETHOS_A2A_MESH === '1') {
    console.log('  a2a mesh:     enabled (un-advertised mesh mode; audit active)');
  }
  return { routeModules: a2aRouteModules, peering: a2aPeering, setA2aEnabled };
}

export interface BuildServeWebApiOptions {
  config: EthosConfig;
  /** `~/.ethos` (or the `--data-dir` override). */
  dir: string;
  loop: AgentLoop;
  session: ReturnType<typeof createSessionStore>;
  contextLog: SQLiteContextLog;
  personalities: ServePersonalityRegistry;
  identityMap: IdentityMap;
  attachmentCache: FsAttachmentCache;
  apiKeys: SqliteApiKeyStore;
  idempotencyStore: IdempotencyStore;
  toolRegistry: ToolRegistry | undefined;
  mcpManager: McpManager | undefined;
  pluginLoader: import('@ethosagent/plugin-loader').PluginLoader | undefined;
  notificationRouter: import('@ethosagent/types').NotificationRouter | undefined;
  cronScheduler: CronScheduler | null;
  cronTriggers: CronTriggers;
  goalRunner: import('@ethosagent/goal-runner').GoalRunner | undefined;
  jobStore: import('@ethosagent/types').JobStore | undefined;
  jobRunners: import('@ethosagent/types').JobRunnerRegistry | undefined;
  backgroundExecutor:
    | import('@ethosagent/wiring').CreateAgentLoopResult['backgroundExecutor']
    | undefined;
  setOnSkillProposed: ((fn: (skillId: string, personalityId: string) => void) => void) | undefined;
  onMemoryCaptured:
    | import('@ethosagent/wiring').CreateAgentLoopResult['onMemoryCaptured']
    | undefined;
  refreshLoopPersonalities: (() => Promise<void>) | undefined;
  skillsInjector: import('@ethosagent/skills').SkillsInjector | undefined;
  /**
   * The LOOP's execution-backend registry. Web-api's `ExecutionService` probes
   * `get('ssh')` on it, and because `resolve()` memoises that is the instance
   * `compose-tools` built for the tools — the probe tests what executes.
   * Undefined on the team-coordinator path (`createTeamAgentLoop` exposes no
   * registry) and in onboarding mode: the probe then answers
   * `backend_unresolved` with the reason, never a guessed `unreachable`.
   */
  executionBackends: import('@ethosagent/types').ExecutionBackendRegistry | undefined;
  skillsCatalogDir: ReturnType<typeof resolveSkillsCatalogDir>;
  sttProviders: import('@ethosagent/types').SttProviderRegistry | undefined;
  ttsProviders: import('@ethosagent/types').TtsProviderRegistry | undefined;
  realtimeProviders: import('@ethosagent/types').RealtimeVoiceProviderRegistry | undefined;
  voiceConfig: ServeVoiceConfig | undefined;
  voiceStack: import('@ethosagent/wiring').VoiceStack | undefined;
  titleFn: ((systemPrompt: string, userMessage: string) => Promise<string>) | undefined;
  corsOrigins: ReturnType<typeof resolveCorsOrigins>;
  allowedOrigins: string[] | undefined;
  trustProxy: boolean;
  /** Drives the `Secure` cookie flag together with `config.webBaseUrl`. */
  isLoopbackBind: boolean;
  webDist: ReturnType<typeof locateWebDist>;
  metricsText: ReturnType<typeof createMetricsTextProvider>;
  recordHttpRequest: (method: string, status: number) => void;
  a2aRouteModules: RouteModule[];
  a2aPeering: ReturnType<typeof buildA2aPeeringService>;
  isA2aEnabled: () => boolean;
  setA2aEnabled: (enabled: boolean) => Promise<void>;
  /**
   * Team-scoped loop factory for web chat (teams-as-a-scope D4). Optional so
   * the merged `ethos boot` profile, which does not build team loops, is
   * unchanged.
   */
  createTeamLoop?: (teamName: string) => Promise<TeamLoopHandle>;
  /** `--team <name>` — the team `loop` already runs as; the registry skips it. */
  mainLoopTeam?: string;
}

/**
 * Assemble and construct the web API (plan §3b step 4, "web-api
 * (`createWebApi`)").
 *
 * Pure option assembly around one `createWebApi` call — every collaborator
 * arrives already constructed, so calling this does not build a loop, a store,
 * or a provider. The returned handle (`app`, `chatService`, `voiceSocket`,
 * `satelliteSocket`) is what the caller listens on; this function binds no
 * port.
 */
export function buildServeWebApi(opts: BuildServeWebApiOptions): ReturnType<typeof createWebApi> {
  const {
    config,
    dir,
    loop,
    session,
    contextLog,
    personalities,
    identityMap,
    attachmentCache,
    apiKeys,
    idempotencyStore,
    toolRegistry,
    mcpManager,
    pluginLoader,
    notificationRouter,
    cronScheduler,
    cronTriggers,
    goalRunner,
    jobStore,
    jobRunners,
    backgroundExecutor,
    setOnSkillProposed,
    onMemoryCaptured,
    refreshLoopPersonalities,
    skillsInjector,
    executionBackends,
    skillsCatalogDir,
    sttProviders,
    ttsProviders,
    realtimeProviders,
    voiceConfig,
    voiceStack,
    titleFn,
    corsOrigins,
    allowedOrigins,
    trustProxy,
    isLoopbackBind,
    webDist,
    metricsText,
    recordHttpRequest,
    a2aRouteModules,
    a2aPeering,
    isA2aEnabled,
    setA2aEnabled,
    createTeamLoop,
    mainLoopTeam,
  } = opts;
  return createWebApi({
    dataDir: dir,
    attachmentCache,
    sessionStore: session,
    contextLog,
    personalitiesLlm: () => createLLM(config),
    // Per-team loops for web chat (D4): a team member's turn runs on its
    // team's loop, built on demand through this factory.
    ...(createTeamLoop ? { createTeamLoop } : {}),
    ...(mainLoopTeam ? { mainLoopTeam } : {}),
    memoryProvider: createMemoryProvider({
      dataDir: dir,
      storage: getStorage(),
      source: 'web-editor',
    }),
    // Backend selection for the approve-before-store queue — a web approve
    // replays into the configured backend (vault under memory: vault).
    memoryBackend: config,
    identityMap,
    agentLoop: loop,
    // The same registry the agent loop loaded above is reused so mtime
    // hot-reloads of personality files reach both surfaces in one tick.
    personalities,
    // Loop-registry refresh — chat/completions await it before a turn so a
    // hot-dropped/edited personality resolves without a restart.
    ...(refreshLoopPersonalities ? { refreshPersonalities: refreshLoopPersonalities } : {}),
    // Renderer-capability seam for `personalities.renderers` — the loop's own
    // SkillsInjector, so the derivation reuses one scanner + mtime cache.
    ...(skillsInjector ? { skillsInjector } : {}),
    // Settings › Execution — the probe reaches the loop's own backend instance
    // through this registry (`resolve()` memoises), so `Test connection` tests
    // the object remote commands run on.
    ...(executionBackends ? { executionBackends } : {}),
    // Lane 6 (D5) — model-fit seam for the `personalities.characterSheet`
    // RPC: the SAME wiring assembler the CLI `personality show` calls, so the
    // two surfaces render one verdict. Cache-first probe (a web read is not a
    // diagnostic command); the closure resolves null for unknown ids.
    ...(toolRegistry
      ? {
          modelFit: async (personalityId: string) => {
            const registry = toolRegistry;
            if (!registry) return null;
            const described = personalities.describe(personalityId);
            if (!described) return null;
            const soulMd = await personalities.readSoulMd(personalityId);
            const model = config.modelRouting?.[personalityId] ?? config.model;
            return resolvePersonalityModelFit({
              personality: described.config,
              soulMd,
              toolDefinitions: registry.toDefinitions(described.config.toolset),
              provider: config.provider,
              model,
              ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
              ...(model === config.model && config.contextWindow !== undefined
                ? { configWindow: config.contextWindow }
                : {}),
              ...(config.compaction?.smallWindow !== undefined
                ? { smallWindowOverride: config.compaction.smallWindow }
                : {}),
              storage: getStorage(),
              dataDir: dir,
            });
          },
          // tools-as-code-api Lane G — the script-callable surface for the
          // sheet's `Script-callable (run_code)` line. Same derivation the
          // ScriptToolBridge enforces; resolves null for unknown ids.
          scriptSurface: async (personalityId: string) => {
            const registry = toolRegistry;
            if (!registry) return null;
            const described = personalities.describe(personalityId);
            if (!described) return null;
            return { callable: scriptCallableFor(described.config, registry) };
          },
          // §4.7 — declared network reach for the sheet's `## Boundary`
          // section, so the Web tab reports G-NET inapplicable on exactly the
          // personalities the CLI does. Resolves null for unknown ids.
          boundary: async (personalityId: string) => {
            const registry = toolRegistry;
            if (!registry) return null;
            const described = personalities.describe(personalityId);
            if (!described) return null;
            return { networkTools: toolsDeclaringNetwork(described.config, registry) };
          },
        }
      : {}),
    chatDefaults: {
      model: config.model,
      provider: config.provider,
    },
    // Same `checkCommand` rules the CLI guard uses; surfacing them via
    // the approval modal instead of a hard block. Threaded with the turn's
    // personality (learned from the loop's `session_start`) so `denyRules`
    // and `approvalMode` are enforced, plus a lazy provider handle for
    // `approvalMode: 'smart'` — nothing is constructed unless a flagged call
    // actually reaches the reviewer.
    dangerPredicate: createApprovalDangerPredicate({
      hooks: [loop.hooks],
      personalities,
      getProvider: createLazyProvider(() => createLLM(config)),
      model: config.model,
      alwaysAsk: APPROVAL_SURFACE_ALWAYS_ASK,
    }),
    // Every modal decision (and every allowlist auto-allow) lands in the
    // safety audit trail behind `ethos audit decisions`.
    approvalObservability: {
      recordSafetyApproval: (o) => getEthosObservability().recordSafetyApproval(o),
    },
    // Operator-tunable approval SLA. `!== undefined`, not truthiness — `0`
    // ("wait forever") is a meaningful value the operator may have set.
    ...(config.approvalTimeoutMs !== undefined
      ? { approvalTimeoutMs: config.approvalTimeoutMs }
      : {}),
    // Wake-satellite lane events (`satellite.*`) — today, the turn that ran
    // without speaking because the node declared no loudspeaker. Same
    // observability instance as the approval trail above; fail-open like every
    // other audit call in this file, so a store that will not initialise costs
    // a row and never a turn.
    satelliteObservability: {
      recordSafetyBlock: (o) => {
        try {
          getEthosObservability().recordSafetyBlock(o);
        } catch {
          // observability unavailable — audit is fail-open
        }
      },
    },
    ...(skillsCatalogDir ? { catalogDir: skillsCatalogDir } : {}),
    ...(cronScheduler ? { cronScheduler } : {}),
    ...(toolRegistry ? { toolRegistry } : {}),
    ...(mcpManager ? { mcpManager } : {}),
    ...(pluginLoader ? { pluginLoader } : {}),
    ...(notificationRouter ? { notificationRouter } : {}),
    apiKeys,
    idempotencyStore,
    ...(corsOrigins ? { corsOrigins } : {}),
    ...(allowedOrigins ? { allowedOrigins } : {}),
    listTeams: async () => listRegisteredTeams(dir),
    secureCookie: !isLoopbackBind || config.webBaseUrl?.startsWith('https://') === true,
    trustProxy,
    ...(webDist ? { webDist } : {}),
    ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
    ...(setOnSkillProposed ? { setOnSkillProposed } : {}),
    ...(onMemoryCaptured ? { onMemoryCaptured } : {}),
    memoryNoticesEnabled: config.displayMemoryNotices !== false,
    ...(goalRunner ? { goalRunner } : {}),
    ...(jobStore ? { jobStore } : {}),
    ...(jobRunners ? { jobRunners } : {}),
    // I15/I18 — the run card's liveness feed and the completion hand-back.
    // Both ride the executor's EXISTING subscription seams (`onRunUpdate`,
    // `onComplete`); neither is a new notification bus (G9/D11/D20, D27).
    ...(backgroundExecutor
      ? {
          subscribeRunUpdates: (handler: (update: RunUpdateDigest) => void) => {
            backgroundExecutor?.onRunUpdate(handler);
          },
          subscribeJobComplete: (handler: (job: BackgroundJob) => void) => {
            backgroundExecutor?.onComplete(handler);
          },
        }
      : {}),
    ...(sttProviders ? { sttProviderRegistry: sttProviders } : {}),
    ...(voiceConfig?.sttProviderName ? { sttProviderName: voiceConfig.sttProviderName } : {}),
    ...(voiceConfig ? { sttProviderConfig: voiceConfig.sttProviderConfig } : {}),
    ...(ttsProviders ? { ttsProviderRegistry: ttsProviders } : {}),
    ...(voiceConfig?.ttsProviderName ? { ttsProviderName: voiceConfig.ttsProviderName } : {}),
    ...(voiceConfig ? { ttsProviderConfig: voiceConfig.ttsProviderConfig } : {}),
    // Named rosters — what a personality's `voice.tts_provider` /
    // `voice.stt_provider` pick from.
    ...(voiceConfig?.ttsRoster ? { ttsRoster: voiceConfig.ttsRoster } : {}),
    ...(voiceConfig?.sttRoster ? { sttRoster: voiceConfig.sttRoster } : {}),
    // Realtime tier — the registry backs `voice.realtimeToken`; the roster and
    // tier default are boot snapshots that live Settings config overrides.
    ...(realtimeProviders ? { realtimeProviderRegistry: realtimeProviders } : {}),
    ...(voiceConfig?.realtimeRoster ? { realtimeRoster: voiceConfig.realtimeRoster } : {}),
    ...(voiceConfig?.realtimeDefault ? { realtimeDefault: voiceConfig.realtimeDefault } : {}),
    ...(voiceConfig?.tier ? { voiceTier: voiceConfig.tier } : {}),
    // Where a conversation with no explicit `/voice` mode starts, the same
    // `voice.defaultMode` the gateway reads for its channel lanes.
    ...(config.voice?.defaultMode ? { voiceDefaultMode: config.voice.defaultMode } : {}),
    // The typed per-call cap. Live Settings config still wins; this is the
    // route that exists whether or not the live read does.
    ...(voiceConfig?.realtimeSessionBudgetUsd !== undefined
      ? { realtimeSessionBudgetUsd: voiceConfig.realtimeSessionBudgetUsd }
      : {}),
    // Realtime turns record their latency into the voice stack's span writer —
    // the same one the pipeline tier uses.
    ...(voiceStack ? { voiceSpans: voiceStack.spans } : {}),
    // The browser pipeline lane's `VoiceSession` factory. Absent (no
    // `voice.*` configured) → the lane still handshakes, but refuses `audio`
    // frames with a clear error instead of a silent no-op.
    ...(voiceStack ? { voiceStack } : {}),
    // Local-only voice-egress gate. Armed only when the operator declared
    // `voice.trustedPlugins`; the browser talk lane then refuses a non-local
    // provider instead of shipping audio off the machine.
    ...(voiceConfig?.trustedVoicePlugins
      ? { trustedVoicePlugins: voiceConfig.trustedVoicePlugins }
      : {}),
    ...(titleFn ? { titleFn } : {}),
    // W4.1 — first completed web turn stamps funnel.first_reply.
    onTurnDone: () => {
      void getFunnelTracker().recordFirstReply();
    },
    routeModules: a2aRouteModules,
    a2aPeering,
    a2aControl: { isEnabled: isA2aEnabled, setEnabled: setA2aEnabled },
    // Phase 0 — per-session context anatomy for the web Activity tab, read from
    // the shared observability store's llm_call spans (never the message rows).
    contextAnatomyFn: (sessionId: string) => {
      try {
        return computeContextAnatomy(getObservabilityStore().getLlmCallSpansForSession(sessionId));
      } catch {
        return null;
      }
    },
    // Durable activity history for the web Activity tab, read from the same
    // shared observability store.
    activityHistoryFn: (filter) => {
      try {
        return getObservabilityStore().getRecentActivity(filter);
      } catch {
        return [];
      }
    },
    metricsTextFn: metricsText,
    recordHttpRequest,
    // Always supplied — `CronTriggers.external` is non-nullable, so
    // `POST /cron/fire` is live on every `ethos serve` and gated solely by a
    // bearer key carrying the `cron` scope (D2).
    cronFireTrigger: cronTriggers.external,
  });
}
