import type { PcmChunk } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { encodeWav } from '../wav';

function chunk(samples: number[], sampleRate = 16_000): PcmChunk {
  return { data: Int16Array.from(samples), sampleRate };
}

function ascii(bytes: Uint8Array, offset: number, len: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + len));
}

describe('encodeWav', () => {
  it('writes a 44-byte RIFF/WAVE header followed by the samples', () => {
    const wav = encodeWav([chunk([1, -1, 32767])]);
    expect(wav.byteLength).toBe(44 + 6);
    expect(ascii(wav, 0, 4)).toBe('RIFF');
    expect(ascii(wav, 8, 4)).toBe('WAVE');
    expect(ascii(wav, 12, 4)).toBe('fmt ');
    expect(ascii(wav, 36, 4)).toBe('data');

    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint32(4, true)).toBe(36 + 6);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(40, true)).toBe(6); // data bytes
    expect(view.getInt16(44, true)).toBe(1);
    expect(view.getInt16(46, true)).toBe(-1);
    expect(view.getInt16(48, true)).toBe(32767);
  });

  it('concatenates every frame of the utterance in order', () => {
    const wav = encodeWav([chunk([1, 2]), chunk([3]), chunk([4, 5])]);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const samples = [0, 1, 2, 3, 4].map((i) => view.getInt16(44 + i * 2, true));
    expect(samples).toEqual([1, 2, 3, 4, 5]);
  });

  it('takes the sample rate from the captured audio', () => {
    const wav = encodeWav([chunk([1], 48_000)]);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint32(28, true)).toBe(96_000); // byte rate
  });

  it('produces a valid empty WAV rather than throwing on no audio', () => {
    const wav = encodeWav([]);
    expect(wav.byteLength).toBe(44);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint32(40, true)).toBe(0);
    expect(view.getUint32(24, true)).toBe(16_000); // fallback rate
  });
});
