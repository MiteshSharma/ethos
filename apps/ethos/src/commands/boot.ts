// `ethos boot` — the merged single-process profile from
// plan/phases/single-process-boot-profile.md §6.
//
// WHY THIS EXISTS. Boot-time reconciliation is split across `ethos gateway
// start` and `ethos serve`, and each is missing work the other does (plan §1):
// `serve` never calls `sweepPendingDeliveries()` / `sweepUndeliveredJobs()`,
// `gateway` never calls `A2aTaskStore.failNonTerminal()`. In an always-on
// deployment that asymmetry is invisible; under scale-to-zero every wake is a
// boot, so whichever command is not running silently skips its half. This
// command runs BOTH roles' construction in ONE process and calls
// `runBootReconciliation()` (apps/ethos/src/boot-reconciliation.ts) once,
// explicitly, at the point in the sequence where every dependency it needs is
// live — closing the gap.
//
// ADDITIVE, NOT A REPLACEMENT (plan §2). `runGatewayStart` and `runServe` are
// unchanged and keep working exactly as they do today for existing
// multi-process deployments. This file only CALLS the named seams Phase 1
// extracted out of them; it does not modify either command's behavior.
//
// WHAT IT DELIBERATELY DOES NOT WIRE. This is the merged BOOT profile, not a
// merge of every optional subsystem the two commands can start. The following
// are reachable only from their own command today and are NOT constructed
// here; each is called out at its would-be position below:
//   • telephony / SIP inbound (`createSipInboundHandler` is still inline in
//     `runGatewayStart`; Phase 1 did not extract it)
//   • dreaming (`DreamExecutor`), the Langfuse export poller, the kanban poll
//     loop, team-supervisor spawning, and gateway quick-commands
// Everything reconciliation depends on IS wired. So is the idle watcher: this
// is the profile plan/phases/idle-watcher.md was written for, since a
// scale-to-zero deployment needs something to decide when suspending is safe.

