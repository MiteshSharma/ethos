import { describe, expect, it } from 'vitest';
import {
  decodeVoiceClientFrame,
  decodeVoiceServerFrame,
  encodeVoiceFrame,
  pcm16FromBytes,
  pcm16ToBytes,
  VOICE_SOCKET_VERSION,
} from '../voice-socket';

describe('voice socket framing', () => {
  it('round-trips a control frame with no payload', () => {
    const bytes = encodeVoiceFrame({ t: 'utterance_end', utteranceId: 'u1' });
    const decoded = decodeVoiceClientFrame(bytes);
    expect(decoded?.header).toEqual({ t: 'utterance_end', utteranceId: 'u1' });
    expect(decoded?.payload.length).toBe(0);
  });

  it('round-trips a PCM audio frame with its header intact', () => {
    const samples = Int16Array.from([0, 1, -1, 32767, -32768, 1234]);
    const bytes = encodeVoiceFrame(
      { t: 'audio', utteranceId: 'u7', seq: 3 },
      pcm16ToBytes(samples),
    );
    const decoded = decodeVoiceClientFrame(bytes);
    expect(decoded?.header).toEqual({ t: 'audio', utteranceId: 'u7', seq: 3 });
    expect(Array.from(pcm16FromBytes(decoded?.payload ?? new Uint8Array()))).toEqual(
      Array.from(samples),
    );
  });

  it('reads a payload that lands at a non-zero, odd byte offset', () => {
    // A WebSocket payload is a view into a larger buffer far more often than
    // not; `new Int16Array(buf, oddOffset)` would throw on exactly this.
    const backing = new Uint8Array(9);
    backing.set(pcm16ToBytes(Int16Array.from([7, -7, 300])), 3);
    const view = backing.subarray(3, 9);
    expect(Array.from(pcm16FromBytes(view))).toEqual([7, -7, 300]);
  });

  it('drops a trailing odd byte instead of throwing', () => {
    expect(Array.from(pcm16FromBytes(new Uint8Array([1, 0, 2])))).toEqual([1]);
  });

  it('round-trips a server audio frame', () => {
    const bytes = encodeVoiceFrame(
      {
        t: 'audio',
        utteranceId: 'u1',
        segmentId: 's0',
        seq: 0,
        codec: 'encoded',
        mimeType: 'audio/ogg;codecs=opus',
        provider: 'local-tts',
      },
      new Uint8Array([1, 2, 3]),
    );
    const decoded = decodeVoiceServerFrame(bytes);
    expect(decoded?.header.t).toBe('audio');
    expect(Array.from(decoded?.payload ?? [])).toEqual([1, 2, 3]);
  });

  it('rejects a frame whose header does not match the contract', () => {
    const bogus = encodeVoiceFrame({ t: 'utterance_end', utteranceId: 'u1' });
    // A server frame decoder must not accept a client frame.
    expect(decodeVoiceServerFrame(bogus)).toBeNull();
    // Neither should garbage, a truncated frame, or a wrong version.
    expect(decodeVoiceClientFrame(new Uint8Array([VOICE_SOCKET_VERSION, 0, 40]))).toBeNull();
    expect(decodeVoiceClientFrame(new Uint8Array([99, 0, 0]))).toBeNull();
    expect(decodeVoiceClientFrame(new Uint8Array([]))).toBeNull();
  });

  it('rejects a header that is valid JSON but an unknown type', () => {
    const raw = new TextEncoder().encode(JSON.stringify({ t: 'exec', cmd: 'rm -rf /' }));
    const frame = new Uint8Array(3 + raw.length);
    frame[0] = VOICE_SOCKET_VERSION;
    frame[2] = raw.length;
    frame.set(raw, 3);
    expect(decodeVoiceClientFrame(frame)).toBeNull();
  });
});
