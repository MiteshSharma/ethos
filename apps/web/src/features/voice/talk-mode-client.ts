import {
  type BatchVoiceCallDeps,
  createBatchVoiceCallClient,
  type VoiceTuning,
} from './batch-voice-call-client';
import { createBrowserPlayout, createBrowserVoiceCapture } from './browser-streaming-io';
import { createBrowserRealtimeSocket } from './realtime-socket';
import {
  createRealtimeVoiceCallClient,
  type RealtimeSessionTicket,
} from './realtime-voice-call-client';
import { createStreamingVoiceCallClient } from './streaming-voice-call-client';
import type { VoiceCallClient, VoiceCallEvent } from './voice-call-client';
import { createVoiceSocketTransport, voiceSocketUrl } from './voice-socket-transport';
import { createWakeLock } from './wake-lock';

// Which talk-mode tier and transport a browser gets.
//
// Two TIERS, and inside the pipeline tier two transports:
//
//   realtime  one duplex WebSocket straight to a hosted speech-to-speech
//             provider, opened with a server-minted ephemeral token. The
//             provider owns VAD, the model turn and the voice.
//   pipeline  STT → the Ethos agent turn → TTS, over the binary PCM lane
//             (default) or the batch RPC path (fallback). This is also the
//             explicit private/offline mode: nothing about the conversation is
//             decided by a hosted realtime model.
//
// The tier is decided SERVER-side and reported by `voice.realtimeToken` — as a
// token, or as a typed reason why not. That keeps one authority over
// `voice.tier`, the realtime roster and the local-only egress gate, and leaves
// the browser with a single rule: a token means realtime, anything else means
// pipeline, and any reason that is not the configured preference is shown.

export interface TalkModeEnvironment {
  hasWebSocket: boolean;
  hasAudioContext: boolean;
  hasMediaDevices: boolean;
  hasScriptProcessor: boolean;
}

