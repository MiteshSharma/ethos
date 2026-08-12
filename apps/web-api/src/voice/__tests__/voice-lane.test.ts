import { pcm16ToBytes, type VoiceServerFrame } from '@ethosagent/web-contracts';
import { describe, expect, it, vi } from 'vitest';
import { VoiceLane, type VoiceLaneDeps } from '../voice-lane';

// The lane's conversation protocol, exercised without a socket: frames in,
// frames out. Two things are under test here that no smoke check would catch —
// that a superseded utterance's results never reach the client, and that two
// lanes built from the same factory and the same provider service cannot see
// each other's audio.

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Sent {
  frame: VoiceServerFrame;
  payload: Uint8Array;
}

/** A lane plus the frames it sent, wired to controllable provider fakes. */
function makeLane(
  overrides: Partial<VoiceLaneDeps> = {},
  laneId = 'lane-1',
): {
  lane: VoiceLane;
  sent: Sent[];
  frames: () => VoiceServerFrame[];
} {
  const sent: Sent[] = [];
  const deps: VoiceLaneDeps = {
    transcribe: () => Promise.resolve({ text: 'hello there', provider: 'fake-stt' }),
    synthesize: async function* () {
      yield { audio: new Uint8Array([1, 2]), format: 'opus' as const, provider: 'fake-tts' };
    },
    ...overrides,
  };
  const lane = new VoiceLane({
    laneId,
    deps,
    send: (frame, payload) => sent.push({ frame, payload: payload ?? new Uint8Array() }),
  });
  return { lane, sent, frames: () => sent.map((s) => s.frame) };
}

const pcm = (value: number, count = 4) => pcm16ToBytes(Int16Array.from(Array(count).fill(value)));

describe('VoiceLane — capture → transcript', () => {
  it('answers hello with ready and transcribes a completed utterance', async () => {
    const transcribed: Array<{ mimeType: string; bytes: number }> = [];
    const { lane, frames } = makeLane({
      transcribe: (audio) => {
        transcribed.push({ mimeType: audio.mimeType, bytes: audio.data.length });
        return Promise.resolve({ text: 'what is the weather', provider: 'local-stt' });
      },
    });

    lane.handle({ t: 'hello' }, new Uint8Array());
    lane.handle({ t: 'utterance_start', utteranceId: 'u1', sampleRate: 16_000 }, new Uint8Array());
    lane.handle({ t: 'audio', utteranceId: 'u1', seq: 0 }, pcm(100));
    lane.handle({ t: 'audio', utteranceId: 'u1', seq: 1 }, pcm(-100));
    lane.handle({ t: 'utterance_end', utteranceId: 'u1' }, new Uint8Array());
    await vi.waitFor(() => expect(frames().some((f) => f.t === 'transcript')).toBe(true));

    expect(frames()[0]).toMatchObject({ t: 'ready', laneId: 'lane-1' });
    // The PCM arrived as a WAV: 44-byte header + 8 samples * 2 bytes.
    expect(transcribed).toEqual([{ mimeType: 'audio/wav', bytes: 44 + 16 }]);
    expect(frames().find((f) => f.t === 'transcript')).toEqual({
      t: 'transcript',
      utteranceId: 'u1',
      text: 'what is the weather',
      final: true,
      provider: 'local-stt',
    });
  });

  it('discards an utterance that exceeds the capture cap', () => {
    const sent: Sent[] = [];
    const lane = new VoiceLane({
      laneId: 'lane-1',
      deps: {
        transcribe: () => Promise.reject(new Error('must not be called')),
        synthesize: async function* () {},
      },
      send: (frame, payload) => sent.push({ frame, payload: payload ?? new Uint8Array() }),
      limits: { maxUtteranceBytes: 8 },
    });
    lane.handle({ t: 'utterance_start', utteranceId: 'u1', sampleRate: 16_000 }, new Uint8Array());
    lane.handle({ t: 'audio', utteranceId: 'u1', seq: 0 }, pcm(1, 8));

    const kinds = sent.map((s) => s.frame.t);
    expect(kinds).toEqual(['dropped', 'error']);
    expect(lane.activeUtterance).toBeNull();
  });

  it('keeps the tracked-utterance map bounded across a long call', async () => {
    const sent: Sent[] = [];
    const lane = new VoiceLane({
      laneId: 'lane-1',
      deps: {
        transcribe: () => Promise.resolve({ text: 'hi', provider: 'fake-stt' }),
        synthesize: async function* () {},
      },
      send: (frame, payload) => sent.push({ frame, payload: payload ?? new Uint8Array() }),
      limits: { maxTrackedUtterances: 2 },
    });

    for (let i = 1; i <= 5; i++) {
      lane.handle(
        { t: 'utterance_start', utteranceId: `u${i}`, sampleRate: 16_000 },
        new Uint8Array(),
      );
      lane.handle({ t: 'audio', utteranceId: `u${i}`, seq: 0 }, pcm(50));
    }

    // The oldest utterances were evicted, so a late synthesis request for one
    // of them is refused rather than silently served from unbounded state.
    lane.handle(
      { t: 'synthesize', utteranceId: 'u1', segmentId: 's0', text: 'stale' },
      new Uint8Array(),
    );
    await Promise.resolve();
    expect(sent.filter((s) => s.frame.t === 'audio')).toHaveLength(0);
    expect(lane.activeUtterance).toBe('u5');
  });
});

