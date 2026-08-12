// Production construction of the real-time voice stack.
//
// Before this module, `VoiceSession`, `VoiceChannelAdapter`, the LiveKit/SIP
// transports and `config.voice.*` were all built, typed and unit-tested — and
// had zero construction sites. This is the wiring that makes them reachable.
//
// Two rules shape it:
//
//   1. Absent config is a clean no-op, never a crash. No `voice.*` block →
//      `buildVoiceStack` returns null and nothing downstream changes. LiveKit
//      and SIP construction additionally require their own config block AND an
//      app-supplied native binding (`@livekit/rtc-node` / `livekit-server-sdk`
//      are not repo dependencies), so a half-configured deployment degrades to
//      "that transport is unavailable" rather than throwing at boot.
//
//   2. Providers resolve through ONE path — `resolveSttProvider` /
//      `resolveTtsProvider` in `@ethosagent/core`, shared with the gateway and
//      web-api — so the provider id stamped into the latency spans is the
//      provider that actually ran, and the local-only egress gate cannot be
//      bypassed by constructing a provider some other way.

import {
  resolveSttProvider,
  resolveTtsProvider,
  resolveVoicePreferences,
  unwrapVoiceResolution,
} from '@ethosagent/core';
import type {
  LiveKitRoomClient,
  LiveKitTokenMinter,
  SipTrunkClient,
  VoiceArtifact,
  VoiceBotIdentity,
  VoiceChannelAdapter,
} from '@ethosagent/platform-voice';
import { createLiveKitTransport } from '@ethosagent/platform-voice';
import type {
  Logger,
  PersonalityConfig,
  SecretsResolver,
  SttProviderRegistry,
  TtsProviderRegistry,
} from '@ethosagent/types';
import type { AgentTurnRunner, VoiceSessionConfig, VoiceSpanSink } from '@ethosagent/voice-session';
import { BufferedVoiceSpanWriter, EnergyVad, VoiceSession } from '@ethosagent/voice-session';
import type { WiringConfig } from './index';
import type { EthosObservability } from './observability/ethos-observability';

/**
 * Native LiveKit bindings. Supplied by the app layer because the concrete SDKs
 * (`@livekit/rtc-node`, `livekit-server-sdk`) are not repo dependencies — the
 * seam stays pure and testable with fakes.
 */
export interface LiveKitBindings {
  createClient: () => LiveKitRoomClient;
  tokenMinter: LiveKitTokenMinter;
}

export interface BuildVoiceStackDeps {
  config: WiringConfig;
  sttProviders: SttProviderRegistry;
  ttsProviders: TtsProviderRegistry;
  secrets?: SecretsResolver;
  logger: Logger;
  /** Span destination. Omit to buffer into a discard sink (spans are dropped). */
  observability?: EthosObservability;
  /** Native LiveKit bindings; omit and the LiveKit transport is not built. */
  livekit?: LiveKitBindings;
  /** SIP trunk client; omit and inbound dispatch is not built. */
  trunk?: SipTrunkClient;
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
   */
  createSession(opts: CreateVoiceSessionOptions): VoiceSession;
  /**
   * Per-caller LiveKit adapter factory. Present only when `voice.livekit.*` is
   * configured AND native bindings were supplied.
   */
  createLiveKitAdapter?: (opts: {
    bot: VoiceBotIdentity;
    roomName: string;
    callerId: string;
    runner: AgentTurnRunner;
    agentIdentity?: string;
    sendArtifact?: (artifact: VoiceArtifact) => void | Promise<void>;
  }) => VoiceChannelAdapter;
  /** The configured SIP trunk. Present only when `voice.trunk.*` + a client are wired. */
  readonly sipTrunk?: SipTrunkClient;
  /** Caller-ID for outbound calls, from `voice.trunk.fromNumber`. */
  readonly fromNumber?: string;
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
  const sttResolution = await resolveSttProvider({
    registry: deps.sttProviders,
    providerName: asr?.provider,
    providerConfig: providerConfigFrom(asr),
    ...(deps.secrets ? { secrets: deps.secrets } : {}),
    logger: deps.logger,
    ...(trustedVoicePlugins ? { trustedVoicePlugins } : {}),
  });
  const ttsResolution = await resolveTtsProvider({
    registry: deps.ttsProviders,
    providerName: tts?.provider,
    providerConfig: providerConfigFrom(tts),
    ...(deps.secrets ? { secrets: deps.secrets } : {}),
    logger: deps.logger,
    ...(trustedVoicePlugins ? { trustedVoicePlugins } : {}),
  });

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

