import { z } from 'zod';
import { encodeFrame, splitFrame } from './frame-codec';

// Wire format for the browser ↔ web-api voice lane: ONE persistent WebSocket
// carrying binary frames both directions (mic PCM up, synthesized audio down).
// It replaces the batch RPC pair (`voice.transcribe` / `voice.synthesize`),
// which base64'd audio into JSON and paid an HTTP round trip per utterance and
// per sentence (voice V1a, latency decision L3).
//
// Every frame is a BINARY WebSocket message with the same shape:
//
//   ┌────────┬──────────────┬─────────────────────┬──────────────────┐
//   │ ver:u8 │ headerLen:u16│ header (UTF-8 JSON) │ payload (bytes)  │
//   └────────┴──────────────┴─────────────────────┴──────────────────┘
//        0         1..2            3..3+len            3+len..end
//
// `headerLen` is big-endian. There are no text frames: a control message is a
// frame with an empty payload, so both sides have exactly one decode path.
//
// The layout itself lives in `frame-codec.ts` — the wake-satellite lane speaks
// the same one, and a wire contract that exists in two files drifts. This file
// owns what the HEADERS are allowed to say; the codec owns how bytes are cut.
//
// Why the header is self-describing rather than "audio bytes belong to
// whatever utterance is current": an in-flight result whose utterance was
// superseded by barge-in or by a newer utterance MUST be droppable, and that
// decision needs the id on the frame itself. Implicit binding is precisely the
// bug that plays a stale reply after the user has moved on.

/** Path the voice lane is mounted at, relative to the web-api origin. */
export const VOICE_SOCKET_PATH = '/voice/ws';

/** Framing version. Bump only for an incompatible layout change. */
export const VOICE_SOCKET_VERSION = 1;

/** MIME the mic lane sends: signed 16-bit little-endian PCM, mono. */
export const VOICE_PCM_MIME = 'audio/pcm;codec=s16le';

// Re-exported from their new home so every existing importer of the voice lane
// keeps resolving. Both lanes carry PCM, so the helpers moved to the codec.
export { pcm16FromBytes, pcm16ToBytes } from './frame-codec';

// --- client → server -------------------------------------------------------

const ClientHelloSchema = z.object({
  t: z.literal('hello'),
  /** Chat session this call belongs to. Telemetry/observability only. */
  sessionId: z.string().optional(),
  /** Personality speaking on this lane; picks its toolset, voice and STT/TTS
   *  roster entries. Absent → the deployment default. */
  personalityId: z.string().optional(),
  /**
   * Sample rate of the PCM frames the browser is about to stream. Absent means
   * this connection is not opening the pipeline audio path at all (e.g. a
   * realtime-tier-only control channel) — the server never asks for a session
   * and any `audio` frame that follows anyway is dropped.
   */
  sampleRate: z.number().int().positive().optional(),
});

/**
 * Continuous mic PCM. Unlike V1, the browser no longer buckets frames into a
 * client-decided utterance: the server's `VoiceSession` owns VAD, endpointing
 * and barge-in, so the mic streams unbroken from `hello` to disconnect and the
 * server decides what a turn is. `seq` is a monotonic per-connection frame
 * counter — gaps are visible, not silent — not an utterance id.
 */
const ClientAudioSchema = z.object({
  t: z.literal('audio'),
  seq: z.number().int().nonnegative(),
});

// --- realtime tier: the CONTROL channel -------------------------------------
//
// On the realtime tier the audio does NOT come through here. The browser holds
// a second socket straight to the hosted provider (that is the tier's whole
// latency argument) and keeps THIS one open beside it as a control channel.
//
// The split is the point. Media wants the shortest path to the provider;
// control wants the agent, the lane, the session history and the approval
// surface, all of which live server-side and none of which belong in a page.
// So the frames below carry the small, slow, consequential traffic — a tool
// call to service, a transcript to persist, a line to speak — and never a
// sample of audio.
//
// One connection is one talk session, so nothing here carries a session id:
// the lane is the socket. That is also what makes a second browser tab a second
// conversation rather than an interleaving of the first.

const RealtimeStartSchema = z.object({
  t: z.literal('realtime_start'),
  /** Chat session the call belongs to — the stable half of the lane key. */
  sessionId: z.string().optional(),
  /** Personality speaking; picks the toolset the session was minted with. */
  personalityId: z.string().optional(),
  /**
   * The provider socket can speak a line verbatim (`RealtimeSession.say`).
   * False → the server captions filler instead of asking for speech it knows
   * cannot be produced. Gemini Live is the false case.
   */
  canSay: z.boolean(),
});

const RealtimeToolCallSchema = z.object({
  t: z.literal('realtime_tool_call'),
  /** Provider-issued call id; the answer must carry it back unchanged. */
  callId: z.string().min(1),
  name: z.string().min(1),
  /** Model-authored arguments. Untrusted — the tool validates its own shape. */
  args: z.record(z.string(), z.unknown()),
});

