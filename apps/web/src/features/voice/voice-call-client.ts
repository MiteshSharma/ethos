import { z } from 'zod';

// Isolated, typed boundary for a live browser voice call (talk-mode).
//
// This is the ONLY seam talk-mode's UI + state logic bind to. The production
// implementation wraps `livekit-client` (a WebRTC room: publishes the local mic
// track, subscribes to the agent's audio track, and carries transcript/control
// events over a data channel) — that package is NOT installed here, deliberately,
// so the whole feature typechecks and unit-tests against a fake without a running
// LiveKit server. See `apps/web/src/features/voice/README.md` for the manual
// binding step.
//
// The event stream mirrors `VoiceSessionEvent` from
// `extensions/voice-session/src/types.ts` — kept as a local mirror (not an import)
// so the web bundle takes no dependency on the node-side voice-session package.
// Keep the two in sync when the session contract changes.

/** Playout audio container. Mirrors `AudioFormat` in voice-session. */
export type VoiceCallAudioFormat = 'opus' | 'mp3' | 'wav' | 'pcm';

/**
 * Events surfaced by a {@link VoiceCallClient}. The transcript/reply variants
 * mirror `VoiceSessionEvent`; `disconnected` is a transport-level lifecycle
 * signal (remote/server ended the call) that has no session-event analogue.
 * Consumers must treat an unknown `type` as a no-op (forward-compatible).
 */
export type VoiceCallEvent =
  // A committed utterance's transcript is ready — the agent turn is about to run.
  // `provider` is the STT provider that ACTUALLY ran, when the transport knows it.
  | { type: 'utterance_committed'; text: string; provider?: string }
  // A complete sentence of the reply was flushed to synthesis.
  | { type: 'reply_sentence'; text: string }
  // A chunk of synthesized audio is ready for playout. `provider` is the TTS
  // provider that ACTUALLY ran, when the transport knows it.
  | { type: 'reply_audio'; audio: Uint8Array; format: VoiceCallAudioFormat; provider?: string }
  // Transport link state. The strip renders `reconnecting` from this; the
  // composer stays usable for text throughout.
  | { type: 'link'; status: 'connecting' | 'open' | 'reconnecting' }
  // A spoken filler ("One moment.") was queued during a long tool run.
  | { type: 'filler'; text: string }
  // Barge-in: the reply was interrupted. `text` is the honest played reply.
  | { type: 'interrupted'; text: string }
  // The reply finished playing uninterrupted. `text` is the played reply.
  | { type: 'reply_complete'; text: string }
  // The call spent its budget. `text` is the sign-off the session is speaking
  // right now; the call ends once it has been said. Not an `error`: nothing went
  // wrong, a limit the operator set was reached, and the strip says so in words
  // rather than putting a failure where the state word goes.
  | { type: 'budget_wind_down'; text: string }
  // An error surfaced. `provider` names the provider that failed, when known, so
  // a degraded-to-text notice can say WHICH one.
  | { type: 'error'; error: string; code?: string; provider?: string }
  // Transport-level: the room closed (remote hang-up, server disconnect).
  | { type: 'disconnected' };

/**
 * A live browser voice call. One instance owns one conversation: it acquires and
 * publishes the local mic, plays the agent's audio, and emits transcript/control
 * events. `micStream()` exposes the local track so a level meter can attach an
 * analyser without a second `getUserMedia` grab.
 */
export interface VoiceCallClient {
  /** Join the room, acquire the mic, start publishing. Rejects on failure. */
  connect(): Promise<void>;
  /** Leave the room and release the mic. Idempotent. */
  disconnect(): Promise<void>;
  /** Mute/unmute the outbound mic track. */
  setMuted(muted: boolean): void;
  /** The local mic MediaStream once connected, for a level meter. Null otherwise. */
  micStream(): MediaStream | null;
  /** Subscribe to call/transcript events. Returns an unsubscribe function. */
  on(listener: (event: VoiceCallEvent) => void): () => void;
}

// Zod schema for the JSON-serializable control events a real transport carries
// over its data channel (everything except `reply_audio`, which arrives as a
// media frame, not JSON). The production `livekit-client` binding MUST parse
// inbound data-channel payloads through `parseVoiceCallControlEvent` rather than
// casting them — external JSON is never trusted with `as` (CLAUDE.md "API
// response type safety").
const VoiceCallControlEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('utterance_committed'),
    text: z.string(),
    provider: z.string().optional(),
  }),
  z.object({ type: z.literal('link'), status: z.enum(['connecting', 'open', 'reconnecting']) }),
  z.object({ type: z.literal('reply_sentence'), text: z.string() }),
  z.object({ type: z.literal('filler'), text: z.string() }),
  z.object({ type: z.literal('interrupted'), text: z.string() }),
  z.object({ type: z.literal('reply_complete'), text: z.string() }),
  z.object({ type: z.literal('budget_wind_down'), text: z.string() }),
  z.object({
    type: z.literal('error'),
    error: z.string(),
    code: z.string().optional(),
    provider: z.string().optional(),
  }),
  z.object({ type: z.literal('disconnected') }),
]);

/**
 * Parse an untrusted data-channel payload into a {@link VoiceCallEvent}, or
 * return null when it does not match the contract. Used by the production
 * transport binding to keep external JSON off the `as`-cast path.
 */
export function parseVoiceCallControlEvent(raw: unknown): VoiceCallEvent | null {
  const parsed = VoiceCallControlEventSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const UNWIRED_MESSAGE =
  'Live voice transport is not installed. Install livekit-client and implement ' +
  'VoiceCallClient (see apps/web/src/features/voice/README.md) to talk in the browser.';

/**
 * Default client used until the real transport is wired. `connect()` rejects with
 * an honest message pointing at the manual binding step; every other method is a
 * no-op. This keeps the toggle + in-call UI fully functional and testable while
 * the green tree stays free of the native `livekit-client` dependency.
 */
export function createUnwiredVoiceCallClient(): VoiceCallClient {
  return {
    connect: () => Promise.reject(new Error(UNWIRED_MESSAGE)),
    disconnect: () => Promise.resolve(),
    setMuted: () => {},
    micStream: () => null,
    on: () => () => {},
  };
}
