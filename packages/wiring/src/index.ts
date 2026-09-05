import { join } from 'node:path';
import {
  type AgentLoop,
  ChainedProvider,
  DefaultLLMProviderRegistry,
  type SummarizerFn,
} from '@ethosagent/core';
import type { CronScheduler } from '@ethosagent/cron';
import type { GoalRunner } from '@ethosagent/goal-runner';
import type { TrustPolicy } from '@ethosagent/kanban-store';
import { AuthRotatingProvider } from '@ethosagent/llm-anthropic';
import {
  type PendingGateObservability,
  PendingMemoryStore,
  TombstoneStore,
} from '@ethosagent/memory-approval';
import { type HistorySource, HistoryStore, withHistory } from '@ethosagent/memory-history';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import type { PluginLoader } from '@ethosagent/plugin-loader';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import type { TeamRole } from '@ethosagent/tools-kanban';
import type { McpManager } from '@ethosagent/tools-mcp';
import type { MessagingSendFn } from '@ethosagent/tools-messaging';
import type {
  CliSubcommandContext,
  GlobalMemoryStore,
  LLMProvider,
  Logger,
  MemoryContext,
  MemoryProvider,
  ModelProfile,
  RetentionConfig,
  SecretsResolver,
  SessionStore,
  Storage,
  ToolRegistry,
} from '@ethosagent/types';

export type { WiringContext } from './types';

import { buildAgentLoop } from './build-agent-loop';
import { buildWiringContext } from './build-context';
import { buildInfrastructure } from './build-infrastructure';
import { composeAllTools } from './compose-tools';
import { loadPlugins } from './load-plugins';
import {
  detectLocalRuntime,
  probeServedWindowCached,
  resolveContextWindow,
  type WindowProbeResult,
  windowProbeCachePath,
} from './local-models';
import { createUndecoratedBackend, type MemoryBackendSelection } from './memory-backend';
import {
  lookupContextWindow,
  lookupProfile,
  mergeModelProfile,
  PROVIDER_WINDOW_DEFAULTS,
} from './model-catalog';
import type { EthosObservability } from './observability/ethos-observability';
import { registerBuiltinProviders } from './register-builtin-providers';
import {
  buildSummarizerSystemPrompt,
  capSummary,
  renderMiddleForSummary,
} from './summarizer-prompt';

// ---------------------------------------------------------------------------
// Messaging gateway — send function type re-exported for callers
// ---------------------------------------------------------------------------

export type { MessagingSendFn } from '@ethosagent/tools-messaging';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RotationKey {
  apiKey: string;
  priority: number;
  label?: string;
}

export interface WiringProviderConfig {
  provider: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Azure-only: REST API version (e.g. `2024-10-21`). Required when
   *  `provider === 'azure'`; ignored otherwise. */
  apiVersion?: string;
  /** Bedrock-only: AWS region for the Bedrock runtime endpoint (e.g.
   *  `us-west-2`). Defaults to `us-east-1`; ignored otherwise. */
  region?: string;
  /** Bedrock-only: named AWS profile from `~/.aws/config` (e.g. an SSO profile
   *  after `aws sso login`), used when no static keys are configured; ignored
   *  otherwise. Named `awsProfile`, not `profile`, because `profile` already
   *  means a per-model `ModelProfile` (`models.*`) in this config. */
  awsProfile?: string;
}

