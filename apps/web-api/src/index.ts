import { join } from 'node:path';
import { SessionStreamBuffer } from '@ethosagent/agent-bridge';
import { AgentMesh, defaultRegistryPath } from '@ethosagent/agent-mesh';
import type { AgentLoop } from '@ethosagent/core';
import type { CronScheduler } from '@ethosagent/cron';
import {
  DashboardRefreshScheduler,
  DashboardStore,
  DashboardsService,
} from '@ethosagent/dashboard';
import type { GoalRunner } from '@ethosagent/goal-runner';
import type { FilePersonalityRegistry } from '@ethosagent/personalities';
import { SkillsLibrary } from '@ethosagent/skills';
import { FileSecretsResolver, FsStorage } from '@ethosagent/storage-fs';
import { McpJsonStore, type McpManager } from '@ethosagent/tools-mcp';
import { buildDashboardTools } from '@ethosagent/tools-ui';
import type {
  JobStore,
  MemoryProvider,
  SecretsResolver,
  SessionStore,
  Storage,
} from '@ethosagent/types';
import type { SseEvent } from '@ethosagent/web-contracts';
import {
  createMemoryProvider,
  createPendingMemoryStore,
  HistoryStore,
  type IdentityMap,
  type MemoryBackendSelection,
} from '@ethosagent/wiring';
import type { Hono } from 'hono';
import { ChatRepository } from './features/chat/repository';
import { type ChatDefaults, ChatService } from './features/chat/service';
import { CompletionsRepository } from './features/completions/repository';
import { CompletionsService } from './features/completions/service';
import { DebugService } from './features/debug/service';
import { SessionsRepository } from './features/sessions/repository';
import { SessionsService } from './features/sessions/service';
import type { ApiKeyAdminStore } from './middleware/bearer-auth';
import { AllowlistRepository } from './repositories/allowlist.repository';
import { ConfigRepository } from './repositories/config.repository';
import { EvolverRepository } from './repositories/evolver.repository';
import { PlatformsRepository } from './repositories/platforms.repository';
import { WebTokenRepository } from './repositories/web-token.repository';
import { createRoutes } from './routes';
import type { RouteModule } from './routes/route-module';
import { ApiKeysService } from './services/api-keys.service';
import { createWebApprovalHook, type DangerPredicate } from './services/approval-hook';
import { type ApprovalObservability, ApprovalsService } from './services/approvals.service';
import { ConfigService } from './services/config.service';
import { CronService } from './services/cron.service';
import { DigestService } from './services/digest.service';
import { EvolverService } from './services/evolver.service';
import { GoalsService } from './services/goals.service';
import { KanbanService } from './services/kanban.service';
import { LabService } from './services/lab.service';
import { McpService } from './services/mcp.service';
import { MemoryService } from './services/memory.service';
import { MeshService } from './services/mesh.service';
import { NamedSecretsService } from './services/named-secrets.service';
import { OnboardingService } from './services/onboarding.service';
import { PersonalitiesService } from './services/personalities.service';
import { PlatformsService } from './services/platforms.service';
import { PluginsService } from './services/plugins.service';
import { SkillsService } from './services/skills.service';
import { SystemEventBus } from './services/system-event-bus';
import { TasksService } from './services/tasks.service';
import { ToolSettingsService } from './services/tool-settings.service';
import { VoiceService } from './services/voice.service';

// Public entry for `@ethosagent/web-api`. Boot code (`apps/ethos/src/commands/
// serve.ts`) builds the dependencies it has lying around — a `SessionStore`,
// the agent loop, the personality registry, the data dir — and hands them to
// `createWebApi`. The package wires the layered service container internally
// and returns a Hono app the boot script can `serve()`.

