import type { PcmChunk } from '@ethosagent/types';
import { encodeWav } from '@ethosagent/voice-session';
import {
  pcm16FromBytes,
  VOICE_SOCKET_VERSION,
  type VoiceClientFrame,
  type VoiceServerFrame,
} from '@ethosagent/web-contracts';

// One browser voice call, server-side. A lane owns EXACTLY one WebSocket
// connection and nothing outside it: every piece of state below is an instance
// field, so two concurrent callers are two `VoiceLane` objects that cannot
// observe each other. There is no module-level map keyed by utterance or
// session id — that shape is how one caller's private audio ends up in another
// caller's stream (voice V1a failure-mode criteria, "no process-global voice
// state").
//
// The lane is transport-free on purpose: it takes `send` and is fed decoded
// frames, so the conversation protocol is unit-testable without a socket.

/** Provider seams the lane drives. Both are per-call, both are abortable. */
export interface VoiceLaneDeps {
  /** Transcribe one complete utterance (WAV bytes) → text + provider that ran. */
  transcribe(
    audio: { data: Uint8Array; mimeType: string },
    signal: AbortSignal,
  ): Promise<{ text: string; provider: string }>;
  /** Stream one reply segment's audio. */
  synthesize(
    text: string,
    opts: { voice?: string; personalityId?: string; language?: string; signal: AbortSignal },
  ): AsyncIterable<{ audio: Uint8Array; format: 'opus' | 'mp3' | 'wav' | 'pcm'; provider: string }>;
}

export interface VoiceLaneLimits {
  /** Cap on captured audio per utterance. Beyond it the utterance is dropped. */
  maxUtteranceBytes: number;
  /** How many utterances a lane remembers. Older ones count as superseded. */
  maxTrackedUtterances: number;
}

export const DEFAULT_VOICE_LANE_LIMITS: VoiceLaneLimits = {
  // ~4 minutes of 16 kHz mono PCM. Long enough for any real utterance, small
  // enough that a stuck or hostile client cannot grow the heap without bound.
  maxUtteranceBytes: 8 * 1024 * 1024,
  maxTrackedUtterances: 8,
};

export interface VoiceLaneOptions {
  laneId: string;
  deps: VoiceLaneDeps;
  /** Deliver one frame to THIS lane's socket. */
  send(frame: VoiceServerFrame, payload?: Uint8Array): void;
  limits?: Partial<VoiceLaneLimits>;
  /** Structured lane events for logging/telemetry. Never user-facing. */
  onEvent?: (event: VoiceLaneEvent) => void;
}

export type VoiceLaneEvent =
  | { type: 'utterance_superseded'; utteranceId: string; reason: string }
  | { type: 'transcribed'; utteranceId: string; provider: string; ms: number }
  | { type: 'synthesized'; utteranceId: string; segmentId: string; provider: string; ms: number };

const MIME_BY_FORMAT: Record<string, string> = {
  opus: 'audio/ogg;codecs=opus',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
};

interface UtteranceState {
  id: string;
  sampleRate: number;
  chunks: PcmChunk[];
  bytes: number;
  controller: AbortController;
  /** Superseded by barge-in, a newer utterance, or eviction. Results are dropped. */
  superseded: boolean;
  /** Serializes this utterance's synthesis so reply segments stay in order. */
  synthChain: Promise<void>;
}

export class VoiceLane {
  private readonly opts: VoiceLaneOptions;
  private readonly limits: VoiceLaneLimits;
  /** Per-LANE utterance state. Insertion-ordered; oldest evicted first. */
  private readonly utterances = new Map<string, UtteranceState>();
  private activeUtteranceId: string | null = null;
  private closed = false;

  constructor(opts: VoiceLaneOptions) {
    this.opts = opts;
    this.limits = { ...DEFAULT_VOICE_LANE_LIMITS, ...opts.limits };
  }

  /** The utterance whose results the client is still willing to play. */
  get activeUtterance(): string | null {
    return this.activeUtteranceId;
  }

