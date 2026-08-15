// Production construction of the real-time voice stack.
//
// Before this module, `VoiceSession`, `VoiceChannelAdapter`, the LiveKit/SIP
// transports and `config.voice.*` were all built, typed and unit-tested — and
// had zero construction sites. This is the wiring that makes them reachable.
//
// Two rules shape it:
//
//   1. Absent config is a clean no-op, never a crash. No `voice.*` block →
//      `buildVoiceStack` returns null and nothing downstream changes. The
//      LiveKit/SIP MEDIA leg additionally requires an app-supplied room-client
//      binding (`@livekit/rtc-node` is not a repo dependency), so a
//      half-configured deployment degrades to "that transport is unavailable"
//      rather than throwing at boot.
//
//      What is NO LONGER app-supplied: the LiveKit token minter and the SIP
//      CONTROL plane. Both are plain signed-JWT + HTTPS work that
//      `@ethosagent/platform-voice` implements without an SDK, and both are
//      built here from `voice.livekit.*` / `voice.trunk.*`. Before this,
//      `voice.livekit.apiKey`/`apiSecret` were parsed and never read and
//      `VoiceStack.sipTrunk` was `undefined` in every shipped deployment —
//      which is to say telephony was configured and unreachable.
//
//   2. Providers resolve through ONE path — `resolveSttProviderForPersonality` /
//      `resolveTtsProviderForPersonality` in `@ethosagent/core`, shared with the
//      gateway and web-api — so the provider id stamped into the latency spans
//      is the provider that actually ran, and the local-only egress gate cannot
//      be bypassed by constructing a provider some other way. Resolution is
//      per-PERSONALITY and memoized per roster entry, not per deployment: the
//      personality that speaks picks the provider, and two personalities naming
//      different roster entries get different providers on the same machine.

import type { VoiceBargeInSurface, VoiceBargeInTuning } from '@ethosagent/config';
import type { VoiceLaneClientKind } from '@ethosagent/core';
import {
  deriveBotKey,
  resolveSttProviderForPersonality,
  resolveTtsProviderForPersonality,
  resolveVoicePreferences,
  type SttProviderForPersonality,
  selectSttEntry,
  selectTtsEntry,
  type TtsProviderForPersonality,
  unwrapVoiceResolution,
  voiceLaneKey,
} from '@ethosagent/core';
import type {
  CallConcurrencyLimiter,
  LiveKitRoomClient,
  LiveKitTokenMinter,
  PerCallerRateLimiter,
  SipTrunkClient,
  VoiceArtifact,
  VoiceBotIdentity,
  VoiceDailyBudget,
} from '@ethosagent/platform-voice';
import {
  createCallConcurrencyLimiter,
  createLiveKitSipTrunkClient,
  createLiveKitTokenMinter,
  createPerCallerRateLimiter,
  createVoiceDailyBudget,
  LiveKitVoiceTransport,
  VoiceChannelAdapter,
} from '@ethosagent/platform-voice';
import type {
  Logger,
  PersonalityConfig,
  PersonalityVoiceConfig,
  SecretsResolver,
  SttProviderRegistry,
  TtsProviderRegistry,
} from '@ethosagent/types';
import type {
  AgentTurnRunner,
  VoiceSessionConfig,
  VoiceSpanRecorder,
  VoiceSpanSink,
} from '@ethosagent/voice-session';
import { BufferedVoiceSpanWriter, EnergyVad, VoiceSession } from '@ethosagent/voice-session';
import type { WiringConfig } from './index';
import type { EthosObservability } from './observability/ethos-observability';

/**
 * Native LiveKit MEDIA binding. `createClient` is supplied by the app layer
 * because `@livekit/rtc-node` is not a repo dependency — the seam stays pure
 * and testable with fakes.
 *
 * `tokenMinter` is now OPTIONAL: when omitted it is built from
 * `voice.livekit.apiKey`/`apiSecret`, which needs no SDK (an HS256 JWT). Supply
 * one only to override — a test double, or an app minting through a different
 * credential source.
 */
