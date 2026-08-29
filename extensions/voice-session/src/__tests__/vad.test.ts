import { describe, expect, it } from 'vitest';
import { EnergyVad, rmsEnergy } from '../vad';
import { silenceFrame, speechFrame } from './fakes';

describe('rmsEnergy', () => {
  it('is zero for silence and positive for a loud frame', () => {
    expect(rmsEnergy(silenceFrame().data)).toBe(0);
    expect(rmsEnergy(speechFrame().data)).toBeGreaterThan(0.02);
  });
});

describe('EnergyVad', () => {
  it('classifies a loud frame as speech and a silent frame as not', () => {
    const vad = new EnergyVad({ threshold: 0.02, hangoverFrames: 0 });
    expect(vad.process(speechFrame()).speech).toBe(true);
    expect(vad.process(silenceFrame()).speech).toBe(false);
  });

  it('keeps speech alive for the hangover window', () => {
    const vad = new EnergyVad({ threshold: 0.02, hangoverFrames: 2 });
    expect(vad.process(speechFrame()).speech).toBe(true);
    // Two trailing silence frames stay "speech" via hangover, then drop.
    expect(vad.process(silenceFrame()).speech).toBe(true);
    expect(vad.process(silenceFrame()).speech).toBe(true);
    expect(vad.process(silenceFrame()).speech).toBe(false);
  });
});

describe('EnergyVad minSpeechMs', () => {
  it('never reports speech below the threshold, however long the burst', () => {
    const vad = new EnergyVad({ threshold: 0.02, minSpeechMs: 60, frameMs: 20 });
    for (let i = 0; i < 20; i++) expect(vad.process(silenceFrame()).speech).toBe(false);
  });

  it('ignores a burst shorter than minSpeechMs — the bang, not the voice', () => {
    const vad = new EnergyVad({ threshold: 0.02, minSpeechMs: 60, frameMs: 20 });
    expect(vad.process(speechFrame()).speech).toBe(false);
    expect(vad.process(speechFrame()).speech).toBe(false);
    // The burst ends before it earns speech, and the arming resets.
    expect(vad.process(silenceFrame()).speech).toBe(false);
    expect(vad.process(speechFrame()).speech).toBe(false);
    expect(vad.process(speechFrame()).speech).toBe(false);
  });

  it('reports speech at exactly minSpeechMs', () => {
    const vad = new EnergyVad({ threshold: 0.02, minSpeechMs: 60, frameMs: 20 });
    expect(vad.process(speechFrame()).speech).toBe(false);
    expect(vad.process(speechFrame()).speech).toBe(false);
    expect(vad.process(speechFrame()).speech).toBe(true);
  });

  it('still smooths intra-word gaps once armed', () => {
    const vad = new EnergyVad({
      threshold: 0.02,
      hangoverFrames: 2,
      minSpeechMs: 40,
      frameMs: 20,
    });
    expect(vad.process(speechFrame()).speech).toBe(false);
    expect(vad.process(speechFrame()).speech).toBe(true);
    // A gap inside a word rides the hangover WITHOUT re-arming: making the
    // speaker re-earn minSpeechMs after every consonant would break the very
    // smoothing hangover exists to provide.
    expect(vad.process(silenceFrame()).speech).toBe(true);
    expect(vad.process(speechFrame()).speech).toBe(true);
    expect(vad.process(silenceFrame()).speech).toBe(true);
    expect(vad.process(silenceFrame()).speech).toBe(true);
    expect(vad.process(silenceFrame()).speech).toBe(false);
  });

  it('is a strict no-op by default', () => {
    const vad = new EnergyVad({ threshold: 0.02, hangoverFrames: 0 });
    expect(vad.process(speechFrame()).speech).toBe(true);
    expect(vad.process(silenceFrame()).speech).toBe(false);
  });

  it('counts frameMs per frame, so the knob is in milliseconds not frames', () => {
    const coarse = new EnergyVad({ threshold: 0.02, minSpeechMs: 60, frameMs: 30 });
    expect(coarse.process(speechFrame()).speech).toBe(false);
    expect(coarse.process(speechFrame()).speech).toBe(true);
  });
});