export interface CreateWebApiOptions {
  /** Where `~/.ethos/web-token` lives (and, transitively, all other state). */
  dataDir: string;
  /** SQLite-backed session store, already initialised. Shared with ACP /
   *  gateway so the same DB rows back every surface. */
  sessionStore: SessionStore;
  /** Lazy LLM factory for governed-learning drafts (Living Soul Expression
   *  evolution, Soul split). Omitted in onboarding mode — those RPCs then
   *  return NOT_CONFIGURED. */
  personalitiesLlm?: () => Promise<import('@ethosagent/types').LLMProvider>;
  /** Memory provider for scoped read/write. Construct via
   *  `createMemoryProvider` from `@ethosagent/wiring`. */
  memoryProvider: MemoryProvider;
  /** Identity map for resolving platform users to opaque userIds.
   *  Optional — when omitted, `memory.listUsers` returns empty. */
  identityMap?: IdentityMap;
  /**
   * Memory backend selection (the `memory` / `memoryVault` slice of the app
   * config). Threaded into the approve-before-store queue so a web approve
   * replays into the configured backend (`memory: vault` → the vault, history
   * under `.ethos-meta`) instead of assuming markdown at `dataDir`. Omitted →
   * markdown (previous behavior).
   */
  memoryBackend?: MemoryBackendSelection;
  /** Agent loop the chat surface drives. Must already be wired with tools,
   *  hooks, providers etc. (typically via `@ethosagent/wiring`). When omitted
   *  (onboarding mode), a stub loop that yields a SETUP_REQUIRED error is used. */
  agentLoop?: AgentLoop;
  /** Loop-bearing goal runner from `createAgentLoop`. When provided, web-created
   *  goals execute on the same runner+store as the CLI/gateway path. */
  goalRunner?: GoalRunner;
  /** Durable background-job store from wiring's CreateAgentLoopResult. Backs the
   *  Tasks surface (list/get/cancel). Absent when background delegation is
   *  disabled — the tasks RPC degrades to empty reads. */
  jobStore?: JobStore;
  /** Personality registry — shared with the loop so hot-reloads (mtime cache)
   *  reach both surfaces. Must be a `FilePersonalityRegistry` so the web-api's
   *  Personalities tab can drive its CRUD methods (create / update / delete /
   *  duplicate). Construct via `createPersonalityRegistry({ userPersonalitiesDir })`
   *  to enable the writable user directory. */
  personalities: FilePersonalityRegistry;
  /** Loop-registry refresh from wiring's `CreateAgentLoopResult`. When present,
   *  the chat + completions services await it before a turn so a hot-dropped or
   *  edited personality resolves against the loop's registry without a restart.
   *  The Personalities-tab service refreshes `personalities` (this process's
   *  web-api registry) on its own from disk. Absent → no refresh. */
  refreshPersonalities?: () => Promise<void>;
  /** Provider/model defaults stamped on web-created session rows. */
  chatDefaults: ChatDefaults;
  /** Origins to accept for cross-origin (CSRF) state-changing requests.
   *  Empty / unset = localhost only. */
  allowedOrigins?: string[];
  /** Set `secure` on the auth cookie. Off by default; flip on for non-loopback bind. */
  secureCookie?: boolean;
  /** Honor `X-Forwarded-For` for rate-limit bucketing. Only enable behind a
   *  trusted reverse proxy — otherwise clients spoof the header (WEB-006).
   *  Default false. */
  trustProxy?: boolean;
  /**
   * Decides which tool calls require an explicit user approval. When
   * unset, no approvals are demanded — every tool call passes through
   * (recommended only for tests). Boot code typically passes
   * `createDangerPredicate()` from `@ethosagent/wiring`.
   */
  dangerPredicate?: DangerPredicate;
  /**
   * Sink for the safety audit trail behind `ethos audit decisions` — every
   * approval, denial and allowlist auto-allow is recorded through it. Boot
   * code passes wiring's `EthosObservability`. Omitted (tests) → no rows.
   */
  approvalObservability?: ApprovalObservability;
  /**
   * Absolute path to the built `apps/web/dist` SPA. When set, the same
   * Hono app serves the client at `/*`. Omit in dev — Vite handles
   * static + HMR at :5173 and proxies API calls back here.
   */
  webDist?: string;
  /**
   * CronScheduler instance for the cron tab. Boot code constructs and
   * `start()`s it; the web-api just calls list/create/run/etc. on the
   * shared instance. Omit when cron isn't part of this deployment —
   * `cron.list` returns an empty array gracefully.
   */
  cronScheduler?: CronScheduler;
  /**
   * Storage backend used by services that read ~/.ethos/ directly
   * (currently the MCP-config side of plugins.list). Defaults to FsStorage.
   */
  storage?: Storage;
  /** Optional attachment cache for persisting inbound file attachments to disk. */
  attachmentCache?: import('@ethosagent/types').AttachmentCache;
  /** STT provider registry for voice transcription. */
  sttProviderRegistry?: import('@ethosagent/types').SttProviderRegistry;
  /** Name of the STT provider (from auxiliary.asr.provider). */
  sttProviderName?: string;
  /** Config dict for the STT provider factory. */
  sttProviderConfig?: Record<string, unknown>;
  /** TTS provider registry for voice synthesis. */
  ttsProviderRegistry?: import('@ethosagent/types').TtsProviderRegistry;
  /** Name of the TTS provider (from auxiliary.tts.provider). */
  ttsProviderName?: string;
  /** Config dict for the TTS provider factory. */
  ttsProviderConfig?: Record<string, unknown>;
  /**
   * Secret-backed file resolver under `<dataDir>/secrets/`. Used by the
   * Communications tab to write Telegram / Slack / Discord / email
   * tokens through `${secrets:<ref>}` indirection — so secrets land in
   * `~/.ethos/secrets/` (the canonical location the CLI's setup wizard
   * also uses), not as plaintext inside `~/.ethos/config.yaml`.
   * Defaults to a FileSecretsResolver rooted at `<dataDir>/secrets`.
   */
  secrets?: SecretsResolver;
  /**
   * Bearer-token store backing the OpenAI-compat `/v1/*` surface and the
   * `/rpc/*` dual-auth path (cookie OR bearer). When omitted, `/v1/*` is
   * not mounted and `/rpc/*` uses cookie-only auth. Boot code typically
   * constructs `SqliteApiKeyStore` (from `@ethosagent/session-sqlite`)
   * against the same `sessions.db` file the session store uses.
   */
  apiKeys?: ApiKeyAdminStore;
  /**
   * Returns currently registered team names for `GET /v1/models`. Boot
   * code typically scans `<dataDir>/teams/*.yaml`. When omitted, the
   * models list reports only personalities + `ethos-default`.
   */
  listTeams?: () => Promise<string[]>;
  /** Optional title generation function. When provided, ChatService auto-titles new sessions after the first turn. */
  titleFn?: (systemPrompt: string, userMessage: string) => Promise<string>;
  /** Called on every completed chat turn — boot code wires the W4.1 funnel tracker here. */
  onTurnDone?: () => void;
  /** Tool registry for the tools.catalog RPC. */
  toolRegistry?: import('@ethosagent/types').ToolRegistry;
  /** Plugin loader for resolving plugin data-source paths (dashboard SQL queries). */
  pluginLoader?: import('@ethosagent/plugin-loader').PluginLoader;
  /** Path to the bundled system skills catalog directory. When set,
   *  SkillsLibrary surfaces read-only system skills alongside user
   *  skills. Omit when system skills are not available (e.g. tests). */
  catalogDir?: string;
  /**
   * McpManager instance for the MCP install flow. Boot code constructs
   * and `connect()`s it; the web-api delegates to `McpService` which
   * wraps `McpInstallFlow`. Omit when MCP is not part of this deployment
   * — `mcp.start` returns `discovery_failed` gracefully.
   */
  mcpManager?: McpManager;
  /**
   * Base URL of the web UI (e.g. `http://localhost:3000`). Used to build
   * the OAuth redirect URI for the MCP install flow. Defaults to
   * `http://localhost:3000` when omitted.
   */
  webBaseUrl?: string;
  /**
   * Setter from `CreateAgentLoopResult.setOnSkillProposed`. When provided,
   * `createWebApi` registers a callback that broadcasts an
   * `evolve.skill_pending` SSE event to all connected sessions whenever
   * the improvement fork proposes a new skill candidate.
   */
  setOnSkillProposed?: (fn: (skillId: string, personalityId: string) => void) => void;
  /**
   * Setter from `CreateAgentLoopResult.setOnSkillApplied`. When provided,
   * `createWebApi` registers a callback that broadcasts an
   * `evolve.skill_applied` SSE event to all connected sessions whenever
   * the improvement fork auto-promotes a skill to the live library.
   */
  setOnSkillApplied?: (fn: (skillId: string, personalityId: string) => void) => void;
  /**
   * Subscribe closure from `CreateAgentLoopResult.onMemoryCaptured` (memory-
   * experience §3.3). Present only when proactive capture is enabled. When
   * provided and `memoryNoticesEnabled !== false`, `createWebApi` registers a
   * listener that broadcasts a `memory.captured` SSE event to the capturing
   * session so the web UI can show a quiet "· remembered: …" toast — the same
   * live feedback the CLI already prints. Capture completes after the turn's
   * chat stream closes, so this is a push event, not an AgentEvent.
   */
  onMemoryCaptured?: (
    cb: (n: { sessionId: string; scopeId: string; summary: string }) => void,
  ) => () => void;
  /**
   * Secondary mute for the `memory.captured` broadcast, resolved from
   * `display.memory_notices` (default on). Capture itself is already gated
   * default-off by `memoryCapture.enabled`; this lets a user keep capture on
   * but silence the surfaced notice. Defaults to `true` when omitted.
   */
  memoryNoticesEnabled?: boolean;
  /** Notification router for delivering process completion alerts to web sessions via SSE. */
  notificationRouter?: import('@ethosagent/types').NotificationRouter;
  /**
   * Fired after the onboarding wizard durably writes config.yaml. Boot code
   * (onboarding-mode `ethos serve`) uses this to eagerly boot the real agent
   * loop so the tool catalog and plugins are live before the first chat.
   * Fire-and-forget — errors never fail the onboarding RPC.
   */
  onSetupComplete?: () => void;
  /**
   * Whether a Docker execution backend can be built in this process (F1). Pass
   * `false` from the desktop in-process backend (`disableDocker: true`) so the
   * character sheet honestly renders a `local` (un-sandboxed) posture instead
   * of claiming "Sandboxed · Docker" while execution actually runs on the host.
   * Defaults to `true`.
   */
  dockerBuildable?: boolean;
  /**
   * Lane 6 (D5) — compute the arithmetic model-fit verdict for a personality
   * id. Boot code passes a closure over wiring's `resolvePersonalityModelFit`
   * (it needs the tool registry + provider config the web-api never sees);
   * the `personalities.characterSheet` RPC threads the result into the SAME
   * `renderCharacterSheet` generator the CLI uses. Absent (onboarding mode,
   * tests, desktop) → the sheet renders without the `## Model fit` section.
   * Resolving to `null` (or throwing) degrades the same way.
   */
  modelFit?: (
    personalityId: string,
  ) => Promise<import('@ethosagent/personalities').CharacterSheetModelFit | null>;
  /**
   * tools-as-code-api Lane G — script-callable surface seam for the
   * `personalities.characterSheet` RPC. The provider computes it via
   * `scriptCallableFor()` from `@ethosagent/core` against the live tool
   * registry — the SAME derivation the ScriptToolBridge enforces. Absent or
   * resolving `null` → the sheet renders without the script-callable line.
   */
  scriptSurface?: (
    personalityId: string,
  ) => Promise<import('@ethosagent/personalities').CharacterSheetScriptSurface | null>;
  /**
   * Protocol route modules (A2A, Phase 3) contributed to the Hono app via the
   * explicit, reviewable seam. Each declares its mount path, auth posture, and
   * description; `enabled: false` skips it. Modules inherit the app-wide CORS +
   * error-envelope middleware but bring their own auth posture. See
   * {@link RouteModule}. serve.ts does not pass any yet — Phase 3 wires A2A here.
   */
  routeModules?: RouteModule[];
  /**
   * A2A peering service (from `@ethosagent/wiring`), built over the SAME
   * storage + baseDir as the A2A route modules so the UI/RPC and the live
   * `/a2a` handshake are one source of truth (plan §12). Consumed by the
   * peering RPC procedures wired in a later stage — threaded through here.
   */
  a2aPeering?: import('@ethosagent/wiring').A2aPeeringService;
  /**
   * Runtime A2A enable/disable control. `isEnabled` is the same predicate wired
   * into each A2A `RouteModule.enabledCheck` and the `a2a_send` tool; `setEnabled`
   * flips the live gate and persists to config. Consumed by the peering RPC
   * (later stage) — threaded through here.
   */
  a2aControl?: import('./routes/route-module').A2aControl;
  /**
   * Phase 0 — resolves the per-session context anatomy from observability.db
   * `llm_call` spans, backing `sessions.contextAnatomy` (the web Activity tab's
   * context panel). Boot code (serve) builds this over the shared
   * `SQLiteObservabilityStore`. Omitted → the RPC returns null and the panel
   * hides itself.
   */
  contextAnatomyFn?: (
    sessionId: string,
  ) => import('@ethosagent/web-contracts').ContextAnatomyWire | null;
}