export interface LiveKitBindings {
  createClient: () => LiveKitRoomClient;
  tokenMinter?: LiveKitTokenMinter;
}

export interface BuildVoiceStackDeps {
  config: WiringConfig;
  sttProviders: SttProviderRegistry;
  ttsProviders: TtsProviderRegistry;
  secrets?: SecretsResolver;
  logger: Logger;
  /** Span destination. Omit to buffer into a discard sink (spans are dropped). */
  observability?: EthosObservability;
  /** Native LiveKit media binding; omit and no voice transport is built. */
  livekit?: LiveKitBindings;
  /**
   * SIP trunk client OVERRIDE. Omit and the trunk is derived from
   * `voice.trunk.*` + `voice.livekit.*` (see {@link resolveSipTrunkClient}); an
   * explicitly supplied client always wins, which is what keeps tests and an
   * app wanting a non-LiveKit trunk from having to fight the derivation.
   *
   * Scope note: this override reaches the STACK, not the `call` tool. The tool
   * is composed in an earlier phase and derives its own trunk from config, so a
   * deployment that only injects here gets telephony on the media path and a
   * `call` tool that still reports itself unavailable. That is the honest
   * outcome — `call` should be advertised on the strength of what an operator
   * configured, not of what a caller injected at runtime.
   */
  trunk?: SipTrunkClient;
}

/**
 * The deployment-wide inbound-call gates, built ONCE from `voice.inbound.*`.
 *
 * One instance each per deployment, deliberately: a concurrency limiter, a
 * per-caller window and a daily budget are all *state*, and a second instance
 * is a second cap. They are handed to `decideInboundCall` on every ring.
 */
export interface VoiceInboundGates {
  /** Simultaneous-call cap. Default 2 when `voice.inbound.concurrencyCap` is absent. */
  readonly concurrency: CallConcurrencyLimiter;
  /** Rolling per-caller hour window. Absent when `perCallerPerHour` is not configured. */
  readonly rateLimit: PerCallerRateLimiter | undefined;
  /** Global daily spend ceiling. Always present; unlimited when no `dailyBudgetUsd`. */
  readonly budget: VoiceDailyBudget;
  /** `voice.inbound.allowlist` — E.164 patterns that reach the owner's personality. */
  readonly allowlist: readonly string[] | undefined;
  /** `voice.inbound.receptionist` — the restricted personality unknown callers get. */
  readonly receptionist: string | undefined;
  /** `voice.inbound.prewarm` — who gets a provider socket opened on RING. */
  readonly prewarm: 'allowlisted' | 'none' | 'all';
  /** `voice.inbound.owner` — where summaries and refusal notices are delivered. */
  readonly owner: { platform: string; chatId: string; botKey?: string } | undefined;
}

/** Options shared by both per-call adapter factories. */
export interface CreateVoiceAdapterOptions {
  bot: VoiceBotIdentity;
  roomName: string;
  callerId: string;
  runner: AgentTurnRunner;
  agentIdentity?: string;
  sendArtifact?: (artifact: VoiceArtifact) => void | Promise<void>;
  /** The personality answering/placing this call — picks the voice AND the providers. */
  personality?: PersonalityConfig;
  /** BCP-47 tag selecting from the personality's language→voice map. */
  language?: string;
  /** Endpointing / filler / voice overrides layered over the resolved defaults. */
  sessionConfig?: VoiceSessionConfig;
  /** Fired exactly once when the call ends — the post-call-summary trigger. */
  onEnded?: (adapter: VoiceChannelAdapter) => void | Promise<void>;
}

