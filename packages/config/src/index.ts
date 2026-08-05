import { homedir } from 'node:os';
import { join } from 'node:path';
import { deriveBotKey as deriveBotKeyFromSeed } from '@ethosagent/core';
import type { ChannelFilterConfig, ChannelPlatformConfig } from '@ethosagent/safety-channel';
import { detectSecrets } from '@ethosagent/safety-redact';
import { REF_TO_ENV } from '@ethosagent/storage-fs';
import type {
  ModelProfile,
  RetentionConfig,
  RetentionEventsConfig,
  SecretsResolver,
  Storage,
} from '@ethosagent/types';

// ---------------------------------------------------------------------------
// ${secrets:ref} substitution
// ---------------------------------------------------------------------------

const SECRETS_REF_RE = /\$\{secrets:([^}]+)\}/g;

async function resolveSecretValue(value: string, secrets: SecretsResolver): Promise<string> {
  const matches = [...value.matchAll(SECRETS_REF_RE)];
  if (matches.length === 0) return value;
  let resolved = value;
  for (const m of matches) {
    const ref = m[1];
    if (!ref) continue;
    const secret = await secrets.get(ref);
    if (secret === null) {
      const envKey = REF_TO_ENV.get(ref);
      if (envKey) {
        throw new Error(
          `Secret not found: ${ref}\n\n` +
            `This secret can be provided by ANY of (highest precedence first):\n` +
            `  1. ~/.ethos/.env file with ${envKey}=<value>\n` +
            `  2. environment variable ${envKey}  (e.g. set by systemd EnvironmentFile, docker -e, or your shell)\n` +
            `  3. ~/.ethos/secrets/${ref}  (file mode 0600 — lowest-precedence fallback)\n\n` +
            `Run \`ethos secrets set ${ref} <value>\` to store it as the on-disk fallback.`,
        );
      }
      throw new Error(
        `Secret not found: ${ref}. Run 'ethos secrets set ${ref} <value>' to store it.`,
      );
    }
    resolved = resolved.replace(m[0], () => secret);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Key rotation pool
// ---------------------------------------------------------------------------

export interface KeyProfile {
  apiKey: string;
  priority: number;
  label?: string;
}

export async function readKeys(storage: Storage, secrets?: SecretsResolver): Promise<KeyProfile[]> {
  const src = await storage.read(join(ethosDir(), 'keys.json'));
  if (!src) return [];
  try {
    const keys = JSON.parse(src) as KeyProfile[];
    if (secrets) {
      for (const k of keys) {
        k.apiKey = await resolveSecretValue(k.apiKey, secrets);
      }
    }
    return keys;
  } catch {
    return [];
  }
}

export async function writeKeys(storage: Storage, keys: KeyProfile[]): Promise<void> {
  await storage.mkdir(ethosDir());
  // 0o600 — keys file contains rotation API keys; restrict to owner.
  await storage.write(join(ethosDir(), 'keys.json'), `${JSON.stringify(keys, null, 2)}\n`, {
    mode: 0o600,
  });
}

export interface ActiveContext {
  /** 'personality' = single agent; 'team' = coordinator against a named mesh */
  type: 'personality' | 'team';
  name: string;
}

/** A personality's binding for the `web_search` tool. `secret` is a NAME
 *  only (e.g. `exa-main`) — resolves to `providers/<provider>/<name>` in the
 *  vault. Never a value (§V S9). */
export interface WebSearchToolSetting {
  provider?: 'exa' | 'tavily' | 'brave';
  secret?: string;
}

/** Per-personality tool config. Only `web_search` is modeled in v1. */
export interface PersonalityToolSettings {
  web_search?: WebSearchToolSetting;
}

/** Global FALLBACK map: personality ID (or `_default`) → per-tool config. */
export type ToolSettingsMap = Record<string, PersonalityToolSettings>;

/**
 * Per-bot routing binding. The bot's external identity (@handle, OAuth app)
 * is fixed to one destination — either a single personality or a team's
 * coordinator. `/personality` switching inside the bot's chats is disabled
 * by default; flip `allowSlashSwitch` only for the rare flexible bot.
 */
export interface BotBinding {
  type: 'personality' | 'team';
  name: string;
  allowSlashSwitch?: boolean;
}

export interface TelegramBotConfig {
  /** Stable identifier used in lane keys + logs. Defaults to a short
   *  sha256 of `token` when omitted. */
  id?: string;
  token: string;
  bind: BotBinding;
  piiRedaction?: boolean;
}

export interface SlackAppConfig {
  id?: string;
  botToken: string;
  appToken: string;
  signingSecret: string;
  bind: BotBinding;
  piiRedaction?: boolean;
}

/**
 * Per-team runtime knobs that the gateway honors when a bot binds to
 * `bind.type === 'team'`. Keyed by team manifest name.
 */
export interface TeamRuntimeConfig {
  /** Stop the team supervisor when the gateway shuts down. Default false:
   *  supervisors are long-lived and outlive the gateway. */
  autoStop?: boolean;
}

export interface WhatsAppConfig {
  id?: string;
  session_dir?: string;
  default_mode?: 'all' | 'mention_only';
  allowed_numbers?: string[];
  /** When set, the adapter links via phone-number pairing code instead of QR.
   *  Stored as entered; the adapter strips non-digits before requesting. */
  phone_number?: string;
  /** Optional personality/team binding. Unlike slack/telegram (which require
   *  a bind), WhatsApp bind is optional — bind-less entries fall back to the
   *  default personality in the gateway. */
  bind?: BotBinding;
  piiRedaction?: boolean;
}

/**
 * Real-time voice bot binding (plan/phases/gap-voice-realtime.md §3(b),(e)).
 * Mirrors `telegram.bots[]`: one entry binds a personality/team to the voice
 * lane the bot answers. `match` is the room name or E.164 number pattern the
 * concrete transport routes on — it replaces `token`, since a voice bot has no
 * chat-platform token. The botKey derives from `id` (explicit) or `match`,
 * feeding the lane key `voice:<botKey>:<callerId>`.
 *
 * LiveKit / SIP-trunk connection keys are deliberately NOT modeled here yet;
 * they land with the concrete transport under `voice.livekit.*` / `voice.trunk.*`
 * in a later, isolated step. This step adds only the personality↔voice-bot
 * binding shape.
 */
export interface VoiceBotConfig {
  /** Stable identifier used in lane keys + logs. Defaults to a short
   *  sha256 of `match` when omitted. */
  id?: string;
  /** Room name or E.164 phone-number pattern this bot answers. */
  match: string;
  bind: BotBinding;
}

/**
 * LiveKit connection keys for the real-time voice transport
 * (plan/phases/gap-voice-realtime.md §3(b)). `url` is the LiveKit server/room
 * URL; `apiKey`/`apiSecret` are the LiveKit project credentials the token
 * minter signs access tokens with. All three are required together — a partial
 * block surfaces as a parse error. The concrete transport
 * (`@ethosagent/platform-voice`) consumes these; the native `@livekit/rtc-node`
 * / `livekit-server-sdk` bindings are supplied at the app layer, not committed.
 */
export interface VoiceLiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

/**
 * SIP trunk config for telephony (plan/phases/gap-voice-realtime.md §4 Phase C).
 * A rented PSTN number + SIP trunk (Twilio/Telnyx/…) is pointed at LiveKit SIP,
 * so an inbound/outbound phone call becomes just another LiveKit participant
 * bridged into a room. This block holds the trunk-level connection facts; the
 * per-number → personality routing reuses `voice.bots[]` (a bot's `match` is an
 * E.164 number/pattern, its `bind` names the personality/team — no separate
 * mapping structure).
 *
 * `provider` + `trunkId` are required together. `password`, like
 * `voice.livekit.apiSecret`, is read as a literal — the concrete SIP binding
 * (`livekit-server-sdk` SIP API) is supplied at the app layer, not committed.
 */
export interface VoiceTrunkConfig {
  /** Telephony trunk provider bridged into LiveKit SIP. Informational — the
   *  app-layer binding selects the concrete SDK/credentials shape. */
  provider: 'twilio' | 'telnyx' | 'generic';
  /** LiveKit SIP trunk id the number is attached to (inbound + outbound). */
  trunkId: string;
  /** Caller-ID number presented on outbound `call` (E.164). Optional. */
  fromNumber?: string;
  /** SIP registrar/auth username for outbound trunk auth. Optional. */
  username?: string;
  /** SIP auth password/token. Optional; read as a literal (like apiSecret). */
  password?: string;
}

export interface ProviderConfig {
  provider: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Azure-only: REST API version (e.g. `2024-10-21`). Required when
   *  `provider === 'azure'`; ignored otherwise. */
  apiVersion?: string;
}

/**
 * FW-16 / context-economy Phase 1 — user-defined `/name` shortcuts.
 * `exec` runs an operator-authored shell command; `reply` returns a canned
 * string with no shell involved. `gateway: true` (default false) exposes the
 * command to channel messages via the `gateway_message` claiming hook;
 * `channels` optionally restricts that exposure to the listed platforms.
 * Channel text is only ever exact-matched against `/name` — it is never
 * interpolated into `command`.
 */
export type QuickCommandConfig =
  | { type: 'exec'; command: string; gateway?: boolean; channels?: string[] }
  | { type: 'reply'; reply: string; gateway?: boolean; channels?: string[] };

/**
 * Auxiliary model wiring for non-primary work. Today the only consumer is
 * context compression: `semantic_summary` runs its summarizer on this
 * (typically cheap) model so a compacting turn costs ~one Haiku-tier call
 * instead of a full main-model re-prompt. `provider` / `apiKey` / `baseUrl`
 * default to the primary provider's values when unset.
 */
export interface AuxiliaryCompressionConfig {
  model: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Proactive memory capture (memory-experience pillar B). Default-OFF: absent or
 * `enabled !== true` means no capture runner is wired and behaviour is
 * unchanged (opt-in for one release). `model` (+ optional provider/apiKey/
 * baseUrl) selects the cheap auxiliary model for the single extraction call per
 * turn; when unset the primary model is reused. Rate caps default to 6/hour,
 * 30/day per scope. Config keys:
 *   memoryCapture.enabled: true
 *   memoryCapture.model: claude-haiku-4-5-20251001
 *   memoryCapture.maxPerHour: 6
 *   memoryCapture.maxPerDay: 30
 */
export interface MemoryCaptureConfig {
  enabled?: boolean;
  model?: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  maxPerHour?: number;
  maxPerDay?: number;
}

/**
 * Bring-your-own-vault memory backend (memory-lifecycle L1). Read only when
 * `memory: vault`. Parsed from flat `memoryVault.<field>` keys:
 *   memoryVault.path: /Users/you/Documents/ObsidianVault
 *   memoryVault.agentDir: Ethos
 *   memoryVault.prefetch: MEMORY.md, USER.md
 *   memoryVault.exclude: Archive, Templates
 */
export interface MemoryVaultConfig {
  /** Absolute path to the vault root (the Obsidian folder). */
  path?: string;
  /** Subtree the agent owns; scopes route beneath it. Default `Ethos`. */
  agentDir?: string;
  /** Keys prefetched into the prompt tail. Default `MEMORY.md`, `USER.md`. */
  prefetch?: string[];
  /** Directory / file names hidden from list + search. */
  exclude?: string[];
}

/**
 * Approve-before-store gate (memory-lifecycle L2, §3b). Default-OFF: absent or
 * `mode: off` means every memory write lands durably as before (opt-in for one
 * release, matching the capture/dedup-hatch precedent). Parsed from flat
 * `memoryApproval.<field>` keys:
 *   memoryApproval.mode: automated   # off | automated | all
 *   memoryApproval.cap: 200          # per-scope queue hard cap
 *   memoryApproval.ttlDays: 30       # pending candidates auto-reject after N days
 *
 * `automated` gates the autonomous writers (`capture`, `dream`); `all` also
 * gates explicit tool/consolidation writes. Approved candidates replay through
 * the provenance history under their original source plus `approvedBy`.
 */
export interface MemoryApprovalConfig {
  mode?: 'off' | 'automated' | 'all';
  /** Per-scope pending-queue hard cap. At cap the oldest is dropped. Default 200. */
  cap?: number;
  /** Pending candidate TTL in days; expired candidates auto-reject. Default 30. */
  ttlDays?: number;
}

/**
 * Importance scoring + decay tuning (memory-experience pillar C, §4.2/§4.3).
 * All optional — the nightly pass applies defaults (30-day half-life, 0.05
 * archive threshold, USER.md exempt). Parsed from flat `memoryConsolidation.<field>`
 * keys.
 */
export interface MemoryConsolidationConfig {
  // Importance scoring + decay tuning (memory-experience pillar C, §4.2/§4.3).
  /** Recency half-life in days. Default 30. */
  halfLifeDays?: number;
  /** Effective weight below which a section is archived. Default 0.05. */
  threshold?: number;
  /** Exempt USER.md from decay entirely. Default true. */
  exemptUser?: boolean;
  // Silent memory-flush turn (context-compaction Phase 3). At a soft threshold
  // (default 70% of the model-aware gate) a non-persisted agentic turn,
  // restricted to the memory tools, consolidates durable facts into
  // MEMORY.md / USER.md before auto-compaction later drops raw history.
  /** Enable the opt-in silent memory-flush turn. */
  enabled?: boolean;
  /** Soft threshold (fraction of the model-aware gate) that triggers the flush. Default 0.7. */
  flushThreshold?: number;
  /** Timebox for the flush turn in ms. Default 30000. */
  timeboxMs?: number;
  /** Max tokens for the flush turn. Default 1024. */
  maxTokens?: number;
  /** Max delta chars written per flush. Default 4000. */
  maxDeltaChars?: number;
  /** Minimum messages since last flush before another runs. Default 8. */
  minMessagesSinceFlush?: number;
}

/**
 * tools-vision P2 — auxiliary vision model wiring. `vision_analyze` uses this
 * (typically vision-capable) model when the active personality's primary
 * model can't handle images / PDFs, or when the user wants to route vision
 * traffic to a cheaper model. `provider` / `apiKey` / `baseUrl` default to
 * the primary provider's values when unset, same as compression.
 */
export interface AuxiliaryVisionConfig {
  model: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * tools-web — auxiliary model for web_extract summarization. Same shape as
 * compression/vision. When set, web_extract summarizes large pages via this
 * (typically cheap) model instead of returning truncated raw text.
 */
export interface AuxiliaryWebConfig {
  model: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
}

/** tools-web — web search/extract backend selection. */
export interface WebConfig {
  search_backend?: 'exa' | 'tavily' | 'brave';
  extract_backend?: 'htmltext';
}

/**
 * Remote model catalog configuration. Controls how Ethos fetches and caches
 * the centralized model metadata catalog (capabilities, context windows, pricing).
 */
export interface ModelCatalogConfig {
  /** Whether remote catalog fetching is enabled. Default true. */
  enabled?: boolean;
  /** URL of the catalog JSON endpoint. Default: https://ethos-agent.ai/api/model-catalog.json */
  url?: string;
  /** Cache TTL in hours. Default: 24. */
  ttlHours?: number;
  /** Per-provider URL overrides for catalog endpoints. */
  providers?: Record<string, { url: string }>;
}

export interface AwsSecretsConfig {
  enabled?: boolean;
  region?: string;
  prefix?: string;
  endpoint?: string;
}

export interface AwsConfig {
  secrets?: AwsSecretsConfig;
}

/** Per-hook inbound webhook config (`webhooks.<hookId>.*` keys). */
export interface WebhookHookConfig {
  personalityId: string;
  secret: string;
  sessionKey?: string;
  /** Prefilter script (scripts-dir relative, .sh/.py) run with the raw
   *  request body on stdin before any turn is dispatched. */
  prefilter?: string;
  /** Wall-clock limit for the prefilter in seconds. Default 30, max 600. */
  prefilterTimeoutSeconds?: number;
  /** 'sync' (default) holds the connection for the agent's reply;
   *  'ack' responds 202 immediately and runs the turn detached. */
  mode?: 'sync' | 'ack';
}

/**
 * On-disk schema version for `~/.ethos/config.yaml`. Bump on a breaking
 * field rename, type change, or required-field addition; do NOT bump on
 * additive optional fields. The loader uses this to drive migrations in
 * future releases without guessing whether an unknown field is an
 * operator typo or an older shape.
 *
 * Current shape lives at version 1. Pre-versioned configs (created before
 * this field shipped) load with a one-line deprecation warning and are
 * treated as `1`; the writer always emits the current value going
 * forward.
 */
export const CURRENT_ETHOS_CONFIG_SCHEMA_VERSION = 1;

/**
 * Background sub-agent job config (`background:` section). All fields optional;
 * omitted values fall back to the defaults in `backgroundDefaults()`. Lives in
 * ~/.ethos/config.yaml, NOT on PersonalityConfig (frozen schema).
 *
 * Distinct from the FW-13 `backgroundMaxConcurrent` scalar (config key
 * `background.max_concurrent`) — that governs interactive background sessions;
 * this section governs the Background Sub-Agents job pool.
 */
export interface BackgroundConfig {
  /** Master switch. Default resolved by the wiring layer per surface, not here. */
  enabled?: boolean;
  /** Separate concurrency pool size for background jobs (additive to interactive). Default 2. */
  maxConcurrentJobs?: number;
  /** Max simultaneous active (queued|running) jobs per root session. Default 3. */
  maxJobsPerRoot?: number;
  /** Max simultaneous active jobs per personality. Default 5. */
  maxJobsPerPersonality?: number;
  /** Default per-job cost cap in USD when the tool call omits max_cost_usd. Default 1.00. */
  defaultMaxCostUsd?: number;
  /** Finite-by-default aggregate background spend cap per root, summed over rootSessionKey. Default 5.00. */
  maxRootBackgroundUsd?: number;
  /** Queued rows older than this at boot are expired (ms). Default 900000 (15 min). */
  queuedTtlMs?: number;
  /** Heartbeat staleness threshold (ms). Default 90000 (90s = 3 missed 30s beats). */
  staleMs?: number;
  /** Executor per-job heartbeat timer interval (ms). Default 30000. */
  heartbeatMs?: number;
  /** Terminal-row retention before GC (days). Default 30. */
  retentionDays?: number;
}

/**
 * Canonical defaults for the `background:` section. `enabled` defaults to false;
 * the wiring layer may override per surface. All other fields are finite.
 */
export function backgroundDefaults(): Required<Omit<BackgroundConfig, 'enabled'>> & {
  enabled: boolean;
} {
  return {
    enabled: false,
    maxConcurrentJobs: 2,
    maxJobsPerRoot: 3,
    maxJobsPerPersonality: 5,
    defaultMaxCostUsd: 1.0,
    maxRootBackgroundUsd: 5.0,
    queuedTtlMs: 900_000,
    staleMs: 90_000,
    heartbeatMs: 30_000,
    retentionDays: 30,
  };
}

export interface EthosConfig {
  /**
   * On-disk schema version. Optional for backward compatibility — pre-
   * versioned configs are accepted as `1` with a deprecation warning.
   * Always written by `writeConfig` going forward.
   */
  schemaVersion?: number;
  provider: string;
  model: string;
  apiKey: string;
  personality: string;
  /** Memory backend: 'markdown' (default), 'vector' (semantic retrieval), or 'vault' (bring-your-own external directory) */
  memory?: 'markdown' | 'vector' | 'vault';
  baseUrl?: string;
  /** Azure-only: REST API version (e.g. `2024-10-21`). Required when
   *  `provider === 'azure'`; ignored otherwise. */
  apiVersion?: string;
  /**
   * Lane 0 (eng review D4) — operator override for the model's served context
   * window, in tokens. A window FACT (how many tokens the server accepts) —
   * not a compaction POLICY (`compaction.maxContextTokens` is the ceiling
   * compaction aims for, different semantics) — hence the name matches the
   * catalog's `contextWindow` field rather than the provider-internal
   * `maxContextTokens` it maps to. Wins over the window probe and the catalog
   * (precedence: config > probe > catalog > default). Flat-key shape:
   *   contextWindow: 8192
   */
  contextWindow?: number;
  // Per-personality model overrides: maps personality ID → model ID string
  modelRouting?: Record<string, string>;
  /**
   * Global FALLBACK layer for per-personality tool config. Keyed by
   * personality ID (or `_default`). The personality's own `tools.yaml` is the
   * source of truth; this map only fills the gap for personalities (especially
   * read-only built-ins) that don't declare a tool. Only secret NAMES live
   * here — never values (§V S9). `web_search` is the sole consumer in v1.
   */
  toolSettings?: ToolSettingsMap;
  /**
   * §7 — per-model config profile overrides, merged OVER the catalog profile
   * for the same `(providerId, modelId)`. Keyed by `<providerId>/<modelId>`
   * (the model id itself may contain `/`, e.g. `openrouter/anthropic/...`).
   * Flat-key config shape (the first path segment is the providerId, the rest
   * is the modelId):
   *   models.ollama/llama3.2.sampling.temperature: 0.2
   *   models.ollama/llama3.2.sampling.topP: 0.9
   *   models.ollama/llama3.2.sampling.topK: 40
   *   models.ollama/llama3.2.sampling.minP: 0.05
   *   models.ollama/llama3.2.toolCallFormat: openai
   *   models.ollama/llama3.2.maxOutputTokens: 2048
   */
  models?: Record<string, ModelProfile>;
  /**
   * §5 — global context-compaction gate thresholds, as fractions of the
   * model's window in (0,1]. `pressure` is the gate (compact above it);
   * `target` is what compaction shrinks toward. A per-model catalog `profile`'s
   * `compaction` overrides these; both absent → hardcoded 0.8/0.7 defaults.
   * Flat-key config shape:
   *   compaction.pressure: 0.85
   *   compaction.target: 0.7
   *   compaction.gateDelta: 2000
   *
   * Phase 1c — `gateDelta` is a token headroom (integer ≥ 0, NOT a fraction)
   * added to the previous turn's actual input tokens so the gate fires slightly
   * before the next turn reaches pressure.
   *
   * Phase 3 — `autoCompact` gates the turn-end auto-compaction trigger
   * (default on since the context-economy Phase 2 eval-gated flip; set false
   * to disable). `retryOnOverflow`
   * (default on) turns a provider context-overflow rejection into a
   * compact-and-retry instead of a surfaced error. Flat-key config shape:
   *   compaction.autoCompact: false
   *   compaction.retryOnOverflow: false
   *
   * Phase 4 — `smallWindow` overrides small-window-mode auto-detection. `auto`
   * (default) applies the window (≤32k) + static-ratio (>40%) triggers; `on`
   * forces small-window mode; `off` disables it. Flat-key config shape:
   *   compaction.smallWindow: on
   *
   * Item 7 — `maxContextTokens` is an ABSOLUTE ceiling in tokens (integer > 0):
   * compaction fires above it even when the fractional gate has not been
   * reached, so a million-token window need not grow to 800k first. It applies
   * to both the pre-LLM gate and the turn-end trigger.
   * `minTailUserMessages` (integer ≥ 0, default 3) is the number of USER
   * messages every compaction keeps verbatim in the tail — `tailKeep` counts
   * rows of any role, and a tool-heavy tail can hold none. Flat-key shape:
   *   compaction.maxContextTokens: 400000
   *   compaction.minTailUserMessages: 3
   */
  // biome-ignore format: keep the option shape on one line for readability.
  compaction?: { pressure?: number; target?: number; gateDelta?: number; autoCompact?: boolean; retryOnOverflow?: boolean; smallWindow?: 'auto' | 'on' | 'off'; maxContextTokens?: number; minTailUserMessages?: number };
  /**
   * Fallback provider chain. When 2+ entries are present, `createLLM` wraps
   * them in a `ChainedProvider` with automatic cooldown-based failover.
   * The primary `provider`/`apiKey`/`model` fields are used when absent or
   * when only one entry is present. Config format:
   *   providers.0.provider: anthropic
   *   providers.0.apiKey: sk-ant-...
   *   providers.0.model: claude-opus-4-7
   *   providers.1.provider: openrouter
   *   providers.1.apiKey: sk-or-...
   */
  providers?: ProviderConfig[];
  /**
   * Active chat target. Managed by `ethos set` — do not hand-edit.
   * Takes precedence over `personality` for `ethos chat` and `ethos serve`.
   * @internal
   */
  activeContext?: ActiveContext;
  // Platform tokens — legacy scalar shape (single bot / single app). When
  // `telegram.bots` / `slack.apps` is present the list-shape wins and these
  // are ignored. Existing configs continue to boot unchanged via the
  // deprecation shim in `applyPlatformShim`.
  telegramToken?: string;
  discordToken?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  slackSigningSecret?: string;
  /**
   * Multi-bot routing: one bot entry per @handle. Serialized as dotted
   * indexed keys, matching `providers.<n>.<field>`. Identifiers (id,
   * bind.name) are restricted to `[A-Za-z0-9_-]+` so they round-trip
   * through the line-based config format unambiguously. Example:
   *   telegram.bots.0.token: 123:ABC
   *   telegram.bots.0.bind.type: personality
   *   telegram.bots.0.bind.name: researcher
   */
  telegram?: { bots: TelegramBotConfig[] };
  /**
   * Multi-app routing: one entry per Slack app. Same indexed-key shape
   * as `telegram.bots`. Identifier rules apply. Example:
   *   slack.apps.0.botToken: xoxb-…
   *   slack.apps.0.appToken: xapp-…
   *   slack.apps.0.signingSecret: …
   *   slack.apps.0.bind.type: personality
   *   slack.apps.0.bind.name: coder
   */
  slack?: { apps: SlackAppConfig[] };
  /** Per-team runtime knobs. Keyed by team manifest name (same identifier rules). */
  teams?: Record<string, TeamRuntimeConfig>;
  whatsapp?: WhatsAppConfig[];
  /**
   * Real-time voice bot routing (plan/phases/gap-voice-realtime.md §3(b)).
   * Same indexed-key shape as `telegram.bots`, but keyed on a room/number
   * `match` pattern instead of a token. Example:
   *   voice.bots.0.match: +15551234567
   *   voice.bots.0.bind.type: personality
   *   voice.bots.0.bind.name: receptionist
   * LiveKit transport keys live alongside the bots under `voice.livekit.*`;
   * SIP trunk keys (telephony) live under `voice.trunk.*`.
   */
  voice?: { bots: VoiceBotConfig[]; livekit?: VoiceLiveKitConfig; trunk?: VoiceTrunkConfig };
  // Email platform
  emailImapHost?: string;
  emailImapPort?: number;
  emailUser?: string;
  emailPassword?: string;
  emailSmtpHost?: string;
  emailSmtpPort?: number;
  /** Show per-turn timing summary after every response. */
  verbose?: boolean;
  /**
   * FW-10 — chat-surface verbosity. Cycles via `/verbose`.
   *   `quiet`    final assistant text only — pipe-clean output
   *   `default`  text + tool chips + spinner + usage line
   *   `verbose`  also surfaces internal tool_progress events
   *   `debug`    also dumps raw event JSON
   */
  displayVerbosity?: 'quiet' | 'default' | 'verbose' | 'debug';
  /**
   * FW-9 — what Enter does mid-turn.
   *   `interrupt` (default) — abort in-flight run, start a new turn
   *   `queue`     FIFO-queue the input, run it after the current turn ends
   *   `steer`     inject as `[USER STEER]` on the next iteration's user message
   */
  displayBusyInputMode?: 'interrupt' | 'queue' | 'steer';
  /**
   * FW-11 — tool feed arg truncation. 0 = no truncation (default).
   */
  displayToolPreviewLength?: number;
  /**
   * FW-5 — show resume hint on chat exit. Defaults to true.
   * Set to false via `display.resume_hint: false` in config.yaml.
   */
  displayResumeHint?: boolean;
  /**
   * FW-6 — how many turn pairs to show in the recap panel on resume.
   * 0 disables the panel. Default 3. Range 0–10.
   */
  displayResumeRecapTurns?: number;
  /**
   * Named skin override (see `@ethosagent/design-tokens` built-in skins:
   * `default`, `mono`, `paper`). When set, the resolved tokens are wired
   * into both the TUI SkinContext and the Web ConfigProvider so the
   * visible palette matches the user's choice on every surface.
   */
  skin?: string;
  /**
   * FW-8 — CLI toolset override. Set by `--toolsets <list>` for this
   * invocation only. Never written to config.yaml.
   * @internal
   */
  cliToolsets?: string[];
  /**
   * FW-8 — CLI skill preload. Set by `-s <list>` for this invocation only.
   * Never written to config.yaml.
   * @internal
   */
  cliSkills?: string[];
  /**
   * FW-8 — Pre-loaded content for cliSkills. Populated by applyCliOverrides
   * so the hook in wiring.ts avoids a second readFileSync path.
   * @internal
   */
  cliSkillContents?: string[];
  /**
   * FW-16 — user-defined shell shortcuts, registered as `[quick]` slash commands.
   * Config format:
   *   quick_commands.status.type: exec
   *   quick_commands.status.command: git status
   *   quick_commands.status.gateway: true
   *   quick_commands.status.channels: telegram,slack
   */
  quick_commands?: Record<string, QuickCommandConfig>;
  /**
   * Context-economy Phase 1 — static per-channel toolset narrowing for the
   * gateway (platform → allowed tool names, intersect-only with the
   * personality toolset). Config format:
   *   channel_toolsets.whatsapp: read_file,memory_read
   */
  channelToolsets?: Record<string, string[]>;
  /** Global retention settings. Per-category TTLs. */
  retention?: RetentionConfig;
  /**
   * Per-personality overrides. Keyed by personality ID.
   * Only `retention` sub-block is supported here.
   */
  personalitiesConfig?: Record<string, { retention?: RetentionConfig }>;
  /**
   * Chapter 1 safety: per-platform sender allowlist + pairing config.
   * Parsed from `channel_filter.<platform>.<field>: <value>` keys in config.yaml.
   * When absent, the gateway allows all inbound messages (backward compat).
   * When present, the gateway enforces sender allowlists, DM pairing codes,
   * mention gating, and context-visibility stripping per platform.
   */
  channelFilter?: ChannelFilterConfig;
  /**
   * FW-29 — skill evolver cron registration.
   *   `evolverCronEnabled` — when true, registers an in-process cron job that
   *     runs `ethos evolve run --quiet` on the configured schedule.
   *   `evolverSchedule`   — 5-field cron expression (default: "0 3 * * *").
   */
  evolverCronEnabled?: boolean;
  evolverSchedule?: string;
  /**
   * FW-13 — background sessions.
   *   `backgroundMaxConcurrent` — max simultaneous background agent tasks (default 4).
   *     Config key: background.max_concurrent
   *   `displayBellOnComplete` — ring the terminal bell when a background task finishes.
   *     Config key: display.bell_on_complete
   *
   * NOTE: `backgroundMaxConcurrent` is superseded by the durable engine's
   * `background.maxConcurrentJobs` (`BackgroundJobConfig`). It is retained only
   * for config round-trip stability and is no longer read by any surface.
   */
  backgroundMaxConcurrent?: number;
  /**
   * Background Sub-Agents job pool config (`background:` section). Parsed from
   * flat `background.<snake_case>` keys; see `BackgroundConfig` for the fields
   * and `backgroundDefaults()` for the fallbacks.
   */
  background?: BackgroundConfig;
  displayBellOnComplete?: boolean;
  displayDebugPanel?: boolean;
  displayDebugPanelModel?: string;
  /**
   * Per-surface opt-in for the "· remembered: …" capture notice (pillar B,
   * §3.3). CLI subtle-on when `true`; channels never surface it. Default
   * undefined (CLI decides its own default). Config key: display.memory_notices
   */
  displayMemoryNotices?: boolean;
  /**
   * Channel streaming draft edits (W3.1). Controls whether the gateway
   * delivers a turn's reply as live `editMessage` updates that grow in place
   * on edit-capable channels (Telegram, Slack):
   *   `'off'`  — never stream; one final message per turn.
   *   `'dms'`  — stream in direct messages only (default).
   *   `'all'`  — stream in DMs and group chats.
   * Config key: `display.streaming_edits`.
   */
  displayStreamingEdits?: 'off' | 'dms' | 'all';
  /**
   * context_compression F1 — auxiliary model wiring. `auxiliary.compression`
   * configures the cheap summarizer that `semantic_summary` uses to condense
   * long histories. Config keys:
   *   auxiliary.compression.model: claude-haiku-4-5-20251001
   *   auxiliary.compression.provider: anthropic   (optional — defaults to `provider`)
   *   auxiliary.compression.apiKey: sk-ant-...     (optional — defaults to `apiKey`)
   *   auxiliary.compression.baseUrl: https://...   (optional — defaults to `baseUrl`)
   *
   * tools-vision P2 — `auxiliary.vision` configures the vision-capable model
   * `vision_analyze` routes to when the personality's primary model can't
   * process images / PDFs. Same shape as `compression`.
   *
   * tools-web — `auxiliary.web` configures the model `web_extract` uses to
   * summarize large pages. Same shape as `vision`.
   */
  auxiliary?: {
    compression?: AuxiliaryCompressionConfig;
    vision?: AuxiliaryVisionConfig;
    web?: AuxiliaryWebConfig;
    asr?: { provider: string; model?: string; apiKey?: string; baseUrl?: string };
    tts?: { provider: string; model?: string; apiKey?: string; voice?: string; baseUrl?: string };
  };
  /** tools-web — web_search/web_extract backend selection. */
  web?: WebConfig;
  /**
   * Inbound webhooks. Each hookId maps to a personality + a bearer secret.
   * Exposes POST /webhook/<hookId> on the gateway when non-empty.
   *   webhooks.<hookId>.personalityId: researcher
   *   webhooks.<hookId>.secret: <bearer-secret>
   *   webhooks.<hookId>.sessionKey: <optional-stable-session-key>
   *   webhooks.<hookId>.prefilter: <script under ~/.ethos/scripts/, .sh or .py>
   *   webhooks.<hookId>.prefilterTimeoutSeconds: 30   (max 600)
   *   webhooks.<hookId>.mode: sync | ack              (default sync)
   */
  webhooks?: Record<string, WebhookHookConfig>;
  /**
   * Remote model catalog configuration. Controls how Ethos fetches and caches
   * the centralized model metadata catalog (capabilities, context windows, pricing).
   * Config keys:
   *   modelCatalog.enabled: false
   *   modelCatalog.url: https://custom.example.com/catalog.json
   *   modelCatalog.ttlHours: 12
   *   modelCatalog.providers.<id>.url: https://internal.example.com/anthropic.json
   */
  modelCatalog?: ModelCatalogConfig;
  /**
   * Log rotation settings. Controls when `~/.ethos/logs/errors.jsonl` is
   * rotated. Config keys:
   *   logs.rotation.maxBytes: 10485760
   *   logs.rotation.maxFiles: 5
   *   logs.rotation.enabled: false
   */
  logs?: {
    rotation?: {
      maxBytes?: number;
      maxFiles?: number;
      enabled?: boolean;
    };
  };
  /**
   * AWS integration configuration. Currently supports Secrets Manager
   * as a secrets backend. Config keys:
   *   aws.secrets.enabled: true
   *   aws.secrets.region: us-east-1
   *   aws.secrets.prefix: ethos/engineer
   *   aws.secrets.endpoint: http://localhost:4566
   */
  aws?: AwsConfig;
  /** Public-facing URL of the web UI. Used as the OAuth redirect base.
   *  Resolution: ETHOS_PUBLIC_URL env > config.yaml webBaseUrl > localhost default. */
  webBaseUrl?: string;
  /** Storage-layer settings. Supports at-rest encryption via
   *  `storage.encryption: true` in config.yaml (requires ETHOS_STORAGE_KEY), and
   *  a pluggable backend via `storage.backend` (default `fs`). Set `s3` to
   *  target AWS S3 (or an S3-compatible endpoint) when `backend: s3`. */
  storage?: {
    encryption?: boolean;
    backend?: 'fs' | 's3';
    s3?: {
      bucket?: string;
      region?: string;
      prefix?: string;
      endpoint?: string;
      forcePathStyle?: boolean;
    };
  };
  /** Whether to auto-install plugins from plugins.lock on personality load.
   *  Config key: plugins.auto_install */
  pluginsAutoInstall?: boolean;
  /**
   * Web admin panel gate. The `/admin` page and the `admin.*` RPC namespace
   * are available only when `admin.enabled: true` is set explicitly —
   * default false. Config key: admin.enabled
   */
  admin?: { enabled?: boolean };
  /**
   * Agent-to-Agent (A2A) surface gate. The `/a2a`, `/a2a-auth`, and well-known
   * card routes plus the `a2a_send` tool are live only when `a2a.enabled: true`
   * is set explicitly — default false (A2A stays opt-in). Config key:
   * a2a.enabled. Supersedes the deprecated `ETHOS_A2A_ENABLED` env override.
   */
  a2a?: { enabled?: boolean };
  /**
   * Governed-learning nightly pass scheduler (Phase 3c E). Default-off: when
   * absent or `enabled !== true`, no timer is created and behavior is
   * unchanged. When enabled, `ethos serve` / `ethos gateway start` fire the
   * nightly pass on `cron` (default `0 3 * * *`). Config keys:
   *   nightlyPass.enabled: true
   *   nightlyPass.cron: 0 3 * * *
   */
  nightlyPass?: { enabled?: boolean; cron?: string };
  /**
   * Proactive memory capture (memory-experience pillar B). Default-off. See
   * `MemoryCaptureConfig`. Parsed from flat `memoryCapture.<field>` keys.
   */
  memoryCapture?: MemoryCaptureConfig;
  /**
   * Bring-your-own-vault backend settings (memory-lifecycle L1). Read only
   * when `memory: vault`. See `MemoryVaultConfig`. Parsed from flat
   * `memoryVault.<field>` keys.
   */
  memoryVault?: MemoryVaultConfig;
  /**
   * Approve-before-store gate (memory-lifecycle L2). Default-off. See
   * `MemoryApprovalConfig`. Parsed from flat `memoryApproval.<field>` keys.
   */
  memoryApproval?: MemoryApprovalConfig;
  /**
   * Importance scoring + decay tuning (memory-experience pillar C). Defaults
   * applied by the nightly pass when absent. See `MemoryConsolidationConfig`.
   * Parsed from flat `memoryConsolidation.<field>` keys.
   */
  memoryConsolidation?: MemoryConsolidationConfig;
  /**
   * Weekly governed-learning digest scheduler (Phase 3e). Default-off: when
   * absent or `enabled !== true`, no timer is created and behavior is
   * unchanged. When enabled, `ethos serve` / `ethos gateway start` build the
   * digest on `cron` (default `0 9 * * 1` — Monday 9am). `recipients` is the
   * email allowlist for the optional `--email` delivery path. Config keys:
   *   weeklyDigest.enabled: true
   *   weeklyDigest.cron: 0 9 * * 1
   *   weeklyDigest.recipients: alice@example.com, bob@example.com
   */
  weeklyDigest?: { enabled?: boolean; cron?: string; recipients?: string[] };
  /**
   * Kanban poll loop: periodically checks the board for tasks assigned to
   * this agent's personalityId with status=ready, and enqueues a stimulus.
   * Also runs board housekeeping (promote, rollup, reclaim).
   *
   * Config format:
   *   kanbanPoll.enabled: true
   *   kanbanPoll.intervalMs: 5000
   *   kanbanPoll.boardPath: ~/.ethos/teams/myteam/board.db
   */
  kanbanPoll?: {
    enabled?: boolean;
    /** Poll interval in milliseconds. Default 5000. */
    intervalMs?: number;
    /** Path to the board.db file. When serve is started with --team, this
     *  defaults to the team's board path. */
    boardPath?: string;
  };
}

export function ethosDir(): string {
  const override = process.env.ETHOS_STATE_DIR;
  if (override) return override;
  return join(homedir(), '.ethos');
}

/**
 * Set to true once per process after emitting the pre-versioned-config
 * deprecation warning so we don't spam stderr across repeated reads.
 */
let preVersionedConfigWarned = false;

export async function readRawConfig(storage: Storage): Promise<EthosConfig | null> {
  const src = await storage.read(join(ethosDir(), 'config.yaml'));
  if (!src) return null;
  const parsed = parseConfigYaml(src);
  if (parsed.schemaVersion === undefined && !preVersionedConfigWarned) {
    preVersionedConfigWarned = true;
    console.warn(
      `\n[ethos] ~/.ethos/config.yaml is missing 'schemaVersion'. ` +
        `Treating as schemaVersion: ${CURRENT_ETHOS_CONFIG_SCHEMA_VERSION}. ` +
        `Re-running 'ethos setup' (or adding 'schemaVersion: ${CURRENT_ETHOS_CONFIG_SCHEMA_VERSION}' to the top of the file) ` +
        `will silence this warning and let future migrations key off the version.\n`,
    );
  }
  return parsed;
}

export async function readConfig(
  storage: Storage,
  secrets: SecretsResolver,
): Promise<EthosConfig | null> {
  const raw = await readRawConfig(storage);
  if (!raw) return null;
  return resolveConfigSecrets(raw, secrets);
}

export async function writeConfig(storage: Storage, config: EthosConfig): Promise<void> {
  await storage.mkdir(ethosDir());
  const lines = [
    `schemaVersion: ${config.schemaVersion ?? CURRENT_ETHOS_CONFIG_SCHEMA_VERSION}`,
    `provider: ${config.provider}`,
    `model: ${config.model}`,
    `apiKey: ${config.apiKey}`,
    `personality: ${config.personality}`,
  ];
  if (config.memory) lines.push(`memory: ${config.memory}`);
  if (config.baseUrl) lines.push(`baseUrl: ${config.baseUrl}`);
  if (config.apiVersion) lines.push(`apiVersion: ${config.apiVersion}`);
  if (config.contextWindow !== undefined) lines.push(`contextWindow: ${config.contextWindow}`);
  if (config.modelRouting) {
    for (const [id, model] of Object.entries(config.modelRouting)) {
      lines.push(`modelRouting.${id}: ${model}`);
    }
  }
  if (config.toolSettings) {
    for (const [id, settings] of Object.entries(config.toolSettings)) {
      const ws = settings.web_search;
      if (ws?.provider) lines.push(`toolSettings.${id}.web_search.provider: ${ws.provider}`);
      if (ws?.secret) lines.push(`toolSettings.${id}.web_search.secret: ${ws.secret}`);
    }
  }
  if (config.models) {
    for (const [modelKey, profile] of Object.entries(config.models)) {
      if (profile.sampling) {
        for (const key of ['temperature', 'topP', 'topK', 'minP'] as const) {
          const v = profile.sampling[key];
          if (v !== undefined) lines.push(`models.${modelKey}.sampling.${key}: ${v}`);
        }
      }
      if (profile.toolCallFormat !== undefined) {
        lines.push(`models.${modelKey}.toolCallFormat: ${profile.toolCallFormat}`);
      }
      if (profile.maxOutputTokens !== undefined) {
        lines.push(`models.${modelKey}.maxOutputTokens: ${profile.maxOutputTokens}`);
      }
    }
  }
  if (config.compaction) {
    if (config.compaction.pressure !== undefined) {
      lines.push(`compaction.pressure: ${config.compaction.pressure}`);
    }
    if (config.compaction.target !== undefined) {
      lines.push(`compaction.target: ${config.compaction.target}`);
    }
    if (config.compaction.gateDelta !== undefined) {
      lines.push(`compaction.gateDelta: ${config.compaction.gateDelta}`);
    }
    if (config.compaction.autoCompact !== undefined) {
      lines.push(`compaction.autoCompact: ${config.compaction.autoCompact}`);
    }
    if (config.compaction.retryOnOverflow !== undefined) {
      lines.push(`compaction.retryOnOverflow: ${config.compaction.retryOnOverflow}`);
    }
    if (config.compaction.smallWindow !== undefined) {
      lines.push(`compaction.smallWindow: ${config.compaction.smallWindow}`);
    }
    if (config.compaction.maxContextTokens !== undefined) {
      lines.push(`compaction.maxContextTokens: ${config.compaction.maxContextTokens}`);
    }
    if (config.compaction.minTailUserMessages !== undefined) {
      lines.push(`compaction.minTailUserMessages: ${config.compaction.minTailUserMessages}`);
    }
  }
  if (config.memoryConsolidation) {
    const m = config.memoryConsolidation;
    if (m.enabled !== undefined) lines.push(`memoryConsolidation.enabled: ${m.enabled}`);
    if (m.flushThreshold !== undefined)
      lines.push(`memoryConsolidation.flushThreshold: ${m.flushThreshold}`);
    if (m.timeboxMs !== undefined) lines.push(`memoryConsolidation.timeboxMs: ${m.timeboxMs}`);
    if (m.maxTokens !== undefined) lines.push(`memoryConsolidation.maxTokens: ${m.maxTokens}`);
    if (m.maxDeltaChars !== undefined)
      lines.push(`memoryConsolidation.maxDeltaChars: ${m.maxDeltaChars}`);
    if (m.minMessagesSinceFlush !== undefined)
      lines.push(`memoryConsolidation.minMessagesSinceFlush: ${m.minMessagesSinceFlush}`);
  }
  if (config.activeContext) {
    lines.push(`activeContext.type: ${config.activeContext.type}`);
    lines.push(`activeContext.name: ${config.activeContext.name}`);
  }
  if (config.telegramToken) lines.push(`telegramToken: ${config.telegramToken}`);
  if (config.discordToken) lines.push(`discordToken: ${config.discordToken}`);
  if (config.slackBotToken) lines.push(`slackBotToken: ${config.slackBotToken}`);
  if (config.slackAppToken) lines.push(`slackAppToken: ${config.slackAppToken}`);
  if (config.slackSigningSecret) lines.push(`slackSigningSecret: ${config.slackSigningSecret}`);
  if (config.emailImapHost) lines.push(`emailImapHost: ${config.emailImapHost}`);
  if (config.emailImapPort) lines.push(`emailImapPort: ${config.emailImapPort}`);
  if (config.emailUser) lines.push(`emailUser: ${config.emailUser}`);
  if (config.emailPassword) lines.push(`emailPassword: ${config.emailPassword}`);
  if (config.emailSmtpHost) lines.push(`emailSmtpHost: ${config.emailSmtpHost}`);
  if (config.emailSmtpPort) lines.push(`emailSmtpPort: ${config.emailSmtpPort}`);
  if (config.verbose) lines.push('verbose: true');
  if (config.displayVerbosity) lines.push(`display.verbosity: ${config.displayVerbosity}`);
  if (config.displayBusyInputMode)
    lines.push(`display.busy_input_mode: ${config.displayBusyInputMode}`);
  if (config.displayToolPreviewLength !== undefined)
    lines.push(`display.tool_preview_length: ${config.displayToolPreviewLength}`);
  if (config.displayResumeHint === false) lines.push('display.resume_hint: false');
  if (config.displayResumeRecapTurns !== undefined)
    lines.push(`display.resume_recap_turns: ${config.displayResumeRecapTurns}`);
  if (config.displayBellOnComplete) lines.push('display.bell_on_complete: true');
  if (config.displayMemoryNotices !== undefined)
    lines.push(`display.memory_notices: ${config.displayMemoryNotices}`);
  if (config.displayStreamingEdits)
    lines.push(`display.streaming_edits: ${config.displayStreamingEdits}`);
  if (config.displayDebugPanel) lines.push('display.debug_panel: true');
  if (config.displayDebugPanelModel)
    lines.push(`display.debug_panel_model: ${config.displayDebugPanelModel}`);
  if (config.skin) lines.push(`skin: ${config.skin}`);
  if (config.retention) {
    for (const [key, val] of retentionToLines(config.retention)) {
      lines.push(`retention.${key}: ${val}`);
    }
  }
  if (config.personalitiesConfig) {
    for (const [pid, pcfg] of Object.entries(config.personalitiesConfig)) {
      if (pcfg.retention) {
        for (const [key, val] of retentionToLines(pcfg.retention)) {
          lines.push(`personalities.${pid}.retention.${key}: ${val}`);
        }
      }
    }
  }
  if (config.evolverCronEnabled) lines.push('evolver.cron_enabled: true');
  if (config.evolverSchedule) lines.push(`evolver.schedule: ${config.evolverSchedule}`);
  if (config.backgroundMaxConcurrent !== undefined)
    lines.push(`background.max_concurrent: ${config.backgroundMaxConcurrent}`);
  if (config.background) {
    for (const [key, val] of backgroundToLines(config.background)) {
      lines.push(`background.${key}: ${val}`);
    }
  }
  if (config.telegram?.bots.length) {
    for (const [i, bot] of config.telegram.bots.entries()) {
      if (bot.id) lines.push(`telegram.bots.${i}.id: ${bot.id}`);
      lines.push(`telegram.bots.${i}.token: ${bot.token}`);
      lines.push(`telegram.bots.${i}.bind.type: ${bot.bind.type}`);
      lines.push(`telegram.bots.${i}.bind.name: ${bot.bind.name}`);
      if (bot.bind.allowSlashSwitch) {
        lines.push(`telegram.bots.${i}.bind.allowSlashSwitch: true`);
      }
    }
  }
  if (config.slack?.apps.length) {
    for (const [i, app] of config.slack.apps.entries()) {
      if (app.id) lines.push(`slack.apps.${i}.id: ${app.id}`);
      lines.push(`slack.apps.${i}.botToken: ${app.botToken}`);
      lines.push(`slack.apps.${i}.appToken: ${app.appToken}`);
      lines.push(`slack.apps.${i}.signingSecret: ${app.signingSecret}`);
      lines.push(`slack.apps.${i}.bind.type: ${app.bind.type}`);
      lines.push(`slack.apps.${i}.bind.name: ${app.bind.name}`);
      if (app.bind.allowSlashSwitch) {
        lines.push(`slack.apps.${i}.bind.allowSlashSwitch: true`);
      }
    }
  }
  if (config.whatsapp?.length) {
    for (const [i, wa] of config.whatsapp.entries()) {
      if (wa.id) lines.push(`whatsapp.${i}.id: ${wa.id}`);
      if (wa.default_mode) lines.push(`whatsapp.${i}.default_mode: ${wa.default_mode}`);
      if (wa.session_dir) lines.push(`whatsapp.${i}.session_dir: ${wa.session_dir}`);
      if (wa.phone_number) lines.push(`whatsapp.${i}.phone_number: ${wa.phone_number}`);
      if (wa.allowed_numbers && wa.allowed_numbers.length > 0) {
        lines.push(`whatsapp.${i}.allowed_numbers: ${wa.allowed_numbers.join(',')}`);
      }
      if (wa.bind) {
        lines.push(`whatsapp.${i}.bind.type: ${wa.bind.type}`);
        lines.push(`whatsapp.${i}.bind.name: ${wa.bind.name}`);
        if (wa.bind.allowSlashSwitch) {
          lines.push(`whatsapp.${i}.bind.allowSlashSwitch: true`);
        }
      }
    }
  }
  if (config.voice) {
    for (const [i, bot] of config.voice.bots.entries()) {
      if (bot.id) lines.push(`voice.bots.${i}.id: ${bot.id}`);
      lines.push(`voice.bots.${i}.match: ${bot.match}`);
      lines.push(`voice.bots.${i}.bind.type: ${bot.bind.type}`);
      lines.push(`voice.bots.${i}.bind.name: ${bot.bind.name}`);
      if (bot.bind.allowSlashSwitch) {
        lines.push(`voice.bots.${i}.bind.allowSlashSwitch: true`);
      }
    }
    if (config.voice.livekit) {
      lines.push(`voice.livekit.url: ${config.voice.livekit.url}`);
      lines.push(`voice.livekit.apiKey: ${config.voice.livekit.apiKey}`);
      lines.push(`voice.livekit.apiSecret: ${config.voice.livekit.apiSecret}`);
    }
    if (config.voice.trunk) {
      const t = config.voice.trunk;
      lines.push(`voice.trunk.provider: ${t.provider}`);
      lines.push(`voice.trunk.trunkId: ${t.trunkId}`);
      if (t.fromNumber) lines.push(`voice.trunk.fromNumber: ${t.fromNumber}`);
      if (t.username) lines.push(`voice.trunk.username: ${t.username}`);
      if (t.password) lines.push(`voice.trunk.password: ${t.password}`);
    }
  }
  if (config.teams) {
    for (const [name, tcfg] of Object.entries(config.teams)) {
      if (tcfg.autoStop) lines.push(`teams.${name}.autoStop: true`);
    }
  }
  if (config.quick_commands) {
    for (const [name, qc] of Object.entries(config.quick_commands)) {
      lines.push(`quick_commands.${name}.type: ${qc.type}`);
      if (qc.type === 'exec') {
        lines.push(`quick_commands.${name}.command: ${qc.command}`);
      } else {
        lines.push(`quick_commands.${name}.reply: ${qc.reply}`);
      }
      if (qc.gateway) lines.push(`quick_commands.${name}.gateway: true`);
      if (qc.channels && qc.channels.length > 0) {
        lines.push(`quick_commands.${name}.channels: ${qc.channels.join(',')}`);
      }
    }
  }
  if (config.channelToolsets) {
    for (const [platform, tools] of Object.entries(config.channelToolsets)) {
      lines.push(`channel_toolsets.${platform}: ${tools.join(',')}`);
    }
  }
  if (config.channelFilter) {
    for (const [platform, cfg] of Object.entries(config.channelFilter)) {
      if (cfg.enabled === false) lines.push(`channel_filter.${platform}.enable: false`);
      if (cfg.ownerUserId) lines.push(`channel_filter.${platform}.ownerUserId: ${cfg.ownerUserId}`);
      if (cfg.recipientAllowlist && cfg.recipientAllowlist.length > 0) {
        lines.push(
          `channel_filter.${platform}.recipientAllowlist: ${cfg.recipientAllowlist.join(',')}`,
        );
      }
      if (cfg.dmPolicy) lines.push(`channel_filter.${platform}.dmPolicy: ${cfg.dmPolicy}`);
      if (cfg.contextVisibility)
        lines.push(`channel_filter.${platform}.contextVisibility: ${cfg.contextVisibility}`);
    }
  }
  if (config.providers && config.providers.length > 0) {
    for (const [i, p] of config.providers.entries()) {
      lines.push(`providers.${i}.provider: ${p.provider}`);
      lines.push(`providers.${i}.apiKey: ${p.apiKey}`);
      if (p.model) lines.push(`providers.${i}.model: ${p.model}`);
      if (p.baseUrl) lines.push(`providers.${i}.baseUrl: ${p.baseUrl}`);
      if (p.apiVersion) lines.push(`providers.${i}.apiVersion: ${p.apiVersion}`);
    }
  }
  if (config.auxiliary?.compression) {
    const c = config.auxiliary.compression;
    lines.push(`auxiliary.compression.model: ${c.model}`);
    if (c.provider) lines.push(`auxiliary.compression.provider: ${c.provider}`);
    if (c.apiKey) lines.push(`auxiliary.compression.apiKey: ${c.apiKey}`);
    if (c.baseUrl) lines.push(`auxiliary.compression.baseUrl: ${c.baseUrl}`);
  }
  if (config.auxiliary?.vision) {
    const v = config.auxiliary.vision;
    lines.push(`auxiliary.vision.model: ${v.model}`);
    if (v.provider) lines.push(`auxiliary.vision.provider: ${v.provider}`);
    if (v.apiKey) lines.push(`auxiliary.vision.apiKey: ${v.apiKey}`);
    if (v.baseUrl) lines.push(`auxiliary.vision.baseUrl: ${v.baseUrl}`);
  }
  if (config.auxiliary?.web) {
    const w = config.auxiliary.web;
    lines.push(`auxiliary.web.model: ${w.model}`);
    if (w.provider) lines.push(`auxiliary.web.provider: ${w.provider}`);
    if (w.apiKey) lines.push(`auxiliary.web.apiKey: ${w.apiKey}`);
    if (w.baseUrl) lines.push(`auxiliary.web.baseUrl: ${w.baseUrl}`);
  }
  if (config.auxiliary?.asr) {
    const a = config.auxiliary.asr;
    lines.push(`auxiliary.asr.provider: ${a.provider}`);
    if (a.model) lines.push(`auxiliary.asr.model: ${a.model}`);
    if (a.apiKey) lines.push(`auxiliary.asr.apiKey: ${a.apiKey}`);
    if (a.baseUrl) lines.push(`auxiliary.asr.baseUrl: ${a.baseUrl}`);
  }
  if (config.auxiliary?.tts) {
    const t = config.auxiliary.tts;
    lines.push(`auxiliary.tts.provider: ${t.provider}`);
    if (t.model) lines.push(`auxiliary.tts.model: ${t.model}`);
    if (t.apiKey) lines.push(`auxiliary.tts.apiKey: ${t.apiKey}`);
    if (t.voice) lines.push(`auxiliary.tts.voice: ${t.voice}`);
    if (t.baseUrl) lines.push(`auxiliary.tts.baseUrl: ${t.baseUrl}`);
  }
  if (config.web?.search_backend) lines.push(`web.search_backend: ${config.web.search_backend}`);
  if (config.web?.extract_backend) lines.push(`web.extract_backend: ${config.web.extract_backend}`);
  if (config.webhooks) {
    for (const [hookId, hook] of Object.entries(config.webhooks)) {
      lines.push(`webhooks.${hookId}.personalityId: ${hook.personalityId}`);
      lines.push(`webhooks.${hookId}.secret: ${hook.secret}`);
      if (hook.sessionKey) lines.push(`webhooks.${hookId}.sessionKey: ${hook.sessionKey}`);
      if (hook.prefilter) lines.push(`webhooks.${hookId}.prefilter: ${hook.prefilter}`);
      if (hook.prefilterTimeoutSeconds !== undefined)
        lines.push(`webhooks.${hookId}.prefilterTimeoutSeconds: ${hook.prefilterTimeoutSeconds}`);
      if (hook.mode) lines.push(`webhooks.${hookId}.mode: ${hook.mode}`);
    }
  }
  if (config.modelCatalog) {
    if (config.modelCatalog.enabled === false) lines.push('modelCatalog.enabled: false');
    if (config.modelCatalog.url) lines.push(`modelCatalog.url: ${config.modelCatalog.url}`);
    if (config.modelCatalog.ttlHours !== undefined)
      lines.push(`modelCatalog.ttlHours: ${config.modelCatalog.ttlHours}`);
    if (config.modelCatalog.providers) {
      for (const [id, p] of Object.entries(config.modelCatalog.providers)) {
        lines.push(`modelCatalog.providers.${id}.url: ${p.url}`);
      }
    }
  }
  if (config.logs?.rotation) {
    const r = config.logs.rotation;
    if (r.maxBytes !== undefined) lines.push(`logs.rotation.maxBytes: ${r.maxBytes}`);
    if (r.maxFiles !== undefined) lines.push(`logs.rotation.maxFiles: ${r.maxFiles}`);
    if (r.enabled === false) lines.push('logs.rotation.enabled: false');
  }
  if (config.aws?.secrets) {
    const s = config.aws.secrets;
    if (s.enabled !== undefined) lines.push(`aws.secrets.enabled: ${s.enabled}`);
    if (s.region) lines.push(`aws.secrets.region: ${s.region}`);
    if (s.prefix) lines.push(`aws.secrets.prefix: ${s.prefix}`);
    if (s.endpoint) lines.push(`aws.secrets.endpoint: ${s.endpoint}`);
  }
  if (config.webBaseUrl) lines.push(`webBaseUrl: ${config.webBaseUrl}`);
  if (config.pluginsAutoInstall !== undefined)
    lines.push(`plugins.auto_install: ${config.pluginsAutoInstall}`);
  if (config.admin?.enabled !== undefined) lines.push(`admin.enabled: ${config.admin.enabled}`);
  if (config.a2a?.enabled !== undefined) lines.push(`a2a.enabled: ${config.a2a.enabled}`);
  if (config.nightlyPass) {
    if (config.nightlyPass.enabled !== undefined)
      lines.push(`nightlyPass.enabled: ${config.nightlyPass.enabled}`);
    if (config.nightlyPass.cron) lines.push(`nightlyPass.cron: ${config.nightlyPass.cron}`);
  }
  if (config.memoryCapture) {
    const mc = config.memoryCapture;
    if (mc.enabled !== undefined) lines.push(`memoryCapture.enabled: ${mc.enabled}`);
    if (mc.model) lines.push(`memoryCapture.model: ${mc.model}`);
    if (mc.provider) lines.push(`memoryCapture.provider: ${mc.provider}`);
    if (mc.apiKey) lines.push(`memoryCapture.apiKey: ${mc.apiKey}`);
    if (mc.baseUrl) lines.push(`memoryCapture.baseUrl: ${mc.baseUrl}`);
    if (mc.maxPerHour !== undefined) lines.push(`memoryCapture.maxPerHour: ${mc.maxPerHour}`);
    if (mc.maxPerDay !== undefined) lines.push(`memoryCapture.maxPerDay: ${mc.maxPerDay}`);
  }
  if (config.memoryVault) {
    const mv = config.memoryVault;
    if (mv.path) lines.push(`memoryVault.path: ${mv.path}`);
    if (mv.agentDir) lines.push(`memoryVault.agentDir: ${mv.agentDir}`);
    if (mv.prefetch && mv.prefetch.length > 0)
      lines.push(`memoryVault.prefetch: ${mv.prefetch.join(', ')}`);
    if (mv.exclude && mv.exclude.length > 0)
      lines.push(`memoryVault.exclude: ${mv.exclude.join(', ')}`);
  }
  if (config.memoryApproval) {
    const ma = config.memoryApproval;
    if (ma.mode !== undefined) lines.push(`memoryApproval.mode: ${ma.mode}`);
    if (ma.cap !== undefined) lines.push(`memoryApproval.cap: ${ma.cap}`);
    if (ma.ttlDays !== undefined) lines.push(`memoryApproval.ttlDays: ${ma.ttlDays}`);
  }
  if (config.memoryConsolidation) {
    const mco = config.memoryConsolidation;
    if (mco.halfLifeDays !== undefined)
      lines.push(`memoryConsolidation.halfLifeDays: ${mco.halfLifeDays}`);
    if (mco.threshold !== undefined) lines.push(`memoryConsolidation.threshold: ${mco.threshold}`);
    if (mco.exemptUser !== undefined)
      lines.push(`memoryConsolidation.exemptUser: ${mco.exemptUser}`);
  }
  if (config.weeklyDigest) {
    if (config.weeklyDigest.enabled !== undefined)
      lines.push(`weeklyDigest.enabled: ${config.weeklyDigest.enabled}`);
    if (config.weeklyDigest.cron) lines.push(`weeklyDigest.cron: ${config.weeklyDigest.cron}`);
    if (config.weeklyDigest.recipients && config.weeklyDigest.recipients.length > 0)
      lines.push(`weeklyDigest.recipients: ${config.weeklyDigest.recipients.join(',')}`);
  }
  if (config.kanbanPoll) {
    if (config.kanbanPoll.enabled !== undefined)
      lines.push(`kanbanPoll.enabled: ${config.kanbanPoll.enabled}`);
    if (config.kanbanPoll.intervalMs !== undefined)
      lines.push(`kanbanPoll.intervalMs: ${config.kanbanPoll.intervalMs}`);
    if (config.kanbanPoll.boardPath !== undefined)
      lines.push(`kanbanPoll.boardPath: ${config.kanbanPoll.boardPath}`);
  }
  await storage.write(join(ethosDir(), 'config.yaml'), `${lines.join('\n')}\n`, { mode: 0o600 });
}

export async function resolveConfigSecrets(
  config: EthosConfig,
  secrets: SecretsResolver,
): Promise<EthosConfig> {
  const r = { ...config };
  r.apiKey = await resolveSecretValue(r.apiKey, secrets);
  if (r.baseUrl) r.baseUrl = await resolveSecretValue(r.baseUrl, secrets);
  if (r.telegramToken) r.telegramToken = await resolveSecretValue(r.telegramToken, secrets);
  if (r.discordToken) r.discordToken = await resolveSecretValue(r.discordToken, secrets);
  if (r.slackBotToken) r.slackBotToken = await resolveSecretValue(r.slackBotToken, secrets);
  if (r.slackAppToken) r.slackAppToken = await resolveSecretValue(r.slackAppToken, secrets);
  if (r.slackSigningSecret)
    r.slackSigningSecret = await resolveSecretValue(r.slackSigningSecret, secrets);
  if (r.emailPassword) r.emailPassword = await resolveSecretValue(r.emailPassword, secrets);
  if (r.providers) {
    r.providers = await Promise.all(
      r.providers.map(async (p) => ({
        ...p,
        apiKey: await resolveSecretValue(p.apiKey, secrets),
      })),
    );
  }
  if (r.telegram?.bots) {
    r.telegram = {
      ...r.telegram,
      bots: await Promise.all(
        r.telegram.bots.map(async (bot) => ({
          ...bot,
          token: await resolveSecretValue(bot.token, secrets),
        })),
      ),
    };
  }
  if (r.slack?.apps) {
    r.slack = {
      ...r.slack,
      apps: await Promise.all(
        r.slack.apps.map(async (app) => ({
          ...app,
          botToken: await resolveSecretValue(app.botToken, secrets),
          appToken: await resolveSecretValue(app.appToken, secrets),
          signingSecret: await resolveSecretValue(app.signingSecret, secrets),
        })),
      ),
    };
  }
  if (r.auxiliary?.compression?.apiKey) {
    r.auxiliary = {
      ...r.auxiliary,
      compression: {
        ...r.auxiliary.compression,
        apiKey: await resolveSecretValue(r.auxiliary.compression.apiKey, secrets),
      },
    };
  }
  if (r.auxiliary?.vision?.apiKey) {
    r.auxiliary = {
      ...r.auxiliary,
      vision: {
        ...r.auxiliary.vision,
        apiKey: await resolveSecretValue(r.auxiliary.vision.apiKey, secrets),
      },
    };
  }
  return r;
}

function parseConfigYaml(src: string): EthosConfig {
  const kv: Record<string, string> = {};
  const modelRouting: Record<string, string> = {};
  const toolSettings: ToolSettingsMap = {};
  const activeContextKv: Record<string, string> = {};
  const providersKv: Record<number, Record<string, string>> = {};
  const retentionKv: Record<string, string> = {};
  const personalitiesRetKv: Record<string, Record<string, string>> = {};
  const displayKv: Record<string, string> = {};
  const evolverKv: Record<string, string> = {};
  const backgroundKv: Record<string, string> = {};
  const auxiliaryCompressionKv: Record<string, string> = {};
  const auxiliaryVisionKv: Record<string, string> = {};
  const auxiliaryWebKv: Record<string, string> = {};
  const auxiliaryAsrKv: Record<string, string> = {};
  const auxiliaryTtsKv: Record<string, string> = {};
  const webKv: Record<string, string> = {};
  const modelCatalogKv: Record<string, string> = {};
  const modelCatalogProvidersKv: Record<string, Record<string, string>> = {};
  // §7 — models.<providerId>/<modelId>.<field>: <value>. Keyed by the full
  // `<providerId>/<modelId>` string; field path → raw value.
  const modelsKv: Record<string, Record<string, string>> = {};
  // §5 — global compaction.<field>: <value> (pressure | target | ...flags).
  const compactionKv: Record<string, string> = {};
  // Phase 3 — memoryConsolidation.<field>: <value> (silent flush config).
  const memoryConsolidationKv: Record<string, string> = {};
  const logsRotationKv: Record<string, string> = {};
  const awsSecretsKv: Record<string, string> = {};
  // Indexed list shapes: telegram.bots.<n>.<field> and slack.apps.<n>.<field>,
  // plus their nested `.bind.<field>` sub-keys. Per-team config keyed by name.
  const telegramBotsKv: Record<number, Record<string, string>> = {};
  const slackAppsKv: Record<number, Record<string, string>> = {};
  const whatsappKv: Record<number, Record<string, string>> = {};
  const voiceBotsKv: Record<number, Record<string, string>> = {};
  const voiceLiveKitKv: Record<string, string> = {};
  const voiceTrunkKv: Record<string, string> = {};
  const teamsKv: Record<string, Record<string, string>> = {};
  const webhooksKv: Record<string, Record<string, string>> = {};
  // FW-16 — quick_commands.<name>.<field>: <value>
  const qcKv: Record<string, Record<string, string>> = {};
  // Context-economy Phase 1 — channel_toolsets.<platform>: <tool,list>
  const channelToolsetsKv: Record<string, string> = {};
  // Chapter 1 safety: channel_filter.<platform>.<field>: <value>
  const channelFilterKv: Record<string, Record<string, string>> = {};
  for (const line of src.split('\n')) {
    // telegram.bots.<index>.bind.<field>: <value>
    const tbind = line.match(/^telegram\.bots\.(\d+)\.bind\.(\S+):\s*(.+)$/);
    if (tbind) {
      const idx = Number(tbind[1]);
      telegramBotsKv[idx] ??= {};
      telegramBotsKv[idx][`bind.${tbind[2]}`] = tbind[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // telegram.bots.<index>.<field>: <value>
    const tbot = line.match(/^telegram\.bots\.(\d+)\.(\S+):\s*(.+)$/);
    if (tbot) {
      const idx = Number(tbot[1]);
      telegramBotsKv[idx] ??= {};
      telegramBotsKv[idx][tbot[2]] = tbot[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // slack.apps.<index>.bind.<field>: <value>
    const sbind = line.match(/^slack\.apps\.(\d+)\.bind\.(\S+):\s*(.+)$/);
    if (sbind) {
      const idx = Number(sbind[1]);
      slackAppsKv[idx] ??= {};
      slackAppsKv[idx][`bind.${sbind[2]}`] = sbind[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // slack.apps.<index>.<field>: <value>
    const sapp = line.match(/^slack\.apps\.(\d+)\.(\S+):\s*(.+)$/);
    if (sapp) {
      const idx = Number(sapp[1]);
      slackAppsKv[idx] ??= {};
      slackAppsKv[idx][sapp[2]] = sapp[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // whatsapp.<index>.bind.<field>: <value>
    const wabind = line.match(/^whatsapp\.(\d+)\.bind\.(\S+):\s*(.+)$/);
    if (wabind) {
      const idx = Number(wabind[1]);
      whatsappKv[idx] ??= {};
      whatsappKv[idx][`bind.${wabind[2]}`] = wabind[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // whatsapp.<index>.<field>: <value>
    const wa = line.match(/^whatsapp\.(\d+)\.(\S+):\s*(.+)$/);
    if (wa) {
      const idx = Number(wa[1]);
      whatsappKv[idx] ??= {};
      whatsappKv[idx][wa[2]] = wa[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // voice.bots.<index>.bind.<field>: <value>
    const vbind = line.match(/^voice\.bots\.(\d+)\.bind\.(\S+):\s*(.+)$/);
    if (vbind) {
      const idx = Number(vbind[1]);
      voiceBotsKv[idx] ??= {};
      voiceBotsKv[idx][`bind.${vbind[2]}`] = vbind[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // voice.bots.<index>.<field>: <value>
    const vbot = line.match(/^voice\.bots\.(\d+)\.(\S+):\s*(.+)$/);
    if (vbot) {
      const idx = Number(vbot[1]);
      voiceBotsKv[idx] ??= {};
      voiceBotsKv[idx][vbot[2]] = vbot[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // voice.livekit.<field>: <value>
    const vlk = line.match(/^voice\.livekit\.(\w+):\s*(.+)$/);
    if (vlk) {
      voiceLiveKitKv[vlk[1]] = vlk[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // voice.trunk.<field>: <value>
    const vtr = line.match(/^voice\.trunk\.(\w+):\s*(.+)$/);
    if (vtr) {
      voiceTrunkKv[vtr[1]] = vtr[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // teams.<name>.<field>: <value>
    const tcfg = line.match(/^teams\.([^.]+)\.(\S+):\s*(.+)$/);
    if (tcfg) {
      const name = tcfg[1];
      teamsKv[name] ??= {};
      teamsKv[name][tcfg[2]] = tcfg[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // webhooks.<hookId>.<field>: <value>
    const whook = line.match(/^webhooks\.([^.]+)\.(\S+):\s*(.+)$/);
    if (whook) {
      const hookId = whook[1];
      webhooksKv[hookId] ??= {};
      webhooksKv[hookId][whook[2]] = whook[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // providers.<index>.<field>: <value>
    const prov = line.match(/^providers\.(\d+)\.(\S+):\s*(.+)$/);
    if (prov) {
      const idx = Number(prov[1]);
      providersKv[idx] ??= {};
      const field = prov[2]?.trim() ?? '';
      if (field) providersKv[idx][field] = prov[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // personalities.<id>.retention.<field>: <value>  (must come before modelRouting)
    const perp = line.match(/^personalities\.([^.]+)\.retention\.(events\.)?(\w+):\s*(.+)$/);
    if (perp) {
      const pid = perp[1];
      const key = `${perp[2] ?? ''}${perp[3]}`;
      personalitiesRetKv[pid] ??= {};
      personalitiesRetKv[pid][key] = perp[4].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // retention.<field>: <value>  or  retention.events.<subfield>: <value>
    const ret = line.match(/^retention\.(events\.)?(\w+):\s*(.+)$/);
    if (ret) {
      retentionKv[`${ret[1] ?? ''}${ret[2]}`] = ret[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // display.<field>: <value>
    const disp = line.match(/^display\.([a-z_]+):\s*(.+)$/);
    if (disp) {
      displayKv[disp[1]] = disp[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // evolver.<field>: <value>
    const evlv = line.match(/^evolver\.([a-z_]+):\s*(.+)$/);
    if (evlv) {
      evolverKv[evlv[1]] = evlv[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // background.<field>: <value>
    const bg = line.match(/^background\.([a-z_]+):\s*(.+)$/);
    if (bg) {
      backgroundKv[bg[1]] = bg[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // auxiliary.compression.<field>: <value>
    const auxc = line.match(/^auxiliary\.compression\.(\w+):\s*(.+)$/);
    if (auxc) {
      auxiliaryCompressionKv[auxc[1]] = auxc[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // auxiliary.vision.<field>: <value>
    const auxv = line.match(/^auxiliary\.vision\.(\w+):\s*(.+)$/);
    if (auxv) {
      auxiliaryVisionKv[auxv[1]] = auxv[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // auxiliary.web.<field>: <value>
    const auxw = line.match(/^auxiliary\.web\.(\w+):\s*(.+)$/);
    if (auxw) {
      auxiliaryWebKv[auxw[1]] = auxw[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // auxiliary.asr.<field>: <value>
    const auxAsr = line.match(/^auxiliary\.asr\.(\w+):\s*(.+)$/);
    if (auxAsr) {
      auxiliaryAsrKv[auxAsr[1]] = auxAsr[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // auxiliary.tts.<field>: <value>
    const auxTts = line.match(/^auxiliary\.tts\.(\w+):\s*(.+)$/);
    if (auxTts) {
      auxiliaryTtsKv[auxTts[1]] = auxTts[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // web.<field>: <value>
    const web = line.match(/^web\.(\w+):\s*(.+)$/);
    if (web) {
      webKv[web[1]] = web[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // logs.rotation.<field>: <value>
    const lr = line.match(/^logs\.rotation\.(\w+):\s*(.+)$/);
    if (lr) {
      logsRotationKv[lr[1]] = lr[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // aws.secrets.<field>: <value>
    const awss = line.match(/^aws\.secrets\.(\w+):\s*(.+)$/);
    if (awss) {
      awsSecretsKv[awss[1]] = awss[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // modelCatalog.providers.<id>.url: <value>
    const mcp = line.match(/^modelCatalog\.providers\.([^.]+)\.(\S+):\s*(.+)$/);
    if (mcp) {
      const providerId = mcp[1];
      modelCatalogProvidersKv[providerId] ??= {};
      modelCatalogProvidersKv[providerId][mcp[2]] = mcp[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // modelCatalog.<field>: <value>
    const mc = line.match(/^modelCatalog\.(\w+):\s*(.+)$/);
    if (mc) {
      modelCatalogKv[mc[1]] = mc[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // models.<providerId>/<modelId>.<field>: <value>  (§7 per-model profile).
    // The model key is greedy `.+` so ids containing `/` and `.` round-trip;
    // the trailing field is one of a fixed set, anchored so the split is
    // unambiguous.
    const mdl = line.match(
      /^models\.(.+)\.(sampling\.(?:temperature|topP|topK|minP)|toolCallFormat|maxOutputTokens):\s*(.+)$/,
    );
    if (mdl) {
      const modelKey = mdl[1];
      modelsKv[modelKey] ??= {};
      modelsKv[modelKey][mdl[2]] = mdl[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // §5 / Phase 3 — compaction.<field>: <value>  (global gate + turn-end flags).
    const cmp = line.match(
      /^compaction\.(pressure|target|gateDelta|autoCompact|retryOnOverflow|smallWindow|maxContextTokens|minTailUserMessages):\s*(.+)$/,
    );
    if (cmp) {
      compactionKv[cmp[1]] = cmp[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // Phase 3 — memoryConsolidation.<field>: <value>  (silent flush config).
    const mcz = line.match(
      /^memoryConsolidation\.(enabled|flushThreshold|timeboxMs|maxTokens|maxDeltaChars|minMessagesSinceFlush):\s*(.+)$/,
    );
    if (mcz) {
      memoryConsolidationKv[mcz[1]] = mcz[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // modelRouting.<personality>: <model>
    const mr = line.match(/^modelRouting\.(\S+):\s*(.+)$/);
    if (mr) {
      modelRouting[mr[1].trim()] = mr[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // toolSettings.<personality|_default>.web_search.<provider|secret>: <value>
    const tsMatch = line.match(/^toolSettings\.([^.]+)\.web_search\.(provider|secret):\s*(.+)$/);
    if (tsMatch) {
      const id = tsMatch[1].trim();
      const field = tsMatch[2];
      const val = tsMatch[3].trim().replace(/^["']|["']$/g, '');
      const slot = toolSettings[id] ?? {};
      toolSettings[id] = slot;
      const ws = slot.web_search ?? {};
      slot.web_search = ws;
      if (field === 'provider') {
        if (val === 'exa' || val === 'tavily' || val === 'brave') ws.provider = val;
      } else {
        ws.secret = val;
      }
      continue;
    }
    // activeContext.type / activeContext.name
    const ac = line.match(/^activeContext\.(\S+):\s*(.+)$/);
    if (ac) {
      activeContextKv[ac[1].trim()] = ac[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // channel_filter.<platform>.<field>: <value>
    const cf = line.match(/^channel_filter\.([^.]+)\.(\S+):\s*(.+)$/);
    if (cf) {
      const platform = cf[1];
      channelFilterKv[platform] ??= {};
      (channelFilterKv[platform] as Record<string, string>)[cf[2]] = cf[3]
        .trim()
        .replace(/^["']|["']$/g, '');
      continue;
    }
    // quick_commands.<name>.<field>: <value>
    const qc = line.match(/^quick_commands\.([^.]+)\.(\S+):\s*(.+)$/);
    if (qc) {
      const qname = qc[1];
      qcKv[qname] ??= {};
      (qcKv[qname] as Record<string, string>)[qc[2]] = qc[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // channel_toolsets.<platform>: <comma-separated tool names>
    const ct = line.match(/^channel_toolsets\.([^.:\s]+):\s*(.+)$/);
    if (ct) {
      channelToolsetsKv[ct[1]] = ct[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // storage.<field>: <value>
    const stg = line.match(/^storage\.([\w.]+):\s*(.+)$/);
    if (stg) {
      kv[`storage.${stg[1]}`] = stg[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // plugins.auto_install: <value>
    const pai = line.match(/^plugins\.auto_install:\s*(.+)$/);
    if (pai) {
      kv['plugins.auto_install'] = pai[1].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // admin.enabled: <value>
    const adm = line.match(/^admin\.enabled:\s*(.+)$/);
    if (adm) {
      kv['admin.enabled'] = adm[1].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // a2a.enabled: <value>
    const a2a = line.match(/^a2a\.enabled:\s*(.+)$/);
    if (a2a) {
      kv['a2a.enabled'] = a2a[1].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // nightlyPass.<field>: <value>
    const np = line.match(/^nightlyPass\.(\w+):\s*(.+)$/);
    if (np) {
      kv[`nightlyPass.${np[1]}`] = np[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // weeklyDigest.<field>: <value>
    const wd = line.match(/^weeklyDigest\.(\w+):\s*(.+)$/);
    if (wd) {
      kv[`weeklyDigest.${wd[1]}`] = wd[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // kanbanPoll.<field>: <value>
    const kp = line.match(/^kanbanPoll\.(\w+):\s*(.+)$/);
    if (kp) {
      kv[`kanbanPoll.${kp[1]}`] = kp[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // memoryCapture.<field>: <value>
    const mcap = line.match(/^memoryCapture\.(\w+):\s*(.+)$/);
    if (mcap) {
      kv[`memoryCapture.${mcap[1]}`] = mcap[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // memoryVault.<field>: <value>
    const mvault = line.match(/^memoryVault\.(\w+):\s*(.+)$/);
    if (mvault) {
      kv[`memoryVault.${mvault[1]}`] = mvault[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // memoryApproval.<field>: <value>
    const mappr = line.match(/^memoryApproval\.(\w+):\s*(.+)$/);
    if (mappr) {
      kv[`memoryApproval.${mappr[1]}`] = mappr[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // memoryConsolidation.<field>: <value>
    const mcon = line.match(/^memoryConsolidation\.(\w+):\s*(.+)$/);
    if (mcon) {
      kv[`memoryConsolidation.${mcon[1]}`] = mcon[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) kv[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  }

  const activeContextType = activeContextKv.type;
  const activeContextName = activeContextKv.name;
  const activeContext: ActiveContext | undefined =
    (activeContextType === 'personality' || activeContextType === 'team') && activeContextName
      ? { type: activeContextType, name: activeContextName }
      : undefined;

  const sortedProviderIdxs = Object.keys(providersKv)
    .map(Number)
    .sort((a, b) => a - b);
  const providers: ProviderConfig[] = sortedProviderIdxs
    .map((i): ProviderConfig | null => {
      const p = providersKv[i];
      if (!p?.provider) return null;
      return {
        provider: p.provider,
        apiKey: p.apiKey ?? '',
        model: p.model,
        baseUrl: p.baseUrl,
        apiVersion: p.apiVersion,
      };
    })
    .filter((p): p is ProviderConfig => p !== null);

  const retention = buildRetentionConfig(retentionKv);
  const personalitiesConfig = buildPersonalitiesConfig(personalitiesRetKv);
  const auxiliaryCompression: AuxiliaryCompressionConfig | undefined = auxiliaryCompressionKv.model
    ? {
        model: auxiliaryCompressionKv.model,
        ...(auxiliaryCompressionKv.provider ? { provider: auxiliaryCompressionKv.provider } : {}),
        ...(auxiliaryCompressionKv.apiKey ? { apiKey: auxiliaryCompressionKv.apiKey } : {}),
        ...(auxiliaryCompressionKv.baseUrl ? { baseUrl: auxiliaryCompressionKv.baseUrl } : {}),
      }
    : undefined;
  const auxiliaryVision: AuxiliaryVisionConfig | undefined = auxiliaryVisionKv.model
    ? {
        model: auxiliaryVisionKv.model,
        ...(auxiliaryVisionKv.provider ? { provider: auxiliaryVisionKv.provider } : {}),
        ...(auxiliaryVisionKv.apiKey ? { apiKey: auxiliaryVisionKv.apiKey } : {}),
        ...(auxiliaryVisionKv.baseUrl ? { baseUrl: auxiliaryVisionKv.baseUrl } : {}),
      }
    : undefined;
  const auxiliaryWeb: AuxiliaryWebConfig | undefined = auxiliaryWebKv.model
    ? {
        model: auxiliaryWebKv.model,
        ...(auxiliaryWebKv.provider ? { provider: auxiliaryWebKv.provider } : {}),
        ...(auxiliaryWebKv.apiKey ? { apiKey: auxiliaryWebKv.apiKey } : {}),
        ...(auxiliaryWebKv.baseUrl ? { baseUrl: auxiliaryWebKv.baseUrl } : {}),
      }
    : undefined;
  const auxiliaryAsr:
    | { provider: string; model?: string; apiKey?: string; baseUrl?: string }
    | undefined = auxiliaryAsrKv.provider
    ? {
        provider: auxiliaryAsrKv.provider,
        ...(auxiliaryAsrKv.model ? { model: auxiliaryAsrKv.model } : {}),
        ...(auxiliaryAsrKv.apiKey ? { apiKey: auxiliaryAsrKv.apiKey } : {}),
        ...(auxiliaryAsrKv.baseUrl ? { baseUrl: auxiliaryAsrKv.baseUrl } : {}),
      }
    : undefined;
  const auxiliaryTts:
    | { provider: string; model?: string; apiKey?: string; voice?: string; baseUrl?: string }
    | undefined = auxiliaryTtsKv.provider
    ? {
        provider: auxiliaryTtsKv.provider,
        ...(auxiliaryTtsKv.model ? { model: auxiliaryTtsKv.model } : {}),
        ...(auxiliaryTtsKv.apiKey ? { apiKey: auxiliaryTtsKv.apiKey } : {}),
        ...(auxiliaryTtsKv.voice ? { voice: auxiliaryTtsKv.voice } : {}),
        ...(auxiliaryTtsKv.baseUrl ? { baseUrl: auxiliaryTtsKv.baseUrl } : {}),
      }
    : undefined;
  const webConfig: WebConfig | undefined =
    webKv.search_backend || webKv.extract_backend
      ? {
          ...(webKv.search_backend === 'exa' ||
          webKv.search_backend === 'tavily' ||
          webKv.search_backend === 'brave'
            ? { search_backend: webKv.search_backend }
            : {}),
          ...(webKv.extract_backend === 'htmltext'
            ? { extract_backend: webKv.extract_backend }
            : {}),
        }
      : undefined;
  const modelCatalogProviders: Record<string, { url: string }> | undefined =
    Object.keys(modelCatalogProvidersKv).length > 0
      ? Object.fromEntries(
          Object.entries(modelCatalogProvidersKv)
            .filter(([, v]) => v.url)
            .map(([id, v]) => [id, { url: v.url }]),
        )
      : undefined;
  const modelCatalogEnabled: boolean | undefined =
    modelCatalogKv.enabled === 'true'
      ? true
      : modelCatalogKv.enabled === 'false'
        ? false
        : undefined;
  const modelCatalog: ModelCatalogConfig | undefined =
    Object.keys(modelCatalogKv).length > 0 || modelCatalogProviders
      ? {
          ...(modelCatalogEnabled !== undefined ? { enabled: modelCatalogEnabled } : {}),
          ...(modelCatalogKv.url ? { url: modelCatalogKv.url } : {}),
          ...(modelCatalogKv.ttlHours ? { ttlHours: Number(modelCatalogKv.ttlHours) } : {}),
          ...(modelCatalogProviders ? { providers: modelCatalogProviders } : {}),
        }
      : undefined;
  const models = buildModelProfiles(modelsKv);
  const compaction = buildCompaction(compactionKv);
  const memoryConsolidation = buildMemoryConsolidation(memoryConsolidationKv);
  const parsedMaxBytes = logsRotationKv.maxBytes ? Number(logsRotationKv.maxBytes) : undefined;
  const parsedMaxFiles = logsRotationKv.maxFiles ? Number(logsRotationKv.maxFiles) : undefined;
  const logsRotation =
    Object.keys(logsRotationKv).length > 0
      ? {
          ...(parsedMaxBytes && Number.isFinite(parsedMaxBytes) && parsedMaxBytes > 0
            ? { maxBytes: Math.floor(parsedMaxBytes) }
            : {}),
          ...(parsedMaxFiles && Number.isFinite(parsedMaxFiles) && parsedMaxFiles > 0
            ? { maxFiles: Math.floor(parsedMaxFiles) }
            : {}),
          ...(logsRotationKv.enabled !== undefined
            ? { enabled: logsRotationKv.enabled !== 'false' }
            : {}),
        }
      : undefined;
  const awsSecrets: AwsSecretsConfig | undefined =
    Object.keys(awsSecretsKv).length > 0
      ? {
          ...(awsSecretsKv.enabled === 'true'
            ? { enabled: true }
            : awsSecretsKv.enabled === 'false'
              ? { enabled: false }
              : {}),
          ...(awsSecretsKv.region ? { region: awsSecretsKv.region } : {}),
          ...(awsSecretsKv.prefix ? { prefix: awsSecretsKv.prefix } : {}),
          ...(awsSecretsKv.endpoint ? { endpoint: awsSecretsKv.endpoint } : {}),
        }
      : undefined;
  const awsConfig: AwsConfig | undefined = awsSecrets ? { secrets: awsSecrets } : undefined;
  const telegramResult = buildTelegramBots(telegramBotsKv);
  const slackResult = buildSlackApps(slackAppsKv);
  const whatsappResult = buildWhatsApps(whatsappKv);
  const voiceResult = buildVoiceBots(voiceBotsKv);
  const voiceLiveKitResult = buildVoiceLiveKit(voiceLiveKitKv);
  const voiceTrunkResult = buildVoiceTrunk(voiceTrunkKv);
  const voiceSection =
    voiceResult.bots.length > 0 || voiceLiveKitResult.livekit || voiceTrunkResult.trunk
      ? {
          bots: voiceResult.bots,
          ...(voiceLiveKitResult.livekit ? { livekit: voiceLiveKitResult.livekit } : {}),
          ...(voiceTrunkResult.trunk ? { trunk: voiceTrunkResult.trunk } : {}),
        }
      : undefined;
  const teams = buildTeamsConfig(teamsKv);
  const webhooksResult = buildWebhooks(webhooksKv);
  const quick_commands = buildQuickCommands(qcKv);
  const channelToolsets = buildChannelToolsets(channelToolsetsKv);
  const channelFilter = buildChannelFilter(channelFilterKv);
  const parseErrors = [
    ...telegramResult.errors,
    ...slackResult.errors,
    ...whatsappResult.errors,
    ...voiceResult.errors,
    ...voiceLiveKitResult.errors,
    ...voiceTrunkResult.errors,
    ...webhooksResult.errors,
  ];

  const pluginsAutoInstall: boolean | undefined =
    kv['plugins.auto_install'] === 'true'
      ? true
      : kv['plugins.auto_install'] === 'false'
        ? false
        : undefined;
  const parsedSchemaVersion = kv.schemaVersion ? Number(kv.schemaVersion) : undefined;
  const config: EthosConfig = {
    schemaVersion: Number.isFinite(parsedSchemaVersion) ? parsedSchemaVersion : undefined,
    provider: kv.provider ?? 'anthropic',
    model: kv.model ?? 'claude-opus-4-7',
    apiKey: kv.apiKey ?? '',
    personality: kv.personality ?? 'researcher',
    memory:
      kv.memory === 'vector'
        ? 'vector'
        : kv.memory === 'vault'
          ? 'vault'
          : kv.memory === 'markdown'
            ? 'markdown'
            : undefined,
    baseUrl: kv.baseUrl,
    apiVersion: kv.apiVersion,
    // Lane 0 (D4) — a window is a positive integer token count; anything else
    // (zero, negative, non-numeric) is dropped so a typo cannot poison the
    // provider's maxContextTokens.
    contextWindow: (() => {
      if (kv.contextWindow === undefined) return undefined;
      const n = Number(kv.contextWindow);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
    })(),
    modelRouting: Object.keys(modelRouting).length > 0 ? modelRouting : undefined,
    toolSettings: Object.keys(toolSettings).length > 0 ? toolSettings : undefined,
    models,
    compaction,
    activeContext,
    providers: providers.length > 0 ? providers : undefined,
    telegramToken: kv.telegramToken,
    discordToken: kv.discordToken,
    slackBotToken: kv.slackBotToken,
    slackAppToken: kv.slackAppToken,
    slackSigningSecret: kv.slackSigningSecret,
    emailImapHost: kv.emailImapHost,
    emailImapPort: kv.emailImapPort ? Number(kv.emailImapPort) : undefined,
    emailUser: kv.emailUser,
    emailPassword: kv.emailPassword,
    emailSmtpHost: kv.emailSmtpHost,
    emailSmtpPort: kv.emailSmtpPort ? Number(kv.emailSmtpPort) : undefined,
    verbose: kv.verbose === 'true' ? true : undefined,
    displayVerbosity: parseVerbosity(displayKv.verbosity),
    displayBusyInputMode: parseBusyMode(displayKv.busy_input_mode),
    displayToolPreviewLength: parseToolPreviewLength(displayKv.tool_preview_length),
    displayResumeHint: displayKv.resume_hint === 'false' ? false : undefined,
    displayResumeRecapTurns: (() => {
      if (displayKv.resume_recap_turns === undefined) return undefined;
      const n = parseInt(displayKv.resume_recap_turns, 10);
      return Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : undefined;
    })(),
    skin: kv.skin || undefined,
    retention,
    personalitiesConfig,
    telegram: telegramResult.bots.length > 0 ? { bots: telegramResult.bots } : undefined,
    slack: slackResult.apps.length > 0 ? { apps: slackResult.apps } : undefined,
    whatsapp: whatsappResult.apps.length > 0 ? whatsappResult.apps : undefined,
    voice: voiceSection,
    teams,
    evolverCronEnabled: evolverKv.cron_enabled === 'true' ? true : undefined,
    evolverSchedule: evolverKv.schedule || undefined,
    backgroundMaxConcurrent: backgroundKv.max_concurrent
      ? Number(backgroundKv.max_concurrent)
      : undefined,
    background: buildBackgroundConfig(backgroundKv),
    displayBellOnComplete: displayKv.bell_on_complete === 'true' ? true : undefined,
    displayMemoryNotices:
      displayKv.memory_notices === 'true'
        ? true
        : displayKv.memory_notices === 'false'
          ? false
          : undefined,
    displayDebugPanel: displayKv.debug_panel === 'true' ? true : undefined,
    displayDebugPanelModel: displayKv.debug_panel_model || undefined,
    displayStreamingEdits: parseStreamingEdits(displayKv.streaming_edits),
    quick_commands,
    channelToolsets,
    channelFilter,
    auxiliary:
      auxiliaryCompression || auxiliaryVision || auxiliaryWeb || auxiliaryAsr || auxiliaryTts
        ? {
            ...(auxiliaryCompression ? { compression: auxiliaryCompression } : {}),
            ...(auxiliaryVision ? { vision: auxiliaryVision } : {}),
            ...(auxiliaryWeb ? { web: auxiliaryWeb } : {}),
            ...(auxiliaryAsr ? { asr: auxiliaryAsr } : {}),
            ...(auxiliaryTts ? { tts: auxiliaryTts } : {}),
          }
        : undefined,
    web: webConfig,
    webhooks: webhooksResult.webhooks,
    modelCatalog,
    logs: logsRotation ? { rotation: logsRotation } : undefined,
    aws: awsConfig,
    webBaseUrl: process.env.ETHOS_PUBLIC_URL ?? kv.webBaseUrl ?? undefined,
    storage: buildStorageConfig(kv),
    pluginsAutoInstall,
    admin:
      kv['admin.enabled'] !== undefined ? { enabled: kv['admin.enabled'] === 'true' } : undefined,
    a2a: kv['a2a.enabled'] !== undefined ? { enabled: kv['a2a.enabled'] === 'true' } : undefined,
    nightlyPass:
      kv['nightlyPass.enabled'] !== undefined || kv['nightlyPass.cron'] !== undefined
        ? {
            ...(kv['nightlyPass.enabled'] !== undefined
              ? { enabled: kv['nightlyPass.enabled'] === 'true' }
              : {}),
            ...(kv['nightlyPass.cron'] ? { cron: kv['nightlyPass.cron'] } : {}),
          }
        : undefined,
    memoryCapture: buildMemoryCaptureConfig(kv),
    memoryVault: buildMemoryVaultConfig(kv),
    memoryApproval: buildMemoryApprovalConfig(kv),
    memoryConsolidation: (() => {
      // Union of the silent memory-flush turn (context-compaction) and the
      // decay/importance tuning (memory-experience) — disjoint field sets, one key.
      const decay = buildMemoryConsolidationConfig(kv);
      if (!memoryConsolidation && !decay) return undefined;
      return { ...memoryConsolidation, ...decay };
    })(),
    weeklyDigest:
      kv['weeklyDigest.enabled'] !== undefined ||
      kv['weeklyDigest.cron'] !== undefined ||
      kv['weeklyDigest.recipients'] !== undefined
        ? {
            ...(kv['weeklyDigest.enabled'] !== undefined
              ? { enabled: kv['weeklyDigest.enabled'] === 'true' }
              : {}),
            ...(kv['weeklyDigest.cron'] ? { cron: kv['weeklyDigest.cron'] } : {}),
            ...(kv['weeklyDigest.recipients']
              ? {
                  recipients: kv['weeklyDigest.recipients']
                    .split(/[,\s]+/)
                    .map((r) => r.trim())
                    .filter((r) => r.length > 0),
                }
              : {}),
          }
        : undefined,
    kanbanPoll:
      kv['kanbanPoll.enabled'] !== undefined ||
      kv['kanbanPoll.intervalMs'] !== undefined ||
      kv['kanbanPoll.boardPath'] !== undefined
        ? {
            ...(kv['kanbanPoll.enabled'] !== undefined
              ? { enabled: kv['kanbanPoll.enabled'] === 'true' }
              : {}),
            ...(kv['kanbanPoll.intervalMs']
              ? { intervalMs: Number(kv['kanbanPoll.intervalMs']) }
              : {}),
            ...(kv['kanbanPoll.boardPath'] ? { boardPath: kv['kanbanPoll.boardPath'] } : {}),
          }
        : undefined,
  };
  // Stash parse errors so the strict loader can surface them at boot.
  // readRawConfig (used by CLI commands that don't gateway-boot) ignores them
  // and continues with whatever entries did parse.
  parseErrorsByConfig.set(config, parseErrors);
  return config;
}

// Side-table keyed by the EthosConfig object identity. Avoids polluting
// the public type with an `@internal` field that downstream code would
// have to remember to ignore.
const parseErrorsByConfig = new WeakMap<EthosConfig, string[]>();

/**
 * Strict loader used by the gateway boot path. Returns the parsed config
 * along with any deprecation messages from the legacy → list-shape shim
 * AND any parse-time errors for malformed bot entries. Boot prints both
 * and exits non-zero on errors so a typo never silently boots zero bots.
 */
export interface LoadedConfig {
  config: EthosConfig;
  parseErrors: string[];
  deprecations: string[];
}

export async function loadConfigStrict(
  storage: Storage,
  secrets?: SecretsResolver,
): Promise<LoadedConfig | null> {
  const parsed = await readRawConfig(storage);
  if (!parsed) return null;
  if (secrets) validateNoPlaintextSecrets(parsed);
  const parseErrors = parseErrorsByConfig.get(parsed) ?? [];
  const resolved = secrets ? await resolveConfigSecrets(parsed, secrets) : parsed;
  const { config, deprecations } = applyPlatformShim(resolved);
  return { config, parseErrors, deprecations };
}

// ---------------------------------------------------------------------------
// Plaintext secret detection
// ---------------------------------------------------------------------------

/**
 * Fields whose values MUST be entirely `${secrets:ref}` references when a
 * SecretsResolver is configured. These are known credential-bearing fields
 * regardless of whether the value matches a regex pattern.
 */
const SECRET_FIELD_NAMES = new Set([
  'apiKey',
  'token',
  'botToken',
  'appToken',
  'signingSecret',
  'password',
  'emailPassword',
  'discordToken',
  'slackBotToken',
  'slackAppToken',
  'slackSigningSecret',
  'telegramToken',
]);

/**
 * Walk every string value in `config` (including nested objects and arrays)
 * and throw if any value looks like a plaintext secret. Called from
 * `loadConfigStrict` *before* secrets resolution, so legitimate
 * `${secrets:ref}` references are still present and are explicitly skipped.
 *
 * Two-pass check:
 * 1. **Field-name check** — if the leaf field name is in SECRET_FIELD_NAMES,
 *    the ENTIRE value must be a secrets reference.
 * 2. **Regex catch-all** — for all other fields, run `detectSecrets`.
 *
 * Skips validation entirely when no SecretsResolver is configured (local dev
 * without secrets infrastructure).
 */
export function validateNoPlaintextSecrets(config: EthosConfig): void {
  const violations: Array<{ field: string; label: string }> = [];
  walkStringValues(config, '', (field, value) => {
    const stripped = value.replace(SECRETS_REF_RE, '');
    if (stripped.length === 0) return;

    // Extract the leaf field name, stripping trailing array indices
    const raw = field.includes('.') ? field.slice(field.lastIndexOf('.') + 1) : field;
    const leaf = raw.replace(/\[\d+\]$/, '');

    if (SECRET_FIELD_NAMES.has(leaf)) {
      // Known secret field — entire value must be a secrets reference
      if (stripped.trim().length > 0) {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal label, not a template
        violations.push({ field, label: 'secret (field requires ${secrets:ref})' });
      }
      return;
    }

    const detections = detectSecrets(stripped);
    if (detections.length > 0) {
      violations.push({ field, label: detections[0].label });
    }
  });
  if (violations.length > 0) {
    const details = violations
      .map(
        (v) =>
          `  - field '${v.field}' appears to contain a plaintext ${v.label}. ` +
          `Use \${secrets:<ref>} substitution instead.`,
      )
      .join('\n');
    throw new Error(`Config validation failed: plaintext secret(s) detected.\n${details}`);
  }
}

function walkStringValues(
  obj: unknown,
  prefix: string,
  cb: (field: string, value: string) => void,
): void {
  if (typeof obj === 'string') {
    cb(prefix, obj);
    return;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      walkStringValues(obj[i], `${prefix}[${i}]`, cb);
    }
    return;
  }
  if (obj !== null && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      walkStringValues(value, prefix ? `${prefix}.${key}` : key, cb);
    }
  }
}

function parseVerbosity(v: string | undefined): EthosConfig['displayVerbosity'] {
  return v === 'quiet' || v === 'default' || v === 'verbose' || v === 'debug' ? v : undefined;
}

function parseBusyMode(v: string | undefined): EthosConfig['displayBusyInputMode'] {
  return v === 'interrupt' || v === 'queue' || v === 'steer' ? v : undefined;
}

function parseStreamingEdits(v: string | undefined): EthosConfig['displayStreamingEdits'] {
  return v === 'off' || v === 'dms' || v === 'all' ? v : undefined;
}

function parseToolPreviewLength(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return undefined;
  return n;
}

function buildRetentionConfig(kv: Record<string, string>): RetentionConfig | undefined {
  if (Object.keys(kv).length === 0) return undefined;
  const cfg: RetentionConfig = {};
  if (kv.messages) cfg.messages = kv.messages;
  if (kv.traces) cfg.traces = kv.traces;
  if (kv.spans) cfg.spans = kv.spans;
  if (kv.blobs) cfg.blobs = kv.blobs;
  if (kv.archive) cfg.archive = kv.archive;
  const ev: RetentionEventsConfig = {};
  if (kv['events.error']) ev.error = kv['events.error'];
  if (kv['events.audit']) ev.audit = kv['events.audit'];
  if (kv['events.channel']) ev.channel = kv['events.channel'];
  if (kv['events.install']) ev.install = kv['events.install'];
  if (Object.keys(ev).length > 0) cfg.events = ev;
  return cfg;
}

/**
 * Parse the `background:` section from the shared `background.*` flat-key bag.
 * Only recognised Background Sub-Agents fields are picked — the FW-13
 * `background.max_concurrent` key belongs to `backgroundMaxConcurrent` and is
 * handled separately. Returns undefined when no recognised field is present so
 * `config.background` is only set when the section actually appears.
 *
 * `default_max_cost_usd` / `max_root_background_usd` may legitimately be the
 * literal `null` meaning "explicit opt-out / unbounded". At this config layer we
 * only parse finite numbers — a `null` (or any non-finite value) leaves the
 * field undefined; the wiring layer distinguishes absence from a tool-level
 * explicit null.
 */
function buildBackgroundConfig(kv: Record<string, string>): BackgroundConfig | undefined {
  const cfg: BackgroundConfig = {};
  if (kv.enabled !== undefined) cfg.enabled = kv.enabled === 'true';
  const num = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const maxConcurrentJobs = num(kv.max_concurrent_jobs);
  if (maxConcurrentJobs !== undefined) cfg.maxConcurrentJobs = maxConcurrentJobs;
  const maxJobsPerRoot = num(kv.max_jobs_per_root);
  if (maxJobsPerRoot !== undefined) cfg.maxJobsPerRoot = maxJobsPerRoot;
  const maxJobsPerPersonality = num(kv.max_jobs_per_personality);
  if (maxJobsPerPersonality !== undefined) cfg.maxJobsPerPersonality = maxJobsPerPersonality;
  const defaultMaxCostUsd = num(kv.default_max_cost_usd);
  if (defaultMaxCostUsd !== undefined) cfg.defaultMaxCostUsd = defaultMaxCostUsd;
  const maxRootBackgroundUsd = num(kv.max_root_background_usd);
  if (maxRootBackgroundUsd !== undefined) cfg.maxRootBackgroundUsd = maxRootBackgroundUsd;
  const queuedTtlMs = num(kv.queued_ttl_ms);
  if (queuedTtlMs !== undefined) cfg.queuedTtlMs = queuedTtlMs;
  const staleMs = num(kv.stale_ms);
  if (staleMs !== undefined) cfg.staleMs = staleMs;
  const heartbeatMs = num(kv.heartbeat_ms);
  if (heartbeatMs !== undefined) cfg.heartbeatMs = heartbeatMs;
  const retentionDays = num(kv.retention_days);
  if (retentionDays !== undefined) cfg.retentionDays = retentionDays;
  if (Object.keys(cfg).length === 0) return undefined;
  return cfg;
}

function buildStorageConfig(kv: Record<string, string>): EthosConfig['storage'] {
  const s3: NonNullable<NonNullable<EthosConfig['storage']>['s3']> = {};
  if (kv['storage.s3.bucket']) s3.bucket = kv['storage.s3.bucket'];
  if (kv['storage.s3.region']) s3.region = kv['storage.s3.region'];
  if (kv['storage.s3.prefix']) s3.prefix = kv['storage.s3.prefix'];
  if (kv['storage.s3.endpoint']) s3.endpoint = kv['storage.s3.endpoint'];
  if (kv['storage.s3.forcePathStyle'] === 'true') s3.forcePathStyle = true;
  const rawBackend = kv['storage.backend'];
  const backend: 'fs' | 's3' | undefined =
    rawBackend === 'fs' || rawBackend === 's3' ? rawBackend : undefined;
  const encryption = kv['storage.encryption'] === 'true';
  const hasS3 = s3.bucket !== undefined;
  if (!encryption && backend === undefined && !hasS3) return undefined;
  return {
    ...(encryption ? { encryption: true } : {}),
    ...(backend ? { backend } : {}),
    ...(hasS3 ? { s3 } : {}),
  };
}

function buildMemoryCaptureConfig(kv: Record<string, string>): MemoryCaptureConfig | undefined {
  const present = Object.keys(kv).some((k) => k.startsWith('memoryCapture.'));
  if (!present) return undefined;
  const maxPerHour = Number.parseInt(kv['memoryCapture.maxPerHour'] ?? '', 10);
  const maxPerDay = Number.parseInt(kv['memoryCapture.maxPerDay'] ?? '', 10);
  return {
    ...(kv['memoryCapture.enabled'] !== undefined
      ? { enabled: kv['memoryCapture.enabled'] === 'true' }
      : {}),
    ...(kv['memoryCapture.model'] ? { model: kv['memoryCapture.model'] } : {}),
    ...(kv['memoryCapture.provider'] ? { provider: kv['memoryCapture.provider'] } : {}),
    ...(kv['memoryCapture.apiKey'] ? { apiKey: kv['memoryCapture.apiKey'] } : {}),
    ...(kv['memoryCapture.baseUrl'] ? { baseUrl: kv['memoryCapture.baseUrl'] } : {}),
    ...(Number.isFinite(maxPerHour) ? { maxPerHour } : {}),
    ...(Number.isFinite(maxPerDay) ? { maxPerDay } : {}),
  };
}

function buildMemoryVaultConfig(kv: Record<string, string>): MemoryVaultConfig | undefined {
  const present = Object.keys(kv).some((k) => k.startsWith('memoryVault.'));
  if (!present) return undefined;
  const prefetch = splitList(kv['memoryVault.prefetch']);
  const exclude = splitList(kv['memoryVault.exclude']);
  return {
    ...(kv['memoryVault.path'] ? { path: kv['memoryVault.path'] } : {}),
    ...(kv['memoryVault.agentDir'] ? { agentDir: kv['memoryVault.agentDir'] } : {}),
    ...(prefetch.length > 0 ? { prefetch } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
  };
}

function buildMemoryApprovalConfig(kv: Record<string, string>): MemoryApprovalConfig | undefined {
  const present = Object.keys(kv).some((k) => k.startsWith('memoryApproval.'));
  if (!present) return undefined;
  const mode = kv['memoryApproval.mode'];
  if (mode !== undefined && mode !== 'off' && mode !== 'automated' && mode !== 'all') {
    throw new Error(`Invalid memoryApproval.mode "${mode}". Expected one of: off, automated, all.`);
  }
  const cap = Number.parseInt(kv['memoryApproval.cap'] ?? '', 10);
  const ttlDays = Number.parseInt(kv['memoryApproval.ttlDays'] ?? '', 10);
  if (kv['memoryApproval.cap'] !== undefined && (!Number.isFinite(cap) || cap <= 0)) {
    throw new Error(
      `Invalid memoryApproval.cap "${kv['memoryApproval.cap']}". Expected a positive integer.`,
    );
  }
  if (kv['memoryApproval.ttlDays'] !== undefined && (!Number.isFinite(ttlDays) || ttlDays <= 0)) {
    throw new Error(
      `Invalid memoryApproval.ttlDays "${kv['memoryApproval.ttlDays']}". Expected a positive integer.`,
    );
  }
  return {
    ...(mode !== undefined ? { mode: mode as MemoryApprovalConfig['mode'] } : {}),
    ...(Number.isFinite(cap) && cap > 0 ? { cap } : {}),
    ...(Number.isFinite(ttlDays) && ttlDays > 0 ? { ttlDays } : {}),
  };
}

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function buildMemoryConsolidationConfig(
  kv: Record<string, string>,
): MemoryConsolidationConfig | undefined {
  const present = Object.keys(kv).some((k) => k.startsWith('memoryConsolidation.'));
  if (!present) return undefined;
  const halfLifeDays = Number.parseFloat(kv['memoryConsolidation.halfLifeDays'] ?? '');
  const threshold = Number.parseFloat(kv['memoryConsolidation.threshold'] ?? '');
  return {
    ...(Number.isFinite(halfLifeDays) ? { halfLifeDays } : {}),
    ...(Number.isFinite(threshold) ? { threshold } : {}),
    ...(kv['memoryConsolidation.exemptUser'] !== undefined
      ? { exemptUser: kv['memoryConsolidation.exemptUser'] === 'true' }
      : {}),
  };
}

function buildBotBinding(
  kv: Record<string, string>,
  label: string,
): { bind: BotBinding | null; errors: string[] } {
  const type = kv['bind.type'];
  const name = kv['bind.name'];
  const errors: string[] = [];
  if (type !== 'personality' && type !== 'team') {
    errors.push(
      `${label}: missing or invalid 'bind.type' ` +
        `(got ${type === undefined ? 'nothing' : `'${type}'`}; ` +
        `must be 'personality' or 'team').`,
    );
  }
  if (!name) {
    errors.push(`${label}: missing required field 'bind.name'.`);
  }
  if (errors.length > 0) return { bind: null, errors };
  const allow = kv['bind.allowSlashSwitch'];
  const binding: BotBinding = { type: type as 'personality' | 'team', name: name as string };
  if (allow === 'true') binding.allowSlashSwitch = true;
  return { bind: binding, errors };
}

function sortedIndexes(kv: Record<number, Record<string, string>>): number[] {
  // Numeric sort — `Object.keys(...)` returns strings even on numeric-keyed
  // records, and the default lexicographic order would put index 10 before 2.
  return Object.keys(kv)
    .map(Number)
    .sort((a, b) => a - b);
}

function buildTelegramBots(kv: Record<number, Record<string, string>>): {
  bots: TelegramBotConfig[];
  errors: string[];
} {
  const bots: TelegramBotConfig[] = [];
  const errors: string[] = [];
  for (const idx of sortedIndexes(kv)) {
    const entry = kv[idx];
    if (!entry) continue;
    const label = `telegram.bots[${idx}]`;
    if (!entry.token) {
      errors.push(`${label}: missing required field 'token'.`);
      continue;
    }
    const result = buildBotBinding(entry, label);
    if (result.errors.length > 0) {
      errors.push(...result.errors);
      continue;
    }
    if (!result.bind) continue;
    bots.push({ token: entry.token, bind: result.bind, ...(entry.id ? { id: entry.id } : {}) });
  }
  return { bots, errors };
}

function buildSlackApps(kv: Record<number, Record<string, string>>): {
  apps: SlackAppConfig[];
  errors: string[];
} {
  const apps: SlackAppConfig[] = [];
  const errors: string[] = [];
  for (const idx of sortedIndexes(kv)) {
    const entry = kv[idx];
    if (!entry) continue;
    const label = `slack.apps[${idx}]`;
    const missing = (['botToken', 'appToken', 'signingSecret'] as const).filter((k) => !entry[k]);
    if (missing.length > 0) {
      errors.push(`${label}: missing required field(s) ${missing.join(', ')}.`);
      continue;
    }
    const result = buildBotBinding(entry, label);
    if (result.errors.length > 0) {
      errors.push(...result.errors);
      continue;
    }
    if (!result.bind) continue;
    apps.push({
      botToken: entry.botToken,
      appToken: entry.appToken,
      signingSecret: entry.signingSecret,
      bind: result.bind,
      ...(entry.id ? { id: entry.id } : {}),
    });
  }
  return { apps, errors };
}

function buildWhatsApps(kv: Record<number, Record<string, string>>): {
  apps: WhatsAppConfig[];
  errors: string[];
} {
  const apps: WhatsAppConfig[] = [];
  const errors: string[] = [];
  for (const idx of sortedIndexes(kv)) {
    const entry = kv[idx];
    if (!entry) continue;
    const label = `whatsapp[${idx}]`;
    const app: WhatsAppConfig = {};
    if (entry.id) app.id = entry.id;
    if (entry.session_dir) app.session_dir = entry.session_dir;
    if (entry.phone_number) app.phone_number = entry.phone_number;
    if (entry.default_mode) {
      if (entry.default_mode === 'all' || entry.default_mode === 'mention_only') {
        app.default_mode = entry.default_mode;
      } else {
        errors.push(
          `${label}: invalid default_mode '${entry.default_mode}' (expected 'all' or 'mention_only').`,
        );
        continue;
      }
    }
    if (entry.allowed_numbers) {
      const numbers = entry.allowed_numbers
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (numbers.length > 0) app.allowed_numbers = numbers;
    }
    // WhatsApp bind is optional. Only build (and validate) a binding when the
    // operator supplied both bind.type and bind.name; otherwise leave it
    // undefined so the gateway falls back to the default personality.
    if (entry['bind.type'] && entry['bind.name']) {
      const result = buildBotBinding(entry, label);
      if (result.errors.length > 0) {
        errors.push(...result.errors);
        continue;
      }
      if (result.bind) app.bind = result.bind;
    }
    apps.push(app);
  }
  return { apps, errors };
}

function buildVoiceBots(kv: Record<number, Record<string, string>>): {
  bots: VoiceBotConfig[];
  errors: string[];
} {
  const bots: VoiceBotConfig[] = [];
  const errors: string[] = [];
  for (const idx of sortedIndexes(kv)) {
    const entry = kv[idx];
    if (!entry) continue;
    const label = `voice.bots[${idx}]`;
    if (!entry.match) {
      errors.push(`${label}: missing required field 'match'.`);
      continue;
    }
    const result = buildBotBinding(entry, label);
    if (result.errors.length > 0) {
      errors.push(...result.errors);
      continue;
    }
    if (!result.bind) continue;
    bots.push({ match: entry.match, bind: result.bind, ...(entry.id ? { id: entry.id } : {}) });
  }
  return { bots, errors };
}

function buildVoiceLiveKit(kv: Record<string, string>): {
  livekit?: VoiceLiveKitConfig;
  errors: string[];
} {
  // Absent block is valid — LiveKit keys are optional.
  if (Object.keys(kv).length === 0) return { errors: [] };
  const errors: string[] = [];
  const { url, apiKey, apiSecret } = kv;
  if (!url || !apiKey || !apiSecret) {
    if (!url) errors.push("voice.livekit: missing required field 'url'.");
    if (!apiKey) errors.push("voice.livekit: missing required field 'apiKey'.");
    if (!apiSecret) errors.push("voice.livekit: missing required field 'apiSecret'.");
    return { errors };
  }
  return { livekit: { url, apiKey, apiSecret }, errors: [] };
}

const VOICE_TRUNK_PROVIDERS = ['twilio', 'telnyx', 'generic'] as const;

function buildVoiceTrunk(kv: Record<string, string>): {
  trunk?: VoiceTrunkConfig;
  errors: string[];
} {
  // Absent block is valid — SIP trunk keys are optional.
  if (Object.keys(kv).length === 0) return { errors: [] };
  const errors: string[] = [];
  const { provider, trunkId, fromNumber, username, password } = kv;
  if (!provider) errors.push("voice.trunk: missing required field 'provider'.");
  else if (!(VOICE_TRUNK_PROVIDERS as readonly string[]).includes(provider)) {
    errors.push(
      `voice.trunk: invalid provider '${provider}' (expected one of: ${VOICE_TRUNK_PROVIDERS.join(', ')}).`,
    );
  }
  if (!trunkId) errors.push("voice.trunk: missing required field 'trunkId'.");
  if (errors.length > 0) return { errors };
  return {
    trunk: {
      provider: provider as VoiceTrunkConfig['provider'],
      trunkId,
      ...(fromNumber ? { fromNumber } : {}),
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
    },
    errors: [],
  };
}

function buildTeamsConfig(
  kv: Record<string, Record<string, string>>,
): Record<string, TeamRuntimeConfig> | undefined {
  const names = Object.keys(kv);
  if (names.length === 0) return undefined;
  const out: Record<string, TeamRuntimeConfig> = {};
  for (const name of names) {
    const entry = kv[name];
    if (!entry) continue;
    const cfg: TeamRuntimeConfig = {};
    if (entry.autoStop === 'true') cfg.autoStop = true;
    out[name] = cfg;
  }
  return out;
}

function buildWebhooks(kv: Record<string, Record<string, string>>): {
  webhooks: Record<string, WebhookHookConfig> | undefined;
  errors: string[];
} {
  const ids = Object.keys(kv);
  if (ids.length === 0) return { webhooks: undefined, errors: [] };
  const webhooks: Record<string, WebhookHookConfig> = {};
  const errors: string[] = [];
  for (const hookId of ids) {
    const entry = kv[hookId];
    if (!entry) continue;
    if (!entry.personalityId) {
      errors.push(`webhooks.${hookId}: missing required field 'personalityId'.`);
      continue;
    }
    if (!entry.secret) {
      errors.push(`webhooks.${hookId}: missing required field 'secret'.`);
      continue;
    }
    if (entry.mode !== undefined && entry.mode !== 'sync' && entry.mode !== 'ack') {
      errors.push(`webhooks.${hookId}: mode must be 'sync' or 'ack'.`);
      continue;
    }
    let prefilterTimeoutSeconds: number | undefined;
    if (entry.prefilterTimeoutSeconds !== undefined) {
      if (!entry.prefilter) {
        errors.push(`webhooks.${hookId}: prefilterTimeoutSeconds requires 'prefilter'.`);
        continue;
      }
      const n = Number(entry.prefilterTimeoutSeconds);
      if (!Number.isInteger(n) || n < 1 || n > 600) {
        errors.push(
          `webhooks.${hookId}: prefilterTimeoutSeconds must be an integer between 1 and 600.`,
        );
        continue;
      }
      prefilterTimeoutSeconds = n;
    }
    webhooks[hookId] = {
      personalityId: entry.personalityId,
      secret: entry.secret,
      ...(entry.sessionKey ? { sessionKey: entry.sessionKey } : {}),
      ...(entry.prefilter ? { prefilter: entry.prefilter } : {}),
      ...(prefilterTimeoutSeconds !== undefined ? { prefilterTimeoutSeconds } : {}),
      ...(entry.mode ? { mode: entry.mode } : {}),
    };
  }
  return { webhooks: Object.keys(webhooks).length > 0 ? webhooks : undefined, errors };
}

/**
 * Derive a stable `botKey` for a bot config. Explicit `id` wins; otherwise
 * delegates to `deriveBotKey` from `@ethosagent/core` with the token as
 * seed. Stable across boots; safe to log.
 *
 * Operators who want a readable identifier should set an explicit `id:`
 * in the config.
 */
export function deriveBotKey(
  bot: { id?: string } & ({ token: string } | { botToken: string }),
): string {
  if (bot.id) return bot.id;
  const seed = 'token' in bot ? bot.token : bot.botToken;
  return deriveBotKeyFromSeed(seed);
}

/**
 * Apply the legacy → list-shape shim. Configs written before multi-bot
 * routing kept a scalar `telegramToken`/`slack*` triple; synthesize a
 * one-entry `telegram.bots` / `slack.apps` so downstream code sees one
 * shape. Returns the deprecation messages the caller should surface.
 *
 * Legacy bots always bind to `config.personality` — never to
 * `config.activeContext`. `activeContext` is internal, mutable CLI/session
 * state (managed by `ethos set`); routing platform traffic by it would
 * mean a `/personality` switch in the CLI silently redirects Telegram or
 * Slack traffic after the next restart. Operators who want a team-bound
 * legacy bot must migrate to the explicit list shape.
 */
export function applyPlatformShim(config: EthosConfig): {
  config: EthosConfig;
  deprecations: string[];
} {
  const deprecations: string[] = [];
  let out = config;

  if (config.telegramToken && (config.telegram?.bots?.length ?? 0) === 0) {
    const bind: BotBinding = { type: 'personality', name: config.personality };
    out = { ...out, telegram: { bots: [{ token: config.telegramToken, bind }] } };
    deprecations.push(
      "Config field 'telegramToken' is deprecated. Use the list form: " +
        "'telegram.bots.0.token: <token>' + 'telegram.bots.0.bind.type: personality' + " +
        "'telegram.bots.0.bind.name: <id>'.",
    );
  }

  if (
    config.slackBotToken &&
    config.slackAppToken &&
    config.slackSigningSecret &&
    (config.slack?.apps?.length ?? 0) === 0
  ) {
    const bind: BotBinding = { type: 'personality', name: config.personality };
    out = {
      ...out,
      slack: {
        apps: [
          {
            botToken: config.slackBotToken,
            appToken: config.slackAppToken,
            signingSecret: config.slackSigningSecret,
            bind,
          },
        ],
      },
    };
    deprecations.push(
      "Config fields 'slackBotToken'/'slackAppToken'/'slackSigningSecret' are deprecated. " +
        "Use the list form: 'slack.apps.0.botToken: <token>' + " +
        "'slack.apps.0.appToken: <token>' + 'slack.apps.0.signingSecret: <secret>' + " +
        "'slack.apps.0.bind.type: personality' + 'slack.apps.0.bind.name: <id>'.",
    );
  }

  return { config: out, deprecations };
}

// Identifiers (bot id, bind.name, team key) are interpolated into the
// dotted line-based config format. Anything outside `[A-Za-z0-9_-]` either
// can't round-trip (dot = field separator) or quietly corrupts the file
// (`#` starts a comment, quotes change quoting semantics, whitespace
// truncates parsing). Reject up front so writeConfig never emits data it
// can't parse back unambiguously.
const SAFE_IDENT = /^[A-Za-z0-9_-]+$/;

function rejectUnsafeIdent(label: string, value: string, errors: string[]): void {
  if (!SAFE_IDENT.test(value)) {
    errors.push(
      `${label}: '${value}' must match /^[A-Za-z0-9_-]+$/ — dots, whitespace, '#', and quotes are reserved by the config format.`,
    );
  }
}

/**
 * Validate that every bot binding points at a personality or team that
 * actually exists. Returns the list of human-readable error messages;
 * an empty list means the config is consistent. Boot code prints these
 * and exits non-zero rather than starting bots that will silently route
 * to nowhere.
 */
export function validateBotBindings(
  config: EthosConfig,
  deps: { personalityIds: ReadonlySet<string>; teamNames: ReadonlySet<string> },
): string[] {
  const errors: string[] = [];

  // Single namespace across telegram + slack: even though lane keys are
  // platform-scoped, an explicit `id: 'prod'` shared across platforms is a
  // foot-gun for future maintainers writing per-bot lookups. Reject up
  // front instead of waiting for someone to log just the `botKey` and
  // wonder why two bots collide.
  const seenIds = new Set<string>();

  const checkBind = (
    label: string,
    botId: string | undefined,
    bind: BotBinding,
    botKey: string,
  ): void => {
    if (botId !== undefined) rejectUnsafeIdent(`${label}.id`, botId, errors);
    rejectUnsafeIdent(`${label}.bind.name`, bind.name, errors);
    if (seenIds.has(botKey)) {
      errors.push(`${label}: duplicate botKey '${botKey}'. Set an explicit 'id:' to disambiguate.`);
    }
    seenIds.add(botKey);
    if (bind.type === 'personality' && !deps.personalityIds.has(bind.name)) {
      errors.push(
        `${label}: bind.name='${bind.name}' is not a known personality. ` +
          'Add the personality under ~/.ethos/personalities/, or fix the binding.',
      );
    }
    if (bind.type === 'team' && !deps.teamNames.has(bind.name)) {
      errors.push(
        `${label}: bind.name='${bind.name}' is not a known team. ` +
          `Add a team manifest at ~/.ethos/teams/${bind.name}.yaml, or fix the binding.`,
      );
    }
  };

  for (const [i, bot] of (config.telegram?.bots ?? []).entries()) {
    checkBind(`telegram.bots[${i}]`, bot.id, bot.bind, deriveBotKey(bot));
  }
  for (const [i, app] of (config.slack?.apps ?? []).entries()) {
    checkBind(`slack.apps[${i}]`, app.id, app.bind, deriveBotKey(app));
  }
  for (const [i, wa] of (config.whatsapp ?? []).entries()) {
    // WhatsApp bind is optional — skip entries without one. WhatsApp has no
    // token, so derive the botKey from the explicit id (positional fallback).
    if (!wa.bind) continue;
    checkBind(`whatsapp[${i}]`, wa.id, wa.bind, wa.id ?? `whatsapp[${i}]`);
  }
  for (const [i, vb] of (config.voice?.bots ?? []).entries()) {
    // Voice bots have no token — derive the botKey from the explicit id or the
    // room/number `match` seed (same primitive every adapter/config uses).
    checkBind(`voice.bots[${i}]`, vb.id, vb.bind, vb.id ?? deriveBotKeyFromSeed(vb.match));
  }
  for (const name of Object.keys(config.teams ?? {})) {
    rejectUnsafeIdent(`teams.<key>`, name, errors);
  }
  return errors;
}

function buildQuickCommands(
  kv: Record<string, Record<string, string>>,
): Record<string, QuickCommandConfig> | undefined {
  const result: Record<string, QuickCommandConfig> = {};
  for (const [name, fields] of Object.entries(kv)) {
    const channels = fields.channels
      ? fields.channels
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const shared = {
      ...(fields.gateway === 'true' ? { gateway: true } : {}),
      ...(channels && channels.length > 0 ? { channels } : {}),
    };
    if (fields.type === 'exec' && fields.command) {
      result[name] = { type: 'exec', command: fields.command, ...shared };
    } else if (fields.type === 'reply' && fields.reply) {
      result[name] = { type: 'reply', reply: fields.reply, ...shared };
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function buildChannelToolsets(kv: Record<string, string>): Record<string, string[]> | undefined {
  const result: Record<string, string[]> = {};
  for (const [platform, raw] of Object.entries(kv)) {
    const tools = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (tools.length > 0) result[platform] = tools;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * §7 — assemble per-model profile overrides from parsed flat keys. Numeric
 * fields are dropped when non-finite; `toolCallFormat` is dropped unless it is
 * a known enum value. A model key with no valid fields is omitted.
 */
function buildModelProfiles(
  kv: Record<string, Record<string, string>>,
): Record<string, ModelProfile> | undefined {
  const result: Record<string, ModelProfile> = {};
  for (const [modelKey, fields] of Object.entries(kv)) {
    const profile: ModelProfile = {};
    const sampling: Record<string, number> = {};
    for (const key of ['temperature', 'topP', 'topK', 'minP'] as const) {
      const raw = fields[`sampling.${key}`];
      if (raw === undefined) continue;
      const n = Number(raw);
      if (Number.isFinite(n)) sampling[key] = n;
    }
    if (Object.keys(sampling).length > 0) profile.sampling = sampling;
    if (fields.toolCallFormat === 'openai' || fields.toolCallFormat === 'text-xml') {
      profile.toolCallFormat = fields.toolCallFormat;
    }
    if (fields.maxOutputTokens !== undefined) {
      const n = Number(fields.maxOutputTokens);
      if (Number.isFinite(n)) profile.maxOutputTokens = n;
    }
    if (Object.keys(profile).length > 0) result[modelKey] = profile;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * §5 — assemble the global compaction thresholds from parsed flat keys.
 * `pressure`/`target` are kept only when they parse to a finite fraction in
 * (0,1]; out-of-range or non-numeric values are dropped. Returns `undefined`
 * when neither field survives, so the gate falls back to its 0.8/0.7 defaults.
 */
function buildCompaction(kv: Record<string, string>): EthosConfig['compaction'] | undefined {
  const result: NonNullable<EthosConfig['compaction']> = {};
  for (const key of ['pressure', 'target'] as const) {
    const raw = kv[key];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && n <= 1) result[key] = n;
  }
  // Phase 1c — gateDelta is a token headroom (non-negative integer), not a
  // fraction; validated on a different range from pressure/target.
  const rawDelta = kv.gateDelta;
  if (rawDelta !== undefined) {
    const d = Number(rawDelta);
    if (Number.isFinite(d) && d >= 0) result.gateDelta = Math.floor(d);
  }
  // Phase 3 — boolean flags for the turn-end trigger + overflow-retry.
  if (kv.autoCompact === 'true') result.autoCompact = true;
  else if (kv.autoCompact === 'false') result.autoCompact = false;
  if (kv.retryOnOverflow === 'true') result.retryOnOverflow = true;
  else if (kv.retryOnOverflow === 'false') result.retryOnOverflow = false;
  // Phase 4 — small-window-mode override (auto | on | off).
  if (kv.smallWindow === 'auto' || kv.smallWindow === 'on' || kv.smallWindow === 'off') {
    result.smallWindow = kv.smallWindow;
  }
  // Item 7 — absolute ceiling (positive integer tokens) + guaranteed user tail
  // (non-negative integer). Out-of-range values are dropped, as above.
  const rawCeiling = kv.maxContextTokens;
  if (rawCeiling !== undefined) {
    const c = Number(rawCeiling);
    if (Number.isFinite(c) && c > 0) result.maxContextTokens = Math.floor(c);
  }
  const rawTail = kv.minTailUserMessages;
  if (rawTail !== undefined) {
    const t = Number(rawTail);
    if (Number.isFinite(t) && t >= 0) result.minTailUserMessages = Math.floor(t);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Phase 3 — assemble the memory-consolidation (silent flush) config from parsed
 * flat keys. `flushThreshold` is a fraction in (0,1]; the caps are non-negative
 * integers. Returns `undefined` when nothing survives so the loop stays opt-out.
 */
function buildMemoryConsolidation(
  kv: Record<string, string>,
): EthosConfig['memoryConsolidation'] | undefined {
  const result: NonNullable<EthosConfig['memoryConsolidation']> = {};
  if (kv.enabled === 'true') result.enabled = true;
  else if (kv.enabled === 'false') result.enabled = false;
  const threshold = kv.flushThreshold;
  if (threshold !== undefined) {
    const n = Number(threshold);
    if (Number.isFinite(n) && n > 0 && n <= 1) result.flushThreshold = n;
  }
  for (const key of ['timeboxMs', 'maxTokens', 'maxDeltaChars', 'minMessagesSinceFlush'] as const) {
    const raw = kv[key];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) result[key] = Math.floor(n);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function buildChannelFilter(
  kv: Record<string, Record<string, string>>,
): ChannelFilterConfig | undefined {
  const platforms = Object.keys(kv);
  if (platforms.length === 0) return undefined;
  const out: ChannelFilterConfig = {};
  for (const platform of platforms) {
    const entry = kv[platform];
    if (!entry) continue;
    const cfg: ChannelPlatformConfig = {};
    if (entry.enable === 'false') cfg.enabled = false;
    else if (entry.enable === 'true') cfg.enabled = true;
    if (entry.ownerUserId) cfg.ownerUserId = entry.ownerUserId;
    if (entry.recipientAllowlist) {
      cfg.recipientAllowlist = entry.recipientAllowlist
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (
      entry.dmPolicy === 'pairing' ||
      entry.dmPolicy === 'allowlist' ||
      entry.dmPolicy === 'queue' ||
      entry.dmPolicy === 'reject' ||
      entry.dmPolicy === 'silent-drop'
    ) {
      cfg.dmPolicy = entry.dmPolicy;
    }
    if (
      entry.contextVisibility === 'all' ||
      entry.contextVisibility === 'allowlist' ||
      entry.contextVisibility === 'allowlist_quote'
    ) {
      cfg.contextVisibility = entry.contextVisibility;
    }
    out[platform] = cfg;
  }
  return out;
}

function buildPersonalitiesConfig(
  kv: Record<string, Record<string, string>>,
): Record<string, { retention?: RetentionConfig }> | undefined {
  if (Object.keys(kv).length === 0) return undefined;
  const out: Record<string, { retention?: RetentionConfig }> = {};
  for (const [pid, retKv] of Object.entries(kv)) {
    const retention = buildRetentionConfig(retKv);
    if (retention) out[pid] = { retention };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Serialize a RetentionConfig to dotted key-value pairs. */
function retentionToLines(cfg: RetentionConfig): Array<[string, string]> {
  const lines: Array<[string, string]> = [];
  if (cfg.messages) lines.push(['messages', cfg.messages]);
  if (cfg.traces) lines.push(['traces', cfg.traces]);
  if (cfg.spans) lines.push(['spans', cfg.spans]);
  if (cfg.blobs) lines.push(['blobs', cfg.blobs]);
  if (cfg.archive) lines.push(['archive', cfg.archive]);
  if (cfg.events) {
    if (cfg.events.error) lines.push(['events.error', cfg.events.error]);
    if (cfg.events.audit) lines.push(['events.audit', cfg.events.audit]);
    if (cfg.events.channel) lines.push(['events.channel', cfg.events.channel]);
    if (cfg.events.install) lines.push(['events.install', cfg.events.install]);
  }
  return lines;
}

/**
 * Serialize the `background:` section to flat `[key, value]` pairs, emitting
 * only fields actually present on the config so parse→serialize→parse round-
 * trips are stable (absent fields fall back to `backgroundDefaults()`, never
 * written out).
 */
function backgroundToLines(bg: BackgroundConfig): Array<[string, string]> {
  const lines: Array<[string, string]> = [];
  if (bg.enabled !== undefined) lines.push(['enabled', String(bg.enabled)]);
  if (bg.maxConcurrentJobs !== undefined)
    lines.push(['max_concurrent_jobs', String(bg.maxConcurrentJobs)]);
  if (bg.maxJobsPerRoot !== undefined) lines.push(['max_jobs_per_root', String(bg.maxJobsPerRoot)]);
  if (bg.maxJobsPerPersonality !== undefined)
    lines.push(['max_jobs_per_personality', String(bg.maxJobsPerPersonality)]);
  if (bg.defaultMaxCostUsd !== undefined)
    lines.push(['default_max_cost_usd', String(bg.defaultMaxCostUsd)]);
  if (bg.maxRootBackgroundUsd !== undefined)
    lines.push(['max_root_background_usd', String(bg.maxRootBackgroundUsd)]);
  if (bg.queuedTtlMs !== undefined) lines.push(['queued_ttl_ms', String(bg.queuedTtlMs)]);
  if (bg.staleMs !== undefined) lines.push(['stale_ms', String(bg.staleMs)]);
  if (bg.heartbeatMs !== undefined) lines.push(['heartbeat_ms', String(bg.heartbeatMs)]);
  if (bg.retentionDays !== undefined) lines.push(['retention_days', String(bg.retentionDays)]);
  return lines;
}