export interface WiringConfig {
  provider: string;
  model: string;
  apiKey: string;
  personality?: string;
  memory?: 'markdown' | 'vector' | 'vault';
  /**
   * Bring-your-own-vault backend settings (mapped from `EthosConfig.memoryVault`).
   * Read only when `memory === 'vault'`: `path` is the vault root, `agentDir`
   * the subtree the agent owns (default `Ethos`), `prefetch` the keys pulled
   * into the prompt tail, `exclude` extra names hidden from list/search.
   */
  memoryVault?: {
    path?: string;
    agentDir?: string;
    prefetch?: string[];
    exclude?: string[];
  };
  /**
   * Per-key content ceilings for the markdown backend, in characters (mapped
   * from `EthosConfig.memoryCharLimits`). Absent → 512K per key.
   */
  memoryCharLimits?: { memory?: number; user?: number };
  /**
   * Execution-backend resource caps (mapped from `EthosConfig.execution`).
   * Forwarded to `ExecutionBackendConfig` when the docker backend is resolved.
   */
  execution?: { docker?: { cpu?: number; diskMb?: number } };
  /**
   * Board work-in-progress caps (mapped from `EthosConfig.kanban`). Forwarded
   * to `KanbanStore`, which refuses a claim past the cap. Absent = uncapped.
   */
  kanban?: { maxInProgress?: number; maxInProgressPerProfile?: number };
  /**
   * Ground-truth verification policy (mapped from `EthosConfig.grounding`).
   * Read by `composeGrounding`; absent = the defaults, which is ON.
   */
  grounding?: {
    enabled?: boolean;
    onFinding?: 'annotate' | 'correct';
    showUnsupported?: boolean;
    memoryTag?: boolean;
    kanban?: { checks?: boolean; allowedCheckCommands?: string[] };
  };
  /**
   * Tool-loop soft-warn tiers (mapped from `EthosConfig.toolLoop`). Forwarded
   * to `AgentLoopConfig.options`; absent = no warn tier.
   */
  toolLoop?: { maxToolCallsWarnAt?: number; maxIdenticalToolCallsWarnAt?: number };
  /**
   * Playwright timeout budgets for the browser toolset (mapped from
   * `EthosConfig.browser`). Forwarded to `createBrowserTools`; absent = the
   * 30s navigation / 10s command literals those call sites shipped with.
   */
  browser?: { navigationTimeoutMs?: number; commandTimeoutMs?: number };
  baseUrl?: string;
  /** Azure-only: REST API version (e.g. `2024-10-21`). Required when
   *  `provider === 'azure'`; ignored otherwise. */
  apiVersion?: string;
  /** Bedrock-only: AWS region for the Bedrock runtime endpoint (e.g.
   *  `us-west-2`). Defaults to `us-east-1`; ignored otherwise. */
  region?: string;
  /** Bedrock-only: named AWS profile from `~/.aws/config` (e.g. an SSO profile
   *  after `aws sso login`), used when no static keys are configured; ignored
   *  otherwise. Named `awsProfile`, not `profile`, because `profile` already
   *  means a per-model `ModelProfile` (`models.*`) in this config. */
  awsProfile?: string;
  /**
   * Lane 0 (eng review D4) — operator override for the primary model's served
   * context window (tokens). Wins over the probe and the catalog (precedence:
   * config > probe > catalog > default); maps to the provider's
   * `maxContextTokens`. Applied to the PRIMARY provider/model only — chain
   * fallbacks resolve their own windows.
   */
  contextWindow?: number;
  /**
   * Lane 2a (eng review D6) — tool-definition ordering at the provider
   * serialization boundary. `'stable'` (default) is the deterministic ASCII
   * sort; `'insertion'` restores legacy registration-order bytes. Temporary
   * rollback lever; removal tracked in plan/uncompleted-tasks.md (D13).
   */
  toolOrder?: 'insertion' | 'stable';
  /**
   * Lane 4a(d) — per-request deadline (ms) for OpenAI-compat clients. Absent
   * → the OpenAI SDK default (10 minutes) stays in force; the default is
   * deliberately long because a cold local model load takes minutes.
   */
  requestTimeoutMs?: number;
  /** Lane 4a(d) — retry count for OpenAI-compat clients. Absent → the OpenAI
   *  SDK default (2 retries). */
  maxRetries?: number;
  /**
   * Lane 3(a) — total serialized tool-payload guard threshold, in chars.
   * Absent → `TOOL_PAYLOAD_GUARD_DEFAULT_CHARS` (static-floor.ts). Exceeding
   * it FAILS startup on a local dialect (losing tool calling entirely is the
   * failure prevented) and WARNS on hosted ones.
   */
  toolPayloadLimitChars?: number;
  /** Maps personality ID → model ID for per-personality model overrides. */
  modelRouting?: Record<string, string>;
  /**
   * §7 — per-model profile overrides, keyed by `<providerId>/<modelId>`. Merged
   * OVER the catalog `profile` at provider construction (override wins). Threads
   * `toolCallFormat`/`maxOutputTokens` to the provider and sampling defaults to
   * the loop.
   */
  models?: Record<string, ModelProfile>;
  /**
   * §5 — global context-compaction gate thresholds (fractions in (0,1]). A
   * per-model catalog `profile.compaction` overrides these; both absent → the
   * hardcoded 0.8/0.7 defaults. Threaded into the loop → compaction gate.
   *
   * Item 7 — `maxContextTokens` is an absolute token ceiling applied to BOTH
   * gates (global only, no per-model layer); `minTailUserMessages` is the
   * number of user messages every compaction keeps verbatim (default 3).
   */
  // biome-ignore format: Phase 3 adds turn-end auto-compact + overflow-retry flags; Phase 4 adds smallWindow; Item 7 adds the ceiling + user tail.
  compaction?: { pressure?: number; target?: number; gateDelta?: number; autoCompact?: boolean; retryOnOverflow?: boolean; abortOnSummaryFailure?: boolean; smallWindow?: 'auto' | 'on' | 'off'; maxContextTokens?: number; minTailUserMessages?: number };
  /**
   * Call-capture personality binding (plan/phases/call-capture-extension.md
   * decision 3) — see `EthosConfig.callCapture` in `@ethosagent/config` and
   * `validateCallCaptureBinding` in this package.
   */
  callCapture?: { personalityId?: string };
  /**
   * Phase 3 — silent memory-flush turn config (opt-in). `enabled` gates the
   * whole feature; the rest tune the soft threshold, timebox + token cap,
   * per-flush memory-delta cap, and the trivial-delta skip. Threaded into the
   * loop untouched.
   */
  // biome-ignore format: one line keeps the option shape adjacent to its doc.
  memoryConsolidation?: { enabled?: boolean; flushThreshold?: number; timeboxMs?: number; maxTokens?: number; maxDeltaChars?: number; minMessagesSinceFlush?: number };
  /** Anthropic key rotation pool. Empty / absent = single-key provider. */
  rotationKeys?: RotationKey[];
  /**
   * Override path to the kanban SQLite database. When unset, the path resolves
   * based on `teamName`:
   *   - `teamName` set → `${dataDir}/teams/<teamName>/board.db` (shared team board)
   *   - `teamName` unset → `${dataDir}/board.db` (global board)
   * `kanbanDbPath` always wins when explicitly set.
   */
  kanbanDbPath?: string;
  /**
   * Team this AgentLoop belongs to. When set, the kanban store points at the
   * team's shared board (`${dataDir}/teams/<name>/board.db`) and a `before_tool_call`
   * role hook gets registered (Plan B). When unset, the loop runs solo (Plan A).
   */
  teamName?: string;
  /**
   * Caller's role within the team. Drives the kanban role-gate hook:
   *   - `coordinator` can call kanban_create/_create_goal/_assign/_link/_archive
   *   - `member` cannot, and can only complete/block/unblock/heartbeat their own
   *     assigned tasks. Both roles can comment/list/show/update_status.
   * Only honored when `teamName` is also set.
   */
  role?: TeamRole;
  /**
   * The team manifest's coordinator personality id. When set alongside
   * `teamName`/`role`, the kanban role gate resolves the caller's role per
   * turn from the turn's personality (`coordinator` iff it is this id) instead
   * of the boot-time `role` — needed on a team-scoped loop that runs every
   * member's turns. Absent → boot-time `role` applies to every turn.
   */
  coordinatorId?: string;
  /** Enable postmortem entries in team memory on ticket revision. */
  postmortems?: boolean;
  /** Reputation-aware autonomy tiers for team members. */
  trustPolicy?: TrustPolicy;
  /** Background sub-agent engine config (durable spawn-and-continue jobs). */
  background?: import('@ethosagent/config').BackgroundConfig;
  /**
   * P3 observability — request dump store configuration. When enabled, every
   * LLM request/response is logged to JSONL files for offline debugging.
   */
  observabilityRequestDump?: {
    enabled?: boolean;
    dir?: string;
    includeContent?: boolean;
    rotation?: { maxBytes?: number };
  };
  /**
   * Fallback provider chain. When 2+ entries are provided, `createLLM` wraps
   * them in a `ChainedProvider` with cooldown-based automatic failover.
   * Takes precedence over `provider`/`apiKey`/`model` when present.
   */
  providers?: WiringProviderConfig[];
  /**
   * context_compression F1 — auxiliary compression summarizer. When `model`
   * is set, `semantic_summary` is wired with a real LLM summarizer running on
   * this (typically cheap) model instead of the placeholder. `provider` /
   * `apiKey` / `baseUrl` default to the primary provider's values when unset.
   */
  auxiliaryCompression?: {
    model: string;
    provider?: string;
    apiKey?: string;
    baseUrl?: string;
  };
  /**
   * tools-vision P3 — auxiliary vision model wiring. When `model` is set,
   * `vision_analyze` routes to this (typically vision-capable) provider when
   * the active personality's primary model can't handle images / PDFs.
   * `provider` / `apiKey` / `baseUrl` default to the primary provider's
   * values when unset, mirroring `auxiliaryCompression`.
   */
  auxiliaryVision?: {
    model: string;
    provider?: string;
    apiKey?: string;
    baseUrl?: string;
  };
  /**
   * tools-web — auxiliary model for web_extract summarization. Same shape as
   * auxiliaryVision. `provider`/`apiKey`/`baseUrl` default to the primary
   * provider's values when unset.
   */
  auxiliaryWeb?: {
    model: string;
    provider?: string;
    apiKey?: string;
    baseUrl?: string;
  };
  /**
   * Lane A Phase 2 (kanban-hooks-notify-parity) — auxiliary model for
   * `kanban_decompose`'s goal-to-children fan-out. Same shape as
   * auxiliaryVision/auxiliaryWeb: `provider`/`apiKey`/`baseUrl` default to the
   * primary provider's values when unset. When absent, `kanban_decompose`
   * still registers as a tool but returns a tool error at call time rather
   * than being omitted from the toolset.
   */
  auxiliaryKanbanDecomposer?: {
    model: string;
    provider?: string;
    apiKey?: string;
    baseUrl?: string;
  };
  /** tools-web — web_search backend preference. Auto-detect from env when unset. */
  webSearchBackend?: 'exa' | 'tavily' | 'brave';
  /** Global FALLBACK layer for per-personality tool config (`web_search` in
   *  v1). The personality's own `tools.yaml` is the source of truth; this fills
   *  the gap for personalities that don't declare the tool. Keyed by
   *  personality ID (or `_default`). */
  toolSettings?: import('@ethosagent/config').ToolSettingsMap;
  /** DEFAULT voice STT provider. auxiliary.asr in config.yaml. `command` is the
   *  shell template the local `command-stt` recipe provider runs, `timeout` its
   *  budget in seconds. Named alternatives live in `voice.stt.providers.*`. */
  auxiliaryAsr?: import('@ethosagent/types').SttProviderEntry;
  /** DEFAULT voice TTS provider. auxiliary.tts in config.yaml. `command` is the
   *  shell template the local `command-tts` recipe provider runs, `outputFormat`
   *  the container it writes, `timeout` its budget in seconds, and
   *  `maxTextLength` the per-call text cap it advertises as
   *  `caps.maxInputChars`. Named alternatives live in `voice.tts.providers.*`. */
  auxiliaryTts?: import('@ethosagent/types').TtsProviderEntry;
  /**
   * Real-time voice deployment config — `voice.*` in config.yaml, mapped
   * straight through from `EthosConfig`. Read by `buildVoiceStack`: bots give
   * the personality binding + lane keys, `livekit`/`trunk` gate concrete
   * transport construction (absent → those transports are simply not built),
   * and `trustedPlugins` arms the local-only egress gate.
   */
  voice?: import('@ethosagent/config').EthosConfig['voice'];
  /**
   * memory-experience pillar B — proactive capture. Default-off; when
   * `enabled`, the capture runner is wired on the `agent_done` seam. `model`
   * (+ optional provider/apiKey/baseUrl) selects the auxiliary extraction
   * model; when unset the primary model is reused. Same shape as the
   * `EthosConfig.memoryCapture` block it maps from.
   */
  memoryCapture?: {
    enabled?: boolean;
    model?: string;
    provider?: string;
    apiKey?: string;
    baseUrl?: string;
    maxPerHour?: number;
    maxPerDay?: number;
  };
  /**
   * Approve-before-store gate (memory-lifecycle L2). Default-off. When
   * `mode !== 'off'`, gated writers (`capture`, `dream`, and — in `all` mode —
   * explicit tool writes) park candidates in a per-scope pending queue instead
   * of writing durably; approve replays through the provenance history. Mapped
   * from `EthosConfig.memoryApproval`.
   */
  memoryApproval?: {
    mode?: 'off' | 'automated' | 'all';
    cap?: number;
    ttlDays?: number;
  };
  /**
   * Nightly-pass scheduler flag (mapped from `EthosConfig.nightlyPass`). Read
   * here only to gate capture's inline consolidation fallback (§3.5): when a
   * macro-loop is configured, capture never inline-consolidates.
   */
  nightlyPass?: { enabled?: boolean; cron?: string };
  /** Per-surface capture-notice opt-in (§3.3), mapped from display.memory_notices. */
  displayMemoryNotices?: boolean;
  /** File-backed secrets resolver. When provided, the capability backend
   *  resolves secrets from ~/.ethos/secrets/ before falling back to env vars. */
  secretsResolver?: SecretsResolver;
  /** Storage-layer settings. When `encryption` is true, the primary FsStorage
   *  is wrapped in CryptoStorage using ETHOS_STORAGE_KEY. */
  storage?: {
    backend?: string;
    encryption?: boolean;
  };
  /**
   * Remote model catalog configuration. When provided with `enabled !== false`,
   * the wiring loads the remote catalog (with cache/fallback) and uses it
   * instead of the static bundled MODEL_CATALOG.
   */
  modelCatalogConfig?: {
    enabled?: boolean;
    url?: string;
    ttlHours?: number;
    providers?: Record<string, { url: string }>;
  };
  /** Callback for OAuth authorization user prompts (open-url, device-code).
   *  Surfaces (CLI/TUI/web) provide an implementation that shows the prompt. */
  onUserPrompt?: (prompt: import('@ethosagent/oauth-core').UserPrompt) => void;
  /** Whether to auto-install plugins from plugins.lock on personality load. */
  pluginsAutoInstall?: boolean;
}

