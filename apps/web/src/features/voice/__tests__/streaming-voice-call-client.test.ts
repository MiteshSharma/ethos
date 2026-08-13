import { encodeVoiceFrame, pcm16FromBytes, pcm16ToBytes } from '@ethosagent/web-contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  createStreamingVoiceCallClient,
  type StreamingVoiceCallDeps,
} from '../streaming-voice-call-client';
import type { VoiceCallEvent } from '../voice-call-client';
import { FakePlayout, FakeVoiceCapture, FakeVoiceTransport } from './streaming-fakes';

// The streaming talk loop: PCM up, audio down, and the staleness rules that
// decide what is allowed to reach the speaker. Everything runs against fakes —
// no sockets, no audio hardware, no sleeps (the client's playout wait is
// injected).

/** A reply stream the test pushes chunks into, exactly when it wants them. */
class ReplyStream {
  private readonly chunks: string[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  push(chunk: string): void {
    this.chunks.push(chunk);
    this.flush();
  }

  end(): void {
    this.ended = true;
    this.flush();
  }

  async *stream(): AsyncGenerator<string> {
    while (true) {
      const next = this.chunks.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private flush(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}

function setup(overrides: Partial<StreamingVoiceCallDeps> = {}) {
  const transport = new FakeVoiceTransport();
  const capture = new FakeVoiceCapture();
  const playout = new FakePlayout();
  const events: VoiceCallEvent[] = [];
  let n = 0;
  const client = createStreamingVoiceCallClient({
    transport,
    capture,
    playout,
    runAgentTurn: async function* () {
      yield 'Sure thing.';
    },
    newUtteranceId: () => `u${++n}`,
    ...overrides,
  });
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

describe('streaming talk-mode — utterance over the binary lane', () => {
  it('streams captured PCM up and plays the reply audio it gets back', async () => {
    const { transport, capture, playout, client, events } = setup({
      runAgentTurn: async function* () {
        yield 'Clear skies. ';
        yield 'Twelve degrees.';
      },
    });
    client.on((event) => events.push(event));
    await client.connect();
    // One earcon for "the session is ready" (DR2 first-conversation moment),
    // before the user has said anything.
    expect(capture.earcons).toBe(1);

    capture.emit({ type: 'speech_start' });
    capture.emit({ type: 'frame', data: Int16Array.from([500, -500, 250]) });
    capture.emit({ type: 'speech_end' });

    // Mic audio went up as raw PCM bytes — no base64, no JSON body.
    const audioUp = transport.sent.filter((s) => s.frame.t === 'audio');
    expect(audioUp).toHaveLength(1);
    expect(Array.from(pcm16FromBytes(audioUp[0]?.payload ?? new Uint8Array()))).toEqual([
      500, -500, 250,
    ]);
    expect(transport.frames('utterance_start')).toEqual([
      { t: 'utterance_start', utteranceId: 'u1', sampleRate: 16_000 },
    ]);
    expect(transport.frames('utterance_end')).toHaveLength(1);
    // …and a second on endpoint: the thinking earcon.
    expect(capture.earcons).toBe(2);

    transport.deliver({
      t: 'transcript',
      utteranceId: 'u1',
      text: 'what is the weather',
      final: true,
    });
    await vi.waitFor(() => expect(transport.frames('synthesize')).toHaveLength(2));

    expect(events.find((e) => e.type === 'utterance_committed')).toEqual({
      type: 'utterance_committed',
      text: 'what is the weather',
    });
    expect(transport.frames('synthesize').map((f) => (f as { text: string }).text)).toEqual([
      'Clear skies.',
      'Twelve degrees.',
    ]);

    // Reply audio arrives as binary frames and is scheduled, not buffered to a
    // data URL: PCM plays the moment it lands.
    transport.deliver(
      { ...opusFrame('u1', 's0'), codec: 'pcm_s16le', mimeType: 'audio/pcm', sampleRate: 24_000 },
      pcm16ToBytes(new Int16Array(2400)),
    );
    expect(playout.pcm).toEqual([{ samples: 2400, sampleRate: 24_000 }]);

    transport.deliver(opusFrame('u1', 's1'), new Uint8Array([1, 2, 3]));
    expect(playout.encoded).toHaveLength(0); // held until the segment completes
    transport.deliver({ t: 'segment_end', utteranceId: 'u1', segmentId: 's1' });
    await vi.waitFor(() => expect(playout.encoded).toHaveLength(1));
    expect(Array.from(playout.encoded[0] ?? [])).toEqual([1, 2, 3]);

    playout.finishAll();
    await vi.waitFor(() => expect(events.some((e) => e.type === 'reply_complete')).toBe(true));
    expect(events.find((e) => e.type === 'reply_complete')).toEqual({
      type: 'reply_complete',
      text: 'Clear skies. Twelve degrees.',
    });
    await client.disconnect();
  });
});

describe('streaming talk-mode — the speech-end edge', () => {
  it('reports the endpoint immediately, without waiting for the transcript', async () => {
    const { capture, client, events } = setup();
    client.on((event) => events.push(event));
    await client.connect();

    capture.emit({ type: 'speech_start' });
    capture.emit({ type: 'frame', data: Int16Array.from([500]) });
    capture.emit({ type: 'speech_end' });

    // The transcript is still a round trip away — this is the whole point.
    expect(events.map((e) => e.type)).toEqual(['speech_end']);
    await client.disconnect();
  });

  it('hands the floor back when the transcript comes back empty', async () => {
    const { transport, capture, client, events } = setup();
    client.on((event) => events.push(event));
    await client.connect();

    capture.emit({ type: 'speech_start' });
    capture.emit({ type: 'frame', data: Int16Array.from([500]) });
    capture.emit({ type: 'speech_end' });
    transport.deliver({ t: 'transcript', utteranceId: 'u1', text: '   ', final: true });

    expect(events.map((e) => e.type)).toEqual(['speech_end', 'utterance_dropped']);
    await client.disconnect();
  });
});

describe('streaming talk-mode — utterance-ID staleness discipline', () => {
  it('drops a transcript for an utterance the user has already replaced', async () => {
    const runAgentTurn = vi.fn(async function* () {
      yield 'unreachable';
    });
    const { transport, capture, client, events } = setup({ runAgentTurn });
    client.on((event) => events.push(event));
    await client.connect();

    capture.speakUtterance();
    capture.speakUtterance(); // the user starts over: u1 is superseded by u2

    // The late transcript for u1 arrives anyway. It must not become a turn.
    transport.deliver({
      t: 'transcript',
      utteranceId: 'u1',
      text: 'the abandoned question',
      final: true,
    });
    await Promise.resolve();

    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'utterance_committed')).toBe(false);
    expect(transport.frames('cancel')).toEqual([
      { t: 'cancel', utteranceId: 'u1', reason: 'superseded' },
    ]);

    // The current utterance still works.
    transport.deliver({
      t: 'transcript',
      utteranceId: 'u2',
      text: 'the live question',
      final: true,
    });
    await vi.waitFor(() =>
      expect(runAgentTurn).toHaveBeenCalledWith('the live question', expect.anything()),
    );
    await client.disconnect();
  });

  it('never plays audio addressed to a superseded utterance', async () => {
    const { transport, capture, playout, client } = setup();
    await client.connect();

    capture.speakUtterance();
    transport.deliver({ t: 'transcript', utteranceId: 'u1', text: 'hello', final: true });
    await vi.waitFor(() => expect(transport.frames('synthesize')).toHaveLength(1));

    // The user speaks again mid-reply; u1's audio is now stale.
    capture.emit({ type: 'speech_start' });
    expect(playout.stops).toBeGreaterThan(0);

    transport.deliver(
      { ...opusFrame('u1', 's0'), codec: 'pcm_s16le', mimeType: 'audio/pcm' },
      pcm16ToBytes(new Int16Array(480)),
    );
    transport.deliver(opusFrame('u1', 's1'), new Uint8Array([9, 9]));
    transport.deliver({ t: 'segment_end', utteranceId: 'u1', segmentId: 's1' });
    await Promise.resolve();

    expect(playout.pcm).toEqual([]);
    expect(playout.encoded).toEqual([]);
    await client.disconnect();
  });

  it('barge-in cancels the utterance server-side and keeps only what was heard', async () => {
    const reply = new ReplyStream();
    const { transport, capture, playout, client, events } = setup({
      runAgentTurn: (_text, signal) => {
        signal.addEventListener('abort', () => reply.end(), { once: true });
        return reply.stream();
      },
    });
    client.on((event) => events.push(event));
    await client.connect();

    capture.speakUtterance();
    transport.deliver({ t: 'transcript', utteranceId: 'u1', text: 'tell me a story', final: true });
    reply.push('Sentence one. Sentence two. ');
    await vi.waitFor(() => expect(transport.frames('synthesize')).toHaveLength(2));

    // Sentence one finishes playing; sentence two is mid-flight.
    playout.clipSeconds = 2;
    transport.deliver(opusFrame('u1', 's0'), new Uint8Array([1]));
    transport.deliver({ t: 'segment_end', utteranceId: 'u1', segmentId: 's0' });
    await vi.waitFor(() => expect(playout.encoded).toHaveLength(1));
    playout.clock = 2; // s0 has fully elapsed
    transport.deliver(opusFrame('u1', 's1'), new Uint8Array([2]));
    transport.deliver({ t: 'segment_end', utteranceId: 'u1', segmentId: 's1' });
    await vi.waitFor(() => expect(playout.encoded).toHaveLength(2));

    capture.emit({ type: 'barge_in' });

    await vi.waitFor(() => expect(events.some((e) => e.type === 'interrupted')).toBe(true));
    expect(events.find((e) => e.type === 'interrupted')).toEqual({
      type: 'interrupted',
      text: 'Sentence one.',
    });
    expect(transport.frames('cancel')).toContainEqual({
      t: 'cancel',
      utteranceId: 'u1',
      reason: 'barge_in',
    });
    expect(playout.stops).toBeGreaterThan(0);
    expect(capture.captureEnabled).toBe(true);
    expect(events.some((e) => e.type === 'reply_complete')).toBe(false);

    // Anything still in flight for the cancelled utterance is refused.
    transport.deliver(opusFrame('u1', 's2'), new Uint8Array([3]));
    transport.deliver({ t: 'segment_end', utteranceId: 'u1', segmentId: 's2' });
    await Promise.resolve();
    expect(playout.encoded).toHaveLength(2);
    await client.disconnect();
  });
});

describe('streaming talk-mode — WS drop mid-utterance', () => {
  it('discards the in-flight utterance and returns to a fresh listen', async () => {
    const { transport, capture, playout, client, events } = setup();
    client.on((event) => events.push(event));
    await client.connect();

    // Half an utterance is captured, then the link drops.
    capture.emit({ type: 'speech_start' });
    capture.emit({ type: 'frame', data: Int16Array.from([1, 2]) });
    transport.setStatus('reconnecting');

    expect(playout.stops).toBeGreaterThan(0);
    expect(capture.captureEnabled).toBe(true);
    expect(capture.bargeEnabled).toBe(false);

    // A transcript for the half-captured utterance, arriving after the
    // reconnect, is NOT resumed into a turn.
    transport.setStatus('open');
    transport.deliver({ t: 'transcript', utteranceId: 'u1', text: 'half a sentence', final: true });
    await Promise.resolve();
    expect(events.some((e) => e.type === 'utterance_committed')).toBe(false);

    // The next utterance is a clean one with a new id.
    capture.speakUtterance();
    transport.deliver({
      t: 'transcript',
      utteranceId: 'u2',
      text: 'a whole sentence',
      final: true,
    });
    await vi.waitFor(() => expect(events.some((e) => e.type === 'utterance_committed')).toBe(true));
    expect(events.find((e) => e.type === 'utterance_committed')).toEqual({
      type: 'utterance_committed',
      text: 'a whole sentence',
    });
    await client.disconnect();
  });

  it('drops mic frames while the link is down instead of queueing them', async () => {
    const transport = new FakeVoiceTransport();
    const { capture, client } = setup({ transport });
    await client.connect();
    capture.emit({ type: 'speech_start' });
    const before = transport.sent.length;

    transport.setStatus('reconnecting');
    capture.emit({ type: 'frame', data: Int16Array.from([1]) });
    // The utterance was discarded, so there is no id to attach frames to.
    expect(transport.sent.length).toBe(before);
    await client.disconnect();
  });
});

describe('streaming talk-mode — lifecycle', () => {
  it('takes a wake lock for the call and releases it on hang-up', async () => {
    const wakeLock = { acquire: vi.fn(async () => {}), release: vi.fn(async () => {}), held: true };
    const { client } = setup({ wakeLock });
    await client.connect();
    expect(wakeLock.acquire).toHaveBeenCalledTimes(1);
    await client.disconnect();
    expect(wakeLock.release).toHaveBeenCalledTimes(1);
  });

  it('cancels the live utterance and closes the socket on hang-up', async () => {
    const { transport, capture, client } = setup();
    await client.connect();
    capture.emit({ type: 'speech_start' });
    await client.disconnect();

    expect(transport.frames('cancel')).toContainEqual({
      t: 'cancel',
      utteranceId: 'u1',
      reason: 'hangup',
    });
    expect(transport.closed).toBe(true);
    expect(capture.stopped).toBe(true);
  });

  it('surfaces a server error and returns the call to listening', async () => {
    const { transport, capture, client, events } = setup();
    client.on((event) => events.push(event));
    await client.connect();
    capture.speakUtterance();

    transport.deliver({
      t: 'error',
      code: 'transcribe_failed',
      message: 'Could not transcribe audio — try again',
      utteranceId: 'u1',
    });

    expect(events.find((e) => e.type === 'error')).toEqual({
      type: 'error',
      error: 'Could not transcribe audio — try again',
      code: 'transcribe_failed',
    });
    expect(capture.captureEnabled).toBe(true);
    await client.disconnect();
  });

  it('encodes what it sends as the shared frame format', async () => {
    // Guards the client against drifting from the wire contract: what it hands
    // the transport must be encodable by the shared codec.
    const { transport, capture, client } = setup();
    await client.connect();
    capture.speakUtterance();
    for (const { frame, payload } of transport.sent) {
      expect(() => encodeVoiceFrame(frame, payload)).not.toThrow();
    }
    await client.disconnect();
  });
});

// Per-personality voice (task A16). The client sends WHO is speaking, not the
// voice it thinks they should use — the server owns the precedence rule
// (`resolveVoicePreferences`), so talk-mode and channel replies cannot drift.
describe('streaming talk-mode — voice selection on the wire', () => {
  it('sends personalityId alongside the global voice on every synthesize frame', async () => {
    const { transport, capture, client } = setup({
      voice: 'am_michael',
      personalityId: 'voice',
      runAgentTurn: async function* () {
        yield 'Clear skies.';
      },
    });
    await client.connect();

    capture.emit({ type: 'speech_start' });
    capture.emit({ type: 'frame', data: Int16Array.from([1]) });
    capture.emit({ type: 'speech_end' });
    transport.deliver({ t: 'transcript', utteranceId: 'u1', text: 'weather?', final: true });

    await vi.waitFor(() => expect(transport.frames('synthesize')).toHaveLength(1));
    expect(transport.frames('synthesize')[0]).toMatchObject({
      voice: 'am_michael',
      personalityId: 'voice',
    });
  });

  it('omits personalityId when there is none rather than sending an empty string', async () => {
    const { transport, capture, client } = setup({
      voice: 'am_michael',
      runAgentTurn: async function* () {
        yield 'Clear skies.';
      },
    });
    await client.connect();

    capture.emit({ type: 'speech_start' });
    capture.emit({ type: 'frame', data: Int16Array.from([1]) });
    capture.emit({ type: 'speech_end' });
    transport.deliver({ t: 'transcript', utteranceId: 'u1', text: 'weather?', final: true });

    await vi.waitFor(() => expect(transport.frames('synthesize')).toHaveLength(1));
    expect(transport.frames('synthesize')[0]).not.toHaveProperty('personalityId');
  });
});