export function readTalkModeEnvironment(): TalkModeEnvironment {
  const audioContextCtor =
    typeof AudioContext !== 'undefined'
      ? AudioContext
      : (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext;
  return {
    hasWebSocket: typeof WebSocket !== 'undefined',
    hasAudioContext: typeof audioContextCtor !== 'undefined',
    hasMediaDevices:
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices?.getUserMedia === 'function',
    hasScriptProcessor:
      typeof AudioContext !== 'undefined' &&
      typeof AudioContext.prototype.createScriptProcessor === 'function',
  };
}

/** Every streaming piece must be present; one missing sends the call to batch. */
export function streamingTalkModeSupported(env: TalkModeEnvironment): boolean {
  return env.hasWebSocket && env.hasAudioContext && env.hasMediaDevices && env.hasScriptProcessor;
}

/**
 * The realtime tier needs everything the streaming pipeline tier needs — it
 * captures through the same PCM tap and plays out through the same absolute
 * scheduler. A browser that cannot stream cannot do realtime either.
 */
export function realtimeTalkModeSupported(env: TalkModeEnvironment): boolean {
  return streamingTalkModeSupported(env);
}

/**
 * Error code for "realtime was not available, so this call is on the pipeline".
 *
 * NOT one of the reducer's `DEGRADING_CODES`: voice still works, so the call
 * must not end. The reducer routes it to a dismissible inline notice that sits
 * above a live call strip.
 */
export const TIER_DEGRADED_CODE = 'realtime_unavailable';

/** What `voice.realtimeToken` answered. Mirrors the RPC's output union. */
export type RealtimeTokenAnswer =
  | ({ ok: true } & RealtimeSessionTicket)
  | { ok: false; reason: string; message: string; providerId: string | null };

/**
 * Reasons the user is NOT told about, because nothing went wrong: the
 * deployment (or the personality) asked for the pipeline, or there is no
 * realtime provider configured at all. Every other reason — a refused provider,
 * an unknown roster entry, a provider that cannot issue a browser credential —
 * is a downgrade the user gets told about, in the words the server chose.
 */
const SILENT_REFUSALS = new Set(['pipeline_preferred', 'not_configured']);

/**
 * What the user should be told about a realtime answer, or null for nothing.
 *
 * Pure and exported so the "never a silent downgrade" rule is a test rather
 * than a reading of the transport. The distinction it draws: a CONFIGURED
 * pipeline call is not a downgrade, and a REFUSED realtime call is — including
 * the Gemini Live case, whose provider is fine and simply cannot hand a browser
 * a credential.
 */
export function realtimeDegradeNotice(answer: RealtimeTokenAnswer): string | null {
  if (answer.ok) return null;
  return SILENT_REFUSALS.has(answer.reason) ? null : answer.message;
}

export interface TalkModeClientDeps extends BatchVoiceCallDeps {
  /** Chat session the call belongs to; stamped on the lane for telemetry. */
  sessionId?: () => string | null;
  /** Force the batch path (fallback verification, or a broken provider). */
  forceBatch?: boolean;
  /**
   * Take the local pipeline even when a realtime provider is available — the
   * user's explicit private/offline choice for this call. No token is minted,
   * so nothing about the conversation reaches a hosted realtime model.
   */
  forcePipeline?: boolean;
  /** Asks the server for a realtime credential. Absent → pipeline tier, silently. */
  mintRealtimeToken?: () => Promise<RealtimeTokenAnswer>;
  /** Told which tier actually ran, once known. Drives the strip's mono label. */
  onTier?: (tier: 'pipeline' | 'realtime', detail: { provider?: string; model?: string }) => void;
  /** Overridden in tests; defaults to the current page origin. */
  socketUrl?: string;
  environment?: TalkModeEnvironment;
}

export function createTalkModeClient(deps: TalkModeClientDeps): VoiceCallClient {
  const env = deps.environment ?? readTalkModeEnvironment();
  const listeners = new Set<(event: VoiceCallEvent) => void>();
  const emit = (event: VoiceCallEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };

  /** The tier client this call settled on. Chosen inside `connect()`. */
  let inner: VoiceCallClient | null = null;
  let unsubscribe: (() => void) | null = null;
  let muted = false;

  const adopt = (client: VoiceCallClient): void => {
    inner = client;
    unsubscribe = client.on(emit);
    // A mute toggled before the tier was decided still has to apply.
    if (muted) client.setMuted(true);
  };

  const buildPipelineClient = (): VoiceCallClient => {
    if (deps.forceBatch || !streamingTalkModeSupported(env)) {
      return createBatchVoiceCallClient(deps);
    }
    const context = new AudioContext();
    const tuning: Partial<VoiceTuning> = deps.tuning ?? {};
    const capture = createBrowserVoiceCapture({
      context,
      tuning,
      onDispose: () => context.close().catch(() => {}),
    });

    return createStreamingVoiceCallClient({
      transport: createVoiceSocketTransport({
        url: deps.socketUrl ?? voiceSocketUrl(window.location),
      }),
      capture,
      playout: createBrowserPlayout(context),
      runAgentTurn: deps.runAgentTurn,
      wakeLock: createWakeLock(),
      ...(deps.sessionId ? { sessionId: deps.sessionId } : {}),
      ...(deps.voice ? { voice: deps.voice } : {}),
      ...(deps.personalityId ? { personalityId: deps.personalityId } : {}),
      ...(deps.chime !== undefined ? { chime: deps.chime } : {}),
    });
  };

  const buildRealtimeClient = (ticket: RealtimeSessionTicket): VoiceCallClient => {
    // ONE context at the provider's INPUT rate: capture is then native, and
    // playout buffers declared at the output rate are resampled by WebAudio on
    // the way to the speakers — where a resample costs nothing that matters,
    // unlike on the captured-audio path.
    const context = new AudioContext({ sampleRate: ticket.inputSampleRate });
    const capture = createBrowserVoiceCapture({
      context,
      continuous: true,
      onDispose: () => context.close().catch(() => {}),
    });
    return createRealtimeVoiceCallClient({
      session: ticket,
      capture,
      playout: createBrowserPlayout(context),
      socketFactory: createBrowserRealtimeSocket,
      // The app's own voice socket, held open beside the provider's as this
      // call's CONTROL channel — the same transport the pipeline tier carries
      // audio on, minus the audio. It is where `agent_consult`, the transcript
      // and the approval surface live.
      control: createVoiceSocketTransport({
        url: deps.socketUrl ?? voiceSocketUrl(window.location),
      }),
      wakeLock: createWakeLock(),
      // A fresh credential when the provider socket drops and the one in hand
      // has expired. It is the SAME mint the call opened on, so a server that
      // has since stopped serving the realtime tier refuses the redial too and
      // the call degrades instead of dialling a tier nobody offered.
      ...(deps.mintRealtimeToken
        ? {
            mintTicket: async (): Promise<RealtimeSessionTicket | null> => {
              const answer = await deps.mintRealtimeToken?.();
              return answer?.ok ? answer : null;
            },
          }
        : {}),
      ...(deps.sessionId ? { chatSessionId: deps.sessionId } : {}),
      ...(deps.personalityId ? { personalityId: deps.personalityId } : {}),
      ...(deps.chime !== undefined ? { chime: deps.chime } : {}),
    });
  };

  const release = async (): Promise<void> => {
    unsubscribe?.();
    unsubscribe = null;
    const client = inner;
    inner = null;
    await client?.disconnect().catch(() => {});
  };

  /** Try realtime; return false (after any notice) to fall through to pipeline. */
  const tryRealtime = async (): Promise<boolean> => {
    if (deps.forcePipeline || deps.forceBatch || !deps.mintRealtimeToken) return false;
    if (!realtimeTalkModeSupported(env)) return false;

    let answer: RealtimeTokenAnswer;
    try {
      answer = await deps.mintRealtimeToken();
    } catch {
      // The mint call itself failed (offline, server restarting). The pipeline
      // tier may still work, so say so rather than failing the call.
      emit({
        type: 'error',
        error: 'Could not reach the realtime voice service; continuing on the local pipeline.',
        code: TIER_DEGRADED_CODE,
      });
      return false;
    }

    if (!answer.ok) {
      const notice = realtimeDegradeNotice(answer);
      if (notice) emit({ type: 'error', error: notice, code: TIER_DEGRADED_CODE });
      return false;
    }

    // Adopted BEFORE connecting: the session's own `link` and `session_open`
    // events fire during `connect()`, and a listener attached afterwards would
    // miss the moment the call actually went live.
    adopt(buildRealtimeClient(answer));
    try {
      await inner?.connect();
    } catch (err) {
      // Includes `RealtimeSampleRateError`: the provider is fine, this browser's
      // audio clock is not. Either way the honest move is the pipeline tier with
      // the reason on screen — never a dead mic.
      await release();
      emit({
        type: 'error',
        error:
          err instanceof Error && err.message ? err.message : 'Realtime voice failed to start.',
        code: TIER_DEGRADED_CODE,
      });
      return false;
    }
    deps.onTier?.('realtime', {
      provider: answer.providerId,
      ...(answer.model ? { model: answer.model } : {}),
    });
    return true;
  };

  return {
    async connect(): Promise<void> {
      if (await tryRealtime()) return;
      adopt(buildPipelineClient());
      deps.onTier?.('pipeline', {});
      await inner?.connect();
    },

    disconnect(): Promise<void> {
      return release();
    },

    setMuted(next: boolean): void {
      muted = next;
      inner?.setMuted(next);
    },

    micStream(): MediaStream | null {
      return inner?.micStream() ?? null;
    },

    // Whichever tier ended up serving. The batch fallback has no analyser, so
    // it reports nothing and the overlay draws at rest.
    outputLevel(): number {
      return inner?.outputLevel?.() ?? 0;
    },

    // Whichever tier ended up serving. The realtime tier has no `ask` — the
    // provider owns the turn and the floor there — so a clarify on it stays
    // card-only, which is what the null says.
    ask(question: string, signal: AbortSignal): Promise<string | null> {
      return inner?.ask?.(question, signal) ?? Promise.resolve(null);
    },

    on(listener: (event: VoiceCallEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
