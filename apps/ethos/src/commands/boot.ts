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
import {
  type EthosConfig,
  ethosDir,
  loadConfigStrict,
  type WebhookHookConfig,
} from '@ethosagent/config';
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
  seedAllSystemJobs,
  systemJobProblem,
  wrapUntrusted,
} from '@ethosagent/wiring';
import { runBootReconciliation } from '../boot-reconciliation';
import {
  appliedSliceFor,
  appliedStateOf,
  type ClarifyCorrelator,
  type ConfigSectionDiff,
  closeIdleRouteListener,
  commitHotAdd,
  createClarifyCorrelatorRegistry,
  createLiveBotBusySource,
  createReloadRunner,
  hotAddRefusalReason,
  loadAndDiffConfig,
  markApplied,
  markRetired,
  planReconcile,
  planWebRebind,
  rebindWebServer,
  reconcilePending,
  replaceBotWiring,
  retireBotFully,
  shouldReloadConfig,
  sliceConfigForBot,
  sliceConfigForWebhook,
  startAndMountPlatformWebhook,
  swapBotLive,
  unmountPlatformWebhook,
  type WebBindTarget,
} from '../config-reload';
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
  channelDigestSystemTask,
  createCapturingAdapter,
  createGatewayAttachmentCache,
  createGatewayMetricsAuthCheck,
  createTelegramGreetingProvider,
  createTelegramPersonalityCardReader,
  type GatewayBotWiring,
  openChannelTranscriptStore,
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
  resolveAllowedOrigins,
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
/** How often `ethos boot` re-reads `~/.ethos/config.yaml` to diff it against
 *  the running config (plan/phases/gateway-live-reload.md §1, open question
 *  §7.1 — DECIDED: a dedicated constant, not `HEARTBEAT_INTERVAL_MS`). The two
 *  answer different questions — "is this process alive" vs "did the operator
 *  edit the file" — and sharing a constant would mean neither can move without
 *  the other. They happen to be equal today; that is a coincidence, not a
 *  contract. */
const CONFIG_RELOAD_INTERVAL_MS = 10_000;
/** Same guard, same value, same reason as `REFRESH_DEBOUNCE_MS` below: a
 *  reload triggered from more than one seam must not run twice in a burst. */
