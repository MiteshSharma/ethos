import type { RealtimeEvent } from '@ethosagent/types';
import {
  createGeminiLiveCodec,
  createOpenAiRealtimeCodec,
  createRealtimeProtocolSession,
  openaiRealtimeBrowserSubprotocols,
  type RealtimeProtocolCodec,
  type RealtimeSocketFactory,
} from '@ethosagent/voice-realtime-protocol';
import { splitSentences } from '@ethosagent/voice-text';
import { pcm16FromBytes, pcm16ToBytes } from '@ethosagent/web-contracts';
import type { EndpointerEvent } from './pcm-endpointer';
import type { VoiceCaptureIo } from './streaming-voice-call-client';
import type { VoiceCallClient, VoiceCallEvent } from './voice-call-client';
import type { WakeLock } from './wake-lock';
import type { PlayoutSink } from './webaudio-playout';

// Talk-mode on the hosted realtime tier: the browser opens ONE duplex socket to
// the provider with a server-minted ephemeral token, and the provider owns VAD,
// the model turn, and the voice.
//
// WHY WEBSOCKET AND NOT WEBRTC. WebRTC is the transport the providers advertise
// first, and it is deliberately not used here. A WebRTC path forks the audio
// stack: the mic becomes a published track instead of `createBrowserVoiceCapture`,
// and playout becomes a remote `<audio>` element instead of `AbsolutePlayout`.
// That would mean re-implementing, on a second code path, the two things that
// took the most care to get right on the pipeline tier — barge-in (stop playout
// NOW, keep the honestly-played prefix) and absolute-timeline scheduling (every
// buffer starts where the previous one ended, so late frames cannot accumulate
// drift). A WebSocket carrying PCM16 reuses both wholesale, and the frame
// mapping is shared with the server providers via
// `@ethosagent/voice-realtime-protocol`. The cost is that we do not get the
// browser's jitter buffer and packet-loss concealment for free; the absolute
// playout scheduler is what stands in for it. If a future task needs WebRTC
// (a lossy mobile network is the realistic reason), it should ADD a transport
// behind this same `VoiceCallClient`, not convert this one.
//
// This client implements the existing `VoiceCallClient` unchanged, so
// `TalkModeCallBar`, `useVoiceCall` and `voiceCallReducer` do not know which
// tier is running.

/** `reply_audio` here is a provider announcement, not a carrier of samples. */
const EMPTY_AUDIO = new Uint8Array(0);

/** A minted session, exactly as `voice.realtimeToken` returns it. */
export interface RealtimeSessionTicket {
  /** Registered provider id (`openai-realtime`, …) — what the mono label names. */
  providerId: string;
  model: string | null;
  token: string;
  /** Absolute expiry, epoch ms. */
  expiresAt: number;
  url: string;
  inputSampleRate: number;
  outputSampleRate: number;
}

export interface RealtimeVoiceCallDeps {
  session: RealtimeSessionTicket;
  /** Mic capture, in `continuous` mode — the provider does the endpointing. */
  capture: VoiceCaptureIo;
  playout: PlayoutSink;
  /** Provider socket seam. Injected so the whole client tests with a fake. */
  socketFactory: RealtimeSocketFactory;
  wakeLock?: WakeLock;
  chime?: boolean;
}

/**
 * Thrown by `connect()` when the browser's audio clock cannot run at the rate
 * the provider requires. The caller degrades to the pipeline tier rather than
 * resampling — a resampler on the capture hot path is exactly what splitting
 * `inputSampleRate` from `outputSampleRate` removed.
 */
export class RealtimeSampleRateError extends Error {
  constructor(wanted: number, got: number) {
    super(
      `This browser captures at ${got} Hz and the realtime provider needs ${wanted} Hz. ` +
        'Continuing on the local pipeline.',
    );
    this.name = 'RealtimeSampleRateError';
  }
}

/** Which codec speaks this provider's wire, and how the credential travels. */
function codecFor(ticket: RealtimeSessionTicket): {
  codec: RealtimeProtocolCodec;
  subprotocols: string[];
} {
  if (ticket.providerId === 'gemini-live') {
    // Present for completeness only: `caps.ephemeralToken` is false for Gemini
    // Live, so the mint refuses before a ticket for it can exist. If that ever
    // changes, the codec is already here and the credential placement is the
    // only open question.
    return { codec: createGeminiLiveCodec(), subprotocols: [] };
  }
  return {
    codec: createOpenAiRealtimeCodec(),
    subprotocols: openaiRealtimeBrowserSubprotocols(ticket.token),
  };
}