export type WiringProfile = 'cli' | 'tui' | 'web' | 'acp';

/**
 * Minimal structural shape of the app-layer slash command registry. Wiring
 * must not import the apps' concrete class (layering: apps depend on wiring,
 * never the reverse), so this declares exactly what plugin loading needs to
 * surface plugin-registered commands in autocomplete + /help.
 */
export interface WiringSlashRegistry {
  register(cmd: { name: string; description: string; usage: string; prefix?: string }): void;
  get(name: string): { description?: string; usage?: string } | undefined;
}

export interface WiringCliSubcommandRegistry {
  register(cmd: {
    name: string;
    description: string;
    handler?: (ctx: CliSubcommandContext) => Promise<number>;
    pluginId?: string;
  }): void;
  get(name: string):
    | {
        name: string;
        description: string;
        handler?: (ctx: CliSubcommandContext) => Promise<number>;
        pluginId?: string;
      }
    | undefined;
  getAll(): {
    name: string;
    description: string;
    handler?: (ctx: CliSubcommandContext) => Promise<number>;
    pluginId?: string;
  }[];
}

export interface CreateAgentLoopOptions {
  /** Root data directory (typically `~/.ethos`). Sessions DB, memory, and
   *  user personalities all resolve under this path. */
  dataDir: string;
  /** Working directory tools see. Defaults to `process.cwd()`. */
  workingDir?: string;
  /**
   * Override for where personality built-ins load from — forwarded to
   * `WiringContext.builtinPersonalitiesDir` (see `types.ts` for the full
   * rationale). Needed only by bundled callers whose `import.meta.dirname`
   * no longer resolves to the source tree post-bundling (e.g. the desktop
   * app's electron-vite main bundle). Unset for every other caller.
   */
  builtinPersonalitiesDir?: string;
  /**
   * Override for the root directory containing call-capture's native
   * binaries — forwarded to `WiringContext.callCaptureNativeDir` (see
   * `types.ts` for the full rationale). Needed only by bundled callers
   * whose `import.meta.dirname` no longer resolves to the source tree
   * post-bundling (e.g. the desktop app's electron-vite main bundle). Unset
   * for every other caller.
   */
  callCaptureNativeDir?: string;
  /** Surface label surfaced to tools/hooks as `AgentLoop.options.platform`.
   *  Pure metadata — no behavioral branches keyed on it. */
  profile?: WiringProfile;
  /** Skip Docker init and the tools that depend on it (run_code, browser).
   *  Useful in containers / CI / web profiles where Docker isn't reachable. */
  disableDocker?: boolean;
  /** Optional log sink for non-fatal warnings (e.g. Docker missing, skill
   *  skipped). Defaults to a no-op so the package stays headless. */
  logger?: Logger;
  /** Absolute path to the mesh registry file this agent belongs to.
   *  Controls which peers route_to_agent and broadcast_to_agents can see.
   *  Defaults to the 'default' mesh (~/.ethos/meshes/default/registry.json).
   *  Set by ethos serve --mesh <name> so team members route within their mesh. */
  meshRegistryPath?: string;
  /**
   * Optional observability adapter. When provided, passed through to
   * AgentLoop so LLM calls, tool calls, and hook blocks are recorded via
   * typed domain helpers. When absent, no observability writes occur.
   *
   * Construct as `new EthosObservability(observabilityService)` at the
   * call site; the adapter owns the ethos vocabulary while the underlying
   * service stays vocabulary-agnostic.
   */
  observability?: import('./observability/ethos-observability').EthosObservability;
  /**
   * Shared CronScheduler for agent-callable cron tools. When provided, the
   * 6 tools from `@ethosagent/tools-cron` (`create_cron_job`,
   * `list_cron_jobs`, `delete_cron_job`, `pause_cron_job`,
   * `resume_cron_job`, `run_cron_job_now`) are registered on this
   * AgentLoop's tool registry. Personalities opt in by listing the tool
   * names in their `toolset.yaml` — the same scheduler instance that fires
   * operator-created jobs also accepts agent-created ones.
   *
   * When unset, the cron tools are not registered, and personalities that
   * list them get an "unknown tool" error at call time. CLI / standalone
   * `ethos chat` profiles typically leave this unset; `ethos gateway` and
   * `ethos serve` pass their scheduler instance through.
   */
  cronScheduler?: CronScheduler;
  /**
   * Shared WatcherManager for agent-callable watcher tools. When provided,
   * the 5 tools from `@ethosagent/tools-watchers` (`watcher_create`,
   * `watcher_list`, `watcher_pause`, `watcher_resume`, `watcher_delete`)
   * are registered on this AgentLoop's tool registry (toolset `watchers`).
   * Ticks piggyback on the shared CronScheduler as `source:'system'` jobs —
   * long-lived surfaces (`ethos gateway`, `ethos serve`) pass the manager
   * they wired next to their scheduler; CLI/standalone profiles leave it
   * unset and the tools are not registered.
   */
  watcherManager?: import('@ethosagent/watchers').WatcherManager;
  /**
   * Shared call history for the outbound `call` tool. When provided, a call the
   * agent places opens a row the same way an inbound one does, so the
   * Communications call list is the whole story rather than the inbound half of
   * it. Pass the SAME instance the surface's inbound dispatch writes to — a
   * second `SQLiteCallLog` on the same file is a second connection for no gain.
   *
   * Absent (chat, one-shot CLI, tests) and `call` dials exactly as before,
   * writing nothing: the log is a seam, never a precondition for dialling.
   */
  callLog?: import('@ethosagent/call-log').CallLog;
  /**
   * App-layer slash command registry. When provided, plugins that call
   * `registerSlashCommand` during loading land their commands here so the
   * CLI's autocomplete and /help can surface them. Omit for surfaces with
   * no slash command UI (web, ACP).
   */
  slashRegistry?: WiringSlashRegistry;
  /**
   * App-layer CLI subcommand registry. When provided, plugins that call
   * `registerCliSubcommand` during loading land their commands here so the
   * CLI's `--help` and boot dispatch can surface them. Omit for surfaces
   * with no CLI subcommand UI (web, ACP).
   */
  cliSubcommandRegistry?: WiringCliSubcommandRegistry;
  /** True for one-shot CLI invocations that exit immediately — disables the
   *  background executor by default (a job spawned in a dying process is a lie).
   *  Long-lived surfaces (chat, gateway, web) omit it. */
  oneShot?: boolean;
  /**
   * The bot identity this loop answers as, stamped on every background job it
   * spawns (`origin_bot_key`). The gateway builds one loop per bot and passes
   * the same key it routes that bot's inbound messages by — that column is what
   * makes a completion routable back to its lane after a restart. Surfaces with
   * no bot identity (CLI, web) omit it.
   */
  originBotKey?: string;
  /**
   * Resolve the thread a live turn on `sessionKey` originated in, for stamping
   * `origin_thread_id` on background jobs. Supplied by the gateway (the only
   * component that knows the mapping); omitted elsewhere, in which case a
   * completion is delivered to the channel root.
   */
  resolveOriginThreadId?: (sessionKey: string) => string | undefined;
  /**
   * Lane 0 (eng review D16) — force a LIVE served-window probe (bypassing the
   * 15-minute disk cache) and rewrite the cache. Set by the command paths
   * whose numbers the operator tunes against (`ethos doctor`, `ethos bench
   * context`); chat and gateway startup leave it unset and ride the cache.
   */
  probeWindowRefresh?: boolean;
  /**
   * Native LiveKit MEDIA binding, forwarded to `buildVoiceStack`.
   *
   * `@livekit/rtc-node` ships a per-arch native binary and is deliberately NOT
   * a repo dependency (see `extensions/platform-voice/src/livekit/room-client.ts`),
   * so the app layer loads it optionally and passes the binding down. Absent —
   * which is every deployment that does not do telephony, and every test — the
   * voice stack builds exactly as it did before and the LiveKit/SIP media
   * transports report themselves unavailable.
   */
  livekit?: import('./voice-stack').LiveKitBindings;
}