const CONFIG_RELOAD_DEBOUNCE_MS = 300;

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
 * Close the last wiring gap in the ambient channel digest
 * (plan/phases/ambient-group-monitoring.md R12, "the digest also lands in the
 * web notifications feed").
 *
 * `Gateway.runChannelDigest` posts each digest's in-app copy through
 * `GatewayConfig.channelDigestFeed`, and this is the only process that has one
 * to give it: `CreateWebApiResult.notifyChannelDigest`, which broadcasts the
 * existing `notification` SSE event to every connected session.
 *
 * It is a DIRECT sink and not a `NotificationRouter` wrapper any more. The
 * router was the wrong carrier twice over: `route()` returns `Promise<void>`,
 * so it cannot report whether the digest landed, and its default implementation
 * is a silent no-op when no adapter is registered for the key — which is always,
 * since web-api registers adapters only for CHAT session keys and a lane key
 * such as `telegram:bot-a:-100` is never one. Under `deliverTo: 'inApp'` the
 * gateway read that silence as delivery and marked the lane consumed.
 *
 * `ethos gateway` runs the digest with no in-process web API and `ethos serve`
 * runs a web API with no adapters and therefore no digest at all
 * (`channel-digest` is absent from serve's system-job roster). Under those two
 * commands there is no feed, so `deliverTo: 'inApp'` is refused at startup by
 * `channelDigestSystemTask` rather than discarding every digest.
 *
 * `omittedCount` is not dropped: the count is already inside the message as
 * `formatDigest`'s "showing N of M" footnote. The structured
 * `omittedCount`/`usedCount` fields on `notifyChannelDigest` stay unused rather
 * than being re-derived, which would print the same footnote twice.
 *
 * THE RETURN VALUE IS PASSED STRAIGHT THROUGH, and it is the reason this
 * adapter is not a one-line lambda at the call site. `notifyChannelDigest`
 * answers with the number of connected SSE sessions the digest was written to,
 * because it is an ephemeral multicast rather than a durable feed — nothing is
 * stored, so a digest broadcast with no browser tab open reaches nobody and
 * leaves no trace. Reporting that as delivery is what let a nightly digest be
 * summarised, marked consumed by the watermark, and discarded permanently.
 * Zero recipients has to arrive at the Gateway as zero.
 */
export function channelDigestFeed(
  notifyChannelDigest: (digest: { laneKey: string; summary: string }) => { recipients: number },
): (entry: { laneKey: string; text: string }) => { recipients: number } {
  return (entry) => notifyChannelDigest({ laneKey: entry.laneKey, summary: entry.text });
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
  const allowedOrigins = resolveAllowedOrigins(process.env);
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
  const session = createSessionStore({
    dataDir: dir,
    ...(config.retention ? { retention: config.retention } : {}),
  });
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
  const logger = new ConsoleLogger({}, cfg.logs?.level);
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
    ...(cfg.cron?.maxParallelJobs !== undefined
      ? { maxParallelJobs: cfg.cron.maxParallelJobs }
      : {}),
    executionBackend: new LocalExecutionBackend({ config: {}, secrets, logger }),
    systemTasks: {
      ...buildSystemTaskHandlers(cfg),
      ...watcherManager.systemTasks(),
      // See `channelDigestSystemTask` — the digest needs the live Gateway, so
      // it cannot come from the shared handler table. Forward-referenced
      // through `gatewayRef`, which is set before cron starts.
      // `inAppSink: true` — this profile has a web API, so `deliverTo: 'inApp'`
      // has somewhere to land. See `channelDigestFeed` above.
      'channel-digest': channelDigestSystemTask(cfg, () => gatewayRef, { inAppSink: true }),
    },
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
  // `boot` threads `cronTriggers` into the shared serve-role helper below, so
  // it inherits serve's `POST /cron/fire` mount and must answer the same way:
  // `hasHttpSurface: true` means a `cron.fireUrl` genuinely stops the
  // in-process interval here (plan/phases/cron-fire-url-collapse.md, D1).
  const cronTriggers: CronTriggers = buildCronTriggers(scheduler, cfg.cron, {
    hasHttpSurface: true,
  });
  for (const notice of cronTriggers.notices) {
    console.log(`${c.yellow}⚠${c.reset} ${c.dim}${notice}${c.reset}`);
  }
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
  const coldBuilt = await buildGatewayBots(cfg, scheduler, watcherManager, (sessionKey) =>
    gatewayRef?.originThreadIdFor(sessionKey),
  );
  const bots = coldBuilt.bots;

  // Personality-directory seam for hot-reload, shared by the Gateway and by
  // every loop registry in the process.
  //
  // Seeded with the SYSTEM loop's refresher only. Each bot's own refresher is
  // pushed by its `registerBotLive` call below — cold-booted and hot-added bots
  // alike — so a bot that leaves takes its refresher with it. The resulting
  // order is `[system, ...bots]`, exactly what the bulk seed produced.
  const personalityRefreshers = [shared.refreshPersonalities];
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
  let heartbeatStartedAt = new Date().toISOString();
  const metricsText = createMetricsTextProvider({
    store: getObservabilityStore(),
    getGatewayAdapters: async () => {
      // Read LIVE, not from a one-time snapshot: a bot hot-added or removed by
      // the config reconciler below must be reflected here on the very next
      // scrape (plan/phases/gateway-live-reload.md §2).
      const hb = await buildGatewayHeartbeat(gatewayRef?.listAdapters() ?? [], heartbeatStartedAt);
      return hb.adapters.map((a) => ({ adapter: a.name, up: a.ok ? 1 : 0 }) as const);
    },
  });
  // P2-counters — ethos_http_requests_total. Same closure shape as serve.ts.
  const recordHttpRequest = (method: string, status: number): void => {
    getObservabilityStore().recordHttpRequest(method, status);
  };

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
    allowedOrigins,
    trustProxy,
    isLoopbackBind,
    webDist,
    metricsText,
    recordHttpRequest,
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

  let gatewayRef: ReturnType<typeof buildGateway> | null = null;
  // Clarify correlators, LIVE and KEYED BY BOT. `registerGatewayClarifySurfaces`
  // returns a correlator covering only the adapters it was handed, so a
  // hot-added bot's surface is registered alongside the boot-time one rather
  // than replacing it — and, because the registry is keyed, a removed bot's
  // correlator is dropped instead of accumulating over a dead adapter, and a
  // re-added bot replaces its own. See `createClarifyCorrelatorRegistry` for
  // why the cold-boot correlator gets a slot of its own and runs last.
  //
  // DELIBERATE DIVERGENCE from `runGatewayStart`, which still passes the
  // possibly-undefined correlator straight through (and whose test asserts it
  // is omitted rather than always returning null). That rule was written when
  // the surface list was frozen at boot; here it is not, so "no correlating
  // surface at construction" no longer means "none ever" — a Telegram or
  // WhatsApp bot added live must be able to resolve its own force-replies.
  // The cost when the list is empty is one pure `isSenderAllowed` check.
  const clarifyCorrelators = createClarifyCorrelatorRegistry();
  // `typeof bots` rather than an imported `GatewayBotConfig`: only
  // `commands/gateway.ts` may import `@ethosagent/gateway` (daemon-free
  // doctrine, `daemon-free-smoke.test.ts`).
  //
  // ALWAYS per bot — there is no bulk cold-boot call. Each platform's surface
  // builder filters the adapter list by its own `<platform>:` prefix first, so
  // a one-bot slice builds that bot's surface and nothing else. Returns what it
  // registered so the caller's teardown can delete exactly its own correlator
  // and never one that has since replaced it.
  const registerClarifySurfacesFor = async (
    botsSlice: typeof bots,
    adaptersSlice: PlatformAdapter[],
    botKey: string,
  ): Promise<ClarifyCorrelator | undefined> => {
    const registered = await registerGatewayClarifySurfaces({
      bots: botsSlice,
      adapters: adaptersSlice,
      systemLoop,
      resolveApprovalRoute: (sessionId) => gatewayRef?.resolveApprovalRoute(sessionId),
    });
    const correlate = registered.clarifyMessageCorrelator;
    if (!correlate) return undefined;
    clarifyCorrelators.set(botKey, correlate);
    return correlate;
  };
  const clarifyMessageCorrelator = clarifyCorrelators.correlate;

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

  // Observe-mode transcript sink (plan/phases/ambient-group-monitoring.md R1).
  // Deliberately NOT eager like the two stores above: this one is opened on
  // first write, so `channel-transcript.db` appears only once a chat is
  // actually being watched. See `openChannelTranscriptStore`.
  const channelTranscript = openChannelTranscriptStore(join(dir, 'channel-transcript.db'));

  const adapterMap = new Map<string, PlatformAdapter>();
  // The FULL set, keyed by botKey — `adapterMap` keeps only the first adapter
  // per platform, so on its own it cannot answer `gateway.listAdapters()`.
  const botAdapterMap = new Map<string, PlatformAdapter>();
  for (const adapter of adapters) {
    const colonIdx = adapter.id.indexOf(':');
    const platformKey = colonIdx > 0 ? adapter.id.slice(0, colonIdx) : adapter.id;
    if (!adapterMap.has(platformKey)) adapterMap.set(platformKey, adapter);
    botAdapterMap.set(colonIdx > 0 ? adapter.id.slice(colonIdx + 1) : adapter.id, adapter);
  }

  // Filled by the per-bot `registerBotLive` calls below (bots first, in
  // registration order), then closed with the shared loop's router — the same
  // `[...bots, shared]` order the bulk seed produced, which `route()` below
  // depends on: it delegates to element 0.
  const allNotificationRouters: NotificationRouter[] = [];
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
    botAdapters: botAdapterMap,
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
    channelTranscript,
    channelDigestFeed: channelDigestFeed(created.notifyChannelDigest),
    clarifyMessageCorrelator,
    personalityCardReader: telegramCardReader,
    greetingProvider: telegramGreetingProvider,
  });
  gatewayRef = gateway;

  // Wire the send paths now that the Gateway exists.
  const gatewayMessagingSend: MessagingSendFn = async (platform, target, body) =>
    gateway.sendTo(platform, target, body);
  shared.setMessagingSend(gatewayMessagingSend);
  // Per-bot messaging setters are called by `registerBotLive` below, with every
  // other per-bot registration.
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

  const approvalSeams = {
    personalities,
    getProvider: createLazyProvider(() => createLLM(cfg)),
    model: cfg.model,
    ...(cfg.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: cfg.approvalTimeoutMs } : {}),
  };
  /**
   * One approval surface per bot, keyed by botKey. `wireApprovalFlow` binds its
   * hook to the bots it was handed, so a bot that arrives live needs its own
   * call — and a bot that LEAVES needs its own shutdown, which a single bulk
   * flow could not give it. Cold-booted bots go through the same per-bot call
   * for that reason, not for symmetry's sake: replacing one of them used to
   * leave its approval surface bound to a retired loop forever.
   */
  const approvalFlows = new Map<string, ReturnType<typeof wireApprovalFlow>>();

  /**
   * Every live bot's app-level teardown handle, keyed by botKey — cold-booted
   * and hot-added alike. See {@link replaceBotWiring} for why there is exactly
   * one registry rather than a "hot bots only" one.
   *
   * The transport half — route unmount, deregister, adapter stop — is
   * `retireBotTransport`, deliberately kept separate: a swap retires the old
   * transport while the old wiring is still the thing a rollback must displace.
   */
  const botWiring = new Map<string, () => Promise<void>>();

  /**
   * The app-level registrations EVERY bot makes, whatever its transport and
   * however it arrived — messaging send, notification routers, personality
   * refreshers, clarify surfaces, approval surface — plus the teardown that
   * undoes exactly them.
   *
   * Shared by the cold-boot loop below, the channel-bot hot-add path
   * (`adaptersSlice` is the one new adapter) and the webhook-route path
   * (`adaptersSlice` is empty, because a `webhooks.<hookId>` bot's transport is
   * the webhook server's per-request capturing adapter). Registered BEFORE any
   * `start()`: Slack's clarify home reader is only picked up by
   * `registerHomeEvents`, which runs inside it.
   */
  const registerBotLive = async (
    bot: (typeof bots)[number],
    wiring: GatewayBotWiring,
    adaptersSlice: PlatformAdapter[],
  ): Promise<() => Promise<void>> => {
    for (const setter of wiring.messagingSetters) setter(gatewayMessagingSend);
    allNotificationRouters.push(...wiring.notificationRouters);
    personalityRefreshers.push(...wiring.refreshers);
    let correlator: ClarifyCorrelator | undefined;
    let flow: ReturnType<typeof wireApprovalFlow> | undefined;
    // Every undo is identity-based (splice THIS router, delete THIS
    // correlator), so it is safe to run against a half-finished registration
    // and safe to run after a replacement has registered under the same
    // botKey.
    const undo = async (): Promise<void> => {
      for (const router of wiring.notificationRouters) {
        const i = allNotificationRouters.indexOf(router);
        if (i >= 0) allNotificationRouters.splice(i, 1);
      }
      for (const refresh of wiring.refreshers) {
        const i = personalityRefreshers.indexOf(refresh);
        if (i >= 0) personalityRefreshers.splice(i, 1);
      }
      if (correlator) clarifyCorrelators.delete(bot.botKey, correlator);
      if (!flow) return;
      if (approvalFlows.get(bot.botKey) === flow) approvalFlows.delete(bot.botKey);
      await flow.shutdown();
    };
    try {
      correlator = await registerClarifySurfacesFor([bot], adaptersSlice, bot.botKey);
      flow = wireApprovalFlow(gateway, [bot], adaptersSlice, approvalSeams);
      approvalFlows.set(bot.botKey, flow);
    } catch (err) {
      await undo();
      throw err;
    }
    return undo;
  };

  // Cold-booted bots are wired through the SAME call, into the SAME registry,
  // as anything added later. That is finding 2's fix: `botWiring` used to hold
  // hot-added bots only, so replacing a bot that had been present since boot
  // found no handle to run and left its routers, correlator, approval surface,
  // messaging binding and refresher registered beside the replacement's.
  for (const bot of bots) {
    const wiring = coldBuilt.perBot.get(bot.botKey) ?? {
      messagingSetters: [],
      notificationRouters: [],
      toolRegistries: [],
      refreshers: [],
    };
    const own = botAdapterMap.get(bot.botKey);
    botWiring.set(bot.botKey, await registerBotLive(bot, wiring, own ? [own] : []));
  }
  // Last, so `route()`'s delegate-to-element-0 still lands on the first bot's
  // router in a deployment that has one.
  allNotificationRouters.push(shared.notificationRouter);

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
  // Reconcile the system cron jobs against config (plan D7). Not just a
  // seeder: a schedule edited in config.yaml is patched onto the existing job,
  // and a feature switched off has its job removed instead of firing forever.
  // Only the jobs in that table are touched — watcher ticks are seeded per
  // watcher by the watcher manager and are left alone.
  void seedAllSystemJobs(scheduler, cfg, 'boot')
    .then((outcomes) => {
      for (const o of outcomes) {
        const problem = systemJobProblem(o);
        if (problem) console.error(`[cron] ${problem}`);
      }
    })
    .catch((err) => {
      console.error('[cron] system job reconciliation failed:', err);
    });

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
  //
  // THE ROUTE TABLE IS LIVE (plan/phases/gateway-live-reload.md Phase C, §0
  // row 5). `createWebhookServer` resolves `webhooks[hookId]` per request, so
  // this object — not a copy of it — is what decides which routes are served.
  // The reconciler below mutates it in place; nothing rebinds the server.
  const liveWebhooks: Record<string, WebhookHookConfig> = { ...(cfg.webhooks ?? {}) };
  let webhookServer: ReturnType<typeof createWebhookServer> | undefined;
  /**
   * Bind the webhook listener if a route now exists and nothing is listening.
   *
   * Called once here and again from the reconciler: a deployment that booted
   * with no `webhooks:` block binds no port at all (the unchanged opt-in gate),
   * so the operator's FIRST live route has to bring the listener up with it.
   * That is a first bind, not Phase D's rebind — the port never changes.
   */
  const ensureWebhookServer = (): void => {
    if (webhookServer || Object.keys(liveWebhooks).length === 0) return;
    webhookServer = createWebhookServer(
      webhookPort,
      webhookHost,
      gateway,
      liveWebhooks,
      createCapturingAdapter,
      runWebhookPrefilter,
    );
    for (const hookId of Object.keys(liveWebhooks)) {
      console.log(`  webhook: http://${webhookHost}:${webhookPort}/webhook/${hookId}`);
    }
  };
  ensureWebhookServer();
  /**
   * The inverse of `ensureWebhookServer`, and the half that was missing.
   *
   * The bind is on demand — no `webhooks:` block, no port — so the unbind has
   * to be on demand too. Without it, removing the last route left the port
   * held by a server whose route table was empty: every request 404'd, this
   * file's own no-route/no-bound-port rule was broken, and an operator who
   * removed a route to free the port for something else found it still taken.
   * Closing clears the handle, so a later live addition binds again through
   * `ensureWebhookServer`.
   */
  const releaseWebhookServerIfIdle = (): void => {
    const bound = webhookServer !== undefined;
    webhookServer = closeIdleRouteListener({
      server: webhookServer,
      routeCount: Object.keys(liveWebhooks).length,
      close: (server) => server.close(),
    });
    if (bound && webhookServer === undefined) {
      logger.info('[config-reload] webhook listener closed — no routes left to serve', {
        component: 'config-reload',
        port: webhookPort,
      });
    }
  };
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
  //
  // AND THESE TWO MAPS ARE LIVE (Phase C, §0 row 6). `createPlatformWebhookServer`
  // reads them per request, so they are the mount table rather than a snapshot
  // of it: `startAndMountPlatformWebhook` adds a hot-added bot's route and
  // `unmountPlatformWebhook` drops a removed one, with no rebind. Built from
  // `gateway.listAdapters()` for the same reason `liveAdapters` was — one
  // source of truth for "which adapters are live", never a captured array.
  const platformWebhookMounts = buildPlatformWebhookMounts(cfg, gateway.listAdapters(), (message) =>
    logger.warn(message),
  );
  let platformWebhookServer: import('node:http').Server | undefined;
  /** Bind the platform-webhook listener if a route now exists. See
   *  `ensureWebhookServer` — same first-bind-on-demand rule, same reason. */
  const ensurePlatformWebhookServer = (): void => {
    if (platformWebhookServer) return;
    if (platformWebhookMounts.telegram.size === 0 && platformWebhookMounts.slack.size === 0) return;
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
  };
  ensurePlatformWebhookServer();
  /** The inverse of `ensurePlatformWebhookServer` — see
   *  `releaseWebhookServerIfIdle` for why an on-demand bind owes an on-demand
   *  unbind. Both mount tables have to be empty: one listener serves the
   *  Telegram routes and the Slack ones. */
  const releasePlatformWebhookServerIfIdle = (): void => {
    const bound = platformWebhookServer !== undefined;
    platformWebhookServer = closeIdleRouteListener({
      server: platformWebhookServer,
      routeCount: platformWebhookMounts.telegram.size + platformWebhookMounts.slack.size,
      close: (server) => server.close(),
    });
    if (bound && platformWebhookServer === undefined) {
      logger.info('[config-reload] platform webhook listener closed — no routes left to serve', {
        component: 'config-reload',
        port: platformWebhookPort,
      });
    }
  };

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
  //
  // Both webhook ports are reserved UNCONDITIONALLY, even when nothing is
  // listening on them yet: Phase C lets a live config edit bind either one
  // later, and a web server that had meanwhile settled on that port would turn
  // the operator's first webhook route into an EADDRINUSE warning.
  const reservedPorts = new Set<number>([acpPort, healthPort, webhookPort, platformWebhookPort]);
  const tokens = new WebTokenRepository({ dataDir: dir, storage });
  const token = await tokens.getOrCreate();
  //
  // The ladder is also what a Phase D rebind re-runs (§0 row 9), so it is a
  // named closure rather than one inline call: a live `web.port`/`web.host`
  // edit must land through the SAME reservation and fallback rules as cold
  // boot, not a second, subtly different bind path.
  const listenWeb = (bind: WebBindTarget) =>
    listenWithFallback(
      created.app,
      bind.port,
      WEB_PORT_FALLBACK_ATTEMPTS,
      bind.host,
      reservedPorts,
    );
  const attachWebSockets = (target: Awaited<ReturnType<typeof listenWeb>>['server']): void => {
    created.voiceSocket.attach(target);
    created.satelliteSocket.attach(target);
  };
  /** The address ASKED for. Not the same as the one landed on — the ladder may
   *  have moved the port — and it is the requested one a rebind diffs against. */
  let webRequested: WebBindTarget = { host: webHost, port: webPort };
  const firstBind = await listenWeb(webRequested);
  let webServer = firstBind.server;
  attachWebSockets(webServer);
  /** Print where the web UI now is, plus the non-loopback exposure box when
   *  the bind is network-reachable. Called at cold boot and again after a
   *  Phase D rebind — a rebind onto `0.0.0.0` is exactly as exposing as a cold
   *  boot onto it, so it owes the operator the same warning. */
  const announceWebBind = (host: string, boundPort: number): string | null => {
    const displayHost = host === '0.0.0.0' ? 'localhost' : host;
    console.log(`  web:     http://${displayHost}:${boundPort}`);
    return formatNonLoopbackWarning(host, boundPort);
  };
  const exposureWarning = announceWebBind(webHost, firstBind.port);
  if (!webDist) console.log(`  auth token: ${token}`);
  if (exposureWarning) console.warn(`\n${exposureWarning}`);

  // -------------------------------------------------------------------------
  // §3b step 11 — watchdog / heartbeat timers
  // -------------------------------------------------------------------------
  emitReady('boot');
  notifyReady();
  const stopWatchdog = startWatchdog();
  const heartbeatTimer = setInterval(() => void writeHeartbeat(), HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  // Config live-reload — plan/phases/gateway-live-reload.md Phases 0, A and C.
  //
  // Phase 0 is the diff and the honest "restart required to apply" line for
  // every key that cannot hot-apply (§0 rows 7-10). Phase A is the reconciler
  // below it: a bot added, removed, or edited in `config.yaml` is applied to
  // the running gateway without bouncing web/ACP/cron along with it. Phase C
  // adds the two webhook route tables — the generic `webhooks:` block (§0 row
  // 5) and the native Telegram/Slack webhook-mode mounts (§0 row 6).
  //
  // `channel_filter` (Phase B) is NOT reconciled here, and that is the one
  // thing still bounding what may be accepted: a hot-added bot is only safe
  // when the running gateway ALREADY HAS an installed `channel_filter` entry
  // for its platform — which means one that was present in the configuration
  // this process booted with, since `Gateway.channelFilter` is assigned at
  // construction and nothing replaces it live. A filter an operator adds in
  // the SAME edit as the bot is in the file but not in force, so that
  // addition is refused, by name, until a restart installs it. Every running
  // bot is left untouched, and the cold-boot fatal gate above is unchanged.
  //
  // Poll, not `fs.watch`/`chokidar` (§1, §6) — the same poll-on-a-known-seam
  // shape the personality refresh above uses, for the same reason: a file
  // event fires on a HALF-written editor save, a poll just reads a moment
  // later. `ethos boot` only for v1 (§7.5): restart is already narrow in the
  // split `ethos gateway start`, so live-reload earns far less there.
  // --- Phase A reconciler -------------------------------------------------

  /**
   * What is ACTUALLY running, per unit — the thing a reconcile is planned
   * against. Cold boot applied all of `cfg`, so that is the seed; from here on
   * a unit only enters this ledger once its own reconcile has succeeded.
   */
  const applied = appliedStateOf(cfg);

  /**
   * Report a unit that is not live, without repeating itself on every poll.
   *
   * A failed or refused unit is NOT marked applied, so it is retried on every
   * subsequent poll — which is what turns a transient failure (a credential
   * the transport rejected once, a bot still draining a wedged turn) into a
   * self-healing one without an operator touching the file again.
   *
   * A MISSING `channel_filter` ENTRY IS NOT ONE OF THOSE. Adding the entry to
   * `config.yaml` does not install it in the running gateway (Phase B), so
   * that refusal repeats until the process is restarted — which is exactly
   * what its message says. The first appearance of a reason is the warning an
   * operator needs; every identical repeat is a debug line, so a permanently
   * refused bot does not drown the log.
   */
  const lastFailureReason = new Map<string, string>();
  const noteFailure = (kind: 'bot' | 'webhook', id: string, reason: string): void => {
    const key = `${kind}:${id}`;
    const detail = { component: 'config-reload', [kind]: id };
    if (lastFailureReason.get(key) === reason) {
      logger.debug(`[config-reload] ${kind} "${id}" still not applied — ${reason}`, detail);
      return;
    }
    lastFailureReason.set(key, reason);
    logger.warn(`[config-reload] ${kind} "${id}" not applied — ${reason}`, detail);
  };
  const noteApplied = (kind: 'bot' | 'webhook', id: string, what: string): void => {
    lastFailureReason.delete(`${kind}:${id}`);
    logger.info(`[config-reload] ${kind} "${id}" ${what}`, {
      component: 'config-reload',
      [kind]: id,
    });
  };
  const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  /**
   * A live edit this process will not apply. `EthosError` rather than a raw
   * `Error` per the surface-code rule (`no-raw-throw.test.ts`); it is caught by
   * the reconcile loop and rendered through `noteFailure`, never to a terminal.
   */
  const refuse = (cause: string, action: string): EthosError =>
    new EthosError({ code: 'CONFIG_INVALID', cause, action });

  /** Everything a hot-add needs, built while the old instance still serves. */
  type PreparedBot = {
    bot: (typeof bots)[number];
    adapter: PlatformAdapter;
    wiring: GatewayBotWiring;
    slice: EthosConfig;
  };

  /**
   * Build and validate one bot WITHOUT touching the running gateway.
   *
   * Every rejection lives here — the Phase-B-shaped refusal (a bot whose
   * platform has no INSTALLED `channel_filter` cannot be accepted until Phase B
   * can install one live), an identity that names nothing, a slice that builds
   * the wrong number of bots, a credential the builder throws on. A rejection
   * at this point is a no-op: nothing has been retired and nothing registered.
   */
  const prepareBotLive = async (id: string, source: EthosConfig): Promise<PreparedBot> => {
    // Phase B is not wired, which bounds what may be accepted here. The filter
    // state that decides is the one INSTALLED IN THE GATEWAY, never the parsed
    // file: `Gateway.channelFilter` is construction-time, so a filter added in
    // the same edit as the bot is not in force and admitting the bot on the
    // strength of the file would put it live under access control that was
    // never installed. A refusal is per-bot and non-fatal: every running bot
    // keeps serving, and the cold-boot `process.exit(1)` gate above is
    // untouched.
    const refusal = hotAddRefusalReason(source, id, (platform) =>
      gateway.hasChannelFilterFor(platform),
    );
    if (refusal) {
      throw refuse(
        refusal,
        'Fix the entry in ~/.ethos/config.yaml — a newly added channel_filter entry also needs a restart of ethos.',
      );
    }
    const slice = sliceConfigForBot(source, id);
    if (!slice) {
      throw refuse(
        'no matching entry in the reloaded config',
        'The bot identity named by the diff is not in config.yaml — re-save the file.',
      );
    }
    const built = await buildGatewayBots(slice, scheduler, watcherManager, (sessionKey) =>
      gatewayRef?.originThreadIdFor(sessionKey),
    );
    const newAdapters = await buildGatewayAdapters(slice, attachmentCache);
    const bot = built.bots[0];
    const adapter = newAdapters[0];
    if (!bot || !adapter || built.bots.length !== 1 || newAdapters.length !== 1) {
      throw refuse(
        'the config slice did not build exactly one bot and one adapter',
        'Check the entry in ~/.ethos/config.yaml — its credentials or personality binding are incomplete.',
      );
    }
    const wiring = built.perBot.get(bot.botKey);
    if (!wiring) {
      throw refuse(
        'the config slice built a bot the builder did not attribute',
        'This is a wiring bug — file an issue.',
      );
    }
    return { bot, adapter, wiring, slice };
  };

  /**
   * Register, wire and start a prepared bot as ONE transaction.
   *
   * `commitHotAdd` owns the ordering and the rollback: if the wiring or the
   * start fails, the route is unmounted, the wiring undone and the bot
   * deregistered (which stops the adapter), so the next poll's retry meets an
   * empty routing table rather than the duplicate-botKey guard.
   *
   * Returns the wiring undo for the caller to hold.
   */
  const commitBotLive = async (id: string, prepared: PreparedBot): Promise<() => Promise<void>> => {
    const { bot, adapter, wiring, slice } = prepared;
    let routes: string[] = [];
    const undoWiring = await commitHotAdd({
      // Runtime duplicate guard lives in `Gateway.addAdapter`; this call throws
      // rather than replacing a live routing-table entry.
      register: () => gateway.addAdapter(adapter, bot),
      wire: () => registerBotLive(bot, wiring, [adapter]),
      // Phase C, §0 row 6 — start THIS adapter, then mount THIS adapter's
      // native webhook route, as one sequence. The cold-boot path gets the same
      // ordering per BOOT by placing `buildPlatformWebhookMounts` after
      // `Promise.all(adapters.map(start))`; a hot-add needs it per ADAPTER,
      // which is what `startAndMountPlatformWebhook` is. A non-webhook-mode bot
      // mounts nothing and the call is just a start.
      start: async () => {
        const mounted = await startAndMountPlatformWebhook(
          adapter,
          slice,
          platformWebhookMounts,
          (message) => logger.warn(message),
        );
        routes = [...mounted.telegram.map((k) => `/telegram/webhook/${k}`), ...mounted.slack];
        if (routes.length > 0) ensurePlatformWebhookServer();
      },
      unmount: () => {
        unmountPlatformWebhook(platformWebhookMounts, adapter);
      },
      deregister: () => gateway.removeAdapter(bot.botKey),
      onRollbackError: (err) =>
        logger.warn(`[config-reload] bot "${id}" rollback step failed`, {
          component: 'config-reload',
          bot: id,
          error: reason(err),
        }),
    });
    if (routes.length > 0) {
      logger.info(`[config-reload] bot "${id}" webhook route mounted`, {
        component: 'config-reload',
        bot: id,
        routes: routes.join(', '),
      });
    }
    return undoWiring;
  };

  const addBotLive = async (id: string, source: EthosConfig): Promise<void> => {
    const prepared = await prepareBotLive(id, source);
    botWiring.set(prepared.bot.botKey, await commitBotLive(id, prepared));
  };

  /**
   * Retire one bot's TRANSPORT: unmount its native webhook route, drain its
   * in-flight turns, deregister it, stop its adapter. The app-level wiring is
   * left alone — `removeBotLive` undoes it, and the swap path keeps it so a
   * restore has something to come back to.
   */
  const retireBotTransport = async (id: string): Promise<void> => {
    const botKey = id.slice(id.indexOf(':') + 1);
    // Unmount BEFORE the adapter is deregistered and stopped, so no delivery
    // reaches a handler whose adapter is on its way down. Resolved from the
    // live adapter list, which still answers for a cold-booted bot — the
    // mount table is not restricted to hot-added ones.
    const adapter = gateway.listAdapters().find((a) => a.id === id);
    if (adapter) unmountPlatformWebhook(platformWebhookMounts, adapter);
    await gateway.removeAdapter(botKey);
  };

  const removeBotLive = async (id: string): Promise<void> => {
    const botKey = id.slice(id.indexOf(':') + 1);
    // Transport first, wiring second — see `retireBotFully`. A drain that does
    // not finish within the abort grace leaves the bot QUARANTINED and still
    // fully wired, and throws; undoing the wiring first would have pulled the
    // approval flow, clarify correlator, routers, messaging bindings and
    // refreshers out from under the turn that is still running, with the
    // teardown handle already deleted so the retry could not restore it.
    await retireBotFully(botWiring, botKey, () => retireBotTransport(id));
  };

  /**
   * The configuration a unit is RUNNING — the only correct rollback source.
   *
   * Not "the config that parsed before this one": if version B parses and a
   * bot fails to apply, and version C is then saved, a failed C replacement
   * would rebuild B — a configuration that was never live — while the applied
   * ledger still says A. The ledger and the rollback source have to be the
   * same record, so both come from `applied`.
   */
  const appliedSliceOrRefuse = (kind: 'bot' | 'webhook', id: string): EthosConfig => {
    const slice = appliedSliceFor(applied, kind, id);
    if (!slice) {
      throw refuse(
        `no applied configuration recorded for ${kind} "${id}"`,
        'Restart ethos — the running configuration for this unit cannot be reconstructed.',
      );
    }
    return slice;
  };

  /**
   * Replace a live bot with a rebuilt one. See `swapBotLive` for why the
   * replacement is BUILT before the old instance is retired, and why it cannot
   * also be STARTED first.
   */
  const changeBotLive = async (id: string, source: EthosConfig): Promise<void> => {
    const botKey = id.slice(id.indexOf(':') + 1);
    await swapBotLive({
      prepare: () => prepareBotLive(id, source),
      retire: () => retireBotTransport(id),
      commit: async (prepared) => {
        const undoWiring = await commitBotLive(id, prepared);
        // The replacement is live, so the outgoing registration can go. Its
        // undos are identity-based and cannot touch the new one.
        await replaceBotWiring(botWiring, botKey, undoWiring);
      },
      // NOT the adapter object `retire` just stopped — a fresh one, built from
      // the APPLIED slice and committed through the same transaction a hot-add
      // uses. `PlatformAdapter` promises nothing about `start()` after
      // `stop()`; see `swapBotLive`.
      rebuildPrevious: () => {
        logger.warn(
          `[config-reload] bot "${id}" replacement failed — rebuilding the instance that was running`,
          { component: 'config-reload', bot: id },
        );
        return prepareBotLive(id, appliedSliceOrRefuse('bot', id));
      },
      onRestoreFailed: (err) =>
        logger.error(`[config-reload] bot "${id}" is NOT running — the rebuild also failed`, {
          component: 'config-reload',
          bot: id,
          error: reason(err),
        }),
    });
  };

  // --- Phase C reconciler: generic webhook routes (§0 row 5) --------------
  //
  // A `webhooks.<hookId>` entry is TWO things: a route on the webhook server
  // and a first-class `webhook:<hookId>` bot in the gateway's routing table
  // (that is how `buildGatewayBots` builds it at cold boot). Serving the route
  // without registering the bot would answer the POST and then drop the
  // message at `no_bot_available` — so both move together, and the ORDER is
  // the same discipline as the adapter mount above: register the bot first,
  // then open the route; close the route first, then deregister the bot.

  /** Built while the existing route, if any, is still being served. */
  type PreparedWebhook = {
    bot: (typeof bots)[number];
    wiring: GatewayBotWiring;
    hook: WebhookHookConfig;
  };

  const prepareWebhookLive = async (
    hookId: string,
    source: EthosConfig,
  ): Promise<PreparedWebhook> => {
    const slice = sliceConfigForWebhook(source, hookId);
    const hook = source.webhooks?.[hookId];
    if (!slice || !hook) {
      throw refuse(
        'no matching entry in the reloaded config',
        'The hookId named by the diff is not under `webhooks:` in config.yaml — re-save the file.',
      );
    }
    const built = await buildGatewayBots(slice, scheduler, watcherManager, (sessionKey) =>
      gatewayRef?.originThreadIdFor(sessionKey),
    );
    const bot = built.bots[0];
    if (!bot || built.bots.length !== 1) {
      throw refuse(
        `the config slice built ${built.bots.length} bots, not one`,
        'Check the `webhooks:` entry in ~/.ethos/config.yaml — its personality binding is incomplete.',
      );
    }
    const wiring = built.perBot.get(bot.botKey);
    if (!wiring) {
      throw refuse(
        'the config slice built a bot the builder did not attribute',
        'This is a wiring bug — file an issue.',
      );
    }
    return { bot, wiring, hook };
  };

  /**
   * Register a prepared route as one transaction. The bot goes in BEFORE the
   * route opens — serving the POST without a bot in the routing table would
   * answer the request and then drop the message at `no_bot_available`.
   *
   * A webhook bot has no `PlatformAdapter` of its own (its transport is the
   * webhook server's per-request capturing adapter), so `start` is the route
   * opening and `unmount` is closing it again.
   */
  const commitWebhookLive = async (
    hookId: string,
    prepared: PreparedWebhook,
  ): Promise<() => Promise<void>> =>
    commitHotAdd({
      register: () => gateway.addBot(prepared.bot),
      wire: () => registerBotLive(prepared.bot, prepared.wiring, []),
      start: async () => {
        liveWebhooks[hookId] = prepared.hook;
        ensureWebhookServer();
      },
      unmount: () => {
        delete liveWebhooks[hookId];
      },
      // `removeAdapter` on a bot that never had one: its deregistration path is
      // adapter-optional by design (see `Gateway.addBot`), so this drains the
      // route's in-flight turns and drops its lanes without touching anything
      // else. There is no transport to stop.
      deregister: () => gateway.removeAdapter(`webhook:${hookId}`),
      onRollbackError: (err) =>
        logger.warn(`[config-reload] webhook "${hookId}" rollback step failed`, {
          component: 'config-reload',
          hook: hookId,
          error: reason(err),
        }),
    });

  const addWebhookRouteLive = async (hookId: string, source: EthosConfig): Promise<void> => {
    const prepared = await prepareWebhookLive(hookId, source);
    botWiring.set(prepared.bot.botKey, await commitWebhookLive(hookId, prepared));
  };

  const retireWebhookTransport = async (hookId: string): Promise<void> => {
    delete liveWebhooks[hookId];
    await gateway.removeAdapter(`webhook:${hookId}`);
  };

  /** Same transport-then-wiring ordering as `removeBotLive`, for the same
   *  reason: a webhook bot's drain can be deferred too. */
  const removeWebhookRouteLive = async (hookId: string): Promise<void> => {
    await retireBotFully(botWiring, `webhook:${hookId}`, () => retireWebhookTransport(hookId));
  };

  /** Same build-then-retire ordering as `changeBotLive`, for the same reason. */
  const changeWebhookRouteLive = async (hookId: string, source: EthosConfig): Promise<void> => {
    const botKey = `webhook:${hookId}`;
    await swapBotLive({
      prepare: () => prepareWebhookLive(hookId, source),
      retire: () => retireWebhookTransport(hookId),
      commit: async (prepared) => {
        const undoWiring = await commitWebhookLive(hookId, prepared);
        await replaceBotWiring(botWiring, botKey, undoWiring);
      },
      // Rebuilt from the APPLIED slice, not re-registered from the object that
      // was just retired and not rebuilt from the previously parsed file — the
      // same rule `changeBotLive` follows, so the two swap paths cannot drift.
      rebuildPrevious: () => {
        logger.warn(
          `[config-reload] webhook "${hookId}" replacement failed — rebuilding the route that was being served`,
          { component: 'config-reload', hook: hookId },
        );
        return prepareWebhookLive(hookId, appliedSliceOrRefuse('webhook', hookId));
      },
      onRestoreFailed: (err) =>
        logger.error(
          `[config-reload] webhook "${hookId}" is NOT served — the rebuild also failed`,
          {
            component: 'config-reload',
            hook: hookId,
            error: reason(err),
          },
        ),
    });
  };

  /**
   * Apply the outstanding `bots` work.
   *
   * `applied` — not the parsed file — is what this is driven from, and a unit
   * is marked applied only after its own reconcile RETURNED. One bot that fails
   * neither aborts the others nor gets recorded as live: it stays in the next
   * `planReconcile` result and is retried on the following poll, whether or not
   * the file has been touched again.
   */
  const applyBotPlan = async (plan: ConfigSectionDiff, source: EthosConfig): Promise<void> => {
    for (const id of plan.removed) {
      try {
        await removeBotLive(id);
        markRetired(applied, 'bot', id);
        noteApplied('bot', id, 'removed live');
      } catch (err) {
        noteFailure('bot', id, reason(err));
      }
    }
    for (const id of plan.changed) {
      try {
        await changeBotLive(id, source);
        markApplied(applied, source, 'bot', id);
        noteApplied('bot', id, 'replaced live');
      } catch (err) {
        noteFailure('bot', id, reason(err));
      }
    }
    for (const id of plan.added) {
      try {
        await addBotLive(id, source);
        markApplied(applied, source, 'bot', id);
        noteApplied('bot', id, 'added live');
      } catch (err) {
        noteFailure('bot', id, reason(err));
      }
    }
  };

  /** The `webhooks` half of `applyBotPlan`, with the same ledger discipline. */
  const applyWebhookPlan = async (plan: ConfigSectionDiff, source: EthosConfig): Promise<void> => {
    for (const hookId of plan.removed) {
      try {
        await removeWebhookRouteLive(hookId);
        markRetired(applied, 'webhook', hookId);
        noteApplied('webhook', hookId, 'removed live');
      } catch (err) {
        noteFailure('webhook', hookId, reason(err));
      }
    }
    for (const hookId of plan.changed) {
      try {
        await changeWebhookRouteLive(hookId, source);
        markApplied(applied, source, 'webhook', hookId);
        noteApplied('webhook', hookId, 'replaced live');
      } catch (err) {
        noteFailure('webhook', hookId, reason(err));
      }
    }
    for (const hookId of plan.added) {
      try {
        await addWebhookRouteLive(hookId, source);
        markApplied(applied, source, 'webhook', hookId);
        noteApplied('webhook', hookId, 'added live');
      } catch (err) {
        noteFailure('webhook', hookId, reason(err));
      }
    }
  };

  // --- Phase D reconciler: the web bind (§0 row 9) ------------------------
  //
  // ONE SERVER, AND NOTHING ELSE. `rebindWebServer` is handed the listener,
  // the two addresses, the same fallback ladder cold boot used, and the
  // WebSocket re-attach — no `AgentLoop`, no session store, no job store, no
  // mesh registration, no gateway. Sessions in flight over the ACP or channel
  // adapters do not notice; a browser holding the dashboard reconnects.
  //
  // A brief close-then-listen gap is expected and accepted (plan §6).
  /** `host:port` of a rebind that failed and FELL BACK. A working listener is
   *  worth more than a retry loop that bounces it every ten seconds, so this
   *  one waits for the operator to change the address again. */
  let webRebindRefused: string | null = null;

  const applyWebBindDiff = async (
    source: EthosConfig,
    announceSkip: boolean,
  ): Promise<'skipped' | 'rebound'> => {
    const decision = planWebRebind(webRequested, source, args, process.env);
    if (decision.action === 'skip') {
      if (announceSkip) {
        logger.debug(`[config-reload] web bind unchanged — ${decision.reason}`, {
          component: 'config-reload',
        });
      }
      return 'skipped';
    }
    const wanted = `${decision.target.host}:${decision.target.port}`;
    if (webRebindRefused === wanted) return 'skipped';
    const outcome = await rebindWebServer({
      server: webServer,
      current: webRequested,
      target: decision.target,
      listen: listenWeb,
      onListening: attachWebSockets,
      logger,
    });
    webServer = outcome.server;
    webRequested = outcome.requested;
    webRebindRefused = outcome.fellBack ? wanted : null;
    const warning = announceWebBind(outcome.requested.host, outcome.port);
    if (warning) console.warn(`\n${warning}`);
    return 'rebound';
  };

  const configFilePath = join(dir, 'config.yaml');
  /** The last config that PARSED — what the next diff is computed against.
   *  NOT a rollback source: what a failed replacement is rebuilt from is the
   *  per-unit slice in `applied`, which records what each unit is RUNNING. */
  let liveConfig: EthosConfig = cfg;
  let lastConfigMtimeMs: number | null = null;
  let lastConfigReloadMs = 0;
  let configReloadInFlight = false;
  /** A rebind that left NOTHING listening. Retried on every poll — there is no
   *  working dashboard left to protect. */
  let webRebindPending = false;

  const reloadConfig = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastConfigReloadMs < CONFIG_RELOAD_DEBOUNCE_MS) return;
    lastConfigReloadMs = now;
    if (configReloadInFlight) return;
    configReloadInFlight = true;
    try {
      // mtime gate before the STRICT parse. `loadConfigStrict` resolves every
      // `${secrets:ref}` in the file, which for an AWS-backed resolver is a
      // network call per reference — polling that every tick on an unchanged
      // file would be pure waste (§7.1's "wasted work" concern). A unit that
      // failed to apply outranks the gate: its retry is owed regardless of
      // whether anybody touches the file again.
      const mtimeMs = await storage.mtime(configFilePath);
      const pending = webRebindPending || reconcilePending(applied, liveConfig);
      if (!shouldReloadConfig({ mtimeMs, lastMtimeMs: lastConfigMtimeMs, pending })) return;
      const fileMoved = mtimeMs === null || mtimeMs !== lastConfigMtimeMs;
      if (fileMoved) {
        lastConfigMtimeMs = mtimeMs;
        const next = await loadAndDiffConfig(liveConfig, { storage, secrets, logger });
        if (!next) {
          // Unreadable, mid-write, or a parse error. Keep the last config that
          // parsed, and drop the mtime so the retry is not gated on a further
          // edit.
          lastConfigMtimeMs = null;
          return;
        }
        liveConfig = next.config;
      }
      const plan = planReconcile(applied, liveConfig);
      await applyBotPlan(plan.bots, liveConfig);
      await applyWebhookPlan(plan.webhooks, liveConfig);
      // Both listeners are bound on demand, so they are released on demand
      // too. Done HERE rather than inside each removal so a swap — retire then
      // re-add, which empties a route table for an instant — does not bounce
      // the port, while every path that genuinely leaves no route behind (a
      // removal, a rolled-back add, a replacement that failed both ways) is
      // covered by the same two calls.
      releaseWebhookServerIfIdle();
      releasePlatformWebhookServerIfIdle();
      // LAST, and guarded on its own: the web bind is the only reconcile that
      // drops a listening socket, so a failure there must not be able to
      // abort the bot/webhook reconciles that already succeeded above.
      try {
        await applyWebBindDiff(liveConfig, fileMoved);
        webRebindPending = false;
      } catch (err) {
        webRebindPending = true;
        logger.warn('[config-reload] web bind could not be applied', {
          component: 'config-reload',
          error: reason(err),
        });
      }
    } finally {
      configReloadInFlight = false;
    }
  };
  /**
   * The poll, and the handle shutdown stops it by.
   *
   * Clearing the interval only stops the NEXT reconcile. The one already
   * running can be halfway through adding a bot, replacing an adapter or
   * rebinding the web server — all of which shutdown is concurrently tearing
   * down, so a listener or an adapter created after cleanup walked past it
   * survives the exit. `stop()` therefore latches the refusal first and then
   * awaits the reconcile in flight; see `createReloadRunner`.
   */
  const configReloadRunner = createReloadRunner(reloadConfig, (err) =>
    logger.warn('[config-reload] reconcile failed', {
      component: 'config-reload',
      error: reason(err),
    }),
  );
  const configReloadTimer = setInterval(
    () => configReloadRunner.trigger(),
    CONFIG_RELOAD_INTERVAL_MS,
  );
  configReloadTimer.unref?.();

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
      // FIRST, and it is an await, not a `clearInterval`. A reconcile already
      // in flight adds bots, replaces adapters and rebinds the web server —
      // exactly the resources every step below tears down — so a teardown
      // racing it can walk past a listener or an adapter that the reconcile
      // then brings up behind it, leaving it alive after the process says it
      // is down. `stop()` refuses every further reconcile and waits for the
      // active one to finish before anything is torn down.
      await guard('config-reload', async () => {
        clearInterval(configReloadTimer);
        await configReloadRunner.stop();
      });
      await guard('watchdog', () => {
        if (stopWatchdog) stopWatchdog();
      });
      // Deny + audit suspended approvals FIRST on both surfaces — their auto-deny
      // timers are unref'd and never fire on the way out, and a later await that
      // hangs must not cost the audit row or the card update. MUST stay above
      // `adapters.stop()`, which tears out the transport the card updates ride.
      await guard('approval-flow', async () => {
        await Promise.all([...approvalFlows.values()].map((f) => f.shutdown()));
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
        // `configReloadTimer` is NOT cleared here — the `config-reload` step
        // above cleared it and then awaited the reconcile in flight, before
        // any of the resources that reconcile touches were torn down.
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
        // `webServer`, not a captured `server`: a Phase D rebind replaces the
        // listener, and closing the one this process started on would leave
        // the current one up while the exit races it.
        () => new Promise<void>((resolve) => webServer.close(() => resolve())),
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
          //
          // NO STATIC `...bots` SNAPSHOT. `buildGatewayBusySources` folds
          // `deps.bots` into its counters once, at construction, and the idle
          // watcher's `sources` are readonly — so a captured array reports
          // retired bots' stores and misses the ones that replaced them. It used
          // to be a static half plus a "hot bots only" half split by botKey, and
          // a REPLACED bot keeps its botKey: it landed in neither, and the
          // process could suspend with its work in flight. One live fold covers
          // every bot however it got there.
          bots: [
            createLiveBotBusySource(() => gateway.listBots()),
            { jobStore: shared.jobStore, backgroundExecutor: shared.backgroundExecutor },
          ],
          // Cold-boot surface plus every hot-added bot's own, read live.
          approvalFlow: {
            pendingCount: () =>
              [...approvalFlows.values()].reduce((n, f) => n + f.pendingCount(), 0),
          },
          // A façade, not the handle: Phase C can bind the webhook listener
          // after this point (an operator's first live route), and a captured
          // `undefined` would leave those held connections invisible to the
          // idle watcher — which would then suspend the process out from under
          // a caller waiting on a reply.
          webhookServer: {
            inFlightSyncRequests: () => webhookServer?.inFlightSyncRequests() ?? 0,
          },
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
      hostSignalAvailable: pauseLifecycle.hostSignalAvailable ?? false,
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
