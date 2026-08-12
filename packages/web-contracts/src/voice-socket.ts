import { z } from 'zod';

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

const HEADER_OFFSET = 3;

// --- client → server -------------------------------------------------------

const ClientHelloSchema = z.object({
  t: z.literal('hello'),
  /** Chat session this call belongs to. Telemetry/observability only. */
  sessionId: z.string().optional(),
});

const UtteranceStartSchema = z.object({
  t: z.literal('utterance_start'),
  utteranceId: z.string().min(1),
  /** Sample rate of the PCM frames that follow. */
  sampleRate: z.number().int().positive(),
  /** Personality listening; its `voice.stt_provider` picks the STT entry. The
   *  mirror of `personalityId` on `synthesize`. Absent → the default entry. */
  personalityId: z.string().optional(),
});

const ClientAudioSchema = z.object({
  t: z.literal('audio'),
  utteranceId: z.string().min(1),
  /** Monotonic per-utterance frame counter — gaps are visible, not silent. */
  seq: z.number().int().nonnegative(),
});

const UtteranceEndSchema = z.object({
  t: z.literal('utterance_end'),
  utteranceId: z.string().min(1),
});

const SynthesizeSchema = z.object({
  t: z.literal('synthesize'),
  /** The utterance this reply answers. Stale → the server never synthesizes. */
  utteranceId: z.string().min(1),
  /** Reply segment (one sentence), ordered by the client. */
  segmentId: z.string().min(1),
  text: z.string(),
  /** Global default voice from config — lowest precedence (see the RPC input). */
  voice: z.string().optional(),
  /** Personality speaking this segment; its `voice.tts_voice` beats `voice`. */
  personalityId: z.string().optional(),
  /** BCP-47 tag, selecting from the personality's language→voice map. */
  language: z.string().optional(),
});

const CancelSchema = z.object({
  t: z.literal('cancel'),
  utteranceId: z.string().min(1),
  reason: z.enum(['barge_in', 'hangup', 'superseded']),
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

const RealtimeEndSchema = z.object({
  t: z.literal('realtime_end'),
});

const VoiceClientFrameSchema = z.discriminatedUnion('t', [
  ClientHelloSchema,
  UtteranceStartSchema,
  ClientAudioSchema,
  UtteranceEndSchema,
  SynthesizeSchema,
  CancelSchema,
  RealtimeStartSchema,
  RealtimeToolCallSchema,
  RealtimeTranscriptSchema,
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
  utteranceId: z.string().min(1),
  text: z.string(),
  final: z.boolean(),
  /** The STT provider that actually ran. */
  provider: z.string().optional(),
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

const DroppedSchema = z.object({
  t: z.literal('dropped'),
  utteranceId: z.string().min(1),
  stage: z.enum(['capture', 'transcript', 'synthesis']),
  reason: z.enum(['superseded', 'cancelled', 'lane_closed', 'too_large']),
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

const VoiceServerFrameSchema = z.discriminatedUnion('t', [
  ReadySchema,
  TranscriptSchema,
  ServerAudioSchema,
  SegmentEndSchema,
  DroppedSchema,
  ServerErrorSchema,
  RealtimeReadySchema,
  RealtimeToolResultSchema,
  RealtimeSpeakSchema,
]);

export type VoiceServerFrame = z.infer<typeof VoiceServerFrameSchema>;

/** A decoded frame: its parsed header plus the binary payload that followed. */
export interface DecodedVoiceFrame<T> {
  header: T;
  payload: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Encode one frame. `payload` is empty for control frames. */
export function encodeVoiceFrame(
  header: VoiceClientFrame | VoiceServerFrame,
  payload?: Uint8Array,
): Uint8Array {
  const headerBytes = encoder.encode(JSON.stringify(header));
  if (headerBytes.length > 0xffff) {
    throw new Error('Voice frame header exceeds 64 KiB');
  }
  const body = payload ?? EMPTY;
  const out = new Uint8Array(HEADER_OFFSET + headerBytes.length + body.length);
  out[0] = VOICE_SOCKET_VERSION;
  out[1] = (headerBytes.length >> 8) & 0xff;
  out[2] = headerBytes.length & 0xff;
  out.set(headerBytes, HEADER_OFFSET);
  out.set(body, HEADER_OFFSET + headerBytes.length);
  return out;
}

const EMPTY = new Uint8Array(0);

function splitFrame(bytes: Uint8Array): { header: unknown; payload: Uint8Array } | null {
  if (bytes.length < HEADER_OFFSET) return null;
  if (bytes[0] !== VOICE_SOCKET_VERSION) return null;
  const headerLen = ((bytes[1] ?? 0) << 8) | (bytes[2] ?? 0);
  const headerEnd = HEADER_OFFSET + headerLen;
  if (bytes.length < headerEnd) return null;
  let header: unknown;
  try {
    header = JSON.parse(decoder.decode(bytes.subarray(HEADER_OFFSET, headerEnd)));
  } catch {
    return null;
  }
  return { header, payload: bytes.subarray(headerEnd) };
}

/**
 * Decode a frame sent by the browser. Returns null for anything that does not
 * match the contract — the header is untrusted input off a socket, so it is
 * parsed with Zod, never cast.
 */
export function decodeVoiceClientFrame(
  bytes: Uint8Array,
): DecodedVoiceFrame<VoiceClientFrame> | null {
  const split = splitFrame(bytes);
  if (!split) return null;
  const parsed = VoiceClientFrameSchema.safeParse(split.header);
  return parsed.success ? { header: parsed.data, payload: split.payload } : null;
}

/** Decode a frame sent by the server. Same untrusted-input posture. */
export function decodeVoiceServerFrame(
  bytes: Uint8Array,
): DecodedVoiceFrame<VoiceServerFrame> | null {
  const split = splitFrame(bytes);
  if (!split) return null;
  const parsed = VoiceServerFrameSchema.safeParse(split.header);
  return parsed.success ? { header: parsed.data, payload: split.payload } : null;
}

/**
 * Read a PCM payload as 16-bit samples. Copies: a WebSocket payload can land
 * at any byte offset in its backing buffer, and `new Int16Array(buf, offset)`
 * throws on an odd one. A trailing odd byte is dropped rather than throwing —
 * a truncated frame must not kill a live call.
 */
export function pcm16FromBytes(bytes: Uint8Array): Int16Array {
  const samples = new Int16Array(bytes.length >> 1);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = (((bytes[i * 2] ?? 0) | ((bytes[i * 2 + 1] ?? 0) << 8)) << 16) >> 16;
  }
  return samples;
}

/** Serialize 16-bit samples as little-endian payload bytes. */
export function pcm16ToBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] ?? 0;
    out[i * 2] = value & 0xff;
    out[i * 2 + 1] = (value >> 8) & 0xff;
  }
  return out;
}