export interface CreateVoiceSessionOptions {
  /** `voice:<botKey>:<callerId>` — stamped on every span for this lane. */
  laneKey: string;
  /** Drives one agent turn. `AgentLoop` satisfies this structurally. */
  runner: AgentTurnRunner;
  /**
   * The personality speaking on this lane. Its `voice` block wins over the
   * global `auxiliary.tts.*` defaults — voice is part of who a personality is,
   * not a deployment setting (see `PersonalityConfig.voice`).
   */
  personality?: PersonalityConfig;
  /** BCP-47 tag selecting from the personality's language→voice map. */
  language?: string;
  /** Endpointing / filler / voice overrides layered over the resolved defaults. */
  sessionConfig?: VoiceSessionConfig;
  /**
   * Which `voice.bargeIn.<surface>` block tunes this lane's VAD and endpointing.
   *
   * Set by the adapter factories from the lane kind, not by the caller: a PSTN
   * leg is the `call` surface whoever opened it. Omitted — as it is on a lane
   * with no surface of its own — and the session keeps the built-in defaults,
   * which is byte-identical to the behaviour before this option existed.
   */
  surface?: VoiceBargeInSurface;
}

export interface VoiceStack {
  /** Bots from `voice.bots[]`, in config order (first match wins). */
  readonly bots: readonly VoiceBotIdentity[];
  /** Provider ids that actually resolved, for `ethos doctor` / status. */
  readonly sttProviderId: string | undefined;
  readonly ttsProviderId: string | undefined;
  /** Non-null when a configured provider could not be resolved (with the reason). */
  readonly providerError: string | undefined;
  /** The armed egress allowlist, or undefined when the gate is off. */
  readonly trustedVoicePlugins: ReadonlySet<string> | undefined;
  /**
   * Build a live session for one lane. Throws `VoiceProviderError` when a
   * configured provider did not resolve (unknown, uninitialisable, or refused
   * by the egress gate) — a session with no voice is not a session.
   *
   * ASYNC because provider resolution is now per-personality: which STT/TTS
   * provider serves this lane depends on the personality speaking on it, and
   * constructing a provider is an async factory call. The alternative — resolve
   * lazily inside the session's first use — would have to hand `VoiceSession` a
   * promise or a thunk where it holds a provider today, i.e. change the
   * contract of the class that owns the audio path, to save one `await` on a
   * path that already awaits a network dial.
   */
  createSession(opts: CreateVoiceSessionOptions): Promise<VoiceSession>;
  /**
   * Per-caller LiveKit adapter factory (a room participant — browser, agent,
   * SIP bridge joining as a peer). Present only when `voice.livekit.*` is
   * configured AND a media binding was supplied.
   */
  createLiveKitAdapter?: (opts: CreateVoiceAdapterOptions) => Promise<VoiceChannelAdapter>;
  /**
   * Per-call SIP adapter factory — the same media path with `laneKind: 'sip'`,
   * so a PSTN leg gets its own lane key (`voice:<botKey>:sip:<callerId>`) and
   * can never interleave with the same person's browser talk session.
   * Present under the same condition as {@link createLiveKitAdapter}.
   */
  createSipAdapter?: (opts: CreateVoiceAdapterOptions) => Promise<VoiceChannelAdapter>;
  /**
   * The configured SIP trunk — derived from `voice.trunk.*` + `voice.livekit.*`,
   * or the explicit `deps.trunk` override. Absent when no trunk is configured.
   */
  readonly sipTrunk?: SipTrunkClient;
  /** Caller-ID for outbound calls, from `voice.trunk.fromNumber`. */
  readonly fromNumber?: string;
  /** Deployment-wide inbound gates. See {@link VoiceInboundGates}. */
  readonly inbound: VoiceInboundGates;
  /**
   * The deployment's ONE voice span writer, `record`-only.
   *
   * Exposed so the browser realtime tier — whose media socket never touches
   * this process, and which therefore builds no `VoiceSession` here — records
   * its per-turn latency into the SAME buffer and the SAME sink as the pipeline
   * tier. The alternative was a second writer in web-api, which would mean two
   * buffers, two flush timers and two chances for one of them to grow a
   * synchronous write on an audio path.
   */
  readonly spans: VoiceSpanRecorder;
  /** Flush buffered spans and stop the flush timer. */
  close(): Promise<void>;
}

