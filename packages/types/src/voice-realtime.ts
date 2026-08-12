// packages/types/src/voice-realtime.ts — hosted realtime speech-to-speech contracts
//
// The STT/TTS contracts in `./voice` describe a PIPELINE: microphone → text →
// model turn → text → speaker. A realtime provider (OpenAI Realtime, Gemini
// Live) collapses that pipeline into ONE duplex session that owns the audio in
// both directions, runs its own VAD, and calls tools itself. It is therefore a
// third provider kind rather than a variation on the other two — nothing in
// `./voice` is modified or extended here.

import type { ToolDefinitionLite } from './llm';
import type { VoiceProviderFactoryContext } from './voice';

/**
 * Contract version a realtime provider must declare in `caps.contractVersion`.
 *
 * Starts at 1; there is no earlier realtime shape to migrate from.
 */
export const REALTIME_CONTRACT_VERSION = 1;

/**
 * The only audio encoding on this contract: signed 16-bit little-endian PCM,
 * mono, at `caps.inputSampleRate` going up and `caps.outputSampleRate` coming
 * down. Both target providers accept it, and it is what the browser ↔ web-api
 * voice lane already carries (`VOICE_PCM_MIME` in `@ethosagent/web-contracts`).
 * A format-negotiation layer here would be an abstraction with one
 * implementation on each side, so there isn't one: a provider that speaks
 * something else transcodes at its own edge.
 */
export const REALTIME_AUDIO_FORMAT = 'pcm_s16le';

export interface RealtimeVoiceCapabilities {
  kind: 'realtime';
  /**
   * Sample rate, in Hz, the provider ACCEPTS on {@link RealtimeSession.sendAudio}.
   *
   * Separate from {@link RealtimeVoiceCapabilities.outputSampleRate} because a
   * realtime provider is not obliged to be symmetric — Gemini Live listens at
   * 16 kHz and speaks at 24 kHz. A single number forced the asymmetric provider
   * to resample every captured frame internally, which is pure loss on the
   * audio hot path for a fact the caller could simply have been told. Callers
   * capture at THIS rate.
   */
  inputSampleRate: number;
  /** Sample rate, in Hz, of the PCM16 mono frames the provider SENDS. Callers play out at this rate. */
  outputSampleRate: number;
  /**
   * The session runs on this machine and no audio leaves it. This exact flag
   * is what the local-only egress gate keys on (`resolve()` in
   * `@ethosagent/core`'s `providers/voice-resolution`): anything not
   * `local === true` must be named in `voice.trustedPlugins` before a single
   * frame is sent. Omitted or `false` means "audio leaves this machine".
   */
  local?: boolean;
  voices?: string[];
  languages?: string[];
  /**
   * The provider implements {@link RealtimeVoiceProvider.mintEphemeralToken}
   * and can hand out a short-lived browser-direct credential. This is the flag
   * callers gate on before offering the browser-direct path.
   */
  ephemeralToken?: boolean;
  /** Declare {@link REALTIME_CONTRACT_VERSION}. */
  contractVersion: number;
}

/**
 * One tool the realtime session may call mid-conversation.
 *
 * Structurally identical to {@link ToolDefinitionLite} — and aliased to it on
 * purpose, so the output of `ToolRegistry.toDefinitions()` drops straight into
 * {@link RealtimeSessionOptions.tools} with no adapter and no drift between the
 * tools the model sees over text and the ones it sees over voice.
 */
export type RealtimeToolDefinition = ToolDefinitionLite;

export interface RealtimeSessionOptions {
  /**
   * System instructions for the whole session — this is where the
   * personality's SOUL.md goes. Sent once at open, not per turn.
   */
  instructions: string;
  /** Provider voice id; falls back to the provider's own default. */
  voice?: string;
  model?: string;
  /** BCP-47 tag hinting the spoken language. */
  language?: string;
  /** Tools the session may call. See {@link RealtimeToolDefinition}. */
  tools?: RealtimeToolDefinition[];
  signal?: AbortSignal;
}

/**
 * Everything a realtime session reports back, as one discriminated union.
 * Consumers `switch` on `type`; the union is exhaustiveness-tested.
 */
export type RealtimeEvent =
  /** Session is live and accepting audio. Gates the "start sending mic" edge. */
  | { type: 'session_open'; sessionId: string; model?: string }
  /** Output speech. The surface plays these frames; PCM16 mono at `caps.outputSampleRate`. */
  | { type: 'audio'; pcm: Uint8Array; sampleRate: number }
  /**
   * Incremental transcript for EITHER role. `isFinal` marks the settled text;
   * final deltas are what the session persists as its text history, so a voice
   * conversation is searchable and resumable like a typed one.
   */
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string; isFinal: boolean }
  /**
   * The model wants a tool run. The consumer executes it and answers with
   * {@link RealtimeSession.sendToolResult} using the same `callId`.
   */
  | { type: 'tool_call'; callId: string; name: string; args: Record<string, unknown> }
  /**
   * Provider-side VAD heard the user start talking. This is the barge-in
   * trigger: the surface stops playback and calls
   * {@link RealtimeSession.interrupt}.
   */
  | { type: 'speech_started' }
  /** The model finished a response. Ends the "assistant is speaking" state. */
  | { type: 'response_done'; responseId?: string }
  /** Recoverable session error — the session may still be open. */
  | { type: 'error'; error: string; code: string }
  /** Terminal. Nothing follows. Drives reconnect-or-give-up in the surface. */
  | { type: 'closed'; reason: string };