const RealtimeTranscriptSchema = z.object({
  t: z.literal('realtime_transcript'),
  role: z.enum(['user', 'assistant']),
  /** FINAL text only. Partials churn and would write the same turn many times. */
  text: z.string().min(1),
});

/**
 * One completed realtime turn's mouth-to-ear latency, as measured in the page.
 *
 * THE PAGE MEASURES IT BECAUSE THE PAGE IS THE ONLY PLACE BOTH MOMENTS EXIST.
 * On this tier the media socket runs browser → provider; the server never sees
 * a frame of audio, so it cannot time one. The two moments that bracket the
 * number the ≤800 ms budget is about — the user stopping talking, and the first
 * audio frame of the reply — are both observed there and nowhere else. A server
 * that timed its own control frames instead would be timing a settled
 * transcript relayed over a second socket, and reporting it as mouth-to-ear
 * would be a number that omits the thing it claims to measure.
 *
 * `firstAudioMs` is therefore the WHOLE interval, endpointing included: the
 * provider owns the VAD and does not say when it decided, so its silence
 * window is inside this figure. That makes the reported value an UPPER bound on
 * mouth-to-ear, which is the right direction — a budget that only fails
 * pessimistically cannot flatter the tier. Splitting the provider's own leg out
 * needs a commit marker only the bench harness can see, so the split stays in
 * `scripts/voice-latency-bench.ts` rather than being guessed here.
 *
 * NOT measured, on either side: the browser's own capture and playout legs —
 * mic → first PCM frame, and provider audio → speaker. They are real user
 * latency and they are not in this number.
 *
 * Telemetry only. Nothing routes, bills or halts on it, which is why an absent
 * frame costs a turn its span and nothing else.
 */
const RealtimeTurnLatencySchema = z.object({
  t: z.literal('realtime_turn_latency'),
  /** Groups this turn's spans. Opaque; the server never parses it. */
  turnId: z.string().min(1),
  /** Milliseconds from the user's last speech frame to the reply's first audio frame. */
  firstAudioMs: z.number().nonnegative().finite(),
});

const RealtimeEndSchema = z.object({
  t: z.literal('realtime_end'),
});

const VoiceClientFrameSchema = z.discriminatedUnion('t', [
  ClientHelloSchema,
  ClientAudioSchema,
  RealtimeStartSchema,
  RealtimeToolCallSchema,
  RealtimeTranscriptSchema,
  RealtimeTurnLatencySchema,
  RealtimeEndSchema,
]);

export type VoiceClientFrame = z.infer<typeof VoiceClientFrameSchema>;

// --- server → client -------------------------------------------------------

const ReadySchema = z.object({
  t: z.literal('ready'),
  /** Per-connection id. Two browser tabs are two lanes with two ids. */
  laneId: z.string(),
  protocolVersion: z.number().int().positive(),
});

const TranscriptSchema = z.object({
  t: z.literal('transcript'),
  /** Minted server-side once `VoiceSession` commits an utterance (`u1`, `u2`, …). */
  utteranceId: z.string().min(1),
  text: z.string(),
  final: z.boolean(),
  /** The STT provider that actually ran. */
  provider: z.string().optional(),
});

/**
 * Text of one reply segment — a full sentence, or a spoken filler queued
 * during a long tool run — sent BEFORE that segment's `audio`/`segment_end`
 * frames so a caption can appear ahead of the sound. `segmentId` is minted
 * server-side and is what groups the `audio` frames that follow it.
 */
const ReplyTextSchema = z.object({
  t: z.literal('reply_text'),
  utteranceId: z.string().min(1),
  segmentId: z.string().min(1),
  text: z.string().min(1),
  kind: z.enum(['sentence', 'filler']),
});

/**
 * The turn is over — either it finished playing, or the user barged in.
 * `text` is the honest reply: the sentences actually played, unmodified on
 * `interrupted: false`, or with the trailing `[interrupted]` marker's source
 * text on `interrupted: true` (the marker itself is a render-time concern —
 * see `markInterrupted` on the web side).
 */
const TurnEndSchema = z.object({
  t: z.literal('turn_end'),
  utteranceId: z.string().min(1),
  text: z.string(),
  interrupted: z.boolean(),
});

const ServerAudioSchema = z.object({
  t: z.literal('audio'),
  utteranceId: z.string().min(1),
  segmentId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  /**
   * `pcm_s16le` — the payload is raw samples and can be scheduled the moment
   * it lands. `encoded` — the payload is a slice of a container (opus/mp3);
   * the client accumulates the segment and decodes it at `segment_end`, so
   * streaming is sentence-granular rather than frame-granular for providers
   * that only emit containers.
   */
  codec: z.enum(['pcm_s16le', 'encoded']),
  mimeType: z.string(),
  sampleRate: z.number().int().positive().optional(),
  channels: z.number().int().positive().optional(),
  /** The TTS provider that actually ran. */
  provider: z.string().optional(),
});

