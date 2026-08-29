// SipRealtimeBridge — one phone call, wired to one hosted realtime session.
//
// This is the piece that makes a PSTN leg a conversation. The SIP side speaks
// 8 kHz narrowband, possibly companded; the provider side speaks linear PCM16
// at its own asymmetric rates and owns the VAD, the turn-taking and the tool
// calls. The bridge is the only thing between them, and it is deliberately the
// only thing: no VoiceSession, no STT, no TTS. On this tier the provider IS the
// pipeline (`packages/types/src/voice-realtime.ts`), and inserting our own
// would add a round trip to the one surface where latency is measured in how
// long a person is willing to hold a phone to their ear.
//
// EVERYTHING IS PER-BRIDGE. One call = one bridge = one session = one pacer =
// one transcript. There is no module-level state here at all, which is the
// umbrella plan's explicit invariant (OpenClaw #78523: process-global TTS state
// billed one caller's audio to another session). Two concurrent calls are two
// objects that cannot observe each other.
//
// THE WIRE CODEC IS A PROPERTY OF THE LEG, agreed between this bridge and its
// transport at construction. `OutboundAudioFrame.format` stays `'pcm'` even for
// a G.711 leg, because `AudioFormat` is a union shared across the whole repo
// and G.711 is not one of its members; widening it to describe one telephony
// leg would push a telephony concern into every surface that renders audio. A
// transport built for a `g711u` leg is constructed with the same codec and
// knows what its bytes are. Inbound, the same asymmetry: `VoiceTransport` has
// one inbound shape (`PcmChunk`), so a companded leg carries its wire bytes in
// that chunk's byte view rather than as samples.

import type {
  PcmChunk,
  RealtimeEvent,
  RealtimeSession,
  RealtimeSessionOptions,
  RealtimeVoiceProvider,
} from '@ethosagent/types';
import type { VoiceTransport } from '../transport';
import { createFramePacer, type FramePacer, type FramePacerTimer } from './frame-pacer';
import { aLawToPcm16, muLawToPcm16, pcm16ToALaw, pcm16ToMuLaw, resamplePcm16 } from './g711';

/**
 * How the SIP leg carries audio. Its OWN type, not `AudioFormat` — see the
 * header. `'pcm'` is the default because LiveKit's SIP service already
 * transcodes the PSTN leg to linear PCM before it reaches a room; the companded
 * variants are for a transport that carries the wire format straight through
 * (Twilio Media Streams).
 */
export type SipWireCodec = 'pcm' | 'g711u' | 'g711a';

/** One tool call as the realtime session issued it. */
export interface SipToolCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * Runs the session's tool calls.
 *
 * Structurally a `RealtimeToolHost.dispatch` (`@ethosagent/tools-voice`) with
 * its per-call `RealtimeDispatchContext` ALREADY BOUND, and declared here
 * rather than imported because `@ethosagent/tools-voice` already depends on
 * this package — the dependency cannot point back. Binding the context at the
 * app layer is also the honest split: the context carries `voiceOrigin`, and
 * only the app layer knows whether this call's speaker is the owner or a
 * stranger who dialled the number (`speaker: 'far_end'`). A bridge that
 * defaulted that field would be deciding, from inside a transport, who is
 * allowed to approve a tool.
 */
export interface SipToolDispatcher {
  dispatch(call: SipToolCall): Promise<{ ok: boolean; output: string }>;
}

/** Structured bridge events for logging/telemetry. Never spoken, never user-facing. */
export type SipBridgeEvent =
  | { type: 'session_open'; sessionId: string }
  | { type: 'connected'; callerId: string }
  /** The caller talked over the model; playout was dropped and the model cancelled. */
  | { type: 'barge_in' }
  | { type: 'audio_dropped'; reason: 'superseded' | 'not_connected'; bytes: number }
  | { type: 'tool_dispatched'; callId: string; name: string; ok: boolean; ms: number }
  /** A recoverable provider failure. Surfaced, never thrown — see `pump`. */
  | { type: 'provider_error'; error: string; code: string }
  | { type: 'closed'; reason: string };

export interface SipRealtimeBridgeDeps {
  provider: RealtimeVoiceProvider;
  /** Instructions, voice, model and tools. Sent once, at `prewarm()`. */
  sessionOptions: RealtimeSessionOptions;
  /** The SIP leg. */
  transport: VoiceTransport;
  toolHost: SipToolDispatcher;
  /** Wire format of the SIP leg. Default `'pcm'`. */
  codec?: SipWireCodec;
  /** Sample rate of the SIP leg. Default 8000 for `g711*`, 16000 for `pcm`. */
  wireSampleRate?: number;
  /** Frame size the leg is paced at, in ms. Default 20. */
  frameMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => FramePacerTimer;
  onEvent?: (event: SipBridgeEvent) => void;
}