/**
 * Construct the voice stack from `config.voice.*`. Returns null when no voice
 * block is configured — the clean no-op path every non-voice deployment takes.
 */
export async function buildVoiceStack(deps: BuildVoiceStackDeps): Promise<VoiceStack | null> {
  const voice = deps.config.voice;
  if (!voice) return null;

  const trustedVoicePlugins = voice.trustedPlugins ? new Set(voice.trustedPlugins) : undefined;
  const bots: VoiceBotIdentity[] = voice.bots.map((bot) => ({
    ...(bot.id ? { id: bot.id } : {}),
    match: bot.match,
  }));

  const asr = deps.config.auxiliaryAsr;
  const tts = deps.config.auxiliaryTts;
  const sttRoster = voice.stt?.providers;
  const ttsRoster = voice.tts?.providers;

  // One provider per ROSTER ENTRY, not one per deployment. The memo holds the
  // in-flight promise rather than the settled provider so two lanes opening at
  // once share a single factory call instead of racing to build two.
  const sttMemo = new Map<string, Promise<SttProviderForPersonality>>();
  const ttsMemo = new Map<string, Promise<TtsProviderForPersonality>>();

  const resolveSttFor = (
    personality: PersonalityVoiceConfig | undefined,
  ): Promise<SttProviderForPersonality> => {
    // Selection is pure, so the memo key is available BEFORE the (expensive,
    // async) resolution. A personality naming an entry this machine lacks
    // collapses onto the default entry's cached provider, which is exactly
    // where the shared resolver would send it anyway. No logger here — the
    // resolver below logs the unknown-name fallback once.
    const key = entryMemoKey(
      selectSttEntry({
        ...(personality?.stt_provider ? { requestedName: personality.stt_provider } : {}),
        ...(sttRoster ? { roster: sttRoster } : {}),
      }).entryName,
    );
    const cached = sttMemo.get(key);
    if (cached) return cached;
    const pending = resolveSttProviderForPersonality({
      registry: deps.sttProviders,
      ...(personality ? { personality } : {}),
      ...(sttRoster ? { roster: sttRoster } : {}),
      ...(asr?.provider ? { defaultProviderName: asr.provider } : {}),
      defaultProviderConfig: providerConfigFrom(asr),
      ...(deps.secrets ? { secrets: deps.secrets } : {}),
      logger: deps.logger,
      ...(trustedVoicePlugins ? { trustedVoicePlugins } : {}),
    });
    sttMemo.set(key, pending);
    return pending;
  };

  const resolveTtsFor = (
    personality: PersonalityVoiceConfig | undefined,
  ): Promise<TtsProviderForPersonality> => {
    const key = entryMemoKey(
      selectTtsEntry({
        ...(personality?.tts_provider ? { requestedName: personality.tts_provider } : {}),
        ...(ttsRoster ? { roster: ttsRoster } : {}),
      }).entryName,
    );
    const cached = ttsMemo.get(key);
    if (cached) return cached;
    const pending = resolveTtsProviderForPersonality({
      registry: deps.ttsProviders,
      ...(personality ? { personality } : {}),
      ...(ttsRoster ? { roster: ttsRoster } : {}),
      ...(tts?.provider ? { defaultProviderName: tts.provider } : {}),
      defaultProviderConfig: providerConfigFrom(tts),
      ...(deps.secrets ? { secrets: deps.secrets } : {}),
      logger: deps.logger,
      ...(trustedVoicePlugins ? { trustedVoicePlugins } : {}),
    });
    ttsMemo.set(key, pending);
    return pending;
  };

  // Boot resolution of the DEFAULT entries only — what `ethos doctor` reports
  // and what a deployment with no per-personality roster picks gets. It also
  // seeds the memo, so the first call on the default lane costs nothing.
  const sttResolution = (await resolveSttFor(undefined)).resolution;
  const ttsResolution = (await resolveTtsFor(undefined)).resolution;

  const failures = [sttResolution, ttsResolution]
    .filter((r) => !r.ok)
    .map((r) => (r.ok ? '' : r.error));
  if (failures.length > 0) {
    // A boot-time warning, never a boot-time throw: a mistyped provider must
    // not stop the rest of the deployment from starting. The throw happens at
    // `createSession`, where someone is actually asking to talk.
    for (const failure of failures) deps.logger.warn(`voice: ${failure}`);
  }

  const spanWriter = new BufferedVoiceSpanWriter({
    sink: deps.observability ? createObservabilitySpanSink(deps.observability) : DISCARD_SINK,
    onError: (err) => deps.logger.warn(`voice: span flush failed: ${String(err)}`),
    onDrop: (total) => deps.logger.warn(`voice: span buffer full — ${total} span(s) dropped`),
  });

  const createSession = async (opts: CreateVoiceSessionOptions): Promise<VoiceSession> => {
    const personalityVoice = opts.personality?.voice;
    // `voice.bargeIn.<surface>` — parsed, validated, surfaced in Settings, and
    // until now read by nothing. This is the only place it lands: an untuned
    // surface (or a lane with no surface) contributes no keys at all, so the
    // VAD and the endpoint detector keep their own defaults.
    const tuning: VoiceBargeInTuning =
      (opts.surface ? voice.bargeIn?.[opts.surface] : undefined) ?? {};
    const [sttFor, ttsFor] = await Promise.all([
      resolveSttFor(personalityVoice),
      resolveTtsFor(personalityVoice),
    ]);
    const stt = unwrapVoiceResolution(sttFor.resolution);
    const speech = unwrapVoiceResolution(ttsFor.resolution);
    // Personality voice > the CHOSEN entry's own voice (which is
    // `auxiliary.tts.voice` when the default entry served). Resolved through
    // the SAME function every other surface uses, so "which voice served this
    // turn" has one answer.
    //
    // No `globalModel` is passed: the deployment has no fast-lane model key to
    // pass one from. `config.model` is the AGENTIC default — handing it over
    // would pin every spoken lane to the very model L5 exists to keep off it,
    // and would outrank a personality's own tier config while doing so. The
    // fast-lane model is personality identity (see the `voice.wake` note in
    // `@ethosagent/config`), so it resolves from the personality alone.
    const preferences = resolveVoicePreferences({
      ...(personalityVoice ? { personality: personalityVoice } : {}),
      ...(ttsFor.globalTtsVoice ? { globalTtsVoice: ttsFor.globalTtsVoice } : {}),
      ...(opts.language ? { language: opts.language } : {}),
    });
    return new VoiceSession({
      // L5 — the fast-lane model, pinned onto the runner ONCE per lane rather
      // than passed per turn. This is the hop that makes `voice.model` live:
      // every host that opens a lane (LiveKit adapter, SIP adapter, and
      // anything else handing us a runner) gets the routing without having to
      // remember it, and a lane whose personality declares no `voice.model`
      // gets the untouched runner.
      runner: preferences.model ? pinRunnerModel(opts.runner, preferences.model) : opts.runner,
      // Batch-only providers get the utterance-buffered fallback inside
      // VoiceSession — WAV bytes in memory, no temp file, nothing to inject.
      stt: stt.provider,
      tts: speech.provider,
      vad: new EnergyVad({
        ...(tuning.energyThreshold !== undefined ? { threshold: tuning.energyThreshold } : {}),
        ...(tuning.minSpeechMs !== undefined ? { minSpeechMs: tuning.minSpeechMs } : {}),
      }),
      spans: spanWriter,
      laneKey: opts.laneKey,
      logger: deps.logger,
      config: {
        ...(preferences.ttsVoice ? { ttsVoice: preferences.ttsVoice } : {}),
        // Under `opts.sessionConfig`: the operator tunes the SURFACE, a caller
        // that hands us an explicit endpoint for one lane means that one lane.
        ...(tuning.silenceMs !== undefined ? { endpointSilenceMs: tuning.silenceMs } : {}),
        ...opts.sessionConfig,
      },
    });
  };

  // The SIP CONTROL plane and the token minter build themselves from config —
  // both are signed-JWT + HTTPS, no SDK. An explicit `deps.trunk` still wins.
  const livekitConfig = voice.livekit;
  const sipTrunk = deps.trunk ?? resolveSipTrunkClient(deps.config);
  const tokenMinter =
    deps.livekit?.tokenMinter ??
    (livekitConfig
      ? createLiveKitTokenMinter({
          apiKey: livekitConfig.apiKey,
          apiSecret: livekitConfig.apiSecret,
        })
      : undefined);

  const media =
    livekitConfig && deps.livekit && tokenMinter
      ? {
          createClient: deps.livekit.createClient,
          tokenMinter,
          url: livekitConfig.url,
        }
      : undefined;

  const stack: VoiceStack = {
    bots,
    sttProviderId: sttResolution.ok ? sttResolution.providerId : undefined,
    ttsProviderId: ttsResolution.ok ? ttsResolution.providerId : undefined,
    providerError: failures.length > 0 ? failures.join('; ') : undefined,
    trustedVoicePlugins,
    createSession,
    ...(media
      ? {
          // No `surface` on the room adapter: `voice.bargeIn` names `call` and
          // `satellite`, and a LiveKit room participant is neither.
          // `VoiceLaneClientKind` keeps `livekit` and `browser` apart on
          // purpose, and the browser talk lane does its endpointing in the
          // browser off `display.voice_*` — which is why there is no `browser`
          // surface to hand this lane in the first place.
          createLiveKitAdapter: buildAdapterFactory({
            ...media,
            createSession,
            laneKind: 'livekit',
          }),
          createSipAdapter: buildAdapterFactory({
            ...media,
            createSession,
            laneKind: 'sip',
            surface: 'call',
          }),
        }
      : {}),
    ...(sipTrunk ? { sipTrunk } : {}),
    ...(voice.trunk?.fromNumber ? { fromNumber: voice.trunk.fromNumber } : {}),
    inbound: buildInboundGates(voice.inbound),
    spans: spanWriter,
    close: () => spanWriter.close(),
  };

  if (livekitConfig && !deps.livekit) {
    deps.logger.warn(
      'voice: voice.livekit is configured but no LiveKit media binding was supplied — ' +
        'the LiveKit and SIP media transports are unavailable',
    );
  }
  if (voice.trunk && !sipTrunk) {
    // The only way to configure a trunk and get none: no `voice.livekit.*` to
    // build the SIP control plane from, and no explicit override either.
    deps.logger.warn(
      'voice: voice.trunk is configured but voice.livekit is not — the SIP control plane ' +
        'needs the LiveKit server URL and credentials; telephony is unavailable',
    );
  }

  return stack;
}

