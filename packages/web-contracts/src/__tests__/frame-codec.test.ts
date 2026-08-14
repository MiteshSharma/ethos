import { describe, expect, it } from 'vitest';
import { encodeFrame, FRAME_HEADER_OFFSET, splitFrame } from '../frame-codec';
import { encodeVoiceFrame, VOICE_SOCKET_VERSION } from '../voice-socket';

// The codec was EXTRACTED from `voice-socket.ts`, which means the interesting
// property is not that it works but that it produces the same bytes it did
// before. These assertions are pinned to the layout, not to the implementation,
// so a future refactor of the codec cannot quietly re-frame a live lane.

describe('frame codec', () => {
  it('lays a frame out as ver:u8 | headerLen:u16be | header | payload', () => {
    const bytes = encodeFrame(7, { t: 'x' }, new Uint8Array([9, 9]));
    const headerText = JSON.stringify({ t: 'x' });
    expect(bytes[0]).toBe(7);
    expect(((bytes[1] ?? 0) << 8) | (bytes[2] ?? 0)).toBe(headerText.length);
    expect(new TextDecoder().decode(bytes.subarray(3, 3 + headerText.length))).toBe(headerText);
    expect(Array.from(bytes.subarray(3 + headerText.length))).toEqual([9, 9]);
    expect(FRAME_HEADER_OFFSET).toBe(3);
  });

  it('writes the header length big-endian for a header past 255 bytes', () => {
    // The one byte-order bug a copy of this codec would plausibly introduce.
    const bytes = encodeFrame(1, { t: 'x', pad: 'p'.repeat(400) });
    const headerLen = ((bytes[1] ?? 0) << 8) | (bytes[2] ?? 0);
    expect(headerLen).toBeGreaterThan(0xff);
    expect(bytes[1]).toBe((headerLen >> 8) & 0xff);
    expect(splitFrame(1, bytes)).not.toBeNull();
  });

  it('still throws when a header exceeds the u16 length field', () => {
    // Behaviour `encodeVoiceFrame` had before the extraction, exercised through
    // the wrapper that kept the promise.
    expect(() =>
      encodeVoiceFrame({
        t: 'transcript',
        utteranceId: 'u1',
        text: 'x'.repeat(70_000),
        final: true,
      }),
    ).toThrow(/64 KiB/);
  });

  it('stamps the caller-supplied version, and refuses any other on decode', () => {
    const bytes = encodeVoiceFrame({ t: 'utterance_end', utteranceId: 'u1' });
    expect(bytes[0]).toBe(VOICE_SOCKET_VERSION);
    expect(splitFrame(VOICE_SOCKET_VERSION, bytes)).not.toBeNull();
    expect(splitFrame(VOICE_SOCKET_VERSION + 1, bytes)).toBeNull();
  });

  it('returns null rather than throwing on every malformed input', () => {
    expect(splitFrame(1, new Uint8Array([]))).toBeNull();
    expect(splitFrame(1, new Uint8Array([1, 0]))).toBeNull();
    expect(splitFrame(1, new Uint8Array([1, 0, 40]))).toBeNull();
    // Header bytes present, but not JSON.
    expect(splitFrame(1, new Uint8Array([1, 0, 2, 0x7b, 0x74]))).toBeNull();
  });

  it('hands the header back as an unparsed value, leaving schema work to the lane', () => {
    const split = splitFrame(1, encodeFrame(1, { anything: true }));
    expect(split?.header).toEqual({ anything: true });
    expect(split?.payload.length).toBe(0);
  });
});
