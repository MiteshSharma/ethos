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
    const bytes = encodeVoiceFrame({ t: 'hello', sessionId: 'u1' });
    const decoded = decodeVoiceClientFrame(bytes);
    expect(decoded?.header).toEqual({ t: 'hello', sessionId: 'u1' });
    expect(decoded?.payload.length).toBe(0);
  });

  it('round-trips a PCM audio frame with its header intact', () => {
    const samples = Int16Array.from([0, 1, -1, 32767, -32768, 1234]);
    const bytes = encodeVoiceFrame({ t: 'audio', seq: 3 }, pcm16ToBytes(samples));
    const decoded = decodeVoiceClientFrame(bytes);
    expect(decoded?.header).toEqual({ t: 'audio', seq: 3 });
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

  it('round-trips the budget wind-down frame, reason and all', () => {
    const bytes = encodeVoiceFrame({
      t: 'realtime_wind_down',
      text: 'That’s the spending limit for this call.',
      reason: 'budget',
    });
    expect(decodeVoiceServerFrame(bytes)?.header).toEqual({
      t: 'realtime_wind_down',
      text: 'That’s the spending limit for this call.',
      reason: 'budget',
    });
  });

  it('refuses a wind-down with no line to say, and one with an unknown reason', () => {
    // A wind-down whose text is empty would end the call in silence — the
    // dropped stream the frame exists to prevent.
    const empty = encodeVoiceFrame({
      t: 'realtime_wind_down',
      text: '',
      reason: 'budget',
    } as never);
    expect(decodeVoiceServerFrame(empty)).toBeNull();
    const wrongReason = encodeVoiceFrame({
      t: 'realtime_wind_down',
      text: 'bye',
      reason: 'boredom',
    } as never);
    expect(decodeVoiceServerFrame(wrongReason)).toBeNull();
  });

  it('rejects a frame whose header does not match the contract', () => {
    const bogus = encodeVoiceFrame({ t: 'hello', sessionId: 'u1' });
    // A server frame decoder must not accept a client frame.
    expect(decodeVoiceServerFrame(bogus)).toBeNull();
    // Neither should garbage, a truncated frame, or a wrong version.
    expect(decodeVoiceClientFrame(new Uint8Array([VOICE_SOCKET_VERSION, 0, 40]))).toBeNull();
    expect(decodeVoiceClientFrame(new Uint8Array([99, 0, 0]))).toBeNull();
    expect(decodeVoiceClientFrame(new Uint8Array([]))).toBeNull();
  });

  it('round-trips a realtime turn-latency report', () => {
    const bytes = encodeVoiceFrame({
      t: 'realtime_turn_latency',
      turnId: 'turn-1',
      firstAudioMs: 640,
    });
    expect(decodeVoiceClientFrame(bytes)?.header).toEqual({
      t: 'realtime_turn_latency',
      turnId: 'turn-1',
      firstAudioMs: 640,
    });
  });

  it('refuses a latency report that is not a finite, non-negative duration', () => {
    // The page is the only place this number can be measured, which is exactly
    // why it is parsed rather than trusted: a negative duration would land in
    // the same store the latency budget is read back from.
    const negative = encodeVoiceFrame({
      t: 'realtime_turn_latency',
      turnId: 'turn-1',
      firstAudioMs: -1,
    });
    expect(decodeVoiceClientFrame(negative)).toBeNull();

    // NaN and Infinity do not survive JSON — they arrive as `null`, which the
    // schema must refuse too rather than coercing to zero.
    const nulled = new TextEncoder().encode(
      JSON.stringify({ t: 'realtime_turn_latency', turnId: 'turn-1', firstAudioMs: null }),
    );
    const nullFrame = new Uint8Array(3 + nulled.length);
    nullFrame[0] = VOICE_SOCKET_VERSION;
    nullFrame[2] = nulled.length;
    nullFrame.set(nulled, 3);
    expect(decodeVoiceClientFrame(nullFrame)).toBeNull();
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