import { join } from 'node:path';
import { AgentMesh, meshRegistryPath } from '@ethosagent/agent-mesh';
import { type EthosConfig, ethosDir, loadConfigStrict } from '@ethosagent/config';
import type { AgentLoop } from '@ethosagent/core';
import {
  buildCronTriggers,
  CronScheduler,
  type CronTriggers,
  runScriptFile,
} from '@ethosagent/cron';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import { LocalExecutionBackend } from '@ethosagent/execution-local';
import { IdleWatcherManager } from '@ethosagent/idle-watcher';
import { SQLiteInboundDedupStore } from '@ethosagent/inbound-dedup';
import { ConsoleLogger } from '@ethosagent/logger';
import { createMetricsTextProvider } from '@ethosagent/observability-sqlite';
import { createPersonalityRegistry } from '@ethosagent/personalities';
import { SQLiteContextLog, SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import Database from '@ethosagent/sqlite';
import { FsAttachmentCache, FsStorage } from '@ethosagent/storage-fs';
import { teamsDir } from '@ethosagent/team-supervisor';
import {
  EthosError,
  type InboundMessage,
  type NotificationRouter,
  type PlatformAdapter,
} from '@ethosagent/types';
import { WatcherManager, type WatcherWakeEvent } from '@ethosagent/watchers';
import { IdempotencyStore, WebTokenRepository } from '@ethosagent/web-api';
import {
  createLazyProvider,
  createSessionStore,
  IdentityMap,
  initPairingDb,
  type MessagingSendFn,
  sanitize,
  wrapUntrusted,
} from '@ethosagent/wiring';
import { runBootReconciliation } from '../boot-reconciliation';
import { createHealthServer } from '../health-server';
import { resolveSkillsCatalogDir } from '../lib/resolve-skills-catalog-dir';
import { emitReady } from '../logger';
import { applyPauseCorrections, hasHeartbeatBump } from '../pause-corrections';
import { createPauseLifecycle } from '../pause-lifecycle';
import { createPlatformWebhookServer } from '../platform-webhook-server';
import { notifyReady, startWatchdog } from '../sd-notify';
import { createWebhookServer, type PrefilterRunner } from '../webhook-server';
import {
  buildServeBusySources,
  buildSystemTaskHandlers,
  createAgentLoop,
  createLLM,
  dedupeBusySources,
  deriveIdleWatcherCapabilities,
  getEthosObservability,
  getFunnelTracker,
  getObservabilityStore,
  getSecretsResolver,
  getStorage,
} from '../wiring';
import { runCronTurn } from './cron-turn';
import {
  buildGateway,
  buildGatewayAdapters,
  buildGatewayBots,
  buildGatewayBusySources,
  buildGatewayHeartbeat,
  buildGatewayVoiceOutputs,
  buildPlatformWebhookMounts,
  createCapturingAdapter,
  createGatewayAttachmentCache,
  createGatewayMetricsAuthCheck,
  createTelegramGreetingProvider,
  createTelegramPersonalityCardReader,
  registerGatewayClarifySurfaces,
  validateBindings,
  wireApprovalFlow,
} from './gateway';
import {
  buildServeA2aCore,
  buildServeA2aSurface,
  buildServeAcpServer,
  buildServeWebApi,
  locateWebDist,
} from './serve';
import {
  parseFlagValue,
  parsePort,
  resolveCorsOrigins,
  resolveWebHost,
  resolveWebPort,
} from './serve-helpers';
import { formatNonLoopbackWarning, isLoopbackHost, listenWithFallback } from './serve-listen';

const ACP_PORT_DEFAULT = 3001;
const WEB_PORT_FALLBACK_ATTEMPTS = 5;
const HEARTBEAT_INTERVAL_MS = 10_000;
/** Same cadence gateway.ts and serve.ts already use for the call-capture
 *  ownership retry — do not invent a second interval. */
const CALL_CAPTURE_HEARTBEAT_INTERVAL_MS = 10_000;

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

function gatewayHealthPath(): string {
  return join(ethosDir(), 'gateway-health.json');
}

/**
 * The merged boot profile. Construction order follows plan §3b step-for-step;
 * every deviation is called out inline.
 *
 * @param config — a PRESENCE CHECK ONLY; it is NOT the config that runs. The
 * CLI has already parsed `~/.ethos/config.yaml` leniently and passes the result
 * here so that a missing config becomes "run ethos setup first" below. The
 * config actually in force is `cfg` (`loaded.config`), from the STRICT re-load
 * a few lines down — `runGatewayStart` uses `loadConfigStrict` deliberately and
 * the gateway role this profile merges inherits that contract, so the file is
 * parsed twice on purpose. Below this point, read `cfg`; never `config`.
 */
export async function runBoot(args: string[], config: EthosConfig | null): Promise<void> {
  // -------------------------------------------------------------------------
  // §3b step 1 — shared config / storage / identity setup
  // -------------------------------------------------------------------------
  //
  // There is no onboarding branch here, unlike `runServe`: this profile merges
  // the GATEWAY role too, and the gateway role has no meaningful behaviour
  // without config (it exits on a missing one today). Run `ethos serve` for
  // the onboarding wizard, then `ethos boot`.
  if (config === null) {
    console.error('Run ethos setup first.');
    process.exit(1);
  }
  const storage = getStorage();
  const secrets = await getSecretsResolver();
  // The STRICT loader, matching the gateway role's contract: parse-time errors
  // (typos in bind.type, missing bot tokens) surface here rather than silently
  // booting zero bots. This deliberately re-parses the file the `config`
  // parameter above came from — that parameter is only the presence check, and
  // `loaded.config` is what every line below actually uses.
  const loaded = await loadConfigStrict(storage, secrets);
  if (!loaded) {
    console.error('Run ethos setup first.');
    process.exit(1);
  }
  if (loaded.parseErrors.length > 0) {
    console.log(`${c.red}Config parse errors:${c.reset}`);
    for (const err of loaded.parseErrors) console.log(`  • ${err}`);
    process.exit(1);
  }
  for (const note of loaded.deprecations) {
    console.log(`${c.yellow}⚠ deprecation${c.reset} ${c.dim}${note}${c.reset}`);
  }
  const cfg = loaded.config;
  const dir = ethosDir();

  const bindErrors = await validateBindings(cfg);
  if (bindErrors.length > 0) {
    console.log(`${c.red}Bot binding errors:${c.reset}`);
    for (const err of bindErrors) console.log(`  • ${err}`);
    process.exit(1);
  }

  const acpPort = parsePort(parseFlagValue(args, ['--port']), ACP_PORT_DEFAULT);
  const webPort = resolveWebPort(args, process.env, cfg);
  const webHost = resolveWebHost(args, process.env, cfg);
  const corsOrigins = resolveCorsOrigins(process.env, cfg);
  const trustProxy =
    process.env.ETHOS_TRUST_PROXY === '1' || process.env.ETHOS_TRUST_PROXY === 'true';
  const isLoopbackBind = isLoopbackHost(webHost);
  const healthPort = Number(process.env.ETHOS_GATEWAY_HEALTH_PORT) || 3002;
  const healthHost = process.env.ETHOS_SERVE_HOST ?? '127.0.0.1';
  const webhookPort = Number(process.env.ETHOS_WEBHOOK_PORT) || 3003;
  const webhookHost = process.env.ETHOS_SERVE_HOST ?? '127.0.0.1';
  // 3002 gateway health, 3003 gateway webhook, 3004 `ethos run-all` health, 3005
  // SIP — 3006 is next. Same default and env var `runGatewayStart` uses, so a
  // deployment that moves the port moves it for both entry points at once.
  const platformWebhookPort = Number(process.env.ETHOS_PLATFORM_WEBHOOK_PORT) || 3006;
  const platformWebhookHost = process.env.ETHOS_SERVE_HOST ?? '127.0.0.1';

  console.log(
    `${c.bold}ethos boot${c.reset}  ${c.dim}starting (merged gateway + serve)...${c.reset}`,
  );

  const identityMap = new IdentityMap({ storage, dataDir: dir });
  const resolveUserId = (platform: string, platformUserId: string, displayLabel?: string) =>
    identityMap.resolve(platform, platformUserId, displayLabel);
  await identityMap.resolve('desktop', 'desktop', 'Desktop');

  // ONE session store and ONE personality registry for both roles — the merge
  // win the split process cannot have.
  const session = createSessionStore({ dataDir: dir });
  const contextLog = new SQLiteContextLog(join(dir, 'sessions.db'));
  const personalities = await createPersonalityRegistry({
    storage,
    userPersonalitiesDir: dir,
  });
  await personalities.loadFromDirectory(join(dir, 'personalities'));
  try {
    personalities.setDefault(cfg.personality);
  } catch {
    // Configured default not on disk — keep the registry's built-in default.
  }
  const skillsCatalogDir = resolveSkillsCatalogDir(import.meta.dirname);
  const meshName = parseFlagValue(args, ['--mesh']) ?? 'default';
  const activePersonalityId = cfg.personality;

  // -------------------------------------------------------------------------
  // §3b step 3 (constructed here, STARTED at step 7) — watcher manager + cron
  // -------------------------------------------------------------------------
  //
  // Hoisted above `createAgentLoop` for the same reason both commands hoist
  // it: the loop registers the agent-callable `cron`/`watcher` tools against
  // these instances, and the scheduler's `runJob` forward-references the loop.
  const logger = new ConsoleLogger();
  let sharedLoop: AgentLoop | null = null;
  let chatServiceRef: import('@ethosagent/web-api').ChatService | null = null;
  let cronDeliverFn:
    | ((job: { origin?: { platform: string; chatId: string } }, output: string) => Promise<void>)
    | null = null;
  let watcherDeliverFn:
    | ((target: { platform: string; chatId: string }, text: string) => Promise<void>)
    | null = null;
  let watcherWakeFn: ((event: WatcherWakeEvent) => Promise<void>) | null = null;
  // Named so the SAME wake path drives both `WatcherManager` and the
  // call-capture daemon — one closure, not two copies (mirrors both commands).
  const watcherWake = async (event: WatcherWakeEvent): Promise<void> => {
    if (watcherWakeFn) await watcherWakeFn(event);
  };
  const watcherManager = new WatcherManager({
    storage,
    logger,
    deliver: async (target, text) => {
      if (watcherDeliverFn) await watcherDeliverFn(target, text);
    },
    wake: watcherWake,
  });
  const scheduler = new CronScheduler({
    storage,
    logger,
    executionBackend: new LocalExecutionBackend({ config: {}, secrets, logger }),
    systemTasks: { ...buildSystemTaskHandlers(cfg), ...watcherManager.systemTasks() },
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
    // Gateway-role delivery: an origin-bearing job routes its output back to
    // the channel it was created from. `ethos serve` alone cannot do this.
    deliver: async (job, output) => {
      if (cronDeliverFn) await cronDeliverFn(job, output);
    },
    // Serve-role turn shape (`runCronTurn`): reuses a web-origin session when
    // the personality matches, which the gateway's simpler runJob does not.
    runJob: async (job) => {
      const loop = sharedLoop;
      if (!loop) {
        throw new EthosError({
          code: 'INTERNAL',
          cause: 'System loop not yet initialised at cron firing time',
          action:
            'This is a wiring bug — the scheduler started before the agent loop was assigned. File an issue.',
        });
      }
      await personalities.loadFromDirectory(join(dir, 'personalities'));
      const pers = personalities.get(job.personalityId);
      // Recursion guard: a cron-spawned session cannot schedule further jobs.
      const toolsetOverride = pers?.toolset?.filter((t: string) => t !== 'cron');
      const webOrigin =
        job.origin?.platform === 'web' && job.origin.chatId ? job.origin.chatId : null;
      const ranAt = new Date().toISOString();
      const { sessionKey, output, reusedWebOrigin } = await runCronTurn({
        loop,
        sessions: session,
        jobId: job.id,
        prompt: job.prompt ?? '',
        personalityId: job.personalityId,
        webOrigin,
        ...(toolsetOverride ? { toolsetOverride } : {}),
      });
      chatServiceRef?.broadcastAll({
        type: 'cron.fired',
        jobId: job.id,
        ranAt,
        outputPath: null,
        ...(reusedWebOrigin && webOrigin ? { sessionKey: webOrigin } : {}),
      });
      return { jobId: job.id, ranAt, output, sessionKey };
    },
  });
  watcherManager.attachScheduler(scheduler);
  const cronTriggers: CronTriggers = buildCronTriggers(scheduler, cfg.cron);
  scheduler.setArmingBackend(cronTriggers.arming);

  // -------------------------------------------------------------------------
  // §3b step 2 — `createAgentLoop`, EXACTLY ONCE (plan §3c / §11 OQ1)
  // -------------------------------------------------------------------------
  //
  // ONE SYSTEM `AgentLoop`, with ONE `BackgroundExecutor` and ONE
  // `SQLiteJobStore`, shared by the gateway role and the serve role. Two would
  // be wasteful but not racy on the store itself (every mutation is a CAS in a
  // transaction, owner strings are unique per executor) — the REAL hazard is
  // SUBSCRIPTION: `onComplete` / `onRunUpdate` are in-memory per-instance
  // subscriber lists (packages/wiring/src/build-agent-loop.ts), so a job
  // claimed by a gateway-role executor would never fire the serve-role
  // executor's `subscribeJobComplete` / `subscribeRunUpdates` — the exact seams
  // web-api's run card and completion hand-back use. Hence one SYSTEM loop.
  //
  // WHAT THIS DOES NOT MAKE SINGLE: the per-bot loops. `buildGatewayBots` below
  // still gives every personality-bound bot its OWN `jobStore` +
  // `backgroundExecutor` (which is exactly the set `buildGatewayBusySources`
  // folds over), so the same per-instance subscriber hazard still stands
  // between a per-bot executor and web-api's subscribers: a job claimed by a
  // bot's executor does not reach them. That is inherited verbatim from
  // `ethos gateway start` and is NOT closed by this profile.
  const shared = await createAgentLoop(cfg, {
    profile: 'web',
    meshRegistryPath: meshRegistryPath(meshName),
    cronScheduler: scheduler,
    watcherManager,
  });
  sharedLoop = shared.loop;
  const systemLoop = shared.loop;

  // Per-bot routing table. Each personality-bound bot gets its own loop, the
  // same shape `ethos gateway start` builds today — this is NOT the
  // double-construction §3c warns about, which is about the two ROLES each
  // building a system loop.
  const {
    bots,
    messagingSetters: botMessagingSetters,
    notificationRouters: botNotificationRouters,
    refreshers: botPersonalityRefreshers,
  } = await buildGatewayBots(cfg, scheduler, watcherManager, (sessionKey) =>
    gatewayRef?.originThreadIdFor(sessionKey),
  );

  // Personality-directory seam for hot-reload, shared by the Gateway and by
  // every loop registry in the process.
  const personalityRefreshers = [shared.refreshPersonalities, ...botPersonalityRefreshers];
  const REFRESH_DEBOUNCE_MS = 300;
  let lastRefreshMs = 0;
  const personalityDirectory = {
    refresh: async (): Promise<void> => {
      const now = Date.now();
      if (now - lastRefreshMs < REFRESH_DEBOUNCE_MS) return;
      lastRefreshMs = now;
      const results = await Promise.allSettled([
        personalities.loadFromDirectory(join(dir, 'personalities')),
        ...personalityRefreshers.map((fn) => fn()),
      ]);
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        console.warn(
          `[boot] personality refresh: ${failed}/${results.length} registries failed to reload (serving last-good)`,
        );
      }
    },
    has: (id: string): boolean => personalities.get(id) != null,
    voice: (id: string) => personalities.get(id)?.voice,
    list: (): Array<{ id: string; name: string; isDefault: boolean }> => {
      const defaultId = personalities.getDefault().id;
      return personalities.list().map((p) => ({
        id: p.id,
        name: p.name,
        isDefault: p.id === defaultId,
      }));
    },
  };

  // -------------------------------------------------------------------------
  // §3b step 4 — serve-role stack (constructed; NOTHING binds a port here)
  // -------------------------------------------------------------------------
  const mesh = new AgentMesh(meshRegistryPath(meshName), { storage });
  // §11 OQ8 — the ACP server is CONSTRUCTED here and `startHttp()` is deferred
  // to step 10, AFTER reconciliation. This diverges from `serve.ts`, whose
  // comment "kept first so any breakage is obvious" binds ACP before anything
  // else. That rationale is a DEBUGGABILITY argument and it belongs to
  // `serve.ts`, which keeps its ordering unchanged. `boot.ts` is a new command
  // with no legacy to preserve, so it follows §3b step 10's CORRECTNESS
  // principle instead: nothing external reaches a half-reconciled process.
  const acpServer = buildServeAcpServer({
    dir,
    loop: systemLoop,
    session,
    mesh,
    personalities,
    activePersonality: activePersonalityId,
    teamFlag: undefined,
    mcpManager: shared.mcpManager,
    jobStore: shared.jobStore,
    backgroundExecutor: shared.backgroundExecutor,
    teamAuthToken: undefined,
  });

  const a2a = await buildServeA2aCore({
    config: cfg,
    dir,
    loop: systemLoop,
    personalities,
    activePersonality: activePersonalityId,
  });
  const {
    routeModules: a2aRouteModules,
    peering: a2aPeering,
    setA2aEnabled,
  } = buildServeA2aSurface({ config: cfg, core: a2a, toolRegistry: shared.toolRegistry });

  const apiKeys = new SqliteApiKeyStore(join(dir, 'sessions.db'));
  const idempotencyStore = new IdempotencyStore(join(dir, 'sessions.db'));
  const serveAttachmentCache = new FsAttachmentCache(
    new FsStorage(),
    join(dir, 'cache', 'attachments'),
  );
  void serveAttachmentCache.pruneOlderThan(24 * 60 * 60 * 1000).catch(() => {});
  const webDist = locateWebDist(parseFlagValue(args, ['--web-dist']));

  let titleFn: ((systemPrompt: string, userMessage: string) => Promise<string>) | undefined;
  try {
    const titleLlm = await createLLM(cfg);
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
    console.warn('[boot] session auto-title disabled: failed to create title LLM:', err);
  }

  // `ethos_gateway_adapter_up` reads LIVE adapter health — in the merged
  // process THIS process is the gateway, so there is no heartbeat file to read
  // through a staleness gate (which is what `serve.ts` has to do). Assigned
  // after the adapters exist; the closure is stable.
  let liveAdapters: PlatformAdapter[] = [];
  let heartbeatStartedAt = new Date().toISOString();
  const metricsText = createMetricsTextProvider({
    store: getObservabilityStore(),
    getGatewayAdapters: async () => {
      const hb = await buildGatewayHeartbeat(liveAdapters, heartbeatStartedAt);
      return hb.adapters.map((a) => ({ adapter: a.name, up: a.ok ? 1 : 0 }) as const);
    },
  });

  // §3b step 6 — the web API. Its own SSE clarify presenter is registered
  // INSIDE `createWebApi`, and its `ClarifyBridge.hydrate()`/`.sweep()` fire
  // there too (apps/web-api/src/index.ts), which is why step 4 and step 6 of
  // the plan are one call here.
  const created = buildServeWebApi({
    config: cfg,
    dir,
    loop: systemLoop,
    session,
    contextLog,
    personalities,
    identityMap,
    attachmentCache: serveAttachmentCache,
    apiKeys,
    idempotencyStore,
    toolRegistry: shared.toolRegistry,
    mcpManager: shared.mcpManager,
    pluginLoader: shared.pluginLoader,
    notificationRouter: shared.notificationRouter,
    cronScheduler: scheduler,
    cronTriggers,
    goalRunner: shared.goalRunner,
    jobStore: shared.jobStore,
    jobRunners: shared.jobRunners,
    backgroundExecutor: shared.backgroundExecutor,
    setOnSkillProposed: shared.setOnSkillProposed,
    onMemoryCaptured: shared.onMemoryCaptured,
    refreshLoopPersonalities: shared.refreshPersonalities,
    skillsInjector: shared.skillsInjector,
    skillsCatalogDir,
    sttProviders: shared.sttProviders,
    ttsProviders: shared.ttsProviders,
    realtimeProviders: shared.realtimeProviders,
    voiceConfig: shared.voiceConfig,
    voiceStack: shared.voiceStack,
    titleFn,
    corsOrigins,
    trustProxy,
    isLoopbackBind,
    webDist,
    metricsText,
    a2aRouteModules,
    a2aPeering,
    isA2aEnabled: a2a.isA2aEnabled,
    setA2aEnabled,
  });
  chatServiceRef = created.chatService;

  // -------------------------------------------------------------------------
  // §3b step 5 — gateway-role stack (constructed; adapters NOT started)
  // -------------------------------------------------------------------------
  const { attachmentCache, pruneTimer } = await createGatewayAttachmentCache(storage);
  const adapters = await buildGatewayAdapters(cfg, attachmentCache);
  liveAdapters = adapters;

  let gatewayRef: ReturnType<typeof buildGateway> | null = null;
  const { clarifyMessageCorrelator } = await registerGatewayClarifySurfaces({
    bots,
    adapters,
    systemLoop,
    resolveApprovalRoute: (sessionId) => gatewayRef?.resolveApprovalRoute(sessionId),
  });

  // Chapter 1 safety: fail closed if a channel adapter is configured without a
  // channel filter. Identical to `runGatewayStart`'s gate — a merged process
  // must not be a way to bypass it.
  if (adapters.length > 0 && !cfg.channelFilter) {
    console.error(
      `${c.red}FATAL: Channel adapters configured without channel_filter safety config.${c.reset}\n` +
        'Add channel_filter.<platform>.ownerUserId to config.yaml for each platform.',
    );
    process.exit(1);
  }
  for (const adapter of adapters) {
    const platform = adapter.id.includes(':') ? adapter.id.split(':')[0] : adapter.id;
    if (cfg.channelFilter && platform && !cfg.channelFilter[platform]) {
      console.error(
        `${c.red}FATAL: Adapter "${adapter.id}" has no channel_filter.${platform} config.${c.reset}`,
      );
      process.exit(1);
    }
  }

  let pairingDb: InstanceType<typeof Database> | undefined;
  if (cfg.channelFilter) {
    pairingDb = new Database(join(dir, 'pairing.db'));
    pairingDb.pragma('journal_mode = WAL');
    initPairingDb(pairingDb);
  }

  const deliveryLedger = new SQLiteDeliveryLedger(join(dir, 'delivery-ledger.db'));
  const inboundDedup = new SQLiteInboundDedupStore(join(dir, 'inbound-dedup.db'));

  const adapterMap = new Map<string, PlatformAdapter>();
  for (const adapter of adapters) {
    const colonIdx = adapter.id.indexOf(':');
    const platformKey = colonIdx > 0 ? adapter.id.slice(0, colonIdx) : adapter.id;
    if (!adapterMap.has(platformKey)) adapterMap.set(platformKey, adapter);
  }

  const allNotificationRouters = [...botNotificationRouters, shared.notificationRouter];
  const gatewayNotificationRouter: NotificationRouter = {
    route: (pluginId, opts) =>
      allNotificationRouters[0]?.route(pluginId, opts) ?? Promise.resolve(),
    register: (sessionKey, adapter) => {
      for (const r of allNotificationRouters) r.register(sessionKey, adapter);
    },
    deregister: (sessionKey) => {
      for (const r of allNotificationRouters) r.deregister(sessionKey);
    },
  };

  const hasTelegram = adapters.some((a) => a.id.startsWith('telegram:'));
  const telegramCardReader = hasTelegram ? await createTelegramPersonalityCardReader() : undefined;
  const telegramGreetingProvider = hasTelegram ? await createTelegramGreetingProvider() : undefined;

  const streamingMode = cfg.displayStreamingEdits ?? 'dms';
  const voiceOutputs = buildGatewayVoiceOutputs(cfg, storage);

  const gateway = buildGateway({
    config: cfg,
    bots,
    systemLoop,
    adapterMap,
    deliveryLedger,
    inboundDedup,
    resolveUserId,
    pluginLoader: shared.pluginLoader,
    trustedChannelPlugins: shared.activePersonality?.plugins
      ? new Set(shared.activePersonality.plugins)
      : undefined,
    notificationRouter: gatewayNotificationRouter,
    storage,
    attachmentCache,
    sttProviders: shared.sttProviders,
    ttsProviders: shared.ttsProviders,
    voiceConfig: shared.voiceConfig,
    voiceModeStore: voiceOutputs.voiceModeStore,
    voiceArtifacts: voiceOutputs.voiceArtifacts,
    transcoder: voiceOutputs.transcoder,
    channelVoiceOut: voiceOutputs.channelVoiceOut,
    voiceBitrateKbps: voiceOutputs.voiceBitrateKbps,
    personalityDirectory,
    onTurnComplete: ({ platform }: { platform: string }) => {
      const funnel = getFunnelTracker();
      void funnel.recordFirstReply();
      void funnel.recordChannelFirstReply(platform);
    },
    // Dreaming is not wired in this profile (see the file header), so there is
    // no `DreamExecutor` to stamp user activity on.
    onUserTurn: undefined,
    streamingEdits: { dm: streamingMode !== 'off', group: streamingMode === 'all' },
    pairingDb,
    clarifyMessageCorrelator,
    personalityCardReader: telegramCardReader,
    greetingProvider: telegramGreetingProvider,
  });
  gatewayRef = gateway;

  // Wire the send paths now that the Gateway exists.
  const gatewayMessagingSend: MessagingSendFn = async (platform, target, body) =>
    gateway.sendTo(platform, target, body);
  shared.setMessagingSend(gatewayMessagingSend);
  for (const setter of botMessagingSetters) setter(gatewayMessagingSend);
  cronDeliverFn = async (job, output) => {
    if (!job.origin) return;
    await gateway.sendTo(job.origin.platform, job.origin.chatId, output);
  };
  watcherDeliverFn = async (target, text) => {
    await gateway.sendTo(target.platform, target.chatId, text);
  };
  // Gateway-role wake: synthesize an `InboundMessage` into the owning
  // personality's lane so the woken turn has a real routing table and delivery
  // path. This strictly DOMINATES `serve.ts`'s wake, which drains the stream
  // with no surface consuming it — which is also why the single
  // `CallCaptureOwnershipManager` below is gateway-role (§11 OQ11).
  watcherWakeFn = async (event) => {
    const bot = bots.find(
      (b) => b.binding.type === 'personality' && b.binding.name === event.personalityId,
    );
    if (!bot) {
      console.error(
        `[watcher] wake dropped for "${event.watcherId}" — no bot bound to personality "${event.personalityId}"`,
      );
      return;
    }
    const wrapped = wrapUntrusted({
      content: event.summary,
      toolName: 'watcher',
      source: `${event.watcherId}:${event.target}`,
    });
    const msg: InboundMessage = {
      platform: 'watcher',
      chatId: `watcher:${event.watcherId}`,
      text: sanitize(
        `${event.promptPrefix ?? 'A watcher you own detected a change.'}\n\n${wrapped.content}`,
      ),
      isDm: true,
      isGroupMention: false,
      botKey: bot.botKey,
      messageId: `watcher-${event.watcherId}-${Date.now()}`,
      raw: { watcherId: event.watcherId, target: event.target },
    };
    const { adapter } = createCapturingAdapter();
    await gateway.handleMessage(msg, adapter);
  };

  for (const adapter of adapters) {
    adapter.onMessage((message: InboundMessage) => {
      void gateway.handleMessage(message, adapter).catch((err) => {
        console.error(`[boot:${adapter.id}] Error:`, err);
      });
    });
  }

  const approvalFlow = wireApprovalFlow(gateway, bots, adapters, {
    personalities,
    getProvider: createLazyProvider(() => createLLM(cfg)),
    model: cfg.model,
    ...(cfg.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: cfg.approvalTimeoutMs } : {}),
  });

  // §3c / §11 OQ11 — the SINGLE `CallCaptureOwnershipManager`, gateway-role,
  // unconditionally. Both `gateway.ts` and `serve.ts` construct one against the
  // IDENTICAL lock path; in one merged process the second construction reads a
  // lock naming its OWN pid, `process.kill(pid, 0)` on your own pid always
  // succeeds, so it would report `{claimed:false, ownerPid:<mypid>}` forever
  // and permanently disable call capture on that path. Hence exactly one, here.
  //
  // Gateway-role is not a config knob: the gateway's `wake` reaches a real
  // routing table (see `watcherWakeFn` above) while serve's drains the stream
  // with nothing consuming it. Fallback note for the record — with zero channel
  // bots configured the two degrade to the same drain, so serve-role would be
  // an acceptable substitute; never a better one, which is why it is fixed.
  let callCaptureOwnershipManager:
    | import('@ethosagent/platform-callcapture').CallCaptureOwnershipManager
    | undefined;
  let callCaptureState: { kind: string } = { kind: 'idle' };
  const runCallCaptureFromLoop = shared.runCallCapture;
  if (process.platform === 'darwin' && cfg.callCapture?.personalityId && runCallCaptureFromLoop) {
    const {
      CallCaptureDaemon,
      CallCaptureOwnershipManager,
      CaptureIndicator,
      callCaptureHealthPath,
      callCaptureLockPath,
      checkCallCaptureDependencies,
      MicActivityDetector,
      NotificationGate,
    } = await import('@ethosagent/platform-callcapture');
    const boundPersonalityId = cfg.callCapture.personalityId;
    const captureRunner = runCallCaptureFromLoop;
    callCaptureOwnershipManager = new CallCaptureOwnershipManager({
      lockPath: callCaptureLockPath(dir),
      retryIntervalMs: CALL_CAPTURE_HEARTBEAT_INTERVAL_MS,
      logger,
      onOwnershipClaimed: () => {
        const daemon = new CallCaptureDaemon({
          detector: new MicActivityDetector(),
          notificationGate: new NotificationGate(),
          checkDependencies: checkCallCaptureDependencies,
          personalityId: boundPersonalityId,
          wake: watcherWake,
          indicator: new CaptureIndicator({
            onError: (msg) => logger.warn(`call-capture: ${msg}`),
          }),
          onStateChange: (state) => {
            callCaptureState = state;
          },
          runCapture: async (abortSignal, source, onEntry, onAudioLevel) => {
            const result = await captureRunner(boundPersonalityId, {
              abortSignal,
              source,
              onEntry,
              onAudioLevel,
            });
            if (!result.ok) {
              logger.error(`call-capture: capture failed: ${result.error}`);
              return;
            }
            if (result.warning) logger.warn(`call-capture: ${result.warning}`);
            logger.info(`call-capture: saved transcript to ${result.artifactKey}`);
          },
          logger,
        });
        daemon.start();
        const writeCallCaptureHeartbeat = async () => {
          try {
            await storage.writeAtomic(
              callCaptureHealthPath(dir),
              JSON.stringify({ pid: process.pid, updatedAt: new Date().toISOString() }),
            );
          } catch {
            // Best-effort — a missed tick is harmless.
          }
        };
        void writeCallCaptureHeartbeat();
        const timer = setInterval(
          () => void writeCallCaptureHeartbeat(),
          CALL_CAPTURE_HEARTBEAT_INTERVAL_MS,
        );
        timer.unref?.();
        return async () => {
          daemon.stop();
          callCaptureState = { kind: 'idle' };
          clearInterval(timer);
          await storage.remove(callCaptureHealthPath(dir)).catch(() => {});
        };
      },
    });
    callCaptureOwnershipManager.start();
  }

  // -------------------------------------------------------------------------
  // §3b step 7 — cron start (its `LocalIntervalTrigger.start()` fires
  // `engine.fire()` immediately: today's implicit catch-up)
  // -------------------------------------------------------------------------
  cronTriggers.local?.start();
  void watcherManager.start().catch((err) => {
    console.error('[watcher] failed to start watcher manager:', err);
  });
  const seedSystemJobs = async () => {
    await scheduler.seedSystemJob({
      name: 'Observability Prune',
      schedule: '0 3 * * *',
      systemTask: 'observability-prune',
    });
    if (cfg.nightlyPass?.enabled) {
      await scheduler.seedSystemJob({
        name: 'Nightly Pass',
        schedule: cfg.nightlyPass.cron ?? '0 3 * * *',
        systemTask: 'nightly-pass',
      });
    }
    if (cfg.weeklyDigest?.enabled) {
      await scheduler.seedSystemJob({
        name: 'Weekly Digest',
        schedule: cfg.weeklyDigest.cron ?? '0 9 * * 1',
        systemTask: 'weekly-digest',
      });
    }
    if (cfg.evolverCronEnabled) {
      await scheduler.seedSystemJob({
        name: 'Skill Evolver',
        schedule: cfg.evolverSchedule ?? '0 3 * * *',
        systemTask: 'skill-evolver',
      });
    }
  };
  void seedSystemJobs();

  // -------------------------------------------------------------------------
  // §3b step 8 — adapters started. HARD PRECONDITION for step 9: a delivery
  // sweep against cold adapters sends into nothing while burning obligations.
  // -------------------------------------------------------------------------
  await Promise.all(adapters.map((a) => a.start()));
  heartbeatStartedAt = new Date().toISOString();
  await gateway.pluginsReady();

  // -------------------------------------------------------------------------
  // §3b step 9 — THE reconciliation call. This is the step that closes §1's
  // gap: `ethos serve` alone never runs the delivery / job sweeps, and
  // `ethos gateway start` alone never runs A2A `failNonTerminal`. Fail-open
  // per step — `runBootReconciliation` never rejects.
  // -------------------------------------------------------------------------
  // ONE per process, shared with the idle watcher below (see `pause-lifecycle.ts`).
  // A `NoopPauseLifecycle` unless the operator enabled `pauseClockCorrection`,
  // in which case it is a started clock-drift detector.
  const pauseLifecycle = createPauseLifecycle(cfg);
  const reconciliation = await runBootReconciliation({
    cronEngine: scheduler,
    ...(shared.backgroundExecutor ? { backgroundExecutor: shared.backgroundExecutor } : {}),
    // Both roles' bridges: every per-bot gateway bridge plus the shared loop's,
    // which is the one web-api registered its SSE presenter on.
    clarifyBridges: [...bots.map((b) => b.loop.clarifyBridge), systemLoop.clarifyBridge].filter(
      (b): b is NonNullable<typeof b> => b !== undefined,
    ),
    a2aTaskStore: a2a.taskStore,
    gateway,
    // Correction targets for a resume (plan/phases/clock-tolerance-pass.md §4).
    // Only what this profile already holds: the shared job store and the
    // Gateway. `kanbanStore` and `pendingMemoryStore` are not constructed here,
    // and dreaming is not wired in this profile at all (see the file header) —
    // an unsupplied target is skipped by design, and constructing one purely to
    // satisfy the dep would put a second writer on a store nothing else uses.
    //
    // `createAgentLoop` exposes the narrow `JobStore` contract, which has no
    // pause-correction entry point; the `SQLiteJobStore` it actually returns
    // does. Duck-typed rather than `instanceof`-checked because
    // `@ethosagent/job-store` is deliberately NOT a dependency of this app (see
    // `__tests__/boot-profile-reconciliation-gap.test.ts`), and a backend
    // without the method is simply skipped.
    ...(hasHeartbeatBump(shared.jobStore) ? { jobStore: shared.jobStore } : {}),
    // Shared with the idle watcher below: `readPauseOffset()` is consume-on-read,
    // so a second instance would silently eat the offset.
    pauseLifecycle,
    logger,
  });
  if (reconciliation.pauseOffset !== null) {
    console.log(
      `${c.dim}Resumed from a pause of ${reconciliation.pauseOffset.pauseDurationMs}ms${c.reset}`,
    );
  }
  // The mid-run resume seam. `runBootReconciliation` above handles the pause a
  // COLD-BOOTED process learns about from `readPauseOffset()`; this handles the
  // one a RUNNING process lives through, which is what snapshot+restore actually
  // does (the process image continues — no reboot, no boot code re-run). Absent
  // on `NoopPauseLifecycle`, so this is a no-op unless the operator enabled
  // `pauseClockCorrection`.
  //
  // Targets are exactly those `runBootReconciliation` was given, for the same
  // reasons documented at that call: this profile builds no `DreamExecutor` and
  // no kanban store, and a correction pass must not construct one.
  const onPauseResume = pauseLifecycle.onResume?.bind(pauseLifecycle);
  onPauseResume?.((pauseDurationMs) => {
    void applyPauseCorrections(
      {
        gateway,
        ...(hasHeartbeatBump(shared.jobStore) ? { jobStore: shared.jobStore } : {}),
      },
      pauseDurationMs,
      logger,
    );
  });
  const failedSteps = Object.entries(reconciliation.steps)
    .filter(([, outcome]) => outcome === 'failed')
    .map(([name]) => name);
  if (failedSteps.length > 0) {
    console.warn(
      `${c.yellow}⚠ boot reconciliation: ${failedSteps.join(', ')} failed (continuing)${c.reset}`,
    );
  }

  // §8 — one SYNCHRONOUS heartbeat write immediately after reconciliation, so
  // a resume does not sit up to HEARTBEAT_INTERVAL_MS before its first fresh
  // heartbeat lands and a poller reads it as dead.
  let heartbeatInFlight = false;
  const writeHeartbeat = async () => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    try {
      const hb = await buildGatewayHeartbeat(adapters, heartbeatStartedAt);
      await storage.writeAtomic(gatewayHealthPath(), JSON.stringify(hb));
    } catch {
      // Best-effort — the consumer treats stale data as degraded.
    } finally {
      heartbeatInFlight = false;
    }
  };
  await writeHeartbeat();

  // -------------------------------------------------------------------------
  // §3b step 10 — remaining servers bound. Everything external reaches a
  // FULLY reconciled process, ACP included (§11 OQ8, argued above).
  // -------------------------------------------------------------------------
  const metricsApiKeys = new SqliteApiKeyStore(join(dir, 'sessions.db'));
  const healthServer = createHealthServer(
    healthPort,
    healthHost,
    async () => {
      const hb = await buildGatewayHeartbeat(adapters, heartbeatStartedAt);
      const allOk = hb.adapters.length > 0 && hb.adapters.every((a) => a.ok);
      return {
        status: allOk ? 'ok' : 'degraded',
        uptime: process.uptime(),
        pid: hb.pid,
        startedAt: hb.startedAt,
        updatedAt: hb.updatedAt,
        adapters: hb.adapters,
      };
    },
    metricsText,
    createGatewayMetricsAuthCheck(metricsApiKeys),
  );
  console.log(`  health:  http://${healthHost}:${healthPort}/healthz`);

  // Inbound webhooks — opt-in, unchanged gate (§11 OQ5: same defaults as today,
  // no new exposure policy for the merged profile).
  const webhookPrefilterBackend = new LocalExecutionBackend({ config: {}, secrets, logger });
  const runWebhookPrefilter: PrefilterRunner = (file, opts) =>
    runScriptFile(
      { file, timeoutSeconds: opts.timeoutSeconds },
      {
        storage,
        executionBackend: webhookPrefilterBackend,
        stdin: opts.stdin,
        label: 'prefilter',
      },
    );
  const webhookServer =
    cfg.webhooks && Object.keys(cfg.webhooks).length > 0
      ? createWebhookServer(
          webhookPort,
          webhookHost,
          gateway,
          cfg.webhooks,
          createCapturingAdapter,
          runWebhookPrefilter,
        )
      : undefined;
  if (webhookServer && cfg.webhooks) {
    for (const hookId of Object.keys(cfg.webhooks)) {
      console.log(`  webhook: http://${webhookHost}:${webhookPort}/webhook/${hookId}`);
    }
  }
  // NOT WIRED: the inbound SIP webhook (port 3005). Its handler
  // (`createSipInboundHandler` + the voice stack + call log) is still inline in
  // `runGatewayStart`; Phase 1 did not extract it, and duplicating it here
  // would be the copy-paste the extraction exists to avoid. Telephony
  // deployments should keep using `ethos gateway start`.

  // Native platform webhooks — Telegram + Slack
  // (plan/phases/telegram-slack-webhook-mode.md §2b, §3c, §4).
  //
  // WIRED, unlike the SIP block above, because the asymmetry would be a silent
  // failure rather than a missing feature: `buildGatewayAdapters` is shared with
  // `runGatewayStart`, so a bot with `use_webhook` boots identically here and
  // calls `setWebhook()` against Telegram — registering a public URL with no
  // listener behind it. Every inbound message would then 404 with nothing in
  // this process's logs to say why. There is also nothing to duplicate: the
  // dispatch-map builder and the server are both shared imports.
  //
  // PLACED AFTER `adapters.map((a) => a.start())` (§3b step 8 above), AND THAT
  // IS LOAD-BEARING — the same ordering constraint `runGatewayStart` documents.
  // `TelegramAdapter.webhook` is `undefined` until `start()` has registered the
  // webhook and built grammy's callback, so building the map any earlier mounts
  // nothing and 404s every delivery.
  //
  // Opt-in and gated on need exactly like the `cfg.webhooks` block above: with
  // no bot in webhook mode and no app in HTTP mode, no port is bound at all.
  const platformWebhookMounts = buildPlatformWebhookMounts(cfg, adapters, (message) =>
    logger.warn(message),
  );
  let platformWebhookServer: import('node:http').Server | undefined;
  if (platformWebhookMounts.telegram.size > 0 || platformWebhookMounts.slack.size > 0) {
    // The non-loopback cleartext warning lives inside `createPlatformWebhookServer`
    // — it is the server that knows what host it bound.
    platformWebhookServer = createPlatformWebhookServer({
      port: platformWebhookPort,
      host: platformWebhookHost,
      telegram: platformWebhookMounts.telegram,
      slack: platformWebhookMounts.slack,
    });
    for (const botKey of platformWebhookMounts.telegram.keys()) {
      console.log(
        `  telegram: http://${platformWebhookHost}:${platformWebhookPort}/telegram/webhook/${botKey}`,
      );
    }
    for (const route of platformWebhookMounts.slack.keys()) {
      console.log(`  slack: http://${platformWebhookHost}:${platformWebhookPort}${route}`);
    }
  }

  const acpHttpServer = acpServer.startHttp(acpPort);
  console.log(`  acp:     http://localhost:${acpPort}`);
  const agentId = `${activePersonalityId}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
  const personalityConfig = personalities.get(activePersonalityId);
  await mesh.register({
    agentId,
    capabilities: personalityConfig?.capabilities ?? [],
    model: cfg.model,
    pid: process.pid,
    host: 'localhost',
    port: acpPort,
    activeSessions: 0,
    personalityId: activePersonalityId,
    displayName: personalityConfig?.name ?? activePersonalityId,
    boardSubscriptions: [{ board: 'global' }],
  });
  const stopMeshHeartbeat = mesh.startHeartbeat(agentId, () => acpServer.activeSessionCount);

  // §5 / §11 OQ10 — the web bind is LAST, and it is the one bind that walks a
  // fallback ladder. In one merged process 3001/3002/3003 are this process's
  // own ACP / health / webhook servers, so the ladder is handed the ports it
  // must never take: it skips them and lands past them, or fails loudly naming
  // what it skipped. Never a silent self-collision.
  const reservedPorts = new Set<number>([acpPort, healthPort]);
  if (webhookServer) reservedPorts.add(webhookPort);
  if (platformWebhookServer) reservedPorts.add(platformWebhookPort);
  const tokens = new WebTokenRepository({ dataDir: dir, storage });
  const token = await tokens.getOrCreate();
  const { server, port } = await listenWithFallback(
    created.app,
    webPort,
    WEB_PORT_FALLBACK_ATTEMPTS,
    webHost,
    reservedPorts,
  );
  created.voiceSocket.attach(server);
  created.satelliteSocket.attach(server);
  const displayHost = webHost === '0.0.0.0' ? 'localhost' : webHost;
  console.log(`  web:     http://${displayHost}:${port}`);
  if (!webDist) console.log(`  auth token: ${token}`);
  const exposureWarning = formatNonLoopbackWarning(webHost, port);
  if (exposureWarning) console.warn(`\n${exposureWarning}`);

  // -------------------------------------------------------------------------
  // §3b step 11 — watchdog / heartbeat timers
  // -------------------------------------------------------------------------
  emitReady('boot');
  notifyReady();
  const stopWatchdog = startWatchdog();
  const heartbeatTimer = setInterval(() => void writeHeartbeat(), HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  console.log(`${c.dim}Listening. Press Ctrl+C to stop.${c.reset}\n`);

  // Idle watcher — declared here only so `shutdown` can stop its interval. It
  // is CONSTRUCTED below the signal handlers, after every subsystem it reads
  // (plan/phases/idle-watcher.md §5).
  let idleWatcher: IdleWatcherManager | undefined;

  // -------------------------------------------------------------------------
  // Shutdown — tears down BOTH roles' resources, mirroring `runGatewayStart`'s
  // `shutdown` and `runServe`'s `cleanup`.
  // -------------------------------------------------------------------------
  //
  // Every step below runs through `guard`. The handlers are invoked as
  // `void shutdown()`, so a single rejection would both skip `process.exit(0)`
  // and surface as an unhandled rejection — leaving the process alive with its
  // adapters half-stopped and still registered in the mesh. `guard` is the
  // sync-throw-safe form of the `.catch(() => {})` this closure already used on
  // `mesh.unregister` / `storage.remove`, applied to every step instead of
  // three of them.
  const guard = (label: string, fn: () => unknown): Promise<void> =>
    Promise.resolve()
      .then(fn)
      .then(
        () => {},
        (err: unknown) => {
          logger.warn(`[boot] shutdown step "${label}" failed`, {
            component: 'boot',
            step: label,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );

  let shuttingDown: Promise<void> | undefined;
  const shutdown = async () => {
    // Reentrancy: this is registered on BOTH SIGINT and SIGTERM, and a second
    // signal — plausibly during the approval drain, which can take up to 5s —
    // would otherwise start a CONCURRENT teardown of the same mesh
    // registration, adapters, SQLite ledger, sockets and HTTP servers. One
    // promise, memoized; every caller awaits that same one.
    shuttingDown ??= (async () => {
      console.log(`\n${c.dim}Shutting down...${c.reset}`);
      await guard('watchdog', () => {
        if (stopWatchdog) stopWatchdog();
      });
      // Deny + audit suspended approvals FIRST on both surfaces — their auto-deny
      // timers are unref'd and never fire on the way out, and a later await that
      // hangs must not cost the audit row or the card update. MUST stay above
      // `adapters.stop()`, which tears out the transport the card updates ride.
      await guard('approval-flow', async () => {
        await approvalFlow.shutdown();
      });
      await guard('force-settle-approvals', () => {
        created.forceSettleApprovals();
      });
      await guard('mesh-heartbeat', () => {
        stopMeshHeartbeat();
      });
      await guard('health-server', () => {
        healthServer.close();
      });
      await guard('webhook-server', () => {
        webhookServer?.close();
      });
      await guard('platform-webhook-server', () => {
        platformWebhookServer?.close();
      });
      await guard('timers', () => {
        clearInterval(pruneTimer);
        clearInterval(heartbeatTimer);
        clearInterval(a2a.retentionTimer);
        idleWatcher?.stop();
        cronTriggers.local?.stop();
        pauseLifecycle.stop?.();
      });
      await guard('call-capture-ownership', async () => {
        await callCaptureOwnershipManager?.stop();
      });
      await guard('mesh-unregister', async () => {
        await mesh.unregister(agentId);
      });
      await guard('gateway-health-file', async () => {
        await storage.remove(gatewayHealthPath());
      });
      await guard('gateway', async () => {
        await gateway.shutdown({
          notify:
            '⚠ Ethos was interrupted while answering. Please resend your last message — your session history is preserved.',
        });
      });
      await guard('adapters', () => Promise.allSettled(adapters.map((a) => a.stop())));
      await guard('delivery-ledger', () => {
        deliveryLedger.close();
      });
      await guard('inbound-dedup', () => {
        inboundDedup.close();
      });
      await guard('sockets', () =>
        Promise.allSettled([created.voiceSocket.close(), created.satelliteSocket.close()]),
      );
      // The ACP listener. `serve.ts` never closes its own, but this profile
      // moved the ACP bind AFTER reconciliation on a correctness argument and
      // owes the teardown half of it: the idle watcher's `acp-sessions` source
      // reads `acpServer.activeSessionCount`, so leaving the listener up lets
      // the process call itself idle while it is still accepting connections.
      // NOT awaited on the close callback: `/ws` sockets are upgraded out of
      // the server's request cycle, so that callback can wait on a live client
      // forever — and a shutdown that never reaches `process.exit(0)` is worse
      // than a listener the exit tears down a moment later anyway.
      await guard('acp-server', () => {
        acpHttpServer.closeAllConnections();
        acpHttpServer.close();
      });
      await guard(
        'web-server',
        () => new Promise<void>((resolve) => server.close(() => resolve())),
      );
      process.exit(0);
    })();
    await shuttingDown;
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // -------------------------------------------------------------------------
  // Idle watcher (plan/phases/idle-watcher.md §5) — CONSTRUCTED LAST, after
  // every subsystem its sources read, and only when the operator opted in.
  // -------------------------------------------------------------------------
  //
  // `ethos gateway` and `ethos serve` each construct one; this profile is the
  // one that actually needs it, because plan/phases/single-process-boot-
  // profile.md exists to make a scale-to-zero deployment work and the watcher
  // is what decides when suspending is safe. Its sources are the UNION of both
  // roles' builders, reused verbatim — a source written only here would be a
  // source the two split commands silently lack.
  if (cfg.idleWatcher?.enabled === true) {
    idleWatcher = new IdleWatcherManager({
      // Gateway half FIRST, because `dedupeBusySources` keeps the first source
      // per name and the gateway half's twins sample strictly MORE state (see
      // the `bots` note below). Duplicates found today: `team-supervisors`
      // (both builders, identical check against the one `teamsDir()`), plus
      // `background-jobs` and `job-store` whenever the background subsystem is
      // on. Dropping the narrower twin of a fail-awake source would under-
      // report busy, so the order here is load-bearing, not cosmetic.
      sources: dedupeBusySources([
        ...buildGatewayBusySources({
          gateway,
          // Dreaming is not wired in this profile (see the file header), so
          // there is never a dream turn in flight for this to report.
          dreamExecutor: { hasActiveDreams: () => false },
          // The shared system loop's background handles ride along as one more
          // entry, so this builder's `background-jobs` / `job-store` sources
          // aggregate BOTH roles' work. That is what makes dropping the serve
          // half's same-named sources below lossless: without this fold the
          // survivor would see the per-bot executors only and miss every job
          // the web/cron/ACP surfaces started.
          bots: [
            ...bots,
            { jobStore: shared.jobStore, backgroundExecutor: shared.backgroundExecutor },
          ],
          approvalFlow,
          webhookServer,
          cronScheduler: scheduler,
          // Flat layout: `pidFilePath(name)` in @ethosagent/team-supervisor
          // resolves to `<teamsDir()>/<name>.pid`, so this is the dir the PID
          // files it writes actually land in.
          teamsPidDir: teamsDir(),
          callCaptureActive: callCaptureOwnershipManager
            ? () => callCaptureState.kind !== 'idle'
            : undefined,
        }),
        ...buildServeBusySources({
          chatService: created.chatService,
          voiceSocket: created.voiceSocket,
          satelliteSocket: created.satelliteSocket,
          pendingApprovalCount: created.pendingApprovalCount,
          backgroundExecutor: shared.backgroundExecutor,
          jobStore: shared.jobStore,
          cronScheduler: scheduler,
          teamsPidDir: teamsDir(),
          acpServer,
          callCaptureActive: callCaptureOwnershipManager
            ? () => callCaptureState.kind !== 'idle'
            : undefined,
        }),
      ]),
      // The same instance boot reconciliation read the pause offset from. Its
      // outbound half is still a no-op: a real host adapter that signals a
      // Firecracker-style control plane is a later phase, so the watcher's
      // arming gates are what matter here.
      pauseLifecycle,
      // Flips to `true` when the `pauseLifecycle` above becomes a real host
      // adapter. While it is a no-op, `signalReadyToSuspend()` resolves,
      // latches, and stops the watcher having suspended nothing — so gate 3b
      // refuses to arm rather than accept that as a handoff.
      hostSignalAvailable: false,
      capabilities: deriveIdleWatcherCapabilities(cfg),
      options: cfg.idleWatcher,
      logger,
    });
    // Fire-and-forget: `start()` evaluates the arming gates itself and is a
    // no-op (with a logged reason) when any of them refuses.
    idleWatcher.start();
    // Re-arm after a resume. `IdleWatcherManager` latches `signalled` and
    // stops itself once it has handed off, and `start()` is the ONE path that
    // clears that latch and resets the streak and cooldown — so without a
    // caller a snapshot-restored process would suspend exactly once and never
    // again.
    //
    // On a cold boot `pauseOffset` is null and this branch never runs — `start()`
    // above has already armed the watcher exactly once. It covers the case where
    // this process genuinely cold-booted after a restore and learned the pause
    // from `readPauseOffset()`.
    if (reconciliation.pauseOffset !== null) {
      idleWatcher.start();
      logger.info(
        `[idle-watcher] re-armed after a pause of ${reconciliation.pauseOffset.pauseDurationMs}ms`,
        { component: 'idle-watcher' },
      );
    }
    // THE MID-RUN PATH, and the one that actually fires under snapshot+restore.
    // That deployment continues the same process image, so nothing above runs a
    // second time; the clock-drift detector is the only thing that observes the
    // resume. Registering here re-arms the watcher AND applies every clock
    // correction this profile can — previously the corrections had no live
    // trigger at all and the watcher would have suspended exactly once, ever.
    // Captured: `idleWatcher` is a `let` assigned inside this branch, so the
    // closure cannot narrow it away from `undefined` at the point it runs.
    const watcher = idleWatcher;
    onPauseResume?.((pauseDurationMs) => {
      watcher.start();
      logger.info(`[idle-watcher] re-armed after a pause of ${pauseDurationMs}ms`, {
        component: 'idle-watcher',
      });
    });
  }

  await new Promise(() => {});
}
