import { describe, expect, it } from 'vitest';
import { aLawToPcm16, muLawToPcm16, pcm16ToALaw, pcm16ToMuLaw, resamplePcm16 } from '../sip/g711';

/**
 * Round-trip tolerance. G.711 is LOSSY — a test asserting exact equality would
 * be asserting something false about the codec, and would only pass against an
 * implementation that is not G.711. The bounds below are the measured worst
 * case of the ITU tables over the full 16-bit sweep: a relative error inside
 * the mantissa resolution once the signal is loud enough to have one, and an
 * absolute floor for the near-silence segments where the step size dominates.
 */
const MULAW_NEAR_ZERO_STEP = 68;
const MULAW_RELATIVE = 0.04;
const ALAW_NEAR_ZERO_STEP = 33;
const ALAW_RELATIVE = 0.035;

function one(sample: number): Int16Array {
  return Int16Array.from([sample]);
}

describe('G.711 μ-law', () => {
  it('matches the ITU reference points', () => {
    // Digital silence is 0xFF (positive zero); 0x7F is the negative zero.
    expect(muLawToPcm16(Uint8Array.from([0xff]))[0]).toBe(0);
    expect(muLawToPcm16(Uint8Array.from([0x7f]))[0]).toBe(0);
    // Full scale decodes to ±32124, not ±32768 — the top segment's midpoint.
    expect(muLawToPcm16(Uint8Array.from([0x80]))[0]).toBe(32124);
    expect(muLawToPcm16(Uint8Array.from([0x00]))[0]).toBe(-32124);

    expect(pcm16ToMuLaw(one(0))[0]).toBe(0xff);
    expect(pcm16ToMuLaw(one(32767))[0]).toBe(0x80);
    expect(pcm16ToMuLaw(one(-32768))[0]).toBe(0x00);
    // A mid-scale value: 1000 sits in segment 5 and encodes to 0xCE.
    expect(pcm16ToMuLaw(one(1000))[0]).toBe(0xce);
    expect(pcm16ToMuLaw(one(-1000))[0]).toBe(0x4e);
  });

  it('round-trips inside G.711 quantization error, not exactly', () => {
    for (let sample = -32768; sample < 32767; sample += 37) {
      const back = muLawToPcm16(pcm16ToMuLaw(one(sample)))[0] ?? 0;
      const tolerance = Math.max(MULAW_NEAR_ZERO_STEP, Math.abs(sample) * MULAW_RELATIVE);
      expect(Math.abs(back - sample)).toBeLessThanOrEqual(tolerance);
    }
  });

  it('encodes and decodes whole buffers one byte per sample', () => {
    const samples = Int16Array.from([0, 1000, -1000, 20000, -20000]);
    const encoded = pcm16ToMuLaw(samples);
    expect(encoded.length).toBe(samples.length);
    expect(muLawToPcm16(encoded).length).toBe(samples.length);
  });
});

describe('G.711 A-law', () => {
  it('matches the ITU reference points', () => {
    // A-law has NO exact zero: 0xD5 is the code silence encodes to, and it
    // decodes to ±8. That is the codec, not a bug in this implementation.
    expect(pcm16ToALaw(one(0))[0]).toBe(0xd5);
    expect(aLawToPcm16(Uint8Array.from([0xd5]))[0]).toBe(8);
    expect(aLawToPcm16(Uint8Array.from([0x55]))[0]).toBe(-8);
    expect(aLawToPcm16(Uint8Array.from([0xaa]))[0]).toBe(32256);
    expect(aLawToPcm16(Uint8Array.from([0x2a]))[0]).toBe(-32256);

    expect(pcm16ToALaw(one(32767))[0]).toBe(0xaa);
    expect(pcm16ToALaw(one(-32768))[0]).toBe(0x2a);
    expect(pcm16ToALaw(one(1000))[0]).toBe(0xfa);
    expect(pcm16ToALaw(one(-1000))[0]).toBe(0x7a);
  });

  it('round-trips inside G.711 quantization error, not exactly', () => {
    for (let sample = -32768; sample < 32767; sample += 37) {
      const back = aLawToPcm16(pcm16ToALaw(one(sample)))[0] ?? 0;
      const tolerance = Math.max(ALAW_NEAR_ZERO_STEP, Math.abs(sample) * ALAW_RELATIVE);
      expect(Math.abs(back - sample)).toBeLessThanOrEqual(tolerance);
    }
  });
});

describe('resamplePcm16', () => {
  it('doubles the frame going 8k -> 16k and halves it coming back', () => {
    const eightK = Int16Array.from([100, 200, 300, 400]);
    expect(resamplePcm16(eightK, 8000, 16_000).length).toBe(8);
    expect(resamplePcm16(Int16Array.from([1, 2, 3, 4, 5, 6, 7, 8]), 16_000, 8000).length).toBe(4);
  });

  it('leaves a constant signal unchanged in both directions', () => {
    const flat = new Int16Array(64).fill(1234);
    const up = resamplePcm16(flat, 8000, 16_000);
    expect([...up]).toEqual(new Array(128).fill(1234));
    const down = resamplePcm16(flat, 24_000, 8000);
    expect([...down]).toEqual(new Array(21).fill(1234));
  });

  it('interpolates between neighbours rather than repeating the nearest sample', () => {
    // The whole reason this is not the nearest-sample resampler next door: the
    // inserted sample is the MIDPOINT, not a copy of its left neighbour.
    const up = resamplePcm16(Int16Array.from([0, 1000]), 8000, 16_000);
    expect(up[0]).toBe(0);
    expect(up[1]).toBe(500);
  });

  it('returns the input untouched when the rates already match', () => {
    const same = Int16Array.from([1, 2, 3]);
    expect(resamplePcm16(same, 16_000, 16_000)).toBe(same);
  });

  it('refuses a non-positive rate', () => {
    expect(() => resamplePcm16(Int16Array.from([1]), 0, 8000)).toThrow(/positive/);
  });
});
