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
import { markInterrupted } from './voice-call-reducer';
import { VOICE_RECONNECT_BACKOFF_MS, type VoiceTransport } from './voice-socket-transport';
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
  /**
   * Mint a FRESH ticket for a mid-call redial, or null when the server will not
   * serve one. Absent → a redial can only reuse the ticket it already holds, so
   * a drop after the credential expired ends the call.
   *
   * The mint is the SERVER's decision every time: a browser that reconnected on
   * a refusal would be dialling a tier the server just declined to serve.
   */
  mintTicket?: () => Promise<RealtimeSessionTicket | null>;
  /** Provider-socket reconnect schedule. Test seam; defaults to the app lane's. */
  reconnectDelaysMs?: number[];
  schedule?: (fn: () => void, ms: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
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
 * Clock for the turn-latency span. MONOTONIC, not wall: `Date.now()` steps
 * backwards on an NTP correction mid-call, and a negative mouth-to-ear figure
 * is worse than none. `performance` is guarded for the same reason the batch
 * client guards it — a test or a non-browser host may not have one.
 */
const monotonicNow = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

/**
 * How much of a ticket's remaining life a redial needs in hand before it will
 * reuse it, rather than treating it as spent.
 *
 * A credential that expires during the handshake fails the redial AND burns one
 * of a small number of attempts, so the margin buys the round trip.
 */
const TICKET_REUSE_MARGIN_MS = 5_000;

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

  /** The credential this call is dialling on. Replaced by a redial's fresh mint. */
  let ticket = deps.session;
  let session: ReturnType<typeof createRealtimeProtocolSession> | null = null;
  let disposed = false;
  let pump: Promise<void> | null = null;
  let unsubscribe: (() => void) | null = null;
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancelSchedule =
    deps.cancelSchedule ?? ((handle: unknown) => clearTimeout(handle as never));

  /** Assistant text streamed since the current response began. */
  let replyText = '';
  /** Sentence tail not yet flushed as a `reply_sentence`. */
  let sentenceBuffer = '';
  /** True once this response has announced which provider is speaking. */
  let announced = false;
  /** True while the model has the floor — gates the interrupted/complete split. */
  let speaking = false;
  /**
   * True from a barge-in (or a dropped link) until the provider confirms the
   * cancelled response finished.
   *
   * `response.cancel` is a request, not a stop: the provider keeps streaming
   * transcript and audio for a few more frames. None of it was heard, and the
   * spoken prefix has ALREADY been written out marked `[interrupted]` — so
   * letting the tail through would caption words nobody heard and persist the
   * same turn a second time.
   */
  let cancelled = false;
  /**
   * Responses this client ASKED the provider to speak (consult filler) that have
   * not reported done yet.
   *
   * A filler is not the model's reply, even though the provider streams it back
   * through the same events: it was already captioned as `filler`, so echoing it
   * as `reply_sentence` / `reply_complete` would duplicate the line in the
   * transcript, persist "One moment." as an assistant turn, and drop the strip
   * out of `consulting` a few hundred ms after it entered — which is the whole
   * point of the state. The audio still plays; only the reply framing is
   * suppressed. A count, not a flag, because the lane repeats the filler while
   * a slow consult runs and two of them can overlap.
   */
  let fillerResponses = 0;
  /**
   * The turn whose first audio frame has not been reported yet: the id its span
   * is grouped by, and the monotonic reading taken at the user's speech-end
   * edge. Null between turns, and null again the moment the span is sent — that
   * null IS the once-per-turn guard.
   *
   * THE PAGE IS THE ONLY PLACE BOTH MOMENTS EXIST. On this tier the media
   * socket runs browser → provider, so the server never sees a frame of audio
   * and cannot time one; see `RealtimeTurnLatencySchema` in
   * `@ethosagent/web-contracts` for what the number does and does not cover.
   */
  let pendingTurn: { turnId: string; startedAt: number } | null = null;
  /** Turn ids are opaque to the server; this is the pipeline tier's id shape. */
  const turnIdPrefix = Math.random().toString(36).slice(2, 8);
  let turnCount = 0;
  /** Unsubscribe from the control channel's server frames. */
  let unsubscribeControl: (() => void) | null = null;
  /** Reconnect bookkeeping for the PROVIDER socket (the app lane owns its own). */
  let reconnectAttempt = 0;
  let reconnectHandle: unknown = null;
  let reconnecting = false;
  /** Set once a wind-down is in progress; the call ends when the line is done. */
  let windingDown = false;
  let windDownTimer: ReturnType<typeof setTimeout> | null = null;

  /** Send one control frame, when a control channel is wired. */
  const control = (frame: VoiceClientFrame): void => {
    deps.control?.send(frame);
  };

  /**
   * Report this turn's mouth-to-ear span — once, on the first audio frame of
   * the REPLY.
   *
   * "Of the reply" is doing work: a consult filler is audio the user hears
   * sooner, and timing to it would report a turn that answered in four seconds
   * as one that answered in three hundred milliseconds. So this sits inside the
   * announce-once guard, past the filler suppression, and measures the thing
   * the ≤800 ms budget is about. Telemetry only — an unreported turn costs its
   * span and nothing else, which is why every abandoned path just drops it.
   */
  const reportTurnLatency = (): void => {
    const turn = pendingTurn;
    if (!turn) return;
    pendingTurn = null;
    control({
      t: 'realtime_turn_latency',
      turnId: turn.turnId,
      firstAudioMs: monotonicNow() - turn.startedAt,
    });
  };

  const resetResponse = (): void => {
    replyText = '';
    sentenceBuffer = '';
    announced = false;
    speaking = false;
    cancelled = false;
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
   * End the model's turn early and KEEP what it managed to say.
   *
   * Shared by barge-in and a dropped provider socket, because both leave the
   * same facts on the table: playout has stopped, the words already spoken are
   * the honest record of the turn, and more frames of a turn nobody will hear
   * may still arrive.
   *
   * `text` is what the model had SAID so far, which on this tier is the honest
   * answer available: the provider streams its transcript ahead of the audio it
   * belongs to and gives no per-word playout mapping, so a line may carry a few
   * words the user did not quite hear before the cut. The pipeline tier can be
   * exact because it schedules audio per sentence and knows when each one ended;
   * this tier cannot, and inventing a truncation point would be a guess printed
   * as a fact.
   *
   * The line is WRITTEN TO SESSION HISTORY here, marked `[interrupted]` by the
   * one marker helper the chat projection uses — not left for `response_done`,
   * which by then has an empty `replyText` and would persist nothing. On a
   * conversational tier barge-in is the common case, so leaving it to the
   * completion path silently drops most of the assistant's history.
   */
  const abandonResponse = (): void => {
    flushSentences(true);
    const spoken = replyText.trim();
    // A filler line is already captioned and deliberately never persisted; it
    // must not turn into an interrupted assistant turn either.
    const wasFiller = fillerResponses > 0;
    resetResponse();
    // A turn cut short before its first audio frame has no mouth-to-ear figure
    // — the ear never got there. Reporting one later, off the next response,
    // would time a turn the user already interrupted.
    pendingTurn = null;
    cancelled = true;
    emit({ type: 'interrupted', text: spoken });
    if (spoken && !wasFiller) {
      control({ t: 'realtime_transcript', role: 'assistant', text: markInterrupted(spoken) });
    }
  };

  /**
   * Barge-in. The provider's VAD heard the user over the model, so playout stops
   * immediately and the model is told to stop generating.
   */
  const onSpeechStarted = (): void => {
    if (!speaking) return;
    deps.playout.stop();
    void session?.interrupt().catch(() => {
      // The socket is already gone; the `closed` event is what the UI acts on.
    });
    abandonResponse();
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
    // The sign-off is the server's line, not an answer to whatever was asked
    // last, so the turn still awaiting audio is dropped rather than timed
    // against it.
    pendingTurn = null;
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
        // The link is good again — the next drop gets the full schedule back.
        reconnecting = false;
        reconnectAttempt = 0;
        emit({ type: 'link', status: 'open' });
        return;

      case 'transcript':
        if (event.role === 'user') {
          // Only the settled user transcript commits a turn: partials churn and
          // the reducer treats each one as "the user finished speaking".
          if (event.isFinal && event.text.trim()) {
            // A new user turn ends any response still open from the last one.
            // The self-heal for a provider that never reports one done: left
            // stuck, either flag would mute every reply for the rest of the
            // call, which is a far worse failure than one leaked filler line.
            cancelled = false;
            fillerResponses = 0;
            // The user has stopped talking: this is where the span starts.
            // Stamped BEFORE the listeners run, so a slow UI render is not
            // counted as provider latency. A turn still waiting to be reported
            // is simply replaced — the newer turn is the one being timed.
            pendingTurn = { turnId: `${turnIdPrefix}-${++turnCount}`, startedAt: monotonicNow() };
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
        if (cancelled) return;
        speaking = true;
        // A line WE asked for is not the model's reply — see `fillerResponses`.
        // `speaking` is still set, so the user can talk over a filler.
        if (fillerResponses > 0) return;
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
        if (cancelled) return;
        speaking = true;
        // Played before the reply framing is decided: a consult filler is heard
        // exactly like any other line, it just is not reported as the answer.
        deps.playout.playPcm16(pcm16FromBytes(event.pcm), event.sampleRate);
        if (fillerResponses > 0) return;
        if (!announced) {
          announced = true;
          // First audio of the reply — the far end of the span the user's
          // speech-end edge opened.
          reportTurnLatency();
          // Announce WHICH provider is speaking once per response, not per
          // frame: audio arrives far faster than any UI needs to re-render.
          emit({
            type: 'reply_audio',
            audio: EMPTY_AUDIO,
            format: 'pcm',
            provider: ticket.providerId,
          });
        }
        return;
      }

      case 'speech_started':
        onSpeechStarted();
        return;

      case 'response_done': {
        // One response finished, whichever kind it was. Decremented first so a
        // filler that never reports done cannot mute the reply after it.
        if (fillerResponses > 0) fillerResponses -= 1;
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
        onProviderClosed();
        return;
    }
  };

  // --- provider-socket reconnect (DR1 "Reconnecting") ------------------------
  //
  // The headline use case is a phone browser in a car, where a blip is normal
  // and a call that dies on one is a call nobody trusts. The protocol package
  // deliberately does NOT reconnect (`packages/voice-realtime-protocol/src/
  // socket.ts`) — that is the right call there and the reason the policy lives
  // here: only the caller knows whether the CONVERSATION should continue.
  //
  // What a redial cannot restore is the provider's own memory of the call: the
  // new session starts blank. The continuity is the transcript this client has
  // been writing to the control lane all along, which is why the in-flight
  // reply is flushed to history before the retry rather than after it.

  /** Open a provider session on the current ticket and start pumping its events. */
  const openProviderSession = async (): Promise<void> => {
    resetResponse();
    fillerResponses = 0;
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
    await live.connect();
    session = live;
    pump = (async () => {
      for await (const event of live.events) onEvent(event);
    })();
  };

  /**
   * A credential for the redial.
   *
   * The ticket carries its own `expiresAt`, so "can this one be reused" is
   * answerable rather than guessed: inside its lifetime the same ephemeral
   * secret opens a new session, which is the fast path the blip needs. Past it
   * the secret is dead — a hosted provider's browser credential is short-lived
   * on purpose — and only the server can issue another, so with no mint seam
   * wired the honest move is to stop rather than retry a token that cannot work.
   */
  const nextTicket = async (): Promise<RealtimeSessionTicket | null> => {
    if (Date.now() + TICKET_REUSE_MARGIN_MS < ticket.expiresAt) return ticket;
    const mint = deps.mintTicket;
    if (!mint) return null;
    return await mint().catch(() => null);
  };

  /** Stop retrying and degrade to text, naming the provider that went quiet. */
  const giveUp = (message: string): void => {
    reconnecting = false;
    // `voice_unavailable` is the reducer's existing degrade code: the strip
    // collapses into one dismissible row and chat keeps working — the same
    // ending a failed STT or TTS gets, because it is the same ending.
    emit({
      type: 'error',
      error: message,
      code: 'voice_unavailable',
      provider: ticket.providerId,
    });
    void teardown().finally(() => emit({ type: 'disconnected' }));
  };

  /** Queue the next attempt. False when the schedule is spent — then we stop. */
  const scheduleReconnect = (): boolean => {
    if (disposed || windingDown) return false;
    const delays = deps.reconnectDelaysMs ?? VOICE_RECONNECT_BACKOFF_MS;
    const delay = delays[reconnectAttempt];
    // The app lane repeats its last delay forever; this one walks the schedule
    // ONCE. Each attempt spends an ephemeral credential and yields a provider
    // session with no memory of the conversation, so retrying indefinitely
    // holds a dead call on screen and keeps minting for it.
    if (delay === undefined) return false;
    reconnectAttempt += 1;
    if (!reconnecting) {
      reconnecting = true;
      emit({ type: 'link', status: 'reconnecting' });
    }
    reconnectHandle = schedule(() => {
      reconnectHandle = null;
      void redial();
    }, delay);
    return true;
  };

  const redial = async (): Promise<void> => {
    if (disposed) return;
    const next = await nextTicket();
    if (disposed) return;
    if (!next) {
      giveUp('The voice link dropped and could not be re-established. Continuing in text.');
      return;
    }
    if (next.inputSampleRate !== deps.capture.sampleRate) {
      // The mic graph was built for the old rate and cannot be rebuilt under a
      // live call — refusing beats resampling here for the same reason it does
      // at connect.
      giveUp('The realtime voice service came back at a rate this browser cannot capture.');
      return;
    }
    ticket = next;
    try {
      await openProviderSession();
    } catch {
      if (!scheduleReconnect()) {
        giveUp('The voice link dropped and could not be re-established. Continuing in text.');
      }
    }
  };

  /**
   * The provider socket went away without us closing it.
   *
   * A9's rule for the pipeline tier applies unchanged: the in-flight utterance
   * is DISCARDED and the call returns to a fresh listen. Mic frames captured
   * while the link is down go nowhere (`session` is null), and no partial
   * utterance is replayed into a session that never heard its beginning.
   */
  const onProviderClosed = (): void => {
    session = null;
    deps.playout.stop();
    if (speaking) abandonResponse();
    if (windingDown) {
      // The sign-off's socket closing IS the end of a call that was ending.
      endAfterWindDown();
      return;
    }
    if (!scheduleReconnect()) emit({ type: 'disconnected' });
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
        if (!say) return;
        // Counted BEFORE the write: the provider's echo of this line arrives on
        // the reply events and must not be mistaken for the model's answer.
        fillerResponses += 1;
        void say(frame.text).catch(() => {
          if (fillerResponses > 0) fillerResponses -= 1;
        });
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
    if (reconnectHandle !== null) {
      cancelSchedule(reconnectHandle);
      reconnectHandle = null;
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
      reconnectAttempt = 0;
      reconnecting = false;
      resetResponse();
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
      await openProviderSession();

      await deps.capture.start();
      if (deps.capture.sampleRate !== ticket.inputSampleRate) {
        // Refuse rather than resample. Checked AFTER `start()` because a
        // browser reports the rate its audio graph actually got, which is not
        // always the one the context was asked for.
        await teardown();
        throw new RealtimeSampleRateError(ticket.inputSampleRate, deps.capture.sampleRate);
      }
      // Declared AFTER the provider socket is up, because `canSay` is a
      // property of the codec that was chosen for it. Sent once per CALL, not
      // once per socket: a redial does not re-open the control lane's session,
      // and a second `realtime_start` would be ignored by it anyway.
      const chatSessionId = deps.chatSessionId?.();
      const personalityId = deps.personalityId;
      control({
        t: 'realtime_start',
        canSay: typeof session?.say === 'function',
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

    outputLevel(): number {
      return deps.playout.outputLevel();
    },

    on(listener: (event: VoiceCallEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
