// Minimal 16-bit mono WAV encoder for buffered utterances.
//
// A batch STT provider takes a complete utterance, so the utterance-buffered
// fallback has to hand it the captured PCM frames as something a provider can
// post. WAV is the least-surprising container: every
// `POST /audio/transcriptions`-shaped server accepts it, it needs no codec,
// and the header is 44 fixed bytes.
//
// Pure and in-memory: it returns BYTES, not a path. Nothing here (or in the
// fallback that calls it) touches the filesystem — that is what makes
// `VoiceSession` construction total for any configured provider.

import type { PcmChunk } from '@ethosagent/types';

const HEADER_BYTES = 44;

/**
 * Encode captured PCM frames as a 16-bit mono WAV. The sample rate is taken
 * from the first chunk (a capture session does not change rate mid-utterance);
 * an empty input yields a valid, empty WAV rather than a throw, so a spurious
 * endpoint can never crash a live session.
 */
export function encodeWav(chunks: readonly PcmChunk[], fallbackSampleRate = 16_000): Uint8Array {
  const sampleRate = chunks[0]?.sampleRate ?? fallbackSampleRate;
  let sampleCount = 0;
  for (const chunk of chunks) sampleCount += chunk.data.length;

  const dataBytes = sampleCount * 2;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (mono, 2 bytes/sample)
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = HEADER_BYTES;
  for (const chunk of chunks) {
    for (const sample of chunk.data) {
      view.setInt16(offset, sample, true);
      offset += 2;
    }
  }

  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}
