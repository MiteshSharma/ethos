// Energy-based voice-activity detection. Deterministic and unit-testable with
// synthetic PCM.

import type { PcmChunk } from '@ethosagent/types';
import type { Vad } from './types';

/** Normalized RMS energy (0..1) of a frame of signed 16-bit PCM samples. */
export function rmsEnergy(data: Int16Array): number {
  if (data.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const s = (data[i] ?? 0) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / data.length);
}

export interface EnergyVadConfig {
  /** RMS energy threshold above which a frame counts as speech. Default 0.02. */
  threshold?: number;
  /**
   * Frames of trailing speech kept alive after energy drops below threshold —
   * smooths over brief intra-word silences. Default 3.
   */
  hangoverFrames?: number;
  /**
   * Continuous above-threshold milliseconds required before the detector will
   * report speech at all — the ATTACK filter, the counterpart of
   * `hangoverFrames`'s release.
   *
   * This is the knob a phone line needs. A PSTN leg carries line noise, a car,
   * a television, a cough; any one of those clears an energy threshold for a
   * single frame, and on the realtime tier a single frame of "the caller is
   * talking" is enough to cut the agent off mid-sentence. Requiring the energy
   * to persist is what separates a voice from a bang. A satellite across a
   * quiet room needs far less of it, which is why this is per-surface
   * (`voice.bargeIn.{call|satellite}.minSpeechMs`) rather than one global
   * number.
   *
   * Default 0 — a strict no-op, so every existing caller behaves exactly as it
   * did.
   */
  minSpeechMs?: number;
  /** Milliseconds one frame represents, for {@link minSpeechMs}. Default 20. */
  frameMs?: number;
}

export class EnergyVad implements Vad {
  private readonly threshold: number;
  private readonly hangoverFrames: number;
  private readonly minSpeechMs: number;
  private readonly frameMs: number;
  private hangover = 0;
  /** Above-threshold milliseconds accumulated in the current burst. */
  private activeMs = 0;

  constructor(config: EnergyVadConfig = {}) {
    this.threshold = config.threshold ?? 0.02;
    this.hangoverFrames = config.hangoverFrames ?? 3;
    this.minSpeechMs = config.minSpeechMs ?? 0;
    this.frameMs = config.frameMs ?? 20;
  }

  process(chunk: PcmChunk): { speech: boolean } {
    if (rmsEnergy(chunk.data) >= this.threshold) {
      this.activeMs += this.frameMs;
      // Still arming: loud, but not yet for long enough to be a voice.
      if (this.activeMs < this.minSpeechMs) return { speech: false };
      this.hangover = this.hangoverFrames;
      return { speech: true };
    }
    if (this.hangover > 0) {
      this.hangover--;
      // The burst is NOT re-armed while hangover is holding speech alive: an
      // intra-word gap is part of the same utterance, and making the speaker
      // re-earn `minSpeechMs` after every consonant would break the very
      // smoothing hangover exists to provide.
      return { speech: true };
    }
    this.activeMs = 0;
    return { speech: false };
  }
}
