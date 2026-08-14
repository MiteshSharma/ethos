// The one voice-reply decision (voice V1a, eng-review D3).
//
// Pure function on purpose: persistence of the per-lane mode belongs to
// `LaneVoiceModeStore` in `@ethosagent/core`, not here. Every reply surface — the
// gateway reply path, the hook-claimed reply path, the browser talk path, V2's
// channel sinks, V3's wake-triggered turns — asks this and nothing else.

import type { VoiceMode } from '@ethosagent/types';

// `VoiceMode` and its default live in `@ethosagent/types`: core's
// `LaneVoiceModeStore` persists the mode, and core depends on contracts only.
// Re-exported here so every existing importer of this module is unaffected.
export { DEFAULT_VOICE_MODE, type VoiceMode } from '@ethosagent/types';

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
