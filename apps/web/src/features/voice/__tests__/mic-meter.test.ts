import { describe, expect, it } from 'vitest';
import { createMicMeter, type MicMeterAnalyser } from '../mic-meter';

// DR5's `prefers-reduced-motion` promise for the ONE piece of talk-mode motion
// the stylesheet cannot reach: the red AudioBars mic meter.
//
// The three keyframe pulses stop in CSS and `call-strip-css.test.ts` pins that.
// The meter does not — its bar heights are rewritten from JS on every animation
// frame, so `animation: none` removes the smoothing between two moving heights
// and the bars keep jumping. A stylesheet assertion is structurally incapable of
// catching that, which is why this suite drives the loop itself.

/** A mic that is always loud, so a moving meter is unmistakably moving. */
function loudAnalyser(): MicMeterAnalyser & { reads: number } {
  return {
    reads: 0,
    frequencyBinCount: 8,
    getByteFrequencyData(array: Uint8Array) {
      this.reads++;
      array.fill(200);
    },
  };
}

/** A hand-cranked `requestAnimationFrame`: frames happen when the test says. */
function frames() {
  let pending: (() => void) | null = null;
  const cancelled: number[] = [];
  let handle = 0;
  return {
    cancelled,
    requestFrame: (cb: () => void) => {
      pending = cb;
      return ++handle;
    },
    cancelFrame: (h: number) => cancelled.push(h),
    /** Run `n` scheduled frames. */
    run(n: number) {
      for (let i = 0; i < n; i++) {
        const next = pending;
        pending = null;
        next?.();
      }
    },
  };
}

function meter(reduced: () => boolean) {
  const analyser = loudAnalyser();
  const clock = frames();
  const rows: number[][] = [];
  const stop = createMicMeter({
    analyser,
    bars: 4,
    onLevels: (levels) => rows.push(levels),
    reducedMotion: reduced,
    requestFrame: clock.requestFrame,
    cancelFrame: clock.cancelFrame,
  });
  return { analyser, clock, rows, stop };
}

describe('mic meter — reduced motion', () => {
  it('normally redraws the bars on every frame', () => {
    const { rows, clock, analyser } = meter(() => false);
    clock.run(4);

    expect(rows).toHaveLength(4);
    expect(analyser.reads).toBe(4);
    // The rolling window fills from the right: each frame pushes one more
    // non-zero bar, so consecutive rows are genuinely different.
    expect(rows[0]).not.toEqual(rows[1]);
    expect(rows[3]?.every((level) => level > 0)).toBe(true);
  });

  it('stops the bars dead when motion is reduced', () => {
    const { rows, clock, analyser } = meter(() => true);
    clock.run(5);

    // One flat row so the meter settles at rest rather than freezing on a
    // half-drawn waveform — and then nothing at all.
    expect(rows).toEqual([[0, 0, 0, 0]]);
    // Not merely "published the same row five times": the loop never even
    // reads the mic, so there is no motion left to render.
    expect(analyser.reads).toBe(0);
  });

  it('follows the preference when it flips mid-call', () => {
    let reduced = false;
    const { rows, clock } = meter(() => reduced);

    clock.run(3);
    expect(rows).toHaveLength(3);

    reduced = true;
    clock.run(3);
    // Exactly one more row — the flatten — for three frames of reduced motion.
    expect(rows).toHaveLength(4);
    expect(rows[3]).toEqual([0, 0, 0, 0]);

    reduced = false;
    clock.run(2);
    expect(rows).toHaveLength(6);
    expect(rows[5]?.at(-1)).toBeGreaterThan(0);
  });

  it('stops scheduling frames once torn down', () => {
    const { clock, stop, rows } = meter(() => false);
    clock.run(1);
    stop();
    expect(clock.cancelled).toHaveLength(1);
    // Idempotent: a second teardown must not cancel a handle it no longer owns.
    stop();
    expect(clock.cancelled).toHaveLength(1);
    expect(rows).toHaveLength(1);
  });
});
