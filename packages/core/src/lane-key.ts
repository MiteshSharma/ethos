// The one encoder for lane / session keys.
//
// A lane key names a CONVERSATION. Two conversations that share a key share a
// history, a queue and a turn — which is the failure behind OpenClaw #112253,
// where a phone call and a desktop session interleaved into one session. So the
// rule here is not "make collisions unlikely", it is "make them unconstructible":
// every segment is URL-encoded, so a segment carrying the `:` separator cannot
// alias two distinct keys onto one string.
//
// Continuity with pre-encoding session keys is only guaranteed for segments
// that are themselves URL-safe: platform identifiers (`telegram` / `slack` /
// ...), the hex-derived default botKey (`deriveBotKey` in `./bot-key`), numeric
// Slack `thread_ts`, and the chat IDs the supported platforms emit. An operator
// who configures a custom `id:` value containing reserved characters will see
// their existing SQLite session key change shape once after upgrade and their
// history orphan — that's the cost of choosing an unusual botKey, not a
// regression in the common case.
//
// Treat the returned string as opaque. Nothing decodes it; collisions only
// matter at construction time, and this file is the single point of truth for
// what a lane key looks like.

/** Join `segments` into a lane key, URL-encoding each one. */
export function buildLaneKey(...segments: string[]): string {
  return segments.map(encodeURIComponent).join(':');
}

/**
 * How a voice conversation reached the agent.
 *
 * This is the segment that makes cross-surface collision STRUCTURAL rather
 * than statistical. A phone call and a browser talk session can — and on a
 * single-operator deployment routinely will — carry the same trailing id: the
 * operator's own phone number is as plausible a `callerId` as any browser
 * session id is a `clientId`. Nothing about the ids themselves keeps them
 * apart. The kind segment does: it is a closed union, it is written by the
 * surface that owns the transport, and a browser can never emit `sip`.
 */
export type VoiceLaneClientKind =
  /** Browser talk-mode (web/desktop), pipeline or realtime tier. */
  | 'browser'
  /** A LiveKit room participant. */
  | 'livekit'
  /** An inbound/outbound PSTN leg through the SIP trunk (V4). */
  | 'sip';

export interface VoiceLaneClient {
  kind: VoiceLaneClientKind;
  /**
   * Stable id for this client WITHIN its kind — a caller number for `sip`, a
   * room participant identity for `livekit`, the chat session the call belongs
   * to for `browser`. Stability is what makes a reconnect resume the same
   * conversation instead of forking a new one.
   */
  id: string;
}

/**
 * The lane key for one voice conversation: `voice:<botKey>:<kind>:<id>`.
 *
 * Used by the LiveKit/SIP adapters, by the wiring-built VoiceSession stack and
 * by the browser realtime control lane, so a span, a queue and a transcript all
 * name the same conversation with the same string.
 */
export function voiceLaneKey(botKey: string, client: VoiceLaneClient): string {
  return buildLaneKey('voice', botKey, client.kind, client.id);
}
