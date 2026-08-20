import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve as pathResolve } from 'node:path';
import {
  type A2aAuditSink,
  A2aDelegationGuard,
  type A2aTaskRunner,
  createA2aAuthRouter,
  createA2aRpcRouter,
  createA2aWellKnownRouter,
  FetchA2aPushClient,
  InMemoryA2aTaskStore,
  MemoryA2aLimiter,
  MemoryNonceStore,
  StorageA2aAllowlist,
  StorageA2aPeerStore,
} from '@ethosagent/a2a';
import { AcpServer } from '@ethosagent/acp-server';
import { AgentMesh, meshRegistryPath } from '@ethosagent/agent-mesh';
import {
  type EthosConfig,
  ethosDir,
  readConfig,
  readRawConfig,
  writeConfig,
} from '@ethosagent/config';
import { type AgentLoop, scriptCallableFor, toolsDeclaringNetwork } from '@ethosagent/core';
import { CronScheduler } from '@ethosagent/cron';
import { LocalExecutionBackend } from '@ethosagent/execution-local';
import { LangfusePollLoop } from '@ethosagent/export-langfuse';
import { ConsoleLogger } from '@ethosagent/logger';
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
  MicActivityDetector,
  NotificationGate,
} from '@ethosagent/platform-callcapture';
import { SessionLane } from '@ethosagent/session-lane';
import { SQLiteContextLog, SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { FsAttachmentCache, FsStorage } from '@ethosagent/storage-fs';
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
  wrapUntrusted,
} from '@ethosagent/wiring';
import { appendErrorLog } from '../error-log';
import { createAcpMcpWiring } from '../lib/acp-mcp-wiring';
import { DeferredToolRegistry } from '../lib/deferred-tool-registry';
import { KanbanPollLoop, writeRunActivityComments } from '../lib/kanban-poll';
import { resolveSkillsCatalogDir } from '../lib/resolve-skills-catalog-dir';
import { emitReady } from '../logger';
import { notifyReady, startWatchdog } from '../sd-notify';
import {
  buildSystemTaskHandlers,
  createAgentLoop,
  createLLM,
  createTeamAgentLoop,
  getEthosObservability,
  getFunnelTracker,
  getObservabilityStore,
  getSecretsResolver,
  getStorage,
} from '../wiring';
import { runCronTurn } from './cron-turn';
import {
  parseFlagValue,
  parsePort,
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

export async function runServe(args: string[], config: EthosConfig | null): Promise<void> {
  installServeResilienceGuard();
  const acpPort = parsePort(parseFlagValue(args, ['--port']), ACP_PORT_DEFAULT);
  const webPort = resolveWebPort(args, process.env, config);
  const webHost = resolveWebHost(args, process.env, config);
  const corsOrigins = resolveCorsOrigins(process.env, config);

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
      await webShutdown();
      process.exit(0);
    };
    process.on('SIGTERM', () => void cleanup());
    process.on('SIGINT', () => void cleanup());

    await new Promise(() => {});
    return;
  }

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
  let voiceConfig:
    | {
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
      }
    | undefined;
  // The voice stack, held only for its span writer: the browser realtime tier
  // records per-turn latency into the SAME writer the pipeline tier uses, so a
  // deployment has one voice-span buffer and one sink rather than two.
  let voiceStack: import('@ethosagent/wiring').VoiceStack | undefined;

  // Shared by the ACP server, the web API, and the cron `runJob` closure below
  // (which reads a web-origin session's bound personality before reusing its
  // key). Declared here so that closure has an in-scope binding, not a forward
  // reference to a later `const`.
  const session = createSessionStore({ dataDir: dir });

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
  const watcherLogger = new ConsoleLogger();
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
    logger: new ConsoleLogger(),
    // Script/precheck jobs execute through the same local backend class the
    // execution tools use — never raw child_process in the scheduler.
    executionBackend: new LocalExecutionBackend({
      config: {},
      secrets: await getSecretsResolver(),
      logger: new ConsoleLogger(),
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

  // ACP server (existing behavior — kept first so any breakage is obvious).
  // The MCP session-grant wiring is omitted on the team-coordinator path,
  // which has no McpManager — `session/registerMcpServers` then fails closed.
  const acpServer = new AcpServer({
    runner: loop,
    session,
    mesh,
    ...(mcpManager
      ? createAcpMcpWiring({ mcpManager, personalities, defaultPersonalityId: activePersonality })
      : {}),
    ...(jobStore ? { jobStore } : {}),
    ...(backgroundExecutor ? { backgroundExecutor } : {}),
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
    boardSubscriptions: teamFlag ? [teamFlag] : ['global'],
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
  const kanbanPollEnabled = config.kanbanPoll?.enabled !== false; // enabled by default
  if (kanbanPollEnabled) {
    const boardPath =
      config.kanbanPoll?.boardPath ??
      (teamFlag ? join(dir, 'teams', teamFlag, 'board.db') : join(dir, 'board.db'));

    if (boardPath) {
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
  if (cronScheduler) cronScheduler.start();

  // Load watchers.json and seed the backing `source:'system'` tick jobs.
  // Idempotent — existing jobs are re-registered so interval edits apply.
  void watcherManager.start().catch((err) => {
    console.error('[watcher] failed to start watcher manager:', err);
  });

  // Seed system cron jobs into the scheduler's persistent store. Each call
  // is idempotent — existing jobs are returned as-is. The handlers were
  // already registered via `systemTasks` in the scheduler config above.
  const seedSystemJobs = async () => {
    if (!cronScheduler) return;
    await cronScheduler.seedSystemJob({
      name: 'Observability Prune',
      schedule: '0 3 * * *',
      systemTask: 'observability-prune',
    });
    if (config.nightlyPass?.enabled) {
      await cronScheduler.seedSystemJob({
        name: 'Nightly Pass',
        schedule: config.nightlyPass.cron ?? '0 3 * * *',
        systemTask: 'nightly-pass',
      });
    }
    if (config.weeklyDigest?.enabled) {
      await cronScheduler.seedSystemJob({
        name: 'Weekly Digest',
        schedule: config.weeklyDigest.cron ?? '0 9 * * 1',
        systemTask: 'weekly-digest',
      });
    }
    if (config.evolverCronEnabled) {
      await cronScheduler.seedSystemJob({
        name: 'Skill Evolver',
        schedule: config.evolverSchedule ?? '0 3 * * *',
        systemTask: 'skill-evolver',
      });
    }
  };
  void seedSystemJobs();

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
  const a2aTaskStore = new InMemoryA2aTaskStore();
  const a2aDelegationGuard = new A2aDelegationGuard();
  const a2aLimiter = new MemoryA2aLimiter();
  const a2aPushClient = new FetchA2aPushClient();
  // Phase 7: forward the inbound trace into the loop as the ambient delegation
  // frame, so an onward `a2a_send` signs `depth + 1` and consumes the shared
  // per-trace fan-out budget. `reserveOutbound` binds to the SAME process guard
  // above, so inbound admissions and outbound reservations share one counter.
  const a2aRunner: A2aTaskRunner = {
    run: (personalityId, text, opts) => {
      const delegation = opts?.delegation;
      return loop.run(text, {
        personalityId,
        ...(opts?.sessionKey ? { sessionKey: opts.sessionKey } : {}),
        ...(delegation
          ? {
              a2aDelegation: {
                traceId: delegation.traceId,
                depth: delegation.depth,
                reserveOutbound: () => a2aDelegationGuard.reserveOutbound(delegation.traceId),
              },
            }
          : {}),
      });
    },
  };

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
        delegationGuard: a2aDelegationGuard,
        pushClient: a2aPushClient,
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

  const created = createWebApi({
    dataDir: dir,
    attachmentCache,
    sessionStore: session,
    contextLog,
    personalitiesLlm: () => createLLM(config),
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
    metricsTextFn: metricsText,
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
    Promise.all([created.voiceSocket.close(), created.satelliteSocket.close()]).then(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    );

  emitReady('serve');
  notifyReady();
  const stopWatchdog = startWatchdog();

  const cleanup = async () => {
    if (stopWatchdog) stopWatchdog();
    stopHeartbeat();
    stopPollLoop?.();
    stopLangfusePoll?.();
    // Stops the daemon + heartbeat (if this process ever won the ownership
    // claim, including via a later retry tick — see
    // `CallCaptureOwnershipManager`) and releases the lock so a restarted
    // process, or the other host command, can take it.
    await callCaptureOwnershipManager?.stop();
    await mesh.unregister(agentId);
    if (cronScheduler) cronScheduler.stop();
    if (webShutdown) await webShutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => void cleanup());
  process.on('SIGINT', () => void cleanup());

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
function locateWebDist(explicit: string | undefined): string | null {
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