export function createRealtimeVoiceCallClient(deps: RealtimeVoiceCallDeps): VoiceCallClient {
  const listeners = new Set<(event: VoiceCallEvent) => void>();
  const emit = (event: VoiceCallEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };

  const ticket = deps.session;
  let session: ReturnType<typeof createRealtimeProtocolSession> | null = null;
  let disposed = false;
  let pump: Promise<void> | null = null;
  let unsubscribe: (() => void) | null = null;

  /** Assistant text streamed since the current response began. */
  let replyText = '';
  /** Sentence tail not yet flushed as a `reply_sentence`. */
  let sentenceBuffer = '';
  /** True once this response has announced which provider is speaking. */
  let announced = false;
  /** True while the model has the floor — gates the interrupted/complete split. */
  let speaking = false;

  const resetResponse = (): void => {
    replyText = '';
    sentenceBuffer = '';
    announced = false;
    speaking = false;
  };

  const flushSentences = (final: boolean): void => {
    const { sentences, rest } = splitSentences(sentenceBuffer);
    sentenceBuffer = rest;
    for (const sentence of sentences) emit({ type: 'reply_sentence', text: sentence });
    if (!final) return;
    const tail = sentenceBuffer.trim();
    sentenceBuffer = '';
    if (tail) emit({ type: 'reply_sentence', text: tail });
  };

  /**
   * Barge-in. The provider's VAD heard the user over the model, so playout stops
   * immediately and the model is told to stop generating.
   *
   * `text` is what the model had SAID so far, which on this tier is the honest
   * answer available: the provider streams its transcript ahead of the audio it
   * belongs to and gives no per-word playout mapping, so a line may carry a few
   * words the user did not quite hear before the cut. The pipeline tier can be
   * exact because it schedules audio per sentence and knows when each one ended;
   * this tier cannot, and inventing a truncation point would be a guess printed
   * as a fact. The line still lands in the transcript marked `[interrupted]`,
   * which is the behaviour the A0 regression pin fixes for the pipeline tier.
   */
  const onSpeechStarted = (): void => {
    if (!speaking) return;
    deps.playout.stop();
    void session?.interrupt().catch(() => {
      // The socket is already gone; the `closed` event is what the UI acts on.
    });
    flushSentences(true);
    const spoken = replyText.trim();
    resetResponse();
    emit({ type: 'interrupted', text: spoken });
  };

  const onEvent = (event: RealtimeEvent): void => {
    if (disposed) return;
    switch (event.type) {
      case 'session_open':
        emit({ type: 'link', status: 'open' });
        return;

      case 'transcript':
        if (event.role === 'user') {
          // Only the settled user transcript commits a turn: partials churn and
          // the reducer treats each one as "the user finished speaking".
          if (event.isFinal && event.text.trim()) {
            emit({
              type: 'utterance_committed',
              text: event.text.trim(),
              provider: ticket.providerId,
            });
          }
          return;
        }
        speaking = true;
        if (event.isFinal) {
          // The settled assistant text is authoritative — it replaces the
          // deltas rather than appending to them.
          replyText = event.text.trim() || replyText.trim();
          sentenceBuffer = '';
          return;
        }
        replyText += event.text;
        sentenceBuffer += event.text;
        flushSentences(false);
        return;

      case 'audio': {
        speaking = true;
        if (!announced) {
          announced = true;
          // Announce WHICH provider is speaking once per response, not per
          // frame: audio arrives far faster than any UI needs to re-render.
          emit({
            type: 'reply_audio',
            audio: EMPTY_AUDIO,
            format: 'pcm',
            provider: ticket.providerId,
          });
        }
        deps.playout.playPcm16(pcm16FromBytes(event.pcm), event.sampleRate);
        return;
      }

      case 'speech_started':
        onSpeechStarted();
        return;

      case 'response_done': {
        flushSentences(true);
        const spoken = replyText.trim();
        resetResponse();
        if (spoken) emit({ type: 'reply_complete', text: spoken });
        return;
      }

      case 'tool_call':
        // Nothing is advertised to the session yet, so the model has nothing to
        // call. `agent_consult` and its filler arrive with B5; until then a tool
        // call is a can't-happen and answering it with an invented result would
        // be worse than leaving it unanswered.
        return;

      case 'error':
        emit({ type: 'error', error: event.error, code: event.code, provider: ticket.providerId });
        return;

      case 'closed':
        emit({ type: 'disconnected' });
        return;
    }
  };

  const onCaptureEvent = (event: EndpointerEvent): void => {
    if (disposed || event.type !== 'frame') return;
    void session?.sendAudio(pcm16ToBytes(event.data)).catch(() => {
      // A closed socket surfaces as the `closed` event; a per-frame error box
      // would bury it under hundreds of duplicates.
    });
  };

  /** Release everything this client owns. Idempotent; safe from `connect()`. */
  const teardown = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    unsubscribe?.();
    unsubscribe = null;
    deps.playout.stop();
    await session?.close();
    session = null;
    await pump?.catch(() => {});
    pump = null;
    void deps.wakeLock?.release();
    await deps.capture.stop();
  };

  return {
    async connect(): Promise<void> {
      disposed = false;
      resetResponse();
      const { codec, subprotocols } = codecFor(ticket);
      const live = createRealtimeProtocolSession({
        socketFactory: deps.socketFactory,
        init: {
          url: ticket.url,
          ...(subprotocols.length > 0 ? { subprotocols } : {}),
        },
        codec,
        // No handshake frame: the session's configuration was baked into the
        // ephemeral token when the server minted it.
      });
      emit({ type: 'link', status: 'connecting' });
      await live.connect();
      session = live;
      pump = (async () => {
        for await (const event of live.events) onEvent(event);
      })();

      await deps.capture.start();
      if (deps.capture.sampleRate !== ticket.inputSampleRate) {
        // Refuse rather than resample. Checked AFTER `start()` because a
        // browser reports the rate its audio graph actually got, which is not
        // always the one the context was asked for.
        await teardown();
        throw new RealtimeSampleRateError(ticket.inputSampleRate, deps.capture.sampleRate);
      }
      void deps.wakeLock?.acquire();
      unsubscribe = deps.capture.on(onCaptureEvent);
      // The session is live — say so out loud. First-run users get an audible
      // "go ahead" instead of guessing whether the mic is on.
      if (deps.chime !== false) {
        try {
          deps.capture.playEarcon();
        } catch {
          // Best-effort acknowledgement; never fails a connect.
        }
      }
    },

    disconnect(): Promise<void> {
      return teardown();
    },

    setMuted(muted: boolean): void {
      deps.capture.setMicEnabled(!muted);
    },

    micStream(): MediaStream | null {
      return deps.capture.micStream();
    },

    on(listener: (event: VoiceCallEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
