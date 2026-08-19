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
    expect(splitFrame(1, bytes).ok).toBe(true);
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
    const bytes = encodeVoiceFrame({ t: 'hello', sessionId: 'u1' });
    expect(bytes[0]).toBe(VOICE_SOCKET_VERSION);
    expect(splitFrame(VOICE_SOCKET_VERSION, bytes).ok).toBe(true);
    expect(splitFrame(VOICE_SOCKET_VERSION + 1, bytes).ok).toBe(false);
  });

  it('names the framing fault rather than throwing, on every malformed input', () => {
    // Each of these is a DIFFERENT bug on the far side — a sender writing text
    // frames, a proxy truncating a message, a build on another framing version
    // — and a codec that answered `null` to all four made them one bug report.
    const reasonFor = (bytes: Uint8Array): string => {
      const split = splitFrame(1, bytes);
      return split.ok ? 'decoded' : split.reason;
    };
    expect(reasonFor(new Uint8Array([]))).toBe('frame is 0 bytes, shorter than the 3-byte prefix');
    expect(reasonFor(new Uint8Array([1, 0]))).toBe(
      'frame is 2 bytes, shorter than the 3-byte prefix',
    );
    expect(reasonFor(new Uint8Array([1, 0, 40]))).toBe('header claims 40 bytes but only 0 arrived');
    // Header bytes present, but not JSON.
    expect(reasonFor(new Uint8Array([1, 0, 2, 0x7b, 0x74]))).toBe('the 2-byte header is not JSON');
    expect(reasonFor(new Uint8Array([9, 0, 0]))).toBe('framing version 9, and this lane speaks 1');
  });

  it('hands the header back as an unparsed value, leaving schema work to the lane', () => {
    const split = splitFrame(1, encodeFrame(1, { anything: true }));
    expect(split.ok && split.header).toEqual({ anything: true });
    expect(split.ok && split.payload.length).toBe(0);
  });
});
