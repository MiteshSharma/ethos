import { describe, expect, it } from 'vitest';
import { PlayoutQueue } from '../playout-queue';
import type { AudioFormat } from '../types';
import { deferred, tick } from './fakes';

function oneChunk(byte: number) {
  return async function* (): AsyncIterable<{ audio: Uint8Array; format: AudioFormat }> {
    yield { audio: new Uint8Array([byte]), format: 'pcm' };
  };
}

describe('PlayoutQueue', () => {
  it('plays enqueued items in order and tracks played text', async () => {
    const audio: number[] = [];
    const q = new PlayoutQueue({
      onAudio: (a) => audio.push(a[0] ?? -1),
    });
    q.enqueue({ text: 'one', synthesize: oneChunk(1) });
    q.enqueue({ text: 'two', synthesize: oneChunk(2) });
    q.enqueue({ text: 'three', synthesize: oneChunk(3) });
    await q.idle();

    expect(audio).toEqual([1, 2, 3]);
    expect(q.playedText()).toEqual(['one', 'two', 'three']);
  });

  // The prefetch: sentence N+1 is synthesized while N is still playing, so the
  // synthesis round-trip hides behind audio the user is already hearing.
  // Asserted on recorded call order, not on wall-clock timing.
  it('synthesizes the next sentence while the current one is still playing', async () => {
    const calls: string[] = [];
    const audio: number[] = [];
    const gate = deferred();

    const q = new PlayoutQueue({ onAudio: (a) => audio.push(a[0] ?? -1) });

    q.enqueue({
      text: 'one',
      synthesize: async function* () {
        calls.push('synthesize:one');
        yield { audio: new Uint8Array([1]), format: 'pcm' as AudioFormat };
        await gate.promise;
        yield { audio: new Uint8Array([2]), format: 'pcm' as AudioFormat };
        calls.push('finish:one');
      },
    });
    q.enqueue({
      text: 'two',
      synthesize: async function* () {
        calls.push('synthesize:two');
        yield { audio: new Uint8Array([3]), format: 'pcm' as AudioFormat };
        calls.push('finish:two');
      },
    });

    await tick();
    // "two" was synthesized — and finished — while "one" is still mid-stream.
    expect(calls).toEqual(['synthesize:one', 'synthesize:two', 'finish:two']);
    // …but none of its audio has played: playout has not reordered.
    expect(audio).toEqual([1]);

    gate.resolve();
    await q.idle();

    expect(audio).toEqual([1, 2, 3]);
    expect(q.playedText()).toEqual(['one', 'two']);
  });

  it('does not run ahead further than one sentence', async () => {
    const calls: string[] = [];
    const gate = deferred();
    const q = new PlayoutQueue({ onAudio: () => {} });

    const item = (text: string, hold = false) => ({
      text,
      synthesize: async function* () {
        calls.push(text);
        if (hold) await gate.promise;
        yield { audio: new Uint8Array([1]), format: 'pcm' as AudioFormat };
      },
    });

    q.enqueue(item('one', true));
    q.enqueue(item('two'));
    q.enqueue(item('three'));

    await tick();
    expect(calls).toEqual(['one', 'two']); // "three" is still waiting its slot

    gate.resolve();
    await q.idle();
    expect(calls).toEqual(['one', 'two', 'three']);
    expect(q.playedText()).toEqual(['one', 'two', 'three']);
  });

  it('cancel drops pending items and does not mark the in-flight one as played', async () => {
    const audio: number[] = [];
    let thirdSynthesized = false;
    let secondAborted = false;
    const gate = deferred();

    const q = new PlayoutQueue({
      onAudio: (a) => audio.push(a[0] ?? -1),
    });

    q.enqueue({
      text: 'first',
      synthesize: async function* (signal) {
        yield { audio: new Uint8Array([1]), format: 'pcm' };
        await gate.promise;
        if (signal.aborted) return;
        yield { audio: new Uint8Array([2]), format: 'pcm' };
      },
    });
    // Prefetched (inside the lookahead window) — so it IS synthesized, but its
    // audio must never play and cancel must abort it.
    q.enqueue({
      text: 'second',
      synthesize: async function* (signal) {
        await gate.promise;
        secondAborted = signal.aborted;
        yield { audio: new Uint8Array([9]), format: 'pcm' };
      },
    });
    // Beyond the lookahead window — never synthesized at all.
    q.enqueue({
      text: 'third',
      synthesize: async function* () {
        thirdSynthesized = true;
        yield { audio: new Uint8Array([9]), format: 'pcm' };
      },
    });

    await tick(); // let the first chunk of "first" emit
    q.cancel();
    gate.resolve();
    await q.idle();
    await tick();

    expect(audio).toEqual([1]); // only the first chunk played
    expect(q.playedText()).toEqual([]); // interrupted item is not "played"
    expect(secondAborted).toBe(true); // prefetched item was aborted by cancel
    expect(thirdSynthesized).toBe(false); // pending item dropped
  });

  it('surfaces a prefetched synthesis error only when that sentence comes up', async () => {
    const errors: string[] = [];
    const played: string[] = [];
    const q = new PlayoutQueue({
      onAudio: () => {},
      onSentencePlayed: (t) => played.push(t),
      onError: (err) => errors.push(err instanceof Error ? err.message : String(err)),
    });

    q.enqueue({ text: 'one', synthesize: oneChunk(1) });
    q.enqueue({
      text: 'two',
      synthesize: () => {
        throw new Error('tts exploded');
      },
    });
    await q.idle();

    expect(played).toEqual(['one']); // the good sentence played first
    expect(errors).toEqual(['tts exploded']);
    expect(q.playedText()).toEqual(['one']);
  });
});