/**
 * A live duplex session. Obtained from {@link RealtimeVoiceProvider.open} and
 * owned by the caller until `close()`.
 */
export interface RealtimeSession {
  /**
   * Everything the session reports, in order. Consume with `for await`; the
   * iterable completes after the `closed` event.
   */
  readonly events: AsyncIterable<RealtimeEvent>;
  /** Push captured mic audio. PCM16 mono at `caps.inputSampleRate`. */
  sendAudio(pcm: Uint8Array): Promise<void>;
  /** Answer a `tool_call` event. `output` is the tool result, already stringified. */
  sendToolResult(callId: string, output: string): Promise<void>;
  /**
   * Cancel in-flight speech. Called on barge-in, after `speech_started`, so
   * the model stops talking over the user instead of finishing its sentence.
   */
  interrupt(): Promise<void>;
  close(): Promise<void>;
  /**
   * OPTIONAL — speak `text` verbatim without running a model turn. Used for a
   * spoken filler while a slow consult runs, and for a graceful spoken
   * wind-down when a budget halt cuts the turn short. A provider that cannot
   * do this omits the method entirely; the caller degrades to a normal model
   * turn, which costs a round trip and lets the model reword the line.
   */
  say?(text: string): Promise<void>;
}

/**
 * A short-lived credential the BROWSER uses to connect to the provider
 * directly. That is the whole point: the operator's long-lived API key stays
 * on the server and is never shipped to a page, while audio still takes one
 * hop instead of being relayed through web-api. A provider that has no such
 * mechanism omits {@link RealtimeVoiceProvider.mintEphemeralToken}.
 */
export interface RealtimeEphemeralToken {
  /** The credential itself. Treat as a secret; short-lived, but still a key. */
  token: string;
  /** Absolute expiry, epoch milliseconds. Not a TTL — no clock arithmetic at the edge. */
  expiresAt: number;
  /** Endpoint the browser connects to with `token`. */
  url: string;
  /** Model the token was minted against, when the provider pins one. */
  model?: string;
}

export interface RealtimeVoiceProvider {
  readonly name: string;
  readonly caps: RealtimeVoiceCapabilities;
  /** Open a duplex session. Rejects if the session cannot be established. */
  open(opts: RealtimeSessionOptions): Promise<RealtimeSession>;
  /**
   * OPTIONAL — mint a browser-direct credential for a session configured by
   * `opts`. Present only when `caps.ephemeralToken === true`.
   */
  mintEphemeralToken?(opts: RealtimeSessionOptions): Promise<RealtimeEphemeralToken>;
}

/**
 * One configured realtime provider — the exact structural sibling of
 * `TtsProviderEntry` / `SttProviderEntry`, so a deployment can carry several
 * (`voice.realtime.providers.<name>.*`) and a personality can pick one by name.
 *
 * `provider` is the REGISTERED provider id (`openai-realtime`, `gemini-live`,
 * …). The roster key is a label the operator chose; it is never a provider id
 * and never what the local-only egress gate keys on — that gate reads
 * `caps.local` off the resolved provider.
 */
export interface RealtimeProviderEntry {
  /** Registered provider id, e.g. `openai-realtime` / `gemini-live`. */
  provider: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  /** Default voice id for this entry; a personality's own voice wins over it. */
  voice?: string;
  /**
   * What this entry costs per minute of audio, in USD — the provider's own
   * published rate, typed by the operator. A realtime session is billed by
   * wall-clock audio time rather than by token, so this is the only number
   * that turns session duration into money: multiplied by the session's audio
   * minutes it becomes the accrued cost that usage events report and that
   * `voice.realtime.sessionBudgetUsd` halts on. Absent = no rate known, so
   * nothing accrues and a budget cannot bite.
   */
  costPerMinuteUsd?: number;
}

export type RealtimeVoiceProviderFactory = (
  ctx: VoiceProviderFactoryContext,
) => RealtimeVoiceProvider | Promise<RealtimeVoiceProvider>;

export interface RealtimeVoiceProviderRegistry {
  register(name: string, factory: RealtimeVoiceProviderFactory): void;
  unregister(name: string): void;
  get(name: string): RealtimeVoiceProviderFactory | undefined;
  list(): string[];
}