  handle(frame: VoiceClientFrame, payload: Uint8Array): void {
    if (this.closed) return;
    switch (frame.t) {
      case 'hello':
        this.opts.send({
          t: 'ready',
          laneId: this.opts.laneId,
          protocolVersion: VOICE_SOCKET_VERSION,
        });
        return;
      case 'utterance_start':
        this.startUtterance(frame.utteranceId, frame.sampleRate);
        return;
      case 'audio':
        this.appendAudio(frame.utteranceId, payload);
        return;
      case 'utterance_end':
        void this.finishUtterance(frame.utteranceId);
        return;
      case 'synthesize':
        this.queueSynthesis(frame);
        return;
      case 'cancel':
        this.supersede(
          frame.utteranceId,
          frame.reason === 'barge_in' || frame.reason === 'hangup' ? 'cancelled' : 'superseded',
          'capture',
        );
        return;
    }
  }

  /** Socket closed. Abort everything in flight; keep no audio around. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.utterances.values()) {
      state.superseded = true;
      state.chunks = [];
      state.controller.abort();
    }
    this.utterances.clear();
    this.activeUtteranceId = null;
  }

  private startUtterance(id: string, sampleRate: number): void {
    // A new utterance supersedes every older one: the user moved on, so any
    // transcript or audio still in flight for a previous utterance is stale
    // and must never reach the client.
    for (const previous of this.utterances.keys()) {
      if (previous !== id) this.supersede(previous, 'superseded', 'capture');
    }
    const existing = this.utterances.get(id);
    if (existing) existing.controller.abort();
    this.utterances.set(id, {
      id,
      sampleRate,
      chunks: [],
      bytes: 0,
      controller: new AbortController(),
      superseded: false,
      synthChain: Promise.resolve(),
    });
    this.activeUtteranceId = id;
    this.evictOverflow();
  }

  private appendAudio(id: string, payload: Uint8Array): void {
    const state = this.utterances.get(id);
    if (!state || state.superseded) return;
    if (state.bytes + payload.length > this.limits.maxUtteranceBytes) {
      this.supersede(id, 'too_large', 'capture');
      this.opts.send({
        t: 'error',
        code: 'utterance_too_long',
        message: 'Utterance exceeded the capture limit and was discarded.',
        utteranceId: id,
      });
      return;
    }
    state.bytes += payload.length;
    state.chunks.push({ data: pcm16FromBytes(payload), sampleRate: state.sampleRate });
  }

  private async finishUtterance(id: string): Promise<void> {
    const state = this.utterances.get(id);
    if (!state || state.superseded) {
      this.opts.send({ t: 'dropped', utteranceId: id, stage: 'transcript', reason: 'superseded' });
      return;
    }
    const chunks = state.chunks;
    // The captured PCM is not needed once it has been handed to STT; holding it
    // for the rest of the call would keep raw voice in memory for no reason.
    state.chunks = [];
    const startedAt = Date.now();
    const wav = encodeWav(chunks, state.sampleRate);

    try {
      const result = await this.opts.deps.transcribe(
        { data: wav, mimeType: 'audio/wav' },
        state.controller.signal,
      );
      if (this.isStale(state)) {
        this.opts.send({
          t: 'dropped',
          utteranceId: id,
          stage: 'transcript',
          reason: 'superseded',
        });
        return;
      }
      this.opts.onEvent?.({
        type: 'transcribed',
        utteranceId: id,
        provider: result.provider,
        ms: Date.now() - startedAt,
      });
      this.opts.send({
        t: 'transcript',
        utteranceId: id,
        text: result.text,
        final: true,
        provider: result.provider,
      });
    } catch (err) {
      if (this.isStale(state)) {
        this.opts.send({
          t: 'dropped',
          utteranceId: id,
          stage: 'transcript',
          reason: 'superseded',
        });
        return;
      }
      this.opts.send({
        t: 'error',
        code: 'transcribe_failed',
        message: errorMessage(err, 'Could not transcribe audio — try again'),
        utteranceId: id,
        ...providerOf(err),
      });
    }
  }

  private queueSynthesis(frame: Extract<VoiceClientFrame, { t: 'synthesize' }>): void {
    const state = this.utterances.get(frame.utteranceId);
    if (!state || state.superseded) {
      this.opts.send({
        t: 'dropped',
        utteranceId: frame.utteranceId,
        stage: 'synthesis',
        reason: 'superseded',
      });
      return;
    }
    // Segments are synthesized one at a time per utterance so their frames
    // cannot interleave on the wire. The client still gets sentence N+1 while
    // N is playing — synthesis is far faster than playout — without the lane
    // having to reassemble an out-of-order stream.
    state.synthChain = state.synthChain.then(() => this.runSynthesis(state, frame));
  }

  private async runSynthesis(
    state: UtteranceState,
    frame: Extract<VoiceClientFrame, { t: 'synthesize' }>,
  ): Promise<void> {
    if (this.isStale(state)) {
      this.opts.send({
        t: 'dropped',
        utteranceId: frame.utteranceId,
        stage: 'synthesis',
        reason: 'superseded',
      });
      return;
    }
    const startedAt = Date.now();
    let seq = 0;
    let provider = '';
    try {
      // `voice` is the client's global default; `personalityId` is what lets
      // the server prefer the personality's own voice over it. The lane does
      // not choose — it forwards both and `VoiceService` applies the one
      // shared precedence rule.
      const stream = this.opts.deps.synthesize(frame.text, {
        ...(frame.voice ? { voice: frame.voice } : {}),
        ...(frame.personalityId ? { personalityId: frame.personalityId } : {}),
        ...(frame.language ? { language: frame.language } : {}),
        signal: state.controller.signal,
      });
      for await (const chunk of stream) {
        if (this.isStale(state)) {
          state.controller.abort();
          this.opts.send({
            t: 'dropped',
            utteranceId: frame.utteranceId,
            stage: 'synthesis',
            reason: 'superseded',
          });
          return;
        }
        provider = chunk.provider;
        this.opts.send(
          {
            t: 'audio',
            utteranceId: frame.utteranceId,
            segmentId: frame.segmentId,
            seq: seq++,
            codec: chunk.format === 'pcm' ? 'pcm_s16le' : 'encoded',
            mimeType: MIME_BY_FORMAT[chunk.format] ?? 'application/octet-stream',
            provider: chunk.provider,
          },
          chunk.audio,
        );
      }
      if (this.isStale(state)) return;
      this.opts.send({
        t: 'segment_end',
        utteranceId: frame.utteranceId,
        segmentId: frame.segmentId,
      });
      this.opts.onEvent?.({
        type: 'synthesized',
        utteranceId: frame.utteranceId,
        segmentId: frame.segmentId,
        provider,
        ms: Date.now() - startedAt,
      });
    } catch (err) {
      if (this.isStale(state)) return;
      this.opts.send({
        t: 'error',
        code: 'synthesize_failed',
        message: errorMessage(err, 'Speech synthesis failed'),
        utteranceId: frame.utteranceId,
        // Whatever the stream managed to name before it broke, else the
        // resolution error's own provider id.
        ...(provider ? { provider } : providerOf(err)),
      });
    }
  }

  private supersede(
    id: string,
    reason: 'superseded' | 'cancelled' | 'too_large' | 'lane_closed',
    stage: 'capture' | 'transcript' | 'synthesis',
  ): void {
    const state = this.utterances.get(id);
    if (!state || state.superseded) return;
    state.superseded = true;
    state.chunks = [];
    state.controller.abort();
    if (this.activeUtteranceId === id) this.activeUtteranceId = null;
    this.opts.onEvent?.({ type: 'utterance_superseded', utteranceId: id, reason });
    this.opts.send({ t: 'dropped', utteranceId: id, stage, reason });
  }

  private isStale(state: UtteranceState): boolean {
    return this.closed || state.superseded || this.utterances.get(state.id) !== state;
  }

  /** Keep the tracked-utterance map bounded; evicted utterances are stale. */
  private evictOverflow(): void {
    while (this.utterances.size > this.limits.maxTrackedUtterances) {
      const oldest = this.utterances.keys().next();
      if (oldest.done) return;
      const state = this.utterances.get(oldest.value);
      if (state) {
        state.superseded = true;
        state.chunks = [];
        state.controller.abort();
      }
      this.utterances.delete(oldest.value);
    }
  }
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * Name the provider behind a failure when the error carries one
 * (`VoiceProviderError.providerId` from `@ethosagent/core`). Structural rather
 * than an instanceof import: the lane stays free of provider-resolution
 * dependencies, and any error that names its provider gets to say so.
 */
function providerOf(err: unknown): { provider?: string } {
  if (typeof err !== 'object' || err === null) return {};
  const id = (err as { providerId?: unknown }).providerId;
  return typeof id === 'string' && id ? { provider: id } : {};
}
