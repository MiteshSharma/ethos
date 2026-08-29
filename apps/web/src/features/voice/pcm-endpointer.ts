import { DEFAULT_VOICE_TUNING, type VoiceTuning } from './batch-voice-call-client';

// Endpointing over the captured PCM stream itself.
//
// The batch driver read levels off an AnalyserNode on a 50 ms `setInterval` and
// timed silence with the wall clock. The streaming path already has every
// sample in hand, so the same decisions are made from the audio: elapsed time
// is derived from sample counts, which makes endpointing sample-accurate,
// independent of timer jitter, and — because it is pure — testable without any
// browser audio at all.
//
// Thresholds are the SAME `VoiceTuning` values the batch driver uses (Settings
// → Voice → Advanced), so tuning transfers between the two paths.

export type EndpointerEvent =
  /** An utterance began. The pre-roll frames follow immediately. */
  | { type: 'speech_start' }
  /** One frame belonging to the utterance in progress. */
  | { type: 'frame'; data: Int16Array }
  /** Trailing silence reached: the utterance is complete. */
  | { type: 'speech_end' }
  /** Sustained speech while the agent was speaking. */
  | { type: 'barge_in' };

export interface PcmEndpointerOptions extends Partial<VoiceTuning> {
  /**
   * Audio kept before the speech threshold is crossed and replayed at
   * `speech_start`, so the first consonant is not clipped. The threshold is
   * always crossed a little after the word actually starts.
   */
  prerollMs?: number;
}

const DEFAULT_PREROLL_MS = 300;

export class PcmEndpointer {
  private readonly tuning: VoiceTuning;
  private readonly prerollMs: number;
  private readonly sampleRate: number;

  private elapsedMs = 0;
  private speaking = false;
  private speechStartedMs = 0;
  private lastVoiceMs = 0;
  private bargeSustainedMs = 0;
  private captureEnabled = true;
  private bargeEnabled = false;
  private preroll: Array<{ data: Int16Array; ms: number }> = [];
  private prerollMsHeld = 0;

  constructor(sampleRate: number, opts: PcmEndpointerOptions = {}) {
    this.sampleRate = sampleRate;
    this.tuning = {
      endpointSilenceMs: opts.endpointSilenceMs ?? DEFAULT_VOICE_TUNING.endpointSilenceMs,
      bargeThreshold: opts.bargeThreshold ?? DEFAULT_VOICE_TUNING.bargeThreshold,
      bargeSustainMs: opts.bargeSustainMs ?? DEFAULT_VOICE_TUNING.bargeSustainMs,
      speechThreshold: opts.speechThreshold ?? DEFAULT_VOICE_TUNING.speechThreshold,
      speechMinMs: opts.speechMinMs ?? DEFAULT_VOICE_TUNING.speechMinMs,
    };
    this.prerollMs = opts.prerollMs ?? DEFAULT_PREROLL_MS;
  }

  /** Mic frames are ignored for capture while false (e.g. muted, or speaking). */
  setCaptureEnabled(enabled: boolean): void {
    if (this.captureEnabled === enabled) return;
    this.captureEnabled = enabled;
    if (!enabled) this.resetUtterance();
  }

  /** Watch for the user talking over the agent. */
  setBargeInEnabled(enabled: boolean): void {
    this.bargeEnabled = enabled;
    this.bargeSustainedMs = 0;
  }

  reset(): void {
    this.resetUtterance();
    this.bargeSustainedMs = 0;
  }

  push(frame: Int16Array): EndpointerEvent[] {
    const durationMs = (frame.length / this.sampleRate) * 1000;
    this.elapsedMs += durationMs;
    const level = rms(frame);
    const events: EndpointerEvent[] = [];

    if (this.bargeEnabled) {
      if (level > this.tuning.bargeThreshold) {
        this.bargeSustainedMs += durationMs;
        if (this.bargeSustainedMs >= this.tuning.bargeSustainMs) {
          this.bargeSustainedMs = 0;
          events.push({ type: 'barge_in' });
        }
      } else {
        this.bargeSustainedMs = 0;
      }
    }

    if (!this.captureEnabled) {
      // Still worth remembering: capture usually re-opens right after a
      // barge-in, and the words that triggered it belong to the next utterance.
      this.rememberPreroll(frame, durationMs);
      return events;
    }

    if (level > this.tuning.speechThreshold) {
      if (!this.speaking) {
        this.speaking = true;
        this.speechStartedMs = this.elapsedMs;
        events.push({ type: 'speech_start' });
        for (const held of this.preroll) events.push({ type: 'frame', data: held.data });
        this.preroll = [];
        this.prerollMsHeld = 0;
      }
      this.lastVoiceMs = this.elapsedMs;
      events.push({ type: 'frame', data: frame });
      return events;
    }

    if (!this.speaking) {
      this.rememberPreroll(frame, durationMs);
      return events;
    }

    // In-utterance silence is part of the utterance until it endpoints.
    events.push({ type: 'frame', data: frame });
    const silenceMs = this.elapsedMs - this.lastVoiceMs;
    const speechMs = this.lastVoiceMs - this.speechStartedMs;
    if (silenceMs > this.tuning.endpointSilenceMs && speechMs > this.tuning.speechMinMs) {
      this.resetUtterance();
      events.push({ type: 'speech_end' });
    } else if (silenceMs > this.tuning.endpointSilenceMs) {
      // Too short to be speech — a cough, a door. Drop it silently rather than
      // shipping a phantom utterance to STT.
      this.resetUtterance();
    }
    return events;
  }

  private rememberPreroll(frame: Int16Array, durationMs: number): void {
    this.preroll.push({ data: frame, ms: durationMs });
    this.prerollMsHeld += durationMs;
    while (this.prerollMsHeld > this.prerollMs && this.preroll.length > 1) {
      const dropped = this.preroll.shift();
      this.prerollMsHeld -= dropped?.ms ?? 0;
    }
  }

  private resetUtterance(): void {
    this.speaking = false;
    this.speechStartedMs = 0;
    this.lastVoiceMs = 0;
    this.preroll = [];
    this.prerollMsHeld = 0;
  }
}

/** Root-mean-square level of a 16-bit frame, normalized to 0..1. */
export function rms(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const sample = (frame[i] ?? 0) / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / frame.length);
}
