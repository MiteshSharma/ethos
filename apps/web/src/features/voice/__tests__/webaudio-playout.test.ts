import { describe, expect, it, vi } from 'vitest';
import { AbsolutePlayout } from '../webaudio-playout';
import { FakePlayoutContext } from './fake-playout-context';

// Absolute-time pacing, asserted as arithmetic on the audio clock. The failure
// mode being defended against is a scheduler that says "play this 100ms from
// now" per chunk: each hop inherits the previous hop's lateness, so a long call
// drifts and warbles. Here every start time is derived from the PREVIOUS start
// time, so lateness cannot accumulate.

const LEAD = 0.05;
/** 1600 samples at 16 kHz = exactly 100 ms. */
const frame = () => new Int16Array(1600);

describe('AbsolutePlayout — absolute-time pacing', () => {
  it('schedules consecutive frames back-to-back on the audio clock', () => {
    const ctx = new FakePlayoutContext();
    const playout = new AbsolutePlayout(ctx, { leadSeconds: LEAD });

    playout.playPcm16(frame(), 16_000);
    playout.playPcm16(frame(), 16_000);
    playout.playPcm16(frame(), 16_000);

    expect(ctx.starts.map((s) => s.at)).toEqual([LEAD, LEAD + 0.1, LEAD + 0.2]);
  });

  it('does not drift when frames arrive late and irregularly', () => {
    const ctx = new FakePlayoutContext();
    const playout = new AbsolutePlayout(ctx, { leadSeconds: LEAD });

    // Frames arrive at jittery wall-clock moments — network jitter — but each
    // one still lands where the previous one ended, to the sample.
    const arrivals = [0, 0.031, 0.084, 0.098, 0.137];
    for (const at of arrivals) {
      ctx.currentTime = at;
      playout.playPcm16(frame(), 16_000);
    }

    const expected = [LEAD, LEAD + 0.1, LEAD + 0.2, LEAD + 0.3, LEAD + 0.4];
    for (const [i, start] of ctx.starts.entries()) {
      expect(start.at).toBeCloseTo(expected[i] ?? 0, 10);
    }
    // Zero gap between consecutive frames: end of N is start of N+1.
    for (let i = 1; i < ctx.starts.length; i++) {
      const previous = ctx.starts[i - 1];
      expect(ctx.starts[i]?.at).toBeCloseTo((previous?.at ?? 0) + (previous?.duration ?? 0), 10);
    }
  });

  it('never schedules in the past after the queue runs dry', () => {
    const ctx = new FakePlayoutContext();
    const playout = new AbsolutePlayout(ctx, { leadSeconds: LEAD });

    playout.playPcm16(frame(), 16_000);
    expect(playout.speaking).toBe(true);

    // Long silence: playout finished ages ago. The next frame must be placed
    // ahead of the clock, not at a stale cursor the browser would treat as
    // "play immediately, on top of whatever is sounding".
    ctx.currentTime = 12;
    expect(playout.speaking).toBe(false);
    playout.playPcm16(frame(), 16_000);
    expect(ctx.starts[1]?.at).toBe(12 + LEAD);
  });

  it('schedules decoded segments in arrival order even if decoding finishes out of order', async () => {
    const ctx = new FakePlayoutContext();
    const playout = new AbsolutePlayout(ctx, { leadSeconds: LEAD });

    const first = playout.playEncoded(new Uint8Array([1]));
    const second = playout.playEncoded(new Uint8Array([2]));
    await Promise.resolve();
    // The chain means decode #2 is not even requested until #1 resolves, so a
    // fast second decode can never overtake a slow first one.
    expect(ctx.pendingDecodes).toBe(1);

    ctx.resolveDecode(0, 0.4);
    await first;
    await vi.waitFor(() => expect(ctx.pendingDecodes).toBe(2));
    ctx.resolveDecode(1, 0.25);
    await second;

    expect(ctx.starts.map((s) => s.at)).toEqual([LEAD, LEAD + 0.4]);
  });

  it('stop() halts live sources and resets the timeline for the next turn', () => {
    const ctx = new FakePlayoutContext();
    const playout = new AbsolutePlayout(ctx, { leadSeconds: LEAD });
    playout.playPcm16(frame(), 16_000);
    playout.playPcm16(frame(), 16_000);

    playout.stop();
    expect(ctx.stopped).toHaveLength(2);
    expect(playout.speaking).toBe(false);

    ctx.currentTime = 5;
    playout.playPcm16(frame(), 16_000);
    expect(ctx.starts[2]?.at).toBe(5 + LEAD);
  });

  it('keeps scheduling after a failed decode', async () => {
    const ctx = new FakePlayoutContext();
    ctx.decodeAudioData = () => Promise.reject(new Error('bad container'));
    const playout = new AbsolutePlayout(ctx, { leadSeconds: LEAD });

    await expect(playout.playEncoded(new Uint8Array([1]))).rejects.toThrow('bad container');
    // The queue is not poisoned — PCM still schedules.
    expect(playout.playPcm16(frame(), 16_000)).toBeGreaterThan(0);
  });
});

// The agent's own speaking level. It exists for exactly one reason — the call
// overlay's speaking state is amplitude-driven (DESIGN.md § "Call overlay") —
// and the only place it can be measured is between the scheduled sources and
// the destination, which is why the analyser lives on this graph.
describe('AbsolutePlayout — output level', () => {
  it('routes every scheduled source through the analyser, not the destination', () => {
    const ctx = new FakePlayoutContext();
    const playout = new AbsolutePlayout(ctx, { leadSeconds: LEAD });

    playout.playPcm16(frame(), 16_000);
    playout.playPcm16(frame(), 16_000);

    expect(ctx.connectedTo).toEqual([ctx.analyser, ctx.analyser]);
    // …and the analyser is what reaches the speakers.
    expect(ctx.analyser.connected).toEqual([ctx.destination]);
  });

  it('reports zero while nothing is scheduled, whatever the analyser holds', () => {
    const ctx = new FakePlayoutContext();
    const playout = new AbsolutePlayout(ctx, { leadSeconds: LEAD });
    ctx.analyser.bins = [255, 255, 255, 255];

    // Silence is silence: an analyser still decaying after the last buffer must
    // not keep the shape talking.
    expect(playout.outputLevel()).toBe(0);
  });

  it('smooths towards the analyser reading while audio is scheduled', () => {
    const ctx = new FakePlayoutContext();
    const playout = new AbsolutePlayout(ctx, { leadSeconds: LEAD });
    ctx.analyser.bins = [255, 255, 255, 255];
    playout.playPcm16(frame(), 16_000);

    const first = playout.outputLevel();
    const second = playout.outputLevel();
    const third = playout.outputLevel();

    // One low-pass step per read: rising, never a jump to the raw value.
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    expect(third).toBeLessThan(1);
  });

  it('resets the level on stop, so barge-in silences the shape too', () => {
    const ctx = new FakePlayoutContext();
    const playout = new AbsolutePlayout(ctx, { leadSeconds: LEAD });
    ctx.analyser.bins = [255, 255, 255, 255];
    playout.playPcm16(frame(), 16_000);
    expect(playout.outputLevel()).toBeGreaterThan(0);

    playout.stop();
    expect(playout.outputLevel()).toBe(0);
  });
});
