// The one voice-reply decision (voice V1a, eng-review D3).
//
// Pure function on purpose: persistence of the per-lane mode belongs to the
// gateway's Storage-backed state machine, not here. Every reply surface — the
// gateway reply path, the hook-claimed reply path, the browser talk path, V2's
// channel sinks, V3's wake-triggered turns — asks this and nothing else.

/** Per-lane voice mode. Persisted by the caller; `/voice <mode>` mutates it. */
export type VoiceMode = 'off' | 'mirror_inbound' | 'all';

/** Mode a lane starts in: speak back when spoken to, stay quiet otherwise. */
export const DEFAULT_VOICE_MODE: VoiceMode = 'mirror_inbound';

export interface VoiceReplyDecisionInput {
  /** The lane's persisted voice mode. */
  mode: VoiceMode;
  /** Whether the inbound turn arrived as audio. */
  inboundHadAudio: boolean;
  /**
   * Whether the turn was started by a wake word. Wake turns are voice-origin
   * even when the inbound payload is already text, so they mirror as voice.
   */
  wakeTriggered?: boolean;
}

/** True when this turn's reply should be spoken as well as / instead of written. */
export function shouldReplyWithVoice(input: VoiceReplyDecisionInput): boolean {
  // `off` is an explicit user opt-out; nothing overrides it, wake included.
  if (input.mode === 'off') return false;
  if (input.mode === 'all') return true;
  return input.inboundHadAudio || input.wakeTriggered === true;
}