// ---------------------------------------------------------------------------
// LLM provider construction
// ---------------------------------------------------------------------------

export {
  type A2aIdentityView,
  A2aPeeringError,
  type A2aPeeringErrorCode,
  A2aPeeringService,
  type A2aPeeringServiceDeps,
  type A2aPeerRow,
  type AddPeerArgs,
  type BuildA2aPeeringServiceContext,
  buildA2aPeeringService,
  createA2aPeeringService,
} from './a2a-peering-service';
export { resolveKanbanDbPath } from './kanban-path';
// Lane 6 (D5 + D19) — the arithmetic model-fit verdict: `computeModelFit` is
// the pure division; `resolvePersonalityModelFit` is the one assembler both
// the CLI (`ethos personality show`) and the `personalities.characterSheet`
// RPC seam call, so the surfaces can never disagree.
export { type ComputeModelFitInputs, computeModelFit } from './model-fit';
export {
  type ResolvePersonalityModelFitOptions,
  resolvePersonalityModelFit,
} from './personality-fit';
// Lane 1(b/c/e) + D8 — the shared static-floor measurement and window-scaled
// result-budget arithmetic (consumed by build-agent-loop, `ethos bench
// context`, and — later — Lane 6's fit verdict).
export {
  type ContextFitVerdict,
  evaluateContextFit,
  evaluateToolPayloadGuard,
  evaluateToolSchemaBudget,
  type MeasurableToolDefinition,
  measureStaticFloor,
  measureToolSchemaSizes,
  outputReserveTokens,
  RESULT_BUDGET_CEILING_CHARS,
  RESULT_BUDGET_FLOOR_CHARS,
  resolveResultBudget,
  type StaticFloorComponent,
  type StaticFloorInputs,
  type StaticFloorMeasurement,
  TOOL_PAYLOAD_GUARD_DEFAULT_CHARS,
  type ToolPayloadGuardVerdict,
  type ToolSchemaBudgetVerdict,
} from './static-floor';

// Hard ceiling on a single summarizer call. The summarizer runs on the turn's
// critical path before the main provider call, so a hung auxiliary provider
// would otherwise hang the whole turn. On timeout the call aborts and throws,
// which `maybeCompact` catches and fails open to the un-compacted history.
// (Q6 will add a tighter timeout + a fallback model; this is the floor.)
const SUMMARIZER_TIMEOUT_MS = 30_000;

