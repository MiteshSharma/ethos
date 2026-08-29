import { describe, expect, it } from 'vitest';
import { createFramePacer } from '../sip/frame-pacer';
import { makeTimerScheduler as makeScheduler } from './fakes';

const RATE = 8000;
const FRAME_MS = 20;
const FRAME_SAMPLES = (RATE * FRAME_MS) / 1000;

function tone(frames: number, value = 7): Int16Array {
  return new Int16Array(FRAME_SAMPLES * frames).fill(value);
}

describe('createFramePacer', () => {
  it('schedules from an absolute anchor, so jitter never accumulates', () => {
    const scheduler = makeScheduler();
    const emitted: Array<{ at: number; length: number }> = [];
    const pacer = createFramePacer({
      sampleRate: RATE,
      frameMs: FRAME_MS,
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      emit: (frame) => emitted.push({ at: scheduler.now(), length: frame.length }),
    });

    pacer.push(tone(500));

    const deadlines: Array<number | null> = [];
    for (let i = 0; i < 500; i++) {
      deadlines.push(scheduler.scheduledAt());
      // 1..7 ms late, every single wake-up.
      scheduler.fire((i % 7) + 1);
    }

    expect(emitted.length).toBe(500);
    // THE ASSERTION. Frame `i` is due at exactly `i * frameMs` from the anchor.
    // A `setTimeout(next, frameMs)` chain would have deadline 499 sitting ~2s
    // past this, because it folds each wake-up's lateness into the next one.
    deadlines.forEach((deadline, i) => {
      expect(deadline).toBe(i * FRAME_MS);
    });
    // And the ACTUAL emission never drifts further than one wake-up's lateness.
    const lastEmit = emitted[499];
    expect(lastEmit).toBeDefined();
    expect((lastEmit?.at ?? 0) - 499 * FRAME_MS).toBeLessThanOrEqual(7);
  });

  it('cuts the queue into frames of exactly frameMs', () => {
    const scheduler = makeScheduler();
    const emitted: Int16Array[] = [];
    const pacer = createFramePacer({
      sampleRate: RATE,
      frameMs: FRAME_MS,
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      emit: (frame) => emitted.push(frame),
    });

    // Three chunks that do not align with a frame boundary.
    pacer.push(new Int16Array(200).fill(1));
    pacer.push(new Int16Array(200).fill(2));
    pacer.push(new Int16Array(80).fill(3));
    while (scheduler.fire()) {
      // drain
    }

    expect(emitted.map((f) => f.length)).toEqual([160, 160, 160]);
    expect(emitted[0]?.[0]).toBe(1);
    // The third frame straddles both later chunks and then runs out.
    expect(emitted[2]?.[0]).toBe(2);
  });

  it('zero-pads a partial trailing frame instead of dropping it', () => {
    const scheduler = makeScheduler();
    const emitted: Int16Array[] = [];
    const pacer = createFramePacer({
      sampleRate: RATE,
      frameMs: FRAME_MS,
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      emit: (frame) => emitted.push(frame),
    });

    pacer.push(new Int16Array(100).fill(9));
    expect(scheduler.fire()).toBe(true);

    const frame = emitted[0];
    expect(frame?.length).toBe(FRAME_SAMPLES);
    expect(frame?.[99]).toBe(9);
    expect(frame?.[100]).toBe(0);
    expect(frame?.[159]).toBe(0);
  });

  it('cancel() drops everything queued and stops the schedule', () => {
    const scheduler = makeScheduler();
    const emitted: Int16Array[] = [];
    const pacer = createFramePacer({
      sampleRate: RATE,
      frameMs: FRAME_MS,
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      emit: (frame) => emitted.push(frame),
    });

    pacer.push(tone(50));
    scheduler.fire();
    expect(emitted.length).toBe(1);

    pacer.cancel();
    expect(scheduler.cancelledAt.length).toBe(1);
    expect(scheduler.fire()).toBe(false);
    expect(emitted.length).toBe(1);
  });

  it('drained() resolves once the queue empties', async () => {
    const scheduler = makeScheduler();
    const pacer = createFramePacer({
      sampleRate: RATE,
      frameMs: FRAME_MS,
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      emit: () => {},
    });

    await pacer.drained(); // already empty
    pacer.push(tone(3));
    const pending = pacer.drained();
    while (scheduler.fire()) {
      // drain
    }
    await expect(pending).resolves.toBeUndefined();
  });

  it('re-anchors after a silence instead of trying to catch up', () => {
    const scheduler = makeScheduler();
    const emitted: Int16Array[] = [];
    const pacer = createFramePacer({
      sampleRate: RATE,
      frameMs: FRAME_MS,
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      emit: (frame) => emitted.push(frame),
    });

    pacer.push(tone(1));
    scheduler.fire();
    expect(scheduler.scheduledAt()).toBeNull();

    // Ten seconds of nobody speaking. An anchor held across this would make the
    // pacer believe it owed 500 frames and flush them in one go.
    scheduler.advance(10_000);
    pacer.push(tone(2));
    expect(scheduler.scheduledAt()).toBe(scheduler.now());
    scheduler.fire();
    expect(scheduler.scheduledAt()).toBe(scheduler.now() + FRAME_MS);
    expect(emitted.length).toBe(2);
  });

  it('stop() ends the pacer for good', () => {
    const scheduler = makeScheduler();
    const emitted: Int16Array[] = [];
    const pacer = createFramePacer({
      sampleRate: RATE,
      frameMs: FRAME_MS,
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      emit: (frame) => emitted.push(frame),
    });

    pacer.push(tone(5));
    pacer.stop();
    expect(scheduler.fire()).toBe(false);
    pacer.push(tone(5));
    expect(scheduler.fire()).toBe(false);
    expect(emitted.length).toBe(0);
  });
});
