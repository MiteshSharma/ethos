import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { StorageA2aAllowlist } from '@ethosagent/a2a';
import {
  applyPlatformShim,
  deriveBotKey,
  type EthosConfig,
  ethosDir,
  loadConfigStrict,
  readRawConfig,
  type SlackAppConfig,
  type TelegramBotConfig,
  validateBotBindings,
  type WhatsAppConfig,
  writeConfig,
} from '@ethosagent/config';
import {
  type AgentLoop,
  deriveBotKey as deriveBotKeyFromSeed,
  LaneVoiceModeStore,
  laneVoiceModePath,
} from '@ethosagent/core';
import { CronScheduler, runScriptFile } from '@ethosagent/cron';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import { LocalExecutionBackend } from '@ethosagent/execution-local';
import {
  createCapturingAdapter,
  createFfmpegTranscoder,
  createVoiceArtifactStore,
  DreamExecutor,
  Gateway,
  type GatewayBotConfig,
} from '@ethosagent/gateway';
import { registerGoalNotifications } from '@ethosagent/goal-runner';
import { KanbanStore } from '@ethosagent/kanban-store';
import { ConsoleLogger } from '@ethosagent/logger';
import {
  createPersonalityRegistry,
  firstParagraph,
  PersonalityA2aIdentityProvider,
} from '@ethosagent/personalities';
import { bundledSkillsSource, createInjectors } from '@ethosagent/skills';
import Database from '@ethosagent/sqlite';
import { readRuntime, removeRuntime } from '@ethosagent/team-supervisor';
import { createA2aTools } from '@ethosagent/tools-a2a';
// Platform adapters are loaded LAZILY in runGatewayStart() — see plan/IMPROVEMENT.md P0-3.
// Their underlying SDKs (grammy, discord.js, @slack/bolt, imapflow…) are
// optionalDependencies of @ethosagent/cli. A failed install for any one of
// them must not crash the CLI for users who don't run that platform.
import {
  type ClarifyResponse,
  EthosError,
  type GatewayMessagePayload,
  type GatewayMessageResult,
  type InboundMessage,
  type LLMProvider,
  type MemoryContext,
  type NotificationRouter,
  type PersonalityRegistry,
  type PlatformAdapter,
  resolveModelDisplay,
  type SessionStore,
  type ToolRegistry,
} from '@ethosagent/types';
import {
  type WatcherDeliverTarget,
  WatcherManager,
  type WatcherWakeEvent,
} from '@ethosagent/watchers';
import {
  APPROVAL_SURFACE_ALWAYS_ASK,
  createApprovalDangerPredicate,
  createLazyProvider,
  createMemoryProvider,
  createSessionStore,
  IdentityMap,
  initPairingDb,
  type MessagingSendFn,
  resolveKanbanDbPath,
  sanitize,
  wrapUntrusted,
} from '@ethosagent/wiring';
import {
  ApprovalCoordinator,
  type ApprovalObservability,
  createSlackApprovalHook,
} from '../approval-coordinator';
import { createHealthServer } from '../health-server';
import { formatQuickCommandOutput, runQuickCommand } from '../lib/quick-command-runner';
import { emitReady } from '../logger';
import { migrateSessionKeysIfNeeded } from '../migrations/session-keys-multi-bot';
import { notifyReady, startWatchdog } from '../sd-notify';
import { createWebhookServer, type PrefilterRunner } from '../webhook-server';
import {
  buildSystemTaskHandlers,
  createAgentLoop,
  createLLM,
  createTeamAgentLoop,
  getEthosObservability,
  getFunnelTracker,
  getSecretsResolver,
  getStorage,
} from '../wiring';
import {
  ensureTeamSupervisors,
  stopTeamSupervisors,
  type TeamSupervisorDeps,
} from './supervisor-lifecycle';
import { isPidAlive } from './team-runtime';

// ---------------------------------------------------------------------------
// Gateway heartbeat
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 10_000;
const HEALTH_TIMEOUT_MS = 5_000;
/** How long a CONFIRMED delivery obligation is kept before it is pruned. The
 *  rows hold message bodies, so an unbounded ledger is a privacy and disk
 *  problem. Hard-coded on purpose — no config knob until someone needs one. */
const DELIVERY_LEDGER_RETENTION_MS = 7 * 86_400_000;

export interface GatewayHeartbeat {
  pid: number;
  startedAt: string;
  updatedAt: string;
  adapters: Array<{ name: string; ok: boolean }>;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('health check timeout')), ms).unref(),
    ),
  ]);
}

export async function buildGatewayHeartbeat(
  adapters: PlatformAdapter[],
  startedAt: string,
): Promise<GatewayHeartbeat> {
  const results = await Promise.allSettled(
    adapters.map((a) => withTimeout(a.health(), HEALTH_TIMEOUT_MS)),
  );
  const adapterStatuses = adapters.map((a, i) => {
    const result = results[i];
    const ok = result?.status === 'fulfilled' ? result.value.ok : false;
    return { name: a.id, ok };
  });
  return {
    pid: process.pid,
    startedAt,
    updatedAt: new Date().toISOString(),
    adapters: adapterStatuses,
  };
}

function gatewayHealthPath(): string {
  return join(ethosDir(), 'gateway-health.json');
}

// Best-effort dynamic import. Returns null and logs a clear warning if the
// module can't be loaded — typically because its underlying SDK isn't
// installed. Callers downgrade gracefully.
// Each branch uses a LITERAL-STRING dynamic import so tsup follows it
// statically and inlines the workspace package (`@ethosagent/platform-*`)
// into the published cli bundle. Earlier this function did
// `await import(modulePath)` where `modulePath` was a parameter — tsup
// can't statically resolve that, so the published dist tried to resolve
// the workspace packages from npm at runtime and 404'd ("Cannot find
// package '@ethosagent/platform-telegram' imported from
// node_modules/@ethosagent/cli/dist/index.js"). Keep additions here in
// lockstep with new platform modules.
async function loadAdapterModule<T>(modulePath: string, label: string): Promise<T | null> {
  try {
    let mod: unknown;
    switch (modulePath) {
      case '@ethosagent/platform-telegram':
        mod = await import('@ethosagent/platform-telegram');
        break;
      case '@ethosagent/platform-slack':
        mod = await import('@ethosagent/platform-slack');
        break;
      case '@ethosagent/platform-discord':
        mod = await import('@ethosagent/platform-discord');
        break;
      case '@ethosagent/platform-email':
        mod = await import('@ethosagent/platform-email');
        break;
      case '@ethosagent/platform-telegram/clarify-surface':
        mod = await import('@ethosagent/platform-telegram/clarify-surface');
        break;
      case '@ethosagent/platform-slack/clarify-surface':
        mod = await import('@ethosagent/platform-slack/clarify-surface');
        break;
      case '@ethosagent/platform-discord/clarify-surface':
        mod = await import('@ethosagent/platform-discord/clarify-surface');
        break;
      case '@ethosagent/platform-whatsapp':
        mod = await import('@ethosagent/platform-whatsapp');
        break;
      case '@ethosagent/platform-whatsapp/clarify-surface':
        mod = await import('@ethosagent/platform-whatsapp/clarify-surface');
        break;
      default:
        throw new EthosError({
          code: 'INTERNAL',
          cause: `loadAdapterModule: unknown module '${modulePath}'`,
          action:
            'Add a literal-string switch arm in apps/ethos/src/commands/gateway.ts so the bundler can inline this module.',
        });
    }
    return mod as T;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `${c.yellow}⚠ ${label} adapter unavailable${c.reset} ${c.dim}(${reason})${c.reset}`,
    );
    return null;
  }
}

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

// ---------------------------------------------------------------------------
// ethos gateway setup
// ---------------------------------------------------------------------------

export async function runGatewaySetup(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

  console.log(`\n${c.cyan}${c.bold}ethos gateway setup${c.reset}\n`);
  console.log(
    `${c.dim}Create a Telegram bot at https://t.me/BotFather, then paste the token below.${c.reset}\n`,
  );

  const token = (await ask('Telegram bot token: ')).trim();
  rl.close();

  if (!token) {
    console.log(
      `${c.yellow}No token entered. Run ethos gateway setup again to configure.${c.reset}`,
    );
    return;
  }

  // Validate token by calling getMe
  console.log(`${c.dim}Validating token...${c.reset}`);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await res.json()) as { ok: boolean; result?: { username?: string } };

    if (!data.ok) {
      console.log(`${c.red}Invalid token — Telegram rejected it.${c.reset}`);
      return;
    }

    const username = data.result?.username ?? '(unknown)';
    console.log(`${c.green}✓ Bot validated: @${username}${c.reset}`);
  } catch {
    console.log(
      `${c.yellow}Warning: could not reach Telegram to validate token. Saving anyway.${c.reset}`,
    );
  }

  const storage = getStorage();
  const config = await readRawConfig(storage);
  if (!config) {
    console.log(`${c.red}No ethos config found. Run ethos setup first.${c.reset}`);
    return;
  }

  await writeConfig(storage, { ...config, telegramToken: token }, await getSecretsResolver());
  console.log(`${c.green}✓ Token saved to ~/.ethos/config.yaml${c.reset}`);
  console.log(
    `\n${c.dim}Run ${c.reset}${c.bold}ethos gateway start${c.reset}${c.dim} to start the bot.${c.reset}\n`,
  );
}

// ---------------------------------------------------------------------------
// ethos gateway start
// ---------------------------------------------------------------------------

export interface GatewayStartOptions {
  /** Fired once the gateway is fully up and listening — used by the setup
   *  three-way close (W2.5) to print the `t.me` deep-link success block after
   *  the "Starting the Telegram bot…" line. */
  onReady?: () => void;
}

/**
 * `voice.channels.<platform>.ttsOut` → the Gateway's `channelVoiceOut` gate.
 *
 * Only an EXPLICIT boolean is an operator decision. A platform whose entry
 * omits `ttsOut` inherits the lane's mode, so it must NOT appear in the map —
 * an entry present with `undefined` would read as "declared" downstream.
 * Returns `undefined` when nothing was declared, so the option is omitted
 * entirely rather than passed as an empty object.
 */