// context_compression F1 — build the real LLM summarizer for `semantic_summary`.
// Runs on the auxiliary (typically cheap) model so a compacting turn costs
// ~one Haiku-tier call rather than a full main-model re-prompt. Fails open: a
// throw here is caught by the engine's caller (`maybeCompact`), which ships
// the un-compacted history and records a degradation event.
// Lane 5(ii) — the summarizer's provider gets the SAME window/profile
// threading as the main provider (D15 precedence: config > cached probe >
// catalog > default). Without it the provider inherits the 128k default —
// the §0 mis-sizing — so the summarizer's own compaction arithmetic lies on
// local setups. Exported for tests (asserted at the factory seam).
export function buildCompressionSummarizer(
  registry: import('@ethosagent/types').LLMProviderRegistry,
  config: WiringConfig,
  observability: EthosObservability | undefined,
  log: Logger,
  windowProbe?: WindowProbeContext,
): SummarizerFn {
  const aux = config.auxiliaryCompression;
  const providerName = aux?.provider ?? config.provider;
  const model = aux?.model ?? config.model;
  const baseUrl = aux?.baseUrl ?? config.baseUrl;
  let cachedProvider: LLMProvider | undefined;

  const getProvider = async (): Promise<LLMProvider> => {
    if (cachedProvider) return cachedProvider;
    const factory = registry.get(providerName);
    if (!factory) {
      throw new Error(
        `LLM provider "${providerName}" is not registered (compression summarizer). ` +
          `Available: ${registry.list().join(', ')}`,
      );
    }
    const NOOP: import('@ethosagent/types').SecretsResolver = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    };
    // Lane 0 precedence, cache-first: the summarizer is not a diagnostic
    // command, so the probe never forces a live refresh here — a warm cache
    // resolves with no network call.
    const isPrimary = providerName === config.provider && model === config.model;
    const runtime = detectLocalRuntime(providerName, baseUrl ?? '');
    let probe: WindowProbeResult | undefined;
    if (runtime !== undefined && baseUrl !== undefined && windowProbe !== undefined) {
      probe = await probeServedWindowCached({
        runtime,
        baseUrl,
        model,
        storage: windowProbe.storage,
        cachePath: windowProbeCachePath(windowProbe.dataDir),
        ...(windowProbe.fetchImpl !== undefined ? { fetchImpl: windowProbe.fetchImpl } : {}),
      });
    }
    const resolvedWindow = resolveContextWindow({
      provider: providerName,
      model,
      ...(isPrimary && config.contextWindow !== undefined
        ? { configWindow: config.contextWindow }
        : {}),
      ...(probe !== undefined ? { probe } : {}),
      ...(() => {
        const catalogWindow =
          lookupContextWindow(providerName, model) ?? PROVIDER_WINDOW_DEFAULTS[providerName];
        return catalogWindow !== undefined ? { catalogWindow } : {};
      })(),
      localRuntime: runtime !== undefined,
    });
    for (const diagnostic of resolvedWindow.diagnostics) {
      log.warn(`compression summarizer: ${diagnostic}`);
    }
    const profile = mergeModelProfile(
      lookupProfile(providerName, model),
      config.models?.[`${providerName}/${model}`],
    );
    cachedProvider = await factory({
      config: {
        provider: providerName,
        model,
        apiKey: aux?.apiKey ?? config.apiKey,
        ...(baseUrl ? { baseUrl } : {}),
        ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
        ...(resolvedWindow.contextWindow !== undefined
          ? { maxContextTokens: resolvedWindow.contextWindow }
          : {}),
        ...(profile?.toolCallFormat !== undefined
          ? { toolCallFormat: profile.toolCallFormat }
          : {}),
        ...(profile?.maxOutputTokens !== undefined
          ? { maxOutputTokens: profile.maxOutputTokens }
          : {}),
        ...(profile?.structuredOutput !== undefined
          ? { structuredOutput: profile.structuredOutput }
          : {}),
        ...(profile?.parseThinkTags !== undefined
          ? { parseThinkTags: profile.parseThinkTags }
          : {}),
        // FIX 8 — this path already surfaced any unknown-window diagnostic
        // (prefixed 'compression summarizer:' above); the factory must not
        // log a near-identical second copy.
        windowResolutionDiagnosed: true,
      },
      secrets: config.secretsResolver ?? NOOP,
      logger: log,
    });
    return cachedProvider;
  };

  return async (middle, targetTokens, instructions) => {
    const provider = await getProvider();
    const startedAt = Date.now();
    let text = '';
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const stream = provider.complete(
        [{ role: 'user', content: renderMiddleForSummary(middle) }],
        [],
        {
          system: buildSummarizerSystemPrompt(instructions),
          maxTokens: Math.ceil(targetTokens * 1.5),
          abortSignal: AbortSignal.timeout(SUMMARIZER_TIMEOUT_MS),
        },
      );
      for await (const chunk of stream) {
        if (chunk.type === 'text_delta') {
          text += chunk.text;
        } else if (chunk.type === 'usage') {
          costUsd = chunk.usage.estimatedCostUsd;
          inputTokens = chunk.usage.inputTokens;
          outputTokens = chunk.usage.outputTokens;
        }
      }
    } catch (err) {
      log.warn(
        `compression summarizer failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      log.warn('compression summarizer returned empty output');
      throw new Error('compression summarizer returned empty output');
    }
    const summary = capSummary(trimmed, targetTokens);
    observability?.recordCompaction({
      code: 'compaction_summarized',
      cause: `${provider.model}: summarized ${middle.length} message(s)`,
      details: {
        model: provider.model,
        inputTokens,
        outputTokens,
        costUsd,
        durationMs: Date.now() - startedAt,
      },
    });
    return summary;
  };
}

/**
 * Lane 0 (eng review D3+D16) — context needed to run the served-window probe
 * with its disk cache. When absent, no probe runs and resolution falls back
 * to config > catalog > default (preserves pre-Lane-0 callers unchanged).
 */
export interface WindowProbeContext {
  storage: Storage;
  dataDir: string;
  /** Bypass the 15-min cache: probe LIVE and rewrite it. Set by the command
   *  paths an operator tunes against (setup / doctor / personality show /
   *  bench context); chat and gateway startup leave it unset. */
  forceRefresh?: boolean;
  /** Test seam — stub fetch so probes stay off the network. */
  fetchImpl?: typeof fetch;
}

export async function createLLM(
  config: WiringConfig,
  windowProbe?: WindowProbeContext,
  log?: Logger,
): Promise<LLMProvider> {
  const registry = new DefaultLLMProviderRegistry();
  registerBuiltinProviders(registry);
  const noop: Logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => noop,
  };
  return createLLMFromRegistry(registry, config, log ?? noop, undefined, windowProbe);
}

/**
 * §4.B trust gate — default-deny for plugin-contributed LLM providers.
 * Built-in providers (no `/` in name) are always allowed.
 * Plugin providers (`pluginId/name`) require `pluginId` in the allowlist.
 * When `allowedPlugins` is undefined, all providers are allowed (backward compat).
 */
export function isProviderAllowed(providerName: string, allowedPlugins?: string[]): boolean {
  if (!allowedPlugins) return true;
  if (!providerName.includes('/')) return true;
  const pluginId = providerName.split('/')[0] ?? '';
  return allowedPlugins.includes(pluginId);
}

/**
 * Registry-aware LLM creation — used internally by `createAgentLoop` after
 * plugins have loaded. Falls through to the registry for each provider name,
 * so plugin-contributed providers participate in chained failover.
 */
async function createLLMFromRegistry(
  registry: import('@ethosagent/types').LLMProviderRegistry,
  config: WiringConfig,
  log: Logger,
  allowedPlugins?: string[],
  windowProbe?: WindowProbeContext,
): Promise<LLMProvider> {
  const secrets: import('@ethosagent/types').SecretsResolver = {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    list: async () => [],
  };

  const resolveOne = async (cfg: {
    provider: string;
    model: string;
    apiKey: string;
    baseUrl?: string;
    apiVersion?: string;
    region?: string;
    awsProfile?: string;
  }): Promise<LLMProvider> => {
    // §4.B trust gate: plugin-contributed providers (pluginId/name) require
    // the plugin to be in the personality's allowed-plugins list.
    if (!isProviderAllowed(cfg.provider, allowedPlugins)) {
      const pluginId = cfg.provider.split('/')[0] ?? '';
      throw new Error(
        `LLM provider "${cfg.provider}" is from plugin "${pluginId}" which is not in ` +
          `the personality's allowed plugins list. Add "${pluginId}" to personality.plugins ` +
          `to use this provider.`,
      );
    }

    const factory = registry.get(cfg.provider);
    if (!factory) {
      throw new Error(
        `LLM provider "${cfg.provider}" is not registered. ` +
          `Available: ${registry.list().join(', ')}`,
      );
    }
    // Lane 0 — resolve the model's context window with the D15 precedence:
    // config > probe > catalog > default. The probe runs only for a detected
    // local runtime (hosted endpoints are never probed), cache-first on
    // chat/gateway startup (D3) and live when the caller forces a refresh
    // (D16). A full miss leaves the field absent → the provider default still
    // applies (no crash), with the loud unknown-window diagnostic below.
    const isPrimary = cfg.provider === config.provider && cfg.model === config.model;
    const configWindow = isPrimary ? config.contextWindow : undefined;
    const runtime = detectLocalRuntime(cfg.provider, cfg.baseUrl ?? '');
    let windowProbeResult: WindowProbeResult | undefined;
    if (runtime !== undefined && cfg.baseUrl !== undefined && windowProbe !== undefined) {
      windowProbeResult = await probeServedWindowCached({
        runtime,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        storage: windowProbe.storage,
        cachePath: windowProbeCachePath(windowProbe.dataDir),
        ...(windowProbe.forceRefresh !== undefined
          ? { forceRefresh: windowProbe.forceRefresh }
          : {}),
        ...(windowProbe.fetchImpl !== undefined ? { fetchImpl: windowProbe.fetchImpl } : {}),
      });
    }
    const resolvedWindow = resolveContextWindow({
      provider: cfg.provider,
      model: cfg.model,
      ...(configWindow !== undefined ? { configWindow } : {}),
      ...(windowProbeResult !== undefined ? { probe: windowProbeResult } : {}),
      ...(() => {
        const catalogWindow =
          lookupContextWindow(cfg.provider, cfg.model) ?? PROVIDER_WINDOW_DEFAULTS[cfg.provider];
        return catalogWindow !== undefined ? { catalogWindow } : {};
      })(),
      localRuntime: runtime !== undefined,
    });
    for (const diagnostic of resolvedWindow.diagnostics) log.warn(diagnostic);
    const contextWindow = resolvedWindow.contextWindow;
    // §7 — resolve the effective per-model profile (config override OVER catalog)
    // and thread its provider-facing fields (toolCallFormat, maxOutputTokens)
    // into the factory config, next to maxContextTokens. Sampling defaults are
    // handled at the loop (see resolveModelProfile / buildAgentLoop). No profile
    // → no fields injected → behavior byte-identical to today.
    const profile = mergeModelProfile(
      lookupProfile(cfg.provider, cfg.model),
      config.models?.[`${cfg.provider}/${cfg.model}`],
    );
    const provider = await factory({
      config: {
        ...(cfg as unknown as Record<string, unknown>),
        ...(contextWindow !== undefined ? { maxContextTokens: contextWindow } : {}),
        ...(profile?.toolCallFormat !== undefined
          ? { toolCallFormat: profile.toolCallFormat }
          : {}),
        ...(profile?.maxOutputTokens !== undefined
          ? { maxOutputTokens: profile.maxOutputTokens }
          : {}),
        // §3 — a profile that declares structured-output support turns on the
        // provider's `capabilities.structuredOutput`, which internal JSON
        // consumers gate on. Absent → capability stays unset (unchanged).
        ...(profile?.structuredOutput !== undefined
          ? { structuredOutput: profile.structuredOutput }
          : {}),
        // FIX 5 — <think>-tag parsing opt-in for hosted reasoning models.
        // Absent → the provider derives it from its local classification.
        ...(profile?.parseThinkTags !== undefined
          ? { parseThinkTags: profile.parseThinkTags }
          : {}),
        // Lane 2a — tool-ordering escape hatch (global, applies to every
        // resolved provider). Absent → the provider's 'stable' default.
        ...(config.toolOrder !== undefined ? { toolOrder: config.toolOrder } : {}),
        // Lane 4a(d) — request deadline + retry count (global, applies to
        // every resolved provider). Absent → the SDK defaults stay in force.
        ...(config.requestTimeoutMs !== undefined
          ? { requestTimeoutMs: config.requestTimeoutMs }
          : {}),
        ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
        // Lane 3(a) — llamacpp-class runtimes (llama.cpp server, Ollama,
        // LM Studio — all GBNF grammar compilers) get the schema sanitizer at
        // the provider boundary (D7). vLLM is local but not llamacpp-class
        // (no GBNF lowering of tool schemas); hosted dialects never sanitize.
        ...(runtime === 'llamacpp' || runtime === 'ollama' || runtime === 'lmstudio'
          ? { toolSchemaProfile: 'llamacpp' }
          : {}),
        // FIX 8 — resolveContextWindow above already logged any unknown-window
        // diagnostic for this provider; suppress the factory's duplicate copy
        // so the condition surfaces exactly ONE warning.
        windowResolutionDiagnosed: true,
      },
      secrets: config.secretsResolver ?? secrets,
      logger: log,
    });
    // Capability validation: LLMProvider requires supportsCaching,
    // supportsThinking, and maxContextTokens. TypeScript enforces this for
    // typed plugins. For JS plugins, a missing field would surface as
    // undefined reads in the agent loop — fail-loud at resolution time.
    if (
      typeof provider.supportsCaching !== 'boolean' ||
      typeof provider.supportsThinking !== 'boolean' ||
      typeof provider.maxContextTokens !== 'number'
    ) {
      throw new Error(
        `LLM provider "${cfg.provider}" is missing required capability declarations ` +
          `(supportsCaching, supportsThinking, maxContextTokens). ` +
          `These must be declared on the provider instance.`,
      );
    }
    return provider;
  };

  if (config.providers && config.providers.length >= 2) {
    const instances = await Promise.all(
      config.providers.map((p) =>
        resolveOne({
          provider: p.provider,
          model: p.model ?? config.model,
          apiKey: p.apiKey,
          ...(p.baseUrl !== undefined ? { baseUrl: p.baseUrl } : {}),
          ...(p.apiVersion !== undefined ? { apiVersion: p.apiVersion } : {}),
          ...(p.region !== undefined ? { region: p.region } : {}),
          ...(p.awsProfile !== undefined ? { awsProfile: p.awsProfile } : {}),
        }),
      ),
    );
    return new ChainedProvider(instances);
  }

  // Anthropic rotation pool is provider-specific (rotates across API keys for
  // the same model). Handled inline — rotation is an Anthropic concern, not a
  // registry concern.
  if (config.provider === 'anthropic') {
    const rotation = config.rotationKeys ?? [];
    if (rotation.length > 0) {
      return new AuthRotatingProvider(
        [
          { id: 'primary', apiKey: config.apiKey, priority: 100 },
          ...rotation.map((k, i) => ({
            id: k.label ?? `key-${i + 1}`,
            apiKey: k.apiKey,
            priority: k.priority,
          })),
        ],
        config.model,
        // Lane 2a — the tool-ordering escape hatch applies to rotation pools too.
        config.toolOrder !== undefined ? { toolOrder: config.toolOrder } : undefined,
      );
    }
  }

  return resolveOne({
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    ...(config.apiVersion !== undefined ? { apiVersion: config.apiVersion } : {}),
    ...(config.region !== undefined ? { region: config.region } : {}),
    ...(config.awsProfile !== undefined ? { awsProfile: config.awsProfile } : {}),
  });
}

