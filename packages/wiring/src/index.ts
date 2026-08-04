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
import { createUndecoratedBackend, type MemoryBackendSelection } from './memory-backend';
import { lookupContextWindow, lookupProfile, mergeModelProfile } from './model-catalog';
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
  baseUrl?: string;
  /** Azure-only: REST API version (e.g. `2024-10-21`). Required when
   *  `provider === 'azure'`; ignored otherwise. */
  apiVersion?: string;
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
   */
  // biome-ignore format: Phase 3 adds turn-end auto-compact + overflow-retry flags; Phase 4 adds smallWindow.
  compaction?: { pressure?: number; target?: number; gateDelta?: number; autoCompact?: boolean; retryOnOverflow?: boolean; smallWindow?: 'auto' | 'on' | 'off' };
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
  /** tools-web — web_search backend preference. Auto-detect from env when unset. */
  webSearchBackend?: 'exa' | 'tavily' | 'brave';
  /** Global FALLBACK layer for per-personality tool config (`web_search` in
   *  v1). The personality's own `tools.yaml` is the source of truth; this fills
   *  the gap for personalities that don't declare the tool. Keyed by
   *  personality ID (or `_default`). */
  toolSettings?: import('@ethosagent/config').ToolSettingsMap;
  /** Voice STT provider. auxiliary.asr in config.yaml. */
  auxiliaryAsr?: {
    provider: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
  };
  /** Voice TTS provider. auxiliary.tts in config.yaml. */
  auxiliaryTts?: {
    provider: string;
    model?: string;
    apiKey?: string;
    voice?: string;
    baseUrl?: string;
  };
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
function buildCompressionSummarizer(
  registry: import('@ethosagent/types').LLMProviderRegistry,
  config: WiringConfig,
  observability: EthosObservability | undefined,
  log: Logger,
): SummarizerFn {
  const aux = config.auxiliaryCompression;
  const providerName = aux?.provider ?? config.provider;
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
    cachedProvider = await factory({
      config: {
        provider: providerName,
        model: aux?.model ?? config.model,
        apiKey: aux?.apiKey ?? config.apiKey,
        ...((aux?.baseUrl ?? config.baseUrl) ? { baseUrl: aux?.baseUrl ?? config.baseUrl } : {}),
        ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
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

export async function createLLM(config: WiringConfig): Promise<LLMProvider> {
  const registry = new DefaultLLMProviderRegistry();
  registerBuiltinProviders(registry);
  const noop: Logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => noop,
  };
  return createLLMFromRegistry(registry, config, noop);
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
    // M1b — resolve the model's context window from the catalog and inject it
    // so openai-compat-alias providers (ollama, groq, …) report their real
    // window to compaction instead of the 128k default. A catalog miss leaves
    // the field absent → the provider default still applies (no crash).
    const contextWindow = lookupContextWindow(cfg.provider, cfg.model);
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
      );
    }
  }

  return resolveOne({
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    ...(config.apiVersion !== undefined ? { apiVersion: config.apiVersion } : {}),
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
  /** The McpManager instance from tool composition. Pass to createWebApi so
   *  re-auth via the web UI hits the live manager and updates the tool registry. */
  mcpManager: McpManager;
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
  /** Voice provider config from auxiliary.asr / auxiliary.tts in config. */
  voiceConfig: {
    sttProviderName?: string;
    sttProviderConfig: Record<string, unknown>;
    ttsProviderName?: string;
    ttsProviderConfig: Record<string, unknown>;
    secretsResolver: import('@ethosagent/types').SecretsResolver;
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
        ? buildCompressionSummarizer(infra.llmProviders, config, opts.observability, log)
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
}

export function createSessionStore(opts: CreateSessionStoreOptions): SessionStore {
  return new SQLiteSessionStore(join(opts.dataDir, 'sessions.db'));
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
  type CreateDangerPredicateOptions,
  canonicalizeArgs,
  createDangerPredicate,
  type DangerPredicate,
  type DangerReason,
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
