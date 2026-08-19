import type { PcmChunk } from '@ethosagent/types';
import type { VoiceSession, VoiceSessionEvent } from '@ethosagent/voice-session';
import { pcm16ToBytes, type VoiceServerFrame } from '@ethosagent/web-contracts';
import { describe, expect, it, vi } from 'vitest';
import { VoiceLane, type VoiceLaneSessionOpener } from '../voice-lane';

// The lane's frame-plumbing role, exercised without a socket: frames in,
// frames out, against a FAKE `VoiceSession` this file drives by hand. The
// conversation itself (VAD, endpointing, the agent turn) is
// `@ethosagent/voice-session`'s own test suite's job — this file only proves
// the TRANSLATION between `VoiceSessionEvent`s and `VoiceServerFrame`s, and
// that opening the session is deferred to `hello` and is per-connection.

interface Sent {
  frame: VoiceServerFrame;
  payload: Uint8Array;
}

/** A `VoiceSession` stand-in the test emits events through by hand. */
class FakeVoiceSession {
  readonly pushed: PcmChunk[] = [];
  private listeners: Array<(event: VoiceSessionEvent) => void> = [];

  pushAudio(chunk: PcmChunk): void {
    this.pushed.push(chunk);
  }

  on(listener: (event: VoiceSessionEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  emit(event: VoiceSessionEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  get subscriberCount(): number {
    return this.listeners.length;
  }
}

/** A lane plus the frames it sent, wired to a controllable session opener. */
function makeLane(opener: VoiceLaneSessionOpener): {
  lane: VoiceLane;
  sent: Sent[];
  frames: () => VoiceServerFrame[];
} {
  const sent: Sent[] = [];
  const lane = new VoiceLane({
    laneId: 'lane-1',
    openSession: opener,
    send: (frame, payload) => sent.push({ frame, payload: payload ?? new Uint8Array() }),
  });
  return { lane, sent, frames: () => sent.map((s) => s.frame) };
}

const pcm = (value: number, count = 4) => pcm16ToBytes(Int16Array.from(Array(count).fill(value)));

describe('VoiceLane — handshake and audio plumbing', () => {
  it('answers hello with ready before the session finishes opening', async () => {
    const session = new FakeVoiceSession();
    const { lane, frames } = makeLane(() => Promise.resolve(session as unknown as VoiceSession));

    lane.handle({ t: 'hello', sampleRate: 16_000 }, new Uint8Array());
    expect(frames()).toEqual([{ t: 'ready', laneId: 'lane-1', protocolVersion: 1 }]);
    await vi.waitFor(() => expect(session.subscriberCount).toBe(1));
  });

  it('does not open a session when hello names no sample rate', async () => {
    const opener = vi.fn();
    const { lane, frames } = makeLane(opener);

    lane.handle({ t: 'hello' }, new Uint8Array());
    await Promise.resolve();

    expect(opener).not.toHaveBeenCalled();
    expect(frames()).toEqual([{ t: 'ready', laneId: 'lane-1', protocolVersion: 1 }]);
  });

  it('forwards audio frames to the session as PCM chunks at the declared sample rate', async () => {
    const session = new FakeVoiceSession();
    const { lane } = makeLane(() => Promise.resolve(session as unknown as VoiceSession));

    lane.handle({ t: 'hello', sampleRate: 48_000 }, new Uint8Array());
    await vi.waitFor(() => expect(session.subscriberCount).toBe(1));
    lane.handle({ t: 'audio', seq: 0 }, pcm(1000, 3));

    expect(session.pushed).toHaveLength(1);
    expect(session.pushed[0]?.sampleRate).toBe(48_000);
    expect(Array.from(session.pushed[0]?.data ?? [])).toEqual([1000, 1000, 1000]);
  });

  it('drops audio that arrives before the session has opened', async () => {
    let resolveGate!: (session: VoiceSession | null) => void;
    const gate = new Promise<VoiceSession | null>((resolve) => {
      resolveGate = resolve;
    });
    const { lane } = makeLane(() => gate);

    lane.handle({ t: 'hello', sampleRate: 16_000 }, new Uint8Array());
    lane.handle({ t: 'audio', seq: 0 }, pcm(1));
    // Never throws, never buffers — the frame is simply gone.
    const session = new FakeVoiceSession();
    resolveGate(session as unknown as VoiceSession);
    await vi.waitFor(() => expect(session.subscriberCount).toBe(1));
    expect(session.pushed).toHaveLength(0);
  });

  it('drops audio silently once the session resolves null (voice not configured)', async () => {
    const { lane, frames } = makeLane(() => Promise.resolve(null));

    lane.handle({ t: 'hello', sampleRate: 16_000 }, new Uint8Array());
    await vi.waitFor(() =>
      expect(frames().some((f) => f.t === 'error' && f.code === 'voice_unavailable')).toBe(true),
    );
    lane.handle({ t: 'audio', seq: 0 }, pcm(1));

    expect(frames().filter((f) => f.t === 'error')).toHaveLength(1);
  });

  it('surfaces a thrown opener as a voice_unavailable error rather than crashing the lane', async () => {
    const { lane, frames } = makeLane(() => Promise.reject(new Error('provider refused')));

    lane.handle({ t: 'hello', sampleRate: 16_000 }, new Uint8Array());
    await vi.waitFor(() =>
      expect(frames()).toEqual([
        { t: 'ready', laneId: 'lane-1', protocolVersion: 1 },
        { t: 'error', code: 'voice_unavailable', message: 'provider refused' },
      ]),
    );
  });

  it('ignores a second hello on an already-opening lane', async () => {
    const opener = vi.fn(() => new Promise<VoiceSession | null>(() => {}));
    const { lane } = makeLane(opener);

    lane.handle({ t: 'hello', sampleRate: 16_000, sessionId: 'a' }, new Uint8Array());
    lane.handle({ t: 'hello', sampleRate: 16_000, sessionId: 'b' }, new Uint8Array());

    expect(opener).toHaveBeenCalledTimes(1);
  });
});

describe('VoiceLane — event translation', () => {
  async function openedLane(): Promise<{
    session: FakeVoiceSession;
    lane: VoiceLane;
    frames: () => VoiceServerFrame[];
  }> {
    const session = new FakeVoiceSession();
    const { lane, frames } = makeLane(() => Promise.resolve(session as unknown as VoiceSession));
    lane.handle({ t: 'hello', sampleRate: 16_000 }, new Uint8Array());
    await vi.waitFor(() => expect(session.subscriberCount).toBe(1));
    return { session, lane, frames };
  }

  it('mints an utterance id on utterance_committed and sends it as a transcript', async () => {
    const { session, frames } = await openedLane();
    session.emit({ type: 'utterance_committed', text: 'what is the weather' });

    expect(frames()).toEqual([
      { t: 'ready', laneId: 'lane-1', protocolVersion: 1 },
      { t: 'transcript', utteranceId: 'u1', text: 'what is the weather', final: true },
    ]);
  });

  it('opens a new segment for a reply sentence, closing whatever was open', async () => {
    const { session, frames } = await openedLane();
    session.emit({ type: 'utterance_committed', text: 'weather?' });
    session.emit({ type: 'reply_sentence', text: 'Clear skies.' });
    session.emit({ type: 'reply_audio', audio: new Uint8Array([1, 2]), format: 'opus' });
    session.emit({ type: 'reply_sentence', text: 'Twelve degrees.' });

    const kinds = frames().map((f) => f.t);
    expect(kinds).toEqual([
      'ready',
      'transcript',
      'reply_text',
      'audio',
      'segment_end',
      'reply_text',
    ]);
    expect(frames()[2]).toEqual({
      t: 'reply_text',
      utteranceId: 'u1',
      segmentId: 's1',
      text: 'Clear skies.',
      kind: 'sentence',
    });
    expect(frames()[3]).toMatchObject({
      t: 'audio',
      utteranceId: 'u1',
      segmentId: 's1',
      seq: 0,
      codec: 'encoded',
      mimeType: 'audio/ogg;codecs=opus',
    });
    expect(frames()[4]).toEqual({ t: 'segment_end', utteranceId: 'u1', segmentId: 's1' });
    expect(frames()[5]).toMatchObject({ t: 'reply_text', segmentId: 's2', kind: 'sentence' });
  });

  it('marks a filler segment distinctly from a reply sentence', async () => {
    const { session, frames } = await openedLane();
    session.emit({ type: 'utterance_committed', text: 'do the thing' });
    session.emit({ type: 'filler', text: 'One moment.' });

    expect(frames().at(-1)).toEqual({
      t: 'reply_text',
      utteranceId: 'u1',
      segmentId: 's1',
      text: 'One moment.',
      kind: 'filler',
    });
  });

  it('closes the open segment and ends the turn on reply_complete', async () => {
    const { session, frames } = await openedLane();
    session.emit({ type: 'utterance_committed', text: 'weather?' });
    session.emit({ type: 'reply_sentence', text: 'Clear skies.' });
    session.emit({ type: 'reply_complete', text: 'Clear skies.' });

    expect(frames().slice(-2)).toEqual([
      { t: 'segment_end', utteranceId: 'u1', segmentId: 's1' },
      { t: 'turn_end', utteranceId: 'u1', text: 'Clear skies.', interrupted: false },
    ]);
  });

  it('marks the turn interrupted on barge-in', async () => {
    const { session, frames } = await openedLane();
    session.emit({ type: 'utterance_committed', text: 'tell me a story' });
    session.emit({ type: 'reply_sentence', text: 'Once upon a time' });
    session.emit({ type: 'interrupted', text: 'Once upon a time [interrupted]' });

    expect(frames().at(-1)).toEqual({
      t: 'turn_end',
      utteranceId: 'u1',
      text: 'Once upon a time [interrupted]',
      interrupted: true,
    });
  });

  it('increments the utterance id across successive turns on one connection', async () => {
    const { session, frames } = await openedLane();
    session.emit({ type: 'utterance_committed', text: 'first' });
    session.emit({ type: 'reply_complete', text: 'ok' });
    session.emit({ type: 'utterance_committed', text: 'second' });

    const transcripts = frames().filter((f) => f.t === 'transcript');
    expect(transcripts.map((f) => (f as { utteranceId: string }).utteranceId)).toEqual([
      'u1',
      'u2',
    ]);
  });

  it('forwards a session error as an error frame', async () => {
    const { session, frames } = await openedLane();
    session.emit({ type: 'utterance_committed', text: 'weather?' });
    session.emit({ type: 'error', error: 'STT failed', code: 'stt' });

    expect(frames().at(-1)).toEqual({
      t: 'error',
      code: 'stt',
      message: 'STT failed',
      utteranceId: 'u1',
    });
  });

  it('marks raw PCM as directly schedulable', async () => {
    const { session, frames } = await openedLane();
    session.emit({ type: 'utterance_committed', text: 'hi' });
    session.emit({ type: 'reply_sentence', text: 'Hi.' });
    session.emit({ type: 'reply_audio', audio: pcm(200), format: 'pcm' });

    expect(frames().find((f) => f.t === 'audio')).toMatchObject({
      codec: 'pcm_s16le',
      mimeType: 'audio/pcm',
    });
  });
});

describe('VoiceLane — cross-lane isolation (regression)', () => {
  // The bug this is written against: one caller's private audio reaching a
  // different recipient because voice state was keyed globally instead of per
  // connection. Both lanes here deliberately mint the same utterance-id
  // sequence — the collision a global map would lose.
  it('never routes one lane’s events to another lane', async () => {
    const alice = new FakeVoiceSession();
    const bob = new FakeVoiceSession();
    const aliceLane = makeLane(() => Promise.resolve(alice as unknown as VoiceSession));
    const bobLane = makeLane(() => Promise.resolve(bob as unknown as VoiceSession));

    aliceLane.lane.handle({ t: 'hello', sampleRate: 16_000 }, new Uint8Array());
    bobLane.lane.handle({ t: 'hello', sampleRate: 16_000 }, new Uint8Array());
    await vi.waitFor(() => {
      expect(alice.subscriberCount).toBe(1);
      expect(bob.subscriberCount).toBe(1);
    });

    bob.emit({ type: 'utterance_committed', text: 'bob bank balance' });
    alice.emit({ type: 'utterance_committed', text: 'alice medical result' });

    const transcriptOf = (frames: VoiceServerFrame[]) =>
      frames.filter((f) => f.t === 'transcript').map((f) => (f as { text: string }).text);
    expect(transcriptOf(aliceLane.frames())).toEqual(['alice medical result']);
    expect(transcriptOf(bobLane.frames())).toEqual(['bob bank balance']);
  });
});

describe('VoiceLane — lifecycle', () => {
  it('unsubscribes from the session on close without touching the turn in flight', async () => {
    const session = new FakeVoiceSession();
    const { lane } = makeLane(() => Promise.resolve(session as unknown as VoiceSession));
    lane.handle({ t: 'hello', sampleRate: 16_000 }, new Uint8Array());
    await vi.waitFor(() => expect(session.subscriberCount).toBe(1));

    lane.close();
    expect(session.subscriberCount).toBe(0);

    // The session itself is untouched — no abort call exists on the fake, and
    // an event fired after close reaches no listener rather than throwing.
    expect(() => session.emit({ type: 'reply_complete', text: 'late' })).not.toThrow();
  });

  it('ignores frames after close', async () => {
    const session = new FakeVoiceSession();
    const { lane, frames } = makeLane(() => Promise.resolve(session as unknown as VoiceSession));
    lane.close();
    lane.handle({ t: 'hello', sampleRate: 16_000 }, new Uint8Array());
    expect(frames()).toEqual([]);
  });
});
