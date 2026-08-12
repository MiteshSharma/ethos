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
import {
  pcm16FromBytes,
  pcm16ToBytes,
  type VoiceClientFrame,
  type VoiceServerFrame,
} from '@ethosagent/web-contracts';
import type { EndpointerEvent } from './pcm-endpointer';
import type { VoiceCaptureIo } from './streaming-voice-call-client';
import type { VoiceCallClient, VoiceCallEvent } from './voice-call-client';
import type { VoiceTransport } from './voice-socket-transport';
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
//
// TWO SOCKETS, ON PURPOSE. The provider socket above is the MEDIA channel. The
// app's own voice socket stays open beside it as the CONTROL channel, carrying
// the traffic that must not live in a page: a tool call to service, a settled
// transcript to persist, a line to speak while the agent works. The browser is
// a relay on that path and decides nothing — it does not run the tool, does not
// choose the words, does not know the lane key until the server names it. That
// is what keeps the agent, the approval surface and the session history
// server-side while the audio still takes one hop.

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
  /**
   * The app's voice socket, held open as this call's control channel. Absent →
   * the session runs with no tools (nothing was advertised to it either), which
   * is a legitimate degraded call rather than a broken one: the provider still
   * hears and answers, it just cannot reach the agent.
   */
  control?: VoiceTransport;
  /** Chat session the call belongs to — the stable half of the talk lane key. */
  chatSessionId?: () => string | null;
  /** Personality speaking; picks the toolset the control lane will service. */
  personalityId?: string;
  /** Mic capture, in `continuous` mode — the provider does the endpointing. */
  capture: VoiceCaptureIo;
  playout: PlayoutSink;
  /** Provider socket seam. Injected so the whole client tests with a fake. */
  socketFactory: RealtimeSocketFactory;
  wakeLock?: WakeLock;
  chime?: boolean;
  /**
   * How long the call is allowed to keep speaking after a wind-down before it
   * is ended anyway.
   *
   * The sign-off must not be cut mid-word, so the close waits for the provider
   * to report the response finished. This is the backstop for a provider that
   * never reports one — without it a budget-halted session would sit open on a
   * paid socket, which is the exact opposite of what a budget halt is for.
   */
  windDownGraceMs?: number;
}

