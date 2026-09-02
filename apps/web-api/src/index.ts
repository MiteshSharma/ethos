import { join } from 'node:path';
import { SessionStreamBuffer } from '@ethosagent/agent-bridge';
import { AgentMesh, defaultRegistryPath } from '@ethosagent/agent-mesh';
import { resolveSecretRef, type VoiceBargeInTuning } from '@ethosagent/config';
import { type AgentLoop, satelliteLaneKey } from '@ethosagent/core';
import type { CronScheduler } from '@ethosagent/cron';
import {
  DashboardRefreshScheduler,
  DashboardStore,
  DashboardsService,
} from '@ethosagent/dashboard';
import type { GoalRunner } from '@ethosagent/goal-runner';
import { ConsoleLogger } from '@ethosagent/logger';
import type { FilePersonalityRegistry } from '@ethosagent/personalities';
import { SQLiteCardStore } from '@ethosagent/session-cards';
import { type SkillsInjector, SkillsLibrary } from '@ethosagent/skills';
import { FileSecretsResolver, FsStorage } from '@ethosagent/storage-fs';
import { McpJsonStore, type McpManager } from '@ethosagent/tools-mcp';
import { buildDashboardTools } from '@ethosagent/tools-ui';
import type {
  BackgroundJob,
  JobRunnerRegistry,
  JobStore,
  MemoryProvider,
  RunUpdateDigest,
  SecretsResolver,
  SessionStore,
  Storage,
} from '@ethosagent/types';
import type { ActivityEvent, SseEvent } from '@ethosagent/web-contracts';
import {
  createMemoryProvider,
  createPendingMemoryStore,
  HistoryStore,
  type IdentityMap,
  type MemoryBackendSelection,
} from '@ethosagent/wiring';
import type { Hono } from 'hono';
import { formatRunHandBack } from './features/chat/handback';
import { resolveJobSessionId } from './features/chat/job-session';
import { ChatRepository } from './features/chat/repository';
import { type ChatDefaults, ChatService } from './features/chat/service';
import { CompletionsRepository } from './features/completions/repository';
import { CompletionsService } from './features/completions/service';
import { DebugService } from './features/debug/service';
import { SessionsRepository } from './features/sessions/repository';
import { SessionsService } from './features/sessions/service';
import { AUTH_COOKIE } from './middleware/auth';
import type { ApiKeyAdminStore } from './middleware/bearer-auth';
import { AllowlistRepository } from './repositories/allowlist.repository';
import {
  ConfigRepository,
  parseRealtimeRoster,
  parseSttRoster,
  parseTtsRoster,
  parseWakeRouting,
} from './repositories/config.repository';
import { EvolverRepository } from './repositories/evolver.repository';
import { PlatformsRepository } from './repositories/platforms.repository';
import { WebTokenRepository } from './repositories/web-token.repository';
import { createRoutes } from './routes';
import { documentsRoutes } from './routes/documents';
import { personalityAvatarRoutes } from './routes/personality-avatar';
import type { RouteModule } from './routes/route-module';
import { ApiKeysService } from './services/api-keys.service';
import { createWebApprovalHook, type DangerPredicate } from './services/approval-hook';
import { type ApprovalObservability, ApprovalsService } from './services/approvals.service';
import { CallsService } from './services/calls.service';
import { ConfigService, readLegacyBrowserBargeInTuning } from './services/config.service';
import { CronService } from './services/cron.service';
import { DeliveriesService } from './services/deliveries.service';
import { DigestService } from './services/digest.service';
import { DocumentsService } from './services/documents.service';
import { EvolverService } from './services/evolver.service';
import { GoalsService } from './services/goals.service';
import { KanbanService } from './services/kanban.service';
import { KeysService } from './services/keys.service';
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
import { VoiceLaneModeService } from './services/voice-lane-mode.service';
import { WakeRoutesService } from './services/wake-routes.service';
import { createBrowserVoiceSessionOpener } from './voice/browser-voice-session';
import { withImplicitWakeRoutes } from './voice/implicit-wake-routes';
import { createRealtimeControlDeps } from './voice/realtime-control-deps';
import { createRealtimeSurface } from './voice/realtime-surface';
import type { SatelliteObservability } from './voice/satellite-lane';
import { SatelliteRegistry } from './voice/satellite-registry';
import { createSatelliteSocket, type SatelliteSocket } from './voice/satellite-socket';
import { createVoiceSocket, readCookie, type VoiceSocket } from './voice/voice-socket';
import { isPrivilegedPersonality } from './voice/wake-privilege';

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
  /** Phase E of plan/phases/model-visible-logged.md — when provided, session
   *  fork copies the source's context events onto the child (D9) so
   *  resolveContextAt on the fork still reproduces what the parent saw.
   *  Optional: absent in onboarding/stub mode and in tests that don't need it —
   *  fork() then silently skips the copy (today's behavior). */
  contextLog?: import('./features/sessions/repository').ForkableContextLog;
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
  /**
   * Resolved job runners from wiring, so the Tasks detail RPC can ask the runner
   * that executed a row for its own detail-grid rows (`JobRunner.describe`,
   * pi-delegation D18). Absent → the grid renders its 12 shared rows and nothing
   * else, which is a valid card.
   */
  jobRunners?: JobRunnerRegistry;
  /**
   * Subscribe to the executor's coalesced run digest (pi-delegation G9/D11/D20).
   * Wired by the surface that owns the `BackgroundExecutor`. Each digest is
   * routed to its PARENT session's SSE stream as a `run.update` push event —
   * without it a run card renders once and freezes, because the run's own events
   * fire on `childSessionKey`, which nobody watching the parent chat subscribes
   * to. Absent → no digest, and the card is fed by polling nothing.
   */
  subscribeRunUpdates?: (handler: (update: RunUpdateDigest) => void) => void;
  /**
   * Subscribe to terminal job transitions (`BackgroundExecutor.onComplete`) so
   * the run's result lands as a message in the parent conversation, from Ethos
   * (§4.9/D27). Deliberately the EXISTING complete path — not a new bus.
   */
  subscribeJobComplete?: (handler: (job: BackgroundJob) => void) => void;
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
  /** The live `SkillsInjector` from wiring's `CreateAgentLoopResult`. Backs
   *  `personalities.renderers` — the derivation of a personality's declared
   *  renderer capabilities from its resolved skill set. Reusing the loop's
   *  instance (rather than constructing a second one) keeps one scanner and one
   *  mtime cache per process. Absent → `personalities.renderers` returns `[]`
   *  and every fenced block stays a code block. */
  skillsInjector?: SkillsInjector;
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
   * Auto-deny window for a pending approval, in ms. Omitted → the
   * `ApprovalsService` default (10 minutes); `0` disables the timeout so a
   * call waits forever. Boot code sources it from `config.approvalTimeoutMs`.
   */
  approvalTimeoutMs?: number;
  /**
   * Sink for wake-satellite lane events (`satellite.*`) — today, the turn that
   * ran without speaking because the node declared no loudspeaker. Boot code
   * passes wiring's `EthosObservability`. Omitted (tests) → no rows.
   */
  satelliteObservability?: SatelliteObservability;
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
  /** Realtime (speech-to-speech) registry — backs `voice.realtimeToken`. */
  realtimeProviderRegistry?: import('@ethosagent/types').RealtimeVoiceProviderRegistry;
  /** Boot snapshot of `voice.realtime.providers.*`; live config wins over it. */
  realtimeRoster?: Record<string, import('@ethosagent/types').RealtimeProviderEntry>;
  /** Boot snapshot of `voice.realtime.default`. */
  realtimeDefault?: string;
  /** Boot snapshot of `voice.tier`. */
  voiceTier?: 'pipeline' | 'realtime';
  /**
   * Boot snapshot of `voice.defaultMode` — where a conversation with no
   * explicit mode starts. Reported by `voice.laneMode.get` as `default` so the
   * chat header can say "inheriting" rather than showing an invented choice.
   * Absent → `mirror_inbound`, the same fallback the gateway takes.
   */
  voiceDefaultMode?: import('@ethosagent/types').VoiceMode;
  /**
   * Boot snapshot of `voice.realtime.sessionBudgetUsd` — the cap on ONE
   * realtime call. Live config still wins; this is what keeps the cap alive on
   * a surface with no live-config read, which used to be silently uncapped.
   */
  realtimeSessionBudgetUsd?: number;
  /**
   * The deployment's voice span writer (`VoiceStack.spans`). Realtime turns
   * record their per-turn latency into it, so both tiers' spans land in one
   * buffer and one sink. Omit → realtime turns write no spans.
   */
  voiceSpans?: import('@ethosagent/voice-session').VoiceSpanRecorder;
  /**
   * The deployment's voice stack (`@ethosagent/wiring`'s `buildVoiceStack()`
   * result). Its `createSession()` is what the browser PIPELINE lane's
   * `VoiceSession` is built from — the same factory the SIP/LiveKit lanes
   * use. Absent (no `voice.*` configured) → the pipeline lane still
   * handshakes but refuses `audio` frames with a clear error instead of
   * silently doing nothing; realtime-tier calls are unaffected either way.
   */
  voiceStack?: import('@ethosagent/wiring').VoiceStack;
  /** Name of the STT provider (from auxiliary.asr.provider). */
  sttProviderName?: string;
  /** Config dict for the STT provider factory. */
  sttProviderConfig?: Record<string, unknown>;
  /**
   * Named STT roster (`voice.stt.providers.*`), keyed by the operator's label.
   * A personality's `voice.stt_provider` picks one; an absent or unknown name
   * falls back to the `sttProviderName`/`sttProviderConfig` default above.
   */
  sttRoster?: Readonly<Record<string, import('@ethosagent/types').SttProviderEntry>>;
  /** TTS provider registry for voice synthesis. */
  ttsProviderRegistry?: import('@ethosagent/types').TtsProviderRegistry;
  /** Name of the TTS provider (from auxiliary.tts.provider). */
  ttsProviderName?: string;
  /** Config dict for the TTS provider factory. */
  ttsProviderConfig?: Record<string, unknown>;
  /**
   * Named TTS roster (`voice.tts.providers.*`), keyed by the operator's label.
   * A personality's `voice.tts_provider` picks one; an absent or unknown name
   * falls back to the `ttsProviderName`/`ttsProviderConfig` default above.
   */
  ttsRoster?: Readonly<Record<string, import('@ethosagent/types').TtsProviderEntry>>;
  /**
   * Local-only voice-egress allowlist (`voice.trustedPlugins`). Passed through
   * to VoiceService so a non-local provider selected here — including one
   * chosen live in Settings — is refused before any audio leaves the machine.
   * Undefined leaves the gate off.
   */
  trustedVoicePlugins?: ReadonlySet<string>;
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
  /**
   * SQLite-backed idempotency cache for `POST /v1/chat/completions`. When
   * provided, a request carrying an `Idempotency-Key` header is cached and
   * replayed on retry instead of re-driving the agent loop. Boot code
   * typically constructs `IdempotencyStore` against the same `sessions.db`
   * file the session store uses. Omitted → no idempotency support.
   */
  idempotencyStore?: import('./stores/idempotency-store').IdempotencyStore;
  /**
   * Comma-separated CORS origins or `*` for the `/v1/*` OpenAI-compat
   * surface. Defaults to the `ETHOS_API_CORS_ORIGINS` env var when unset.
   */
  corsOrigins?: string;
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
   * §4.7 — declared-reach seam for the `## Boundary` section of the
   * `personalities.characterSheet` RPC. The provider computes it via
   * `toolsDeclaringNetwork()` from `@ethosagent/core` against the live tool
   * registry — the SAME `capabilities` declaration G-CAP intersects per call.
   * Absent or resolving `null` → the section still renders, it just never
   * reports a guarantee as inapplicable for reach it cannot see.
   */
  boundary?: (
    personalityId: string,
  ) => Promise<import('@ethosagent/personalities').CharacterSheetBoundary | null>;
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
  /**
   * Reads the merged durable activity feed from observability.db (tool/LLM
   * spans, turn traces, events), backing `activity.history`. Boot code (serve)
   * builds this over the same shared `SQLiteObservabilityStore` as
   * `contextAnatomyFn`. Omitted → the RPC returns an empty page.
   */
  activityHistoryFn?: import('./routes/index').ActivityHistoryFn;
  /**
   * P2-counters (D2/D16) — renders the OpenMetrics text `GET /metrics` (scope
   * `metrics:read`) serves. Boot code builds this via
   * `createMetricsTextProvider` over the shared `SQLiteObservabilityStore`,
   * ONCE, so its 5s TTL cache is shared across requests. Omitted → `/metrics`
   * is not mounted.
   */
  metricsTextFn?: () => Promise<string>;
  /**
   * P2-counters (D2) — records one `ethos_http_requests_total` increment per
   * request, method + status code labeled. Boot code builds this over the
   * shared `SQLiteObservabilityStore`. Omitted → requests are simply not
   * counted (no `/metrics` family, no behavior change).
   */
  recordHttpRequest?: (method: string, status: number) => void;
  /** External cron trigger (plan/phases/cron-scheduler-seam.md) — mounts
   *  `POST /cron/fire` (bearer auth, scope `cron`) when present. No config
   *  gates it — `ethos serve` / `ethos boot` always supply an
   *  `HttpFireTrigger`. Optional so embedders (and this package's own tests)
   *  can build an app without one; omitted → `/cron/fire` is not mounted. */
  cronFireTrigger?: import('./routes/cron').CronFireTrigger;
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
  /**
   * The binary voice lane for browser talk-mode. Boot code calls
   * `voiceSocket.attach(server)` on the listening HTTP server to serve
   * `GET /voice/ws`; skipping the call simply leaves the lane unmounted and
   * talk-mode falls back to the batch RPC path.
   */
  voiceSocket: VoiceSocket;
  /**
   * The wake-satellite lane. Boot code calls `satelliteSocket.attach(server)`
   * on the same listening server the voice lane is attached to — the two share
   * one upgrade router, so the order does not matter. Skipping the call leaves
   * `GET /satellite/ws` unmounted and no satellite can connect.
   */
  satelliteSocket: SatelliteSocket;
  /**
   * Force-settle every pending tool approval as a deny (audited). Boot code
   * calls this from its shutdown `cleanup()` closure before `process.exit`:
   * the auto-deny timers are `unref`'d, so without this a graceful restart
   * abandons every suspended hook with no audit row.
   */
  forceSettleApprovals: () => void;
  /**
   * How many tool approvals are still awaiting a human decision. Read by the
   * idle watcher's `web-approvals` busy source: a suspended approval is
   * in-flight work, and suspending the VM on one loses it silently
   * (plan/phases/idle-watcher.md §1 check #12).
   */
  pendingApprovalCount: () => number;
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

  const secrets: SecretsResolver =
    opts.secrets ?? new FileSecretsResolver({ dir: join(opts.dataDir, 'secrets'), storage });

  // --- Repositories (data access only) ---
  const tokens = new WebTokenRepository({ dataDir: opts.dataDir, storage });
  const sessionsRepo = new SessionsRepository(opts.sessionStore, opts.contextLog);
  const chatRepo = new ChatRepository(opts.sessionStore);
  const completionsRepo = new CompletionsRepository(opts.sessionStore);
  const configRepo = new ConfigRepository({ dataDir: opts.dataDir, storage, secrets });
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
  const platformsRepo = new PlatformsRepository({
    config: configRepo,
    secrets,
    dataDir: opts.dataDir,
    storage,
  });

  const systemBus = new SystemEventBus();

  // --- Services (business logic) ---
  // Typed UI cards get their own database, not a column on the STRICT
  // `messages` table: the envelopes are a rendering concern with their own
  // version, and the LLM history has no use for them.
  const cardStore = new SQLiteCardStore(join(opts.dataDir, 'cards.db'), {
    logger: new ConsoleLogger({ component: 'cards' }),
  });
  const sessionsService = new SessionsService({
    sessions: sessionsRepo,
    cards: cardStore,
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
    ...(opts.skillsInjector ? { skillsInjector: opts.skillsInjector } : {}),
    ...(opts.refreshPersonalities ? { refreshLoopPersonalities: opts.refreshPersonalities } : {}),
    ...(opts.dockerBuildable === false ? { dockerBuildable: false } : {}),
    ...(opts.modelFit ? { modelFit: opts.modelFit } : {}),
    ...(opts.scriptSurface ? { scriptSurface: opts.scriptSurface } : {}),
    ...(opts.boundary ? { boundary: opts.boundary } : {}),
  });
  // Connected wake satellites. Constructed BEFORE `ConfigService` because the
  // Settings write path pushes to it: eng-review D5 makes a Settings save the
  // moment a route change reaches the microphones in the house. A hand-edited
  // `config.yaml` applies on the next satellite reconnect or restart instead —
  // nothing watches the file, which is documented behaviour, not a bug.
  //
  // The table is the CONFIGURED routes plus the implicit `hey <name>` default
  // every unprivileged personality answers to. Assembled here, once, so the
  // pushed `routes` frame, the lane's wake re-resolution and the Settings editor
  // cannot disagree — and the personality registry is reloaded first so a
  // personality dropped on disk gets its name back on the next table read.
  const satelliteRegistry = new SatelliteRegistry({
    readTable: async () => {
      const table = parseWakeRouting((await configRepo.read())?.passthrough ?? {});
      await opts.personalities.loadFromDirectory(join(opts.dataDir, 'personalities'));
      return withImplicitWakeRoutes(table, opts.personalities.list());
    },
  });
  const configService = new ConfigService({
    config: configRepo,
    secrets,
    // Only used to refuse a `voice.bots[]` entry bound to a personality that
    // does not exist — a phone number that rings through to nothing.
    personalities: personalitiesService,
    onUpdated: () => satelliteRegistry.refreshRoutes(),
  });
  const onboardingService = new OnboardingService({
    config: configRepo,
    personalities: opts.personalities,
    secrets,
    ...(opts.onSetupComplete ? { onSetupComplete: opts.onSetupComplete } : {}),
  });
  const approvalsService = new ApprovalsService({
    allowlist: allowlistRepo,
    // `!== undefined`, not truthiness — `0` ("no timeout") must be threadable.
    ...(opts.approvalTimeoutMs !== undefined ? { timeoutMs: opts.approvalTimeoutMs } : {}),
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
  const kanbanService = new KanbanService({ mesh, hooks: agentLoop.hooks });
  const tasksService = new TasksService(opts.jobStore ? { store: opts.jobStore } : {});
  const apiKeysService = new ApiKeysService(opts.apiKeys ?? null);
  // Phase 2 — global named-secrets vault + generic per-tool settings surface.
  const namedSecretsService = new NamedSecretsService({ secrets });
  // Keys pane — the whole vault, masked, partitioned by the static catalog.
  const keysService = new KeysService({ secrets, namedSecrets: namedSecretsService });
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
  const documentsService = new DocumentsService({
    personalities: opts.personalities,
    dataDir: opts.dataDir,
    storage,
    // Same hot-reload seam the Personalities tab uses — a workdir declaration
    // edited on disk takes effect on the next listing, without a restart.
    refresh: () => opts.personalities.loadFromDirectory(join(opts.dataDir, 'personalities')),
  });
  // Durable per-conversation voice mode. Constructed once (the store caches the
  // parsed document) and shares `<dataDir>/voice/lane-modes.json` with the
  // gateway's channel lanes, so a mode is one fact across surfaces.
  const voiceLaneModeService = new VoiceLaneModeService({
    storage,
    dataDir: opts.dataDir,
    ...(opts.voiceDefaultMode ? { defaultMode: opts.voiceDefaultMode } : {}),
  });
  // Read-only ledger view. Opens nothing until first asked, and nothing at all
  // when the gateway has never run here.
  const deliveriesService = new DeliveriesService({ dataDir: opts.dataDir, storage });
  // Read-only telephony call history, `<dataDir>/calls.db` — the same file the
  // gateway writes. Same lazy-open rule as the ledger above: a deployment with
  // no telephony never grows the database by opening a Settings page.
  const callsService = new CallsService({ dataDir: opts.dataDir, storage });
  const voiceService = new VoiceService({
    sttRegistry: opts.sttProviderRegistry,
    providerName: opts.sttProviderName,
    providerConfig: opts.sttProviderConfig,
    secrets,
    configGetter: async () => {
      const raw = await configRepo.read();
      // Keys are stored as `${secrets:<ref>}` (G-SEC) — resolve before the
      // value reaches a provider factory, which expects a usable key.
      const resolveKey = async (v: string | undefined): Promise<string | undefined> =>
        v ? await resolveSecretRef(v, secrets) : v;
      if (!raw) return null;
      // The rosters are edited from Settings → Voice, so they are read live
      // here rather than trusted from the boot snapshot: an entry added a
      // minute ago must be selectable and previewable without a restart.
      const resolveRoster = async <E extends { apiKey?: string }>(
        roster: Record<string, E>,
      ): Promise<Record<string, E>> => {
        const out: Record<string, E> = {};
        for (const [name, entry] of Object.entries(roster)) {
          const apiKey = await resolveKey(entry.apiKey);
          out[name] = apiKey === undefined ? entry : { ...entry, apiKey };
        }
        return out;
      };
      const ttsRoster = await resolveRoster(parseTtsRoster(raw.passthrough));
      const sttRoster = await resolveRoster(parseSttRoster(raw.passthrough));
      const realtimeRoster = await resolveRoster(parseRealtimeRoster(raw.passthrough));
      const tier = raw.passthrough['voice.tier'];
      const rawBudget = Number(raw.passthrough['voice.realtime.sessionBudgetUsd']);
      const budgetUsd = Number.isFinite(rawBudget) && rawBudget > 0 ? rawBudget : null;
      return {
        voiceProvider: raw.voiceProvider,
        voiceApiKey: await resolveKey(raw.voiceApiKey),
        voiceBaseUrl: raw.voiceBaseUrl,
        voiceModel: raw.voiceModel,
        voiceTtsProvider: raw.voiceTtsProvider,
        voiceTtsApiKey: await resolveKey(raw.voiceTtsApiKey),
        voiceTtsVoice: raw.voiceTtsVoice,
        voiceTtsBaseUrl: raw.voiceTtsBaseUrl,
        voiceTtsModel: raw.voiceTtsModel,
        ...(Object.keys(ttsRoster).length > 0 ? { voiceTtsProviders: ttsRoster } : {}),
        ...(Object.keys(sttRoster).length > 0 ? { voiceSttProviders: sttRoster } : {}),
        ...(Object.keys(realtimeRoster).length > 0
          ? { voiceRealtimeProviders: realtimeRoster }
          : {}),
        voiceRealtimeDefault: raw.passthrough['voice.realtime.default'] ?? null,
        voiceTier: tier === 'pipeline' || tier === 'realtime' ? tier : null,
        // The cap on ONE realtime session, read live for the same reason the
        // roster is: it is edited in Settings → Voice, and an operator who has
        // just lowered it means the next call, not the next restart.
        voiceRealtimeSessionBudgetUsd: budgetUsd,
      };
    },
    ...(opts.sttRoster ? { sttRoster: opts.sttRoster } : {}),
    ttsRegistry: opts.ttsProviderRegistry,
    ttsProviderName: opts.ttsProviderName,
    ttsProviderConfig: opts.ttsProviderConfig,
    ...(opts.ttsRoster ? { ttsRoster: opts.ttsRoster } : {}),
    // Realtime (speech-to-speech) tier. The registry is injected; the roster,
    // its default entry and the tier default are read LIVE above, so a realtime
    // provider added in Settings is mintable on the next call.
    ...(opts.realtimeProviderRegistry ? { realtimeRegistry: opts.realtimeProviderRegistry } : {}),
    ...(opts.realtimeRoster ? { realtimeRoster: opts.realtimeRoster } : {}),
    ...(opts.realtimeDefault ? { realtimeDefault: opts.realtimeDefault } : {}),
    ...(opts.voiceTier ? { tier: opts.voiceTier } : {}),
    // The typed cap, from `EthosConfig.voice.realtime.sessionBudgetUsd`. Live
    // config still wins; this is the route that does not depend on the live
    // read existing.
    ...(opts.realtimeSessionBudgetUsd !== undefined
      ? { realtimeSessionBudgetUsd: opts.realtimeSessionBudgetUsd }
      : {}),
    ...(opts.trustedVoicePlugins ? { trustedVoicePlugins: opts.trustedVoicePlugins } : {}),
    // Per-personality voice on the browser path: the same registry the
    // Personalities tab refreshes, so an edited `voice.tts_voice` is heard on
    // the next spoken reply without a restart.
    personalities: opts.personalities,
    // Who a realtime session is (SOUL.md + the consult boundary policy) and
    // what it may call (generated from the wired tool registry). Baked into
    // the ephemeral credential at mint: a live session is configured once.
    realtimeSurface: createRealtimeSurface({
      storage,
      ...(opts.toolRegistry ? { toolRegistry: opts.toolRegistry } : {}),
      personalities: opts.personalities,
      ...(opts.refreshPersonalities ? { refresh: opts.refreshPersonalities } : {}),
    }),
  });
  // `display.voice_*` compatibility read-through for the browser lane's
  // barge-in tuning (Conflict 2, L1 — plan §7). Read live, the same reason the
  // voice rosters in `voiceService`'s `configGetter` above are: an operator
  // who just changed Settings → Voice → Advanced means the next call, not the
  // next restart. `voiceStack.createSession` only applies this when
  // `voice.bargeIn.browser` is unset.
  const legacyBargeInTuning = async (): Promise<VoiceBargeInTuning> => {
    const raw = await configRepo.read();
    return raw ? readLegacyBrowserBargeInTuning(raw.passthrough) : {};
  };
  // The persistent binary voice lane (talk-mode). Constructed here so it shares
  // this process's VoiceService — same provider resolution, same egress gate as
  // the batch RPCs — but it only carries traffic once boot code attaches it to
  // the listening HTTP server (`voiceSocket.attach(server)`).
  const realtimeControlRegistry = opts.toolRegistry;
  const voiceSocket = createVoiceSocket({
    // The pipeline tier's browser lane: each connection gets its own
    // `VoiceSession` from the deployment's voice stack, keyed
    // `voice:web:browser:<client>` — never the typed chat session. Absent
    // `opts.voiceStack` (no `voice.*` configured) → the opener resolves null
    // per connection and the lane refuses `audio` frames honestly instead of
    // pretending to listen.
    session: (laneId: string) =>
      createBrowserVoiceSessionOpener(
        {
          voiceStack: opts.voiceStack,
          agentLoop,
          personalities: opts.personalities,
          legacyBargeInTuning,
        },
        laneId,
      ),
    // The realtime tier's CONTROL channel: same socket, same credential, but
    // the frames carry tool calls and transcripts instead of audio. Wired only
    // when a tool registry exists — without one there is nothing to consult,
    // and a lane that accepted the frames anyway would advertise an agent it
    // cannot reach.
    ...(realtimeControlRegistry
      ? {
          realtime: (laneId: string) =>
            createRealtimeControlDeps(
              {
                toolRegistry: realtimeControlRegistry,
                hooks: agentLoop.hooks,
                sessions: opts.sessionStore,
                personalities: opts.personalities,
                defaults: opts.chatDefaults,
                // Per-audio-minute pricing + the session cap, resolved from the
                // same roster selection the mint makes. The browser is never
                // asked what a minute costs.
                pricing: (personalityId) => voiceService.realtimeSessionCost(personalityId),
                // The loop already holds this talk session's spend under its
                // lane key — every `agent_consult` turn runs there — so audio
                // minutes join the same total rather than starting a second one.
                budget: agentLoop,
                // Per-turn latency for the hosted tier. The browser owns the
                // media socket here, so the moment it reports is the only
                // measurement of mouth-to-ear that exists; it lands in the
                // deployment's ONE span writer, beside the pipeline tier's.
                ...(opts.voiceSpans ? { spans: opts.voiceSpans } : {}),
              },
              laneId,
            ),
        }
      : {}),
    authenticate: async (req) => {
      const cookie = readCookie(req.headers.cookie, AUTH_COOKIE);
      return cookie ? tokens.matches(cookie) : false;
    },
    ...(opts.allowedOrigins ? { allowedOrigins: opts.allowedOrigins } : {}),
  });
  // The wake-satellite lane (`GET /satellite/ws`). Same process, same cookie,
  // same VoiceService and same AgentLoop as the browser lane — which is why it
  // is mounted here rather than on the gateway: pushing a routing table to a
  // connected microphone is then an in-process call.
  //
  // Hoisted so the per-lane deps factory closes over a narrowed value rather
  // than re-reading an optional field on every socket.
  const satelliteObservability = opts.satelliteObservability;
  const satelliteSocket = createSatelliteSocket({
    registry: satelliteRegistry,
    deps: () => ({
      transcribe: (audio, transcribeOpts) =>
        voiceService.transcribeBytes(
          audio.data,
          audio.mimeType,
          transcribeOpts.signal,
          transcribeOpts.personalityId ? { personalityId: transcribeOpts.personalityId } : {},
        ),
      synthesize: (text, synthOpts) => voiceService.synthesizeStream(text, synthOpts),
      resolvePersonality: async (id) => {
        // Refresh BOTH registries before resolving: the loop's (which decides
        // the turn) and this process's (which the sheet/editor reads). A route
        // naming a personality deleted since the last push must be refused
        // against what is on disk now, not against a boot snapshot.
        await opts.refreshPersonalities?.();
        await opts.personalities.loadFromDirectory(join(opts.dataDir, 'personalities'));
        const config = opts.personalities.get(id);
        // Unknown resolves privileged as well as absent — nothing downstream
        // should ever read `privileged: false` off a personality that is not
        // there.
        if (!config) return { exists: false, privileged: true };
        return { exists: true, privileged: isPrivilegedPersonality(config) };
      },
      runTurn: ({ text, sessionKey, personalityId, signal }) =>
        agentLoop.run(text, {
          sessionKey,
          personalityId,
          abortSignal: signal,
          // A wake turn IS a spoken turn even though the transcript is text by
          // the time the loop sees it — the annotation is what the approval
          // gate reads to tell a spoken request from a typed one.
          voiceOrigin: { transport: 'satellite-wake', speaker: 'owner' },
        }),
      voiceMode: (laneKey) => voiceLaneModeService.getForLane(laneKey),
      // One bot identity per web-api, the same single value the browser
      // realtime lane assumes (`createRealtimeControlDeps`).
      laneKey: (nodeId, personalityId) => satelliteLaneKey('web', nodeId, personalityId),
      ...(satelliteObservability
        ? {
            observe: (code: string, details: Record<string, unknown>) =>
              satelliteObservability.recordSafetyBlock({ code, details }),
          }
        : {}),
    }),
    authenticate: async (req) => {
      const cookie = readCookie(req.headers.cookie, AUTH_COOKIE);
      return cookie ? tokens.matches(cookie) : false;
    },
    ...(opts.allowedOrigins ? { allowedOrigins: opts.allowedOrigins } : {}),
  });
  const wakeRoutesService = new WakeRoutesService({
    config: configService,
    personalities: personalitiesService,
    registry: satelliteRegistry,
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
  // Cross-session activity feed (`GET /sse/activity`). One shared bucket under
  // a single fixed key, so touch/disconnect/reap apply to the whole feed — the
  // per-personality isolation is applied at READ time by
  // `ChatService.subscribeActivity`'s filter, NOT by the buffer. Larger
  // capacity than the per-session buffer because it aggregates every session.
  const activityBuffer = new SessionStreamBuffer<ActivityEvent>({ capacity: 5000 });
  const chatService = new ChatService({
    loop: agentLoop,
    sessions: chatRepo,
    buffer,
    activityBuffer,
    defaults: opts.chatDefaults,
    cardStore,
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

  // Session key ↔ session id translation. The `session_start` hook is the one
  // place both `sessionKey` (what background jobs/routers key by) and
  // `sessionId` (what the SSE buffer/ChatService is keyed by) are known
  // together. Shared by the clarify presenter below (a delegated clarify's
  // `PendingClarify.sessionId` is actually a job's `childSessionKey`, not a
  // web session id — see job-session.ts) and the delegated-run bridge
  // further down, which turns `RunUpdateDigest.parentSessionKey` /
  // `BackgroundJob.parentSessionKey` into the same session id the same way.
  const sessionIdsByKey = new Map<string, string>();
  const sessionKeysById = new Map<string, string>();
  agentLoop.hooks.registerVoid('session_start', async (payload) => {
    sessionIdsByKey.set(payload.sessionKey, payload.sessionId);
    sessionKeysById.set(payload.sessionId, payload.sessionKey);
  });
  const previousOnReapForSessionKeys = buffer.onReap;
  buffer.onReap = (sessionId: string) => {
    const key = sessionKeysById.get(sessionId);
    if (key !== undefined) {
      sessionIdsByKey.delete(key);
      sessionKeysById.delete(sessionId);
    }
    previousOnReapForSessionKeys?.(sessionId);
  };

  // Bridge clarify → SSE. The `clarify` tool registers a pending request on
  // the loop's ClarifyBridge; present it to the browser over the same SSE
  // channel approvals use, and broadcast the resolution so the card collapses
  // on every tab. A boot sweep clears rows that expired while the process
  // was down.
  //
  // `req.sessionId` (a `PendingClarify`) means two different things depending
  // on the caller: an interactive clarify sets it to the real session id, but
  // a background/delegated clarify (`req.jobId !== undefined`) sets it to the
  // job's `childSessionKey` — not a session the SSE buffer knows about. For
  // that case, resolve the job's `parentSessionKey` and translate it through
  // the map above instead.
  const clarifyBridge = agentLoop.clarifyBridge;
  if (clarifyBridge) {
    clarifyBridge.registerPresenter('web', async (req) => {
      // ClarifyBridge.presentNow() awaits this presenter inside a bare
      // `.catch(() => {})` (see clarify-bridge.ts) — a throw here is
      // otherwise invisible anywhere in the process. Log before rethrowing
      // so a routing/lookup failure shows up in server output instead of
      // just silently never presenting the card.
      try {
        const sessionId =
          req.jobId !== undefined
            ? await resolveJobSessionId(req.jobId, opts.jobStore, sessionIdsByKey)
            : req.sessionId;
        // No open session for this key — a CLI/gateway-spawned clarify, or no
        // browser tab open for it. Nothing to present here.
        if (!sessionId) return;
        chatService.broadcast(sessionId, {
          type: 'clarify.request',
          requestId: req.requestId,
          question: req.question,
          ...(req.options ? { options: req.options } : {}),
          ...(req.default !== undefined ? { default: req.default } : {}),
          // Present when a delegated run asked (D22) — the browser draws the
          // question inside that run's card instead of floating it.
          ...(req.jobId !== undefined ? { jobId: req.jobId } : {}),
          defaultDeadlineAt: req.defaultDeadlineAt,
        });
      } catch (err) {
        console.warn(
          `[chat] clarify presenter failed for request ${req.requestId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    });
    clarifyBridge.onResolved((row, response) => {
      void (async () => {
        const sessionId =
          row.jobId !== undefined
            ? await resolveJobSessionId(row.jobId, opts.jobStore, sessionIdsByKey)
            : row.sessionId;
        if (!sessionId) return;
        chatService.broadcast(sessionId, {
          type: 'clarify.resolved',
          requestId: row.requestId,
          source: response?.source ?? 'timeout-no-default',
        });
      })().catch((err) => {
        console.warn(
          `[chat] clarify.resolved broadcast failed for request ${row.requestId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
    // Fix 4 (pi-delegation.md §1b) — rebuild lane bookkeeping for rows that
    // survived a restart (must run AFTER the presenter above is
    // registered — hydrate() only adopts rows this bridge can present).
    void clarifyBridge.hydrate();
    void clarifyBridge.sweep();
  }

  // Bridge delegated runs → SSE (pi-delegation G9/D11/D20 = I15, §4.9/D27 = I18).
  //
  // The problem this solves: a background job's own events fire on its
  // `childSessionKey`, which is not a web session anyone is subscribed to. A run
  // card in the PARENT chat fed by those would render once and freeze at
  // `queued` while the run finished. So the executor publishes a coalesced
  // digest keyed by `parentSessionKey`, and this block reuses the key→id map
  // above (built by the same `session_start` hook) to turn that session KEY
  // into the session ID the SSE buffer is keyed by. A run card therefore
  // requires a turn to have run in its session — which is exactly how the run
  // got delegated.
  if (opts.subscribeRunUpdates || opts.subscribeJobComplete) {
    opts.subscribeRunUpdates?.((update) => {
      const sessionId = sessionIdsByKey.get(update.parentSessionKey);
      // No open session for this key — a CLI- or gateway-spawned run. Its card
      // does not live here, so there is nothing to keep alive.
      if (!sessionId) return;
      chatService.broadcast(sessionId, {
        type: 'run.update',
        jobId: update.jobId,
        runner: update.runner,
        status: update.status,
        now: update.now,
        elapsedMs: update.elapsedMs,
        spendUsd: update.spendUsd,
        toolCount: update.toolCount,
      });
    });

    opts.subscribeJobComplete?.((job) => {
      const sessionId = sessionIdsByKey.get(job.parentSessionKey);
      if (!sessionId) return;
      const text = formatRunHandBack({
        runner: job.runner ?? 'ethos',
        label: job.label,
        status: job.status,
        summary: job.summary,
        error: job.error,
        spendUsd: job.spendUsd,
        elapsedMs:
          job.startedAt !== undefined && job.finishedAt !== undefined
            ? job.finishedAt - job.startedAt
            : undefined,
      });
      if (!text) return;
      void chatService.handBack(sessionId, text).catch((err) => {
        console.warn(
          `[chat] completion hand-back failed for job ${job.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
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
      documents: documentsService,
      namedSecrets: namedSecretsService,
      keys: keysService,
      toolSettings: toolSettingsService,
      voice: voiceService,
      voiceLaneMode: voiceLaneModeService,
      satellites: satelliteRegistry,
      wakeRoutes: wakeRoutesService,
      deliveries: deliveriesService,
      calls: callsService,
      toolRegistry: opts.toolRegistry,
      dashboards: dashboardsService,
      pluginLoader: opts.pluginLoader,
      agentLoop,
      systemBus,
      ...(opts.a2aPeering ? { a2aPeering: opts.a2aPeering } : {}),
      ...(opts.a2aControl ? { a2aControl: opts.a2aControl } : {}),
      ...(opts.activityHistoryFn ? { activityHistory: opts.activityHistoryFn } : {}),
    },
    ...(opts.allowedOrigins ? { allowedOrigins: opts.allowedOrigins } : {}),
    ...(opts.secureCookie !== undefined ? { secureCookie: opts.secureCookie } : {}),
    ...(opts.trustProxy !== undefined ? { trustProxy: opts.trustProxy } : {}),
    ...(opts.webDist ? { webDist: opts.webDist } : {}),
    ...(opts.apiKeys ? { apiKeys: opts.apiKeys } : {}),
    ...(opts.listTeams ? { listTeams: opts.listTeams } : {}),
    ...(opts.webBaseUrl ? { webBaseUrl: opts.webBaseUrl } : {}),
    ...(opts.metricsTextFn ? { metricsTextFn: opts.metricsTextFn } : {}),
    ...(opts.recordHttpRequest ? { recordHttpRequest: opts.recordHttpRequest } : {}),
    ...(opts.cronFireTrigger ? { cronFireTrigger: opts.cronFireTrigger } : {}),
    ...(opts.idempotencyStore ? { idempotencyStore: opts.idempotencyStore } : {}),
    ...(opts.corsOrigins ? { corsOrigins: opts.corsOrigins } : {}),
    // The download/upload routes are a built-in module rather than a
    // caller-supplied one: they need `documentsService`, which is constructed
    // here. Declaring it through the same seam keeps its auth posture explicit
    // and reviewable, and mounts it BEFORE the static `/*` catch-all.
    routeModules: [
      ...(opts.routeModules ?? []),
      {
        basePath: '/documents',
        router: documentsRoutes({ documents: documentsService }),
        auth: 'cookie',
        description:
          'Streams a file out of a personality workdir, and accepts a raw-body upload ' +
          'into one. Cookie-only: an `<a download>` navigation carries `ethos_auth`, ' +
          'but a Bearer header cannot be attached to one.',
      },
      {
        basePath: '/api/personalities',
        router: personalityAvatarRoutes({ personalities: personalitiesService }),
        auth: 'cookie',
        description:
          'Upload/serve/delete a personality avatar image. Cookie-only, same posture as ' +
          '`/documents`: personality-mutating writes are cookie-only everywhere else in ' +
          'this app too (see dual-auth.ts SCOPE_MAP), and `<img src>` cannot carry a ' +
          'Bearer header regardless.',
      },
    ],
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

  return {
    app,
    chatService,
    systemBus,
    voiceSocket,
    satelliteSocket,
    forceSettleApprovals: () => approvalsService.forceSettleAll(),
    pendingApprovalCount: () => approvalsService.pendingCount(),
  };
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
export type { WakeRoute, WakeRoutingTable } from './repositories/config.repository';
export { WebTokenRepository } from './repositories/web-token.repository';
export type { RouteModule } from './routes/route-module';
export { setWhatsAppPairingCode, setWhatsAppQr } from './routes/setup-whatsapp';
export type { DangerPredicate, DangerReason } from './services/approval-hook';
export { IdempotencyStore } from './stores/idempotency-store';
// The satellite lane, exported so a host that OWNS a satellite client can be
// tested against the code that actually receives its frames rather than
// against a fixture — see `apps/ethos/src/__tests__/listen-satellite-e2e.test.ts`.
export type { SatelliteLaneDeps, SatelliteLaneLimits } from './voice/satellite-lane';
export { SatelliteRegistry } from './voice/satellite-registry';
export { createSatelliteSocket, type SatelliteSocket } from './voice/satellite-socket';
