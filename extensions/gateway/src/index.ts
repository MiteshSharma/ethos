import { randomUUID } from 'node:crypto';
import type { AgentLoop } from '@ethosagent/core';
import {
  deriveBotKey,
  resolveSttProvider as resolveSharedStt,
  resolveTtsProvider as resolveSharedTts,
  stripAnsiEscapes,
} from '@ethosagent/core';
import type { DeliveryLedger } from '@ethosagent/delivery-ledger';
import type { ChannelFilterConfig } from '@ethosagent/safety-channel';
import {
  checkMessage,
  consumeAndAllow,
  getApprovedSenders,
  isSenderAllowed,
  revokeApproval,
} from '@ethosagent/safety-channel';
import { shortPatternCheck, wrapUntrusted } from '@ethosagent/safety-injection';
import { redactPii } from '@ethosagent/safety-redact';
import { SessionLane } from '@ethosagent/session-lane';
import type Database from '@ethosagent/sqlite';
import { createEventTranslator, shouldSurfaceProgress } from '@ethosagent/surface-kit';
import type {
  AttachmentCache,
  BackgroundJob,
  ChannelContext,
  ClarifyResponse,
  DeliveryResult,
  InboundMessage,
  Logger,
  OutboundMessage,
  PlatformAdapter,
  PlatformAdapterFactory,
  SteerSink,
  SttProvider,
  SttProviderRegistry,
  TtsProvider,
  TtsProviderRegistry,
} from '@ethosagent/types';
import {
  DEFAULT_VOICE_MODE,
  sanitizeForSpeech,
  shouldReplyWithVoice,
  truncateAtSentenceBoundary,
  type VoiceMode,
} from '@ethosagent/voice-text';
import { MessageDedupCache } from './dedup';
import { beginDelivery, confirmDelivery, type DeliveryBinding } from './delivery';
import {
  attachmentsFromStructured,
  OUTBOUND_MEDIA_MAX_BYTES,
  type OutboundMediaCaps,
} from './media';
import { DraftStreamer } from './streaming';
import {
  buildTranscriptText,
  hasAudioAttachments,
  transcribeAudioAttachments,
} from './voice-pipeline';

export { SessionLane } from '@ethosagent/session-lane';
export { MessageDedupCache } from './dedup';
export { beginDelivery, confirmDelivery, type DeliveryBinding } from './delivery';
export { DreamExecutor } from './dream-executor';
export {
  attachmentsFromStructured,
  decodeDataUrl,
  isOutboundMediaSource,
  OUTBOUND_MEDIA_MAX_BYTES,
  type OutboundMediaCaps,
  type OutboundMediaSource,
} from './media';
export {
  closeUnbalancedMarkup,
  DraftStreamer,
  parseRetryAfterSeconds,
  type StreamAdapter,
} from './streaming';
export { type CapturingAdapter, createCapturingAdapter } from './webhook-adapter';

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};

/**
 * Minimal observability surface the gateway needs. Defined locally so this
 * package depends only on `@ethosagent/types` + `@ethosagent/core`'s AgentLoop;
 * any adapter exposing this method shape (e.g. wiring's GatewayObservability)
 * is a fit.
 */
export interface GatewayObservability {
  recordSafetyBlock(opts: {
    code?: string;
    cause?: string;
    details?: Record<string, unknown>;
  }): void;
  recordInjectionFlag?(opts: {
    code?: string;
    cause?: string;
    details?: Record<string, unknown>;
  }): void;
  recordChannelAllow(opts: {
    code?: string;
    cause?: string;
    details?: Record<string, unknown>;
  }): void;
  recordChannelDeny(opts: {
    code?: string;
    cause?: string;
    details?: Record<string, unknown>;
  }): void;
}

// ---------------------------------------------------------------------------
// Lane / session key encoding
// ---------------------------------------------------------------------------

/**
 * Build a lane / session key from its segments. Each segment is
 * URL-encoded so a segment that happens to contain the `:` separator
 * (e.g. a future adapter's `threadId` with a colon) cannot alias two
 * distinct conversations onto the same key.
 *
 * Continuity with pre-encoding session keys is only guaranteed for
 * segments that are themselves URL-safe: platform identifiers
 * (`telegram` / `slack` / ...), the hex-derived default botKey
 * (`deriveBotKey` in `packages/core/src/bot-key.ts`), numeric Slack
 * `thread_ts`, and the chat IDs the supported platforms emit. An
 * operator who configures a custom `id:` value containing reserved
 * characters will see their existing SQLite session key change shape
 * once after upgrade and their history orphan — that's the cost of
 * choosing an unusual botKey, not a regression in the common case.
 *
 * Treat the returned string as opaque. The Gateway never decodes it;
 * collisions only matter at construction time, and the encoder is the
 * single point of truth for what a lane key looks like.
 */
function buildLaneKey(...segments: string[]): string {
  return segments.map(encodeURIComponent).join(':');
}

// ---------------------------------------------------------------------------
// Concurrency limiter
// ---------------------------------------------------------------------------

/**
 * Per-root concurrency cap for `/background` jobs — parity with the durable
 * engine's `maxJobsPerRoot` default (see `backgroundDefaults()` in
 * `@ethosagent/config`). The gateway has no live background config, so it uses
 * the same default constant.
 */
const BACKGROUND_MAX_JOBS_PER_ROOT = 3;

/**
 * Cap on the in-process announced-jobs Set. Only wide enough to cover a
 * duplicate `onComplete` for a job still in flight; the durable
 * `jobs.delivered_at` claim is what actually enforces exactly-once.
 */
const DELIVERED_WAKES_MAX = 4_096;

/**
 * Tools that render typed UI cards on the web surface. Channel adapters get
 * prose instead — by design, not by omission — so they are excluded from every
 * channel turn's tool definitions. The tools' own `ctx.platform` check is a
 * backstop, not the gate.
 */
export const CHANNEL_EXCLUDED_TOOLS: readonly string[] = ['emit_card', 'render_ui'];

/** Reply sent when a lane is rejected under saturation (typed busy result). */
const SYSTEM_BUSY_MESSAGE =
  '⚠ The system is busy right now — too many requests in progress. Please try again in a moment.';

/**
 * Counting semaphore bounding how many turns run at once across ALL lanes.
 * `maxConcurrentSessions` is the single-instance quota knob; when the operator
 * leaves it unset the limiter is constructed with `Infinity` permits, so
 * `acquire()` never blocks and today's unbounded behavior is preserved
 * exactly.
 *
 * Leak-free contract: every `acquire()` that resolves `true` MUST be paired
 * with exactly one `release()` in a `finally`. `acquire(signal)` is abortable
 * — if the signal fires while the caller is parked it resolves `false` (NO
 * permit was taken, so the caller must NOT release) and the waiter is removed
 * so a later `release()` never hands a permit to a dead waiter.
 */
class TurnSemaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  /** True when no permit is currently free (all slots in use). */
  get saturated(): boolean {
    return this.permits <= 0;
  }

  /** Acquire a permit. Resolves `true` once held; `false` if `signal` aborts
   *  first, in which case no permit is held. */
  acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const grant = () => {
        signal.removeEventListener('abort', onAbort);
        resolve(true);
      };
      const onAbort = () => {
        const idx = this.waiters.indexOf(grant);
        if (idx !== -1) this.waiters.splice(idx, 1);
        resolve(false);
      };
      this.waiters.push(grant);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Release a permit — hand it straight to the next waiter if any, else
   *  return it to the pool. */
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next(); // transfer the permit directly; `permits` stays "held"
    } else {
      this.permits++;
    }
  }
}

// ---------------------------------------------------------------------------
// Gateway config
// ---------------------------------------------------------------------------

/**
 * Per-bot routing entry. The Gateway maintains one `AgentLoop` per bot;
 * inbound messages carrying `InboundMessage.botKey` route to the entry
 * with the matching `botKey`. Each bot is statically bound to a single
 * destination (a personality or a team's coordinator).
 *
 * `binding.type === 'team'` means the supplied `loop` is the team's
 * coordinator loop (constructed via `createTeamAgentLoop`). The Gateway
 * does not override the personality on team turns — the coordinator's
 * personality is baked into the loop. `binding.type === 'personality'`
 * means the loop is the shared CLI loop and the Gateway passes
 * `binding.name` as the per-turn personality id.
 *
 * `binding.allowSlashSwitch` defaults to false: the `/personality`
 * command is soft-rejected for identity-bound bots so the bot's
 * external identity remains a stable contract with the user.
 */
export interface GatewayBotConfig {
  botKey: string;
  loop: AgentLoop;
  binding: {
    type: 'personality' | 'team';
    name: string;
    allowSlashSwitch?: boolean;
  };
  /** When true, PII (email, phone, card, SSN) is redacted from inbound message
   *  text before it reaches AgentLoop. Default false. */
  piiRedaction?: boolean;
  /** Durable background executor for this bot's loop — present when the background
   *  subsystem is enabled. The gateway subscribes to it for completion wakes and
   *  creates /background jobs through it. */
  backgroundExecutor?: import('@ethosagent/job-runner').BackgroundExecutor;
  /** This bot's job store — present when background is enabled. */
  jobStore?: import('@ethosagent/types').JobStore;
}

