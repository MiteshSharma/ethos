// Captured frames → one buffer a batch STT provider will accept.
//
// WHY IT LIVES HERE AND NOT IN THE HOST. An edge-STT node transcribes the SAME
// utterance the gateway would otherwise have transcribed, and the gateway's
// lane already encodes it one way (`encodeWav` on the accumulated `PcmChunk`s
// in `finishUtterance`). Two encoders would be two chances for "the same words
// through the two paths" to stop meaning the same thing — a different header, a
// different rate, a provider that accepts one and not the other. So this is a
// thin adapter over THAT encoder, and the host holds no audio format knowledge
// at all.
//
// No audio library is involved: `encodeWav` is 44 bytes of header and a sample
// copy, pure and in-memory, so the package's headless-safe import doctrine is
// untouched.

import { encodeWav } from '@ethosagent/voice-session';
import type { WakeFrame } from './wake-engine';

/**
 * Encode one captured utterance as 16-bit mono WAV.
 *
 * `fallbackSampleRate` is used only for an EMPTY utterance — every frame
 * carries its own rate, and the encoder takes the first one, because a capture
 * session does not change rate mid-utterance.
 */
export function encodeUtteranceWav(
  frames: readonly WakeFrame[],
  fallbackSampleRate: number,
): Uint8Array {
  return encodeWav(
    frames.map((frame) => ({ data: frame.samples, sampleRate: frame.sampleRate })),
    fallbackSampleRate,
  );
}