// Skill passthrough helpers live in a separate file so tests can import them
// without pulling in the heavy plugin-loader / docker / mcp dependency chain.
export { applySkillPassthrough, deriveSkillPassthrough } from './skill-passthrough';

// ---------------------------------------------------------------------------
// AgentLoop assembly
// ---------------------------------------------------------------------------

export interface CreateAgentLoopResult {
  loop: AgentLoop;
  toolRegistry: ToolRegistry;
  /** Lane 3(b) — the served context window (tokens) of the primary provider.
   *  `ethos bench context` uses it as the schema-budget denominator so the
   *  bench table and the startup warning read the same numbers (D8). */
  contextWindow: number;
  /** The McpManager instance from tool composition. Pass to createWebApi so
   *  re-auth via the web UI hits the live manager and updates the tool registry. */
  mcpManager: McpManager;
  /** The SkillsInjector from tool composition — the single eligibility decision
   *  ("which skills does personality P see"). Pass to createWebApi so read-only
   *  surfaces derive from THIS instance rather than building a second injector
   *  with its own scanner + mtime cache. Note it closes over the LOOP's
   *  personality registry, not the web-api's; refresh via `refreshPersonalities`. */
  skillsInjector: import('@ethosagent/skills').SkillsInjector;
  /** Replace the messaging tool's send implementation with the real gateway.
   *  Called from gateway.ts after Gateway construction. Scoped to this loop
   *  instance — multiple loops in the same process are independent. */
  setMessagingSend: (fn: MessagingSendFn) => void;
  /** Set by the web-api chat service to receive SSE notifications when the
   *  improvement fork proposes a new skill candidate. */
  setOnSkillProposed?: (fn: (skillId: string, personalityId: string) => void) => void;
  /** Set by the web-api chat service to receive SSE notifications when the
   *  improvement fork auto-promotes a skill to the live library. */
  setOnSkillApplied?: (fn: (skillId: string, personalityId: string) => void) => void;
  /**
   * Subscribe to proactive-capture notices (memory-experience §3.3). Present
   * only when `memoryCapture.enabled`. CLI chat subscribes to print one dim
   * "· remembered: …" line; channel adapters do not subscribe. Returns an
   * unsubscribe fn.
   */
  onMemoryCaptured?: (
    cb: (n: { sessionId: string; scopeId: string; summary: string }) => void,
  ) => () => void;
  /**
   * Directly and deterministically runs the call-capture pipeline for the
   * given personality — no LLM turn, no tool registry involved. Present only
   * when call capture is enabled (`isCallCaptureToolsEnabled`). Bound in
   * `build-agent-loop.ts`, closing over the constructed TapCapture/MicCapture/
   * STT/memory dependencies. `apps/ethos/src/commands/serve.ts` wires this
   * directly into `CallCaptureDaemon`'s `runCapture` option.
   */
  runCallCapture?: (
    personalityId: string,
    opts: {
      source?: string;
      abortSignal: AbortSignal;
      /**
       * Live per-entry callback (plan/phases/call-capture-desktop-ux.md,
       * P3) — forwarded straight through to `RunCallCaptureInput.onEntry`.
       * Absent for every caller except the desktop app's pill popover.
       */
      onEntry?: (entry: import('@ethosagent/platform-callcapture').TranscriptEntry) => void;
      /**
       * Live per-chunk audio-level callback (much higher frequency than
       * `onEntry`) — forwarded straight through to
       * `RunCallCaptureInput.onAudioLevel`. Absent for every caller except
       * the level-meter UI consuming it via `CallCaptureIndicatorPort`.
       */
      onAudioLevel?: (
        speaker: import('@ethosagent/platform-callcapture').Speaker,
        level: number,
        at: number,
      ) => void;
    },
  ) => Promise<import('@ethosagent/tools-callcapture').CallCaptureResult>;
  /** v2.2 — Notification router for registering per-session adapters.
   *  CLI/TUI/web-api register a NotificationAdapter on this router so plugin
   *  monitors can deliver messages to the active surface. */
  notificationRouter: import('@ethosagent/types').NotificationRouter;
  /** v2.2 — Plugin loader instance for health checks and diagnostics. */
  pluginLoader: PluginLoader;
  /** Loop-bearing goal runner — always present (backed by the shared goals.db).
   *  Shared with the web-api GoalsService so web-created goals execute on the same runner+store. */
  goalRunner: GoalRunner;
  /** Durable background-job store — present only when the background subsystem is
   *  enabled for this loop. Shared with the gateway/Tasks surface. */
  jobStore?: import('@ethosagent/types').JobStore;
  /** Detached background executor — present only when enabled. gateway.ts/chat.ts
   *  register completion handlers and call shutdown() on it. */
  backgroundExecutor?: import('@ethosagent/job-runner').BackgroundExecutor;
  /** Resolved job runners — present only when the background subsystem is enabled.
   *  The web-api Tasks detail RPC asks the runner that executed a row for its own
   *  detail-grid rows (pi-delegation D18). */
  jobRunners?: import('@ethosagent/types').JobRunnerRegistry;
  /** Mesh proxy reconciler — present only when the background subsystem is enabled.
   *  Polls mesh peers for jobs spawned via route_to_agent(background:true). Timers
   *  are unref'd; expose stop() for shutdown symmetry. */
  meshProxyReconciler?: import('@ethosagent/tools-delegation').MeshProxyReconciler;
  /** The resolved active personality for this loop. Exposed so gateway.ts can
   *  read the plugins allowlist without duplicating the personality load. */
  activePersonality: import('@ethosagent/types').PersonalityConfig;
  /** Re-load this loop's personality registry from `~/.ethos/personalities/`.
   *  Cheap when nothing changed (mtime-fingerprint cache → ~4 stat() calls per
   *  dir). Callers refresh before resolving a personality so a newly dropped or
   *  edited directory is picked up without a restart. */
  refreshPersonalities: () => Promise<void>;
  /** STT provider registry — threaded to Gateway for voice transcription. */
  sttProviders: import('@ethosagent/types').SttProviderRegistry;
  /** TTS provider registry — threaded to Gateway for voice synthesis. */
  ttsProviders: import('@ethosagent/types').TtsProviderRegistry;
  /**
   * Realtime (speech-to-speech) provider registry — threaded to web-api so the
   * browser talk lane can mint an ephemeral token on the realtime tier.
   */
  realtimeProviders: import('@ethosagent/types').RealtimeVoiceProviderRegistry;
  /**
   * Real-time voice stack built from `config.voice.*`. Absent when no voice
   * block is configured — the clean no-op every non-voice deployment takes.
   */
  voiceStack?: import('./voice-stack').VoiceStack;
  /** Voice provider config from auxiliary.asr / auxiliary.tts in config. */
  voiceConfig: {
    sttProviderName?: string;
    sttProviderConfig: Record<string, unknown>;
    ttsProviderName?: string;
    ttsProviderConfig: Record<string, unknown>;
    /**
     * Named TTS roster from `voice.tts.providers.*`, keyed by the operator's
     * label. A personality's `voice.tts_provider` names one of these; anything
     * else (and anything unknown) falls back to the `auxiliary.tts` default.
     */
    ttsRoster?: Record<string, import('@ethosagent/types').TtsProviderEntry>;
    /**
     * Named STT roster from `voice.stt.providers.*`. The exact mirror:
     * `voice.stt_provider` names one, anything unknown falls back to the
     * `auxiliary.asr` default.
     */
    sttRoster?: Record<string, import('@ethosagent/types').SttProviderEntry>;
    /**
     * Named REALTIME roster from `voice.realtime.providers.*`. Unlike the other
     * two this roster has no `auxiliary.*` default underneath it:
     * `realtimeDefault` NAMES one of these entries, and a deployment with
     * neither simply has no realtime tier.
     */
    realtimeRoster?: Record<string, import('@ethosagent/types').RealtimeProviderEntry>;
    /** `voice.realtime.default` — the roster key a personality that names none gets. */
    realtimeDefault?: string;
    /** `voice.tier` — the deployment's default voice engine. */
    tier?: 'pipeline' | 'realtime';
    /**
     * `voice.realtime.sessionBudgetUsd` — USD cap on ONE realtime call.
     *
     * Forwarded for the same reason `tier` is. Without it the only route from
     * the parsed config to the surface that enforces the cap was web-api's
     * OPTIONAL live-config read, so a surface built without that read was
     * silently uncapped — and a cap that silently does not apply is worse than
     * no cap, because the deployment believes it has one.
     */
    realtimeSessionBudgetUsd?: number;
    secretsResolver: import('@ethosagent/types').SecretsResolver;
    /**
     * Local-only voice-egress allowlist from `voice.trustedPlugins`. Present
     * only when the operator declared the key; surfaces pass it straight
     * through so a non-local provider selection is refused with a typed error
     * instead of quietly shipping audio off the machine.
     */
    trustedVoicePlugins?: ReadonlySet<string>;
  };
}