export interface CreateWebApiResult {
  /** Hono app the boot script `serve()`s. */
  app: Hono;
  /**
   * The chat service the API constructed internally. Surface code that
   * needs to push out-of-band SSE events (e.g. the cron worker
   * broadcasting `cron.fired`) reaches in via `chatService.broadcastAll`.
   * Mutating session state here would skip the layered architecture —
   * keep the use to push-event fan-out only.
   */
  chatService: ChatService;
  /** System-level event bus for broadcasting real-time events (cron
   *  completions, platform status, session titles, health) to the
   *  desktop app via `GET /sse/system`. */
  systemBus: SystemEventBus;
}

export function createWebApi(opts: CreateWebApiOptions): CreateWebApiResult {
  const agentLoop: AgentLoop =
    opts.agentLoop ??
    ({
      run: async function* () {
        yield {
          type: 'error' as const,
          error: 'Setup required — complete onboarding first.',
          code: 'SETUP_REQUIRED',
        };
      },
    } as unknown as AgentLoop);

  // The composition root owns Storage construction; every repository/service
  // below receives this single instance (never a silent FsStorage fallback).
  const storage: Storage = opts.storage ?? new FsStorage();

  // --- Repositories (data access only) ---
  const tokens = new WebTokenRepository({ dataDir: opts.dataDir, storage });
  const sessionsRepo = new SessionsRepository(opts.sessionStore);
  const chatRepo = new ChatRepository(opts.sessionStore);
  const completionsRepo = new CompletionsRepository(opts.sessionStore);
  const configRepo = new ConfigRepository({ dataDir: opts.dataDir, storage });
  const allowlistRepo = new AllowlistRepository({ dataDir: opts.dataDir, storage });
  // Gap 11 — lazy getter so skills' `requires.tools` gates see the live
  // registry (including MCP/plugin tools registered after boot). Omitted
  // when no registry is wired: the tools gate is skipped, not failed.
  const skillsToolRegistry = opts.toolRegistry;
  const skillsLibrary = new SkillsLibrary({
    dataDir: opts.dataDir,
    storage,
    ...(opts.catalogDir ? { catalogDir: opts.catalogDir } : {}),
    ...(skillsToolRegistry
      ? { availableTools: () => new Set(skillsToolRegistry.getAvailable().map((t) => t.name)) }
      : {}),
  });
  const evolverRepo = new EvolverRepository({ dataDir: opts.dataDir, storage });
  // The mesh registry lives at ~/.ethos/meshes/default/registry.json —
  // the same path `ethos serve` writes to via meshRegistryPath('default').
  const mesh = new AgentMesh(defaultRegistryPath(), { storage });
  const memoryProvider = opts.memoryProvider;
  const secrets: SecretsResolver =
    opts.secrets ?? new FileSecretsResolver({ dir: join(opts.dataDir, 'secrets'), storage });
  const platformsRepo = new PlatformsRepository({
    config: configRepo,
    secrets,
    dataDir: opts.dataDir,
    storage,
  });

  const systemBus = new SystemEventBus();

  // --- Services (business logic) ---
  const sessionsService = new SessionsService({
    sessions: sessionsRepo,
    ...(opts.contextAnatomyFn ? { contextAnatomy: opts.contextAnatomyFn } : {}),
  });
  const sharedMcpJsonStore = new McpJsonStore(storage);
  const personalitiesService = new PersonalitiesService({
    personalities: opts.personalities,
    library: skillsLibrary,
    secrets,
    mcpJsonStore: sharedMcpJsonStore,
    ...(opts.personalitiesLlm ? { llm: opts.personalitiesLlm } : {}),
    sessions: opts.sessionStore,
    storage,
    dataDir: opts.dataDir,
    // Reload this process's web-api registry from disk before each read so a
    // personality dropped/edited on disk (by another process, or the loop's
    // create path) is visible in the Personalities tab without a restart.
    refresh: () => opts.personalities.loadFromDirectory(join(opts.dataDir, 'personalities')),
    ...(opts.dockerBuildable === false ? { dockerBuildable: false } : {}),
    ...(opts.modelFit ? { modelFit: opts.modelFit } : {}),
    ...(opts.scriptSurface ? { scriptSurface: opts.scriptSurface } : {}),
  });
  const configService = new ConfigService({ config: configRepo, secrets });
  const onboardingService = new OnboardingService({
    config: configRepo,
    personalities: opts.personalities,
    secrets,
    ...(opts.onSetupComplete ? { onSetupComplete: opts.onSetupComplete } : {}),
  });
  const approvalsService = new ApprovalsService({
    allowlist: allowlistRepo,
    ...(opts.approvalObservability ? { observability: opts.approvalObservability } : {}),
  });
  // Cron service degrades gracefully when no scheduler is provided —
  // tests and ACP-only deployments don't need it. Mutations throw a
  // clear error in that mode; reads return empty.
  const cronService = new CronService({
    scheduler: opts.cronScheduler ?? createPassiveScheduler(),
  });
  const skillsService = new SkillsService({ library: skillsLibrary });
  const evolverService = new EvolverService({ evolver: evolverRepo, library: skillsLibrary });
  const goalsService = new GoalsService({
    dataDir: opts.dataDir,
    sessionStore: opts.sessionStore,
    ...(opts.goalRunner ? { runner: opts.goalRunner } : {}),
  });
  const meshService = new MeshService({ mesh });
  const memoryService = new MemoryService({
    memory: memoryProvider,
    identityMap: opts.identityMap,
    // Timeline reads the same JSONL history the CLI does; restore writes through
    // a `restore`-labelled handle so the move records itself (§5).
    history: new HistoryStore({ dataDir: opts.dataDir, storage }),
    restoreMemory: createMemoryProvider({
      dataDir: opts.dataDir,
      storage,
      source: 'restore',
    }),
    // Approve-before-store queue (L3). Reads the same `memory-pending.jsonl`
    // the runtime gate writes and the CLI `ethos memory pending` drives; approve
    // replays through the provenance history under the original source, into
    // the configured backend when a selection is threaded through.
    pending: createPendingMemoryStore({
      dataDir: opts.dataDir,
      storage,
      ...(opts.memoryBackend ? { config: opts.memoryBackend } : {}),
    }).store,
  });
  const kanbanService = new KanbanService({ mesh });
  const tasksService = new TasksService(opts.jobStore ? { store: opts.jobStore } : {});
  const apiKeysService = new ApiKeysService(opts.apiKeys ?? null);
  // Phase 2 — global named-secrets vault + generic per-tool settings surface.
  const namedSecretsService = new NamedSecretsService({ secrets });
  const toolSettingsService = new ToolSettingsService({
    config: configRepo,
    personalities: personalitiesService,
    ...(opts.toolRegistry ? { toolRegistry: opts.toolRegistry } : {}),
  });
  const digestService = new DigestService({
    storage,
    dataDir: opts.dataDir,
    personalities: opts.personalities,
  });
  const voiceService = new VoiceService({
    sttRegistry: opts.sttProviderRegistry,
    providerName: opts.sttProviderName,
    providerConfig: opts.sttProviderConfig,
    secrets,
    configGetter: async () => {
      const raw = await configRepo.read();
      return raw
        ? {
            voiceProvider: raw.voiceProvider,
            voiceApiKey: raw.voiceApiKey,
            voiceBaseUrl: raw.voiceBaseUrl,
            voiceModel: raw.voiceModel,
            voiceTtsProvider: raw.voiceTtsProvider,
            voiceTtsApiKey: raw.voiceTtsApiKey,
            voiceTtsVoice: raw.voiceTtsVoice,
            voiceTtsBaseUrl: raw.voiceTtsBaseUrl,
            voiceTtsModel: raw.voiceTtsModel,
          }
        : null;
    },
    ttsRegistry: opts.ttsProviderRegistry,
    ttsProviderName: opts.ttsProviderName,
    ttsProviderConfig: opts.ttsProviderConfig,
  });
  const debugService = new DebugService({ sessionStore: opts.sessionStore, agentLoop });
  // Project-level plugins (`<cwd>/.ethos/plugins/`) are out of scope
  // for v1; user-level only is the standard install path. Threading
  // `workingDir` from boot would be the next step when we add it.
  const pluginsService = new PluginsService({ storage, dataDir: opts.dataDir });
  // MCP install flow — the service wraps McpInstallFlow (OAuth DCR dance)
  // and delegates personality attachment back through PersonalitiesService.
  // When mcpManager is omitted, a passive stub rejects mutations cleanly.
  const mcpService = new McpService({
    mcpManager: opts.mcpManager ?? createPassiveMcpManager(),
    personalityUpdater: {
      get: (id) => {
        const d = opts.personalities.describe(id);
        if (!d) return undefined;
        return { id: d.config.id, mcp_servers: d.config.mcp_servers };
      },
      update: (id, patch) => personalitiesService.update(id, patch),
    },
    secrets,
    mcpJsonStore: sharedMcpJsonStore,
    redirectUri: opts.webBaseUrl
      ? `${opts.webBaseUrl}/oauth/callback`
      : 'http://localhost:3000/oauth/callback',
  });
  const platformsService = new PlatformsService({ repo: platformsRepo });
  const labService = new LabService({ dataDir: opts.dataDir, loop: agentLoop, storage });
  // F3+F4 — drives `POST /v1/chat/completions`. Shares the AgentLoop with
  // the web chat surface so personality reloads + tool wiring reach both.
  const completionsService = new CompletionsService({
    loop: agentLoop,
    sessions: completionsRepo,
    defaults: opts.chatDefaults,
    ...(opts.refreshPersonalities ? { refreshPersonalities: opts.refreshPersonalities } : {}),
  });

  const dashboardsService = new DashboardsService({
    dbPath: join(opts.dataDir, 'dashboards.db'),
    pluginLoader: opts.pluginLoader,
  });

  // Share the DashboardsService's DB handle with DashboardStore so
  // agent-driven dashboard_create / dashboard_add_panel tools operate on
  // the same connection — no duplicate WAL handle.
  const dashboardStore = new DashboardStore(dashboardsService.getDb());

  // Register agent-driven dashboard tools when a tool registry is available.
  if (opts.toolRegistry) {
    for (const tool of buildDashboardTools(dashboardStore)) {
      opts.toolRegistry.register(tool);
    }
  }

  // One buffer per process — keyed internally by sessionId. Bridges are
  // owned by ChatService. The reap callback lets the bridge map drain
  // alongside the SSE buffer so a long-running server doesn't accumulate
  // an AgentBridge per session forever (memory leak otherwise).
  const buffer = new SessionStreamBuffer<SseEvent>();
  const chatService = new ChatService({
    loop: agentLoop,
    sessions: chatRepo,
    buffer,
    defaults: opts.chatDefaults,
    onForget: (sessionId) => approvalsService.cancelForSession(sessionId),
    ...(opts.titleFn ? { titleFn: opts.titleFn } : {}),
    ...(opts.onTurnDone ? { onTurnDone: opts.onTurnDone } : {}),
    systemBus,
    ...(opts.attachmentCache ? { attachmentCache: opts.attachmentCache } : {}),
    ...(opts.refreshPersonalities ? { refreshPersonalities: opts.refreshPersonalities } : {}),
  });
  buffer.onReap = (sessionId) => {
    chatService.forget(sessionId);
  };

  // Register web notification adapter — delivers process/plugin notifications
  // (router keyed by sessionKey) to the session's SSE stream as a
  // `notification` event. The `session_start` hook is the one place both
  // `sessionId` (what the SSE buffer is keyed by) and `sessionKey` (what the
  // router routes by) are known. Deregistration piggybacks on the buffer's
  // onReap (which already drives chatService.forget).
  if (opts.notificationRouter && opts.agentLoop) {
    const router = opts.notificationRouter;
    const sessionKeysById = new Map<string, string>();
    agentLoop.hooks.registerVoid('session_start', async (payload) => {
      sessionKeysById.set(payload.sessionId, payload.sessionKey);
      router.register(payload.sessionKey, {
        send: async (message: string) => {
          chatService.broadcast(payload.sessionId, { type: 'notification', message });
        },
        injectUserMessage: async (message: string) => {
          // Input injection isn't supported on the web surface — surface the
          // message as a notification instead of dropping it.
          chatService.broadcast(payload.sessionId, { type: 'notification', message });
        },
      });
    });
    const originalOnReap = buffer.onReap;
    buffer.onReap = (sessionId: string) => {
      const sessionKey = sessionKeysById.get(sessionId);
      if (sessionKey !== undefined) {
        router.deregister(sessionKey);
        sessionKeysById.delete(sessionId);
      }
      originalOnReap?.(sessionId);
    };
  }

  // Bridge approvals → SSE. The hook fires when the agent reaches a
  // dangerous tool call; the resolved event lets every tab on the same
  // session auto-dismiss the modal once any one of them decides.
  approvalsService.onPending((sessionId, request) => {
    chatService.broadcast(sessionId, { type: 'tool.approval_required', request });
  });
  approvalsService.onResolved((sessionId, approvalId, decision, decidedBy) => {
    chatService.broadcast(sessionId, {
      type: 'approval.resolved',
      approvalId,
      decision,
      decidedBy,
    });
  });

  // Bridge clarify → SSE. The `clarify` tool registers a pending request on
  // the loop's ClarifyBridge; present it to the browser over the same SSE
  // channel approvals use, and broadcast the resolution so the card collapses
  // on every tab. A boot sweep clears rows that expired while the process
  // was down.
  const clarifyBridge = agentLoop.clarifyBridge;
  if (clarifyBridge) {
    clarifyBridge.setPresenter((req) => {
      chatService.broadcast(req.sessionId, {
        type: 'clarify.request',
        requestId: req.requestId,
        question: req.question,
        ...(req.options ? { options: req.options } : {}),
        ...(req.default !== undefined ? { default: req.default } : {}),
        defaultDeadlineAt: req.defaultDeadlineAt,
      });
    });
    clarifyBridge.onResolved((row, response) => {
      chatService.broadcast(row.sessionId, {
        type: 'clarify.resolved',
        requestId: row.requestId,
        source: response?.source ?? 'timeout-no-default',
      });
    });
    void clarifyBridge.sweep();
  }

  // E3 — improvement fork SSE. When the wiring layer's setOnSkillProposed
  // setter is threaded through, register a callback that broadcasts an
  // `evolve.skill_pending` push event to every connected session. The web
  // UI picks this up to surface the review-queue badge.
  opts.setOnSkillProposed?.((skillId, personalityId) => {
    chatService.broadcastAll({
      type: 'evolve.skill_pending',
      skillId,
      personalityId,
      proposedAt: new Date().toISOString(),
    });
  });

  opts.setOnSkillApplied?.((skillId, personalityId) => {
    chatService.broadcastAll({
      type: 'evolve.skill_applied',
      skillId,
      personalityId,
      appliedAt: new Date().toISOString(),
    });
  });

  // memory-experience §3.3 — proactive-capture notice. Capture runs AFTER the
  // turn's chat stream closes (queued post-`done`), so it can't ride the turn
  // SSE as an AgentEvent — broadcast it as its own push event, scoped to the
  // capturing session. Gated by `display.memory_notices` (default on).
  if (opts.onMemoryCaptured && opts.memoryNoticesEnabled !== false) {
    opts.onMemoryCaptured((n) => {
      chatService.broadcast(n.sessionId, { type: 'memory.captured', summary: n.summary });
    });
  }

  // Register the web `before_tool_call` hook on the loop. CLI/TUI/ACP
  // profiles get the synchronous terminal guard from `@ethosagent/wiring`;
  // the web profile skips that registration so this hook is the sole
  // gatekeeper for dangerous calls. Without a predicate (e.g. tests) every
  // tool call passes through unattended.
  if (opts.dangerPredicate) {
    agentLoop.hooks.registerModifying(
      'before_tool_call',
      createWebApprovalHook({
        approvals: approvalsService,
        isDangerous: opts.dangerPredicate,
      }),
    );
  }

  const app = createRoutes({
    tokens,
    services: {
      sessions: sessionsService,
      chat: chatService,
      personalities: personalitiesService,
      config: configService,
      onboarding: onboardingService,
      approvals: approvalsService,
      ...(clarifyBridge ? { clarifyBridge } : {}),
      cron: cronService,
      skills: skillsService,
      evolver: evolverService,
      goals: goalsService,
      mesh: meshService,
      memory: memoryService,
      plugins: pluginsService,
      mcp: mcpService,
      platforms: platformsService,
      lab: labService,
      kanban: kanbanService,
      tasks: tasksService,
      completions: completionsService,
      debug: debugService,
      apiKeys: apiKeysService,
      digest: digestService,
      namedSecrets: namedSecretsService,
      toolSettings: toolSettingsService,
      voice: voiceService,
      toolRegistry: opts.toolRegistry,
      dashboards: dashboardsService,
      pluginLoader: opts.pluginLoader,
      agentLoop,
      systemBus,
      ...(opts.a2aPeering ? { a2aPeering: opts.a2aPeering } : {}),
      ...(opts.a2aControl ? { a2aControl: opts.a2aControl } : {}),
    },
    ...(opts.allowedOrigins ? { allowedOrigins: opts.allowedOrigins } : {}),
    ...(opts.secureCookie !== undefined ? { secureCookie: opts.secureCookie } : {}),
    ...(opts.trustProxy !== undefined ? { trustProxy: opts.trustProxy } : {}),
    ...(opts.webDist ? { webDist: opts.webDist } : {}),
    ...(opts.apiKeys ? { apiKeys: opts.apiKeys } : {}),
    ...(opts.listTeams ? { listTeams: opts.listTeams } : {}),
    ...(opts.webBaseUrl ? { webBaseUrl: opts.webBaseUrl } : {}),
    ...(opts.routeModules ? { routeModules: opts.routeModules } : {}),
    storage,
    secrets,
  });

  // Dashboard panel refresh — driven by the cron extension's schedule engine
  // via the extension-owned scheduler (replaces the old hand-rolled `isCronDue`
  // + `setInterval` poller). Each prompt refresh runs as an ephemeral session
  // (the throwaway chat session is GC'd via the shared session store).
  if (opts.agentLoop) {
    new DashboardRefreshScheduler({
      dashboards: dashboardsService,
      agentLoop: opts.agentLoop,
      pluginLoader: opts.pluginLoader,
      sessions: opts.sessionStore,
    }).start();
  }

  return { app, chatService, systemBus };
}

