import { existsSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { meshRegistryPath, setMeshObservabilityService } from '@ethosagent/agent-mesh';
import { type EthosConfig, ethosDir, readKeys, readRawConfig } from '@ethosagent/config';
import type { AgentLoop } from '@ethosagent/core';
import type { CronJob } from '@ethosagent/cron';
import {
  BlobStore,
  ObservabilityService,
  SQLiteObservabilityStore,
} from '@ethosagent/observability-sqlite';
import { setUnknownModelReporter } from '@ethosagent/pricing';
import {
  EnvSecretsResolver,
  FileSecretsResolver,
  FsStorage,
  loadDotEnv,
  MergedSecretsResolver,
} from '@ethosagent/storage-fs';
import { parseTeamManifest, teamsDir } from '@ethosagent/team-supervisor';
import type {
  LLMProvider,
  SecretsResolver,
  Storage,
  TeamManifest,
  ToolRegistry,
} from '@ethosagent/types';
import {
  type CreateAgentLoopResult,
  EthosObservability,
  FunnelTracker,
  createAgentLoop as packageCreateAgentLoop,
  createLLM as packageCreateLLM,
  type WiringConfig,
  type WiringProfile,
} from '@ethosagent/wiring';
import { setObservabilityService } from './error-log';
import { logger } from './logger';

// CLI-side adapter over @ethosagent/wiring. Resolves the rotation pool, data
// dir, working dir, and logger from the CLI's environment, then delegates.
// The actual loop assembly (LLM + tools + hooks + session/memory/personalities)
// lives in the package so TUI / web / ACP surfaces can share it.

let storageSingleton: Storage | undefined;

/**
 * The CLI's process-wide Storage instance. FsStorage is stateless so multiple
 * instances would be safe, but a singleton keeps the dependency-injection
 * graph readable: any code path that needs ~/.ethos/ access calls this.
 */
export function getStorage(): Storage {
  if (!storageSingleton) storageSingleton = new FsStorage();
  return storageSingleton;
}

let secretsInitPromise: Promise<SecretsResolver> | undefined;

export function getSecretsResolver(): Promise<SecretsResolver> {
  if (!secretsInitPromise) {
    secretsInitPromise = initSecrets();
  }
  return secretsInitPromise;
}

async function initSecrets(): Promise<SecretsResolver> {
  const envFilePath = process.env.ETHOS_ENV_FILE ?? join(ethosDir(), '.env');
  loadDotEnv(envFilePath);

  const file = new FileSecretsResolver({
    dir: join(ethosDir(), 'secrets'),
    storage: getStorage(),
  });
  const env = new EnvSecretsResolver();

  const rawConfig = await readRawConfig(getStorage());
  if (rawConfig?.aws?.secrets?.enabled) {
    const { AwsSecretsManagerResolver } = await import('@ethosagent/secrets-aws');
    const awsResolver = new AwsSecretsManagerResolver({
      region: rawConfig.aws.secrets.region ?? 'us-east-1',
      prefix: rawConfig.aws.secrets.prefix ?? 'ethos',
      endpoint: rawConfig.aws.secrets.endpoint,
    });
    return new MergedSecretsResolver({
      readers: [env, awsResolver, file],
      writer: awsResolver,
    });
  }

  return new MergedSecretsResolver({ readers: [env, file], writer: file });
}

let obsSingleton: ObservabilityService | undefined;
let ethosObsSingleton: EthosObservability | undefined;
let obsStoreSingleton: SQLiteObservabilityStore | undefined;

/**
 * The CLI's process-wide ObservabilityService. Creates the SQLite store and
 * blob store on first access, returning the same instance thereafter. The
 * ethos-flavored adapter is constructed alongside and registered with
 * components that need typed domain helpers (error-log, mesh journal).
 */
export function getObservabilityService(): ObservabilityService {
  if (!obsSingleton) {
    const dir = ethosDir();
    const storage = getStorage();
    const store = new SQLiteObservabilityStore(join(dir, 'observability.db'));
    obsStoreSingleton = store;
    const blobStore = new BlobStore(join(dir, 'blobs'), storage);
    const killSwitchPath = join(dir, '.observability.disabled');
    obsSingleton = new ObservabilityService(store, blobStore, () => existsSync(killSwitchPath));
    ethosObsSingleton = new EthosObservability(obsSingleton);
    setObservabilityService(ethosObsSingleton);
    setMeshObservabilityService(ethosObsSingleton);
    // A5 — provider transports call `estimateCost` with no observability handle
    // of their own, so the sink for unpriced models is bound here, once per
    // process. The pricing package does the per-model de-duplication.
    setUnknownModelReporter((model) => {
      ethosObsSingleton?.recordUnknownModelPricing({
        code: 'pricing.unknown_model',
        cause: `No rate for model "${model}" — its calls are recorded as $0.`,
        model,
      });
    });
  }
  return obsSingleton;
}

/**
 * The underlying SQLite observability store (Phase 0 — backs the per-session
 * context anatomy read). Initialised alongside the ObservabilityService.
 */
export function getObservabilityStore(): SQLiteObservabilityStore {
  if (!obsStoreSingleton) getObservabilityService();
  if (!obsStoreSingleton) throw new Error('ethos observability store not initialised');
  return obsStoreSingleton;
}

export function getEthosObservability(): EthosObservability {
  // Constructed alongside the singleton — getObservabilityService initialises both.
  if (!ethosObsSingleton) {
    getObservabilityService();
  }
  if (!ethosObsSingleton) throw new Error('ethos observability adapter not initialised');
  return ethosObsSingleton;
}

let funnelSingleton: FunnelTracker | undefined;

/**
 * Process-wide funnel tracker (W4.1). Owns the `~/.ethos/funnel-state.json`
 * stamp file; every emission site (setup, chat done, gateway turn completion,
 * web-api done pipeline) records through this so each funnel event fires
 * exactly once per install.
 */
export function getFunnelTracker(): FunnelTracker {
  if (!funnelSingleton) {
    funnelSingleton = new FunnelTracker({
      storage: getStorage(),
      dataDir: ethosDir(),
      observability: getEthosObservability(),
    });
  }
  return funnelSingleton;
}

/**
 * Build the handler map for source:'system' cron jobs. Each handler is a
 * closure that lazy-imports the heavy module it needs, keeping startup fast.
 *
 * NOTE: dashboard-refresh is intentionally omitted — its DashboardsService
 * dependency lives in the web-api scope, not the CLI wiring layer. The
 * web-api poller stays as-is; a follow-up will migrate it.
 */
export function buildSystemTaskHandlers(
  config: EthosConfig,
): Record<string, (job: CronJob) => Promise<{ output: string }>> {
  return {
    'observability-prune': async () => {
      const { pruneObservabilityByPath } = await import('@ethosagent/observability-sqlite');
      const dir = ethosDir();
      const obsDbPath = join(dir, 'observability.db');
      const sessDbPath = join(dir, 'sessions.db');
      pruneObservabilityByPath(obsDbPath, config.retention ?? {}, { sessDbPath });
      return { output: 'Observability prune completed' };
    },
    'nightly-pass': async () => {
      const { runNightlyOnce } = await import('./commands/nightly');
      await runNightlyOnce(config);
      return { output: 'Nightly governed-learning pass completed' };
    },
    'weekly-digest': async () => {
      const { runDigestOnce } = await import('./commands/digest');
      await runDigestOnce(config, { email: !!config.weeklyDigest?.recipients?.length });
      return { output: 'Weekly digest completed' };
    },
    'skill-evolver': async () => {
      const { runEvolve } = await import('./commands/evolve');
      await runEvolve(['run', '--quiet'], config);
      return { output: 'Skill evolver run completed' };
    },
  };
}

async function withRotation(config: EthosConfig) {
  const rotationKeys =
    config.provider === 'anthropic' ? await readKeys(getStorage(), await getSecretsResolver()) : [];
  return { ...config, rotationKeys };
}

export async function createLLM(
  config: EthosConfig,
  opts: { probeWindowRefresh?: boolean } = {},
): Promise<LLMProvider> {
  // The provider factories resolve credentials from the secret store before
  // falling back to the plaintext config key, and some (codex, bedrock) have
  // no config key at all. Without the resolver those factories see the
  // package's null-object fallback and every stored credential reads as
  // absent — `createAgentLoop` threads it, so this must too.
  const wiringConfig: WiringConfig = {
    ...(await withRotation(config)),
    secretsResolver: await getSecretsResolver(),
  };
  // Lane 0 — thread the window-probe context so local runtimes resolve their
  // SERVED context window (cache-first; `probeWindowRefresh` forces a live
  // probe and rewrites the cache — `ethos doctor`).
  return packageCreateLLM(wiringConfig, {
    storage: getStorage(),
    dataDir: ethosDir(),
    ...(opts.probeWindowRefresh === true ? { forceRefresh: true } : {}),
  });
}

export async function createAgentLoop(
  config: EthosConfig & Pick<WiringConfig, 'teamName' | 'role' | 'postmortems' | 'trustPolicy'>,
  opts: {
    profile?: WiringProfile;
    meshRegistryPath?: string;
    /**
     * Shared CronScheduler so the agent-callable `cron` tool lands in the
     * same store the operator-driven `ethos cron` CLI uses. Pass the
     * gateway's / serve's scheduler instance here; the wiring layer
     * registers the tool only when the personality opts in via
     * `toolset.yaml`. Omit for ephemeral CLI chat sessions where
     * scheduled work can't persist past process exit.
     */
    cronScheduler?: import('@ethosagent/cron').CronScheduler;
    /**
     * Shared WatcherManager so the agent-callable `watcher_*` tools land
     * in the same watchers.json the ticking manager reads. Pass the
     * gateway's / serve's manager instance; omit for ephemeral CLI chat
     * sessions where a watcher couldn't tick past process exit.
     */
    watcherManager?: import('@ethosagent/watchers').WatcherManager;
    /**
     * Shared call log so the outbound `call` tool records the calls this loop
     * places. Gateway only — it is the surface that opens `~/.ethos/calls.db`
     * for inbound dispatch, and both directions belong in the one file. Omit
     * and `call` dials without writing a row.
     */
    callLog?: import('@ethosagent/call-log').CallLog;
    /**
     * App-layer slash command registry (chat REPL). Threaded through to
     * plugin loading so plugin-registered slash commands show up in
     * autocomplete and /help.
     */
    slashRegistry?: import('@ethosagent/wiring').WiringSlashRegistry;
    /**
     * The bot this loop answers as, stamped on background jobs it spawns so a
     * completion stays routable back to its lane across a restart. Gateway
     * only — one loop per bot; CLI/serve loops have no bot identity.
     */
    originBotKey?: string;
    /**
     * Resolve which thread a live turn belongs to, for the same reason.
     * Gateway only — it is the one component that knows the mapping.
     */
    resolveOriginThreadId?: (sessionKey: string) => string | undefined;
    /**
     * Lane 0 (D16) — force a LIVE served-window probe (bypassing the disk
     * cache) and rewrite the cache. Set by `ethos bench context`; chat and
     * gateway startup leave it unset and ride the cache.
     */
    probeWindowRefresh?: boolean;
    /**
     * Native LiveKit MEDIA binding from `resolveLiveKitMedia()` — the thing
     * that lets `voiceStack.createSipAdapter` exist and a phone call carry
     * audio. Gateway only, and only when `voice.trunk`/`voice.livekit` is
     * configured; every other caller omits it and gets today's behaviour.
     */
    livekit?: import('@ethosagent/wiring').LiveKitBindings;
  } = {},
): Promise<CreateAgentLoopResult> {
  const rotated = await withRotation(config);
  const wiringConfig: WiringConfig = {
    ...rotated,
    ...(config.teamName !== undefined ? { teamName: config.teamName } : {}),
    ...(config.role !== undefined ? { role: config.role } : {}),
    ...(config.auxiliary?.compression
      ? { auxiliaryCompression: config.auxiliary.compression }
      : {}),
    ...(config.auxiliary?.vision ? { auxiliaryVision: config.auxiliary.vision } : {}),
    ...(config.auxiliary?.web ? { auxiliaryWeb: config.auxiliary.web } : {}),
    ...(config.auxiliary?.asr ? { auxiliaryAsr: config.auxiliary.asr } : {}),
    ...(config.auxiliary?.tts ? { auxiliaryTts: config.auxiliary.tts } : {}),
    ...(config.voice ? { voice: config.voice } : {}),
    ...(config.memoryCapture ? { memoryCapture: config.memoryCapture } : {}),
    ...(config.memoryVault ? { memoryVault: config.memoryVault } : {}),
    ...(config.memoryApproval ? { memoryApproval: config.memoryApproval } : {}),
    ...(config.nightlyPass ? { nightlyPass: config.nightlyPass } : {}),
    ...(config.displayMemoryNotices !== undefined
      ? { displayMemoryNotices: config.displayMemoryNotices }
      : {}),
    ...(config.web?.search_backend ? { webSearchBackend: config.web.search_backend } : {}),
    ...(config.postmortems !== undefined ? { postmortems: config.postmortems } : {}),
    ...(config.trustPolicy !== undefined ? { trustPolicy: config.trustPolicy } : {}),
    ...(config.background ? { background: config.background } : {}),
    ...(config.modelCatalog ? { modelCatalogConfig: config.modelCatalog } : {}),
    ...(config.storage ? { storage: config.storage } : {}),
    ...(config.pluginsAutoInstall !== undefined
      ? { pluginsAutoInstall: config.pluginsAutoInstall }
      : {}),
    secretsResolver: await getSecretsResolver(),
  };
  const result = await packageCreateAgentLoop(wiringConfig, {
    dataDir: ethosDir(),
    workingDir: process.cwd(),
    profile: opts.profile ?? 'cli',
    logger,
    meshRegistryPath: opts.meshRegistryPath,
    observability: getEthosObservability(),
    ...(opts.cronScheduler ? { cronScheduler: opts.cronScheduler } : {}),
    ...(opts.watcherManager ? { watcherManager: opts.watcherManager } : {}),
    ...(opts.callLog ? { callLog: opts.callLog } : {}),
    ...(opts.slashRegistry ? { slashRegistry: opts.slashRegistry } : {}),
    ...(opts.originBotKey ? { originBotKey: opts.originBotKey } : {}),
    ...(opts.resolveOriginThreadId ? { resolveOriginThreadId: opts.resolveOriginThreadId } : {}),
    ...(opts.probeWindowRefresh === true ? { probeWindowRefresh: true } : {}),
    ...(opts.livekit ? { livekit: opts.livekit } : {}),
  });

  return result;
}

// ---------------------------------------------------------------------------
// Team helpers
// ---------------------------------------------------------------------------

export interface TeamLoopInfo {
  loop: AgentLoop;
  toolRegistry: ToolRegistry;
  /** Personality the coordinator runs as. */
  coordinatorPersonality: string;
  /** Mesh name (team name unless manifest.mesh overrides it). */
  meshName: string;
  /** Forward the improvement-fork callback setter so `serve.ts` can wire SSE. */
  setOnSkillProposed?: (fn: (skillId: string, personalityId: string) => void) => void;
  /** v2.2 — Notification router for registering per-session adapters. */
  notificationRouter: import('@ethosagent/types').NotificationRouter;
  /** v2.2 — Plugin loader for health checks and diagnostics. */
  pluginLoader: import('@ethosagent/wiring').CreateAgentLoopResult['pluginLoader'];
  /** Phase B — durable background engine handles (undefined when background is disabled). */
  jobStore?: import('@ethosagent/wiring').CreateAgentLoopResult['jobStore'];
  backgroundExecutor?: import('@ethosagent/wiring').CreateAgentLoopResult['backgroundExecutor'];
  /**
   * Round-3 Issue 2 — forwarded from the coordinator's own `createAgentLoop`
   * call below. `isCallCaptureToolsEnabled` gates on darwin +
   * `callCapture.personalityId` alone (not on which personality the loop
   * itself is "for"), so the coordinator's loop produces an equivalent
   * closure to any other loop's. Undefined on every deployment that hasn't
   * configured call capture, same as the non-team `createAgentLoop` path.
   */
  runCallCapture?: import('@ethosagent/wiring').CreateAgentLoopResult['runCallCapture'];
}

/** Resolve a team manifest by name (local ./team.yaml or ~/.ethos/teams/<n>.yaml). */
export function loadTeamManifest(teamName: string): TeamManifest {
  // Try trusted location first — ~/.ethos/teams/<teamName>.yaml
  const trusted = join(teamsDir(), `${teamName}.yaml`);
  try {
    return parseTeamManifest(readFileSync(trusted, 'utf-8'));
  } catch {
    // Not found — fall through to CWD fallback
  }
  // Fallback: ./team.yaml in CWD (developer convenience, lower priority)
  const local = resolvePath('./team.yaml');
  const src = readFileSync(local, 'utf-8');
  const m = parseTeamManifest(src);
  if (m.name === teamName) return m;
  throw new Error(`team.yaml in CWD has name "${m.name}", expected "${teamName}"`);
}

/**
 * Build an AgentLoop wired to a team's named mesh.
 * The coordinator personality is taken from manifest.coordinator, falling back
 * to the first member, then to config.personality.
 *
 * Phase 2: applies coordinator model override from manifest.coordinator_model.
 */
export async function createTeamAgentLoop(
  config: EthosConfig,
  teamName: string,
  opts: {
    profile?: WiringProfile;
    role?: 'coordinator' | 'member';
    slashRegistry?: import('@ethosagent/wiring').WiringSlashRegistry;
  } = {},
): Promise<TeamLoopInfo> {
  const manifest = loadTeamManifest(teamName);
  const coordinatorPersonality =
    manifest.coordinator ?? manifest.members[0]?.personality ?? config.personality;
  const meshName = manifest.mesh ?? manifest.name;

  // Coordinator model: manifest.coordinator_model beats global config.model.
  // Coordinator does NOT use personality-level modelRouting (see plan doc).
  const coordinatorConfig = manifest.coordinator_model
    ? { ...config, model: manifest.coordinator_model }
    : config;

  // Plan B — thread teamName + role into the wiring so the kanban store points at
  // the team board and the role-gate hook gets registered.
  const {
    loop,
    toolRegistry,
    setOnSkillProposed,
    notificationRouter,
    pluginLoader,
    jobStore,
    backgroundExecutor,
    runCallCapture,
  } = await createAgentLoop(
    {
      ...coordinatorConfig,
      personality: coordinatorPersonality,
      teamName,
      role: opts.role ?? 'coordinator',
      postmortems: manifest.postmortems,
      trustPolicy: manifest.trust_policy,
    },
    {
      profile: opts.profile ?? 'cli',
      meshRegistryPath: meshRegistryPath(meshName),
      ...(opts.slashRegistry ? { slashRegistry: opts.slashRegistry } : {}),
    },
  );

  const coordinatorSystem = buildCoordinatorTeamPrompt(manifest);
  loop.hooks.registerModifying('before_prompt_build', async (payload) => {
    if (payload.personalityId !== coordinatorPersonality) return null;
    return { prependSystem: coordinatorSystem };
  });

  return {
    loop,
    toolRegistry,
    coordinatorPersonality,
    meshName,
    setOnSkillProposed,
    notificationRouter,
    pluginLoader,
    ...(jobStore ? { jobStore } : {}),
    ...(backgroundExecutor ? { backgroundExecutor } : {}),
    ...(runCallCapture ? { runCallCapture } : {}),
  };
}

function buildCoordinatorTeamPrompt(manifest: TeamManifest): string {
  const members = manifest.members.map((m) => m.personality);
  const teamName = manifest.name;
  const memberText = members.length > 0 ? members.join(', ') : 'none';
  return [
    `## Team Identity`,
    `You are the coordinator of team "${teamName}".`,
    `Your name is "${teamName}".`,
    `If asked your name, answer with "${teamName}".`,
    `If asked who you are, say you are the coordinator of this team and list your member personalities: ${memberText}.`,
    `For simple conversational questions (greetings, identity, coordination metadata), reply directly without any tool call.`,
    `Delegate only when specialist execution is required.`,
  ].join('\n');
}

/**
 * Resolve the active chat target from config and return a ready AgentLoop.
 * Dispatches to team or personality mode based on config.activeContext.
 */
export interface ActiveLoop {
  loop: AgentLoop;
  /** Personality ID to pass per-turn (the coordinator for teams). */
  personalityId: string;
  /** Human-readable label for the banner: "researcher" or "team:myteam". */
  displayName: string;
  /** Forward the skill-evolution callback setter so surfaces can wire SSE/CLI notifications. */
  setOnSkillProposed?: (fn: (skillId: string, personalityId: string) => void) => void;
  /** memory-experience §3.3 — subscribe to proactive-capture notices (CLI prints them). */
  onMemoryCaptured?: import('@ethosagent/wiring').CreateAgentLoopResult['onMemoryCaptured'];
  /** v2.2 — Notification router for registering per-session adapters. */
  notificationRouter: import('@ethosagent/types').NotificationRouter;
  /** v2.2 — Plugin loader for health checks and diagnostics. */
  pluginLoader: import('@ethosagent/wiring').CreateAgentLoopResult['pluginLoader'];
  /** Phase B — durable background engine handles (undefined when background is disabled). */
  jobStore?: import('@ethosagent/wiring').CreateAgentLoopResult['jobStore'];
  backgroundExecutor?: import('@ethosagent/wiring').CreateAgentLoopResult['backgroundExecutor'];
}

export async function resolveActiveLoop(
  config: EthosConfig,
  opts: {
    profile?: WiringProfile;
    slashRegistry?: import('@ethosagent/wiring').WiringSlashRegistry;
  } = {},
): Promise<ActiveLoop> {
  if (config.activeContext?.type === 'team') {
    const teamName = config.activeContext.name;
    const teamResult = await createTeamAgentLoop(config, teamName, opts);
    applyCliOverrideHooks(teamResult.loop, config);
    return {
      loop: teamResult.loop,
      personalityId: teamResult.coordinatorPersonality,
      displayName: `team:${teamName}`,
      setOnSkillProposed: teamResult.setOnSkillProposed,
      // Team-scope capture is deferred (open-question 6); no notice forwarding.
      notificationRouter: teamResult.notificationRouter,
      pluginLoader: teamResult.pluginLoader,
      ...(teamResult.jobStore ? { jobStore: teamResult.jobStore } : {}),
      ...(teamResult.backgroundExecutor
        ? { backgroundExecutor: teamResult.backgroundExecutor }
        : {}),
    };
  }
  const personalityId = config.activeContext?.name ?? config.personality;
  const result = await createAgentLoop({ ...config, personality: personalityId }, opts);
  applyCliOverrideHooks(result.loop, config);
  return {
    loop: result.loop,
    personalityId,
    displayName: personalityId,
    setOnSkillProposed: result.setOnSkillProposed,
    ...(result.onMemoryCaptured ? { onMemoryCaptured: result.onMemoryCaptured } : {}),
    notificationRouter: result.notificationRouter,
    pluginLoader: result.pluginLoader,
    ...(result.jobStore ? { jobStore: result.jobStore } : {}),
    ...(result.backgroundExecutor ? { backgroundExecutor: result.backgroundExecutor } : {}),
  };
}

// ---------------------------------------------------------------------------
// FW-8 — apply CLI override hooks after the AgentLoop is constructed
// ---------------------------------------------------------------------------

/**
 * Register hooks that enforce the CLI override flags (`--toolsets`, `-s`).
 * Called after every loop construction path in resolveActiveLoop so team
 * and solo modes both get the overrides.
 */
function applyCliOverrideHooks(loop: AgentLoop, config: EthosConfig): void {
  // --toolsets: reject before_tool_call for tools not in the allowed set
  if (config.cliToolsets && config.cliToolsets.length > 0) {
    const allowed = new Set(config.cliToolsets);
    loop.hooks.registerModifying('before_tool_call', async (payload) => {
      const tool = loop.getAvailableTools().find((t) => t.name === payload.toolName);
      if (tool?.toolset && !allowed.has(tool.toolset)) {
        return {
          error: `Tool '${payload.toolName}' (toolset: ${tool.toolset}) is disabled by --toolsets CLI override`,
        };
      }
      return null;
    });
  }

  // -s: prepend skill content to every turn's system prompt (content pre-loaded by applyCliOverrides)
  if (config.cliSkillContents && config.cliSkillContents.length > 0) {
    const skillContent = config.cliSkillContents.filter(Boolean).join('\n\n---\n\n');
    if (skillContent) {
      loop.hooks.registerModifying('before_prompt_build', async () => {
        return { prependSystem: skillContent };
      });
    }
  }
}