export async function createAgentLoop(
  config: WiringConfig,
  opts: CreateAgentLoopOptions,
): Promise<CreateAgentLoopResult> {
  const { wiringCtx, profile, log } = buildWiringContext(config, opts);

  // -------------------------------------------------------------------------
  // Infrastructure: registries, personalities, sandbox, hooks, session,
  // capability backends, tool registry, clarify bridge
  // -------------------------------------------------------------------------

  const infra = await buildInfrastructure(wiringCtx, config, opts);

  // -------------------------------------------------------------------------
  // Tool composition: all tool groups, hooks, skills, MCP, design tools,
  // guard hooks, team memory.
  // -------------------------------------------------------------------------

  const toolsResult = await composeAllTools(wiringCtx, config, opts, { infra, profile });
  const { skillPool, injectors, skillScanner } = toolsResult;

  // -------------------------------------------------------------------------
  // Plugin loading: context engines + plugin registries + plugin loader
  // -------------------------------------------------------------------------

  const pluginsResult = await loadPlugins(wiringCtx, config, opts, {
    tools: infra.tools,
    hooks: infra.hooks,
    injectors,
    personalities: infra.personalities,
    llmProviders: infra.llmProviders,
    memoryProviders: infra.memoryProviders,
    storageBackends: infra.storageBackends,
    executionBackends: infra.executionBackends,
    sttProviders: infra.sttProviders,
    ttsProviders: infra.ttsProviders,
    activePerson: infra.activePerson,
    skillScanner,
    skillPool,
    buildCompressionSummarizer: () =>
      config.auxiliaryCompression?.model
        ? buildCompressionSummarizer(infra.llmProviders, config, opts.observability, log, {
            // Lane 5(ii) — cache-first window resolution for the summarizer's
            // provider; never a forced live probe (not a diagnostic command).
            storage: wiringCtx.storage,
            dataDir: wiringCtx.dataDir,
          })
        : undefined,
    ...(opts.slashRegistry ? { slashRegistry: opts.slashRegistry } : {}),
    ...(opts.cliSubcommandRegistry ? { cliSubcommandRegistry: opts.cliSubcommandRegistry } : {}),
  });

  // -------------------------------------------------------------------------
  // Resolve LLM AFTER plugin loading so plugin-contributed providers are
  // available for config-level selection.
  // -------------------------------------------------------------------------

  const llm = await createLLMFromRegistry(
    infra.llmProviders,
    config,
    log,
    infra.activePerson.plugins,
    // Lane 0 — startup consults the probe cache (D3); command paths that must
    // show fresh numbers set probeWindowRefresh to force a live probe (D16).
    {
      storage: wiringCtx.storage,
      dataDir: wiringCtx.dataDir,
      ...(opts.probeWindowRefresh === true ? { forceRefresh: true } : {}),
    },
  );

  // -------------------------------------------------------------------------
  // Final assembly: memory, vision, improvement fork, safety, AgentLoop.
  // -------------------------------------------------------------------------

  return buildAgentLoop(wiringCtx, config, opts, {
    infra,
    toolsResult,
    pluginsResult,
    llm,
    profile,
  });
}

// ---------------------------------------------------------------------------
// Session / memory factories
// ---------------------------------------------------------------------------
// Apps that need a SessionStore or MemoryProvider before they build a full
// AgentLoop (e.g. the TUI session picker) ask wiring for one. Wiring keeps
// the choice of concrete backend; the app does not import session-sqlite or
// memory-markdown directly.

export interface CreateSessionStoreOptions {
  /** Root data directory (typically `~/.ethos`). */
  dataDir: string;
  /**
   * `retention.*` slice from the app config. Only the post-prune maintenance
   * knobs are consumed here; the TTL strings belong to the observability prune
   * pass. Absent → no automatic vacuum, today's behavior.
   */
  retention?: Pick<RetentionConfig, 'vacuumAfterPrune' | 'minVacuumIntervalDays'>;
}

export function createSessionStore(opts: CreateSessionStoreOptions): SessionStore {
  return new SQLiteSessionStore(join(opts.dataDir, 'sessions.db'), {
    ...(opts.retention?.vacuumAfterPrune !== undefined
      ? { vacuumAfterPrune: opts.retention.vacuumAfterPrune }
      : {}),
    ...(opts.retention?.minVacuumIntervalDays !== undefined
      ? { minVacuumIntervalDays: opts.retention.minVacuumIntervalDays }
      : {}),
  });
}

export interface CreateMemoryProviderOptions {
  /** Root data directory (typically `~/.ethos`). */
  dataDir: string;
  /** Storage backend. Injected by the composition root; required. */
  storage: Storage;
  /**
   * Provenance-history source label baked into this handle (§2.1). Every
   * write through the returned provider is recorded under this source, except
   * `writeGlobalEntry` (always `global-entry`) and dream turns (derived from
   * the `dream:` sessionKey prefix). Defaults to `tool`.
   */
  source?: HistorySource;
}

