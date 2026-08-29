// VoiceTransport — the transport-agnostic seam for one live audio session.
//
// The VoiceSession core is transport-agnostic (plan/phases/gap-voice-realtime.md
// §3(b)): it does not know whether audio arrives from a LiveKit WebRTC room, a
// Twilio Media Streams WebSocket (μ-law), or a browser mic. This interface is
// the only surface the channel adapter binds to; concrete transports (LiveKit,
// Twilio) implement it in later, isolated steps behind this seam.
//
// Keep it small and honest: inbound audio frames, an outbound audio sink, a
// caller identity, and connect/disconnect lifecycle — nothing transport-
// specific leaks through. Inbound audio is delivered via a push callback (the
// shape VoiceSession.pushAudio consumes and the model every other Ethos adapter
// already uses), not an AsyncIterable.

import type { PcmChunk } from '@ethosagent/types';
import type { AudioFormat } from '@ethosagent/voice-session';

/**
 * One frame of reply audio published to the participant. Matches the payload
 * of a VoiceSession `reply_audio` event so the adapter forwards it verbatim.
 */
export interface OutboundAudioFrame {
  audio: Uint8Array;
  format: AudioFormat;
}

export interface VoiceTransport {
  /**
   * Stable identity of the remote participant for this session — the LiveKit
   * participant identity for rooms, or the E.164 number for PSTN. Fixed for
   * the transport's lifetime (one transport = one participant/call) and used
   * to build the lane key `voice:<botKey>:<callerId>`.
   */
  readonly callerId: string;

  /** Establish the live audio session. Resolves once media can flow. */
  connect(): Promise<void>;

  /** Tear down the live audio session and release resources. */
  disconnect(): Promise<void>;

  /**
   * Subscribe to inbound audio frames from the participant, delivered as
   * `PcmChunk`s ready for the VoiceSession. Returns an unsubscribe function.
   */
  onAudio(handler: (chunk: PcmChunk) => void): () => void;

  /** Publish one frame of reply audio to the participant (outbound sink). */
  sendAudio(frame: OutboundAudioFrame): void;

  /**
   * Subscribe to remote teardown — the participant left, the caller hung up,
   * the room closed. Returns an unsubscribe function.
   *
   * OPTIONAL because not every transport can observe it: a browser mic knows
   * only what its owner tells it. A transport that omits this simply never
   * fires the adapter's remote-hangup path, and the call ends when someone
   * calls `stop()` — the behaviour every transport had before this existed.
   */
  onClosed?(handler: () => void): () => void;
}
