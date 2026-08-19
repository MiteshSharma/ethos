import { encodeVoiceFrame, pcm16FromBytes, pcm16ToBytes } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import {
  createStreamingVoiceCallClient,
  type StreamingVoiceCallDeps,
} from '../streaming-voice-call-client';
import type { VoiceCallEvent } from '../voice-call-client';
import { FakePlayout, FakeVoiceCapture, FakeVoiceTransport } from './streaming-fakes';

// V2: the client no longer drives a turn or decides utterances — it streams
// mic PCM continuously and translates whatever the server's `VoiceSession`
// sends back. Everything here runs against fakes; no sockets, no audio
// hardware, no sleeps.

function setup(overrides: Partial<StreamingVoiceCallDeps> = {}) {
  const transport = new FakeVoiceTransport();
  const capture = new FakeVoiceCapture();
  const playout = new FakePlayout();
  const events: VoiceCallEvent[] = [];
  const client = createStreamingVoiceCallClient({ transport, capture, playout, ...overrides });
  return { transport, capture, playout, client, events };
}

const opusFrame = (utteranceId: string, segmentId: string) => ({
  t: 'audio' as const,
  utteranceId,
  segmentId,
  seq: 0,
  codec: 'encoded' as const,
  mimeType: 'audio/ogg;codecs=opus',
});

describe('streaming talk-mode — connect handshake', () => {
  it('sends hello with the capture sample rate and streams every captured frame', async () => {
    const { transport, capture, client } = setup({ personalityId: 'researcher' });
    await client.connect();

    expect(transport.frames('hello')).toEqual([
      { t: 'hello', sampleRate: 16_000, personalityId: 'researcher' },
    ]);

    capture.emit({ type: 'frame', data: Int16Array.from([500, -500, 250]) });
    capture.emit({ type: 'frame', data: Int16Array.from([1, 2]) });

    const audioUp = transport.frames('audio');
    expect(audioUp).toEqual([
      { t: 'audio', seq: 0 },
      { t: 'audio', seq: 1 },
    ]);
    const payloads = transport.sent.filter((s) => s.frame.t === 'audio').map((s) => s.payload);
    expect(Array.from(pcm16FromBytes(payloads[0] ?? new Uint8Array()))).toEqual([500, -500, 250]);
    await client.disconnect();
  });

  it('plays one earcon for the session being ready', async () => {
    const { capture, client } = setup();
    await client.connect();
    expect(capture.earcons).toBe(1);
    await client.disconnect();
  });

  it('skips the earcon when chime is disabled', async () => {
    const { capture, client } = setup({ chime: false });
    await client.connect();
    expect(capture.earcons).toBe(0);
    await client.disconnect();
  });
});

