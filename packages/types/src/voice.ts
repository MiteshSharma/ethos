// packages/types/src/voice.ts — voice provider contracts

/**
 * Contract version an STT provider must declare in `caps.contractVersion`.
 *
 * v1 took a filesystem path (`transcribe(audioPath)`); v2 takes the utterance
 * bytes directly (`transcribeBuffer`). The migration was additive-then-remove
 * with no deprecation window (voice V1a, eng-review D4), so there is no v1
 * signature left to fall back to — a provider still declaring `1` cannot be
 * satisfying the interface it claims. `validateVoiceCaps` in
 * `@ethosagent/voice-providers` enforces the floor for third-party providers.
 */
export const STT_CONTRACT_VERSION = 2;

/**
 * A complete captured utterance, held in memory. The batch STT input.
 *
 * Utterances are seconds of 16 kHz mono audio — tens of kilobytes. Routing
 * them through a temp file cost a write, a read, a permission decision and a
 * cleanup obligation on the most sensitive artifact the system handles, for a
 * payload that every provider immediately loaded back into memory anyway.
 * A provider that genuinely needs a path (one that shells out to a binary)
 * materializes its own temp file and owns its lifetime.
 */
export interface SttAudio {
  /** Encoded audio bytes. */
  data: Uint8Array;
  /**
   * MIME type of `data` (e.g. `audio/webm`, `audio/wav`, `audio/ogg`).
   * Providers that upload the bytes derive the multipart filename and
   * content-type from it. Absent/unrecognized → `application/octet-stream`.
   */
  mimeType?: string;
  /** Sample rate in Hz. Meaningful only for raw `audio/pcm`. */
  sampleRate?: number;
}

export interface SttProvider {
  readonly name: string;
  readonly caps: VoiceCapabilities;
  /**
   * Transcribe one complete utterance. Providers that can transcribe
   * incrementally implement {@link StreamingSttProvider} in addition and
   * advertise `caps.streaming === true`; callers prefer the stream when it is
   * there and fall back to this method otherwise.
   */
  transcribeBuffer(
    audio: SttAudio,
    opts?: { language?: string; signal?: AbortSignal },
  ): Promise<string>;
}

export interface TtsProvider {
  readonly name: string;
  readonly caps: VoiceCapabilities;
  synthesize(
    text: string,
    opts?: { voice?: string; speed?: number; signal?: AbortSignal },
  ): Promise<{ audio: Uint8Array; format: 'opus' | 'mp3' | 'wav' | 'pcm' }>;
}

export interface VoiceCapabilities {
  kind: 'stt' | 'tts';
  formats: Array<'opus' | 'mp3' | 'wav' | 'pcm'>;
  languages?: string[];
  voices?: string[];
  /**
   * The provider also implements {@link StreamingSttProvider} /
   * {@link StreamingTtsProvider}. This is the flag callers gate on: a session
   * prefers the streaming method when it is `true` and falls back to the batch
   * method otherwise.
   */
  streaming?: boolean;
  local?: boolean;
  maxInputChars?: number;
  /** STT providers declare {@link STT_CONTRACT_VERSION}; TTS providers `1`. */
  contractVersion: number;
}

// ---------------------------------------------------------------------------
// Streaming voice contracts (additive — batch providers above remain valid).
//
// Real-time voice (see plan/phases/gap-voice-realtime.md §3(a)) drives audio
// as a live stream rather than a complete utterance. These interfaces extend
// the batch contracts above WITHOUT modifying them: a provider that advertises
// `caps.streaming === true` implements the streaming variant in addition to
// the batch method it inherits. Consumers feature-detect with the type
// guards below; batch-only providers keep working via utterance-buffered
// fallback in the caller.
// ---------------------------------------------------------------------------

/** A frame of linear PCM audio. `data` is signed 16-bit samples (mono). */
export interface PcmChunk {
  data: Int16Array;
  sampleRate: number;
  /** Optional capture timestamp (ms) for latency accounting. */
  timestampMs?: number;
}

/** An incremental transcription result from a streaming STT provider. */
export interface SttPartial {
  text: string;
  /** True once the provider considers this the settled transcript. */
  isFinal: boolean;
  confidence?: number;
}

/**
 * A streaming STT provider. Extends {@link SttProvider} additively: it still
 * carries the batch `transcribeBuffer()` method, and adds `transcribeStream()`
 * for live partial transcription. Advertise support via
 * `caps.streaming === true`.
 */
export interface StreamingSttProvider extends SttProvider {
  transcribeStream(
    audio: AsyncIterable<PcmChunk>,
    opts?: { language?: string; signal?: AbortSignal },
  ): AsyncIterable<SttPartial>;
}

/**
 * A streaming TTS provider. Extends {@link TtsProvider} additively: it still
 * carries the batch `synthesize()` method, and adds `synthesizeStream()` that
 * consumes text as it is produced (e.g. per sentence) and yields audio chunks
 * as they are ready. Advertise support via `caps.streaming === true`.
 */
export interface StreamingTtsProvider extends TtsProvider {
  synthesizeStream(
    text: AsyncIterable<string>,
    opts?: { voice?: string; speed?: number; signal?: AbortSignal },
  ): AsyncIterable<{ audio: Uint8Array; format: 'opus' | 'mp3' | 'wav' | 'pcm' }>;
}

/** True when `p` implements the streaming STT contract. */
export function isStreamingSttProvider(p: SttProvider): p is StreamingSttProvider {
  return (
    p.caps.streaming === true && typeof (p as StreamingSttProvider).transcribeStream === 'function'
  );
}

/** True when `p` implements the streaming TTS contract. */
export function isStreamingTtsProvider(p: TtsProvider): p is StreamingTtsProvider {
  return (
    p.caps.streaming === true && typeof (p as StreamingTtsProvider).synthesizeStream === 'function'
  );
}

export interface VoiceProviderFactoryContext {
  config: Record<string, unknown>;
  secrets: import('./secrets').SecretsResolver;
  logger: import('./logger').Logger;
}

export type SttProviderFactory = (
  ctx: VoiceProviderFactoryContext,
) => SttProvider | Promise<SttProvider>;
export type TtsProviderFactory = (
  ctx: VoiceProviderFactoryContext,
) => TtsProvider | Promise<TtsProvider>;

export interface SttProviderRegistry {
  register(name: string, factory: SttProviderFactory): void;
  unregister(name: string): void;
  get(name: string): SttProviderFactory | undefined;
  list(): string[];
}

export interface TtsProviderRegistry {
  register(name: string, factory: TtsProviderFactory): void;
  unregister(name: string): void;
  get(name: string): TtsProviderFactory | undefined;
  list(): string[];
}