export function deriveChannelVoiceOut(
  channels: Readonly<Record<string, { ttsOut?: boolean }>> | undefined,
): Record<string, boolean> | undefined {
  if (!channels) return undefined;
  const out: Record<string, boolean> = {};
  for (const [platform, entry] of Object.entries(channels)) {
    if (typeof entry?.ttsOut === 'boolean') out[platform] = entry.ttsOut;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function runGatewayStart(opts: GatewayStartOptions = {}): Promise<void> {
  // Load config through the strict path so parse-time errors (typos in
  // bind.type, missing bot tokens) surface here instead of silently
  // booting zero bots. The strict loader also applies the legacy →
  // list-shape shim and returns the deprecation messages we should
  // surface before any other work.
  const storage = getStorage();
  const secrets = await getSecretsResolver();
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
  const config = loaded.config;

  const identityMap = new IdentityMap({ storage, dataDir: ethosDir() });
  const resolveUserId = (platform: string, platformUserId: string, displayLabel?: string) =>
    identityMap.resolve(platform, platformUserId, displayLabel);

  const hasEmailConfig =
    config.emailImapHost && config.emailUser && config.emailPassword && config.emailSmtpHost;

  const hasAnyPlatform =
    config.telegramToken ||
    config.discordToken ||
    (config.slackBotToken && config.slackAppToken && config.slackSigningSecret) ||
    (config.telegram?.bots.length ?? 0) > 0 ||
    (config.slack?.apps.length ?? 0) > 0 ||
    (config.whatsapp?.length ?? 0) > 0 ||
    hasEmailConfig;

  if (!hasAnyPlatform) {
    console.log(
      `${c.dim}No platform configured — gateway idling. Run: ethos gateway setup to add one.${c.reset}`,
    );
  }

  // Validate bot bindings against the on-disk personality registry and
  // team manifests. Fail loudly here rather than letting messages route
  // to a non-existent destination at first request.
  const bindErrors = await validateBindings(config);
  if (bindErrors.length > 0) {
    console.log(`${c.red}Bot binding errors:${c.reset}`);
    for (const err of bindErrors) console.log(`  • ${err}`);
    process.exit(1);
  }

  // Migrate persisted session keys to the new `${platform}:${botKey}:
  // ${chatId}` shape if we haven't already. Idempotent — subsequent
  // boots see the marker and short-circuit.
  const migration = await migrateSessionKeysIfNeeded({ storage, config });
  if (migration && migration.migrated > 0) {
    console.log(
      `${c.dim}Migrated ${migration.migrated} session key(s) to the multi-bot lane format.${c.reset}`,
    );
  }

  console.log(`${c.bold}ethos gateway${c.reset}  ${c.dim}starting...${c.reset}`);
  // First-run notice: gateway is opt-in for always-on channels. CLI is the
  // supported install. See plan/phases/30-robustness.md § 30.5.
  console.log(
    `${c.dim}Runs in the foreground. For always-on production, see https://ethosagent.ai/docs/guides/run-as-daemon (launchd / systemd / pm2). For interactive use, run ${c.reset}${c.bold}ethos chat${c.reset}${c.dim}.${c.reset}`,
  );

  // Cron scheduler — hoisted ABOVE every loop construction so the same
  // instance can be threaded into every createAgentLoop call (which
  // registers the agent-callable `cron` tool against it) AND used as the
  // firing engine below. The `runJob` closure captures `systemLoop` via
  // a forward-referenced `let`; the scheduler doesn't fire until
  // `.start()` later, by which point `systemLoop` is assigned. This
  // lets any personality with `cron` in its toolset register jobs that
  // land in the same store as operator-created jobs.
  let systemLoop: import('@ethosagent/core').AgentLoop | null = null;
  let cronPersonalities: Awaited<ReturnType<typeof createPersonalityRegistry>> | null = null;
  // Forward-reference: filled after the Gateway + adapters are built.
  let cronDeliverFn:
    | ((job: import('@ethosagent/cron').CronJob, output: string) => Promise<void>)
    | null = null;
  // Watcher manager — constructed BEFORE the scheduler so its systemTask
  // handler can be merged into the scheduler's `systemTasks` config (watcher
  // ticks piggyback on the cron scheduler as source:'system' jobs — no
  // second ticker). Deliver/wake are forward-referenced like `cronDeliverFn`:
  // bound after the Gateway + bots exist, fired only once the scheduler runs.
  let watcherDeliverFn: ((target: WatcherDeliverTarget, text: string) => Promise<void>) | null =
    null;
  let watcherWakeFn: ((event: WatcherWakeEvent) => Promise<void>) | null = null;
  const watcherManager = new WatcherManager({
    storage: getStorage(),
    logger: new ConsoleLogger(),
    deliver: async (target, text) => {
      if (watcherDeliverFn) await watcherDeliverFn(target, text);
    },
    wake: async (event) => {
      if (watcherWakeFn) await watcherWakeFn(event);
    },
  });
  const scheduler = new CronScheduler({
    storage: getStorage(),
    logger: new ConsoleLogger(),
    // Script/precheck jobs execute through the same local backend class the
    // execution tools use — never raw child_process in the scheduler.
    executionBackend: new LocalExecutionBackend({
      config: {},
      secrets,
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
    deliver: async (job, output) => {
      if (cronDeliverFn) await cronDeliverFn(job, output);
    },
    runJob: async (job) => {
      if (!systemLoop) {
        throw new EthosError({
          code: 'INTERNAL',
          cause: 'System loop not yet initialised at cron firing time',
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

      const sessionKey = `cron:${job.id}:${new Date().toISOString()}`;
      let output = '';
      for await (const event of systemLoop.run(job.prompt ?? '', {
        sessionKey,
        personalityId: pid,
        toolsetOverride,
      })) {
        if (event.type === 'text_delta') output += event.text;
      }
      return { jobId: job.id, ranAt: new Date().toISOString(), output, sessionKey };
    },
  });

  // Late-bind the scheduler into the watcher manager (the manager was
  // constructed first so its systemTask handler could ride the scheduler
  // config above). Backing jobs are seeded by `watcherManager.start()` later.
  watcherManager.attachScheduler(scheduler);

  // Build one AgentLoop per configured bot. Personality bots use
  // `createAgentLoop`; team bots use `createTeamAgentLoop`. Each loop
  // receives the shared `scheduler` so its `cron` tool lands in the
  // same scheduler store as everything else.
  // Late-bound on purpose: the loops are built here, but the Gateway is
  // constructed further down. Assigned right after construction, and read by
  // two things — the approval-route hooks, and the thread resolver below. A
  // background job spawned by `delegate_task` stamps the turn's thread so its
  // completion (possibly only delivered after a restart) returns to the
  // sub-conversation that asked for it.
  let gatewayRef: Gateway | null = null;
  const {
    bots,
    messagingSetters: botMessagingSetters,
    notificationRouters: botNotificationRouters,
    toolRegistries: botToolRegistries,
    refreshers: botPersonalityRefreshers,
  } = await buildGatewayBots(config, scheduler, watcherManager, (sessionKey) =>
    gatewayRef?.originThreadIdFor(sessionKey),
  );

  // Phase 3: for each team-bound bot, ensure the supervisor is running.
  const supervisorDeps: TeamSupervisorDeps = {
    readRuntime,
    removeRuntime,
    isPidAlive,
    spawn,
    kill: (pid, signal) => process.kill(pid, signal as NodeJS.Signals),
  };
  const entryPoint = process.argv[1] ?? '';
  const supervisorResults = await ensureTeamSupervisors(bots, entryPoint, supervisorDeps);
  for (const [teamName, result] of supervisorResults) {
    if (result.status === 'spawned' && result.pid === undefined) {
      console.log(
        `${c.yellow}⚠ team supervisor${c.reset} ${c.bold}${teamName}${c.reset} ${c.yellow}spawned but did not publish a runtime file — team routing may be broken. Run 'ethos team status ${teamName}' to diagnose.${c.reset}`,
      );
    } else {
      console.log(
        result.status === 'spawned'
          ? `${c.dim}team supervisor${c.reset} ${c.bold}${teamName}${c.reset} ${c.dim}spawned (PID ${result.pid})${c.reset}`
          : `${c.dim}team supervisor${c.reset} ${c.bold}${teamName}${c.reset} ${c.dim}already running (PID ${result.pid})${c.reset}`,
      );
    }
  }
  // System loop used by cron — not bot-bound. Cron jobs route through
  // their own `job.personalityId` field, not through the platform bot
  // routing table. The scheduler is passed in so agent-callable cron
  // tools register against the same instance the firing engine uses.
  const {
    loop: systemLoopReady,
    toolRegistry: systemToolRegistry,
    setMessagingSend: setSystemMessagingSend,
    pluginLoader,
    notificationRouter: systemNotificationRouter,
    activePersonality,
    sttProviders,
    ttsProviders,
    voiceConfig,
    refreshPersonalities: refreshSystemPersonalities,
  } = await createAgentLoop(config, { cronScheduler: scheduler, watcherManager });
  systemLoop = systemLoopReady;

  // Personality-directory seam for hot-reload. `refresh()` reloads every loop
  // registry (system + per-bot) plus a dedicated read registry from disk, so a
  // personality dropped into or edited under `~/.ethos/personalities/` is
  // usable on the next turn/command without a restart. `has()`/`list()` read
  // the dedicated registry, which `refresh()` keeps in sync with the same disk
  // the loops resolve against.
  const personalitiesDir = join(ethosDir(), 'personalities');
  const seamPersonalities = await createPersonalityRegistry(getStorage());
  await seamPersonalities.loadFromDirectory(personalitiesDir);
  try {
    seamPersonalities.setDefault(config.personality);
  } catch {
    // Configured default not on disk — keep the registry's built-in default.
  }
  const personalityRefreshers = [refreshSystemPersonalities, ...botPersonalityRefreshers];
  // Debounce window: at burst scale, re-scan disk at most once per interval. The
  // mtime-fingerprint cache already makes a no-change scan cheap (~stat per
  // file), and this bounds the per-turn syscall cost when many turns land in
  // quick succession. A dropped/edited personality becomes visible within one
  // window (sub-second), which is well inside human command latency.
  const REFRESH_DEBOUNCE_MS = 300;
  let lastRefreshMs = 0;
  const personalityDirectory = {
    refresh: async (): Promise<void> => {
      const now = Date.now();
      if (now - lastRefreshMs < REFRESH_DEBOUNCE_MS) return;
      lastRefreshMs = now;
      // allSettled, not all: one malformed personality directory (bad YAML) must
      // not sink every other registry's refresh. Log the rejected arm count once
      // and proceed — each surviving registry serves last-good.
      const results = await Promise.allSettled([
        seamPersonalities.loadFromDirectory(personalitiesDir),
        ...personalityRefreshers.map((fn) => fn()),
      ]);
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        console.warn(
          `[gateway] personality refresh: ${failed}/${results.length} registries failed to reload (serving last-good)`,
        );
      }
    },
    has: (id: string): boolean => seamPersonalities.get(id) != null,
    // Per-personality voice for channel TTS. Read from the SAME registry the
    // refresh above reloads, so an edited `voice.tts_voice` is audible on the
    // next spoken reply without a restart.
    voice: (id: string) => seamPersonalities.get(id)?.voice,
    list: (): Array<{ id: string; name: string; isDefault: boolean }> => {
      const defaultId = seamPersonalities.getDefault().id;
      return seamPersonalities.list().map((p) => ({
        id: p.id,
        name: p.name,
        isDefault: p.id === defaultId,
      }));
    },
  };

  // Idle-triggered background maintenance ("dreaming"). Opt-in per personality:
  // a personality with no `dreaming` block — or `enable: false` — is skipped on
  // every tick, so there is no LLM turn and no cost. The executor owns the whole
  // policy (idle threshold, rolling daily cap, cancel-on-user-activity); this
  // wiring only supplies its three collaborators and drives start/stop.
  //
  // Dreams run on `systemLoop`, the same not-bot-bound loop cron fires through:
  // the turn resolves its personality (and therefore its memory scope) from the
  // `personalityId` passed per run, and its output is maintenance, never a
  // channel reply. Config is read through `seamPersonalities`, which
  // `personalityDirectory.refresh()` reloads before every turn — so switching
  // `dreaming.enable` on disk takes effect without a gateway restart.
  const dreamExecutor = new DreamExecutor(
    getStorage(),
    () => systemLoop ?? undefined,
    (personalityId) => seamPersonalities.get(personalityId),
  );
  const onUserTurn = ({ personalityId }: { personalityId: string }): void => {
    try {
      dreamExecutor.recordUserTurn(personalityId);
    } catch {
      // Unsafe personality id — skip the activity stamp. Dreaming is
      // best-effort background maintenance and must never break a live turn.
    }
  };

  // A2A Stage 1d: register the outbound `a2a_send` tool on every gateway loop's
  // tool registry (per-bot loops + the system loop), so an A2A call can
  // originate from a channel turn — not just from `ethos serve`. The gateway is
  // a separate process with no live settings flag, so the tool follows the
  // persisted `config.a2a.enabled` value (mirrors serve's `ETHOS_A2A_ENABLED`
  // override for parity); a toggle reaches it on the next gateway start (plan
  // §13). Fail-open: a failure constructing the A2A deps must NOT crash gateway
  // startup — channels are the gateway's core job.
  await registerA2aOutboundTools(config, [...botToolRegistries, systemToolRegistry]);

  // Resolve the active personality's plugin allowlist for the trust gate.
  // If the personality declares `plugins:`, only those are trusted; if it
  // doesn't, all plugins are allowed (backward compat — trustedChannelPlugins
  // stays undefined).
  const trustedChannelPlugins = activePersonality?.plugins
    ? new Set(activePersonality.plugins)
    : undefined;

  // Gap 10 — every loop (per-bot + system) owns its own NotificationRouter,
  // and `process_complete` hooks fire on the owning loop's instance. The
  // Gateway holds a single router reference, so fan registrations out to all
  // of them; whichever loop's hook fires finds the same per-session adapter.
  const allNotificationRouters = [...botNotificationRouters, systemNotificationRouter];
  const gatewayNotificationRouter: NotificationRouter = {
    // Registrations are mirrored on every router, so routing through the
    // first reaches the same adapter set — fanning route() out would
    // double-send.
    route: (pluginId, opts) =>
      allNotificationRouters[0]?.route(pluginId, opts) ?? Promise.resolve(),
    register: (sessionKey, adapter) => {
      for (const r of allNotificationRouters) r.register(sessionKey, adapter);
    },
    deregister: (sessionKey) => {
      for (const r of allNotificationRouters) r.deregister(sessionKey);
    },
  };

  // Shared attachment cache for all platform adapters. Hoisted here so the
  // same instance flows into both `buildAdapters` (Telegram, Slack) and the
  // `Gateway` (cleanup on /new and lane eviction).
  const { FsAttachmentCache } = await import('@ethosagent/storage-fs');
  const attachmentCache = new FsAttachmentCache(storage, join(ethosDir(), 'cache', 'attachments'));
  // TTL sweep — prune cached attachments older than 24 h every hour.
  const pruneTimer = setInterval(
    () => {
      void attachmentCache.pruneOlderThan(24 * 60 * 60 * 1000).catch(() => {});
    },
    60 * 60 * 1000,
  );
  pruneTimer.unref?.();

  // Build and register all configured adapters early so we can wire the
  // clarify surfaces *before* constructing the Gateway. The surfaces' combined
  // `correlateMessage` is passed in as `clarifyMessageCorrelator`. The
  // surface's `getSessionRouting` closes over a mutable holder filled in
  // right after Gateway construction — necessary because the surface and the
  // Gateway each need a reference to the other.
  const adapters = await buildAdapters(config, loadAdapterModule, attachmentCache, {
    onWhatsAppQr: (botId, qr) => {
      import('@ethosagent/web-api').then((m) => m.setWhatsAppQr(botId, qr)).catch(() => {});
    },
    onWhatsAppPairingCode: (botId, code) => {
      if (code !== null) {
        console.log(
          `\n  ${c.bold}WhatsApp pairing code for "${botId}": ${c.cyan}${code}${c.reset}\n` +
            `  ${c.dim}On that phone: WhatsApp → Linked Devices → Link with phone number instead → enter the code.${c.reset}\n`,
        );
      }
      import('@ethosagent/web-api')
        .then((m) => m.setWhatsAppPairingCode(botId, code))
        .catch(() => {});
    },
  });

  const telegramClarifySurfaces = await buildTelegramClarifySurfaces(
    bots,
    adapters,
    (sessionId) => {
      const route = gatewayRef?.resolveApprovalRoute(sessionId);
      if (!route) return undefined;
      return route.requesterUserId !== undefined
        ? { chatId: route.chatId, requesterUserId: route.requesterUserId }
        : { chatId: route.chatId };
    },
  );
  // Slack clarify surfaces are wired identically — only the surface module
  // and the routing fields differ (Slack carries a `threadId` for thread
  // routing). The surfaces register their own `block_actions` /
  // `view_submission` listeners on the adapter; the gateway never calls into
  // them directly, so they don't contribute to `clarifyMessageCorrelator`.
  await buildSlackClarifySurfaces(bots, adapters, (sessionId) => {
    const route = gatewayRef?.resolveApprovalRoute(sessionId);
    if (!route) return undefined;
    return {
      chatId: route.chatId,
      ...(route.threadId !== undefined ? { threadId: route.threadId } : {}),
      ...(route.requesterUserId !== undefined ? { requesterUserId: route.requesterUserId } : {}),
    };
  });
  // Discord clarify surfaces — same pattern as Slack but no thread routing.
  // Discord delivers component clicks via `interactionCreate`, which the
  // surface registers on directly via `adapter.onClarifyInteraction`.
  // Discord now appears in `buildGatewayBots`, so the surface binds to that
  // per-bot loop's bridge; `systemLoop` remains the fallback for the rare
  // case where no bot entry matched.
  await buildDiscordClarifySurfaces(bots, adapters, systemLoop, (sessionId) => {
    const route = gatewayRef?.resolveApprovalRoute(sessionId);
    if (!route) return undefined;
    return {
      chatId: route.chatId,
      ...(route.requesterUserId !== undefined ? { requesterUserId: route.requesterUserId } : {}),
    };
  });
  // WhatsApp clarify surfaces — text-only (Baileys cannot send buttons or
  // lists), so like Telegram they resolve through `correlateMessage`.
  const whatsAppClarifySurfaces = await buildWhatsAppClarifySurfaces(
    bots,
    adapters,
    (sessionId) => {
      const route = gatewayRef?.resolveApprovalRoute(sessionId);
      if (!route) return undefined;
      return route.requesterUserId !== undefined
        ? { chatId: route.chatId, requesterUserId: route.requesterUserId }
        : { chatId: route.chatId };
    },
  );
  const correlatingClarifySurfaces = [...telegramClarifySurfaces, ...whatsAppClarifySurfaces];
  const clarifyMessageCorrelator =
    correlatingClarifySurfaces.length > 0
      ? async (msg: InboundMessage): Promise<ClarifyResponse | null> => {
          for (const surface of correlatingClarifySurfaces) {
            const r = await surface.correlateMessage(msg);
            if (r) return r;
          }
          return null;
        }
      : undefined;

  // Telegram personality card reader + greeting provider — wired when any
  // Telegram adapter is configured. The card reader powers `/personality rich`;
  // the greeting provider powers `/start`.
  const hasTelegram = adapters.some((a) => a.id.startsWith('telegram:'));
  const telegramCardReader = hasTelegram ? await createTelegramPersonalityCardReader() : undefined;
  const telegramGreetingProvider = hasTelegram ? await createTelegramGreetingProvider() : undefined;

  // ---------------------------------------------------------------------------
  // Chapter 1 safety: channel filter fail-closed assertion + pairing DB init
  // ---------------------------------------------------------------------------
  // If any channel adapter is configured but channel_filter is missing, refuse
  // to boot. This prevents an unchecked gateway from accepting messages from
  // anyone reachable by the bot.
  if (adapters.length > 0 && !config.channelFilter) {
    console.error(
      `${c.red}FATAL: Channel adapters configured without channel_filter safety config.${c.reset}\n` +
        'Add channel_filter.<platform>.ownerUserId to config.yaml for each platform.\n' +
        'See: https://docs.ethos.dev/security/channel-filter',
    );
    process.exit(1);
  }
  // Per-platform assertion: every active adapter must have a matching entry.
  for (const adapter of adapters) {
    const platform = adapter.id.includes(':') ? adapter.id.split(':')[0] : adapter.id;
    if (config.channelFilter && !config.channelFilter[platform]) {
      console.error(
        `${c.red}FATAL: Adapter "${adapter.id}" has no channel_filter.${platform} config.${c.reset}\n` +
          `Add channel_filter.${platform}.ownerUserId to config.yaml.`,
      );
      process.exit(1);
    }
  }

  // Initialize the pairing DB when channel filter is configured. The SQLite
  // file lives alongside the main ethos state at ~/.ethos/pairing.db.
  let pairingDb: InstanceType<typeof Database> | undefined;
  if (config.channelFilter) {
    const dbPath = join(ethosDir(), 'pairing.db');
    pairingDb = new Database(dbPath);
    pairingDb.pragma('journal_mode = WAL');
    initPairingDb(pairingDb);
  }

  // Durable delivery-obligation ledger (item 9). One SQLite file alongside the
  // rest of the ethos state; umask default, same posture as jobs.db /
  // sessions.db, which hold the same class of content.
  const deliveryLedger = new SQLiteDeliveryLedger(join(ethosDir(), 'delivery-ledger.db'));

  // Build adapter registry for send_message cross-platform routing.
  // Derive platform key from adapter.id prefix (e.g. 'telegram:bot-1' → 'telegram',
  // 'email' → 'email'). This is a stable identifier, unlike displayName which is UI text.
  const adapterMap = new Map<string, PlatformAdapter>();
  for (const adapter of adapters) {
    const colonIdx = adapter.id.indexOf(':');
    const platformKey = colonIdx > 0 ? adapter.id.slice(0, colonIdx) : adapter.id;
    // First adapter per platform wins (multi-bot: all share the same send path)
    if (!adapterMap.has(platformKey)) {
      adapterMap.set(platformKey, adapter);
    }
  }

  // W4.1 — funnel stamps at gateway turn completion. The tracker no-ops once
  // stamped, so this is one cheap callback per turn after the first.
  const onTurnComplete = ({ platform }: { platform: string }): void => {
    const funnel = getFunnelTracker();
    void funnel.recordFirstReply();
    void funnel.recordChannelFirstReply(platform);
  };

  // W3.1 — channel streaming draft edits. `display.streaming_edits` in
  // config.yaml (default `dms`: stream in DMs, not group chats).
  const streamingMode = config.displayStreamingEdits ?? 'dms';
  const streamingEdits = { dm: streamingMode !== 'off', group: streamingMode === 'all' };

  // Context-economy Phase 1 — deterministic pre-LLM quick commands. Register
  // ONE `gateway_message` claiming handler per loop the gateway can dispatch
  // to (each bot loop; the system loop only on the single-loop fallback path).
  // Only commands explicitly marked `gateway: true` are exposed to channels,
  // optionally restricted to the platforms in `channels`. Matching is EXACT
  // (`/<name>`, case-sensitive) and the executed command string comes solely
  // from operator config — channel text is never interpolated into the shell.
  const gatewayQuickCommands = Object.entries(config.quick_commands ?? {}).filter(
    ([, qc]) => qc.gateway === true,
  );
  if (gatewayQuickCommands.length > 0) {
    const quickCommandHandler = async (
      payload: GatewayMessagePayload,
    ): Promise<GatewayMessageResult> => {
      const text = payload.text.trim();
      for (const [name, qc] of gatewayQuickCommands) {
        if (text !== `/${name}`) continue;
        if (qc.channels && !qc.channels.includes(payload.platform)) continue;
        if (qc.type === 'reply') return { handled: true, reply: qc.reply };
        // type 'exec' — runs the operator-authored command, zero LLM tokens.
        const result = runQuickCommand(qc.command);
        return { handled: true, reply: formatQuickCommandOutput(result) };
      }
      return { handled: false };
    };
    const quickCommandLoops =
      bots.length > 0 ? new Set(bots.map((b) => b.loop)) : new Set([systemLoopReady]);
    for (const loop of quickCommandLoops) {
      loop.hooks.registerClaiming('gateway_message', quickCommandHandler);
    }
  }

  // Voice-note machinery. Built ONCE and handed to whichever Gateway the
  // branch below constructs — a second store would mean two caches over the
  // same file and two artifact dirs over the same bytes.
  //
  // The store carries the deployment default, so `defaultVoiceMode` is not also
  // passed: an injected store's own default is the one the Gateway reads.
  const voiceModeStore = new LaneVoiceModeStore({
    storage,
    path: laneVoiceModePath(ethosDir()),
    ...(config.voice?.defaultMode ? { defaultMode: config.voice.defaultMode } : {}),
    onError: (err) => {
      new ConsoleLogger().warn(`voice lane-mode persist failed: ${err}`);
    },
  });
  // ffmpeg stage. Optional at runtime: an unavailable binary degrades to
  // pass-through, and the startup probe below says so once.
  const transcoder = createFfmpegTranscoder({
    ...(config.voice?.transcode?.ffmpegPath
      ? { ffmpegPath: config.voice.transcode.ffmpegPath }
      : {}),
    // `voice.transcode.timeout` is SECONDS; the option is milliseconds.
    timeoutMs: (config.voice?.transcode?.timeout ?? 30) * 1000,
  });
  // Synthesized audio has to outlive a failed send: redelivery re-sends THOSE
  // bytes rather than re-synthesizing, which would be a different take.
  const voiceArtifacts = createVoiceArtifactStore({
    storage,
    dir: join(ethosDir(), 'voice', 'artifacts'),
    onError: (op, err) => {
      new ConsoleLogger().warn(`voice artifact ${op} failed: ${err}`);
    },
  });
  const channelVoiceOut = deriveChannelVoiceOut(config.voice?.channels);
  const voiceBitrateKbps = config.voice?.transcode?.bitrateKbps;

  const gateway: Gateway =
    bots.length === 0
      ? // No platform configured — idle gateway. Every configured platform
        // (including Discord/Email) now registers a bot in `buildGatewayBots`,
        // so this single-loop path is reached only when nothing is wired up.
        new Gateway({
          loop: systemLoop,
          defaultPersonality: config.personality,
          adapters: adapterMap,
          deliveryLedger,
          resolveUserId,
          pluginLoader,
          pluginAdapters: pluginLoader.getPlatformAdapters(),
          trustedChannelPlugins,
          notificationRouter: gatewayNotificationRouter,
          sttProviderRegistry: sttProviders,
          sttProviderName: voiceConfig.sttProviderName,
          sttProviderConfig: voiceConfig.sttProviderConfig,
          ttsProviderRegistry: ttsProviders,
          ttsProviderName: voiceConfig.ttsProviderName,
          ttsProviderConfig: voiceConfig.ttsProviderConfig,
          voiceSecretsResolver: voiceConfig.secretsResolver,
          // Local-only voice-egress gate (`voice.trustedPlugins`); undefined = off.
          ...(voiceConfig.trustedVoicePlugins
            ? { trustedVoicePlugins: voiceConfig.trustedVoicePlugins }
            : {}),
          // Where a NEW lane starts (`voice.defaultMode`); `/voice` still wins
          // per lane, and the store persists that choice across restarts.
          voiceModeStore,
          voiceArtifacts,
          transcoder,
          ...(channelVoiceOut ? { channelVoiceOut } : {}),
          ...(voiceBitrateKbps !== undefined ? { voiceBitrateKbps } : {}),
          personalityDirectory,
          onTurnComplete,
          onUserTurn,
          streamingEdits,
          ...(config.channelToolsets ? { channelToolsets: config.channelToolsets } : {}),
          ...(config.channelFilter ? { channelFilter: config.channelFilter } : {}),
          ...(pairingDb ? { pairingDb } : {}),
        })
      : new Gateway({
          bots,
          attachmentCache,
          // Reading cached attachment bytes: an inbound voice note is
          // transcribed from the audio itself, not from a path.
          storage,
          adapters: adapterMap,
          deliveryLedger,
          resolveUserId,
          pluginLoader,
          pluginAdapters: pluginLoader.getPlatformAdapters(),
          trustedChannelPlugins,
          notificationRouter: gatewayNotificationRouter,
          sttProviderRegistry: sttProviders,
          sttProviderName: voiceConfig.sttProviderName,
          sttProviderConfig: voiceConfig.sttProviderConfig,
          ttsProviderRegistry: ttsProviders,
          ttsProviderName: voiceConfig.ttsProviderName,
          ttsProviderConfig: voiceConfig.ttsProviderConfig,
          voiceSecretsResolver: voiceConfig.secretsResolver,
          // Local-only voice-egress gate (`voice.trustedPlugins`); undefined = off.
          ...(voiceConfig.trustedVoicePlugins
            ? { trustedVoicePlugins: voiceConfig.trustedVoicePlugins }
            : {}),
          // Where a NEW lane starts (`voice.defaultMode`); `/voice` still wins
          // per lane, and the store persists that choice across restarts.
          voiceModeStore,
          voiceArtifacts,
          transcoder,
          ...(channelVoiceOut ? { channelVoiceOut } : {}),
          ...(voiceBitrateKbps !== undefined ? { voiceBitrateKbps } : {}),
          personalityDirectory,
          onTurnComplete,
          onUserTurn,
          streamingEdits,
          ...(config.channelToolsets ? { channelToolsets: config.channelToolsets } : {}),
          ...(clarifyMessageCorrelator ? { clarifyMessageCorrelator } : {}),
          ...(telegramCardReader ? { personalityCardReader: telegramCardReader } : {}),
          ...(telegramGreetingProvider ? { greetingProvider: telegramGreetingProvider } : {}),
          ...(config.channelFilter ? { channelFilter: config.channelFilter } : {}),
          ...(pairingDb ? { pairingDb } : {}),
        });
  gatewayRef = gateway;

  // Wire goal completion notifications back to their originating channel.
  // Each bot's goalRunner fires on that bot's own hooks; register per bot
  // (registries are distinct, so no double-send) plus the system loop for
  // the email/legacy path.
  const sendGoalNote = async (platform: string, chatId: string, text: string): Promise<void> => {
    await gateway.sendTo(platform, chatId, text);
  };
  for (const bot of bots) {
    registerGoalNotifications(bot.loop.hooks, sendGoalNote);
  }
  if (systemLoop) {
    registerGoalNotifications(systemLoop.hooks, sendGoalNote);
  }

  // Wire send_message tool to the real Gateway send path.
  // Each loop's messaging send function is scoped — set on all active loops.
  const gatewayMessagingSend: MessagingSendFn = async (platform, target, body) =>
    gateway.sendTo(platform, target, body);
  setSystemMessagingSend(gatewayMessagingSend);
  for (const setter of botMessagingSetters) {
    setter(gatewayMessagingSend);
  }

  // Wire cron delivery through the gateway's sendTo path so origin-bearing
  // jobs route output back to the channel they were created from.
  cronDeliverFn = async (job, output) => {
    if (!job.origin) return;
    await gateway.sendTo(job.origin.platform, job.origin.chatId, output);
  };

  // Watcher deliver → the gateway's sendTo path. sendTo already routes
  // through the outbound dedup cache — the watcher layer adds NO dedup of
  // its own (CLAUDE.md adapter contract). Targets are explicit
  // platform+chatId, never a captured origin.
  watcherDeliverFn = async (target, text) => {
    await gateway.sendTo(target.platform, target.chatId, text);
  };

  // Watcher wake → synthesize an InboundMessage into the owning
  // personality's lane, the way webhook wake does. The diff summary is
  // external observation — wrap it as untrusted content and sanitize the
  // assembled prompt before it enters the loop (same treatment as the cron
  // precheck path). The capturing adapter's reply is intentionally discarded:
  // a woken agent acts through its tools (send_message etc.), not through
  // the synthetic inbound's reply surface.
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

  // Index bots by botKey so health-check lines can show the binding inline.
  const botByKey = new Map(bots.map((b) => [b.botKey, b]));

  if (adapters.length === 0) {
    console.log(
      `${c.dim}No adapters started — gateway idling. Configure a platform to activate.${c.reset}`,
    );
  }

  // Wire all adapters → gateway. Every adapter (Telegram, Slack, Discord,
  // Email, WhatsApp) stamps `InboundMessage.botKey` from the `botKey` field
  // passed at construction — computed once in wiring — and every one is
  // registered as a bot in `buildGatewayBots`, so inbound routes to the
  // matching loop instead of dropping at the unknown-botKey gate.
  for (const adapter of adapters) {
    adapter.onMessage((message: InboundMessage) => {
      void gateway.handleMessage(message, adapter).catch((err) => {
        console.error(`[gateway:${adapter.id}] Error:`, err);
      });
    });
  }

  // Wire the interactive tool-approval flow. Registers a `before_tool_call`
  // hook on every bot loop that suspends a dangerous tool call until the
  // user clicks Allow / Deny on an approval card (Slack or Telegram).
  // No-op for deployments without an approval-capable adapter.
  wireApprovalFlow(gateway, bots, adapters, {
    personalities: seamPersonalities,
    getProvider: createLazyProvider(() => createLLM(config)),
    model: config.model,
  });

  // Start the cron scheduler that was hoisted above (so agent-callable
  // cron tools register against the same instance the firing engine
  // uses). At this point `systemLoop` is assigned, so the deferred
  // `runJob` closure can safely run.
  scheduler.start();
  console.log(`${c.dim}Cron scheduler running (checks every 60s)${c.reset}`);

  // Idle checks for dreaming. The interval is unref'd, so it never holds the
  // process open; personalities that don't opt in cost one map lookup a tick.
  dreamExecutor.start();

  // Load watchers.json and seed the backing `source:'system'` tick jobs.
  // Idempotent — existing jobs are re-registered so interval edits apply.
  void watcherManager.start().catch((err) => {
    console.error('[watcher] failed to start watcher manager:', err);
  });

  // Seed system cron jobs into the scheduler's persistent store. Each call
  // is idempotent — existing jobs are returned as-is. The handlers were
  // already registered via `systemTasks` in the scheduler config above.
  const seedSystemJobs = async () => {
    await scheduler.seedSystemJob({
      name: 'Observability Prune',
      schedule: '0 3 * * *',
      systemTask: 'observability-prune',
    });
    if (config.nightlyPass?.enabled) {
      await scheduler.seedSystemJob({
        name: 'Nightly Pass',
        schedule: config.nightlyPass.cron ?? '0 3 * * *',
        systemTask: 'nightly-pass',
      });
    }
    if (config.weeklyDigest?.enabled) {
      await scheduler.seedSystemJob({
        name: 'Weekly Digest',
        schedule: config.weeklyDigest.cron ?? '0 9 * * 1',
        systemTask: 'weekly-digest',
      });
    }
    if (config.evolverCronEnabled) {
      await scheduler.seedSystemJob({
        name: 'Skill Evolver',
        schedule: config.evolverSchedule ?? '0 3 * * *',
        systemTask: 'skill-evolver',
      });
    }
  };
  void seedSystemJobs();

  // Start all adapters
  await Promise.all(adapters.map((a) => a.start()));

  // Durable delivery sweep (item 9). Deliberately AFTER adapter.start(): a
  // sweep against cold adapters would send into nothing while still burning
  // the obligations. Only rows whose botKey this process owns are touched, and
  // the ledger's atomic claim keeps a peer process (gateway vs. serve) from
  // redelivering the same row — an aged `pending` row is not proof of a crash.
  void gateway
    .sweepPendingDeliveries()
    .then(({ redelivered, failed }) => {
      if (redelivered > 0 || failed > 0) {
        console.log(
          `${c.dim}Delivery ledger: redelivered ${redelivered} pending reply(s), ${failed} deferred${c.reset}`,
        );
      }
    })
    .catch((err) => {
      new ConsoleLogger().warn(`delivery ledger boot sweep failed: ${String(err)}`);
    });

  // Restore-and-deliver (item 10). A background job that finished while this
  // process was down was written `done`/`failed` and then sat unread — the
  // delivery ledger cannot help, because nothing was ever recorded for it.
  // Runs after adapter.start() for the same reason the ledger sweep does.
  void gateway
    .sweepUndeliveredJobs()
    .then(({ delivered, failed }) => {
      if (delivered > 0 || failed > 0) {
        console.log(
          `${c.dim}Background jobs: announced ${delivered} completion(s) missed while offline, ${failed} deferred${c.reset}`,
        );
      }
    })
    .catch((err) => {
      new ConsoleLogger().warn(`background completion boot sweep failed: ${String(err)}`);
    });

  // Retention GC — delivered rows carry message bodies, so they are not kept
  // forever. Prune once at boot, then hourly. Pending rows are never pruned.
  const pruneDeliveryLedger = () => {
    void deliveryLedger.pruneDelivered(Date.now() - DELIVERY_LEDGER_RETENTION_MS).catch((err) => {
      new ConsoleLogger().warn(`delivery ledger retention prune failed: ${String(err)}`);
    });
  };
  // Voice artifacts ride the same schedule: abandon obligations nothing ever
  // delivered, then enforce the total-size cap oldest-first. `void`-ed so a
  // retention failure is a log line, never a dead gateway.
  const pruneVoiceArtifacts = () => {
    void gateway
      .pruneVoiceArtifacts({
        abandonAfterDays: config.voice?.artifacts?.abandonAfterDays ?? 7,
        maxTotalMb: config.voice?.artifacts?.maxTotalMb ?? 512,
      })
      .catch((err) => {
        new ConsoleLogger().warn(`voice artifact retention prune failed: ${String(err)}`);
      });
  };
  pruneDeliveryLedger();
  pruneVoiceArtifacts();
  const retentionPruneTimer = setInterval(() => {
    pruneDeliveryLedger();
    pruneVoiceArtifacts();
  }, 3_600_000);
  retentionPruneTimer.unref?.();

  // ffmpeg is optional. Without it the gateway still speaks — it sends the
  // formats the TTS provider already produces and SKIPS the rest rather than
  // handing an adapter a container it declared it cannot play. Say so once, as
  // a notice: a missing optional binary must not read as a failed boot.
  void transcoder
    .available()
    .then((ok) => {
      if (!ok) {
        console.log(
          `${c.yellow}⚠ ffmpeg not found${c.reset} ${c.dim}— voice notes will be delivered only in the formats the TTS provider already produces. Install ffmpeg to enable the rest.${c.reset}`,
        );
      }
    })
    .catch(() => {});

  // Plugins finished loading inside createAgentLoop above; now that the
  // adapters are constructed and started, push plugin slash commands to each
  // platform's command menu (Telegram setMyCommands, Slack, Discord).
  await gateway.pluginsReady();

  // Health checks — include botKey and binding for multi-bot adapters so the
  // startup log shows exactly which bot is live and what it's bound to.
  for (const adapter of adapters) {
    const health = await adapter.health();
    // adapter.id is `${platform}:${botKey}` for telegram/slack; the botKey is
    // everything after the first colon.
    const adapterBotKey = adapter.id.includes(':') ? adapter.id.split(':').slice(1).join(':') : '';
    const bot = botByKey.get(adapterBotKey);
    const bindingSuffix = bot
      ? ` ${c.dim}→ ${bot.binding.type}:${c.reset}${c.bold}${bot.binding.name}${c.reset}`
      : '';
    if (health.ok) {
      const ms = health.latencyMs ? `${c.dim} (${health.latencyMs}ms)${c.reset}` : '';
      console.log(`${c.green}✓${c.reset} ${c.bold}${adapter.id}${c.reset}${bindingSuffix}${ms}`);
    } else {
      console.log(`${c.yellow}⚠ ${adapter.id} health check failed${c.reset}${bindingSuffix}`);
    }
  }

  emitReady('gateway');
  notifyReady();
  const stopWatchdog = startWatchdog();

  const heartbeatStartedAt = new Date().toISOString();

  const healthPort = Number(process.env.ETHOS_GATEWAY_HEALTH_PORT) || 3002;
  const healthHost = process.env.ETHOS_SERVE_HOST ?? '127.0.0.1';
  const healthServer = createHealthServer(healthPort, healthHost, async () => {
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
  });
  console.log(`  health: http://${healthHost}:${healthPort}/healthz`);

  // Inbound webhooks — opt-in: only listen when at least one hook is configured.
  const webhookPort = Number(process.env.ETHOS_WEBHOOK_PORT) || 3003;
  const webhookHost = process.env.ETHOS_SERVE_HOST ?? '127.0.0.1';
  // Prefilter scripts run through the same guarded machinery as cron script
  // jobs (`runScriptFile`: ~/.ethos/scripts/ confinement, fixed interpreters,
  // secret-redacted output). Injected as a seam so webhook-server.ts keeps
  // its types-only top-level import surface (daemon-free doctrine).
  const webhookPrefilterBackend = new LocalExecutionBackend({
    config: {},
    secrets,
    logger: new ConsoleLogger(),
  });
  const runWebhookPrefilter: PrefilterRunner = (file, opts) =>
    runScriptFile(
      { file, timeoutSeconds: opts.timeoutSeconds },
      {
        storage: getStorage(),
        executionBackend: webhookPrefilterBackend,
        stdin: opts.stdin,
        label: 'prefilter',
      },
    );
  const webhookServer =
    config.webhooks && Object.keys(config.webhooks).length > 0
      ? createWebhookServer(
          webhookPort,
          webhookHost,
          gateway,
          config.webhooks,
          createCapturingAdapter,
          runWebhookPrefilter,
        )
      : undefined;
  if (webhookServer && config.webhooks) {
    const isLoopbackHost = ['127.0.0.1', 'localhost', '::1'].includes(webhookHost);
    if (!isLoopbackHost) {
      new ConsoleLogger().warn(
        `webhook bound to non-loopback host ${webhookHost} over plaintext HTTP — ` +
          'the bearer secret is transmitted in cleartext. Put a TLS-terminating ' +
          'proxy in front, or bind to loopback (ETHOS_SERVE_HOST=127.0.0.1).',
      );
    }
    for (const hookId of Object.keys(config.webhooks)) {
      console.log(`  webhook: http://${webhookHost}:${webhookPort}/webhook/${hookId}`);
    }
  }

  console.log(`${c.dim}Listening for messages. Press Ctrl+C to stop.${c.reset}\n`);
  let heartbeatInFlight = false;
  const writeHeartbeat = async () => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    try {
      const hb = await buildGatewayHeartbeat(adapters, heartbeatStartedAt);
      await storage.writeAtomic(gatewayHealthPath(), JSON.stringify(hb));
    } catch {
      // Best-effort — a missed tick is harmless; the consumer treats stale
      // data as degraded.
    } finally {
      heartbeatInFlight = false;
    }
  };
  void writeHeartbeat();
  const heartbeatTimer = setInterval(() => void writeHeartbeat(), HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  // Graceful shutdown on SIGINT / SIGTERM. Tell every in-flight chat that the
  // gateway was interrupted so they don't sit waiting on a response that
  // never comes. See plan/IMPROVEMENT.md P1-1.
  const shutdown = async () => {
    console.log(`\n${c.dim}Shutting down...${c.reset}`);
    if (stopWatchdog) stopWatchdog();
    healthServer.close();
    webhookServer?.close();
    clearInterval(pruneTimer);
    clearInterval(heartbeatTimer);
    clearInterval(retentionPruneTimer);
    scheduler.stop();
    dreamExecutor.stop();
    await storage.remove(gatewayHealthPath()).catch(() => {});
    await gateway.shutdown({
      notify:
        '⚠ Ethos was interrupted while answering. Please resend your last message — your session history is preserved.',
    });
    await Promise.allSettled(adapters.map((a) => a.stop()));
    deliveryLedger.close();
    stopTeamSupervisors(bots, config.teams ?? {}, supervisorDeps);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // Gateway is fully up and listening — let the caller print its own ready
  // banner (the W2.5 t.me success block) after all the adapter/health lines.
  opts.onReady?.();

  // Keep the process alive (adapter polling runs async)
  await new Promise(() => {});
}

// ---------------------------------------------------------------------------
// Phase 1 helpers
// ---------------------------------------------------------------------------

/**
 * Build the per-bot routing table the Gateway needs. Walks both
 * `config.telegram.bots` and `config.slack.apps`, resolving each
 * binding to either a personality-scoped AgentLoop (`createAgentLoop`)
 * or a team coordinator loop (`createTeamAgentLoop`). The botKey
 * matches what adapters will stamp on inbound messages.
 */
interface BuildGatewayBotsResult {
  bots: GatewayBotConfig[];
  messagingSetters: Array<(fn: MessagingSendFn) => void>;
  /** One NotificationRouter per bot loop — `process_complete` hooks fire on
   *  the owning loop's router, so the Gateway must register its per-session
   *  adapter on every one of them. */
  notificationRouters: NotificationRouter[];
  /** One ToolRegistry per bot loop. Each loop owns its own registry (there is
   *  no shared one), so the outbound `a2a_send` tool is registered on every one
   *  of them — see `registerA2aOutboundTools`. */
  toolRegistries: ToolRegistry[];
  /** One `refreshPersonalities` closure per personality-bound bot loop. The
   *  gateway's `personalityDirectory.refresh()` invokes all of them so a
   *  hot-dropped/edited personality reaches every loop's registry. Team loops
   *  have no personality registry and contribute none. */
  refreshers: Array<() => Promise<void>>;
}

/**
 * Derive the botKey for a WhatsApp config. MUST stay byte-identical to the
 * adapter's own fallback (`WhatsAppAdapter` in @ethosagent/platform-whatsapp)
 * so the key the gateway routes table is built from matches the key the
 * adapter stamps on inbound messages. WhatsApp has no token, so unlike
 * telegram/slack there is nothing to sha256 — the key is the explicit `id`
 * or a slug of the session directory.
 */
function whatsAppBotKey(waCfg: WhatsAppConfig): string {
  return (
    waCfg.id ??
    `wa-${(waCfg.session_dir ?? join(ethosDir(), 'whatsapp')).replace(/[^a-zA-Z0-9]/g, '').slice(-16)}`
  );
}

/**
 * Derive the botKey for the legacy scalar Discord config. Computed once here
 * and passed to BOTH the adapter (which stamps it on inbound messages) and
 * `buildGatewayBots` (which registers the routing entry), so the two never
 * drift. Seed is the bot token, matching the pre-P5 adapter derivation so the
 * key value is stable across the change.
 */
function discordBotKey(discordToken: string): string {
  return deriveBotKeyFromSeed(discordToken);
}

/**
 * Derive the botKey for the legacy scalar Email config. Same contract as
 * `discordBotKey`. Seed is `<user>@<imapHost>`, matching the pre-P5 adapter
 * derivation.
 */
function emailBotKey(user: string, imapHost: string): string {
  return deriveBotKeyFromSeed(`${user}@${imapHost}`);
}

async function buildGatewayBots(
  config: EthosConfig,
  scheduler: CronScheduler,
  watcherManager: WatcherManager,
  resolveOriginThreadId: (sessionKey: string) => string | undefined,
): Promise<BuildGatewayBotsResult> {
  // Every personality loop gets the same scheduler + watcher manager so
  // agent-callable cron/watcher tools land in the shared stores. The thread
  // resolver rides along so background jobs record their full origin lane.
  const loopOpts = { cronScheduler: scheduler, watcherManager, resolveOriginThreadId };
  const out: GatewayBotConfig[] = [];
  const setters: Array<(fn: MessagingSendFn) => void> = [];
  const routers: NotificationRouter[] = [];
  const registries: ToolRegistry[] = [];
  const refreshers: Array<() => Promise<void>> = [];
  const buildOne = async (bot: TelegramBotConfig | SlackAppConfig): Promise<GatewayBotConfig> => {
    const botKey = deriveBotKey(bot);
    let loop: AgentLoop;
    let jobStore: GatewayBotConfig['jobStore'];
    let backgroundExecutor: GatewayBotConfig['backgroundExecutor'];
    if (bot.bind.type === 'team') {
      const team = await createTeamAgentLoop(config, bot.bind.name);
      loop = team.loop;
      routers.push(team.notificationRouter);
      registries.push(team.toolRegistry);
    } else {
      // Per-bot personality loop. Threads the shared scheduler so
      // `create_cron_job` etc. lands in the same store as the
      // system-loop's jobs.
      const result = await createAgentLoop(
        { ...config, personality: bot.bind.name },
        { ...loopOpts, originBotKey: botKey },
      );
      loop = result.loop;
      jobStore = result.jobStore;
      backgroundExecutor = result.backgroundExecutor;
      setters.push(result.setMessagingSend);
      routers.push(result.notificationRouter);
      registries.push(result.toolRegistry);
      refreshers.push(result.refreshPersonalities);
    }
    return {
      botKey,
      loop,
      binding: { ...bot.bind },
      piiRedaction: bot.piiRedaction,
      ...(jobStore ? { jobStore } : {}),
      ...(backgroundExecutor ? { backgroundExecutor } : {}),
    };
  };
  for (const bot of config.telegram?.bots ?? []) out.push(await buildOne(bot));
  for (const app of config.slack?.apps ?? []) out.push(await buildOne(app));
  for (const waCfg of config.whatsapp ?? []) {
    const botKey = whatsAppBotKey(waCfg);
    // WhatsApp bind is optional (unlike telegram/slack). A bind-less entry
    // falls back to the default personality — but make that visible so a
    // misconfigured bot doesn't silently answer as the wrong persona.
    const bind = waCfg.bind ?? { type: 'personality' as const, name: config.personality };
    if (!waCfg.bind) {
      console.warn(
        `[whatsapp] bot "${botKey}" has no personality bind — using the default personality "${config.personality}". Re-save it in the app to bind a personality.`,
      );
    }
    let loop: AgentLoop;
    let jobStore: GatewayBotConfig['jobStore'];
    let backgroundExecutor: GatewayBotConfig['backgroundExecutor'];
    if (bind.type === 'team') {
      const team = await createTeamAgentLoop(config, bind.name);
      loop = team.loop;
      routers.push(team.notificationRouter);
      registries.push(team.toolRegistry);
    } else {
      const result = await createAgentLoop(
        { ...config, personality: bind.name },
        { ...loopOpts, originBotKey: botKey },
      );
      loop = result.loop;
      jobStore = result.jobStore;
      backgroundExecutor = result.backgroundExecutor;
      setters.push(result.setMessagingSend);
      routers.push(result.notificationRouter);
      registries.push(result.toolRegistry);
      refreshers.push(result.refreshPersonalities);
    }
    out.push({
      botKey,
      loop,
      binding: { ...bind },
      piiRedaction: waCfg.piiRedaction,
      ...(jobStore ? { jobStore } : {}),
      ...(backgroundExecutor ? { backgroundExecutor } : {}),
    });
  }
  // Inbound webhooks — each hookId becomes a first-class personality-bound bot
  // so POST /webhook/<hookId> drives the same gateway/session machinery as a
  // channel bot. botKey matches what the webhook server stamps on inbounds.
  for (const [hookId, hook] of Object.entries(config.webhooks ?? {})) {
    const botKey = `webhook:${hookId}`;
    const result = await createAgentLoop(
      { ...config, personality: hook.personalityId },
      { ...loopOpts, originBotKey: botKey },
    );
    out.push({
      botKey,
      loop: result.loop,
      binding: { type: 'personality', name: hook.personalityId },
      ...(result.jobStore ? { jobStore: result.jobStore } : {}),
      ...(result.backgroundExecutor ? { backgroundExecutor: result.backgroundExecutor } : {}),
    });
    setters.push(result.setMessagingSend);
    routers.push(result.notificationRouter);
    registries.push(result.toolRegistry);
    refreshers.push(result.refreshPersonalities);
  }
  // Legacy scalar Discord — register as a first-class bot bound to the default
  // personality so its inbound (stamped with the wiring-computed botKey)
  // resolves to a loop instead of dropping at the unknown-botKey gate. The
  // botKey MUST match what `buildAdapters` passes the DiscordAdapter.
  if (config.discordToken) {
    const botKey = discordBotKey(config.discordToken);
    const result = await createAgentLoop(config, { ...loopOpts, originBotKey: botKey });
    out.push({
      botKey,
      loop: result.loop,
      binding: { type: 'personality', name: config.personality },
      ...(result.jobStore ? { jobStore: result.jobStore } : {}),
      ...(result.backgroundExecutor ? { backgroundExecutor: result.backgroundExecutor } : {}),
    });
    setters.push(result.setMessagingSend);
    routers.push(result.notificationRouter);
    registries.push(result.toolRegistry);
    refreshers.push(result.refreshPersonalities);
  }
  // Legacy scalar Email — same treatment as Discord.
  if (config.emailImapHost && config.emailUser && config.emailPassword && config.emailSmtpHost) {
    const botKey = emailBotKey(config.emailUser, config.emailImapHost);
    const result = await createAgentLoop(config, { ...loopOpts, originBotKey: botKey });
    out.push({
      botKey,
      loop: result.loop,
      binding: { type: 'personality', name: config.personality },
      ...(result.jobStore ? { jobStore: result.jobStore } : {}),
      ...(result.backgroundExecutor ? { backgroundExecutor: result.backgroundExecutor } : {}),
    });
    setters.push(result.setMessagingSend);
    routers.push(result.notificationRouter);
    registries.push(result.toolRegistry);
    refreshers.push(result.refreshPersonalities);
  }
  return {
    bots: out,
    messagingSetters: setters,
    notificationRouters: routers,
    toolRegistries: registries,
    refreshers,
  };
}

/**
 * A2A Stage 1d — register the outbound `a2a_send` tool on every gateway loop's
 * tool registry so an A2A call can originate from a channel turn (Telegram,
 * Slack, …), not just from `ethos serve`. Mirrors serve.ts's construction:
 * the SAME per-personality allowlist that gates inbound peers gates outbound
 * calls (egress default-deny, plan §15), and the tool is still gated by each
 * personality's `a2a` toolset.
 *
 * Unlike serve (which owns a live toggle), the gateway is a separate process
 * with no live settings flag: `isEnabled` reads the persisted `config.a2a`
 * value (plus the `ETHOS_A2A_ENABLED` override, for parity with serve). A
 * toggle therefore reaches the gateway on its next start — the documented
 * gateway behaviour (plan §13).
 *
 * Fail-open: constructing the A2A deps must NEVER crash gateway startup —
 * channels are the gateway's core job — so any failure is logged and swallowed.
 */
async function registerA2aOutboundTools(
  config: EthosConfig,
  registries: ToolRegistry[],
): Promise<void> {
  if (registries.length === 0) return;
  try {
    const isEnabled = () => config.a2a?.enabled === true || process.env.ETHOS_A2A_ENABLED === '1';
    const secrets = await getSecretsResolver();
    const storage = getStorage();
    const dir = ethosDir();
    const baseDir = join(dir, 'a2a');
    const personalities = await createPersonalityRegistry({
      storage,
      userPersonalitiesDir: join(dir, 'personalities'),
    });
    await personalities.loadFromDirectory(join(dir, 'personalities'));
    const identity = new PersonalityA2aIdentityProvider({
      personalities,
      secrets,
      storage,
      ...(config.webBaseUrl ? { baseUrl: config.webBaseUrl } : {}),
    });
    const allowlist = new StorageA2aAllowlist(storage, baseDir);
    const allowSelfLoop = process.env.ETHOS_A2A_SELF_LOOP === '1';
    const tools = createA2aTools({
      identity,
      secrets,
      allowlist,
      ...(allowSelfLoop ? { allowSelfLoop: true } : {}),
      isEnabled,
    });
    for (const registry of registries) {
      for (const tool of tools) registry.register(tool);
    }
    console.log(
      `${c.dim}a2a:          outbound tool registered on ${registries.length} loop(s) (${isEnabled() ? 'enabled' : 'disabled'})${c.reset}`,
    );
  } catch (err) {
    console.warn(
      `${c.yellow}⚠ a2a: outbound tool registration failed — A2A calls from channels unavailable${c.reset} ${c.dim}(${err instanceof Error ? err.message : String(err)})${c.reset}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Interactive tool-approval flow (Slack, Telegram, any ApprovalCapableAdapter)
// ---------------------------------------------------------------------------

// `import type` only — erased at runtime, so `@ethosagent/platform-slack`
// stays lazily loaded via `loadAdapterModule` and the layering is unchanged.
// The approval contract lives in `@ethosagent/types` so any adapter
// (Slack, Telegram, future) can implement it without cross-platform imports.
type ApprovalCapableAdapter = import('@ethosagent/types').ApprovalCapableAdapter;

/**
 * Runtime narrowing for the approval surface. The adapter list is typed as
 * `PlatformAdapter[]` (adapters are loaded lazily and heterogeneously), so a
 * structural probe is still needed to pick out the approval-capable ones —
 * but it narrows to the explicit, package-owned `ApprovalCapableAdapter`
 * type, not an ad-hoc shape.
 */
function isApprovalCapable(
  adapter: PlatformAdapter,
): adapter is PlatformAdapter & ApprovalCapableAdapter {
  const a = adapter as Partial<ApprovalCapableAdapter>;
  return (
    typeof a.botKey === 'string' &&
    typeof a.postApprovalCard === 'function' &&
    typeof a.updateApprovalCard === 'function' &&
    typeof a.onApprovalDecision === 'function'
  );
}

/**
 * Connect the agent loop's `before_tool_call` hook to approval cards.
 *
 * Three wires:
 *   1. `before_tool_call` hook on every approval-capable bot loop →
 *      `ApprovalCoordinator` suspends dangerous calls.
 *   2. `coordinator.onPending` → resolve the sessionId to its adapter/chat/
 *      thread via the gateway and post an approval card.
 *   3. each adapter's button-click event → `coordinator.approve/deny`
 *      and an in-place update of the card.
 *
 * Skipped entirely when no approval-capable adapter is configured.
 */
function wireApprovalFlow(
  gateway: Gateway,
  bots: GatewayBotConfig[],
  adapters: PlatformAdapter[],
  seams: {
    /** The gateway's hot-reloaded read registry — the same one `/personality`
     *  validates against, so a switched personality's approval policy applies
     *  on its next turn. */
    personalities: PersonalityRegistry;
    /** Lazy provider handle for `approvalMode: 'smart'`. */
    getProvider: () => Promise<LLMProvider>;
    /** Model the smart reviewer runs on. */
    model: string;
  },
): void {
  const approvalAdapters = adapters.filter(isApprovalCapable);
  if (approvalAdapters.length === 0) return;

  // Every settled approval lands in the safety audit trail (`ethos audit
  // decisions`). Resolved lazily so a boot that never touches observability
  // doesn't open the DB; the coordinator swallows any failure here.
  const observability: ApprovalObservability = {
    recordSafetyApproval: (opts) => getEthosObservability().recordSafetyApproval(opts),
  };
  const coordinator = new ApprovalCoordinator({ observability });

  // Where a posted card lives, keyed by `approvalId`. Populated once
  // `postApprovalCard` succeeds; consumed by the `onResolved` handler so the
  // card is updated in place no matter HOW the approval resolved — button
  // click, timeout, or session cancel. A fail-closed deny (no card ever
  // posted) simply has no entry here, so the update is skipped.
  const postedCards = new Map<
    string,
    { adapter: ApprovalCapableAdapter; chatId: string; messageTs: string; toolName: string }
  >();
  // Resolutions that landed BEFORE the card finished posting (e.g. a session
  // cancel races the API call). Keyed by `approvalId`. The post
  // `.then()` drains this so a card posted into an already-resolved approval
  // is updated immediately instead of being left with live buttons forever.
  const resolvedBeforePost = new Map<string, { decision: 'allow' | 'deny'; decidedBy: string }>();
  // `approvalId`s with a `postApprovalCard` call genuinely in flight. Gates
  // `resolvedBeforePost`: without it, a fail-closed deny (no route / no
  // adapter / post failure) would record an outcome that no post
  // `.then()` ever drains — an unbounded leak.
  const inFlightPosts = new Set<string>();

  // Resolve a `sessionId` to its approval target. Returns `undefined` for
  // any turn whose route isn't an approval-capable adapter.
  const resolveApprovalTarget = (sessionId: string) => {
    const route = gateway.resolveApprovalRoute(sessionId);
    if (!route || !isApprovalCapable(route.adapter)) return undefined;
    // Bind the approval to the user whose message triggered the turn, so a
    // bystander in the channel can't click Allow on a tool call they don't own.
    return { requesterUserId: route.requesterUserId };
  };

  // Register the approval hook only on loops whose bot has an
  // approval-capable adapter.
  const approvalBotKeys = new Set(approvalAdapters.map((a) => a.botKey));
  const approvalBots = bots.filter((bot) => approvalBotKeys.has(bot.botKey));
  // One predicate for all approval bots. It learns each turn's personality
  // from the owning loop's `session_start`, so `denyRules` and `approvalMode`
  // follow whatever personality the lane is actually running — including a
  // `/personality` switch. The reviewer and its provider stay unconstructed
  // unless a flagged call reaches `approvalMode: 'smart'`.
  const isDangerous = createApprovalDangerPredicate({
    hooks: approvalBots.map((bot) => bot.loop.hooks),
    personalities: seams.personalities,
    getProvider: seams.getProvider,
    model: seams.model,
    alwaysAsk: APPROVAL_SURFACE_ALWAYS_ASK,
  });
  for (const bot of approvalBots) {
    bot.loop.hooks.registerModifying(
      'before_tool_call',
      createSlackApprovalHook({ coordinator, isDangerous, resolveApprovalTarget }),
    );
  }

  // Update a posted card to its resolved state. Shared by the normal
  // `onResolved` path and the post-races-resolution recovery path.
  const updateCard = (
    card: { adapter: ApprovalCapableAdapter; chatId: string; messageTs: string; toolName: string },
    decision: 'allow' | 'deny',
    decidedBy: string,
  ): void => {
    void card.adapter
      .updateApprovalCard({
        chatId: card.chatId,
        messageTs: card.messageTs,
        toolName: card.toolName,
        decision,
        decidedBy,
      })
      .then((result) => {
        if (!result.ok) {
          console.error('[gateway] failed to update approval card:', result.error);
        }
      })
      .catch((err) => {
        console.error('[gateway] failed to update approval card:', err);
      });
  };

  // Pending approval → post a card on the originating Slack conversation.
  //
  // Fail CLOSED: the agent loop's hook is already suspended on the
  // coordinator promise. Any path that can't deliver a card — no route, a
  // non-Slack adapter (e.g. a Discord/Email message that fell back to this
  // Slack bot's loop), or a Slack post failure — must resolve the approval
  // as a deny, or the turn hangs forever with no way to recover. Card
  // delivery is a correctness path, not an observability-only one.
  coordinator.onPending((req) => {
    const route = gateway.resolveApprovalRoute(req.sessionId);
    if (!route || !isApprovalCapable(route.adapter)) {
      void coordinator.deny(req.approvalId, 'system');
      return;
    }
    const adapter = route.adapter;
    inFlightPosts.add(req.approvalId);
    void adapter
      .postApprovalCard({
        chatId: route.chatId,
        threadId: route.threadId,
        approvalId: req.approvalId,
        toolName: req.toolName,
        reason: req.reason,
        args: req.args,
      })
      .then((result) => {
        inFlightPosts.delete(req.approvalId);
        if ('error' in result) {
          console.error('[gateway] failed to post approval card:', result.error);
          resolvedBeforePost.delete(req.approvalId);
          void coordinator.deny(req.approvalId, 'system');
          return;
        }
        const card = {
          adapter,
          chatId: route.chatId,
          messageTs: result.messageTs,
          toolName: req.toolName,
        };
        // If the approval resolved while this post was in flight, the
        // `onResolved` handler already ran and found no card. Drain that
        // recorded outcome now so the freshly-posted card doesn't sit in the
        // channel with live buttons forever.
        const racedOutcome = resolvedBeforePost.get(req.approvalId);
        if (racedOutcome) {
          resolvedBeforePost.delete(req.approvalId);
          updateCard(card, racedOutcome.decision, racedOutcome.decidedBy);
          return;
        }
        postedCards.set(req.approvalId, card);
      })
      .catch((err) => {
        inFlightPosts.delete(req.approvalId);
        resolvedBeforePost.delete(req.approvalId);
        console.error('[gateway] failed to post approval card:', err);
        void coordinator.deny(req.approvalId, 'system');
      });
  });

  // Resolution (from ANY source — click, timeout, cancel) → update the card
  // in place so its buttons disappear and it reflects the real decision. The
  // card UI must never lie about approval state. When a card post is still
  // in flight, record the outcome so the post `.then()` can apply it the
  // moment the card exists; when no post is in flight (a fail-closed deny
  // with no route), there's no card to update and nothing to record.
  coordinator.onResolved((approvalId, decision, decidedBy) => {
    const card = postedCards.get(approvalId);
    if (!card) {
      if (inFlightPosts.has(approvalId)) {
        resolvedBeforePost.set(approvalId, { decision, decidedBy });
      }
      return;
    }
    postedCards.delete(approvalId);
    updateCard(card, decision, decidedBy);
  });

  // Button click → resolve the approval through the coordinator. The card
  // update is handled by the `onResolved` handler above, so a click and a
  // timeout converge on the same render path.
  for (const adapter of approvalAdapters) {
    adapter.onApprovalDecision((event) => {
      if (event.decision === 'allow') {
        void coordinator.approve(event.approvalId, event.decidedBy);
      } else {
        void coordinator.deny(event.approvalId, event.decidedBy);
      }
    });
  }
}

/**
 * Validate that every bot binding points at a real personality or team
 * on disk. Personality set comes from the same `FilePersonalityRegistry`
 * the agent loop uses at runtime — no duplicated roster of built-ins
 * to drift the next time built-ins change. Team set comes from
 * `~/.ethos/teams/<name>.yaml`.
 */
async function validateBindings(config: EthosConfig): Promise<string[]> {
  const storage = getStorage();
  const registry = await createPersonalityRegistry({
    storage,
    userPersonalitiesDir: join(ethosDir(), 'personalities'),
  });
  // `loadFromDirectory` uses Storage.list, which returns [] for a
  // missing directory — so we don't pre-check existence. Genuine
  // load errors (corrupt personality file, parse failure, permission
  // denied) propagate here at validation time rather than crashing
  // the first inbound message later.
  await registry.loadFromDirectory(join(ethosDir(), 'personalities'));
  const personalityIds = new Set<string>(registry.list().map((p) => p.id));

  // Team manifests live at ~/.ethos/teams/<name>.yaml. Storage.listEntries
  // is the constitution-approved listing primitive and yields an empty
  // list for a missing directory, so no pre-check needed.
  const teamNames = new Set<string>();
  for (const entry of await storage.listEntries(join(ethosDir(), 'teams'))) {
    if (entry.name.endsWith('.yaml')) teamNames.add(entry.name.replace(/\.yaml$/, ''));
  }
  return validateBotBindings(config, { personalityIds, teamNames });
}

/**
 * Construct one PlatformAdapter per configured bot/app, in addition to
 * single legacy adapters for discord + email. Exported so tests can
 * exercise the multi-bot adapter loop with a mocked module loader
 * (avoiding a real grammy / @slack/bolt construction in unit tests).
 *
 * Applies `applyPlatformShim` defensively so callers that pass a
 * legacy single-bot config (`telegramToken` / `slackBotToken` etc.)
 * still construct adapters correctly. The shim is idempotent — when
 * the boot path already normalized via `loadConfigStrict`, the
 * second pass is a no-op.
 */
export type AdapterModuleLoader = <T>(modulePath: string, label: string) => Promise<T | null>;

/**
 * Adapt the personality-scoped MemoryProvider to the narrow
 * `{ read, append }` shape the Slack `/ethos memory` command consumes.
 * Scopes every read/write to `personality:<id>` so each Slack bot sees
 * the MEMORY.md of the personality it's bound to.
 */
function createSlackMemoryReader(personalityId: string) {
  const provider = createMemoryProvider({ dataDir: ethosDir(), storage: getStorage() });
  const ctx: MemoryContext = {
    scopeId: `personality:${personalityId}`,
    sessionId: '',
    sessionKey: '',
    platform: 'slack',
    workingDir: process.cwd(),
  };
  return {
    async read(): Promise<string | null> {
      const entry = await provider.read('MEMORY.md', ctx);
      return entry?.content ?? null;
    },
    async append(text: string): Promise<void> {
      await provider.sync([{ action: 'add', key: 'MEMORY.md', content: text }], ctx);
    },
  };
}

/**
 * Build the `/ethos personality rich` card reader: the personality registry
 * supplies config + SOUL.md, and the shared `SkillsInjector.resolveSkills()`
 * supplies the resolved skill set. The injector is constructed the way
 * `createInjectors` builds it for the agent loop, so the card never drifts
 * from what the personality actually sees. Built once at boot; `read()`
 * reloads the registry (mtime-cached, cheap) so an edited personality
 * reflects without a gateway restart.
 */
async function createSlackPersonalityCardReader() {
  const storage = getStorage();
  const personalitiesDir = join(ethosDir(), 'personalities');
  const registry = await createPersonalityRegistry({
    storage,
    userPersonalitiesDir: personalitiesDir,
  });
  const { skillsInjector } = createInjectors(registry, {
    storage,
    trustedFirstPartySources: [bundledSkillsSource()],
  });
  return {
    async read(personalityId: string) {
      await registry.loadFromDirectory(personalitiesDir);
      const config = registry.get(personalityId);
      if (!config) return null;
      const soulMd = await registry.readSoulMd(personalityId);
      const resolved = await skillsInjector.resolveSkills(personalityId);
      return {
        id: config.id,
        name: config.name,
        description: config.description ?? '',
        prose: firstParagraph(soulMd),
        model: resolveModelDisplay(config.model),
        provider: config.provider ?? '(engine default)',
        toolset: config.toolset ?? [],
        skills: resolved.map((r) => ({ id: r.id, source: r.source })),
      };
    },
  };
}

/** How many recent sessions the App Home reader hands the Slack adapter. The
 *  view caps its own list at 5 and renders "+ N more" from the overflow, so a
 *  slightly larger window makes that counter meaningful without unbounded IO. */
const SLACK_RECENT_SESSION_LIMIT = 10;

/**
 * Build the App Home "Recent sessions" reader and the `/sessions/<id>` unfurl
 * reader, both backed by the gateway's `sessions.db`. Mirrors
 * `createSlackMemoryReader`: the Slack package never imports
 * `@ethosagent/session-sqlite`, it just consumes these narrow shapes.
 *
 * The store is opened on first read, not at boot — `buildAdapters` runs in
 * contexts (tests, `--dry-run`-style construction) where touching the session
 * database would be a surprising side effect.
 *
 * `recentSessions` filters on the gateway's own lane-key prefix
 * (`slack:<botKey>:`, each segment URL-encoded — see `buildLaneKey` in
 * `@ethosagent/gateway`), so one workspace's App Home never lists another
 * bot's conversations.
 */
function createSlackSessionReaders(botKey: string) {
  let store: SessionStore | undefined;
  const sessions = (): SessionStore => {
    store ??= createSessionStore({ dataDir: ethosDir() });
    return store;
  };
  const prefix = `slack:${encodeURIComponent(botKey)}:`;
  return {
    session: {
      async recentSessions() {
        const rows = await sessions().listSessions({
          keyPrefix: prefix,
          limit: SLACK_RECENT_SESSION_LIMIT,
        });
        return rows.map((s) => ({
          id: s.id,
          // The lane key's tail is the channel (plus thread, when threaded) —
          // the only human-meaningful part of an otherwise opaque key.
          label: s.key.slice(prefix.length) || s.key,
          lastActivity: s.updatedAt,
        }));
      },
    },
    sessionUnfurl: {
      async lookupSession(id: string) {
        const s = await sessions().getSession(id);
        if (!s) return null;
        return {
          id: s.id,
          // Sessions store the personality id, which is what operators name
          // their personalities by; no registry lookup buys anything here.
          personalityName: s.personalityId ?? 'unknown',
          lastActivity: s.updatedAt,
        };
      },
    },
  };
}

/**
 * Build the `/personalities/<id>` unfurl reader. Same registry the
 * `/ethos personality rich` card reader uses, reloaded per lookup (mtime-cached,
 * so an edited personality unfurls without a gateway restart).
 */
async function createSlackPersonalityUnfurlReader() {
  const storage = getStorage();
  const personalitiesDir = join(ethosDir(), 'personalities');
  const registry = await createPersonalityRegistry({
    storage,
    userPersonalitiesDir: personalitiesDir,
  });
  return {
    async lookupPersonality(id: string) {
      await registry.loadFromDirectory(personalitiesDir);
      const config = registry.get(id);
      if (!config) return null;
      return { id: config.id, name: config.name, description: config.description ?? '' };
    },
  };
}

/**
 * Build the `/ethos kanban list` reader and the `/kanban/<ticket>` unfurl
 * reader for a team-bound Slack bot. Both open the team's `board.db` per call
 * and close it — the board is small, the reads are rare (a slash command or a
 * pasted link), and a long-lived handle in the adapter would outlive the
 * board's own lifecycle. A team with no board yet degrades to an empty list /
 * skipped unfurl rather than creating one.
 */
function createSlackKanbanReaders(teamName: string) {
  const boardPath = resolveKanbanDbPath({ teamName }, ethosDir());
  const open = async (): Promise<KanbanStore | null> => {
    if (!(await getStorage().exists(boardPath))) return null;
    return new KanbanStore(boardPath, { teamId: teamName });
  };
  return {
    kanban: {
      async listOpenTickets() {
        const store = await open();
        if (!store) return [];
        try {
          return store
            .listTasks({ limit: 200 })
            .filter((t) => t.status !== 'done' && t.status !== 'archived')
            .map((t) => ({ id: t.id, title: t.title, status: t.status, assignee: t.assignee }));
        } finally {
          store.close();
        }
      },
    },
    kanbanUnfurl: {
      async lookupTicket(id: string) {
        const store = await open();
        if (!store) return null;
        try {
          const task = store.getTask(id);
          if (!task) return null;
          return {
            id: task.id,
            title: task.title,
            status: task.status,
            assignee: task.assignee,
            parentGoal: store.getParents(task.id)[0]?.title ?? null,
          };
        } finally {
          store.close();
        }
      },
    },
  };
}

/**
 * Build the Telegram `/personality rich` card reader. Mirrors the Slack
 * reader but renders the card as Telegram Markdown text via the Telegram
 * personality module. Lazily imports `@ethosagent/platform-telegram` so
 * the function stays safe when the Telegram adapter SDK isn't installed.
 */
async function createTelegramPersonalityCardReader() {
  const storage = getStorage();
  const personalitiesDir = join(ethosDir(), 'personalities');
  const registry = await createPersonalityRegistry({
    storage,
    userPersonalitiesDir: personalitiesDir,
  });
  const { skillsInjector } = createInjectors(registry, {
    storage,
    trustedFirstPartySources: [bundledSkillsSource()],
  });
  // Lazily import the Telegram personality renderer. The import type is
  // erased at runtime; the `as` cast is safe because we catch import failure.
  let renderFn: ((card: Record<string, unknown>) => string) | null = null;
  try {
    const mod = await import('@ethosagent/platform-telegram/personality');
    renderFn = mod.personalityRichMessage as unknown as (card: Record<string, unknown>) => string;
  } catch {
    // Telegram personality module not available — reader will return null.
  }
  return {
    async read(personalityId: string): Promise<{ text: string } | null> {
      if (!renderFn) return null;
      await registry.loadFromDirectory(personalitiesDir);
      const config = registry.get(personalityId);
      if (!config) return null;
      const soulMd = await registry.readSoulMd(personalityId);
      const resolved = await skillsInjector.resolveSkills(personalityId);
      const card = {
        id: config.id,
        name: config.name,
        description: config.description ?? '',
        prose: firstParagraph(soulMd),
        model: resolveModelDisplay(config.model),
        provider: config.provider ?? '(engine default)',
        toolset: config.toolset ?? [],
        skills: resolved.map((r) => ({ id: r.id, source: r.source })),
      };
      return { text: renderFn(card) };
    },
  };
}

/**
 * Build the Telegram `/start` greeting provider. Returns a personality-aware
 * greeting composed of the personality's description (or first paragraph of
 * SOUL.md), plus a pointer to `/help`.
 */
async function createTelegramGreetingProvider() {
  const storage = getStorage();
  const personalitiesDir = join(ethosDir(), 'personalities');
  const registry = await createPersonalityRegistry({
    storage,
    userPersonalitiesDir: personalitiesDir,
  });
  return {
    async greet(personalityId: string): Promise<string> {
      await registry.loadFromDirectory(personalitiesDir);
      const config = registry.get(personalityId);
      if (!config) {
        return `Hello! I'm *${personalityId}*. Send a message to get started, or try /help for available commands.`;
      }
      const soulMd = await registry.readSoulMd(personalityId).catch(() => '');
      const prose = firstParagraph(soulMd);
      const intro = prose || config.description || config.name;
      return `${intro}\n\nUse /help to see available commands.`;
    },
  };
}

/**
 * Effective allowlist for a Slack app's out-of-band surfaces — the `/ethos`
 * slash command and the App Home tab. Neither is an inbound message, so the
 * gateway's `checkMessage` never sees them; this is where they get their
 * trust set, and it is derived from the message surface's so the two cannot
 * disagree about who is trusted.
 *
 * Base = `channel_filter.slack` (`ownerUserId` + `recipientAllowlist`), the
 * exact set `checkMessage` admits. `slack.apps.<i>.allowedSlashUsers`, when
 * set, *narrows* that base — it can never widen it, so a user who cannot get
 * a message to the bot can never drive its privileged surfaces either.
 *
 * Fail-closed: no `channel_filter.slack` entry, no allowlisted senders, or an
 * `allowedSlashUsers` list that shares no id with the base, all yield `[]`,
 * and an empty list authorizes nobody. `channel_filter.slack.enabled: false`
 * is deliberately not an escape hatch here — disabling the message filter
 * opens the message surface, not the surfaces that write MEMORY.md and
 * rewrite channel routing.
 */
function slackSlashAllowlist(
  filter: { ownerUserId?: string; recipientAllowlist?: string[] } | undefined,
  allowedSlashUsers: string[] | undefined,
): string[] {
  const base: string[] = [];
  if (filter?.ownerUserId) base.push(filter.ownerUserId);
  if (filter?.recipientAllowlist) base.push(...filter.recipientAllowlist);
  if (!allowedSlashUsers || allowedSlashUsers.length === 0) return base;
  return base.filter((id) => allowedSlashUsers.includes(id));
}

export async function buildAdapters(
  config: EthosConfig,
  loadAdapter: AdapterModuleLoader,
  attachmentCache?: import('@ethosagent/types').AttachmentCache,
  opts?: {
    onWhatsAppQr?: (botId: string, qr: string | null) => void;
    onWhatsAppPairingCode?: (botId: string, code: string | null) => void;
  },
): Promise<PlatformAdapter[]> {
  config = applyPlatformShim(config).config;
  const adapters: PlatformAdapter[] = [];

  if ((config.telegram?.bots.length ?? 0) > 0) {
    const mod = await loadAdapter<typeof import('@ethosagent/platform-telegram')>(
      '@ethosagent/platform-telegram',
      'Telegram',
    );
    if (mod) {
      // Resolve identity for personality-bound bots from the registry.
      const storage = getStorage();
      const personalitiesDir = join(ethosDir(), 'personalities');
      const registry = await createPersonalityRegistry({
        storage,
        userPersonalitiesDir: personalitiesDir,
      });
      await registry.loadFromDirectory(personalitiesDir);

      // Telegram adapter requires a cache. When the caller provides one
      // (production gateway path), use it; otherwise create one on the fly
      // (test / standalone path).
      let telegramCache = attachmentCache;
      if (!telegramCache) {
        const { FsAttachmentCache } = await import('@ethosagent/storage-fs');
        telegramCache = new FsAttachmentCache(storage, join(ethosDir(), 'cache', 'attachments'));
      }

      for (const botCfg of config.telegram?.bots ?? []) {
        let identity: { name: string; shortDescription: string; description: string } | undefined;
        if (botCfg.bind.type === 'personality') {
          const pConfig = registry.get(botCfg.bind.name);
          if (pConfig) {
            const soulMd = await registry.readSoulMd(botCfg.bind.name).catch(() => '');
            const prose = firstParagraph(soulMd);
            identity = {
              name: pConfig.name,
              shortDescription: pConfig.description ?? pConfig.name,
              description: prose || pConfig.description || pConfig.name,
            };
          }
        }
        adapters.push(
          new mod.TelegramAdapter({
            token: botCfg.token,
            cache: telegramCache,
            botKey: deriveBotKey(botCfg),
            dropPendingUpdates: true,
            ...(identity ? { identity } : {}),
          }),
        );
      }
    }
  }

  if ((config.slack?.apps.length ?? 0) > 0) {
    const mod = await loadAdapter<typeof import('@ethosagent/platform-slack')>(
      '@ethosagent/platform-slack',
      'Slack',
    );
    if (mod) {
      // Slack adapters consume `binding` (member-join greeting, /ethos
      // personality, /ethos help) and `storage` (per-channel mode
      // overrides + thread-participation state). The adapter owns its
      // on-disk layout under <storage_root>/slack — wiring stays out of
      // that decision so the filesystem path doesn't show up in two
      // places.
      const slackStorage = getStorage();
      // One card reader serves every Slack bot — `read()` takes the
      // personality id, so it isn't bot-specific. The handler only consults
      // it for personality bindings (`/ethos personality rich`).
      const personalityCard = await createSlackPersonalityCardReader();
      // Likewise bot-agnostic: `lookupPersonality` takes the id from the
      // shared URL.
      const personalityUnfurl = await createSlackPersonalityUnfurlReader();
      // The Ethos web UI origin is not a Slack-specific setting — it's the
      // same public URL the OAuth redirect and the web app use
      // (`ETHOS_PUBLIC_URL` env > `webBaseUrl` in config.yaml). Passing it is
      // what turns App Home deep links on AND registers the `link_shared`
      // unfurl handler at all; without it `registerLinkEvents` returns early.
      const webUiBaseUrl = config.webBaseUrl;
      for (const appCfg of config.slack?.apps ?? []) {
        // `/ethos memory show|add` reads the bound personality's MEMORY.md.
        // Team bindings have no single MEMORY.md, so they keep degrading to
        // "Memory is unavailable for this bot."
        const memory =
          appCfg.bind.type === 'personality'
            ? createSlackMemoryReader(appCfg.bind.name)
            : undefined;
        const botKey = deriveBotKey(appCfg);
        // Session rows are per-bot: the reader filters on this bot's lane-key
        // prefix.
        const { session, sessionUnfurl } = createSlackSessionReaders(botKey);
        // Kanban is a team feature — a personality-bound bot has no board, and
        // the slash command already says so. Leaving the readers unwired keeps
        // the App Home section and the ticket unfurl hidden for those bots.
        const kanbanReaders =
          appCfg.bind.type === 'team' ? createSlackKanbanReaders(appCfg.bind.name) : undefined;
        adapters.push(
          new mod.SlackAdapter({
            botToken: appCfg.botToken,
            appToken: appCfg.appToken,
            signingSecret: appCfg.signingSecret,
            botKey,
            binding: { type: appCfg.bind.type, name: appCfg.bind.name },
            // Always passed, never conditionally spread: an omitted key would
            // leave the gate's state implicit, and this gate denies by
            // default precisely so nothing depends on omission.
            allowedUsers: slackSlashAllowlist(
              config.channelFilter?.slack,
              appCfg.allowedSlashUsers,
            ),
            // CHS-005 — adapter-local refusals land in the same audit trail as
            // approvals. Resolved lazily so a boot that never refuses anything
            // does not open the observability DB.
            observability: {
              recordSafetyBlock: (opts) => getEthosObservability().recordSafetyBlock(opts),
            },
            storage: slackStorage,
            personalityCard,
            personalityUnfurl,
            session,
            sessionUnfurl,
            ...(attachmentCache ? { cache: attachmentCache } : {}),
            ...(memory ? { memory } : {}),
            ...(kanbanReaders
              ? { kanban: kanbanReaders.kanban, kanbanUnfurl: kanbanReaders.kanbanUnfurl }
              : {}),
            ...(appCfg.defaultChannelMode ? { defaultChannelMode: appCfg.defaultChannelMode } : {}),
            ...(appCfg.receiptReaction ? { receiptReaction: appCfg.receiptReaction } : {}),
            ...(appCfg.allowedBotIds?.length ? { allowedBotIds: appCfg.allowedBotIds } : {}),
            ...(appCfg.longReplyThresholdChars !== undefined
              ? { longReplyThresholdChars: appCfg.longReplyThresholdChars }
              : {}),
            ...(webUiBaseUrl ? { webUiBaseUrl } : {}),
          }),
        );
      }
    }
  }

  if (config.discordToken) {
    const mod = await loadAdapter<typeof import('@ethosagent/platform-discord')>(
      '@ethosagent/platform-discord',
      'Discord',
    );
    if (mod) {
      adapters.push(
        new mod.DiscordAdapter({
          token: config.discordToken,
          botKey: discordBotKey(config.discordToken),
          // CHS-005 — see the Slack adapter above; a refused approval click is
          // otherwise visible only to the person refused.
          observability: {
            recordSafetyBlock: (opts) => getEthosObservability().recordSafetyBlock(opts),
          },
        }),
      );
    }
  }

  if (config.emailImapHost && config.emailUser && config.emailPassword && config.emailSmtpHost) {
    const mod = await loadAdapter<typeof import('@ethosagent/platform-email')>(
      '@ethosagent/platform-email',
      'Email',
    );
    if (mod) {
      adapters.push(
        new mod.EmailAdapter({
          imapHost: config.emailImapHost,
          imapPort: config.emailImapPort ?? 993,
          user: config.emailUser,
          password: config.emailPassword,
          smtpHost: config.emailSmtpHost,
          smtpPort: config.emailSmtpPort ?? 587,
          botKey: emailBotKey(config.emailUser, config.emailImapHost),
        }),
      );
    }
  }

  if ((config.whatsapp?.length ?? 0) > 0) {
    const mod = await loadAdapter<typeof import('@ethosagent/platform-whatsapp')>(
      '@ethosagent/platform-whatsapp',
      'WhatsApp',
    );
    if (mod) {
      let waCache = attachmentCache;
      if (!waCache) {
        const { FsAttachmentCache } = await import('@ethosagent/storage-fs');
        waCache = new FsAttachmentCache(getStorage(), join(ethosDir(), 'cache', 'attachments'));
      }

      const waConfigs = config.whatsapp ?? [];
      if (waConfigs.length > 1) {
        const missingIds = waConfigs.filter((c) => !c.id);
        if (missingIds.length > 0) {
          throw new EthosError({
            code: 'CONFIG_INVALID',
            cause: `[whatsapp] Multiple WhatsApp configs require explicit 'id' fields. ${missingIds.length} config(s) are missing an id.`,
            action: "Add an 'id' field to each WhatsApp config in ~/.ethos/config.yaml.",
          });
        }
        const ids = waConfigs.map((c) => c.id);
        const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
        if (dupes.length > 0) {
          throw new EthosError({
            code: 'CONFIG_INVALID',
            cause: `[whatsapp] Duplicate WhatsApp bot IDs: ${dupes.join(', ')}. Each config must have a unique id.`,
            action:
              "Ensure each WhatsApp config in ~/.ethos/config.yaml has a distinct 'id' value.",
          });
        }
      }

      for (const waCfg of config.whatsapp ?? []) {
        const onQrCb = opts?.onWhatsAppQr;
        const onPairingCb = opts?.onWhatsAppPairingCode;
        adapters.push(
          new mod.WhatsAppAdapter({
            id: waCfg.id,
            botKey: whatsAppBotKey(waCfg),
            sessionDir: waCfg.session_dir ?? join(ethosDir(), 'whatsapp'),
            defaultMode: waCfg.default_mode ?? 'mention_only',
            allowedJids: waCfg.allowed_numbers,
            cache: waCache,
            onQr: onQrCb ? (qr) => onQrCb(waCfg.id ?? 'default', qr) : undefined,
            ...(waCfg.phone_number ? { phoneNumber: waCfg.phone_number } : {}),
            onPairingCode: onPairingCb
              ? (code) => onPairingCb(waCfg.id ?? 'default', code)
              : undefined,
          }),
        );
      }
    }
  }

  return adapters;
}

/**
 * Build one `TelegramClarifySurface` per (Telegram adapter, Telegram bot)
 * pair. Loaded lazily — when the platform-telegram surface module isn't
 * installed (or no Telegram adapter is configured), returns `[]` and the
 * Gateway runs without a clarify correlator. The surface registers
 * `bridge.setPresenter`, `bridge.onResolved`, and `adapter.onCallbackQuery`
 * in its constructor; the gateway later calls `surface.correlateMessage` for
 * every inbound message.
 *
 * `getSessionRouting` resolves a sessionId to the chat + originator user id
 * of the turn that issued the clarify. Closes over a gateway reference that
 * is filled in *after* this function returns (the surface and the Gateway
 * each need a reference to the other), so callers must pass a closure rather
 * than a direct gateway method.
 */
async function buildTelegramClarifySurfaces(
  bots: GatewayBotConfig[],
  adapters: PlatformAdapter[],
  getSessionRouting: (
    sessionId: string,
  ) => { chatId: string; requesterUserId?: string } | undefined,
): Promise<{ correlateMessage: (m: InboundMessage) => Promise<ClarifyResponse | null> }[]> {
  const telegramAdapters = adapters.filter((a) => a.id.startsWith('telegram:'));
  if (telegramAdapters.length === 0) return [];

  const mod = await loadAdapterModule<
    typeof import('@ethosagent/platform-telegram/clarify-surface')
  >('@ethosagent/platform-telegram/clarify-surface', 'Telegram clarify surface');
  if (!mod) return [];

  const surfaces: {
    correlateMessage: (m: InboundMessage) => Promise<ClarifyResponse | null>;
  }[] = [];
  for (const adapter of telegramAdapters) {
    // `adapter.id` is `telegram:<botKey>` — strip the prefix to find the
    // matching bot's clarifyBridge.
    const botKey = adapter.id.slice('telegram:'.length);
    const bot = bots.find((b) => b.botKey === botKey);
    const bridge = bot?.loop.clarifyBridge;
    if (!bridge) continue;
    // The TelegramAdapter satisfies TelegramClarifyAdapter structurally —
    // the methods were added in the same package.
    const tgAdapter = adapter as unknown as ConstructorParameters<
      typeof mod.TelegramClarifySurface
    >[0]['adapter'];
    surfaces.push(
      new mod.TelegramClarifySurface({
        adapter: tgAdapter,
        bridge,
        store: bridge.store,
        getSessionRouting,
      }),
    );
  }
  return surfaces;
}

/**
 * Build one `SlackClarifySurface` per (Slack adapter, Slack bot) pair.
 * Loaded lazily — when the platform-slack surface module isn't installed
 * (or no Slack adapter is configured), returns `[]` and Slack just runs
 * without clarify support. Each surface registers `bridge.setPresenter`,
 * `bridge.onResolved`, `adapter.onClarifyAction`, and
 * `adapter.onClarifyModalSubmit` in its constructor; nothing else needs
 * wiring (Slack carries its own button-click + modal-submission events
 * through Bolt, so there's no inbound-correlator step like Telegram has
 * for force-replies).
 */
async function buildSlackClarifySurfaces(
  bots: GatewayBotConfig[],
  adapters: PlatformAdapter[],
  getSessionRouting: (
    sessionId: string,
  ) => { chatId: string; threadId?: string; requesterUserId?: string } | undefined,
): Promise<unknown[]> {
  const slackAdapters = adapters.filter((a) => a.id.startsWith('slack:'));
  if (slackAdapters.length === 0) return [];

  const mod = await loadAdapterModule<typeof import('@ethosagent/platform-slack/clarify-surface')>(
    '@ethosagent/platform-slack/clarify-surface',
    'Slack clarify surface',
  );
  if (!mod) return [];

  const surfaces: unknown[] = [];
  for (const adapter of slackAdapters) {
    const botKey = adapter.id.slice('slack:'.length);
    const bot = bots.find((b) => b.botKey === botKey);
    const bridge = bot?.loop.clarifyBridge;
    if (!bridge) continue;
    const slackAdapter = adapter as unknown as ConstructorParameters<
      typeof mod.SlackClarifySurface
    >[0]['adapter'];
    const surface = new mod.SlackClarifySurface({
      adapter: slackAdapter,
      bridge,
      store: bridge.store,
      getSessionRouting,
      // CHS-005 — the cross-tenant gate drops a click silently by design; the
      // audit row is what makes a replay attempt investigable afterwards.
      observability: {
        recordSafetyBlock: (opts) => getEthosObservability().recordSafetyBlock(opts),
      },
    });
    // Wire the App Home "Waiting on you" data source. Setter must run
    // before adapter.start() so registerHomeEvents picks it up.
    const withReader = adapter as unknown as {
      setClarifyHomeReader?: (r: { listPendingForBot: () => Promise<unknown[]> }) => void;
    };
    withReader.setClarifyHomeReader?.(surface);
    surfaces.push(surface);
  }
  return surfaces;
}

/**
 * Build one `DiscordClarifySurface` per (Discord adapter, Discord bot) pair.
 * Currently Discord supports a single bot per process (the legacy single
 * `discordToken` config), so this typically builds 0 or 1 surface. Loaded
 * lazily — when the surface module isn't installed (or no Discord adapter
 * is configured), returns `[]`.
 */
async function buildDiscordClarifySurfaces(
  bots: GatewayBotConfig[],
  adapters: PlatformAdapter[],
  systemLoop: AgentLoop,
  getSessionRouting: (
    sessionId: string,
  ) => { chatId: string; requesterUserId?: string } | undefined,
): Promise<unknown[]> {
  const discordAdapters = adapters.filter((a) => a.id.startsWith('discord:'));
  if (discordAdapters.length === 0) return [];

  const mod = await loadAdapterModule<
    typeof import('@ethosagent/platform-discord/clarify-surface')
  >('@ethosagent/platform-discord/clarify-surface', 'Discord clarify surface');
  if (!mod) return [];

  const surfaces: unknown[] = [];
  for (const adapter of discordAdapters) {
    const botKey = adapter.id.slice('discord:'.length);
    const bot = bots.find((b) => b.botKey === botKey);
    // Per-bot loop wins; legacy single-Discord (no entry in `bots[]`) falls
    // back to the system loop. Either way, the bridge must exist — the
    // wiring layer always attaches one, so an absent bridge is a bug.
    const bridge = bot?.loop.clarifyBridge ?? systemLoop.clarifyBridge;
    if (!bridge) continue;
    const discordAdapter = adapter as unknown as ConstructorParameters<
      typeof mod.DiscordClarifySurface
    >[0]['adapter'];
    surfaces.push(
      new mod.DiscordClarifySurface({
        adapter: discordAdapter,
        bridge,
        store: bridge.store,
        getSessionRouting,
      }),
    );
  }
  return surfaces;
}

/**
 * Build one `WhatsAppClarifySurface` per (WhatsApp adapter, WhatsApp bot)
 * pair. Loaded lazily — when the surface module isn't installed (or no
 * WhatsApp adapter is configured), returns `[]` and WhatsApp runs without
 * clarify support.
 *
 * WhatsApp has no interactive-component transport (Baileys 7 can neither
 * send buttons/lists nor decode their responses), so the surface presents a
 * numbered prompt and, like Telegram, resolves it through the gateway's
 * `clarifyMessageCorrelator`.
 */
async function buildWhatsAppClarifySurfaces(
  bots: GatewayBotConfig[],
  adapters: PlatformAdapter[],
  getSessionRouting: (
    sessionId: string,
  ) => { chatId: string; requesterUserId?: string } | undefined,
): Promise<{ correlateMessage: (m: InboundMessage) => Promise<ClarifyResponse | null> }[]> {
  const whatsAppAdapters = adapters.filter((a) => a.id.startsWith('whatsapp:'));
  if (whatsAppAdapters.length === 0) return [];

  const mod = await loadAdapterModule<
    typeof import('@ethosagent/platform-whatsapp/clarify-surface')
  >('@ethosagent/platform-whatsapp/clarify-surface', 'WhatsApp clarify surface');
  if (!mod) return [];

  const surfaces: {
    correlateMessage: (m: InboundMessage) => Promise<ClarifyResponse | null>;
  }[] = [];
  for (const adapter of whatsAppAdapters) {
    // `adapter.id` is `whatsapp:<botKey>` — strip the prefix to find the
    // matching bot's clarifyBridge.
    const botKey = adapter.id.slice('whatsapp:'.length);
    const bot = bots.find((b) => b.botKey === botKey);
    const bridge = bot?.loop.clarifyBridge;
    if (!bridge) continue;
    // The WhatsAppAdapter satisfies WhatsAppClarifyAdapter structurally.
    const waAdapter = adapter as unknown as ConstructorParameters<
      typeof mod.WhatsAppClarifySurface
    >[0]['adapter'];
    surfaces.push(
      new mod.WhatsAppClarifySurface({
        adapter: waAdapter,
        bridge,
        store: bridge.store,
        getSessionRouting,
      }),
    );
  }
  return surfaces;
}