describe('streaming talk-mode — server events', () => {
  it('reports a committed utterance with a second earcon', async () => {
    const { transport, capture, client, events } = setup();
    client.on((event) => events.push(event));
    await client.connect();
    expect(capture.earcons).toBe(1);

    transport.deliver({
      t: 'transcript',
      utteranceId: 'u1',
      text: 'what is the weather',
      final: true,
    });

    expect(events).toEqual([{ type: 'utterance_committed', text: 'what is the weather' }]);
    expect(capture.earcons).toBe(2);
    await client.disconnect();
  });

  it('reports an empty transcript as a dropped utterance', async () => {
    const { transport, client, events } = setup();
    client.on((event) => events.push(event));
    await client.connect();

    transport.deliver({ t: 'transcript', utteranceId: 'u1', text: '   ', final: true });

    expect(events).toEqual([{ type: 'utterance_dropped' }]);
    await client.disconnect();
  });

  it('translates reply_text into reply_sentence and filler by kind', async () => {
    const { transport, client, events } = setup();
    client.on((event) => events.push(event));
    await client.connect();

    transport.deliver({
      t: 'reply_text',
      utteranceId: 'u1',
      segmentId: 's1',
      text: 'Clear skies.',
      kind: 'sentence',
    });
    transport.deliver({
      t: 'reply_text',
      utteranceId: 'u1',
      segmentId: 's2',
      text: 'One moment.',
      kind: 'filler',
    });

    expect(events).toEqual([
      { type: 'reply_sentence', text: 'Clear skies.' },
      { type: 'filler', text: 'One moment.' },
    ]);
    await client.disconnect();
  });

  it('schedules PCM audio the moment it lands', async () => {
    const { transport, playout, client } = setup();
    await client.connect();

    transport.deliver(
      { ...opusFrame('u1', 's0'), codec: 'pcm_s16le', mimeType: 'audio/pcm', sampleRate: 24_000 },
      pcm16ToBytes(new Int16Array(2400)),
    );
    expect(playout.pcm).toEqual([{ samples: 2400, sampleRate: 24_000 }]);
    await client.disconnect();
  });

  it('holds encoded audio until the segment completes, then decodes it', async () => {
    const { transport, playout, client } = setup();
    await client.connect();

    transport.deliver(opusFrame('u1', 's1'), new Uint8Array([1, 2, 3]));
    expect(playout.encoded).toHaveLength(0);
    transport.deliver({ t: 'segment_end', utteranceId: 'u1', segmentId: 's1' });
    expect(playout.encoded).toHaveLength(1);
    expect(Array.from(playout.encoded[0] ?? [])).toEqual([1, 2, 3]);
    await client.disconnect();
  });

  it('maps turn_end to reply_complete or interrupted by its flag', async () => {
    const { transport, client, events } = setup();
    client.on((event) => events.push(event));
    await client.connect();

    transport.deliver({
      t: 'turn_end',
      utteranceId: 'u1',
      text: 'Clear skies.',
      interrupted: false,
    });
    transport.deliver({
      t: 'turn_end',
      utteranceId: 'u2',
      text: 'cut off [interrupted]',
      interrupted: true,
    });

    expect(events).toEqual([
      { type: 'reply_complete', text: 'Clear skies.' },
      { type: 'interrupted', text: 'cut off [interrupted]' },
    ]);
    await client.disconnect();
  });

  it('surfaces a server error as-is', async () => {
    const { transport, client, events } = setup();
    client.on((event) => events.push(event));
    await client.connect();

    transport.deliver({
      t: 'error',
      code: 'voice_unavailable',
      message: 'Voice is not configured for this deployment.',
    });

    expect(events).toEqual([
      {
        type: 'error',
        error: 'Voice is not configured for this deployment.',
        code: 'voice_unavailable',
      },
    ]);
    await client.disconnect();
  });
});

describe('streaming talk-mode — link and lifecycle', () => {
  it('stops playout and reports link status on anything but open', async () => {
    const { transport, playout, client, events } = setup();
    client.on((event) => events.push(event));
    await client.connect();

    transport.setStatus('reconnecting');
    expect(playout.stops).toBeGreaterThan(0);
    expect(events).toContainEqual({ type: 'link', status: 'reconnecting' });
    await client.disconnect();
  });

  it('takes a wake lock for the call and releases it on hang-up', async () => {
    const wakeLock = { acquire: async () => {}, release: async () => {}, held: true };
    let acquired = 0;
    let released = 0;
    const { client } = setup({
      wakeLock: {
        acquire: async () => {
          acquired++;
        },
        release: async () => {
          released++;
        },
        held: wakeLock.held,
      },
    });
    await client.connect();
    expect(acquired).toBe(1);
    await client.disconnect();
    expect(released).toBe(1);
  });

  it('closes the transport and stops capture on hang-up', async () => {
    const { transport, capture, client } = setup();
    await client.connect();
    await client.disconnect();

    expect(transport.closed).toBe(true);
    expect(capture.stopped).toBe(true);
  });

  it('ignores server frames once disconnected', async () => {
    const { transport, client, events } = setup();
    client.on((event) => events.push(event));
    await client.connect();
    await client.disconnect();

    transport.deliver({ t: 'transcript', utteranceId: 'u1', text: 'late', final: true });
    expect(events).toEqual([]);
  });

  it('encodes what it sends as the shared frame format', async () => {
    // Guards the client against drifting from the wire contract: what it hands
    // the transport must be encodable by the shared codec.
    const { transport, capture, client } = setup();
    await client.connect();
    capture.emit({ type: 'frame', data: Int16Array.from([1]) });
    for (const { frame, payload } of transport.sent) {
      expect(() => encodeVoiceFrame(frame, payload)).not.toThrow();
    }
    await client.disconnect();
  });

  it('has no ask() — clarify falls back to the on-screen card on this tier', async () => {
    const { client } = setup();
    expect(client.ask).toBeUndefined();
  });
});