/** Long enough for one spoken sentence, short enough that a stuck call still ends. */
const DEFAULT_WIND_DOWN_GRACE_MS = 6_000;

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
  /** Unsubscribe from the control channel's server frames. */
  let unsubscribeControl: (() => void) | null = null;
  /** Set once a wind-down is in progress; the call ends when the line is done. */
  let windingDown = false;
  let windDownTimer: ReturnType<typeof setTimeout> | null = null;

  /** Send one control frame, when a control channel is wired. */
  const control = (frame: VoiceClientFrame): void => {
    deps.control?.send(frame);
  };

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

  /** Whether the wind-down has already ended the call. Makes the close once-only. */
  let windDownEnded = false;

  /** End a winding-down call: the line has been said (or the grace ran out). */
  const endAfterWindDown = (): void => {
    if (windDownTimer !== null) {
      clearTimeout(windDownTimer);
      windDownTimer = null;
    }
    if (windDownEnded) return;
    windDownEnded = true;
    // `disconnected` AFTER teardown, so the UI's terminal state and the released
    // mic land together rather than the strip ending on a still-open socket.
    void teardown().finally(() => emit({ type: 'disconnected' }));
  };

  /**
   * The budget wind-down (plan DR1 "★ Budget wind-down"). The server has spent
   * this call's budget and asked for one sentence and a clean close.
   *
   * The order is the point: caption, speak, then close when the speaking is
   * DONE. Closing on receipt would cut the sentence mid-word, which is the
   * dropped stream the criterion forbids; on a provider that cannot speak a
   * line verbatim there is nothing to wait for, so the call ends immediately
   * with the sentence captioned.
   */
  const beginWindDown = (text: string): void => {
    if (windingDown || disposed) return;
    windingDown = true;
    emit({ type: 'budget_wind_down', text });
    // Stop capturing now: every further second of mic is a second billed to a
    // call that is already over, and nothing said into it will be answered.
    deps.capture.setMicEnabled(false);
    const say = session?.say?.bind(session);
    if (!say) {
      endAfterWindDown();
      return;
    }
    void say(text).catch(() => endAfterWindDown());
    windDownTimer = setTimeout(
      endAfterWindDown,
      deps.windDownGraceMs ?? DEFAULT_WIND_DOWN_GRACE_MS,
    );
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
            // The settled transcript IS this call's text history. Sent final
            // only: partials churn, and each one would write the same turn
            // again.
            control({ t: 'realtime_transcript', role: 'user', text: event.text.trim() });
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
        if (spoken) {
          emit({ type: 'reply_complete', text: spoken });
          control({ t: 'realtime_transcript', role: 'assistant', text: spoken });
        }
        // The sign-off has finished playing — this is the clean close.
        if (windingDown) endAfterWindDown();
        return;
      }

      case 'tool_call':
        // Relayed verbatim. The browser does not run tools and does not decide
        // which ones exist — the server advertised the list at mint and answers
        // with `realtime_tool_result` on the same `callId`. With no control
        // channel there is nothing to relay to; the session was minted with no
        // tools in that case, so this is unreachable rather than dropped.
        control({
          t: 'realtime_tool_call',
          callId: event.callId,
          name: event.name,
          args: event.args,
        });
        return;

      case 'error':
        emit({ type: 'error', error: event.error, code: event.code, provider: ticket.providerId });
        return;

      case 'closed':
        emit({ type: 'disconnected' });
        return;
    }
  };

  /**
   * Server frames on the control channel.
   *
   * `realtime_speak` is the consult filler. It is spoken through the provider
   * when the wire has a verbatim-speech frame, and ALWAYS captioned — a
   * provider without one (Gemini Live) still shows the listener that a check is
   * in progress, and the boundary policy covers the audible half by telling the
   * model to announce the check itself before it calls the tool.
   */
  const onControlFrame = (frame: VoiceServerFrame): void => {
    if (disposed) return;
    switch (frame.t) {
      case 'realtime_tool_result':
        void session?.sendToolResult(frame.callId, frame.output).catch(() => {
          // The socket is gone; the `closed` event is what the UI acts on.
        });
        return;
      case 'realtime_speak': {
        emit({ type: 'filler', text: frame.text });
        const say = session?.say?.bind(session);
        void say?.(frame.text).catch(() => {});
        return;
      }
      case 'realtime_wind_down':
        beginWindDown(frame.text);
        return;
      default:
        // Every other server frame belongs to the pipeline tier's audio lane.
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
    if (windDownTimer !== null) {
      clearTimeout(windDownTimer);
      windDownTimer = null;
    }
    unsubscribe?.();
    unsubscribe = null;
    // Tell the control lane the call is over BEFORE the socket goes: it aborts
    // an in-flight consult rather than finishing an agent turn nobody will hear.
    control({ t: 'realtime_end' });
    unsubscribeControl?.();
    unsubscribeControl = null;
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
      if (deps.control) {
        unsubscribeControl = deps.control.on(onControlFrame);
        await deps.control.connect().catch(() => {
          // A control channel that will not open costs the call its tools, not
          // the call. The session was still minted advertising them, so the
          // model may offer one — which is why the failure is surfaced.
          emit({
            type: 'error',
            error:
              'Could not reach the assistant; this call can hear you but cannot look things up.',
            code: 'realtime_control_unavailable',
            provider: ticket.providerId,
          });
        });
      }
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
      // Declared AFTER the provider socket is up, because `canSay` is a
      // property of the codec that was chosen for it.
      const chatSessionId = deps.chatSessionId?.();
      const personalityId = deps.personalityId;
      control({
        t: 'realtime_start',
        canSay: typeof live.say === 'function',
        ...(chatSessionId ? { sessionId: chatSessionId } : {}),
        ...(personalityId ? { personalityId } : {}),
      });
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
