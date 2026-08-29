// Thin adapter from `@ethosagent/voice-session`'s `EnergyVad` to the shape the
// capture machine consumes.
//
// The VAD is NOT forked. `EnergyVad` speaks `PcmChunk` (`{ data, sampleRate }`)
// because that is the contract the browser voice lane and the STT providers
// already share; the capture machine speaks `WakeFrame` (`{ samples,
// sampleRate }`) because that is what the wake seam calls a frame. The two
// differ by one field name, and the right answer to a field-name difference is
// six lines of translation, not a second energy detector that will drift from
// the first.

import { EnergyVad, type EnergyVadConfig } from '@ethosagent/voice-session';
import type { WakeFrame } from './wake-engine';

/** What `CaptureMachineDeps.vad` wants: one frame in, speech-or-not out. */
export interface FrameVad {
  push(frame: WakeFrame): boolean;
}

export function createEnergyFrameVad(config: EnergyVadConfig = {}): FrameVad {
  const vad = new EnergyVad(config);
  return {
    push: (frame) => vad.process({ data: frame.samples, sampleRate: frame.sampleRate }).speech,
  };
}
