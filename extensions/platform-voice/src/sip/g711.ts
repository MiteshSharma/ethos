// G.711 companding and the rate conversion a phone leg needs.
//
// A PSTN leg is 8 kHz narrowband, usually carried as G.711 μ-law (North
// America, Japan) or A-law (everywhere else). A realtime provider speaks 16 kHz
// in and 24 kHz out, in linear PCM16. Something has to sit between them, and it
// is this file: the tables below are the ITU-T G.711 reference implementation
// (the Sun `g711.c` form, which is the one every telephony stack agrees with),
// not an approximation — a codec that is 99% right produces audio that is
// audibly wrong on every sample.
//
// Deliberately dependency-free and allocation-per-call: these run on the audio
// hot path, once per 20 ms frame, and a frame is 160 samples. There is nothing
// here worth a library.

/** Segment shift/masks shared by both companding laws (ITU-T G.711). */
const SEG_SHIFT = 4;
const SEG_MASK = 0x70;
const QUANT_MASK = 0x0f;
const SIGN_BIT = 0x80;

/** μ-law works in a 14-bit domain with a bias; A-law in a 13-bit domain. */
const MULAW_BIAS = 0x84;
const MULAW_CLIP = 8159;
const MULAW_SEG_END = [0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff];
const ALAW_SEG_END = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];

/** First segment whose upper bound contains `value`; `ends.length` when none does. */
function segment(value: number, ends: readonly number[]): number {
  for (let i = 0; i < ends.length; i++) {
    if (value <= (ends[i] ?? 0)) return i;
  }
  return ends.length;
}

// --- μ-law -----------------------------------------------------------------

function encodeMuLawSample(sample: number): number {
  let value = sample >> 2;
  let mask: number;
  if (value < 0) {
    value = -value;
    mask = 0x7f;
  } else {
    mask = 0xff;
  }
  if (value > MULAW_CLIP) value = MULAW_CLIP;
  value += MULAW_BIAS >> 2;
  const seg = segment(value, MULAW_SEG_END);
  if (seg >= MULAW_SEG_END.length) return (0x7f ^ mask) & 0xff;
  return (((seg << SEG_SHIFT) | ((value >> (seg + 1)) & QUANT_MASK)) ^ mask) & 0xff;
}

function decodeMuLawSample(byte: number): number {
  const u = ~byte & 0xff;
  let t = ((u & QUANT_MASK) << 3) + MULAW_BIAS;
  t <<= (u & SEG_MASK) >> SEG_SHIFT;
  return (u & SIGN_BIT) !== 0 ? MULAW_BIAS - t : t - MULAW_BIAS;
}

/** Decode G.711 μ-law bytes to linear PCM16. One byte in, one sample out. */
export function muLawToPcm16(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = decodeMuLawSample(bytes[i] ?? 0);
  return out;
}

/** Encode linear PCM16 to G.711 μ-law. Lossy by design — see the round-trip test. */
export function pcm16ToMuLaw(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = encodeMuLawSample(samples[i] ?? 0);
  return out;
}

// --- A-law -----------------------------------------------------------------

function encodeALawSample(sample: number): number {
  let value = sample >> 3;
  let mask: number;
  if (value >= 0) {
    mask = 0xd5;
  } else {
    mask = 0x55;
    value = -value - 1;
  }
  const seg = segment(value, ALAW_SEG_END);
  if (seg >= ALAW_SEG_END.length) return (0x7f ^ mask) & 0xff;
  const quant = seg < 2 ? (value >> 1) & QUANT_MASK : (value >> seg) & QUANT_MASK;
  return (((seg << SEG_SHIFT) | quant) ^ mask) & 0xff;
}

function decodeALawSample(byte: number): number {
  const a = (byte ^ 0x55) & 0xff;
  let t = (a & QUANT_MASK) << 4;
  const seg = (a & SEG_MASK) >> SEG_SHIFT;
  if (seg === 0) {
    t += 8;
  } else if (seg === 1) {
    t += 0x108;
  } else {
    t += 0x108;
    t <<= seg - 1;
  }
  return (a & SIGN_BIT) !== 0 ? t : -t;
}

/** Decode G.711 A-law bytes to linear PCM16. */
export function aLawToPcm16(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = decodeALawSample(bytes[i] ?? 0);
  return out;
}

/** Encode linear PCM16 to G.711 A-law. Lossy by design; A-law has no exact zero. */
export function pcm16ToALaw(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = encodeALawSample(samples[i] ?? 0);
  return out;
}

// --- rate conversion -------------------------------------------------------

/**
 * Linear-interpolating resampler.
 *
 * NOT the nearest-sample decimation in `../livekit/transport.ts`. That one is
 * fine for its job — 48 kHz → 16 kHz is an integer factor, where nearest-sample
 * IS decimation and the discarded samples are the only loss. A phone leg is a
 * different problem: 8 kHz ↔ 16/24 kHz is a 2× or 3× ratio in BOTH directions,
 * and on the upsampling leg nearest-sample holds each source sample flat across
 * two or three output samples. That zero-order hold is a rectangular window,
 * whose spectrum smears the narrowband content into audible aliasing — a
 * metallic edge on every voiced sound, on the one leg where the listener is
 * already down to 3.4 kHz of bandwidth and has none to spare. Interpolating
 * between neighbours costs one multiply per sample and removes it.
 *
 * Still not a proper polyphase filter with an anti-alias stage: on the
 * DOWNsampling leg (24 kHz → 8 kHz) content above 4 kHz folds back, because
 * nothing here low-passes first. The provider is speaking, not transmitting
 * music, and its energy above 4 kHz is small — but this is the known limit of
 * this function, and the place to fix it if a call ever sounds harsh.
 */
export function resamplePcm16(samples: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate <= 0 || toRate <= 0) {
    throw new Error('resamplePcm16: sample rates must be positive');
  }
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = fromRate / toRate;
  // Round, not floor: 8 kHz → 16 kHz must DOUBLE the frame, and a floor would
  // shorten every odd-length frame by a sample, which is a slow drift.
  const outLength = Math.max(1, Math.round(samples.length / ratio));
  const out = new Int16Array(outLength);
  const lastIndex = samples.length - 1;
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const low = Math.min(lastIndex, Math.floor(pos));
    const high = Math.min(lastIndex, low + 1);
    const frac = pos - low;
    const a = samples[low] ?? 0;
    const b = samples[high] ?? 0;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}