describe('VoiceLane — utterance-ID staleness discipline', () => {
  it('drops a transcript whose utterance was superseded while STT was running', async () => {
    const gate = deferred<{ text: string; provider: string }>();
    const { lane, frames } = makeLane({ transcribe: () => gate.promise });

    lane.handle({ t: 'utterance_start', utteranceId: 'u1', sampleRate: 16_000 }, new Uint8Array());
    lane.handle({ t: 'audio', utteranceId: 'u1', seq: 0 }, pcm(500));
    lane.handle({ t: 'utterance_end', utteranceId: 'u1' }, new Uint8Array());

    // The user speaks again before the first transcript comes back.
    lane.handle({ t: 'utterance_start', utteranceId: 'u2', sampleRate: 16_000 }, new Uint8Array());
    gate.resolve({ text: 'the stale answer', provider: 'fake-stt' });

    await vi.waitFor(() => expect(frames().some((f) => f.t === 'dropped')).toBe(true));
    expect(frames().some((f) => f.t === 'transcript')).toBe(false);
    expect(frames().filter((f) => f.t === 'dropped')).toContainEqual({
      t: 'dropped',
      utteranceId: 'u1',
      stage: 'transcript',
      reason: 'superseded',
    });
  });

  it('never synthesizes for an utterance cancelled by barge-in', async () => {
    const synthesize = vi.fn(async function* () {
      yield { audio: new Uint8Array([9]), format: 'opus' as const, provider: 'fake-tts' };
    });
    const { lane, frames } = makeLane({ synthesize });

    lane.handle({ t: 'utterance_start', utteranceId: 'u1', sampleRate: 16_000 }, new Uint8Array());
    lane.handle({ t: 'cancel', utteranceId: 'u1', reason: 'barge_in' }, new Uint8Array());
    lane.handle(
      { t: 'synthesize', utteranceId: 'u1', segmentId: 's0', text: 'Too late.' },
      new Uint8Array(),
    );

    await vi.waitFor(() =>
      expect(frames().filter((f) => f.t === 'dropped').length).toBeGreaterThanOrEqual(2),
    );
    expect(synthesize).not.toHaveBeenCalled();
    expect(frames().some((f) => f.t === 'audio')).toBe(false);
  });

  it('stops mid-stream and drops the rest when barge-in lands during synthesis', async () => {
    const chunkGate = deferred<void>();
    const { lane, sent, frames } = makeLane({
      synthesize: async function* () {
        yield { audio: new Uint8Array([1]), format: 'opus' as const, provider: 'fake-tts' };
        await chunkGate.promise;
        yield { audio: new Uint8Array([2]), format: 'opus' as const, provider: 'fake-tts' };
      },
    });

    lane.handle({ t: 'utterance_start', utteranceId: 'u1', sampleRate: 16_000 }, new Uint8Array());
    lane.handle(
      { t: 'synthesize', utteranceId: 'u1', segmentId: 's0', text: 'One.' },
      new Uint8Array(),
    );
    await vi.waitFor(() => expect(frames().some((f) => f.t === 'audio')).toBe(true));

    lane.handle({ t: 'cancel', utteranceId: 'u1', reason: 'barge_in' }, new Uint8Array());
    chunkGate.resolve();

    await vi.waitFor(() =>
      expect(frames().filter((f) => f.t === 'dropped').length).toBeGreaterThanOrEqual(2),
    );
    // Exactly the one chunk that was already on the wire — the post-barge-in
    // chunk is never sent, and the segment never claims completion.
    expect(sent.filter((s) => s.frame.t === 'audio').map((s) => Array.from(s.payload))).toEqual([
      [1],
    ]);
    expect(frames().some((f) => f.t === 'segment_end')).toBe(false);
  });

  it('keeps reply audio flowing for the utterance that is still current', async () => {
    const { lane, sent, frames } = makeLane();
    lane.handle({ t: 'utterance_start', utteranceId: 'u1', sampleRate: 16_000 }, new Uint8Array());
    lane.handle(
      { t: 'synthesize', utteranceId: 'u1', segmentId: 's0', text: 'Clear skies.' },
      new Uint8Array(),
    );
    await vi.waitFor(() => expect(frames().some((f) => f.t === 'segment_end')).toBe(true));

    const audio = sent.filter((s) => s.frame.t === 'audio');
    expect(audio).toHaveLength(1);
    expect(audio[0]?.frame).toMatchObject({
      t: 'audio',
      utteranceId: 'u1',
      segmentId: 's0',
      codec: 'encoded',
      mimeType: 'audio/ogg;codecs=opus',
      provider: 'fake-tts',
    });
  });

  it('marks raw PCM as directly schedulable', async () => {
    const { lane, sent, frames } = makeLane({
      synthesize: async function* () {
        yield { audio: pcm(200), format: 'pcm' as const, provider: 'fake-tts' };
      },
    });
    lane.handle({ t: 'utterance_start', utteranceId: 'u1', sampleRate: 16_000 }, new Uint8Array());
    lane.handle(
      { t: 'synthesize', utteranceId: 'u1', segmentId: 's0', text: 'Hi.' },
      new Uint8Array(),
    );
    await vi.waitFor(() => expect(frames().some((f) => f.t === 'segment_end')).toBe(true));
    expect(sent.find((s) => s.frame.t === 'audio')?.frame).toMatchObject({
      codec: 'pcm_s16le',
      mimeType: 'audio/pcm',
    });
  });

  it('closes out every in-flight utterance when the socket goes away', async () => {
    const gate = deferred<{ text: string; provider: string }>();
    const { lane, frames } = makeLane({ transcribe: () => gate.promise });
    lane.handle({ t: 'utterance_start', utteranceId: 'u1', sampleRate: 16_000 }, new Uint8Array());
    lane.handle({ t: 'audio', utteranceId: 'u1', seq: 0 }, pcm(10));
    lane.handle({ t: 'utterance_end', utteranceId: 'u1' }, new Uint8Array());

    lane.close();
    gate.resolve({ text: 'nobody is listening', provider: 'fake-stt' });
    await Promise.resolve();
    await Promise.resolve();

    expect(frames().some((f) => f.t === 'transcript')).toBe(false);
    expect(lane.activeUtterance).toBeNull();
  });
});