export interface GatewayConfig {
  /**
   * Multi-bot routing: one entry per bot. The Gateway keys its lane state
   * by `(platform, botKey, chatId[, threadId])` — encoded via `buildLaneKey`
   * — so concurrent conversations across bots and threads stay isolated.
   * Exactly one of `bots` / `loop` must be set; single-adapter deployments
   * may continue to pass `loop` directly.
   */
  bots?: GatewayBotConfig[];
  /** Back-compat shorthand for single-bot deployments. Ignored when
   *  `bots` is non-empty. Internally synthesized into a one-entry list
   *  with `botKey: 'default'` and binding `{ type: 'personality', name: defaultPersonality }`. */
  loop?: AgentLoop;
  /** Default personality ID for the back-compat single-bot path. */
  defaultPersonality?: string;
  /**
   * Global cap on how many turns (`runTurn`) execute simultaneously across ALL
   * lanes — the single-instance quota knob. Enforced by a semaphore around
   * turn execution: excess turns wait for a slot, and a lane whose backlog
   * reaches `maxLaneQueue` while the global budget is saturated gets a typed
   * busy rejection instead of an unbounded queue.
   *
   * When UNSET (or <= 0) the limit is unbounded — today's behavior is
   * preserved exactly, no turn ever waits. Set it only to impose a quota.
   */
  maxConcurrentSessions?: number;
  /**
   * Maximum messages queued for a single lane while turns wait on a global
   * concurrency slot. Once a lane's depth reaches this AND
   * `maxConcurrentSessions` is saturated, further messages for that lane are
   * rejected with a typed "system busy" reply rather than queued unbounded.
   * Defaults to 8. Has no effect unless `maxConcurrentSessions` is set (an
   * unbounded global budget never saturates, so lanes never back up).
   */
  maxLaneQueue?: number;
  /**
   * Size of the inbound-message dedup window. The Gateway remembers the most
   * recent N `(platform, chatId, messageId)` triples and silently drops
   * duplicates. Defaults to 1024. Set to 0 to disable dedup.
   * Adapters that don't populate `InboundMessage.messageId` are unaffected
   * (no key, no dedup possible — see plan/IMPROVEMENT.md P2-2).
   */
  dedupWindow?: number;
  /**
   * TTL for the outbound-message dedup cache (`MessageDedupCache`). Same
   * `(sessionId, content)` within this window is suppressed before reaching
   * the adapter. Defaults to 30s. Set to 0 to disable. The
   * `ETHOS_DEDUP_LEGACY=1` env var is a separate, hard-off switch — see
   * `dedup.ts` and plan/phases/30-robustness.md § 30.4.
   */
  outboundDedupTtlMs?: number;
  /**
   * Durable delivery-obligation ledger (item 9). When present, the covered
   * outbound reply paths record a `pending` obligation BEFORE the platform
   * call and mark it `delivered` only once the adapter CONFIRMS
   * (`DeliveryResult.ok === true`). `sweepPendingDeliveries()` then redelivers
   * anything left `pending` by a crash.
   *
   * Orthogonal to `outboundDedupTtlMs`: the dedup cache stops DOUBLE sends,
   * the ledger stops LOST sends. Absent → today's behavior, no durability.
   *
   * Deliberately NOT a personality concern — no personality may opt out of
   * having its replies delivered.
   */
  deliveryLedger?: DeliveryLedger;
  /**
   * Maximum number of distinct chats kept in memory. The least-recently-used
   * idle chat is evicted (its lane, session key, personality override, and
   * usage stats are forgotten) once this cap is exceeded. Active in-flight
   * lanes are never evicted. Defaults to 4096.
   */
  maxChats?: number;
  /**
   * Per-platform sender allowlist + pairing + mention-gate + context-visibility
   * config (Chapter 1 agent safety). When absent, all messages are allowed
   * (backward compat). Keys are platform identifiers (e.g. 'telegram').
   */
  channelFilter?: ChannelFilterConfig;
  /**
   * Context-economy Phase 1 — static per-channel toolset narrowing. Keys are
   * platform identifiers (e.g. 'whatsapp'), values the tool names allowed on
   * that channel. Passed as `RunOptions.toolsetNarrow` on lane turns, so it
   * can only SHRINK the personality toolset (intersect-only at turn-setup) —
   * economy config, never a security boundary. MUST be resolved from static
   * config only: computing it per turn would mutate the tool list and
   * invalidate the prefix cache (plan R1). Platforms without an entry are
   * unaffected.
   */
  channelToolsets?: Record<string, string[]>;
  /**
   * SQLite database used to store pairing codes when `dmPolicy: 'pairing'` is
   * configured. Must be initialised with `initPairingDb(db)` before passing.
   * Required when any platform uses pairing; optional otherwise.
   */
  pairingDb?: Database.Database;
  /**
   * Optional observability adapter for audit events (drops, blocks, context strips).
   */
  observability?: GatewayObservability;
  /**
   * Optional hook fired after a turn completes with a delivered reply (not
   * aborted, not errored, non-empty response). The caller decides what to do
   * with it — e.g. the CLI gateway command records the W4.1 funnel stamps
   * (`funnel.first_reply` / `funnel.channel_first_reply`) here, keeping
   * funnel emission in the app layer instead of this library.
   */
  onTurnComplete?: (info: { platform: string }) => void;
  /**
   * Optional hook fired when a turn STARTS, carrying the personality the turn
   * resolved to. Team-bound bots resolve no personality and never fire it.
   * The gateway holds no idle policy of its own — this is the activity signal
   * the CLI gateway command feeds to `DreamExecutor.recordUserTurn()`, which
   * owns the idle threshold, the daily cap, and cancelling an in-flight dream
   * when the user comes back. Absent (tests, standalone) → no signal, no
   * dreaming.
   */
  onUserTurn?: (info: { personalityId: string }) => void;
  /**
   * Optional hook called when a sender is approved via `/allow <code>` so the
   * caller can persist the updated allowlist back to config.yaml.
   */
  onAllowlistChange?: (
    platform: string,
    userId: string,
    action: 'add' | 'remove',
  ) => void | Promise<void>;
  /**
   * Optional inbound correlator for the clarify protocol. Runs BEFORE the
   * channel safety filter on every inbound message; when it returns a
   * `ClarifyResponse`, the gateway resolves the pending clarify on the
   * routed bot's `loop.clarifyBridge` and stops further processing (the
   * message was a force-reply / `/cancel`, not a fresh prompt to the agent).
   * Wired by `gateway.ts` from the per-bot `TelegramClarifySurface`'s
   * `correlateMessage`. See plan/phases/tool_clarity_plan.md Surface 4.
   */
  clarifyMessageCorrelator?: (message: InboundMessage) => Promise<ClarifyResponse | null>;
  /**
   * How often (ms) to run the clarify sweep across all bots' bridges. The
   * sweep clears persisted rows whose deadline has passed and notifies
   * surfaces so they can edit timed-out prompts in place. Defaults to 30s
   * per plan. Set to 0 to disable (tests).
   */
  clarifySweepIntervalMs?: number;
  /**
   * Optional card reader for `/personality rich`. When set, the gateway
   * renders a character-sheet card for the bound personality. Slack handles
   * this in its own slash handler; Telegram routes through the gateway, so
   * the reader is wired here.
   */
  personalityCardReader?: {
    read(personalityId: string): Promise<{ text: string } | null>;
  };
  /**
   * Optional greeting provider for `/start`. Returns a personality-aware
   * greeting string. When absent, `/start` returns a generic message.
   */
  greetingProvider?: {
    greet(personalityId: string): Promise<string>;
  };
  /**
   * Optional personality-directory seam for hot-reload. The gateway extension
   * holds no registry — this seam lets the app layer inject refresh + read
   * closures over every loop registry it built. `refresh()` re-loads ALL loop
   * registries in this process from disk (cheap — mtime-fingerprint cache);
   * `has()` / `list()` read the system loop's registry. Absent (tests,
   * standalone) → no refresh, legacy hardcoded `/personality list`.
   */
  personalityDirectory?: {
    refresh(): Promise<void>;
    has(id: string): boolean;
    list(): Array<{ id: string; name: string; isDefault: boolean }>;
  };
  /**
   * Optional attachment cache for cleaning up cached files on session reset
   * (`/new`) and lane eviction. When absent, no cleanup is performed.
   */
  attachmentCache?: AttachmentCache;
  /** STT provider registry for resolving voice transcription providers by name. */
  sttProviderRegistry?: SttProviderRegistry;
  /** Name of the STT provider to use (from auxiliary.asr.provider in config). */
  sttProviderName?: string;
  /** TTS provider registry for resolving voice synthesis providers by name. */
  ttsProviderRegistry?: TtsProviderRegistry;
  /** Name of the TTS provider to use (from auxiliary.tts.provider in config). */
  ttsProviderName?: string;
  /** Config dict passed to STT provider factory (apiKey, model, etc.). */
  sttProviderConfig?: Record<string, unknown>;
  /** Config dict passed to TTS provider factory (apiKey, model, voice, etc.). */
  ttsProviderConfig?: Record<string, unknown>;
  /** Secrets resolver for voice provider factories. */
  voiceSecretsResolver?: import('@ethosagent/types').SecretsResolver;
  /** Default voice mode: 'off' | 'mirror_inbound' | 'all'. Default 'mirror_inbound'. */
  defaultVoiceMode?: VoiceMode;
  /** Adapter lookup for agent-initiated outbound sends (send_message tool). */
  adapters?: Map<string, PlatformAdapter>;
  /** Plugin-contributed adapter factories. The gateway instantiates and starts
   *  each one, creating a ChannelContext that routes inbound messages through
   *  the standard handleMessage pipeline with auto-stamped botKey. */
  pluginAdapters?: Map<string, PlatformAdapterFactory>;
  /** Allowlist of plugin adapter IDs that are trusted to route. Channel
   *  adapters are high-privilege (they broker external I/O) and are
   *  default-deny — only IDs in this list will be started. When undefined
   *  (not set), all plugin adapters are allowed (backward compat / dev mode).
   *  When set (even to an empty Set), only listed IDs are started. */
  trustedChannelPlugins?: Set<string>;
  /** Trusted voice provider plugin IDs. Non-local STT/TTS providers must be
   *  in this set to be activated. Local providers (caps.local=true) are exempt. */
  trustedVoicePlugins?: ReadonlySet<string>;
  /** Resolves (platform, platformUserId) -> internal userId for per-user profiles. */
  resolveUserId?: (
    platform: string,
    platformUserId: string,
    displayLabel?: string,
  ) => Promise<string>;
  /** Plugin loader for dispatching plugin-registered slash commands. */
  pluginLoader?: {
    getSlashHandler(
      name: string,
    ):
      | ((args: string, ctx: import('@ethosagent/types').SlashCommandContext) => Promise<string>)
      | undefined;
    getAllSlashCommands(): { name: string; description: string; usage: string }[];
  };
  /** Notification router for delivering process completion alerts to channels. */
  notificationRouter?: import('@ethosagent/types').NotificationRouter;
  /**
   * Streaming draft-edit config (W3.1). When enabled for a chat and the
   * adapter can edit messages, a turn's reply is delivered as throttled
   * `editMessage` updates that grow in place (the first throttled chunk is the
   * first message — there is NO turn-start placeholder). Sourced from
   * `display.streaming_edits` in `~/.ethos/config.yaml` (NOT PersonalityConfig,
   * which is frozen). Defaults: DMs on, group chats off, since draft edits
   * multiply API calls per turn.
   */
  streamingEdits?: { dm?: boolean; group?: boolean };
  /**
   * Minimum ms between successive draft edits (the first send is never
   * throttled). Defaults to 2500 (~1 edit / 2.5s). Set to 0 in tests to flush
   * every chunk.
   */
  streamingEditIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Built-in gateway slash commands (handled before the AgentLoop sees the text)
// ---------------------------------------------------------------------------

const PLATFORM_COMMANDS: Record<
  string,
  | 'new'
  | 'usage'
  | 'stop'
  | 'help'
  | 'personality'
  | 'allow'
  | 'deny'
  | 'communications'
  | 'start'
  | 'queue'
  | 'background'
  | 'voice'
  | 'compact'
> = {
  '/new': 'new',
  '/reset': 'new',
  '/stop': 'stop',
  '/usage': 'usage',
  '/help': 'help',
  '/personality': 'personality',
  '/compact': 'compact',
  '/allow': 'allow',
  '/deny': 'deny',
  '/communications': 'communications',
  '/start': 'start',
  '/queue': 'queue',
  '/background': 'background',
  '/voice': 'voice',
};

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

/**
 * Where an in-flight turn originated — the adapter/chat/thread plus the user
 * who triggered it. The `before_tool_call` approval flow resolves a
 * `sessionId` to this so it can surface a prompt on the right conversation
 * and bind the decision to the rightful approver.
 */
export interface SessionRouting {
  adapter: PlatformAdapter;
  chatId: string;
  threadId?: string;
  /** Platform user id of whoever's message triggered the turn. Absent when
   *  the adapter didn't stamp one — the approval is then left unbound. */
  requesterUserId?: string;
}

export class Gateway {
  /** Bot routing table keyed by `botKey`. */
  private readonly bots: Map<string, GatewayBotConfig>;
  /** The botKey used when `InboundMessage.botKey` is absent (single-bot
   *  deployments). When the config supplies multiple bots, this is null
   *  and a message without `botKey` is treated as an unknown route. */
  private readonly defaultBotKey: string | null;
  private readonly lanes = new Map<string, SessionLane>();
  /** Effective session key per lane (allows /new to fork a fresh session). */
  private readonly sessionKeys = new Map<string, string>();
  /** Per-lane active personality (overrideable via /personality). */
  private readonly personalityIds = new Map<string, string>();
  /** Per-lane usage accumulator. */
  private readonly usageStore = new Map<
    string,
    { inputTokens: number; outputTokens: number; costUsd: number }
  >();
  /** Bounded LRU of recently-seen inbound-message keys. */
  private readonly seenMessages = new Set<string>();
  private readonly dedupWindow: number;
  /** Outbound-message dedup cache. Suppresses `(sessionId, content)` within TTL. */
  private readonly outboundDedup: MessageDedupCache;
  /** Durable delivery-obligation ledger (item 9). Absent → no durability. */
  private readonly deliveryLedger: DeliveryLedger | undefined;
  /** Streaming draft edits enabled for DMs / group chats (W3.1). */
  private readonly streamingDm: boolean;
  private readonly streamingGroup: boolean;
  /** Minimum ms between draft edits. */
  private readonly streamingEditIntervalMs: number;
  /** Chats (`${platform}:${chatId}`) where streaming was disabled after
   *  repeated flood-waits — future turns there fall back to non-streaming. */
  private readonly streamingDisabledChats = new Set<string>();
  /** Active turns by laneKey — used by graceful shutdown to notify users. */
  private readonly activeTurns = new Map<string, { adapter: PlatformAdapter; chatId: string }>();
  /** Active steer sinks by laneKey — inbound messages during a turn push here. */
  private readonly activeSinks = new Map<string, SteerSink>();
  /** Buffered notifications for sessions whose turn has ended. */
  private readonly unreadNotifications = new Map<string, string[]>();
  /**
   * Routing for an in-flight turn, keyed by `sessionKey`. Populated when the
   * turn is enqueued (where `adapter`, `chatId`, and `threadId` are all in
   * scope) and consumed by the `session_start` hook below, which is the only
   * place `sessionId` becomes known. `activeTurns` is keyed by `laneKey` and
   * lacks `threadId`, so it can't serve this — hence a parallel map.
   */
  private readonly sessionRouting = new Map<string, SessionRouting>();
  /**
   * `sessionId → routing` — the bridge a `before_tool_call` approval hook
   * needs. The hook only has `sessionId`; the adapter/chat/thread live on the
   * inbound message. The gateway is the one component that knows both halves,
   * so it owns the mapping. Populated by the `session_start` hook (which
   * carries both ids), cleared when the turn ends.
   */
  private readonly approvalRoutes = new Map<string, SessionRouting>();
  /**
   * `sessionKey → sessionId`, recorded by the `session_start` hook. The
   * gateway never computes `sessionId` itself (the AgentLoop does), so this
   * is how turn-end cleanup — which only knows `sessionKey` — finds the
   * `approvalRoutes` entry to evict.
   */
  private readonly sessionIdByKey = new Map<string, string>();
  private readonly maxChats: number;
  /** Optional clarify correlator — see GatewayConfig.clarifyMessageCorrelator. */
  private readonly clarifyCorrelator:
    | ((message: InboundMessage) => Promise<ClarifyResponse | null>)
    | undefined;
  /** Live timer running the periodic clarify sweep, cleared on shutdown. */
  private clarifySweepTimer: ReturnType<typeof setInterval> | undefined;
  /** Chapter 1 safety: per-platform sender allowlist + pairing config. */
  private readonly channelFilter: ChannelFilterConfig | undefined;
  /** Static per-channel toolset narrowing (platform → allowed tool names). */
  private readonly channelToolsets: Record<string, string[]> | undefined;
  /** SQLite DB for pairing codes. */
  private readonly pairingDb: Database.Database | undefined;
  /** Observability adapter for audit events. */
  private readonly observability: GatewayObservability | undefined;
  /** Hook fired after a turn completes with a delivered reply. */
  private readonly onTurnComplete: ((info: { platform: string }) => void) | undefined;
  /** Hook fired at turn start with the resolved personality (activity signal). */
  private readonly onUserTurn: ((info: { personalityId: string }) => void) | undefined;
  /** Global limiter on simultaneous turns (`maxConcurrentSessions` quota). */
  private readonly concurrency: TurnSemaphore;
  /** Per-lane queue cap — beyond this, saturated lanes get a busy rejection. */
  private readonly maxLaneQueue: number;
  /** Hook called when the allowlist changes via /allow or /deny. */
  private readonly onAllowlistChange:
    | ((platform: string, userId: string, action: 'add' | 'remove') => void | Promise<void>)
    | undefined;
  /** Optional card reader for `/personality rich`. */
  private readonly personalityCardReader:
    | { read(personalityId: string): Promise<{ text: string } | null> }
    | undefined;
  /** Optional greeting provider for `/start`. */
  private readonly greetingProvider: { greet(personalityId: string): Promise<string> } | undefined;
  /** Optional personality-directory seam for hot-reload (refresh + read). */
  private readonly personalityDirectory: GatewayConfig['personalityDirectory'];
  /** Optional attachment cache for cleanup on /new and lane eviction. */
  private readonly attachmentCache: AttachmentCache | undefined;
  /** STT provider registry for resolving voice transcription providers by name. */
  private readonly sttProviderRegistry: SttProviderRegistry | undefined;
  /** Name of the STT provider to use (from auxiliary.asr.provider in config). */
  private readonly sttProviderName: string | undefined;
  /** Lazily resolved STT provider instance. */
  private sttProvider: SttProvider | null = null;
  /** Whether `resolveSttProvider` has been called at least once. */
  private sttProviderResolved = false;
  /** TTS provider registry for resolving voice synthesis providers by name. */
  private readonly ttsProviderRegistry: TtsProviderRegistry | undefined;
  /** Name of the TTS provider to use (from auxiliary.tts.provider in config). */
  private readonly ttsProviderName: string | undefined;
  /** Lazily resolved TTS provider instance. */
  private ttsProvider: TtsProvider | null = null;
  /** Whether `resolveTtsProvider` has been called at least once. */
  private ttsProviderResolved = false;
  /** Config dict passed to STT provider factory. */
  private readonly sttProviderConfig: Record<string, unknown>;
  /** Config dict passed to TTS provider factory. */
  private readonly ttsProviderConfig: Record<string, unknown>;
  /** Secrets resolver for voice provider factories. */
  private readonly voiceSecretsResolver: import('@ethosagent/types').SecretsResolver | undefined;
  /** Per-lane voice mode. */
  private readonly voiceModes = new Map<string, VoiceMode>();
  /** Default voice mode for new lanes. */
  private readonly defaultVoiceMode: VoiceMode;
  /** Tracks whether the most recent inbound message per lane had audio. */
  private readonly lastInboundHadAudio = new Map<string, boolean>();
  /** Adapter lookup for agent-initiated outbound sends (send_message tool). */
  private readonly adapterRegistry: Map<string, PlatformAdapter>;
  private readonly resolveUserIdFn:
    | ((platform: string, platformUserId: string, displayLabel?: string) => Promise<string>)
    | undefined;
  private readonly trustedVoicePlugins: ReadonlySet<string> | undefined;
  /** Provider ids that actually resolved — answerable after the fact. */
  private resolvedSttProviderId: string | undefined;
  private resolvedTtsProviderId: string | undefined;
  /** Why a configured provider did not resolve (refusal, unknown, init fail). */
  private readonly voiceProviderErrors: { stt?: string; tts?: string } = {};
  private readonly pluginLoader: GatewayConfig['pluginLoader'];
  private readonly notificationRouter: GatewayConfig['notificationRouter'];
  /** Completion notices waiting for their lane to go idle. laneKey -> items. */
  private readonly pendingWakes = new Map<
    string,
    Array<{ job: BackgroundJob; bot: GatewayBotConfig }>
  >();
  /** job.id of every wake already delivered (or claimed for delivery) — exactly-once. */
  private readonly deliveredWakes = new Set<string>();
  /** Unsubscribe callbacks for each bot executor's `onComplete` subscription. */
  private readonly bgWakeUnsubs: Array<() => void> = [];
  /** Periodic timer retrying deferred wakes whose lane may since have gone idle. */
  private bgWakeSweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(config: GatewayConfig) {
    // The two construction shapes are mutually exclusive. Silent
    // precedence would let a caller wire both and not notice that
    // `loop` was ignored — a debugging nightmare three years out.
    if (config.bots && config.bots.length > 0 && config.loop !== undefined) {
      throw new Error(
        'Gateway: pass either `bots: [...]` (multi-bot) or `loop` (single-bot back-compat), not both.',
      );
    }
    const botEntries: GatewayBotConfig[] =
      config.bots && config.bots.length > 0
        ? config.bots
        : config.loop !== undefined
          ? [
              {
                // Back-compat: synthesize a one-entry routing table from the
                // legacy `loop` + `defaultPersonality` shorthand. `default`
                // is the lane-key segment for these messages.
                botKey: 'default',
                loop: config.loop,
                binding: {
                  type: 'personality',
                  name: config.defaultPersonality ?? 'default',
                  // The legacy single-bot path used to allow /personality
                  // switching freely. Preserve that.
                  allowSlashSwitch: true,
                },
              },
            ]
          : [];
    if (botEntries.length === 0) {
      throw new Error('Gateway: provide either `bots: [...]` or `loop` in GatewayConfig.');
    }
    this.bots = new Map(botEntries.map((b) => [b.botKey, b]));
    if (this.bots.size !== botEntries.length) {
      throw new Error('Gateway: duplicate botKey in GatewayConfig.bots.');
    }
    this.defaultBotKey = botEntries.length === 1 ? botEntries[0].botKey : null;

    // Bridge `sessionId → routing`. `session_start` fires inside `loop.run()`
    // (AgentLoop step 2) and is the only hook that carries BOTH `sessionId`
    // and `sessionKey`. We register it on every bot loop so that, by the time
    // any `before_tool_call` approval hook fires later in the same turn, the
    // gateway can resolve the sessionId back to its adapter/chat/thread.
    for (const entry of botEntries) {
      entry.loop.hooks.registerVoid('session_start', async (payload) => {
        const routing = this.sessionRouting.get(payload.sessionKey);
        if (routing) {
          this.approvalRoutes.set(payload.sessionId, routing);
          this.sessionIdByKey.set(payload.sessionKey, payload.sessionId);
        }
      });
    }

    this.dedupWindow = config.dedupWindow ?? 1024;
    this.maxChats = config.maxChats ?? 4096;
    this.channelFilter = config.channelFilter;
    this.channelToolsets = config.channelToolsets;
    this.pairingDb = config.pairingDb;
    this.observability = config.observability;
    this.onTurnComplete = config.onTurnComplete;
    this.onUserTurn = config.onUserTurn;
    // Global turn budget. Unset / non-positive => Infinity permits (unbounded,
    // preserving today's behavior). A positive value is the enforced quota.
    this.concurrency = new TurnSemaphore(
      config.maxConcurrentSessions && config.maxConcurrentSessions > 0
        ? config.maxConcurrentSessions
        : Number.POSITIVE_INFINITY,
    );
    this.maxLaneQueue = config.maxLaneQueue ?? 8;
    // ttlMs <= 0 disables dedup inside the cache itself (shouldSend always returns true).
    // onDrop surfaces every genuine duplicate suppression to observability
    // (read lazily, so it sees the observability set on the line above).
    this.outboundDedup = new MessageDedupCache({
      ttlMs: config.outboundDedupTtlMs ?? 30_000,
      onDrop: (info) => {
        this.observability?.recordSafetyBlock({
          code: 'gateway.dedup_drop',
          details: {
            sessionId: info.sessionId,
            contentHash: info.contentHash,
            contentLength: info.contentLength,
          },
        });
      },
    });
    this.deliveryLedger = config.deliveryLedger;
    // Streaming draft edits: DMs on, groups off, unless config overrides.
    this.streamingDm = config.streamingEdits?.dm ?? true;
    this.streamingGroup = config.streamingEdits?.group ?? false;
    this.streamingEditIntervalMs = config.streamingEditIntervalMs ?? 2500;
    this.onAllowlistChange = config.onAllowlistChange;
    this.clarifyCorrelator = config.clarifyMessageCorrelator;
    this.personalityCardReader = config.personalityCardReader;
    this.greetingProvider = config.greetingProvider;
    this.personalityDirectory = config.personalityDirectory;
    this.attachmentCache = config.attachmentCache;
    this.sttProviderRegistry = config.sttProviderRegistry;
    this.sttProviderName = config.sttProviderName;
    this.ttsProviderRegistry = config.ttsProviderRegistry;
    this.ttsProviderName = config.ttsProviderName;
    this.sttProviderConfig = config.sttProviderConfig ?? {};
    this.ttsProviderConfig = config.ttsProviderConfig ?? {};
    this.voiceSecretsResolver = config.voiceSecretsResolver;
    this.defaultVoiceMode = config.defaultVoiceMode ?? DEFAULT_VOICE_MODE;
    this.trustedVoicePlugins = config.trustedVoicePlugins;
    this.adapterRegistry = config.adapters ?? new Map();
    this.resolveUserIdFn = config.resolveUserId;
    this.pluginLoader = config.pluginLoader;
    this.notificationRouter = config.notificationRouter;

    // --- Plugin-contributed adapters (Channel SDK) ---
    if (config.pluginAdapters) {
      for (const [name, factory] of config.pluginAdapters) {
        // Default-deny: only start trusted channel plugins when the allowlist is set.
        // When trustedChannelPlugins is undefined, all plugins are allowed (backward compat).
        if (config.trustedChannelPlugins) {
          const pluginId = name.includes('/') ? (name.split('/')[0] ?? '') : name;
          if (!config.trustedChannelPlugins.has(pluginId)) {
            continue;
          }
        }
        const adapter = factory({});
        const adapterBotKey = deriveBotKey(name);
        const ctx: ChannelContext = {
          botKey: adapterBotKey,
          onMessage: async (msg: InboundMessage) => {
            // Pin unconditionally: a plugin adapter represents exactly one bot
            // (`adapterBotKey`), so a caller-supplied `botKey` must never be
            // allowed to address a different bot's loop.
            const stamped = { ...msg, botKey: adapterBotKey };
            await this.handleMessage(stamped, adapter);
          },
          logger: noopLogger,
        };
        if (adapter.startWithContext) {
          adapter.startWithContext(ctx).catch(() => {});
        } else {
          adapter.onMessage((msg: InboundMessage) => {
            // Pin unconditionally — see the startWithContext path above.
            const stamped = { ...msg, botKey: adapterBotKey };
            void this.handleMessage(stamped, adapter);
          });
          adapter.start().catch(() => {});
        }
        this.adapterRegistry.set(name, adapter);
      }
    }

    // Background completion wakes — one subscription per bot whose loop has a
    // durable executor. A finished job's notice is delivered to its originating
    // chat, but never while a turn is in flight on that lane (see flushWakes).
    for (const bot of botEntries) {
      if (!bot.backgroundExecutor) continue;
      this.bgWakeUnsubs.push(
        bot.backgroundExecutor.onComplete((job) => this.onBackgroundJobComplete(bot, job)),
      );
    }
    // Periodic retry for deferred wakes: a turn that was in flight when a job
    // finished won't always fire the turn-end flush for the RIGHT lane (a wake
    // may arrive between turns), so sweep every lane with pending items.
    this.bgWakeSweepTimer = setInterval(() => {
      for (const laneKey of [...this.pendingWakes.keys()]) void this.flushWakes(laneKey);
    }, 15_000);
    this.bgWakeSweepTimer.unref?.();

    // Clarify sweep — fires on a single timer for all bots' bridges so a
    // multi-bot deployment doesn't pile up N timers. Each bridge owns its own
    // expiry logic; we just tick them in parallel.
    const sweepMs = config.clarifySweepIntervalMs ?? 30_000;
    const bridges = botEntries
      .map((b) => b.loop.clarifyBridge)
      .filter((b): b is NonNullable<typeof b> => b !== undefined);
    if (sweepMs > 0 && bridges.length > 0) {
      this.clarifySweepTimer = setInterval(() => {
        void Promise.all(bridges.map((b) => b.sweep())).catch(() => {});
      }, sweepMs);
      // `unref()` lets the process exit when only the sweep timer remains.
      this.clarifySweepTimer.unref?.();
    }

    // Seed in-memory allowlists from DB-persisted approved senders
    if (config.pairingDb && config.channelFilter) {
      for (const [platform, cfg] of Object.entries(config.channelFilter)) {
        const approved = getApprovedSenders(config.pairingDb, platform);
        if (approved.length > 0) {
          if (!cfg.recipientAllowlist) cfg.recipientAllowlist = [];
          for (const id of approved) {
            if (!cfg.recipientAllowlist.includes(id)) cfg.recipientAllowlist.push(id);
          }
        }
      }
    }
  }

