// The red `AudioBars` mic meter's animation loop.
//
// Lifted out of `useVoiceCall` for the same reason `voice-call-reducer.ts` was:
// the rule that matters here is hard to see and impossible to test through the
// hook, which needs React and a live `AudioContext`. With the loop behind an
// injected clock and analyser it is a plain unit test.
//
// The rule: `prefers-reduced-motion` has to stop THIS loop. The bars are not a
// keyframe animation — they are redrawn from JS on every animation frame — so
// the stylesheet's `animation: none` / `transition: none` removes only the
// smoothing BETWEEN two heights and the red bars keep jumping. Motion is a
// property of the loop, so the loop is where the preference is honored
// (DESIGN.md motion rules, plan DR5).

/** The slice of `AnalyserNode` the meter reads. */
export interface MicMeterAnalyser {
  readonly frequencyBinCount: number;
  getByteFrequencyData(array: Uint8Array): void;
}

export interface MicMeterDeps {
  analyser: MicMeterAnalyser;
  /** How many bars the strip draws. */
  bars: number;
  /** Publish a new bar row. Not called again while motion is reduced. */
  onLevels: (levels: number[]) => void;
  /**
   * Read once per frame rather than captured at start: the OS preference can
   * flip in the middle of a call, and a meter that only checked at `connect()`
   * would keep moving for the rest of it.
   */
  reducedMotion: () => boolean;
  requestFrame: (cb: () => void) => number;
  cancelFrame: (handle: number) => void;
}

/** Start the meter. Returns the teardown. */
export function createMicMeter(deps: MicMeterDeps): () => void {
  const flat = (): number[] => Array.from({ length: deps.bars }, () => 0);
  let levels = flat();
  let handle: number | null = null;
  /** Whether the current reduced-motion spell has already been flattened. */
  let frozen = false;

  const tick = (): void => {
    if (deps.reducedMotion()) {
      // Freeze. One flat row first, so the meter settles at rest instead of
      // holding whatever half-drawn waveform it happened to be on, and then
      // nothing at all — no analyser read, no publish — until the preference
      // flips back.
      if (!frozen) {
        frozen = true;
        levels = flat();
        deps.onLevels(levels);
      }
    } else {
      frozen = false;
      const data = new Uint8Array(deps.analyser.frequencyBinCount);
      deps.analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] ?? 0;
      const avg = Math.min(1, sum / data.length / 160);
      // A rolling window: the oldest bar falls off the left, the newest lands
      // on the right. Owned here rather than in React state so the loop reads
      // its own previous row without a render in between.
      levels = [...levels.slice(1), avg];
      deps.onLevels(levels);
    }
    handle = deps.requestFrame(tick);
  };

  handle = deps.requestFrame(tick);

  return () => {
    if (handle === null) return;
    deps.cancelFrame(handle);
    handle = null;
  };
}
