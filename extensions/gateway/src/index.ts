import { randomUUID } from 'node:crypto';
import type { AgentLoop } from '@ethosagent/core';
import {
  buildLaneKey,
  type ClarifyNoticeTarget,
  DEFAULT_ESCALATION_DELAY_MS,
  deriveBotKey,
  LaneVoiceModeStore,
  resolveSttProviderForPersonality,
  resolveTtsProviderForPersonality,
  resolveVoicePreferences,
  sweepClarifyEscalations as runClarifyEscalationSweep,
  type SttProviderForPersonality,
  selectSttEntry,
  selectTtsEntry,
  stripAnsiEscapes,
  type TtsProviderForPersonality,
} from '@ethosagent/core';
import type { DeliveryLedger, DeliveryObligation } from '@ethosagent/delivery-ledger';
import type { InboundDedupStore } from '@ethosagent/inbound-dedup';
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
  ClarifySurfaceType,
  DeliveryResult,
  InboundMessage,
  Logger,
  OutboundMessage,
  PersonalityVoiceConfig,
  PlatformAdapter,
  PlatformAdapterFactory,
  SteerSink,
  Storage,
  SttProvider,
  SttProviderEntry,
  SttProviderRegistry,
  TtsProvider,
  TtsProviderEntry,
  TtsProviderRegistry,
  VoiceAudioFormat,
  VoiceTurnOrigin,
} from '@ethosagent/types';
import { isVoiceOutboundAdapter, voiceAudioExtension, voiceAudioMimeType } from '@ethosagent/types';
import {
  DEFAULT_VOICE_MODE,
  detectLanguage,
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
import type { TranscodeResult, Transcoder } from './transcode';
import type { VoiceArtifactStore } from './voice-artifacts';
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
export {
  createFfmpegTranscoder,
  type FfmpegTranscoderOptions,
  type TranscodeRequest,
  type TranscodeResult,
  type Transcoder,
  type TranscodeStageEvent,
} from './transcode';
export {
  createVoiceArtifactStore,
  type VoiceArtifactStore,
  type VoiceArtifactStoreOptions,
} from './voice-artifacts';
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
 * Memo key for "the default voice entry" — `auxiliary.asr` / `auxiliary.tts`,
 * which have no roster name of their own. The leading space keeps it out of the
 * space of names an operator can type as a roster key.
 */
const DEFAULT_VOICE_ENTRY_KEY = ' default';

/**
 * Fix 5 (pi-delegation.md D7) — every channel platform with a live clarify
 * surface (see the `extensions/platform-` packages' `clarify-surface.ts`).
 * `InboundMessage.platform` is a plain string; other origins (email, mcp,
 * webhook, cron) carry values with no clarify surface at all. Mirrors the
 * same set in `packages/wiring/src/build-agent-loop.ts`
 * (`CLARIFY_SURFACE_TYPES`) — duplicated locally rather than shared because
 * `extensions/gateway` must not depend on `packages/wiring`
 * (ARCHITECTURE.md §II layer direction).
 */
const CLARIFY_SURFACE_TYPES = new Set<ClarifySurfaceType>([
  'tui',
  'cli',
  'web',
  'telegram',
  'slack',
  'discord',
  'whatsapp',
]);

function isClarifySurfaceType(platform: string): platform is ClarifySurfaceType {
  return CLARIFY_SURFACE_TYPES.has(platform as ClarifySurfaceType);
}

/**
 * Tools that render typed UI cards on the web surface. Channel adapters get
 * prose instead — by design, not by omission — so they are excluded from every
 * channel turn's tool definitions. The tools' own `ctx.platform` check is a
 * backstop, not the gate.
 */
export const CHANNEL_EXCLUDED_TOOLS: readonly string[] = ['emit_card', 'render_ui'];

/**
 * §4.6 rung 3 — how often the escalation sweep looks for a question that has
 * been unanswered past `clarifyEscalationDelayMs`. Deliberately much shorter
 * than the rung itself: the poll period is the sweep's error bar, so a 60 s
 * rung polled every 5 s fires between 60 s and 65 s.
 */
const CLARIFY_ESCALATION_POLL_MS = 5_000;

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
   * Durable backstop for the in-memory inbound dedup `Set`
   * (plan/phases/telegram-slack-webhook-mode.md §5). Consulted only when the
   * `Set` misses, so a continuously-running process pays nothing for it.
   *
   * Absent → today's behavior: in-memory only, which a process restart
   * empties. That is the gap webhook mode + scale-to-zero turns from a rare
   * crash-time risk into a routine one.
   */
  inboundDedup?: InboundDedupStore;
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
   * §4.6 rung 3 — how long a PRESENTED background-job question may go
   * unanswered before a "needs you" notice is pushed to the run's origin lane.
   * Defaults to 60s per the escalation ladder. Set to 0 to disable the push
   * entirely (the question still lives its normal life; only the nudge stops).
   */
  clarifyEscalationDelayMs?: number;
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
    /**
     * The personality's `voice` block, when it declares one. Optional so the
     * seam stays backwards-compatible; absent → channel TTS falls back to the
     * global `auxiliary.tts.voice`, which is what every deployment did before
     * per-personality voice existed. Read AFTER `refresh()`, so an edited
     * `voice.tts_voice` takes effect on the next spoken reply without a
     * restart, exactly like the rest of the directory.
     */
    voice?(id: string): PersonalityVoiceConfig | undefined;
  };
  /**
   * Optional attachment cache for cleaning up cached files on session reset
   * (`/new`) and lane eviction. When absent, no cleanup is performed.
   */
  attachmentCache?: AttachmentCache;
  /**
   * Storage used to read cached attachment bytes — today only for transcribing
   * inbound voice notes, which need the audio itself and not just its path.
   * Absent (with `attachmentCache` present) means audio attachments still land
   * as `(voice message)`; they are simply not transcribed.
   */
  storage?: Storage;
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
  /**
   * `voice.stt.providers.*` / `voice.tts.providers.*` — the NAMED rosters a
   * personality's `voice.stt_provider` / `voice.tts_provider` picks from.
   *
   * Absent → every personality gets the single `sttProviderName` /
   * `ttsProviderName` default, which is what every deployment did before
   * per-personality providers reached channel replies. The roster KEY is a
   * label the operator typed and is never what the egress gate keys on: the
   * shared resolver gates on the selected entry's `provider` and the
   * constructed provider's `caps.local`, so naming a cloud entry
   * `local-anything` cannot walk it past a local-only gate.
   */
  sttProviderRoster?: Readonly<Record<string, SttProviderEntry>>;
  ttsProviderRoster?: Readonly<Record<string, TtsProviderEntry>>;
  /** Secrets resolver for voice provider factories. */
  voiceSecretsResolver?: import('@ethosagent/types').SecretsResolver;
  /** Default voice mode: 'off' | 'mirror_inbound' | 'all'. Default 'mirror_inbound'. */
  defaultVoiceMode?: VoiceMode;
  /**
   * Persisted per-lane voice mode. Absent → an in-memory store seeded with
   * `defaultVoiceMode`, which is exactly the behaviour of the Map this
   * replaced: modes live for the life of the process and no further.
   */
  voiceModeStore?: LaneVoiceModeStore;
  /**
   * Synthesized-audio store. Absent → artifacts are not persisted and a failed
   * voice send cannot be redelivered (the obligation still records, so the loss
   * is visible rather than silent).
   */
  voiceArtifacts?: VoiceArtifactStore;
  /**
   * ffmpeg stage. Absent → no transcode: a synthesized format the adapter does
   * not accept is SKIPPED rather than sent wrong. Sending mp3 bytes to a sink
   * that declared opus is how audio arrives as an undownloadable document.
   */
  transcoder?: Transcoder;
  /**
   * `voice.channels.<platform>.ttsOut`. An explicit `false` silences that
   * platform regardless of lane mode — an operator decision outranks a
   * conversational one. A platform absent here inherits the lane's mode.
   */
  channelVoiceOut?: Readonly<Record<string, boolean>>;
  /** Transcode bitrate (`voice.transcode.bitrateKbps`). */
  voiceBitrateKbps?: number;
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
  /** Durable dedup backstop. Absent → in-memory only. */
  private readonly inboundDedup: InboundDedupStore | undefined;
  /** Outbound-message dedup cache. Suppresses `(sessionId, content)` within TTL. */
  private readonly outboundDedup: MessageDedupCache;
  /** Durable delivery-obligation ledger (item 9). Absent → no durability. */
  private readonly deliveryLedger: DeliveryLedger | undefined;
  /** Accumulated host-pause duration discounted from the stale-obligation
   *  abandon window. See `applyPauseOffset`. */
  private pauseOffsetMs = 0;
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
  /** §4.6 rung 3 — timer running the unanswered-question escalation sweep. */
  private clarifyEscalationTimer: ReturnType<typeof setInterval> | undefined;
  private readonly clarifyEscalationDelayMs: number;
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
  /** Optional storage for reading cached attachment bytes (voice-note STT). */
  private readonly storage: Storage | undefined;
  /** STT provider registry for resolving voice transcription providers by name. */
  private readonly sttProviderRegistry: SttProviderRegistry | undefined;
  /** Name of the STT provider to use (from auxiliary.asr.provider in config). */
  private readonly sttProviderName: string | undefined;
  /**
   * Resolved STT providers, ONE PER ROSTER ENTRY — not one per gateway.
   *
   * A single memoized provider is what made `voice.stt_provider` a
   * browser-talk-mode-only setting: whichever personality spoke first bound the
   * whole process. The key is the selected roster entry (or the default
   * entry), so two personalities naming the same entry still share one
   * constructed provider, and the promise is memoized rather than the settled
   * value so two concurrent turns cannot race into two factory calls.
   */
  private readonly sttProviders = new Map<string, Promise<SttProviderForPersonality>>();
  /** TTS provider registry for resolving voice synthesis providers by name. */
  private readonly ttsProviderRegistry: TtsProviderRegistry | undefined;
  /** Name of the TTS provider to use (from auxiliary.tts.provider in config). */
  private readonly ttsProviderName: string | undefined;
  /** Resolved TTS providers, one per roster entry. See {@link sttProviders}. */
  private readonly ttsProviders = new Map<string, Promise<TtsProviderForPersonality>>();
  /** Config dict passed to STT provider factory. */
  private readonly sttProviderConfig: Record<string, unknown>;
  /** Config dict passed to TTS provider factory. */
  private readonly ttsProviderConfig: Record<string, unknown>;
  /** `voice.stt.providers.*` — the named roster a personality can pick from. */
  private readonly sttProviderRoster: Readonly<Record<string, SttProviderEntry>> | undefined;
  /** `voice.tts.providers.*` — the named roster a personality can pick from. */
  private readonly ttsProviderRoster: Readonly<Record<string, TtsProviderEntry>> | undefined;
  /** Secrets resolver for voice provider factories. */
  private readonly voiceSecretsResolver: import('@ethosagent/types').SecretsResolver | undefined;
  /**
   * Per-lane voice mode, and the only place the default now lives — the store
   * owns it, so there is no second copy on the Gateway to drift from it.
   * Durable when a storage-backed store was injected.
   */
  private readonly voiceModeStore: LaneVoiceModeStore;
  /** Synthesized-audio store backing voice redelivery. Absent → no artifacts. */
  private readonly voiceArtifacts: VoiceArtifactStore | undefined;
  /** ffmpeg stage. Absent → only already-accepted formats are sent. */
  private readonly transcoder: Transcoder | undefined;
  /** Per-platform TTS-out overrides from `voice.channels.<platform>.ttsOut`. */
  private readonly channelVoiceOut: Readonly<Record<string, boolean>> | undefined;
  /** Transcode bitrate in kbps; undefined leaves the transcoder's own default. */
  private readonly voiceBitrateKbps: number | undefined;
  /** Tracks whether the most recent inbound message per lane had audio. */
  private readonly lastInboundHadAudio = new Map<string, boolean>();
  /** Adapter lookup for agent-initiated outbound sends (send_message tool). */
  private readonly adapterRegistry: Map<string, PlatformAdapter>;
  private readonly resolveUserIdFn:
    | ((platform: string, platformUserId: string, displayLabel?: string) => Promise<string>)
    | undefined;
  private readonly trustedVoicePlugins: ReadonlySet<string> | undefined;
  // NO `resolvedSttProviderId` / `resolvedTtsProviderId` fields. They used to
  // hold "the" provider id, which was honest only while one provider served the
  // whole process. With per-personality resolution a remembered id is a
  // last-writer-wins global, and a turn stamping it into its own telemetry
  // would name whichever personality spoke most recently. Each resolution now
  // returns its id and the caller stamps THAT.
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
    this.inboundDedup = config.inboundDedup;
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
    this.clarifyEscalationDelayMs = config.clarifyEscalationDelayMs ?? DEFAULT_ESCALATION_DELAY_MS;
    this.personalityCardReader = config.personalityCardReader;
    this.greetingProvider = config.greetingProvider;
    this.personalityDirectory = config.personalityDirectory;
    this.attachmentCache = config.attachmentCache;
    this.storage = config.storage;
    this.sttProviderRegistry = config.sttProviderRegistry;
    this.sttProviderName = config.sttProviderName;
    this.ttsProviderRegistry = config.ttsProviderRegistry;
    this.ttsProviderName = config.ttsProviderName;
    this.sttProviderConfig = config.sttProviderConfig ?? {};
    this.ttsProviderConfig = config.ttsProviderConfig ?? {};
    this.sttProviderRoster = config.sttProviderRoster;
    this.ttsProviderRoster = config.ttsProviderRoster;
    this.voiceSecretsResolver = config.voiceSecretsResolver;
    // No store injected → an in-memory one. `LaneVoiceModeStore` with no
    // `storage` is exactly the Map this replaced, so a standalone/test gateway
    // behaves as it always did while a wired one persists across restarts. An
    // injected store carries its OWN default (the wiring builds it from
    // `voice.defaultMode`), so `config.defaultVoiceMode` seeds only the
    // fallback — one default, in one place, either way.
    this.voiceModeStore =
      config.voiceModeStore ??
      new LaneVoiceModeStore({ defaultMode: config.defaultVoiceMode ?? DEFAULT_VOICE_MODE });
    this.voiceArtifacts = config.voiceArtifacts;
    this.transcoder = config.transcoder;
    this.channelVoiceOut = config.channelVoiceOut;
    this.voiceBitrateKbps = config.voiceBitrateKbps;
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

    // §4.6 rung 3 — its own timer, not the 30s clarify sweep's: a 60s rung
    // polled every 30s fires anywhere between 60s and 90s, and the ladder's
    // whole claim is that the push lands when the silence has actually lasted
    // a minute. Its own cadence keeps the fire window at 60–65s.
    if (this.clarifyEscalationDelayMs > 0 && bridges.length > 0) {
      this.clarifyEscalationTimer = setInterval(() => {
        void this.sweepClarifyEscalations().catch(() => {});
      }, CLARIFY_ESCALATION_POLL_MS);
      this.clarifyEscalationTimer.unref?.();
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
  // VoiceSession stack use. Nothing here re-implements provider lookup, roster
  // selection or the local-only egress gate; a second implementation is exactly
  // how "config says one provider, the pipeline used another" happens, and the
  // gate lives INSIDE that shared resolver so there is one door, not two.
  //
  // Resolution is per-PERSONALITY. The memo key is the selected roster entry,
  // computed by the pure `select*Entry` BEFORE the async factory call — so an
  // unknown roster name collapses onto the default entry's cached provider,
  // which is where the shared resolver would send it anyway. The returned
  // `providerId` is what the caller stamps into its telemetry, so "which
  // provider served this reply" stays answerable per turn rather than per boot.
  private resolveSttFor(
    personalityVoice: PersonalityVoiceConfig | undefined,
  ): Promise<SttProviderForPersonality> {
    const key =
      selectSttEntry({
        ...(personalityVoice?.stt_provider ? { requestedName: personalityVoice.stt_provider } : {}),
        ...(this.sttProviderRoster ? { roster: this.sttProviderRoster } : {}),
      }).entryName ?? DEFAULT_VOICE_ENTRY_KEY;
    const cached = this.sttProviders.get(key);
    if (cached) return cached;
    const pending = resolveSttProviderForPersonality({
      registry: this.sttProviderRegistry,
      ...(personalityVoice ? { personality: personalityVoice } : {}),
      ...(this.sttProviderRoster ? { roster: this.sttProviderRoster } : {}),
      ...(this.sttProviderName ? { defaultProviderName: this.sttProviderName } : {}),
      defaultProviderConfig: this.sttProviderConfig,
      ...(this.voiceSecretsResolver ? { secrets: this.voiceSecretsResolver } : {}),
      logger: noopLogger,
      ...(this.trustedVoicePlugins ? { trustedVoicePlugins: this.trustedVoicePlugins } : {}),
    });
    this.sttProviders.set(key, pending);
    return pending;
  }

  private resolveTtsFor(
    personalityVoice: PersonalityVoiceConfig | undefined,
  ): Promise<TtsProviderForPersonality> {
    const key =
      selectTtsEntry({
        ...(personalityVoice?.tts_provider ? { requestedName: personalityVoice.tts_provider } : {}),
        ...(this.ttsProviderRoster ? { roster: this.ttsProviderRoster } : {}),
      }).entryName ?? DEFAULT_VOICE_ENTRY_KEY;
    const cached = this.ttsProviders.get(key);
    if (cached) return cached;
    const pending = resolveTtsProviderForPersonality({
      registry: this.ttsProviderRegistry,
      ...(personalityVoice ? { personality: personalityVoice } : {}),
      ...(this.ttsProviderRoster ? { roster: this.ttsProviderRoster } : {}),
      ...(this.ttsProviderName ? { defaultProviderName: this.ttsProviderName } : {}),
      defaultProviderConfig: this.ttsProviderConfig,
      ...(this.voiceSecretsResolver ? { secrets: this.voiceSecretsResolver } : {}),
      logger: noopLogger,
      ...(this.trustedVoicePlugins ? { trustedVoicePlugins: this.trustedVoicePlugins } : {}),
    });
    this.ttsProviders.set(key, pending);
    return pending;
  }

  /**
   * The STT provider serving one personality's inbound audio, or null when none
   * resolved. Records the failure reason (unless "not configured", which is not
   * a failure) so a refused provider is reportable rather than looking like
   * "voice just doesn't work here".
   */
  private async resolveSttProvider(personalityId?: string): Promise<{
    provider: SttProvider | null;
    providerId: string | undefined;
  }> {
    const { resolution } = await this.resolveSttFor(this.personalityVoice(personalityId));
    if (resolution.ok) {
      return { provider: resolution.provider, providerId: resolution.providerId };
    }
    if (resolution.code !== 'not_configured') this.voiceProviderErrors.stt = resolution.error;
    return { provider: null, providerId: undefined };
  }

  /** The TTS provider serving one personality's replies. Mirrors the STT half. */
  private async resolveTtsProvider(personalityId?: string): Promise<{
    provider: TtsProvider | null;
    providerId: string | undefined;
    /** The chosen entry's own voice id — the lowest rung of voice precedence. */
    entryVoice: string | undefined;
  }> {
    const { resolution, globalTtsVoice } = await this.resolveTtsFor(
      this.personalityVoice(personalityId),
    );
    if (resolution.ok) {
      return {
        provider: resolution.provider,
        providerId: resolution.providerId,
        entryVoice: globalTtsVoice,
      };
    }
    if (resolution.code !== 'not_configured') this.voiceProviderErrors.tts = resolution.error;
    return { provider: null, providerId: undefined, entryVoice: undefined };
  }

  /** This personality's `voice` block, when the directory seam exposes one. */
  private personalityVoice(personalityId?: string): PersonalityVoiceConfig | undefined {
    return personalityId ? this.personalityDirectory?.voice?.(personalityId) : undefined;
  }

  /**
   * What voice resolution actually does here: the provider ids that serve this
   * gateway's DEFAULT entries, plus the reason either one is missing (unknown
   * provider, failed init, or refused by the local-only egress gate). Resolution
   * is memoized, so calling this is equivalent to what the first voice message
   * on a personality with no roster pick triggers — which is exactly why it can
   * answer "which provider ran".
   */
  async voiceProviderStatus(): Promise<{
    stt: string | undefined;
    tts: string | undefined;
    sttError: string | undefined;
    ttsError: string | undefined;
  }> {
    const stt = await this.resolveSttProvider();
    const tts = await this.resolveTtsProvider();
    return {
      stt: stt.providerId,
      tts: tts.providerId,
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
   *
   * TWO LAYERS, both keyed identically. The in-memory `Set` is the fast path
   * and answers alone whenever it hits. Only on a miss — and only when a
   * durable store is configured — does this touch SQLite, because a process
   * restart empties the `Set` and a platform redelivery arriving at the fresh
   * process would otherwise be fully reprocessed and re-billed. Under webhook
   * mode with scale-to-zero that restart is routine rather than rare.
   *
   * Synchronous on purpose: the durable store is synchronous too
   * (`@ethosagent/sqlite` has no async API), and awaiting here would reorder
   * the inbound pipeline for every message to pay for a cold-start edge.
   */
  private isDuplicate(message: InboundMessage, botKey: string): boolean {
    // Both layers are disabled together — `dedupWindow: 0` means "no dedup",
    // not "no in-memory dedup".
    if (this.dedupWindow <= 0 || !message.messageId) return false;
    const key = buildLaneKey(message.platform, botKey, message.chatId, message.messageId);
    if (this.seenMessages.has(key)) return true;
    this.seenMessages.add(key);
    // Bound the set — drop the oldest entry once we exceed the window.
    if (this.seenMessages.size > this.dedupWindow) {
      const first = this.seenMessages.values().next().value;
      if (first !== undefined) this.seenMessages.delete(first);
    }
    // `Set` miss. The durable layer records the sighting and reports whether
    // it had already seen this key — from this process or a previous one.
    if (this.inboundDedup) {
      return this.inboundDedup.seen(message.platform, botKey, message.chatId, message.messageId);
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
    // The durable backstop (`inboundDedup`) sits BEHIND this same call, keyed
    // on the same `dedupBotKey`, so adding it changed nothing about when dedup
    // runs relative to botKey resolution or the safety filter.
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

      // …and the same for the channel-history block the adapter attached.
      // Empty means nothing survived the allowlist: drop the field outright
      // rather than prepend an empty wrapper to the turn.
      if (filterResult.strippedPriorContext !== undefined) {
        this.observability?.recordSafetyBlock({
          code: 'channel.prior_context_stripped',
          details: {
            platform: message.platform,
            chatId: message.chatId,
            userId: message.userId,
            dropped: filterResult.strippedPriorContext === '',
          },
        });
        message = {
          ...message,
          priorContext:
            filterResult.strippedPriorContext === ''
              ? undefined
              : filterResult.strippedPriorContext,
          priorContextEntries: undefined,
        };
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

    // Fix 5 (pi-delegation.md D7) — an ordinary inbound message establishes
    // presence too, not just answering a clarify (the clarify surfaces'
    // `correlateMessage`/`handleAction` paths above already record it for
    // that case). Otherwise a background job's later question only ever
    // routes to wherever the human last happened to answer a clarify, never
    // to wherever they're just casually chatting.
    if (isClarifySurfaceType(message.platform)) {
      bot.loop.clarifyBridge?.recordPresence(message.platform, {
        chatId: message.chatId,
        botKey: bot.botKey,
        ...(message.threadId ? { threadId: message.threadId } : {}),
      });
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
      // Voice mode deliberately SURVIVES /new: it is a durable per-lane
      // preference ("talk to me out loud in this chat"), not session state, and
      // a preference a /new wipes is not durable in any sense the user would
      // recognise. `lastInboundHadAudio` IS per-turn state and still clears.
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
        await this.voiceModeStore.set(laneKey, arg as VoiceMode);
        await adapter
          .send(message.chatId, { text: `✓ Voice mode: ${arg}`, threadId })
          .catch(() => {});
      } else if (!arg) {
        const current = await this.voiceModeStore.get(laneKey);
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
            const claimDelivered = await this.sendTracked(
              {
                adapter,
                botKey: bot.botKey,
                platform: message.platform,
                chatId: message.chatId,
                sessionKey: claimSessionKey,
              },
              { text: reply, threadId },
            );
            // A claimed reply is still a reply, so it goes through the SAME
            // voice decision the agent path does — otherwise a lane in `all`
            // mode falls silent the moment a hook answers for the agent, which
            // is exactly the "voice-in gets text-out" drift this lane closes.
            // The claim runs BEFORE transcription, so the audio signal is the
            // raw attachment list and there is no transcript to detect a
            // language from.
            if (
              claimDelivered &&
              shouldReplyWithVoice({
                mode: await this.voiceModeStore.get(laneKey),
                inboundHadAudio: hasAudioAttachments(message.attachments),
              })
            ) {
              await this.deliverVoiceReply({
                adapter,
                botKey: bot.botKey,
                platform: message.platform,
                chatId: message.chatId,
                threadId,
                sessionKey: claimSessionKey,
                text: reply,
                personalityId:
                  bot.binding.type === 'team' ? undefined : this.activePersonalityFor(laneKey, bot),
                language: undefined,
              });
            }
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
      const attachmentCache = this.attachmentCache;
      const storage = this.storage;
      // Set only when a transcript actually reached the turn. It becomes a
      // MESSAGE-LEVEL `<voice-origin>` annotation inside AgentLoop, riding
      // ALONGSIDE the `<attachments>` audio marker rather than replacing it —
      // the transcript is an annotation on the audio message, never a
      // substitute for it (OC #87269 / Hermes #51131). Nothing goes into the
      // system prompt, so a lane that mixes typed and spoken messages keeps a
      // byte-identical static prefix.
      let voiceOrigin: VoiceTurnOrigin | undefined;
      // BCP-47 tag of the inbound utterance, when the personality declares a
      // voice for it. Carried to the reply so a Spanish voice note comes back
      // in the Spanish voice.
      let voiceLanguage: string | undefined;
      if (hasAudioAttachments(message.attachments) && attachmentCache && storage) {
        // Resolved for THIS personality: a personality naming `voice.stt_provider`
        // is transcribed by that provider on a channel voice note, not only in
        // browser talk mode.
        const stt = await this.resolveSttProvider(personalityId);
        const results = await transcribeAudioAttachments(
          message.attachments ?? [],
          stt.provider,
          (url) => storage.readBytes(attachmentCache.resolveLocalPath(url)),
          {
            // Normalize before STT and retry once as wav. Absent transcoder →
            // the provider gets the platform's raw bytes, as it always did.
            ...(this.transcoder ? { transcoder: this.transcoder } : {}),
            onStage: (event) => {
              if (event.ok) return;
              this.observability?.recordSafetyBlock({
                code: `gateway.voice_stt_${event.stage}_failed`,
                cause: event.error,
                details: { platform: message.platform, chatId: message.chatId },
              });
            },
          },
        );
        text = buildTranscriptText(text, results);
        // Detected against the personality's OWN language keys, never against
        // the world: `detectLanguage` only ever decides between candidates, so
        // a personality with no language map produces no guess and the default
        // voice stands — the behaviour that existed before this did.
        const candidates = Object.keys(this.personalityVoice(personalityId)?.languages ?? {});
        voiceLanguage = candidates.length > 0 ? detectLanguage(text, { candidates }) : undefined;
        // A channel voice note is the account owner's own message on their own
        // lane — channel ingress is already sender-gated. A far-end caller
        // arrives over telephony (V4), never here.
        //
        // The stamped id is THIS turn's resolution, not a remembered global:
        // per-personality resolution makes "which provider ran" a per-turn fact.
        voiceOrigin = {
          transport: `${message.platform}-voice-note`,
          speaker: 'owner',
          ...(stt.providerId ? { sttProvider: stt.providerId } : {}),
          ...(voiceLanguage ? { language: voiceLanguage } : {}),
        };
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
        ...(voiceOrigin ? { voiceOrigin } : {}),
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
          // `shouldReplyWithVoice` is the ONE decision function (voice V1a
          // eng-review D3, drift-gated). Everything downstream of it is
          // delivery mechanics, which is why they live in their own method.
          const shouldSynth = shouldReplyWithVoice({
            mode: await this.voiceModeStore.get(laneKey),
            inboundHadAudio: this.lastInboundHadAudio.get(laneKey) ?? false,
          });
          if (shouldSynth) {
            await this.deliverVoiceReply({
              adapter,
              botKey: bot.botKey,
              platform: message.platform,
              chatId: message.chatId,
              threadId,
              sessionKey,
              text: sanitized,
              personalityId,
              language: voiceLanguage,
            });
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
  // Voice replies (voice V2)
  // ---------------------------------------------------------------------------

  /**
   * Speak one already-delivered reply.
   *
   * The caller has already asked `shouldReplyWithVoice()` — that decision has
   * exactly one implementation and does not live here. What lives here is
   * everything between "yes, speak" and bytes on the platform: caps, synthesis,
   * transcode, the byte cap, the artifact, and the delivery obligation.
   *
   * ONE voice note per reply, whatever its length. Sentence-chunking belongs to
   * live surfaces, where a listener is waiting on the first sentence; on a
   * channel it is eight notifications for one answer.
   *
   * Every early return records an event. A voice reply that silently does not
   * arrive is the failure mode this whole lane exists to close, so "nothing
   * happened and nobody knows why" is not an acceptable outcome of any branch.
   */
  private async deliverVoiceReply(input: {
    adapter: PlatformAdapter;
    botKey: string;
    platform: string;
    chatId: string;
    threadId: string | undefined;
    sessionKey: string;
    text: string;
    personalityId: string | undefined;
    language: string | undefined;
  }): Promise<void> {
    // `recordSafetyBlock` is this file's generic event sink — `dedup_drop` and
    // `delivery_redelivered` already ride it — not a claim that a skipped voice
    // note is a safety violation.
    const event = (code: string, details: Record<string, unknown> = {}, cause?: string): void => {
      this.observability?.recordSafetyBlock({
        code,
        ...(cause ? { cause } : {}),
        details: {
          platform: input.platform,
          botKey: input.botKey,
          chatId: input.chatId,
          ...details,
        },
      });
    };

    // 1. Operator override. `voice.channels.<platform>.ttsOut: false` outranks
    //    the lane's mode — a deployment decision beats a conversational one.
    if (this.channelVoiceOut?.[input.platform] === false) {
      event('gateway.voice_channel_disabled');
      return;
    }

    // 2. DECLARED caps, not `'sendVoice' in adapter`. The duck-type could not
    //    tell a voice bubble from a file attachment, could not name an accepted
    //    container, and gave every new adapter a silent no-op by default.
    if (!isVoiceOutboundAdapter(input.adapter)) {
      event('gateway.voice_no_caps');
      return;
    }
    const sink = input.adapter;

    // 3. Provider — resolved for THIS personality. A personality naming
    //    `voice.tts_provider` speaks through that provider on a channel reply,
    //    not only in browser talk mode. The refusal path is unchanged: a
    //    roster entry the egress gate rejects yields no provider and no
    //    synthesize call, whatever the entry was labelled.
    const tts = await this.resolveTtsProvider(input.personalityId);
    const speech = tts.provider;
    if (!speech) {
      event(
        'gateway.voice_no_provider',
        this.voiceProviderErrors.tts ? { error: this.voiceProviderErrors.tts } : {},
      );
      return;
    }

    // 4. Speakable text — markdown, emoji and code fences are not speech.
    let synthText = sanitizeForSpeech(input.text);
    const maxChars = speech.caps.maxInputChars;
    if (maxChars && synthText.length > maxChars) {
      synthText = truncateAtSentenceBoundary(synthText, maxChars);
    }
    if (synthText.length === 0) return;

    // 5. Which voice. Same resolution function the VoiceSession stack uses, so
    //    "which voice served this reply" has one answer across surfaces:
    //    language-specific > personality default > the CHOSEN entry's own voice
    //    (which is `auxiliary.tts.voice` when the default entry served).
    const personalityVoice = this.personalityVoice(input.personalityId);
    const voicePrefs = resolveVoicePreferences({
      ...(personalityVoice ? { personality: personalityVoice } : {}),
      ...(tts.entryVoice ? { globalTtsVoice: tts.entryVoice } : {}),
      ...(input.language ? { language: input.language } : {}),
    });

    // 6. Synthesis.
    const synthStarted = Date.now();
    let synthesized: Awaited<ReturnType<TtsProvider['synthesize']>>;
    try {
      synthesized = await speech.synthesize(
        synthText,
        voicePrefs.ttsVoice ? { voice: voicePrefs.ttsVoice } : undefined,
      );
    } catch (err) {
      event('gateway.voice_synth_failed', {}, err instanceof Error ? err.message : String(err));
      return;
    }
    event('gateway.voice_synth', {
      format: synthesized.format,
      bytes: synthesized.audio.length,
      durationMs: Date.now() - synthStarted,
      // The id that actually ran this turn, not a remembered global.
      ...(tts.providerId ? { ttsProvider: tts.providerId } : {}),
      ...(voicePrefs.ttsVoice ? { voice: voicePrefs.ttsVoice } : {}),
    });

    // 7. Transcode into a container the sink actually declared.
    const targets = sink.voiceCaps.outbound.formats;
    let bytes = synthesized.audio;
    let finalFormat: VoiceAudioFormat = synthesized.format;
    if (this.transcoder) {
      // `Transcoder` promises a typed result, but the shipped ffmpeg one writes
      // a scratch file first — a full or read-only tmpdir throws before any of
      // its own error handling runs. The text reply has already gone out, so
      // that must degrade to "no voice note, and here is why", never to a
      // rejected turn.
      const transcoded = await this.transcoder
        .transcode({
          data: synthesized.audio,
          sourceMimeType: voiceAudioMimeType(synthesized.format),
          targets,
          ...(this.voiceBitrateKbps ? { bitrateKbps: this.voiceBitrateKbps } : {}),
        })
        .catch(
          (err: unknown): TranscodeResult => ({
            ok: false,
            code: 'failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      if (!transcoded.ok) {
        event('gateway.voice_transcode_failed', { code: transcoded.code }, transcoded.error);
        return;
      }
      bytes = transcoded.data;
      finalFormat = transcoded.format;
    } else if (!targets.includes(synthesized.format)) {
      // No ffmpeg on this host. Sending mp3 bytes to a sink that declared opus
      // produces an undownloadable document, not a voice note — so skip and say
      // so, rather than deliver something that looks like a bug to the user.
      event('gateway.voice_format_unsupported', { format: synthesized.format, accepted: targets });
      return;
    }

    // 8. Platform byte cap.
    const maxBytes = sink.voiceCaps.outbound.maxBytes;
    if (maxBytes !== undefined && bytes.length > maxBytes) {
      event('gateway.voice_too_large', { bytes: bytes.length, maxBytes });
      return;
    }

    // 9. Persist the artifact BEFORE the send, so a failed send has something
    //    to redeliver. A store that is absent or failing returns null: the
    //    obligation is still recorded, which makes the loss visible even though
    //    it cannot then be repaired.
    const ref = (await this.voiceArtifacts?.put(bytes, finalFormat)) ?? null;

    // 10. Ledger, four-path contract: pending BEFORE the platform call.
    //     `content` is the SPOKEN TEXT — a voice row stays readable, hashes to
    //     a comparable value, and is diagnosable when its artifact is gone.
    const binding = this.deliveryBinding(input.botKey, input.platform);
    const obligationId = await beginDelivery(binding, {
      chatId: input.chatId,
      sessionId: input.sessionKey,
      threadId: input.threadId,
      content: synthText,
      kind: 'voice',
      ...(ref ? { artifactRef: ref } : {}),
      mediaFormat: finalFormat,
    });

    // 11. Send. A throw folds into `{ ok: false }` exactly as in `sendTracked`.
    const result = await sink
      .sendVoiceNote(input.chatId, bytes, {
        format: finalFormat,
        mimeType: voiceAudioMimeType(finalFormat),
        filename: `reply.${voiceAudioExtension(finalFormat)}`,
        ...(input.threadId ? { threadId: input.threadId } : {}),
      })
      .catch(
        (err: unknown): DeliveryResult => ({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );

    // 12. Confirmed → the obligation is discharged and its artifact is released
    //     (retention D9: delivering deletes). Otherwise the row stays `pending`
    //     and the artifact stays on disk for the sweep to re-send.
    if (result?.ok === true) {
      await confirmDelivery(binding, obligationId);
      if (ref) await this.voiceArtifacts?.remove(ref);
      return;
    }
    event(
      'gateway.delivery_unconfirmed',
      { kind: 'voice', error: result?.error, durable: obligationId !== null },
      'adapter did not confirm voice delivery',
    );
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
   * Whether any turn is in flight on this gateway — the busy predicate an
   * idle-watcher consults before a scale-to-zero host is told it may snapshot
   * or stop the VM.
   *
   * Both maps are read from one accessor because they are two halves of the
   * same fact: `activeTurns` and `activeSinks` are set together at turn start
   * and deleted together in `runTurn`'s `finally`, so they are normally empty
   * or non-empty as a pair. The `||` is the conservative half — if a sink ever
   * outlived its turn it would still be work in flight, and answering "idle"
   * there would stop the process out from under a live steer.
   */
  hasActiveTurns(): boolean {
    return this.activeTurns.size > 0 || this.activeSinks.size > 0;
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
    if (this.clarifyEscalationTimer) {
      clearInterval(this.clarifyEscalationTimer);
      this.clarifyEscalationTimer = undefined;
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
   * Send an agent- or subsystem-initiated notification through the DURABLE
   * outbound path — the public door onto `sendTracked`.
   *
   * `sendTo()` is the other public send and records no obligation: it is the
   * `send_message` tool's path, where the agent is told immediately whether the
   * send worked and can react. This one is for messages nobody is waiting on —
   * a post-call summary, an owner notice that a call was refused for capacity —
   * where "silently lost" is the failure mode and a `pending` row that the boot
   * sweep redelivers is the fix. Same ledger, same `DeliveryResult.ok === true`
   * definition of confirmed, same observability event on an unconfirmed send;
   * there is deliberately no second ledger path.
   *
   * Returns whether the platform CONFIRMED. `false` with a ledger wired means
   * the obligation is still `pending` and will be retried by
   * {@link sweepPendingDeliveries}.
   *
   * Refuses (returning false, and recording the same unconfirmed event) when
   * the platform has no registered adapter, or when the bot cannot be named: an
   * obligation filed under a botKey this process does not own is one the sweep
   * will never pick up, which is a lost message wearing a durable row. In
   * multi-bot deployments `botKey` is therefore required — `voice.inbound.owner`
   * carries one for exactly this reason.
   */
  async notifyTracked(
    target: {
      platform: string;
      chatId: string;
      botKey?: string;
      /** Ledger session id. Defaults to `<platform>:<chatId>`. */
      sessionKey?: string;
      threadId?: string;
    },
    text: string,
  ): Promise<boolean> {
    const refuse = (cause: string): false => {
      this.observability?.recordSafetyBlock({
        code: 'gateway.delivery_unconfirmed',
        cause,
        details: {
          platform: target.platform,
          ...(target.botKey ? { botKey: target.botKey } : {}),
          chatId: target.chatId,
          durable: false,
        },
      });
      return false;
    };

    const adapter = this.adapterRegistry.get(target.platform);
    if (!adapter) return refuse(`no adapter registered for platform "${target.platform}"`);

    const botKey = target.botKey ?? this.defaultBotKey;
    if (!botKey) return refuse('no botKey given and this deployment has no single default bot');
    if (!this.bots.has(botKey)) return refuse(`botKey "${botKey}" is not served by this process`);

    return this.sendTracked(
      {
        adapter,
        botKey,
        platform: target.platform,
        chatId: target.chatId,
        sessionKey: target.sessionKey ?? `${target.platform}:${target.chatId}`,
      },
      { text, ...(target.threadId ? { threadId: target.threadId } : {}) },
    );
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
        if (row.kind === 'voice') {
          // A voice obligation owes BYTES, not a string, so it takes its own
          // path — one that re-sends the stored artifact and never
          // re-synthesizes (a second TTS pass is a different recording).
          if (await this.redeliverVoiceObligation(row, adapter, ledger)) redelivered++;
          else failed++;
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

  /**
   * Redeliver one claimed `voice` obligation by re-sending its stored artifact.
   *
   * It never re-synthesizes. A second TTS pass is a different recording — the
   * engine is not deterministic and the personality's voice may have changed
   * since — so the user would receive an answer they can hear is not the one
   * that was lost. The artifact IS the obligation's payload.
   *
   * Returns whether the platform confirmed. Every failure hands the row back to
   * the pending pool rather than burning it.
   */
  private async redeliverVoiceObligation(
    row: DeliveryObligation,
    adapter: PlatformAdapter,
    ledger: DeliveryLedger,
  ): Promise<boolean> {
    const giveBack = async (code: string, details: Record<string, unknown> = {}) => {
      await ledger.release(row.id);
      this.observability?.recordSafetyBlock({
        code,
        details: { platform: row.platform, botKey: row.botKey, chatId: row.chatId, ...details },
      });
      return false;
    };

    const ref = row.artifactRef;
    const bytes = ref ? await this.voiceArtifacts?.read(ref) : undefined;
    if (!bytes) {
      // Deliberately NOT a text fallback on `row.content`. The written reply
      // for this turn already went out under its own obligation, so sending
      // the spoken text as a message here would deliver the same answer twice.
      // A missing voice note is the smaller failure, and the event names it.
      return giveBack('gateway.voice_artifact_missing', { artifactRef: ref ?? null });
    }
    if (!isVoiceOutboundAdapter(adapter)) {
      return giveBack('gateway.voice_no_caps');
    }

    const declared = adapter.voiceCaps.outbound.formats;
    // The row's own format is authoritative: the artifact holds exactly those
    // bytes, and re-labelling them would hand the platform a mislabelled
    // container. It is matched against the adapter's declared list because that
    // is the only typed source of `VoiceAudioFormat` values here — a stored
    // format the adapter no longer accepts (a caps change between the send and
    // the sweep) is refused rather than mislabelled. A null column is a pre-v3
    // row or a store that lost it; the sink's preferred format is the best
    // available guess.
    const format = row.mediaFormat ? declared.find((f) => f === row.mediaFormat) : declared[0];
    if (!format) {
      return giveBack('gateway.voice_format_unsupported', {
        format: row.mediaFormat,
        accepted: declared,
      });
    }

    const result = await adapter
      .sendVoiceNote(row.chatId, bytes, {
        format,
        mimeType: voiceAudioMimeType(format),
        filename: `reply.${voiceAudioExtension(format)}`,
        ...(row.threadId ? { threadId: row.threadId } : {}),
      })
      .catch(
        (err: unknown): DeliveryResult => ({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    if (result?.ok !== true) {
      return giveBack('gateway.delivery_unconfirmed', { kind: 'voice', error: result?.error });
    }

    await ledger.markDelivered(row.id);
    // Redelivery bypassed `shouldSend()` — a warm cache must not swallow what
    // the user never received — so record the key afterwards, exactly as the
    // text path does, and release the artifact now that it is discharged.
    this.outboundDedup.record(row.sessionId, row.content);
    if (ref) await this.voiceArtifacts?.remove(ref);
    this.observability?.recordSafetyBlock({
      code: 'gateway.delivery_redelivered',
      details: {
        kind: 'voice',
        platform: row.platform,
        botKey: row.botKey,
        chatId: row.chatId,
        contentHash: row.contentHash,
        createdAt: row.createdAt,
      },
    });
    return true;
  }

  /**
   * Discount a host pause from the stale-obligation abandon window.
   *
   * On a snapshot-and-restore host the wall clock advances while the guest is
   * frozen. If the pause alone exceeds `abandonAfterDays`, the first
   * post-resume sweep abandons — and, for voice, DELETES the audio artifact of
   * — an obligation that was never actually lost. Successive pauses
   * accumulate. Non-positive or non-finite durations are a no-op.
   */
  applyPauseOffset(pauseDurationMs: number): void {
    if (!Number.isFinite(pauseDurationMs) || pauseDurationMs <= 0) return;
    this.pauseOffsetMs += pauseDurationMs;
  }

  /**
   * Retention pass for synthesized voice artifacts.
   *
   * Three mechanisms, in the order they should fire: an obligation that was
   * DELIVERED released its artifact at confirm time (in `deliverVoiceReply`);
   * one that was never delivered is abandoned here after `abandonAfterDays` and
   * its artifact deleted with it; and the total-size cap is the backstop for
   * everything neither of those caught — an artifact whose row vanished, or a
   * burst that outran the abandon window.
   *
   * Never throws, and never runs without both a ledger and a store: abandoning
   * rows whose artifacts nothing can delete, or deleting artifacts whose rows
   * nothing abandoned, would leave the two halves permanently out of step.
   */
  async pruneVoiceArtifacts(opts: {
    abandonAfterDays: number;
    maxTotalMb: number;
  }): Promise<{ abandoned: number; bytesFreed: number }> {
    const ledger = this.deliveryLedger;
    const artifacts = this.voiceArtifacts;
    if (!ledger || !artifacts) return { abandoned: 0, bytesFreed: 0 };

    let abandoned = 0;
    try {
      const cutoff = Date.now() - opts.abandonAfterDays * 86_400_000 - this.pauseOffsetMs;
      // Ownership-filtered inside the ledger: a shared ledger file must never
      // let this deployment abandon a live peer's obligation.
      const rows = await ledger.abandonStale([...this.bots.keys()], cutoff);
      abandoned = rows.length;
      for (const row of rows) {
        if (row.artifactRef) await artifacts.remove(row.artifactRef);
      }
    } catch (err) {
      this.observability?.recordSafetyBlock({
        code: 'gateway.voice_abandon_failed',
        cause: err instanceof Error ? err.message : String(err),
      });
    }

    let bytesFreed = 0;
    try {
      bytesFreed = await artifacts.enforceSizeCap(opts.maxTotalMb * 1024 * 1024);
    } catch (err) {
      this.observability?.recordSafetyBlock({
        code: 'gateway.voice_size_cap_failed',
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    return { abandoned, bytesFreed };
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

  // ---------------------------------------------------------------------------
  // Mid-run "needs you" escalation (§4.6 rung 3)
  // ---------------------------------------------------------------------------

  /**
   * Push a "needs you" notice to the origin lane of every run parked on a
   * question that has been PRESENTED and unanswered for longer than
   * `clarifyEscalationDelayMs` (§4.6 rung 3, D2's clock rule).
   *
   * Runs on its own timer, and is public so a caller (or a test) can drive one
   * pass deterministically. Per bot: the bridge supplies the SHARED clarify
   * store every process sweeps, the job store supplies G5's second claim
   * (`claimNotice`, keyed by `requestId` so it never spends the completion
   * notice's `deliveredAt`), and delivery goes through `sendTracked` — the same
   * ledger-backed path the completion notice uses, so an unconfirmed push is
   * redelivered by `sweepPendingDeliveries()` rather than lost.
   *
   * Never throws: it is called from a timer with no one to catch it.
   */
  async sweepClarifyEscalations(
    now: number = Date.now(),
  ): Promise<{ pushed: number; failed: number }> {
    let pushed = 0;
    let failed = 0;
    for (const bot of this.bots.values()) {
      const bridge = bot.loop.clarifyBridge;
      const store = bot.jobStore;
      if (!bridge || !store) continue;
      const result = await runClarifyEscalationSweep(
        {
          store: bridge.store,
          jobs: store,
          delayMs: this.clarifyEscalationDelayMs,
          // With a ledger wired, an unconfirmed push left a `pending`
          // obligation and the ledger sweep owns the retry, so the claim is
          // kept. Without one, nothing would ever retry — release it.
          durableRetry: this.deliveryLedger !== undefined,
          resolveTarget: (job) => this.clarifyNoticeTarget(bot, job),
          notify: (target, text) => this.deliverClarifyNotice(bot, target, text),
          onError: (stage, err, details) => {
            this.observability?.recordSafetyBlock({
              code: 'clarify.escalation_failed',
              cause: err instanceof Error ? err.message : String(err),
              details: { stage, botKey: bot.botKey, ...details },
            });
          },
        },
        now,
      );
      pushed += result.pushed;
      failed += result.failed;
    }
    return { pushed, failed };
  }

  /**
   * The lane a parked run's notice is pushed to, or `null` to skip it: a job
   * with no recorded origin (CLI-owned), a job whose origin belongs to a
   * DIFFERENT bot in a shared store (an obligation filed under someone else's
   * botKey is a lost message), or a platform this process has no adapter for.
   * Skipping returns the row untouched — its claim is never spent.
   */
  private clarifyNoticeTarget(
    bot: GatewayBotConfig,
    job: BackgroundJob,
  ): ClarifyNoticeTarget | null {
    const platform = job.originPlatform;
    const chatId = job.originChatId;
    if (!platform || !chatId) return null;
    if (job.originBotKey && job.originBotKey !== bot.botKey) return null;
    if (!this.adapterRegistry.get(platform)) return null;
    return {
      platform,
      botKey: bot.botKey,
      chatId,
      ...(job.originThreadId ? { threadId: job.originThreadId } : {}),
    };
  }

  /**
   * Send one escalation notice through the durable outbound path. Returns
   * whether the platform confirmed; a dedup hit counts as confirmed, since the
   * identical text already reached this lane.
   */
  private async deliverClarifyNotice(
    bot: GatewayBotConfig,
    target: ClarifyNoticeTarget,
    text: string,
  ): Promise<boolean> {
    const adapter = this.adapterRegistry.get(target.platform);
    if (!adapter) return false;
    const laneKey = target.threadId
      ? buildLaneKey(target.platform, bot.botKey, target.chatId, target.threadId)
      : buildLaneKey(target.platform, bot.botKey, target.chatId);
    if (!this.outboundDedup.shouldSend(laneKey, text)) return true;
    return this.sendTracked(
      {
        adapter,
        botKey: bot.botKey,
        platform: target.platform,
        chatId: target.chatId,
        sessionKey: this.sessionKeys.get(laneKey) ?? laneKey,
      },
      { text, ...(target.threadId ? { threadId: target.threadId } : {}) },
    );
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
      // Voice mode is NOT evicted with the lane. Eviction is a memory-pressure
      // decision about in-process state; the mode is a persisted preference,
      // and dropping it here would silently un-set what the user typed the
      // moment a busy deployment crossed `maxChats`.
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