  // Both resolvers delegate to the SHARED resolution path in
  // `@ethosagent/core` — the same one web-api and the wiring-built
  // VoiceSession stack use. Nothing here re-implements provider lookup or the
  // local-only egress gate; a second implementation is exactly how "config
  // says one provider, the pipeline used another" happens. The resolved id is
  // remembered so callers can report which provider actually ran.
  private async resolveSttProvider(): Promise<SttProvider | null> {
    if (this.sttProviderResolved) return this.sttProvider;
    this.sttProviderResolved = true;
    const resolution = await resolveSharedStt({
      registry: this.sttProviderRegistry,
      providerName: this.sttProviderName,
      providerConfig: this.sttProviderConfig,
      ...(this.voiceSecretsResolver ? { secrets: this.voiceSecretsResolver } : {}),
      logger: noopLogger,
      ...(this.trustedVoicePlugins ? { trustedVoicePlugins: this.trustedVoicePlugins } : {}),
    });
    if (resolution.ok) {
      this.sttProvider = resolution.provider;
      this.resolvedSttProviderId = resolution.providerId;
    } else if (resolution.code !== 'not_configured') {
      // Transcription falls back to the placeholder path. The reason is kept
      // (not swallowed) so a refused provider is reportable rather than
      // looking like "voice just doesn't work here".
      this.voiceProviderErrors.stt = resolution.error;
    }
    return this.sttProvider;
  }