export interface SipRealtimeBridge {
  /**
   * Open the provider socket WITHOUT the SIP leg — the pre-warm during ring.
   * Idempotent; `start()` reuses an already-warm session.
   */
  prewarm(): Promise<void>;
  /** Connect the SIP leg and pump both directions. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The conversation so far, assistant + user, for the post-call summary. */
  transcript(): string;
}

/** Answer given to the model when a tool throws. Spoken, so it is prose. */
const TOOL_FAILURE_TEXT = 'That did not finish.';

export function createSipRealtimeBridge(deps: SipRealtimeBridgeDeps): SipRealtimeBridge {
  const codec: SipWireCodec = deps.codec ?? 'pcm';
  const wireRate = deps.wireSampleRate ?? (codec === 'pcm' ? 16_000 : 8_000);
  const now = deps.now ?? Date.now;
  const onEvent = deps.onEvent;

  let session: RealtimeSession | null = null;
  let openPromise: Promise<RealtimeSession> | null = null;
  let unsubscribeAudio: (() => void) | null = null;
  let connected = false;
  let stopped = false;
  /** Settled transcript lines, both roles, in arrival order. */
  const lines: string[] = [];

  // --- utterance staleness -------------------------------------------------
  //
  // The `audio` event does NOT name the response it belongs to: only
  // `response_done` carries a `responseId`, and it arrives AFTER the audio it
  // closes. So the bridge keeps its own counter over the boundaries the
  // contract does give it. A barge-in supersedes whatever is speaking; audio
  // still tagged with that response is dropped rather than played over the
  // caller. The window closes at the next `response_done` OR the next
  // transcript event, whichever comes first.
  //
  // Closing on ANY transcript (not only the caller's) is deliberate and it is a
  // trade. Closing only on `response_done` would be tighter, and OpenAI
  // Realtime does close even a cancelled response — but Gemini Live does not,
  // so on that provider the window would never reopen and the agent would go
  // MUTE for the rest of the call. A little stale audio is a blemish; a mute
  // agent is a broken call. Both in-repo providers stream transcripts
  // continuously (the transcript contract requires it), so the window always
  // reopens within a few frames.
  let responseSeq = 0;
  let supersededSeq: number | null = null;
  /**
   * A provider that honours a cancel LATE has already pushed frames at us. The
   * first audio we accept after a barge-in therefore flushes the queue again
   * before it plays — belt and braces for the provider (Gemini) whose only
   * barge-in signal is its own after-the-fact `interrupted`.
   */
  let flushOnNextAudio = false;

  const report = (err: unknown, code: string): void => {
    onEvent?.({
      type: 'provider_error',
      error: err instanceof Error ? err.message : String(err),
      code,
    });
  };

  const pacer: FramePacer = createFramePacer({
    sampleRate: wireRate,
    ...(deps.frameMs !== undefined ? { frameMs: deps.frameMs } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
    emit: (frame: Int16Array): void => {
      if (!connected) return;
      deps.transport.sendAudio({ audio: encodeWire(frame, codec), format: 'pcm' });
    },
  });

  // --- provider -> phone ---------------------------------------------------

  const handleAudio = (event: Extract<RealtimeEvent, { type: 'audio' }>): void => {
    if (!connected) {
      onEvent?.({ type: 'audio_dropped', reason: 'not_connected', bytes: event.pcm.length });
      return;
    }
    if (supersededSeq === responseSeq) {
      onEvent?.({ type: 'audio_dropped', reason: 'superseded', bytes: event.pcm.length });
      return;
    }
    if (flushOnNextAudio) {
      flushOnNextAudio = false;
      pacer.cancel();
    }
    const fromRate = event.sampleRate > 0 ? event.sampleRate : deps.provider.caps.outputSampleRate;
    pacer.push(resamplePcm16(pcmBytesToSamples(event.pcm), fromRate, wireRate));
  };

  const handleBargeIn = (): void => {
    // THE ORDER IS THE BEHAVIOUR. Drop the queued playout FIRST, then tell the
    // provider to stop generating. Interrupting first leaves a full pacer queue
    // that goes on playing over the caller for as long as it holds — which is
    // precisely the thing the interrupt exists to stop.
    pacer.cancel();
    supersededSeq = responseSeq;
    flushOnNextAudio = true;
    onEvent?.({ type: 'barge_in' });
    void session?.interrupt().catch((err: unknown) => report(err, 'realtime_interrupt_failed'));
  };

  const dispatchTool = async (call: SipToolCall): Promise<void> => {
    const startedAt = now();
    let result: { ok: boolean; output: string };
    try {
      result = await deps.toolHost.dispatch(call);
    } catch (err) {
      report(err, 'realtime_tool_failed');
      result = { ok: false, output: TOOL_FAILURE_TEXT };
    }
    // ALWAYS answer, even on failure: a realtime session waits forever on an
    // unanswered tool call, and forever is what the caller hears.
    try {
      await session?.sendToolResult(call.callId, result.output);
    } catch (err) {
      report(err, 'realtime_tool_result_failed');
    }
    onEvent?.({
      type: 'tool_dispatched',
      callId: call.callId,
      name: call.name,
      ok: result.ok,
      ms: now() - startedAt,
    });
  };

  const handleEvent = (event: RealtimeEvent): void => {
    switch (event.type) {
      case 'session_open':
        onEvent?.({ type: 'session_open', sessionId: event.sessionId });
        return;
      case 'audio':
        handleAudio(event);
        return;
      case 'transcript':
        supersededSeq = null;
        if (event.isFinal && event.text.trim()) {
          lines.push(`${event.role}: ${event.text.trim()}`);
        }
        return;
      case 'tool_call':
        void dispatchTool({ callId: event.callId, name: event.name, args: event.args });
        return;
      case 'speech_started':
        handleBargeIn();
        return;
      case 'response_done':
        responseSeq += 1;
        return;
      case 'error':
        onEvent?.({ type: 'provider_error', error: event.error, code: event.code });
        return;
      case 'closed':
        onEvent?.({ type: 'closed', reason: event.reason });
        return;
      default:
        return;
    }
  };

  /**
   * Drain the provider's event stream for the life of the session.
   *
   * Nothing thrown in here escapes: this runs detached, and a provider socket
   * that drops mid-call would otherwise become an unhandled rejection that
   * takes down the gateway process hosting every OTHER live call.
   */
  const pump = async (live: RealtimeSession): Promise<void> => {
    try {
      for await (const event of live.events) handleEvent(event);
    } catch (err) {
      report(err, 'realtime_pump_failed');
    }
  };

  // --- phone -> provider ---------------------------------------------------

  const handleTransportAudio = (chunk: PcmChunk): void => {
    const live = session;
    if (!live || !connected) return;
    const samples = decodeWire(chunk, codec);
    const fromRate = codec === 'pcm' ? chunk.sampleRate : wireRate;
    const upsampled = resamplePcm16(samples, fromRate, deps.provider.caps.inputSampleRate);
    void live
      .sendAudio(samplesToPcmBytes(upsampled))
      .catch((err: unknown) => report(err, 'realtime_send_audio_failed'));
  };

  const ensureSession = (): Promise<RealtimeSession> => {
    if (!openPromise) {
      openPromise = deps.provider.open(deps.sessionOptions).then((live) => {
        session = live;
        // Detached on purpose — the pump outlives this call and is drained by
        // `stop()` closing the session, which ends the iterable.
        void pump(live);
        return live;
      });
    }
    return openPromise;
  };

  return {
    async prewarm(): Promise<void> {
      if (stopped) return;
      await ensureSession();
    },

    async start(): Promise<void> {
      if (stopped) return;
      // Reuses the warm session. Opening a second one here would throw away the
      // whole point of the pre-warm and bill for two sockets.
      await ensureSession();
      if (stopped) return;
      await deps.transport.connect();
      connected = true;
      unsubscribeAudio = deps.transport.onAudio(handleTransportAudio);
      onEvent?.({ type: 'connected', callerId: deps.transport.callerId });
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      pacer.stop();
      unsubscribeAudio?.();
      unsubscribeAudio = null;
      const live = session;
      session = null;
      if (live) {
        try {
          await live.close();
        } catch (err) {
          report(err, 'realtime_close_failed');
        }
      }
      if (connected) {
        connected = false;
        try {
          await deps.transport.disconnect();
        } catch (err) {
          report(err, 'transport_disconnect_failed');
        }
      }
    },

    transcript(): string {
      return lines.join('\n');
    },
  };
}

// --- wire helpers ----------------------------------------------------------

/**
 * The wire payload of one inbound frame. For a `pcm` leg `chunk.data` IS the
 * samples; for a companded leg the transport carries the encoded bytes in the
 * same buffer, because `VoiceTransport` has exactly one inbound shape and
 * `AudioFormat` deliberately does not name G.711 (see the file header).
 */
function decodeWire(chunk: PcmChunk, codec: SipWireCodec): Int16Array {
  if (codec === 'pcm') return chunk.data;
  const bytes = new Uint8Array(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
  return codec === 'g711u' ? muLawToPcm16(bytes) : aLawToPcm16(bytes);
}

function encodeWire(frame: Int16Array, codec: SipWireCodec): Uint8Array {
  if (codec === 'g711u') return pcm16ToMuLaw(frame);
  if (codec === 'g711a') return pcm16ToALaw(frame);
  return samplesToPcmBytes(frame);
}

/** Reinterpret little-endian PCM16 bytes as samples. A trailing odd byte is dropped. */
function pcmBytesToSamples(bytes: Uint8Array): Int16Array {
  const usable = bytes.length - (bytes.length % 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, usable);
  const out = new Int16Array(usable / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

function samplesToPcmBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] ?? 0, true);
  return bytes;
}
