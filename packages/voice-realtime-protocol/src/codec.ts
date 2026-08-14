// The per-provider wire mapping, as a pure object.
//
// A realtime provider is two things: a wire vocabulary, and a session that owns
// a socket. The session half is identical for every provider (buffer audio
// until the handshake lands, emit exactly one terminal `closed`, never deliver
// after close) and lives in `./session-core`. The vocabulary half is all that
// actually differs, and it is THIS.
//
// Splitting them is what lets the browser speak a provider's protocol directly
// on the realtime tier without importing `ws` or a node builtin: the codec is
// data-in / data-out, so the SAME mapping serves the server-side session and
// the browser-direct one. The alternative — a second copy of the frame mapping
// in `apps/web` — is the failure this repo already paid for once with the
// speakable-text helpers (three drifted copies, deleted in V1a).

import type { RealtimeEvent } from '@ethosagent/types';

export interface RealtimeDecodeResult {
  /**
   * The provider confirmed the session with this frame. Flips the session out
   * of its buffering state; audio captured before it is held, not dropped.
   */
  ready: boolean;
  /** What this frame means on the contract. Empty for frames not on it. */
  events: RealtimeEvent[];
}

/**
 * One session's worth of wire mapping. Created per session because a provider
 * may need per-session state to honour the contract — Gemini Live streams
 * transcripts with no finality flag at all, so its codec accumulates them and
 * replays a settled transcript at `turnComplete`.
 */
export interface RealtimeProtocolCodec {
  /** Decode one inbound text frame. Never throws: a bad frame is an `error` event. */
  decode(raw: string): RealtimeDecodeResult;
  /** The frame carrying one chunk of captured PCM16 at `caps.inputSampleRate`. */
  encodeAudio(pcm: Uint8Array): unknown;
  /** The frame(s) answering a `tool_call`, in write order. */
  encodeToolResult(callId: string, output: string): unknown[];
  /**
   * The frame(s) cancelling in-flight speech, in write order. An empty array is
   * a legitimate answer: Gemini Live has already cancelled server-side by the
   * time the client hears about it, so there is nothing to write.
   */
  encodeInterrupt(): unknown[];
  /**
   * OPTIONAL — the frame(s) that speak `text` without a normal model turn.
   * A codec that cannot express it omits the method; the session then omits
   * `say()` entirely, which is what {@link RealtimeSession.say} being optional
   * is for.
   */
  encodeSay?(text: string): unknown[];
}

/** A codec plus the one frame that opens its session, when it has one. */
export interface RealtimeProtocolHandshake {
  codec: RealtimeProtocolCodec;
  /**
   * Frame written as soon as the transport opens. Absent means "write
   * nothing" — the browser-direct OpenAI path, where the session
   * configuration was baked into the ephemeral token at mint time.
   */
  handshake?: unknown;
}
