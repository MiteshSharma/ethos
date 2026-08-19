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
  // A complete sentence of the reply was flushed to synthesis. `segmentId` is
  // minted here and is the SAME id stamped on every `reply_audio` chunk (and
  // the eventual `reply_segment_end`) that belongs to this sentence — the
  // source of truth for segment boundaries, because prefetch means a later
  // sentence's `reply_sentence`/first `reply_audio` can arrive before an
  // earlier sentence's audio has finished. A consumer must key off
  // `segmentId`, never off "whichever segment event arrived most recently".
  | { type: 'reply_sentence'; text: string; segmentId: string }
  // A chunk of synthesized audio is ready for playout. `segmentId` names
  // which enqueued item (sentence or filler) this chunk belongs to.
  | { type: 'reply_audio'; audio: Uint8Array; format: AudioFormat; segmentId: string }
  // A spoken filler ("one moment") was queued during a long tool run.
  | { type: 'filler'; text: string; segmentId: string }
  // This segment's audio has been fully delivered — either it finished
  // playing naturally, or barge-in cut it off (in which case this is the
  // ACTIVELY-PLAYING segment only, never a different, not-yet-started one).
  // A consumer with per-segment buffered audio (e.g. an encoded codec that
  // only decodes at this boundary) should treat this as "no more chunks are
  // coming for this segmentId", nothing more.
  | { type: 'reply_segment_end'; segmentId: string }
  // A non-speech keep-alive cue while a tool call is still in flight and no
  // reply text has resumed. Never synthesized — surfaces play a local asset.
  | { type: 'tick' }
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
   * Debounce (ms) before speaking a filler line during a tool call. Armed
   * only on the FIRST tool call of a turn that starts before any reply text
   * has appeared — a tool call that finishes inside this window never speaks
   * one. Omit/0 to disable. Default disabled.
   */
  fillerAfterMs?: number;
  /** Spoken filler text. Default 'One moment.'. */
  fillerText?: string;
  /**
   * While a tool call is still in flight, repeat a non-speech `tick` event at
   * this interval (ms) so the surface can play a short keep-alive cue.
   * Restarts on every tool-call gap, independent of whether the debounced
   * filler line fired. Omit/0 to disable. Default disabled.
   */
  tickIntervalMs?: number;
  /** Voice id forwarded to the TTS provider. */
  ttsVoice?: string;
  /** Speaking-rate multiplier forwarded to the TTS provider. */
  ttsSpeed?: number;
}