// The markdown backend supports MEMORY.md / USER.md direct read/write
// (GlobalMemoryStore) alongside the contract methods. The factory
// advertises both via intersection so apps that need only one half
// narrow at the use site. The result is wrapped in the history decorator so
// every mutation is auditable (§2) — reads and tool-visible write behaviour
// stay byte-identical.
export function createMemoryProvider(
  opts: CreateMemoryProviderOptions,
): MemoryProvider & GlobalMemoryStore {
  const base = new MarkdownFileMemoryProvider({ dir: opts.dataDir, storage: opts.storage });
  const history = new HistoryStore({ dataDir: opts.dataDir, storage: opts.storage });
  return withHistory(base, history, { source: opts.source ?? 'tool' });
}

export interface CreatePendingMemoryStoreOptions {
  /** Root data directory (typically `~/.ethos`). */
  dataDir: string;
  storage: Storage;
  /**
   * Backend selection (`memory` / `memoryVault` slice of the app config).
   * With `memory: 'vault'`, approve replays through the vault provider with
   * provenance history under `<vaultRoot>/<agentDir>/.ethos-meta`. The pending
   * queue + tombstones stay at `dataDir` regardless of backend. Omitted →
   * markdown at `dataDir` (previous behavior).
   */
  config?: MemoryBackendSelection;
  /** Per-scope queue hard cap. Default 200. */
  cap?: number;
  /** Pending candidate TTL in ms. Default 30 days. */
  ttlMs?: number;
  observability?: PendingGateObservability;
  /** Test seam. */
  now?: () => number;
}

/**
 * Assemble a `PendingMemoryStore` (memory-lifecycle L2) over the configured
 * backend, with the approve-replay `apply` wired to the provenance history so an
 * approved candidate records under its ORIGINAL source plus `approvedBy`. Used
 * by the CLI `ethos memory pending` command and (L3) the web RPC service — the
 * runtime write path composes the gate inline in `build-infrastructure`.
 */
export function createPendingMemoryStore(opts: CreatePendingMemoryStoreOptions): {
  store: PendingMemoryStore;
  tombstones: TombstoneStore;
} {
  const { base, history } = createUndecoratedBackend({
    selection: opts.config ?? {},
    dataDir: opts.dataDir,
    storage: opts.storage,
  });
  const tombstones = new TombstoneStore({ storage: opts.storage, dataDir: opts.dataDir });
  const store = new PendingMemoryStore({
    storage: opts.storage,
    dataDir: opts.dataDir,
    tombstones,
    ...(opts.cap !== undefined ? { cap: opts.cap } : {}),
    ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
    ...(opts.observability ? { observability: opts.observability } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    apply: async (entry, approvedBy) => {
      const handle = withHistory(base, history, { source: entry.source, approvedBy });
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
  return { store, tombstones };
}

export {
  isGated,
  type MemoryApprovalMode,
  type PendingEntry,
  type PendingGateObservability,
  PendingMemoryGate,
  PendingMemoryStore,
  type ProposeInput,
  TombstoneStore,
  withPendingGate,
} from '@ethosagent/memory-approval';
// Content-normalized fact hash — the tombstone key shared by capture dedup and
// the L4 `ethos memory retract` op, so a retracted fact is never re-proposed.
export { hashFact } from '@ethosagent/memory-capture';
export {
  type HistoryEntry,
  type HistoryReadFilter,
  type HistoryReadResult,
  type HistorySource,
  HistoryStore,
  withHistory,
} from '@ethosagent/memory-history';
// Shared archive-restore path (pillar C, §4.2) — re-exported so the web-api
// MemoryService can call the exact function the CLI `ethos memory restore`
// uses, without depending on `apps/ethos`.
export { type RestoreResult, restoreArchivedSlug } from '@ethosagent/nightly-loop';
// Backend-aware sibling of createMemoryProvider (memory-lifecycle vault gaps):
// returns a history-decorated handle for the CONFIGURED backend (`memory:
// vault` → the vault; anything else → markdown at dataDir) plus the history
// store and sidecar root/storage out-of-loop writers (nightly) need.
export {
  type ConfiguredMemoryBackend,
  type CreateMemoryProviderFromConfigOptions,
  createMemoryProviderFromConfig,
  type MemoryBackendSelection,
} from './memory-backend';

// ---------------------------------------------------------------------------
// Danger predicate (shared between CLI guard + web approval flow)
// ---------------------------------------------------------------------------

export {
  type CreateApprovalDangerPredicateOptions,
  createApprovalDangerPredicate,
  createLazyProvider,
} from './approval-seams';
export {
  APPROVAL_SURFACE_ALWAYS_ASK,
  type CreateDangerPredicateOptions,
  canonicalizeArgs,
  createDangerPredicate,
  type DangerPredicate,
  type DangerReason,
  SMART_MODE_CONSEQUENTIAL_TOOLS,
  type SmartApprovalCallback,
  type SmartVerdict,
} from './danger-predicate';
export type { ModelSource, ModelTarget, ResolveModelInput } from './model-resolver';
// Re-export the resolver so callers don't need a separate import.
export { resolveModelTarget } from './model-resolver';
// Shared live provider-credential probe (W2.2 / W2.4) with W1.2 liveness
// classification — used by the readline fallback, TUI AuthStep, and --from-env.
export {
  classifyProbeError,
  type ProbeProviderConfig,
  type ProbeProviderOutcome,
  probeProvider,
} from './probe-provider';
export { type CreateSmartApproverOptions, createSmartApprover } from './smart-approver';
export {
  farEndRefusalReason,
  SPOKEN_CONFIRMATION_TOOLS,
  type SpokenConfirmationOptions,
  type SpokenConfirmationRecord,
  spokenConfirmationReason,
  withSpokenConfirmation,
} from './spoken-confirmation';

// ---------------------------------------------------------------------------
// Real-time voice stack (config.voice.* → VoiceSession / transports)
// ---------------------------------------------------------------------------

export {
  createFarEndConsultTool,
  FAR_END_VOICE_ORIGIN,
  type FarEndConsultOptions,
} from './far-end-consult';
export { createBuiltinVoiceRegistries } from './voice-registries';
export {
  type BuildVoiceStackDeps,
  buildVoiceStack,
  type CreateVoiceAdapterOptions,
  type CreateVoiceSessionOptions,
  createObservabilitySpanSink,
  type LiveKitBindings,
  resolveSipTrunkClient,
  type VoiceInboundGates,
  type VoiceStack,
} from './voice-stack';

// ---------------------------------------------------------------------------
// Ethos observability adapter
// ---------------------------------------------------------------------------

export { IdentityMap, type IdentityMapEntry, type IdentityMapOptions } from './identity-map';
export {
  ETHOS_EVENT_CATEGORIES,
  ETHOS_TRACE_KINDS,
  type EthosEventCategory,
  EthosObservability,
  type EthosTraceKind,
} from './observability/ethos-observability';
export {
  FUNNEL_STATE_FILE,
  type FunnelObservability,
  type FunnelState,
  FunnelTracker,
  type FunnelTrackerOptions,
  type FunnelWizardPath,
  mergeFunnelState,
} from './observability/funnel';
export { resolveExecutionBackendName } from './resolve-execution-backend';
export {
  type BuildExecutionPostureInput,
  buildExecutionPosture,
  type ContainerizedDetection,
  type ContainerizedDetectionInput,
  type ContainerizedSignal,
  constitutionForbidsLocal,
  detectContainerized,
  hasExecTool,
  isExecTool,
  type ResolveExecutionPostureInput,
  resolveExecutionPosture,
} from './resolve-execution-posture';

// ---------------------------------------------------------------------------
// OAuth service factory
// ---------------------------------------------------------------------------

export { createOAuthService } from './oauth-factory';

// ---------------------------------------------------------------------------
// Security kernel — passthrough for apps (ARCHITECTURE.md §II, §III Law 5)
//
// The list lives in ./security-kernel so a lazily-loaded CLI command can import
// it WITHOUT the composition root's import graph (a barrel import costs ~7s and
// loads every extension). Re-exported here so surfaces already on the barrel —
// gateway, serve — keep one import.
// ---------------------------------------------------------------------------

export * from './security-kernel';

// ---------------------------------------------------------------------------
// Backup / restore (plan agent-state-backup, T2)
// ---------------------------------------------------------------------------
//
// The archive format, the scope table and the create/restore pair. Re-exported
// on the barrel so the CLI shims, the scheduled task and the web RPC all reach
// one implementation.

export * from './backup';

// ---------------------------------------------------------------------------
// Scheduled backup + system cron job reconciliation (plan agent-state-backup, T4)
// ---------------------------------------------------------------------------

export * from './backup-schedule';
export * from './system-jobs';