  private async resolveTtsProvider(): Promise<TtsProvider | null> {
    if (this.ttsProviderResolved) return this.ttsProvider;
    this.ttsProviderResolved = true;
    const resolution = await resolveSharedTts({
      registry: this.ttsProviderRegistry,
      providerName: this.ttsProviderName,
      providerConfig: this.ttsProviderConfig,
      ...(this.voiceSecretsResolver ? { secrets: this.voiceSecretsResolver } : {}),
      logger: noopLogger,
      ...(this.trustedVoicePlugins ? { trustedVoicePlugins: this.trustedVoicePlugins } : {}),
    });
    if (resolution.ok) {
      this.ttsProvider = resolution.provider;
      this.resolvedTtsProviderId = resolution.providerId;
    } else if (resolution.code !== 'not_configured') {
      // Voice replies stay disabled; keep the reason for the same purpose.
      this.voiceProviderErrors.tts = resolution.error;
    }
    return this.ttsProvider;
  }

  /**
   * What voice resolution actually does here: the provider ids that serve this
   * gateway, plus the reason either one is missing (unknown provider, failed
   * init, or refused by the local-only egress gate). Resolution is memoized,
   * so calling this is equivalent to what the first voice message triggers —
   * which is exactly why it can answer "which provider ran".
   */
  async voiceProviderStatus(): Promise<{
    stt: string | undefined;
    tts: string | undefined;
    sttError: string | undefined;
    ttsError: string | undefined;
  }> {
    await this.resolveSttProvider();
    await this.resolveTtsProvider();
    return {
      stt: this.resolvedSttProviderId,
      tts: this.resolvedTtsProviderId,
      sttError: this.voiceProviderErrors.stt,
      ttsError: this.voiceProviderErrors.tts,
    };
  }