const SegmentEndSchema = z.object({
  t: z.literal('segment_end'),
  utteranceId: z.string().min(1),
  segmentId: z.string().min(1),
});

const ServerErrorSchema = z.object({
  t: z.literal('error'),
  message: z.string(),
  code: z.string(),
  utteranceId: z.string().optional(),
  /** The provider that failed, when the stage had one resolved. Lets a
   *  degraded-to-text notice name WHICH provider let the user down. */
  provider: z.string().optional(),
});

const RealtimeReadySchema = z.object({
  t: z.literal('realtime_ready'),
  /** The talk session's own lane. Opaque; surfaced for telemetry and tests. */
  laneKey: z.string().min(1),
  /**
   * Every tool name this control channel will service.
   *
   * Observability, not instruction: the session was already minted advertising
   * exactly these, and the browser does not re-derive anything from the list.
   * It is on the wire so a live call can be asked what it will actually answer
   * — the runtime companion to the advertised == handled test, and the frame
   * V4's call path reuses when it keeps its own copy of that test.
   */
  tools: z.array(z.string()),
});

const RealtimeToolResultSchema = z.object({
  t: z.literal('realtime_tool_result'),
  callId: z.string().min(1),
  ok: z.boolean(),
  /** Already sanitized for speech. Goes straight to `sendToolResult`. */
  output: z.string(),
});

const RealtimeSpeakSchema = z.object({
  t: z.literal('realtime_speak'),
  text: z.string().min(1),
  /** `ack` is the immediate "checking"; `filler` is the keep-alive after it. */
  kind: z.enum(['ack', 'filler']),
});

/**
 * The call has spent its budget: say this, then hang up.
 *
 * A separate frame from `realtime_speak` because it carries an INSTRUCTION as
 * well as a line. The browser owns the media socket on this tier, so the server
 * cannot close the call itself — it can only ask, and what it asks for is
 * ordered: speak the sign-off, let it finish, then end the call. A `realtime_speak`
 * followed by a socket drop would be a teardown mid-word, which is exactly the
 * failure this frame exists to avoid.
 *
 * `text` is spoken verbatim where the provider has a verbatim-speech frame and
 * captioned everywhere — the same degradation as the consult ack, for the same
 * reason: the listener must SEE why the call ended even on a provider that
 * cannot say it.
 */
const RealtimeWindDownSchema = z.object({
  t: z.literal('realtime_wind_down'),
  text: z.string().min(1),
  /** Why. One value today; a union so a second reason cannot be mistaken for this one. */
  reason: z.literal('budget'),
});

const VoiceServerFrameSchema = z.discriminatedUnion('t', [
  ReadySchema,
  TranscriptSchema,
  ReplyTextSchema,
  ServerAudioSchema,
  SegmentEndSchema,
  TurnEndSchema,
  ServerErrorSchema,
  RealtimeReadySchema,
  RealtimeToolResultSchema,
  RealtimeSpeakSchema,
  RealtimeWindDownSchema,
]);

export type VoiceServerFrame = z.infer<typeof VoiceServerFrameSchema>;

/** A decoded frame: its parsed header plus the binary payload that followed. */
export interface DecodedVoiceFrame<T> {
  header: T;
  payload: Uint8Array;
}

/** Encode one frame. `payload` is empty for control frames. */
export function encodeVoiceFrame(
  header: VoiceClientFrame | VoiceServerFrame,
  payload?: Uint8Array,
): Uint8Array {
  return encodeFrame(VOICE_SOCKET_VERSION, header, payload);
}

/**
 * Decode a frame sent by the browser. Returns null for anything that does not
 * match the contract — the header is untrusted input off a socket, so it is
 * parsed with Zod, never cast.
 */
export function decodeVoiceClientFrame(
  bytes: Uint8Array,
): DecodedVoiceFrame<VoiceClientFrame> | null {
  const split = splitFrame(VOICE_SOCKET_VERSION, bytes);
  if (!split.ok) return null;
  const parsed = VoiceClientFrameSchema.safeParse(split.header);
  return parsed.success ? { header: parsed.data, payload: split.payload } : null;
}

/** Decode a frame sent by the server. Same untrusted-input posture. */
export function decodeVoiceServerFrame(
  bytes: Uint8Array,
): DecodedVoiceFrame<VoiceServerFrame> | null {
  const split = splitFrame(VOICE_SOCKET_VERSION, bytes);
  if (!split.ok) return null;
  const parsed = VoiceServerFrameSchema.safeParse(split.header);
  return parsed.success ? { header: parsed.data, payload: split.payload } : null;
}