/**
 * The deployment's `SipTrunkClient`, derived from config alone.
 *
 * Exported because the `call` tool is composed BEFORE the voice stack is built
 * (`compose-tools` runs before `buildVoiceStack` in `build-agent-loop`), and
 * two derivations of "is telephony configured" is exactly how a tool ends up
 * advertised on a deployment that cannot dial. One function, both callers.
 *
 * Returns undefined when either half is missing — `voice.trunk.*` names the
 * trunk, `voice.livekit.*` carries the credentials the control plane signs with.
 */
export function resolveSipTrunkClient(config: WiringConfig): SipTrunkClient | undefined {
  const trunk = config.voice?.trunk;
  const livekit = config.voice?.livekit;
  if (!trunk || !livekit) return undefined;
  return createLiveKitSipTrunkClient({
    url: livekit.url,
    apiKey: livekit.apiKey,
    apiSecret: livekit.apiSecret,
    trunkId: trunk.trunkId,
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function providerConfigFrom(
  cfg:
    | {
        model?: string;
        apiKey?: string;
        baseUrl?: string;
        voice?: string;
        command?: string;
        outputFormat?: string;
        timeout?: number;
        maxTextLength?: number;
      }
    | undefined,
): Record<string, unknown> {
  if (!cfg) return {};
  return {
    ...(cfg.model !== undefined ? { model: cfg.model } : {}),
    ...(cfg.apiKey !== undefined ? { apiKey: cfg.apiKey } : {}),
    ...(cfg.baseUrl !== undefined ? { baseUrl: cfg.baseUrl } : {}),
    ...(cfg.voice !== undefined ? { voice: cfg.voice } : {}),
    ...(cfg.command !== undefined ? { command: cfg.command } : {}),
    ...(cfg.outputFormat !== undefined ? { outputFormat: cfg.outputFormat } : {}),
    ...(cfg.timeout !== undefined ? { timeout: cfg.timeout } : {}),
    ...(cfg.maxTextLength !== undefined ? { maxTextLength: cfg.maxTextLength } : {}),
  };
}

/**
 * Wrap a runner so every turn it drives carries `modelOverride`. The caller's
 * own per-turn options still win where they overlap on other keys; the pin does
 * not, because it is the lane's property and not the turn's.
 */
function pinRunnerModel(runner: AgentTurnRunner, modelOverride: string): AgentTurnRunner {
  return {
    run: (text, opts) => runner.run(text, { ...opts, modelOverride }),
  };
}

/** Memo key for "the default entry", which has no roster name of its own. */
const DEFAULT_ENTRY_MEMO_KEY = ' default';

function entryMemoKey(entryName: string | undefined): string {
  return entryName ?? DEFAULT_ENTRY_MEMO_KEY;
}

/** Simultaneous-call cap when `voice.inbound.concurrencyCap` is not configured. */
const DEFAULT_CONCURRENCY_CAP = 2;

type VoiceInboundSettings = NonNullable<WiringConfig['voice']>['inbound'];

function buildInboundGates(inbound: VoiceInboundSettings): VoiceInboundGates {
  return {
    concurrency: createCallConcurrencyLimiter({
      cap: inbound?.concurrencyCap ?? DEFAULT_CONCURRENCY_CAP,
    }),
    rateLimit: inbound?.perCallerPerHour
      ? createPerCallerRateLimiter({ perHour: inbound.perCallerPerHour })
      : undefined,
    budget: createVoiceDailyBudget(
      inbound?.dailyBudgetUsd !== undefined ? { limitUsd: inbound.dailyBudgetUsd } : {},
    ),
    allowlist: inbound?.allowlist,
    receptionist: inbound?.receptionist,
    prewarm: inbound?.prewarm ?? 'allowlisted',
    owner: inbound?.owner,
  };
}

/**
 * One per-call adapter factory, parameterised by lane kind.
 *
 * It constructs `LiveKitVoiceTransport` + `VoiceChannelAdapter` directly rather
 * than going through `createLiveKitTransport`: that factory's `createSession`
 * seam is synchronous (provider resolution is now per-personality and async)
 * and it forwards neither `laneKind` nor `onEnded`, both of which telephony
 * needs — `laneKind` is what keeps a PSTN leg's lane key distinct from the same
 * person's browser session, and `onEnded` is the post-call-summary trigger for
 * a caller who simply hangs up. One factory here, two lane kinds, so the
 * LiveKit and SIP paths cannot drift apart.
 */
function buildAdapterFactory(args: {
  createClient: () => LiveKitRoomClient;
  tokenMinter: LiveKitTokenMinter;
  url: string;
  createSession: (opts: CreateVoiceSessionOptions) => Promise<VoiceSession>;
  laneKind: VoiceLaneClientKind;
  /** The `voice.bargeIn.<surface>` block this lane kind is tuned by, if any. */
  surface?: VoiceBargeInSurface;
}): (opts: CreateVoiceAdapterOptions) => Promise<VoiceChannelAdapter> {
  return async (opts) => {
    const bot = opts.bot;
    // Same encoder, same botKey derivation as `VoiceChannelAdapter.laneKey`.
    // These two used to be hand-written and DISAGREED — the adapter hashed an
    // absent `bot.id` through `deriveBotKey`, this one interpolated the raw
    // `bot.match` — so the span a turn wrote and the lane it ran on named the
    // same call differently. One encoder is the fix.
    const session = await args.createSession({
      laneKey: voiceLaneKey(bot.id ?? deriveBotKey(bot.match), {
        kind: args.laneKind,
        id: opts.callerId,
      }),
      runner: opts.runner,
      ...(opts.personality ? { personality: opts.personality } : {}),
      ...(opts.language ? { language: opts.language } : {}),
      ...(opts.sessionConfig ? { sessionConfig: opts.sessionConfig } : {}),
      ...(args.surface ? { surface: args.surface } : {}),
    });
    const transport = new LiveKitVoiceTransport({
      client: args.createClient(),
      tokenMinter: args.tokenMinter,
      config: {
        url: args.url,
        roomName: opts.roomName,
        agentIdentity: opts.agentIdentity ?? 'ethos',
        callerId: opts.callerId,
      },
    });
    return new VoiceChannelAdapter({
      transport,
      session,
      bot,
      laneKind: args.laneKind,
      ...(opts.sendArtifact ? { sendArtifact: opts.sendArtifact } : {}),
      ...(opts.onEnded ? { onEnded: opts.onEnded } : {}),
    });
  };
}

const DISCARD_SINK: VoiceSpanSink = { write: () => {} };

/**
 * Map buffered voice spans onto the observability store. Called from the span
 * writer's flush — off the turn/audio path, which is the whole point: these
 * are synchronous SQLite writes.
 */
export function createObservabilitySpanSink(obs: EthosObservability): VoiceSpanSink {
  return {
    write(spans) {
      const byTurn = new Map<string, typeof spans>();
      for (const span of spans) {
        const group = byTurn.get(span.turnId);
        if (group) group.push(span);
        else byTurn.set(span.turnId, [span]);
      }
      for (const [turnId, group] of byTurn) {
        const first = group[0];
        if (!first) continue;
        const traceId = obs.startVoiceTurnTrace({
          ...(first.laneKey ? { sessionId: first.laneKey } : {}),
          attrs: {
            turnId,
            ...(first.sttProvider ? { sttProvider: first.sttProvider } : {}),
            ...(first.ttsProvider ? { ttsProvider: first.ttsProvider } : {}),
            // The hosted tier's own stamp. Dropping it here would have left the
            // realtime turn's trace saying only that SOME provider took 620 ms,
            // which is the half of the latency criterion that names a provider.
            ...(first.realtimeProvider ? { realtimeProvider: first.realtimeProvider } : {}),
          },
        });
        let worst: 'ok' | 'error' | 'aborted' = 'ok';
        for (const span of group) {
          const spanId = obs.startSpan({
            traceId,
            kind: 'voice_stage',
            name: span.stage,
            attrs: {
              turnId: span.turnId,
              durationMs: span.endTs - span.startTs,
              ...(span.sttProvider ? { sttProvider: span.sttProvider } : {}),
              ...(span.ttsProvider ? { ttsProvider: span.ttsProvider } : {}),
              ...(span.realtimeProvider ? { realtimeProvider: span.realtimeProvider } : {}),
              ...(span.error ? { error: span.error } : {}),
            },
          });
          obs.endSpan(spanId, span.status === 'ok' ? 'ok' : 'error');
          if (span.status === 'error') worst = 'error';
          else if (span.status === 'interrupted' && worst === 'ok') worst = 'aborted';
        }
        obs.endTrace(traceId, worst);
      }
    },
  };
}
