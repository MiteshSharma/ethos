// Package-local types for the voice-session orchestrator.

import type { AgentEvent, PcmChunk } from '@ethosagent/types';

export type AudioFormat = 'opus' | 'mp3' | 'wav' | 'pcm';

/**
 * The line spoken when a turn goes quiet during a long tool run.
 *
 * Exported because it is not only this orchestrator's: the hosted-realtime
 * tier's consult filler (`RealtimeControlLane` in web-api) speaks the same
 * words, and two surfaces of one assistant saying different things while they
 * think is a seam the listener can hear.
 */
export const DEFAULT_VOICE_FILLER_TEXT = 'One moment.';

/**
 * Structural interface over the thing that drives one agent turn. The real
 * implementation is `AgentLoop.run()` from `@ethosagent/core`, but this
 * package depends only on the shape — dependency injection at construction
 * (Ethos's "injection at construction" principle) keeps voice-session free of
 * a hard core dependency and lets tests/harnesses inject a fake.
 */
export interface AgentTurnRunner {
  run(
    text: string,
    opts?: {
      abortSignal?: AbortSignal;
      /**
       * Route this turn to a named model. The voice stack pins the speaking
       * personality's fast-lane model here (latency decision L5) so a spoken
       * turn never runs on the agentic default. Absent → the runner routes as
       * it normally would.
       */
      modelOverride?: string;
    },
  ): AsyncGenerator<AgentEvent>;
}

/** Voice-activity detector: classifies a single audio frame as speech or not. */
export interface Vad {
  process(chunk: PcmChunk): { speech: boolean };
}

/** Lifecycle states of a live voice conversation. */
export type VoiceSessionState = 'idle' | 'listening' | 'thinking' | 'speaking';

/**
 * Events emitted by a {@link VoiceSession}. Forward-compatible: consumers must
 * treat unknown `type` values as a no-op.
 */
export type VoiceSessionEvent =
  // A committed utterance's transcript is ready and passed the hallucination
  // filter — the agent turn is about to run.
  | { type: 'utterance_committed'; text: string }
  // A complete sentence of the reply was flushed to synthesis.
  | { type: 'reply_sentence'; text: string }
  // A chunk of synthesized audio is ready for playout.
  | { type: 'reply_audio'; audio: Uint8Array; format: AudioFormat }
  // A spoken filler ("one moment") was queued during a long tool run.
  | { type: 'filler'; text: string }
  // Barge-in: the reply was interrupted. `text` is the honest reply — the
  // sentences actually played, plus a ` [interrupted]` marker.
  | { type: 'interrupted'; text: string }
  // The reply finished playing uninterrupted. `text` is the played reply.
  | { type: 'reply_complete'; text: string }
  // A recoverable error (synthesis failure, runner error) surfaced.
  | { type: 'error'; error: string; code?: string };

export interface VoiceSessionConfig {
  /** Trailing silence (ms) after speech that commits an utterance. Default 400. */
  endpointSilenceMs?: number;
  /**
   * If no `text_delta` arrives for this many ms during a turn (e.g. a long
   * tool run), speak a filler once. Omit/0 to disable. Default disabled.
   */
  fillerAfterMs?: number;
  /** Spoken filler text. Default 'One moment.'. */
  fillerText?: string;
  /** Voice id forwarded to the TTS provider. */
  ttsVoice?: string;
  /** Speaking-rate multiplier forwarded to the TTS provider. */
  ttsSpeed?: number;
}