describe('VoiceLane — cross-lane isolation (regression)', () => {
  // The bug this is written against: one caller's private audio reaching a
  // different recipient because voice state was keyed globally (by utterance or
  // session id) instead of per connection. Both lanes here deliberately use the
  // SAME utterance id and the SAME provider service, and their provider calls
  // are resolved out of order — anything shared would cross the streams.
  it('never routes one lane’s transcript or audio to another lane', async () => {
    const transcribeGates = new Map<string, Deferred<{ text: string; provider: string }>>();
    const laneFor = (name: string) => {
      const gate = deferred<{ text: string; provider: string }>();
      transcribeGates.set(name, gate);
      return makeLane(
        {
          transcribe: () => gate.promise,
          synthesize: async function* (text) {
            yield {
              audio: new TextEncoder().encode(`${name}:${text}`),
              format: 'opus' as const,
              provider: 'shared-tts',
            };
          },
        },
        name,
      );
    };

    const alice = laneFor('alice');
    const bob = laneFor('bob');

    // Same utterance id on both lanes — the collision a global map would lose.
    for (const lane of [alice.lane, bob.lane]) {
      lane.handle({ t: 'hello' }, new Uint8Array());
      lane.handle(
        { t: 'utterance_start', utteranceId: 'u1', sampleRate: 16_000 },
        new Uint8Array(),
      );
      lane.handle({ t: 'audio', utteranceId: 'u1', seq: 0 }, pcm(1000));
      lane.handle({ t: 'utterance_end', utteranceId: 'u1' }, new Uint8Array());
    }

    // Resolve Bob's STT first, Alice's second — interleaved completion.
    transcribeGates.get('bob')?.resolve({ text: 'bob bank balance', provider: 'shared-stt' });
    transcribeGates.get('alice')?.resolve({ text: 'alice medical result', provider: 'shared-stt' });

    await vi.waitFor(() => {
      expect(alice.frames().some((f) => f.t === 'transcript')).toBe(true);
      expect(bob.frames().some((f) => f.t === 'transcript')).toBe(true);
    });

    const transcriptOf = (frames: VoiceServerFrame[]) =>
      frames.filter((f) => f.t === 'transcript').map((f) => (f as { text: string }).text);
    expect(transcriptOf(alice.frames())).toEqual(['alice medical result']);
    expect(transcriptOf(bob.frames())).toEqual(['bob bank balance']);

    // Same for synthesized audio, again under a shared segment id.
    alice.lane.handle(
      { t: 'synthesize', utteranceId: 'u1', segmentId: 's0', text: 'private-to-alice' },
      new Uint8Array(),
    );
    bob.lane.handle(
      { t: 'synthesize', utteranceId: 'u1', segmentId: 's0', text: 'private-to-bob' },
      new Uint8Array(),
    );
    await vi.waitFor(() => {
      expect(alice.frames().some((f) => f.t === 'segment_end')).toBe(true);
      expect(bob.frames().some((f) => f.t === 'segment_end')).toBe(true);
    });

    const audioOf = (sent: Sent[]) =>
      sent.filter((s) => s.frame.t === 'audio').map((s) => new TextDecoder().decode(s.payload));
    expect(audioOf(alice.sent)).toEqual(['alice:private-to-alice']);
    expect(audioOf(bob.sent)).toEqual(['bob:private-to-bob']);

    // And a barge-in on one lane leaves the other lane's call untouched.
    alice.lane.handle({ t: 'cancel', utteranceId: 'u1', reason: 'barge_in' }, new Uint8Array());
    expect(alice.lane.activeUtterance).toBeNull();
    expect(bob.lane.activeUtterance).toBe('u1');
    bob.lane.handle(
      { t: 'synthesize', utteranceId: 'u1', segmentId: 's1', text: 'still-bob' },
      new Uint8Array(),
    );
    await vi.waitFor(() =>
      expect(audioOf(bob.sent)).toEqual(['bob:private-to-bob', 'bob:still-bob']),
    );
    expect(audioOf(alice.sent)).toEqual(['alice:private-to-alice']);
  });
});