  /**
   * Returns true if this message is a duplicate of one seen in the dedup
   * window (and records the key for future drops). Returns false for
   * never-before-seen keys, or when the message has no `messageId` (we can't
   * dedup what isn't keyed).
   *
   * The dedup key is platform-, bot-, chat-, and message-scoped: the same
   * `messageId` arriving through two different bots is two distinct
   * inbounds, not a duplicate. (Without the botKey segment, multi-bot
   * routing would silently drop one of them.)
   */
  private isDuplicate(message: InboundMessage, botKey: string): boolean {
    if (this.dedupWindow <= 0 || !message.messageId) return false;
    const key = buildLaneKey(message.platform, botKey, message.chatId, message.messageId);
    if (this.seenMessages.has(key)) return true;
    this.seenMessages.add(key);
    // Bound the set — drop the oldest entry once we exceed the window.
    if (this.seenMessages.size > this.dedupWindow) {
      const first = this.seenMessages.values().next().value;
      if (first !== undefined) this.seenMessages.delete(first);
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Public API — adapters call this for every inbound message
  // ---------------------------------------------------------------------------

  async handleMessage(message: InboundMessage, adapter: PlatformAdapter): Promise<void> {
    // Drop duplicates BEFORE any work — billing-relevant. See OpenClaw #71761
    // (channel messages injected twice → 2× cost). Use the resolved botKey
    // (message.botKey or the synthesized default) so multi-bot routing
    // doesn't accidentally cross-dedupe. Edited messages (`isEdit: true`)
    // bypass dedup because they intentionally re-use the same `messageId`
    // with different content.
    // NOTE (GWA-008): dedup/clarify are intentionally keyed on this
    // pre-resolution `dedupBotKey`, not the authoritative `bot.botKey`
    // resolved further below. Dedup must run BEFORE any work (billing) and
    // before the safety filter can rewrite `message`, so it cannot wait on
    // full resolution. Adapters stamp `botKey` consistently, so the two agree
    // in practice; single-bot has one loop, so a stale/foreign botKey here has
    // no cross-bot effect. The namespace divergence is deliberate, not a bug.
    const dedupBotKey = message.botKey ?? this.defaultBotKey ?? '';
    if (!message.isEdit && this.isDuplicate(message, dedupBotKey)) return;

    // --- Clarify correlator: short-circuit force-reply + `/cancel` ---
    // Runs BEFORE the safety filter's mention gate so an approved sender's
    // force-reply isn't treated as a fresh agent prompt (the agent is
    // already paused inside `clarify()` waiting on this answer). But we
    // still gate on the *allowlist* portion of the safety filter — a
    // non-allowlisted sender in a group chat must NOT be able to resolve
    // the bot's pending clarify (that would be an authentication bypass,
    // not just a routing shortcut).
    if (this.clarifyCorrelator) {
      const platformCfg = this.channelFilter?.[message.platform];
      if (isSenderAllowed(message, platformCfg)) {
        const resp = await this.clarifyCorrelator(message).catch(() => null);
        if (resp) {
          const bot = this.bots.get(dedupBotKey);
          await bot?.loop.clarifyBridge?.respond(resp);
          return;
        }
      }
    }

    // --- Chapter 1: before_inbound channel safety filter ---
    if (this.channelFilter) {
      const platformCfg = this.channelFilter[message.platform];
      const filterResult = checkMessage(message, platformCfg, this.pairingDb);

      if (filterResult.action === 'drop') {
        // Emit audit event for observability
        this.observability?.recordSafetyBlock({
          code: message.isDm ? 'channel.allowlist.blocked' : 'channel.mention_gate',
          details: {
            platform: message.platform,
            chatId: message.chatId,
            userId: message.userId,
            isDm: message.isDm,
            isGroupMention: message.isGroupMention,
          },
        });
        return;
      }

      if (filterResult.action === 'pairing_reply') {
        await adapter.send(message.chatId, { text: filterResult.reply ?? '' }).catch(() => {});
        return;
      }

      // 'allow' — if context was stripped, use stripped text for the turn
      if (filterResult.strippedText !== undefined) {
        this.observability?.recordSafetyBlock({
          code: 'channel.context_stripped',
          details: {
            platform: message.platform,
            chatId: message.chatId,
            userId: message.userId,
            replyToId: message.replyToId,
          },
        });
        message = { ...message, text: filterResult.strippedText };
      }
    }

    // Resolve which bot this message is for. `message.botKey` wins when
    // adapters populate it; single-bot deployments fall back to the
    // synthesized default. The degrade-to-default fallback below is
    // reachable in SINGLE-BOT mode ONLY: `this.defaultBotKey` is null in
    // multi-bot deployments (see constructor), so a multi-bot message with
    // an unknown botKey is dropped at `no_bot_available` rather than routed
    // to another bot's loop — cross-bot isolation is preserved.
    let botKey = message.botKey ?? this.defaultBotKey ?? '';
    let bot = botKey ? this.bots.get(botKey) : undefined;
    if (!bot && this.defaultBotKey) {
      // Graceful fallback (single-bot only — `defaultBotKey` is null in
      // multi-bot): an unknown botKey degrades to the sole bot rather than
      // silently dropping. The observability event lets operators spot a
      // misconfigured adapter that is stamping the wrong botKey.
      this.observability?.recordSafetyBlock({
        code: 'gateway.unknown_botKey',
        details: {
          platform: message.platform,
          chatId: message.chatId,
          botKey: message.botKey,
          fallback: this.defaultBotKey,
        },
      });
      botKey = this.defaultBotKey;
      bot = this.bots.get(botKey);
    }
    if (!bot) {
      this.observability?.recordSafetyBlock({
        code: 'gateway.no_bot_available',
        details: { platform: message.platform, chatId: message.chatId, botKey },
      });
      return;
    }
    // Adapters that surface a thread identifier (currently only Slack, via
    // `thread_ts`) get a per-thread lane so concurrent threads in the same
    // channel never share session state. Adapters without thread semantics
    // omit `threadId` and the key degrades to the unthreaded form.
    //
    // Empty-string `threadId` is treated as no thread: the contract is
    // `threadId?: string`, but an empty string carries no routing signal,
    // and admitting it would mean a misbehaving adapter could quietly
    // build a thread lane keyed on `''` — distinct from the unthreaded
    // root but holding only its mistakes.
    const threadId = message.threadId ? message.threadId : undefined;
    const laneKey = threadId
      ? buildLaneKey(message.platform, bot.botKey, message.chatId, threadId)
      : buildLaneKey(message.platform, bot.botKey, message.chatId);
    const lane = this.getOrCreateLane(laneKey);
    const rawText = message.text?.trim() ?? '';
    const text = bot.piiRedaction ? redactPii(rawText) : rawText;

    // --- Gateway-level slash command handling ---

    const cmdToken = text.split(/\s+/)[0] ?? '';
    const cmdType = PLATFORM_COMMANDS[cmdToken.toLowerCase()];

    if (cmdType === 'stop') {
      lane.abort();
      await adapter.send(message.chatId, { text: '✓ Stopped.' }).catch(() => {});
      return;
    }

    if (cmdType === 'new') {
      lane.abort();
      const previousSession = this.sessionKeys.get(laneKey) ?? laneKey;
      this.outboundDedup.clearSession(previousSession);
      void this.attachmentCache?.clear(previousSession).catch(() => {});
      const fresh = `${laneKey}:${Date.now()}`;
      this.sessionKeys.set(laneKey, fresh);
      this.usageStore.delete(laneKey);
      this.personalityIds.delete(laneKey); // reset to default personality
      this.voiceModes.delete(laneKey);
      this.lastInboundHadAudio.delete(laneKey);
      await adapter.send(message.chatId, { text: '✓ New session started.' }).catch(() => {});
      return;
    }

    if (cmdType === 'help') {
      const current = this.activePersonalityFor(laneKey, bot);
      const personalityLines = this.personalitySwitchAllowed(bot)
        ? [
            `/personality — show current personality (${current})`,
            `/personality list — available personalities`,
            `/personality <id> — switch personality`,
          ]
        : [`/personality — show current binding (${current}; switching disabled)`];
      let helpText =
        `/new — start a fresh session\n` +
        `/stop — abort current response\n` +
        `${personalityLines.join('\n')}\n` +
        `/usage — token and cost stats\n` +
        `/compact [focus] — compress older context now\n` +
        `/voice — set voice reply mode (off|mirror_inbound|all)\n` +
        `/help — this message`;
      const pluginCmds = this.pluginLoader?.getAllSlashCommands() ?? [];
      if (pluginCmds.length > 0) {
        const pluginLines = pluginCmds
          .map((c) => `/${c.name} — ${c.description} [plugin]`)
          .join('\n');
        helpText += `\n\n${pluginLines}`;
      }
      await adapter
        .send(message.chatId, {
          text: helpText,
        })
        .catch(() => {});
      return;
    }

    if (cmdType === 'start') {
      const personalityId = this.activePersonalityFor(laneKey, bot);
      if (this.greetingProvider) {
        const greeting = await this.greetingProvider.greet(personalityId).catch(() => null);
        if (greeting) {
          await adapter.send(message.chatId, { text: greeting }).catch(() => {});
          return;
        }
      }
      await adapter
        .send(message.chatId, {
          text: `Hello! I'm running as *${personalityId}*. Send a message to get started, or try /help for available commands.`,
        })
        .catch(() => {});
      return;
    }

    if (cmdType === 'personality') {
      // Refresh from disk before resolving so a newly dropped or edited
      // personality is visible to this command. Seam absent → no-op. Fail-open:
      // a refresh that throws (e.g. malformed personality YAML on disk) must not
      // abort the command — the seam impl logs; we proceed with the last-good
      // registry (stale-but-alive beats a dead command).
      await this.personalityDirectory?.refresh().catch(() => {});
      const arg = text.split(/\s+/).slice(1).join(' ').trim();
      const current = this.activePersonalityFor(laneKey, bot);

      if (!arg) {
        await adapter
          .send(message.chatId, { text: `Current personality: ${current}` })
          .catch(() => {});
        return;
      }

      // `/personality rich` — full character sheet. Works for personality
      // bindings even when switching is disabled; team bindings fall through
      // to the compact view.
      if (
        arg.toLowerCase() === 'rich' &&
        this.personalityCardReader &&
        bot.binding.type === 'personality'
      ) {
        const card = await this.personalityCardReader.read(current).catch(() => null);
        if (card) {
          await adapter.send(message.chatId, { text: card.text }).catch(() => {});
          return;
        }
      }

      // Identity-bound bots reject the switch — the bot's external
      // identity is the routing contract. The user sees a clear pointer
      // to the right surface to switch to. Team-bots reject regardless
      // of allowSlashSwitch because the coordinator is structurally part
      // of the loop, not a runtime hat.
      if (!this.personalitySwitchAllowed(bot)) {
        await adapter
          .send(message.chatId, {
            text:
              `This bot is bound to ${bot.binding.type} '${bot.binding.name}'. ` +
              `Switching personalities is disabled for identity-bound bots. ` +
              `To talk to a different agent, message that agent's bot.`,
          })
          .catch(() => {});
        return;
      }

      if (arg === 'list') {
        const dir = this.personalityDirectory;
        const listText = dir
          ? `${dir
              .list()
              .map((p) => `${p.id} — ${p.name}${p.isDefault ? ' (default)' : ''}`)
              .join('\n')}\n\nUse /personality <id> to switch.`
          : 'Built-in personalities: researcher · engineer · reviewer · coach · operator\n\nUse /personality <id> to switch.';
        await adapter.send(message.chatId, { text: listText }).catch(() => {});
        return;
      }

      // Validate against the registry before storing the id. Unknown ids must
      // never be stored — turn-setup's `?? getDefault()` would then silently run
      // the default personality. With the seam wired, validate against the
      // just-refreshed seam registry; without it (standalone/test), fall back to
      // this bot's own loop registry so validation is never skipped. If neither
      // can validate, treat the id as unknown (surface not-found, store nothing)
      // rather than storing an unverified id.
      const known = this.personalityDirectory
        ? this.personalityDirectory.has(arg)
        : typeof bot.loop.getPersonalityIds === 'function'
          ? bot.loop.getPersonalityIds().includes(arg)
          : false;
      if (!known) {
        await adapter
          .send(message.chatId, {
            text: `Personality '${arg}' not found — /personality list to see what's available.`,
          })
          .catch(() => {});
        return;
      }

      // Switch personality — also start a fresh session so the new identity takes effect immediately
      const previousSession = this.sessionKeys.get(laneKey) ?? laneKey;
      this.outboundDedup.clearSession(previousSession);
      void this.attachmentCache?.clear(previousSession).catch(() => {});
      this.personalityIds.set(laneKey, arg);
      const fresh = `${laneKey}:${Date.now()}`;
      this.sessionKeys.set(laneKey, fresh);
      await adapter
        .send(message.chatId, { text: `✓ Switched to ${arg} personality. New session started.` })
        .catch(() => {});
      return;
    }

    if (cmdType === 'usage') {
      const u = this.usageStore.get(laneKey) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
      await adapter
        .send(message.chatId, {
          text: `Tokens: ${u.inputTokens.toLocaleString()} in / ${u.outputTokens.toLocaleString()} out\nCost: $${u.costUsd.toFixed(5)}`,
        })
        .catch(() => {});
      return;
    }

    if (cmdType === 'allow') {
      const code = text.split(/\s+/)[1]?.toUpperCase() ?? '';
      if (!code || !this.pairingDb || !this.channelFilter) {
        await adapter
          .send(message.chatId, { text: '✗ Pairing not configured or no code given.' })
          .catch(() => {});
        return;
      }

      // Verify the caller is the configured owner for the code's platform before consuming.
      // This prevents allowlisted non-owners from approving pairings.
      const codeRow = this.pairingDb
        .prepare('SELECT platform FROM pairing_codes WHERE code = ?')
        .get(code) as { platform: string } | undefined;

      if (codeRow) {
        const codePlatformCfg = this.channelFilter[codeRow.platform];
        const isOwner =
          codePlatformCfg?.ownerUserId && message.userId === codePlatformCfg.ownerUserId;
        if (!isOwner) {
          await adapter
            .send(message.chatId, { text: '✗ Only the owner may approve pairings.' })
            .catch(() => {});
          return;
        }
      }

      const result = consumeAndAllow(this.pairingDb, code, message.userId);
      if (result.ok) {
        // Update in-memory cache
        const platformCfg = this.channelFilter[result.platform];
        if (platformCfg) {
          if (!platformCfg.recipientAllowlist) platformCfg.recipientAllowlist = [];
          if (!platformCfg.recipientAllowlist.includes(result.senderId)) {
            platformCfg.recipientAllowlist.push(result.senderId);
          }
        }
        this.observability?.recordChannelAllow({
          code: 'channel.pairing.approved',
          details: {
            approvedUserId: result.senderId,
            approvedPlatform: result.platform,
            byUserId: message.userId,
          },
        });
        await this.onAllowlistChange?.(result.platform, result.senderId, 'add');
        await adapter
          .send(message.chatId, { text: `✓ ${result.senderId} approved.` })
          .catch(() => {});
      } else if (result.reason === 'owner_paused') {
        await adapter
          .send(message.chatId, { text: '✗ Too many invalid attempts. Pairing paused for 24h.' })
          .catch(() => {});
      } else {
        await adapter.send(message.chatId, { text: '✗ Invalid or expired code.' }).catch(() => {});
      }
      return;
    }

    if (cmdType === 'deny') {
      const targetUserId = text.split(/\s+/)[1] ?? '';
      const cleanTarget = targetUserId.replace(/^@/, '');
      if (!cleanTarget || !this.channelFilter) {
        await adapter.send(message.chatId, { text: '✗ Usage: /deny <userId>' }).catch(() => {});
        return;
      }

      let removed = false;
      for (const [platform, cfg] of Object.entries(this.channelFilter)) {
        // Only the owner can remove senders.
        const isOwner = cfg.ownerUserId && message.userId === cfg.ownerUserId;
        if (!isOwner) continue;

        let removedOnPlatform = false;

        // Remove from in-memory list.
        const list = cfg.recipientAllowlist;
        if (list) {
          const idx = list.indexOf(cleanTarget);
          if (idx !== -1) {
            list.splice(idx, 1);
            removedOnPlatform = true;
          }
        }

        // Revoke from persistent DB — idempotent, catches pairing-approved senders.
        if (this.pairingDb && revokeApproval(this.pairingDb, cleanTarget, platform)) {
          removedOnPlatform = true;
        }

        if (removedOnPlatform) {
          removed = true;
          this.observability?.recordChannelDeny({
            code: 'channel.allowlist.removed',
            details: { removedUserId: cleanTarget, platform, byUserId: message.userId },
          });
          await this.onAllowlistChange?.(platform, cleanTarget, 'remove');
        }
      }

      if (removed) {
        await adapter.send(message.chatId, { text: `✓ ${cleanTarget} removed.` }).catch(() => {});
      } else {
        await adapter
          .send(message.chatId, { text: `✗ ${cleanTarget} not found in any allowlist.` })
          .catch(() => {});
      }
      return;
    }

    if (cmdType === 'communications') {
      if (!this.pairingDb || !this.channelFilter) {
        await adapter.send(message.chatId, { text: 'Pairing not configured.' }).catch(() => {});
        return;
      }

      const platformCfg = this.channelFilter[message.platform];
      const isOwner = platformCfg?.ownerUserId && message.userId === platformCfg.ownerUserId;
      if (!isOwner) {
        await adapter
          .send(message.chatId, { text: '✗ Only the owner may use /communications.' })
          .catch(() => {});
        return;
      }

      const subCmd = text.split(/\s+/)[1]?.toLowerCase();

      if (subCmd === 'approve-all') {
        // Scope to platforms where the caller is the configured owner.
        const ownedPlatforms = new Set(
          Object.entries(this.channelFilter)
            .filter(([, cfg]) => cfg.ownerUserId && message.userId === cfg.ownerUserId)
            .map(([p]) => p),
        );

        const pending = this.pairingDb
          .prepare(`SELECT code, platform FROM pairing_codes WHERE status = 'pending'`)
          .all() as { code: string; platform: string }[];

        let approvedCount = 0;
        for (const { code, platform } of pending) {
          if (!ownedPlatforms.has(platform)) continue;
          const result = consumeAndAllow(this.pairingDb, code, message.userId);
          if (result.ok) {
            approvedCount++;
            const cfg = this.channelFilter[result.platform];
            if (cfg) {
              if (!cfg.recipientAllowlist) cfg.recipientAllowlist = [];
              if (!cfg.recipientAllowlist.includes(result.senderId)) {
                cfg.recipientAllowlist.push(result.senderId);
              }
            }
            await this.onAllowlistChange?.(result.platform, result.senderId, 'add');
          }
        }

        await adapter
          .send(message.chatId, { text: `✓ Approved ${approvedCount} sender(s).` })
          .catch(() => {});
        return;
      }

      // Default: list pending codes
      const pending = this.pairingDb
        .prepare(`SELECT code, sender_id, platform FROM pairing_codes WHERE status = 'pending'`)
        .all() as { code: string; sender_id: string; platform: string }[];

      if (pending.length === 0) {
        await adapter
          .send(message.chatId, { text: 'No pending pairing requests.' })
          .catch(() => {});
        return;
      }

      const lines = pending.map((r) => `${r.sender_id} (${r.platform}) — /allow ${r.code}`);
      const reply = `${pending.length} pending pairing request(s):\n${lines.join('\n')}`;
      await adapter.send(message.chatId, { text: reply }).catch(() => {});
      return;
    }

    // --- /background command ---
    if (cmdType === 'background') {
      const bgText = text.slice('/background '.length).trim();
      if (!bgText) {
        await adapter
          .send(message.chatId, { text: '✗ Usage: /background <prompt>' })
          .catch(() => {});
        return;
      }
      const jobStore = bot.jobStore;
      const executor = bot.backgroundExecutor;
      // Background disabled for this bot (e.g. one-shot / team-bound loop) — the
      // durable engine isn't wired. Reply gracefully instead of crashing.
      if (!jobStore || !executor) {
        await adapter
          .send(message.chatId, {
            text: '✗ Background jobs are not enabled for this bot.',
            threadId,
          })
          .catch(() => {});
        return;
      }
      const root = this.sessionKeys.get(laneKey) ?? laneKey;
      // Per-root concurrency cap parity with the durable engine (default 3).
      const cap = BACKGROUND_MAX_JOBS_PER_ROOT;
      if ((await jobStore.countActiveByRoot(root)) >= cap) {
        await adapter
          .send(message.chatId, {
            text: `⚠ Background queue full (max ${cap}). Wait for a task to finish.`,
            threadId,
          })
          .catch(() => {});
        return;
      }
      const personalityId =
        bot.binding.type === 'team' ? undefined : this.activePersonalityFor(laneKey, bot);
      const short = randomUUID().slice(0, 8);
      const job = await jobStore.create({
        owner: executor.owner,
        parentSessionKey: root,
        rootSessionKey: root,
        childSessionKey: `${root}:bgcmd:${short}`,
        ...(personalityId ? { personalityId } : {}),
        depth: 0,
        prompt: bgText,
        originPlatform: message.platform,
        originBotKey: bot.botKey,
        originChatId: message.chatId,
        ...(threadId ? { originThreadId: threadId } : {}),
      });
      executor.nudge();
      // The id is the whole point of the ack: without it the user has nothing to
      // correlate the launch to — not the completion notice (which prints the
      // same short id), not `task_logs`. The full id is what task_* tools take.
      await adapter
        .send(message.chatId, {
          text: `⏳ Background task started — job ${job.id}`,
          threadId,
        })
        .catch(() => {});
      return;
    }

    if (cmdType === 'voice') {
      const arg = text.split(/\s+/).slice(1).join(' ').trim().toLowerCase();
      const validModes: VoiceMode[] = ['off', 'mirror_inbound', 'all'];
      if (arg && validModes.includes(arg as VoiceMode)) {
        this.voiceModes.set(laneKey, arg as VoiceMode);
        await adapter
          .send(message.chatId, { text: `✓ Voice mode: ${arg}`, threadId })
          .catch(() => {});
      } else if (!arg) {
        const current = this.voiceModes.get(laneKey) ?? this.defaultVoiceMode;
        await adapter
          .send(message.chatId, {
            text: `Voice mode: ${current}\nUsage: /voice off|mirror_inbound|all`,
            threadId,
          })
          .catch(() => {});
      } else {
        await adapter
          .send(message.chatId, {
            text: `Unknown voice mode "${arg}". Options: off, mirror_inbound, all`,
            threadId,
          })
          .catch(() => {});
      }
      return;
    }

    if (cmdType === 'compact') {
      const focus = text.split(/\s+/).slice(1).join(' ').trim();
      if (focus.toLowerCase() === 'status') {
        await adapter
          .send(message.chatId, {
            text: 'Context anatomy is available in the CLI: `ethos sessions show <id>`.',
            threadId,
          })
          .catch(() => {});
        return;
      }
      const sessionKey = this.sessionKeys.get(laneKey) ?? laneKey;
      const personalityId = this.activePersonalityFor(laneKey, bot);
      const result = await bot.loop
        .compact(sessionKey, {
          personalityId,
          ...(focus ? { instructions: focus } : {}),
        })
        .catch(() => null);
      let reply: string;
      if (!result?.ok) {
        reply = '✗ Not enough history to compact yet.';
      } else {
        const saved = Math.max(0, result.preTotalTokens - result.postTotalTokens);
        reply =
          `✓ Compacted ${result.droppedCount} earlier message(s) (${result.engineName}): ` +
          `${result.preTotalTokens.toLocaleString()} → ${result.postTotalTokens.toLocaleString()} tok (−${saved.toLocaleString()}).`;
        if (!result.summariesEnabled) {
          reply +=
            '\nSummaries disabled — set auxiliary.compression.model to enable summarized compaction.';
        }
      }
      await adapter.send(message.chatId, { text: reply, threadId }).catch(() => {});
      return;
    }

    // --- /queue command ---
    if (cmdType === 'queue') {
      const queueText = text.slice('/queue '.length).trim();
      if (!queueText) {
        await adapter.send(message.chatId, { text: '✗ Usage: /queue <message>' }).catch(() => {});
        return;
      }
      if (this.activeSinks.has(laneKey)) {
        void this.enqueueTurn(laneKey, lane, bot, message, adapter, queueText, threadId);
        await adapter
          .send(message.chatId, { text: `✅ queued (position ${lane.length})`, threadId })
          .catch(() => {});
        return;
      }
    }

    // --- /learn command ---
    if (!cmdType && /^\/learn(?:\s|$)/i.test(text)) {
      const { parseLearnArgs, buildLearnPrompt } = await import('@ethosagent/core');
      const learnText = text.slice('/learn'.length).trim();
      const parsed = parseLearnArgs(learnText);
      const personalityId = this.activePersonalityFor(laneKey, bot);
      const learnSessionKey = this.sessionKeys.get(laneKey) ?? laneKey;
      const prompt = buildLearnPrompt({
        hint: parsed.hint,
        description: parsed.description,
        personalityId,
        sessionKey: learnSessionKey,
        surface: 'gateway',
      });
      await this.enqueueTurn(laneKey, lane, bot, message, adapter, prompt, threadId);
      return;
    }

    // --- Plugin slash commands ---
    if (!cmdType && text.startsWith('/')) {
      const cmdName = text.split(/\s+/)[0]?.slice(1).toLowerCase();
      const pluginHandler = cmdName ? this.pluginLoader?.getSlashHandler(cmdName) : undefined;
      if (pluginHandler) {
        const cmdArgs = text.split(/\s+/).slice(1).join(' ');
        const sessionId = this.sessionKeys.get(laneKey) ?? laneKey;
        const personalityId = this.activePersonalityFor(laneKey, bot);
        const ctx: import('@ethosagent/types').SlashCommandContext = {
          sessionId,
          personalityId,
          platform: message.platform,
          send: async (t: string) => {
            await adapter.send(message.chatId, { text: t, threadId }).catch(() => {});
          },
        };
        try {
          const result = await pluginHandler(cmdArgs, ctx);
          if (result)
            await adapter.send(message.chatId, { text: result, threadId }).catch(() => {});
        } catch (err) {
          await adapter
            .send(message.chatId, { text: `Plugin command error: ${String(err)}`, threadId })
            .catch(() => {});
        }
        return;
      }
    }

    // --- Deterministic pre-LLM shortcut: gateway_message claiming hook ---
    // Fired after the bot/lane is resolved and every built-in / plugin slash
    // command has had its shot, but BEFORE any session/turn cost (steer,
    // backpressure, enqueue) — a claimed message never starts an agent turn
    // and never steers into a running one. No handler registered →
    // fireClaiming returns { handled: false } and behavior is unchanged.
    // The stub-loop guard (`typeof … === 'function'`) keeps loops without a
    // full HookRegistry (tests) on the unchanged path.
    if (typeof bot.loop.hooks?.fireClaiming === 'function') {
      const claim = await bot.loop.hooks
        .fireClaiming('gateway_message', {
          platform: message.platform,
          chatId: message.chatId,
          botKey: bot.botKey,
          ...(message.userId !== undefined ? { userId: message.userId } : {}),
          text,
          isDm: message.isDm,
        })
        .catch((): { handled: boolean; reply?: string } => ({ handled: false }));
      if (claim.handled) {
        this.observability?.recordSafetyBlock({
          code: 'gateway.message_claimed',
          details: {
            platform: message.platform,
            chatId: message.chatId,
            botKey: bot.botKey,
            hasReply: typeof claim.reply === 'string' && claim.reply.length > 0,
          },
        });
        const reply = claim.reply;
        if (typeof reply === 'string' && reply.length > 0) {
          // Same outbound path as normal turn replies: session-keyed dedup
          // gate, then the ledger-wrapped adapter send.
          const claimSessionKey = this.sessionKeys.get(laneKey) ?? laneKey;
          if (this.outboundDedup.shouldSend(claimSessionKey, reply)) {
            await this.sendTracked(
              {
                adapter,
                botKey: bot.botKey,
                platform: message.platform,
                chatId: message.chatId,
                sessionKey: claimSessionKey,
              },
              { text: reply, threadId },
            );
          }
        }
        return;
      }
    }

    // --- Auto-steer: if a turn is already running, push into its steer sink ---
    const activeSink = this.activeSinks.get(laneKey);
    if (activeSink) {
      const accepted = activeSink.push(text);
      if (accepted) {
        await adapter.send(message.chatId, { text: '↩ noted', threadId }).catch(() => {});
      }
      return;
    }

    // --- Agent turn ---

    const turnText = cmdType === 'queue' ? text.slice('/queue '.length).trim() : text;

    // Backpressure: when the global turn budget is saturated AND this lane has
    // already queued its cap, reject with a typed busy reply rather than
    // growing an unbounded backlog or dropping silently. An unset
    // (Infinity-permit) budget never saturates, so this never trips.
    if (this.concurrency.saturated && lane.length >= this.maxLaneQueue) {
      this.observability?.recordSafetyBlock({
        code: 'gateway.session_busy',
        details: {
          platform: message.platform,
          chatId: message.chatId,
          botKey: bot.botKey,
          laneDepth: lane.length,
          maxLaneQueue: this.maxLaneQueue,
        },
      });
      await adapter.send(message.chatId, { text: SYSTEM_BUSY_MESSAGE, threadId }).catch(() => {});
      return;
    }

    await this.enqueueTurn(laneKey, lane, bot, message, adapter, turnText, threadId);
  }

  /**
   * Enqueue a turn on `lane`, gated by the global concurrency semaphore. The
   * permit is acquired INSIDE the lane task (so lane ordering is preserved)
   * but BEFORE `runTurn` marks the lane active — so while a turn waits for a
   * global slot, further inbound messages for the lane enqueue (and hit the
   * per-lane cap) instead of steering into a turn that hasn't started.
   *
   * Leak-free: the permit is released in `finally`; an abort before a slot
   * frees resolves `acquire` to `false` (no permit held, nothing to release,
   * `runTurn` never runs so there is no lane state to unwind).
   */
  private enqueueTurn(
    laneKey: string,
    lane: SessionLane,
    bot: GatewayBotConfig,
    message: InboundMessage,
    adapter: PlatformAdapter,
    text: string,
    threadId: string | undefined,
  ): Promise<void> {
    return lane.enqueue(async (signal) => {
      const slotHeld = await this.concurrency.acquire(signal);
      if (!slotHeld) return;
      try {
        await this.runTurn(laneKey, lane, bot, message, adapter, text, threadId, signal);
      } finally {
        this.concurrency.release();
      }
    });
  }

  /**
   * Whether this turn's reply should stream as live draft edits. Requires the
   * chat class (DM/group) to be enabled, the adapter to support editing, and
   * the chat not to have been flood-disabled earlier this run.
   */
  private shouldStream(message: InboundMessage, adapter: PlatformAdapter): boolean {
    const enabled = message.isDm ? this.streamingDm : this.streamingGroup;
    if (!enabled) return false;
    if (!adapter.canEditMessage || typeof adapter.editMessage !== 'function') return false;
    if (this.streamingDisabledChats.has(`${message.platform}:${message.chatId}`)) return false;
    return true;
  }

  private async runTurn(
    laneKey: string,
    _lane: SessionLane,
    bot: GatewayBotConfig,
    message: InboundMessage,
    adapter: PlatformAdapter,
    text: string,
    threadId: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const sessionKey = this.sessionKeys.get(laneKey) ?? laneKey;
    this.lastInboundHadAudio.set(laneKey, hasAudioAttachments(message.attachments));
    // Refresh every loop registry from disk before resolving which personality
    // this turn runs as, so a hot-dropped or edited directory takes effect on
    // the next turn without a restart. Seam absent (tests, standalone) → no-op.
    // Fail-open: a refresh that throws (e.g. malformed YAML on disk) must not
    // abort the turn — the seam impl logs; we proceed with the last-good
    // registry (stale-but-alive beats a dead turn).
    await this.personalityDirectory?.refresh().catch(() => {});
    const personalityId =
      bot.binding.type === 'team'
        ? undefined
        : (this.personalityIds.get(laneKey) ?? bot.binding.name);

    // Activity signal, fired at turn START so a listener can cancel background
    // work before the turn runs — not at completion, which would be too late.
    if (personalityId) this.onUserTurn?.({ personalityId });

    this.activeTurns.set(laneKey, { adapter, chatId: message.chatId });

    // Flush buffered notifications from previous disconnected period
    if (this.notificationRouter) {
      const buffered = this.unreadNotifications.get(sessionKey);
      if (buffered && buffered.length > 0) {
        this.unreadNotifications.delete(sessionKey);
        for (const note of buffered) {
          await adapter.send(message.chatId, { text: note, threadId }).catch(() => {});
        }
      }
    }

    let turnActive = true;
    if (this.notificationRouter) {
      this.notificationRouter.register(sessionKey, {
        send: async (text: string) => {
          if (turnActive) {
            await adapter.send(message.chatId, { text, threadId }).catch(() => {});
          } else {
            const buf = this.unreadNotifications.get(sessionKey) ?? [];
            buf.push(text);
            this.unreadNotifications.set(sessionKey, buf);
          }
        },
        injectUserMessage: async (_msg: string) => {},
      });
    }

    const steerSink = createSteerSink();
    this.activeSinks.set(laneKey, steerSink);

    this.sessionRouting.set(sessionKey, {
      adapter,
      chatId: message.chatId,
      threadId: message.threadId ? message.threadId : undefined,
      requesterUserId: message.userId,
    });

    await adapter.sendTyping?.(message.chatId).catch(() => {});
    const typingTimer = setInterval(() => {
      void adapter.sendTyping?.(message.chatId).catch(() => {});
    }, 4_000);

    try {
      let responseText = '';
      let errored: { error: string; code: string } | null = null;

      // --- Voice pipeline: auto-transcribe audio attachments ---
      if (hasAudioAttachments(message.attachments) && this.attachmentCache) {
        const provider = await this.resolveSttProvider();
        const results = await transcribeAudioAttachments(
          message.attachments ?? [],
          provider,
          (url) => this.attachmentCache?.resolveLocalPath(url) ?? url,
        );
        text = buildTranscriptText(text, results);
      }

      const wrapped = wrapUntrusted({ content: text, toolName: 'channel_message' });

      const contextPrefix = message.priorContext
        ? wrapUntrusted({ content: message.priorContext, toolName: 'channel_history' }).content +
          '\n\n---\n\n'
        : '';

      const loopText = contextPrefix ? `${contextPrefix}${wrapped.content}` : wrapped.content;

      const tier1 = shortPatternCheck(text);
      if (tier1.containsInstructions || wrapped.strippedTokens > 0) {
        this.observability?.recordInjectionFlag?.({
          code: 'channel.injection_detected',
          cause: tier1.containsInstructions
            ? (tier1.hits[0]?.rule ?? 'pattern-hit')
            : `stripped ${wrapped.strippedTokens} template token${wrapped.strippedTokens === 1 ? '' : 's'}`,
          details: {
            platform: message.platform,
            chatId: message.chatId,
            userId: message.userId,
            ...(tier1.containsInstructions ? { hits: tier1.hits } : {}),
          },
        });
      }

      const userId =
        message.userId && this.resolveUserIdFn
          ? await this.resolveUserIdFn(message.platform, message.userId, message.username)
          : undefined;

      // W3.1 — live draft-edit streamer, gated by chat class + adapter caps.
      // The ledger binding rides along so the streamer's TERMINAL edit gets the
      // same durable obligation the non-streaming paths get.
      const streamDelivery = this.deliveryBinding(bot.botKey, message.platform);
      const streamer = this.shouldStream(message, adapter)
        ? new DraftStreamer({
            adapter,
            chatId: message.chatId,
            threadId,
            sessionKey,
            dedup: this.outboundDedup,
            ...(streamDelivery ? { delivery: streamDelivery } : {}),
            minEditIntervalMs: this.streamingEditIntervalMs,
            onFloodDisable: () => {
              this.streamingDisabledChats.add(`${message.platform}:${message.chatId}`);
              this.observability?.recordSafetyBlock({
                code: 'gateway.streaming_disabled',
                cause: `streaming disabled for chat ${message.chatId} after repeated flood-waits`,
                details: { platform: message.platform, chatId: message.chatId },
              });
            },
          })
        : undefined;

      // Static per-channel toolset narrowing (context-economy Phase 1).
      // Resolved from static config only — never computed per turn — so the
      // tool list stays byte-stable across turns on this lane (plan R1).
      const toolsetNarrow = this.channelToolsets?.[message.platform];

      const translator = createEventTranslator();
      for await (const event of bot.loop.run(loopText, {
        sessionKey,
        personalityId,
        abortSignal: signal,
        attachments: message.attachments,
        userId,
        steerSink,
        origin: `${message.platform}:${message.chatId}`,
        ...(toolsetNarrow ? { toolsetNarrow } : {}),
        // Unconditional, not config-driven: UI-card tools have no rendering on
        // any channel adapter, so they never reach a channel turn's tool list.
        toolsetExclude: [...CHANNEL_EXCLUDED_TOOLS],
      })) {
        translator.push(event);
        // Feed the live draft. Progress folds in only for `audience:'user'`
        // (W3.3) — the framework never opts a tool in. Fire-and-forget: the
        // streamer serializes internally and finalize() awaits it.
        if (streamer && !signal.aborted) {
          if (event.type === 'text_delta') {
            void streamer.pushText(translator.text);
          } else if (event.type === 'tool_progress' && shouldSurfaceProgress(event)) {
            void streamer.pushProgress(event.message);
          }
        }
        if (event.type === 'usage') {
          const u = this.usageStore.get(laneKey) ?? {
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
          };
          u.inputTokens += event.inputTokens;
          u.outputTokens += event.outputTokens;
          u.costUsd += event.estimatedCostUsd;
          this.usageStore.set(laneKey, u);
        }
        if (translator.error) {
          errored = translator.error;
          break;
        }
        if (translator.done) break;
      }
      responseText = translator.text;

      // Did the live streamer already deliver (at least a first chunk)? If so,
      // the final content lands as a draft edit (registered in dedup via
      // record()) instead of a fresh send — no duplicate message.
      const streamed = streamer?.hasDelivered ?? false;

      if (signal.aborted) {
        // /stop or shutdown — caller already notified the user. Any partial
        // draft is left as-is.
      } else if (errored) {
        const note =
          responseText.trim().length > 0
            ? `${responseText}\n\n⚠ Response interrupted: ${errored.error}`
            : `⚠ Error: ${errored.error}`;
        const sanitizedNote = stripAnsiEscapes(note);
        if (streamer && streamed) {
          // Fold the interruption into the existing draft rather than sending
          // a second message that duplicates the streamed text.
          await streamer.finalize(sanitizedNote);
        } else if (this.outboundDedup.shouldSend(sessionKey, sanitizedNote)) {
          await this.sendTracked(
            {
              adapter,
              botKey: bot.botKey,
              platform: message.platform,
              chatId: message.chatId,
              sessionKey,
            },
            { text: sanitizedNote, threadId },
          );
        }
      } else if (responseText) {
        const sanitized = stripAnsiEscapes(responseText);
        // Streaming path lands the final via editMessage; non-streaming path
        // gates a fresh send on dedup. `delivered` decides whether the voice
        // pipeline runs (it runs on either delivery route).
        let delivered = false;
        if (streamer && streamed) {
          await streamer.finalize(sanitized);
          delivered = true;
        } else if (this.outboundDedup.shouldSend(sessionKey, sanitized)) {
          // `delivered` is now the adapter's own verdict, not "we called
          // send()". An unconfirmed reply leaves a pending obligation AND
          // skips the voice pipeline — synthesising audio for a message the
          // user never received is pure waste.
          delivered = await this.sendTracked(
            {
              adapter,
              botKey: bot.botKey,
              platform: message.platform,
              chatId: message.chatId,
              sessionKey,
            },
            { text: sanitized, parseMode: 'markdown', threadId },
          );
        }

        if (delivered) {
          // --- Voice pipeline: post-turn TTS synthesis ---
          const voiceMode = this.voiceModes.get(laneKey) ?? this.defaultVoiceMode;
          const hadAudio = this.lastInboundHadAudio.get(laneKey) ?? false;
          const shouldSynth = shouldReplyWithVoice({
            mode: voiceMode,
            inboundHadAudio: hadAudio,
          });

          if (shouldSynth) {
            const tts = await this.resolveTtsProvider();
            if (tts) {
              try {
                let synthText = sanitizeForSpeech(sanitized);
                const maxChars = tts.caps.maxInputChars;
                if (maxChars && synthText.length > maxChars) {
                  synthText = truncateAtSentenceBoundary(synthText, maxChars);
                }
                if (synthText.length > 0) {
                  const result = await tts.synthesize(synthText);
                  if (result.format === 'opus' && 'sendVoice' in adapter) {
                    const voiceAdapter = adapter as {
                      sendVoice(
                        chatId: string,
                        audio: Uint8Array,
                        opts?: { threadId?: string },
                      ): Promise<unknown>;
                    };
                    await voiceAdapter.sendVoice(message.chatId, result.audio, {
                      threadId,
                    });
                  } else if ('sendAudio' in adapter) {
                    const audioAdapter = adapter as {
                      sendAudio(
                        chatId: string,
                        audio: Uint8Array,
                        filename: string,
                        opts?: { threadId?: string },
                      ): Promise<unknown>;
                    };
                    const ext =
                      result.format === 'mp3' ? 'mp3' : result.format === 'wav' ? 'wav' : 'audio';
                    await audioAdapter.sendAudio(message.chatId, result.audio, `reply.${ext}`, {
                      threadId,
                    });
                  }
                }
              } catch {
                // TTS synthesis failed — text already sent, degrade silently
              }
            }
          }
        }
      }

      if (!signal.aborted && !errored && responseText) {
        try {
          this.onTurnComplete?.({ platform: message.platform });
        } catch {
          // App-layer callback errors must never break the turn.
        }
      }
    } finally {
      clearInterval(typingTimer);
      this.activeTurns.delete(laneKey);
      this.activeSinks.delete(laneKey);

      turnActive = false;
      // Don't deregister — keep the adapter alive to buffer offline notifications
      this.sessionRouting.delete(sessionKey);
      const sessionId = this.sessionIdByKey.get(sessionKey);
      if (sessionId !== undefined) {
        this.approvalRoutes.delete(sessionId);
        this.sessionIdByKey.delete(sessionKey);
      }
      // The lane just went idle — deliver any background-completion notices that
      // were deferred because a turn was running.
      void this.flushWakes(laneKey);
    }
  }

  // ---------------------------------------------------------------------------
  // Background-completion wakes
  // ---------------------------------------------------------------------------

  /**
   * A durable background job finished. Queue a completion notice for its
   * originating lane and try to flush it. Deferred (not sent) while a turn is
   * in flight on that lane so the notice never interleaves with a streaming
   * response. Only `done` / `failed` wake — `aborted` is user-requested and
   * stays silent; `stale` / `expired` never reach `onComplete` (they come from
   * sweeps, whose cross-process delivery is a later phase). Never throws — a
   * completion callback that throws would crash the executor.
   */
  private onBackgroundJobComplete(bot: GatewayBotConfig, job: BackgroundJob): void {
    if (job.status !== 'done' && job.status !== 'failed') return;
    if (this.deliveredWakes.has(job.id)) return;
    const platform = job.originPlatform;
    const chatId = job.originChatId;
    if (!platform || !chatId) return; // no originating channel (e.g. CLI-owned)
    const threadId = job.originThreadId;
    const laneKey = threadId
      ? buildLaneKey(platform, bot.botKey, chatId, threadId)
      : buildLaneKey(platform, bot.botKey, chatId);
    const list = this.pendingWakes.get(laneKey) ?? [];
    list.push({ job, bot });
    this.pendingWakes.set(laneKey, list);
    void this.flushWakes(laneKey);
  }

  /**
   * Deliver every queued completion notice for `laneKey`, unless a turn is
   * running on that lane (then it's retried on turn-end and by the periodic
   * sweep). Dequeuing is synchronous, so a concurrent flush (turn-end vs sweep)
   * sees an empty queue; the per-job claim below is what makes exactly-once hold
   * across PROCESSES too. Best-effort adapter resolution: an unresolved platform
   * drops the item with an observability record rather than throwing.
   */
  private async flushWakes(laneKey: string): Promise<void> {
    if (this.activeSinks.has(laneKey)) return; // a turn is running — defer
    const list = this.pendingWakes.get(laneKey);
    if (!list || list.length === 0) {
      this.pendingWakes.delete(laneKey);
      return;
    }
    // Drain synchronously into a local batch so a re-entrant flush sees an empty
    // queue. Items are re-checked against deliveredWakes as a second guard.
    const batch = list.splice(0, list.length);
    if (list.length === 0) this.pendingWakes.delete(laneKey);
    for (const item of batch) {
      const { job, bot } = item;
      if (this.deliveredWakes.has(job.id)) continue;
      const platform = job.originPlatform;
      const chatId = job.originChatId;
      if (!platform || !chatId) continue;
      const adapter = this.adapterRegistry.get(platform);
      if (!adapter) {
        // No adapter for this platform in this process — drop, don't retry.
        this.markWakeDelivered(job.id);
        this.observability?.recordSafetyBlock({
          code: 'background.wake_undeliverable',
          details: { jobId: job.id, platform, chatId, botKey: bot.botKey },
        });
        continue;
      }
      // Mark BEFORE the first await: a second `onComplete` for this job that
      // arrives while the claim is in flight must not open a second delivery.
      // Marking a job whose claim we then LOSE is still correct — losing means
      // a peer process is announcing it, so this process is done with it either
      // way.
      this.markWakeDelivered(job.id);
      if (!(await this.claimWake(bot, job))) continue; // a peer process won it
      await this.deliverCompletion(bot, job, adapter, laneKey);
    }
  }

  /**
   * Win the right to announce this job's completion, exactly once.
   *
   * The `jobs.delivered_at` claim is the authority — it is atomic and it
   * survives a restart, which the in-memory `deliveredWakes` Set does not.
   * A store error deliberately fails OPEN (returns true): a completion the user
   * is waiting on must not be swallowed by an audit-column write, and the worst
   * case is one duplicate notice, which the outbound dedup cache usually eats.
   */
  private async claimWake(bot: GatewayBotConfig, job: BackgroundJob): Promise<boolean> {
    if (!bot.jobStore) return true; // no durable store wired — Set-only, as before
    try {
      return await bot.jobStore.claimDelivery(job.id);
    } catch (err) {
      this.observability?.recordSafetyBlock({
        code: 'background.delivery_claim_failed',
        cause: err instanceof Error ? err.message : String(err),
        details: { jobId: job.id, botKey: bot.botKey },
      });
      return true;
    }
  }

  /**
   * Remember an announced job in-process. Bounded: the durable claim is the real
   * exactly-once gate, so this Set only needs to cover the window between an
   * `onComplete` firing twice — it must never grow for the life of the process
   * (it used to, and was lost on restart, which is the worst of both).
   */
  private markWakeDelivered(jobId: string): void {
    this.deliveredWakes.add(jobId);
    while (this.deliveredWakes.size > DELIVERED_WAKES_MAX) {
      const oldest = this.deliveredWakes.values().next().value;
      if (oldest === undefined) break;
      this.deliveredWakes.delete(oldest);
    }
  }

  /**
   * Send one completion notice through the durable outbound path (item 9's
   * ledger), so a notice the platform never confirmed is redelivered by
   * `sweepPendingDeliveries()` rather than silently lost. Returns whether the
   * platform confirmed. A dedup hit counts as delivered — the identical text
   * already reached this lane.
   */
  private async deliverCompletion(
    bot: GatewayBotConfig,
    job: BackgroundJob,
    adapter: PlatformAdapter,
    laneKey: string,
  ): Promise<boolean> {
    const platform = job.originPlatform;
    const chatId = job.originChatId;
    if (!platform || !chatId) return false;
    const text = this.buildWakeNotice(job);
    if (!this.outboundDedup.shouldSend(laneKey, text)) return true;
    return this.sendTracked(
      {
        adapter,
        botKey: bot.botKey,
        platform,
        chatId,
        sessionKey: this.sessionKeys.get(laneKey) ?? laneKey,
      },
      { text, threadId: job.originThreadId },
    );
  }

  /**
   * Notice text for a finished background job: a plain, trusted envelope plus
   * the job's own summary/error wrapped as untrusted content (it may echo
   * whatever the child agent read). Mirrors the `channel_message` treatment.
   */
  private buildWakeNotice(job: BackgroundJob): string {
    const shortId = job.id.slice(0, 8);
    const labelPart = job.label ? `"${job.label}" ` : '';
    const envelope = `[background job ${shortId} ${labelPart}finished — status: ${job.status}]`;
    const body =
      job.status === 'done' ? (job.summary ?? '(no summary)') : (job.error ?? 'unknown error');
    const wrapped = wrapUntrusted({ content: body, toolName: 'background_job_summary' });
    const tier1 = shortPatternCheck(body);
    if (tier1.containsInstructions || wrapped.strippedTokens > 0) {
      this.observability?.recordInjectionFlag?.({
        code: 'background.injection_detected',
        cause: tier1.containsInstructions
          ? (tier1.hits[0]?.rule ?? 'pattern-hit')
          : `stripped ${wrapped.strippedTokens} template token${wrapped.strippedTokens === 1 ? '' : 's'}`,
        details: {
          jobId: job.id,
          ...(job.originPlatform ? { platform: job.originPlatform } : {}),
          ...(job.originChatId ? { chatId: job.originChatId } : {}),
          ...(tier1.containsInstructions ? { hits: tier1.hits } : {}),
        },
      });
    }
    return `${envelope}\n\n${wrapped.content}`;
  }

  /**
   * Resolve a `sessionId` to the adapter/chat/thread its turn originated
   * from — the bridge a `before_tool_call` approval hook needs to surface an
   * approval prompt on the right platform conversation. Returns `undefined`
   * once the turn ends (or if the sessionId was never seen). Platform-
   * agnostic by design: the gateway returns a generic `PlatformAdapter` and
   * never learns which concrete platform is in play.
   */
  resolveApprovalRoute(sessionId: string): SessionRouting | undefined {
    return this.approvalRoutes.get(sessionId);
  }

  /**
   * Stop all active session lanes gracefully. If `notify` is set, send that
   * text to every chat with an in-flight turn before aborting — so users
   * never see silent failure on shutdown / upgrade. See IMPROVEMENT.md P1-1
   * and OpenClaw #71178 (mid-turn update drops every Telegram message).
   */
  async shutdown(opts: { notify?: string } = {}): Promise<void> {
    if (opts.notify) {
      const sends: Promise<unknown>[] = [];
      for (const ctx of this.activeTurns.values()) {
        sends.push(ctx.adapter.send(ctx.chatId, { text: opts.notify }).catch(() => {}));
      }
      await Promise.allSettled(sends);
    }
    if (this.clarifySweepTimer) {
      clearInterval(this.clarifySweepTimer);
      this.clarifySweepTimer = undefined;
    }
    if (this.bgWakeSweepTimer) {
      clearInterval(this.bgWakeSweepTimer);
      this.bgWakeSweepTimer = undefined;
    }
    for (const unsub of this.bgWakeUnsubs) unsub();
    this.bgWakeUnsubs.length = 0;
    this.pendingWakes.clear();
    for (const lane of this.lanes.values()) {
      lane.abort();
    }
    this.lanes.clear();
    this.sessionKeys.clear();
    this.activeTurns.clear();
    this.activeSinks.clear();
    this.sessionRouting.clear();
    this.approvalRoutes.clear();
    this.sessionIdByKey.clear();
  }

  /** Call after all plugins are loaded to register plugin slash commands with platform adapters. */
  async pluginsReady(): Promise<void> {
    const cmds =
      this.pluginLoader
        ?.getAllSlashCommands()
        .map((c) => ({ name: c.name, description: c.description })) ?? [];
    if (cmds.length === 0) return;
    for (const adapter of this.adapterRegistry.values()) {
      await adapter.registerCommands?.(cmds).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Durable delivery obligations (item 9)
  // ---------------------------------------------------------------------------

  /** The ledger binding for one bot, or `undefined` when no ledger is wired. */
  private deliveryBinding(botKey: string, platform: string): DeliveryBinding | undefined {
    const ledger = this.deliveryLedger;
    if (!ledger) return undefined;
    return {
      ledger,
      botKey,
      platform,
      onLedgerError: (stage, error) => {
        this.observability?.recordSafetyBlock({
          code: 'gateway.delivery_ledger_error',
          cause: `delivery ledger ${stage} failed`,
          details: { stage, botKey, platform, error },
        });
      },
    };
  }

  /**
   * Send a reply with a durable obligation wrapped around it.
   *
   * `DeliveryResult.ok === true` is the ONLY definition of confirmed. Every
   * shipped adapter catches platform failures and returns `{ ok: false }`
   * rather than throwing, so "the promise resolved" would mark exactly the
   * failures this ledger exists to catch as delivered. A rejected promise is
   * folded into the same `{ ok: false }` shape so a throwing adapter still
   * leaves the obligation `pending` — and, as before, never breaks the turn.
   *
   * Returns whether the platform confirmed.
   */
  private async sendTracked(
    target: {
      adapter: PlatformAdapter;
      botKey: string;
      platform: string;
      chatId: string;
      sessionKey: string;
    },
    message: OutboundMessage,
  ): Promise<boolean> {
    const binding = this.deliveryBinding(target.botKey, target.platform);
    const obligationId = await beginDelivery(binding, {
      chatId: target.chatId,
      sessionId: target.sessionKey,
      // Every caller already puts the thread on the OutboundMessage, so the
      // ledger reads it from the same place the platform call does — there is
      // no second source that could drift.
      threadId: message.threadId,
      content: message.text,
    });
    const result = await target.adapter.send(target.chatId, message).catch(
      (err: unknown): DeliveryResult => ({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    if (result?.ok === true) {
      await confirmDelivery(binding, obligationId);
      return true;
    }
    // Leave the row `pending` — the next boot sweep redelivers it. Surface the
    // failure too: before this, a failed send was completely invisible.
    this.observability?.recordSafetyBlock({
      code: 'gateway.delivery_unconfirmed',
      cause: 'adapter did not confirm delivery',
      details: {
        platform: target.platform,
        botKey: target.botKey,
        chatId: target.chatId,
        error: result?.error,
        durable: obligationId !== null,
      },
    });
    return false;
  }

  /**
   * Redeliver every `pending` obligation this process OWNS.
   *
   * Ownership is `botKey ∈ this.bots` — a deployment sharing a ledger file
   * never touches another deployment's rows. Two processes that DO share a
   * botKey are separated by the ledger's atomic claim, so each obligation is
   * redelivered exactly once. Note the corollary: age alone never authorizes
   * a redelivery, because an old `pending` row may belong to a live peer that
   * is mid-send. The claim is what makes the sweep safe, not a threshold.
   *
   * Redelivery calls `adapter.send()` DIRECTLY, bypassing `shouldSend()` — a
   * warm dedup cache must not swallow a message the user never received — then
   * calls `record()` so a *subsequent* duplicate is still suppressed. That is
   * exactly what `record()` exists for; no new dedup API is needed.
   *
   * Must run AFTER `adapter.start()`: a sweep against a cold adapter is a
   * silent no-op that also burns the obligation.
   */
  async sweepPendingDeliveries(): Promise<{ redelivered: number; failed: number }> {
    const ledger = this.deliveryLedger;
    if (!ledger) return { redelivered: 0, failed: 0 };

    let pending: Awaited<ReturnType<DeliveryLedger['listPending']>>;
    try {
      pending = await ledger.listPending([...this.bots.keys()]);
    } catch (err) {
      this.observability?.recordSafetyBlock({
        code: 'gateway.delivery_sweep_failed',
        cause: err instanceof Error ? err.message : String(err),
      });
      return { redelivered: 0, failed: 0 };
    }

    let redelivered = 0;
    let failed = 0;
    for (const row of pending) {
      let claimed = false;
      try {
        claimed = await ledger.claim(row.id);
        if (!claimed) continue; // a peer process won the claim
        const adapter = this.adapterRegistry.get(row.platform);
        if (!adapter) {
          // This process owns the bot but not an adapter for its platform.
          // Hand the row back rather than burning it.
          await ledger.release(row.id);
          failed++;
          continue;
        }
        // The row carries its thread, so a redelivered reply returns to the
        // sub-conversation it belonged to instead of the root chat. `threadId`
        // is `undefined` for an unthreaded row — never '' or the string 'null',
        // which some adapters would forward to the platform verbatim.
        const result = await adapter
          .send(row.chatId, { text: row.content, threadId: row.threadId })
          .catch(
            (err: unknown): DeliveryResult => ({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        if (result?.ok === true) {
          await ledger.markDelivered(row.id);
          this.outboundDedup.record(row.sessionId, row.content);
          redelivered++;
          this.observability?.recordSafetyBlock({
            code: 'gateway.delivery_redelivered',
            details: {
              platform: row.platform,
              botKey: row.botKey,
              chatId: row.chatId,
              contentHash: row.contentHash,
              createdAt: row.createdAt,
            },
          });
        } else {
          await ledger.release(row.id);
          failed++;
        }
      } catch (err) {
        if (claimed) await ledger.release(row.id).catch(() => {});
        failed++;
        this.observability?.recordSafetyBlock({
          code: 'gateway.delivery_redelivery_failed',
          cause: err instanceof Error ? err.message : String(err),
          details: { platform: row.platform, botKey: row.botKey },
        });
      }
    }
    return { redelivered, failed };
  }

  // ---------------------------------------------------------------------------
  // Restart-durable background completions (item 10)
  // ---------------------------------------------------------------------------

  /**
   * Announce every background job that finished while nobody was listening.
   *
   * The gap item 9's ledger structurally cannot close: a process that died
   * before announcing a completion never called `record()`, so no pending
   * obligation exists and the ledger has nothing to redeliver. The job row's
   * own `delivered_at` is the missing bit of state — NULL on a terminal row
   * means "finished, never announced", which is precisely this sweep's input.
   *
   * Ownership matches the ledger's rule (`botKey ∈ this.bots`): the query is
   * scoped per bot, so a deployment sharing a `jobs.db` never announces another
   * deployment's completions. The claim is atomic, so two processes booting at
   * once announce each completion exactly once. Delivery itself goes through
   * `sendTracked`, which is how a restored completion inherits the ledger's
   * durability and thread-correct redelivery.
   *
   * Must run AFTER `adapter.start()`, for the same reason the ledger sweep must.
   */
  async sweepUndeliveredJobs(): Promise<{ delivered: number; failed: number }> {
    let delivered = 0;
    let failed = 0;
    for (const bot of this.bots.values()) {
      const store = bot.jobStore;
      if (!store) continue;
      let rows: BackgroundJob[];
      try {
        rows = await store.listUndelivered([bot.botKey]);
      } catch (err) {
        this.observability?.recordSafetyBlock({
          code: 'background.restore_sweep_failed',
          cause: err instanceof Error ? err.message : String(err),
          details: { botKey: bot.botKey },
        });
        continue;
      }
      for (const job of rows) {
        const platform = job.originPlatform;
        const chatId = job.originChatId;
        if (!platform || !chatId) continue;
        const adapter = this.adapterRegistry.get(platform);
        if (!adapter) {
          // This process owns the bot but not an adapter for its platform. Hand
          // the row back untouched rather than burning its one claim.
          failed++;
          continue;
        }
        const laneKey = job.originThreadId
          ? buildLaneKey(platform, bot.botKey, chatId, job.originThreadId)
          : buildLaneKey(platform, bot.botKey, chatId);
        try {
          if (!(await store.claimDelivery(job.id))) continue; // a peer won it
          this.markWakeDelivered(job.id);
          const ok = await this.deliverCompletion(bot, job, adapter, laneKey);
          if (ok) {
            delivered++;
            continue;
          }
          failed++;
          // With a ledger wired, `sendTracked` left a `pending` obligation and
          // the ledger sweep owns the retry — keep the claim so the completion
          // is not announced twice. Without one there is no retry anywhere, so
          // release the claim and let the next boot try again.
          if (!this.deliveryLedger) await store.releaseDelivery(job.id);
        } catch (err) {
          failed++;
          this.observability?.recordSafetyBlock({
            code: 'background.restore_delivery_failed',
            cause: err instanceof Error ? err.message : String(err),
            details: { jobId: job.id, botKey: bot.botKey, platform },
          });
        }
      }
    }
    return { delivered, failed };
  }

  /**
   * The thread a live turn on `sessionKey` originated in. The gateway is the one
   * component that knows this mapping (`ToolContext` carries no thread), so it
   * is exposed for wiring to hand to the background tools — a `delegate_task`
   * job stamps it as `origin_thread_id` and its completion returns to the
   * sub-conversation that asked for it. `undefined` once the turn ends.
   */
  originThreadIdFor(sessionKey: string): string | undefined {
    return this.sessionRouting.get(sessionKey)?.threadId;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Whether `/personality` switching is permitted for this lane's bot.
   *  Team bots always reject (coordinator is structural). Personality
   *  bots reject unless `binding.allowSlashSwitch` is on. */
  private personalitySwitchAllowed(bot: GatewayBotConfig): boolean {
    if (bot.binding.type === 'team') return false;
    return bot.binding.allowSlashSwitch === true;
  }

  /** The personality identifier surfaced by `/personality` (no arg) and
   *  `/help` for a given lane. Honors the per-lane override only when
   *  the bot permits slash-switching. */
  private activePersonalityFor(laneKey: string, bot: GatewayBotConfig): string {
    if (this.personalitySwitchAllowed(bot)) {
      const override = this.personalityIds.get(laneKey);
      if (override) return override;
    }
    return bot.binding.name;
  }

  // ---------------------------------------------------------------------------
  // Public API — agent-initiated outbound sends (send_message tool)
  // ---------------------------------------------------------------------------

  async sendTo(
    platform: string,
    target: string,
    body: string,
    media?: unknown,
  ): Promise<{ ok: boolean; error?: string }> {
    const adapter = this.adapterRegistry.get(platform);
    if (!adapter) {
      return { ok: false, error: `No adapter registered for platform "${platform}"` };
    }
    try {
      // Route through outbound dedup — same path as normal responses.
      // Use target as the session key for dedup so repeated sends to the
      // same target with same content are suppressed within TTL.
      const dedupKey = `outbound:${platform}:${target}`;
      if (!this.outboundDedup.shouldSend(dedupKey, body)) {
        return { ok: true }; // silently deduplicated
      }
      // W3.2 — outbound media convention. Map a recognized `structured`
      // payload to native attachments when the adapter's caps allow;
      // otherwise degrade to the text body (nothing attached).
      const attachments =
        media !== undefined
          ? attachmentsFromStructured(
              media,
              this.outboundMediaCaps(adapter),
              OUTBOUND_MEDIA_MAX_BYTES,
              (rejectedPath) =>
                this.observability?.recordSafetyBlock({
                  code: 'gateway.media_path_rejected',
                  cause: 'rejected unsafe path-based media source (traversal or symlink)',
                  details: { platform, path: rejectedPath },
                }),
            )
          : [];
      const result = await adapter.send(target, {
        text: body,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      if (!result.ok) {
        return { ok: false, error: result.error ?? 'Adapter send failed' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Outbound media capabilities for an adapter (W3.2). Prefers the v2
   * `ChannelCapabilities.media` manifest when present; otherwise falls back to
   * the legacy `canSendFiles` boolean, which gates both images and files.
   */
  private outboundMediaCaps(adapter: PlatformAdapter): OutboundMediaCaps {
    const media = adapter.caps?.media;
    if (media) return { imagesOut: media.imagesOut, filesOut: media.filesOut };
    return { imagesOut: adapter.canSendFiles, filesOut: adapter.canSendFiles };
  }

  private getOrCreateLane(key: string): SessionLane {
    const existing = this.lanes.get(key);
    if (existing) {
      // LRU touch: re-insert to push to the tail so eviction skips it.
      this.lanes.delete(key);
      this.lanes.set(key, existing);
      return existing;
    }
    const lane = new SessionLane();
    this.lanes.set(key, lane);
    this.evictIdleChats();
    return lane;
  }

  /**
   * Bound per-chat state at `maxChats`. Walks `lanes` in LRU order (oldest
   * first) and evicts the first idle chat — one whose lane queue is empty
   * and that has no in-flight turn. Active chats are skipped, so a flood of
   * new chats can't drop a user mid-response.
   */
  private evictIdleChats(): void {
    while (this.lanes.size > this.maxChats) {
      let evictedKey: string | null = null;
      for (const [key, lane] of this.lanes) {
        if (lane.length === 0 && !this.activeTurns.has(key)) {
          evictedKey = key;
          break;
        }
      }
      if (evictedKey === null) return; // every chat is busy — leave the cap alone
      const evictedSession = this.sessionKeys.get(evictedKey) ?? evictedKey;
      void this.attachmentCache?.clear(evictedSession).catch(() => {});
      this.lanes.delete(evictedKey);
      this.sessionKeys.delete(evictedKey);
      this.personalityIds.delete(evictedKey);
      this.usageStore.delete(evictedKey);
      this.voiceModes.delete(evictedKey);
      this.lastInboundHadAudio.delete(evictedKey);
    }
  }
}

function createSteerSink(cap = 32): SteerSink {
  const queue: string[] = [];
  return {
    push(text: string): boolean {
      if (queue.length >= cap) return false;
      queue.push(text);
      return true;
    },
    drain(): string[] {
      if (queue.length === 0) return [];
      const out = queue.splice(0);
      return out;
    },
    depth(): number {
      return queue.length;
    },
  };
}