/**
 * Stand-in for the CronScheduler when no real one is wired (e.g. tests,
 * ACP-only deployments). File-backed reads still work via the
 * scheduler's own `listJobs`/`getJob`; writes/runs throw a clear error
 * so the surface can render an actionable message.
 */
function createPassiveScheduler(): CronScheduler {
  const notConfigured = () => {
    throw new Error('Cron scheduler not configured for this server.');
  };
  return {
    listJobs: async () => [],
    getJob: async () => null,
    createJob: async () => notConfigured(),
    deleteJob: async () => notConfigured(),
    pauseJob: async () => notConfigured(),
    resumeJob: async () => notConfigured(),
    runJobNow: async () => notConfigured(),
    listRuns: async () => [],
    readRunOutput: async () => notConfigured(),
    start: () => {},
    stop: () => {},
  } as unknown as CronScheduler;
}

/**
 * Stand-in for the McpManager when no real one is wired (e.g. tests,
 * deployments where MCP isn't configured). addServer and removeServer
 * throw a clear error; listServers returns empty.
 */
function createPassiveMcpManager(): McpManager {
  const notConfigured = () => {
    throw new Error('McpManager not configured for this server.');
  };
  return {
    connect: async () => {},
    disconnect: async () => {},
    shutdown: async () => {},
    getTools: () => [],
    getToolsForPersonality: async () => [],
    listServers: () => [],
    addServer: async () => {},
    removeServer: async () => notConfigured(),
    invalidatePersonalityClients: () => {},
    reconnectPersonality: async () => {},
  } as unknown as McpManager;
}

export { type ChatDefaults, ChatService } from './features/chat/service';
// Re-exports so boot code can read tokens / inspect contract surfaces directly.
export { WebTokenRepository } from './repositories/web-token.repository';
export type { RouteModule } from './routes/route-module';
export { setWhatsAppPairingCode, setWhatsAppQr } from './routes/setup-whatsapp';
export type { DangerPredicate, DangerReason } from './services/approval-hook';