  const createSession = (opts: CreateVoiceSessionOptions): VoiceSession => {
    const stt = unwrapVoiceResolution(sttResolution);
    const speech = unwrapVoiceResolution(ttsResolution);
    // Personality voice > global `auxiliary.tts.voice`. Resolved through the
    // SAME function every other surface uses, so "which voice served this
    // turn" has one answer.
    const preferences = resolveVoicePreferences({
      ...(opts.personality?.voice ? { personality: opts.personality.voice } : {}),
      ...(tts?.voice ? { globalTtsVoice: tts.voice } : {}),
      ...(opts.language ? { language: opts.language } : {}),
    });
    return new VoiceSession({
      runner: opts.runner,
      // Batch-only providers get the utterance-buffered fallback inside
      // VoiceSession — WAV bytes in memory, no temp file, nothing to inject.
      stt: stt.provider,
      tts: speech.provider,
      vad: new EnergyVad(),
      spans: spanWriter,
      laneKey: opts.laneKey,
      logger: deps.logger,
      config: {
        ...(preferences.ttsVoice ? { ttsVoice: preferences.ttsVoice } : {}),
        ...opts.sessionConfig,
      },
    });
  };

  const stack: VoiceStack = {
    bots,
    sttProviderId: sttResolution.ok ? sttResolution.providerId : undefined,
    ttsProviderId: ttsResolution.ok ? ttsResolution.providerId : undefined,
    providerError: failures.length > 0 ? failures.join('; ') : undefined,
    trustedVoicePlugins,
    createSession,
    ...(voice.livekit && deps.livekit
      ? {
          createLiveKitAdapter: buildLiveKitAdapterFactory({
            livekit: deps.livekit,
            url: voice.livekit.url,
            createSession,
          }),
        }
      : {}),
    ...(voice.trunk && deps.trunk ? { sipTrunk: deps.trunk } : {}),
    ...(voice.trunk?.fromNumber ? { fromNumber: voice.trunk.fromNumber } : {}),
    close: () => spanWriter.close(),
  };

  if (voice.livekit && !deps.livekit) {
    deps.logger.warn(
      'voice: voice.livekit is configured but no LiveKit binding was supplied — the LiveKit transport is unavailable',
    );
  }
  if (voice.trunk && !deps.trunk) {
    deps.logger.warn(
      'voice: voice.trunk is configured but no SIP trunk client was supplied — telephony is unavailable',
    );
  }

  return stack;
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

function buildLiveKitAdapterFactory(args: {
  livekit: LiveKitBindings;
  url: string;
  createSession: (opts: CreateVoiceSessionOptions) => VoiceSession;
}): NonNullable<VoiceStack['createLiveKitAdapter']> {
  return (opts) => {
    const bot = opts.bot;
    const factory = createLiveKitTransport({
      createClient: args.livekit.createClient,
      tokenMinter: args.livekit.tokenMinter,
      room: {
        url: args.url,
        roomName: opts.roomName,
        agentIdentity: opts.agentIdentity ?? 'ethos',
      },
      bot,
      createSession: (callerId: string) =>
        args.createSession({
          laneKey: `voice:${bot.id ?? bot.match}:${callerId}`,
          runner: opts.runner,
        }),
      ...(opts.sendArtifact ? { sendArtifact: opts.sendArtifact } : {}),
    });
    return factory(opts.callerId);
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
