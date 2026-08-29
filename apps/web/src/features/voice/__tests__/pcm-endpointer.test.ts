import { describe, expect, it } from 'vitest';
import { type EndpointerEvent, PcmEndpointer, rms } from '../pcm-endpointer';

// Endpointing is timed off sample counts, so a "frame" here is exactly 10 ms of
// 16 kHz audio and the assertions are about durations, not wall-clock waits.

const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 160; // 10 ms

const loud = () => Int16Array.from({ length: FRAME_SAMPLES }, () => 8000);
const quiet = () => new Int16Array(FRAME_SAMPLES);

function pushMany(
  endpointer: PcmEndpointer,
  frame: () => Int16Array,
  count: number,
): EndpointerEvent[] {
  const events: EndpointerEvent[] = [];
  for (let i = 0; i < count; i++) events.push(...endpointer.push(frame()));
  return events;
}

describe('PcmEndpointer', () => {
  it('measures level on the 0..1 scale the tuning thresholds use', () => {
    expect(rms(quiet())).toBe(0);
    expect(rms(loud())).toBeCloseTo(8000 / 32768, 4);
    expect(rms(new Int16Array(0))).toBe(0);
  });

  it('opens an utterance on speech and closes it after the trailing silence', () => {
    const endpointer = new PcmEndpointer(SAMPLE_RATE, {
      endpointSilenceMs: 100,
      speechMinMs: 50,
      prerollMs: 0,
    });
    const opening = pushMany(endpointer, loud, 10); // 100 ms of speech
    expect(opening[0]).toEqual({ type: 'speech_start' });
    expect(opening.filter((e) => e.type === 'frame')).toHaveLength(10);

    const trailing = pushMany(endpointer, quiet, 15); // 150 ms of silence
    expect(trailing.some((e) => e.type === 'speech_end')).toBe(true);
    // Silence inside the utterance is still shipped — the endpoint is where the
    // utterance ends, not where each word does.
    expect(trailing.filter((e) => e.type === 'frame').length).toBeGreaterThan(0);
  });

  it('replays pre-roll so the first syllable is not clipped', () => {
    const endpointer = new PcmEndpointer(SAMPLE_RATE, { prerollMs: 50 });
    pushMany(endpointer, quiet, 20); // 200 ms of room tone, only 50 ms retained
    const events = endpointer.push(loud());

    expect(events[0]).toEqual({ type: 'speech_start' });
    const frames = events.filter((e) => e.type === 'frame');
    // 50 ms of pre-roll (5 frames) plus the frame that crossed the threshold.
    expect(frames).toHaveLength(6);
  });

  it('drops a blip too short to be speech instead of shipping a phantom utterance', () => {
    const endpointer = new PcmEndpointer(SAMPLE_RATE, {
      endpointSilenceMs: 100,
      speechMinMs: 200,
      prerollMs: 0,
    });
    pushMany(endpointer, loud, 5); // 50 ms — a cough
    const events = pushMany(endpointer, quiet, 15);
    expect(events.some((e) => e.type === 'speech_end')).toBe(false);

    // And the detector is ready for the next real utterance.
    const next = pushMany(endpointer, loud, 25);
    expect(next[0]).toEqual({ type: 'speech_start' });
  });

  it('only reports barge-in when it is enabled and sustained', () => {
    const endpointer = new PcmEndpointer(SAMPLE_RATE, {
      bargeThreshold: 0.06,
      bargeSustainMs: 50,
      prerollMs: 0,
    });
    endpointer.setCaptureEnabled(false);

    expect(pushMany(endpointer, loud, 3).some((e) => e.type === 'barge_in')).toBe(false);

    endpointer.setBargeInEnabled(true);
    // 40 ms is not enough...
    expect(pushMany(endpointer, loud, 4).some((e) => e.type === 'barge_in')).toBe(false);
    // ...50 ms is.
    expect(pushMany(endpointer, loud, 1).some((e) => e.type === 'barge_in')).toBe(true);
  });

  it('does not open an utterance while capture is gated off', () => {
    const endpointer = new PcmEndpointer(SAMPLE_RATE, { prerollMs: 100 });
    endpointer.setCaptureEnabled(false);
    expect(pushMany(endpointer, loud, 10)).toEqual([]);

    // The audio captured while gated is still the start of the next utterance,
    // so re-opening capture does not lose the word that triggered barge-in.
    endpointer.setCaptureEnabled(true);
    const events = endpointer.push(loud());
    expect(events[0]).toEqual({ type: 'speech_start' });
    expect(events.filter((e) => e.type === 'frame').length).toBeGreaterThan(1);
  });

  it('forgets a half-captured utterance when capture is gated off mid-word', () => {
    const endpointer = new PcmEndpointer(SAMPLE_RATE, { prerollMs: 0, speechMinMs: 10 });
    pushMany(endpointer, loud, 5);
    endpointer.setCaptureEnabled(false);
    endpointer.setCaptureEnabled(true);
    const events = endpointer.push(loud());
    // A fresh utterance, not a continuation.
    expect(events[0]).toEqual({ type: 'speech_start' });
  });
});
