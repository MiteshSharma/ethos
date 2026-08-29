import { describe, expect, it, vi } from 'vitest';
import {
  createBatchVoiceCallClient,
  type SynthesizedClip,
  type UtteranceCapture,
  type VoiceIoDriver,
} from '../batch-voice-call-client';
import type { VoiceCallEvent } from '../voice-call-client';
import {
  initialVoiceCallState,
  voiceCallReducer,
  voiceTranscriptToMessages,
} from '../voice-call-reducer';

// REGRESSION PIN for today's browser talk-mode (plan/phases/
// voice-v1a-pipeline-foundation.md §0 "Regression pin BEFORE the rewrite").
//
// Talk-mode is about to move from batch HTTP + `new Audio(dataURL)` to binary-PCM
// over a WebSocket with WebAudio playout. These tests pin the OBSERVABLE
// behaviors of the current pipeline — not its transport — so the rewrite cannot
// silently drop one:
//
//   1. utterance → transcribe → agent turn → sentence split → ordered playout
//   2. sentence pipelining (N plays while N+1 is still synthesizing)
//   3. barge-in aborts the in-flight turn AND stops playback
//   4. what persists after barge-in is the honestly-played prefix, `[interrupted]`
//   5. the thinking earcon is gated (the gate, not the sound)
//   6. a Whisper phantom utterance is dropped instead of becoming a turn
//
// Every one is asserted through the public seams (`VoiceCallClient`,
// `VoiceIoDriver`, the injected deps, and the transcript reducer) with fakes —
// no real audio, no network, no sleeps. Ordering and overlap are observed via
// the fake's recorded call sequence, never via elapsed time.

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * A test-driven reply stream standing in for the chat SSE tap: the test pushes
 * chunks exactly when it wants the agent to have produced them, so "sentence 3
 * arrived while sentence 1 was playing" is a controlled fact, not a race.
 */
class ReplyStream {
  private readonly chunks: string[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  push(chunk: string): void {
    this.chunks.push(chunk);
    this.flushWaiter();
  }

  end(): void {
    this.ended = true;
    this.flushWaiter();
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

  private flushWaiter(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}

/**
 * Fake browser-audio boundary with playout under the test's control: every
 * `play()` hangs until `finishPlayback()` (or the turn's abort signal) releases
 * it, so the client can be observed mid-playout.
 */
class ControlledVoiceIoDriver implements VoiceIoDriver {
  readonly utterances: UtteranceCapture[] = [];
  /** Audio handed to `play()`, in the order playout STARTED. */
  readonly playStarts: string[] = [];
  captureCalls = 0;
  earconCalls = 0;
  stopPlaybackCalls = 0;
  stopped = false;
  private pending: Deferred<void> | null = null;
  private bargeEnabled = false;
  private readonly bargeListeners = new Set<() => void>();

  start(): Promise<void> {
    return Promise.resolve();
  }

  micStream(): MediaStream | null {
    return null;
  }

  setMicEnabled(): void {}

  captureUtterance(signal: AbortSignal): Promise<UtteranceCapture | null> {
    this.captureCalls++;
    const next = this.utterances.shift();
    if (next) return Promise.resolve(next);
    // Out of scripted utterances: park until the test disconnects, so the
    // hands-free loop stays alive (and observable) without spinning.
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve(null);
        return;
      }
      signal.addEventListener('abort', () => resolve(null), { once: true });
    });
  }

  play(audioBase64: string, _mimeType: string, signal: AbortSignal): Promise<void> {
    this.playStarts.push(audioBase64);
    const gate = deferred();
    this.pending = gate;
    return new Promise<void>((resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(new DOMException('playout aborted', 'AbortError')),
        { once: true },
      );
      void gate.promise.then(resolve);
    });
  }

  /** Let the clip currently playing run to its end. */
  finishPlayback(): void {
    const gate = this.pending;
    this.pending = null;
    gate?.resolve();
  }

  playEarcon(): void {
    this.earconCalls++;
  }

  onBargeIn(listener: () => void): () => void {
    this.bargeListeners.add(listener);
    return () => {
      this.bargeListeners.delete(listener);
    };
  }

  setBargeInEnabled(enabled: boolean): void {
    this.bargeEnabled = enabled;
  }

  /** Simulate sustained user speech over the agent's playout. */
  triggerBargeIn(): void {
    if (!this.bargeEnabled) return;
    for (const listener of [...this.bargeListeners]) listener();
  }

  stopPlayback(): void {
    this.stopPlaybackCalls++;
  }

  stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }
}

/** Synthesis whose completion each test controls, keyed by sentence text. */
function gatedSynthesizer(): {
  calls: string[];
  synthesize: (text: string) => Promise<SynthesizedClip>;
  complete: (text: string) => void;
} {
  const calls: string[] = [];
  const gates = new Map<string, Deferred<SynthesizedClip>>();
  return {
    calls,
    synthesize(text: string): Promise<SynthesizedClip> {
      calls.push(text);
      const gate = deferred<SynthesizedClip>();
      gates.set(text, gate);
      return gate.promise;
    },
    complete(text: string): void {
      gates.get(text)?.resolve({ audioBase64: `tts:${text}`, mimeType: 'audio/mp3' });
    },
  };
}

/** Replay the call's own events through the transcript reducer, as the UI does. */
function projectToChat(events: VoiceCallEvent[]): ReturnType<typeof voiceTranscriptToMessages> {
  let state = voiceCallReducer(initialVoiceCallState, { type: 'start' });
  state = voiceCallReducer(state, { type: 'connected' });
  for (const event of events) {
    state = voiceCallReducer(state, { type: 'client-event', event });
  }
  return voiceTranscriptToMessages(state.transcript);
}

describe('talk-mode pin — utterance → transcribe → turn → ordered playout', () => {
  it('carries one captured utterance through to sentences played in order', async () => {
    const driver = new ControlledVoiceIoDriver();
    driver.utterances.push({ audioBase64: 'CAPTURED', mimeType: 'audio/webm' });

    const transcribeArgs: Array<[string, string]> = [];
    const turnPrompts: string[] = [];
    const synthOrder: string[] = [];

    const client = createBatchVoiceCallClient({
      transcribe: (audioBase64, mimeType) => {
        transcribeArgs.push([audioBase64, mimeType]);
        return Promise.resolve('  what is the weather  ');
      },
      synthesize: (text) => {
        synthOrder.push(text);
        return Promise.resolve({ audioBase64: `tts:${text}`, mimeType: 'audio/mp3' });
      },
      runAgentTurn: async function* (text) {
        turnPrompts.push(text);
        yield 'Clear skies. ';
        yield 'Twelve degrees.';
      },
      createDriver: () => driver,
    });

    const events: VoiceCallEvent[] = [];
    client.on((event) => events.push(event));
    await client.connect();

    // Playout is gated: release each clip as it starts so the turn can complete.
    await vi.waitFor(() => expect(driver.playStarts.length).toBe(1));
    driver.finishPlayback();
    await vi.waitFor(() => expect(driver.playStarts.length).toBe(2));
    driver.finishPlayback();
    await vi.waitFor(() => expect(events.some((e) => e.type === 'reply_complete')).toBe(true));

    // The captured bytes reached STT unmodified.
    expect(transcribeArgs).toEqual([['CAPTURED', 'audio/webm']]);
    // The trimmed transcript is what was committed and what drove the turn.
    expect(events.find((e) => e.type === 'utterance_committed')).toEqual({
      type: 'utterance_committed',
      text: 'what is the weather',
    });
    expect(turnPrompts).toEqual(['what is the weather']);
    // The reply was split into sentences, synthesized and played in reply order.
    expect(
      events.filter((e) => e.type === 'reply_sentence').map((e) => (e as { text: string }).text),
    ).toEqual(['Clear skies.', 'Twelve degrees.']);
    expect(synthOrder).toEqual(['Clear skies.', 'Twelve degrees.']);
    expect(driver.playStarts).toEqual(['tts:Clear skies.', 'tts:Twelve degrees.']);
    expect(events.find((e) => e.type === 'reply_complete')).toEqual({
      type: 'reply_complete',
      text: 'Clear skies. Twelve degrees.',
    });

    // Hands-free: the loop went back to listening for the next utterance.
    await vi.waitFor(() => expect(driver.captureCalls).toBeGreaterThanOrEqual(2));
    await client.disconnect();
    expect(driver.stopped).toBe(true);
  });
});

describe('talk-mode pin — sentence pipelining', () => {
  it('synthesizes sentence N+1 while sentence N is still playing, without reordering', async () => {
    const driver = new ControlledVoiceIoDriver();
    driver.utterances.push({ audioBase64: 'CAPTURED', mimeType: 'audio/webm' });
    const tts = gatedSynthesizer();
    const reply = new ReplyStream();

    const client = createBatchVoiceCallClient({
      transcribe: () => Promise.resolve('list three things'),
      synthesize: tts.synthesize,
      runAgentTurn: () => reply.stream(),
      createDriver: () => driver,
    });
    const events: VoiceCallEvent[] = [];
    client.on((event) => events.push(event));
    await client.connect();

    // Two sentences arrive together. BOTH are handed to synthesis immediately —
    // synthesis is not serialized behind playout.
    reply.push('One. Two. ');
    await vi.waitFor(() => expect(tts.calls).toEqual(['One.', 'Two.']));
    expect(driver.playStarts).toEqual([]);

    // Sentence 1's audio lands and starts playing; sentence 2's synthesis is
    // still in flight at that moment.
    tts.complete('One.');
    await vi.waitFor(() => expect(driver.playStarts).toEqual(['tts:One.']));

    // Sentence 3 is generated and synthesized DURING sentence 1's playout.
    reply.push('Three. ');
    await vi.waitFor(() => expect(tts.calls).toEqual(['One.', 'Two.', 'Three.']));
    expect(driver.playStarts).toEqual(['tts:One.']);

    // Later sentences finishing synthesis first must not jump the queue.
    tts.complete('Three.');
    tts.complete('Two.');
    expect(driver.playStarts).toEqual(['tts:One.']);

    reply.end();
    driver.finishPlayback();
    await vi.waitFor(() => expect(driver.playStarts).toEqual(['tts:One.', 'tts:Two.']));
    driver.finishPlayback();
    await vi.waitFor(() =>
      expect(driver.playStarts).toEqual(['tts:One.', 'tts:Two.', 'tts:Three.']),
    );
    driver.finishPlayback();

    await vi.waitFor(() => expect(events.some((e) => e.type === 'reply_complete')).toBe(true));
    expect(events.find((e) => e.type === 'reply_complete')).toEqual({
      type: 'reply_complete',
      text: 'One. Two. Three.',
    });
    await client.disconnect();
  });
});

describe('talk-mode pin — barge-in', () => {
  it('aborts the in-flight turn and stops playback when the user speaks over it', async () => {
    const driver = new ControlledVoiceIoDriver();
    driver.utterances.push({ audioBase64: 'CAPTURED', mimeType: 'audio/webm' });
    const reply = new ReplyStream();
    let turnAborted = false;
    let generatorResumed = false;

    const client = createBatchVoiceCallClient({
      transcribe: () => Promise.resolve('tell me a long story'),
      synthesize: (text) => Promise.resolve({ audioBase64: `tts:${text}`, mimeType: 'audio/mp3' }),
      runAgentTurn: async function* (_text, signal) {
        signal.addEventListener('abort', () => {
          turnAborted = true;
          // Production parity: `runBrowserVoiceTurn` forwards this same
          // signal to the `voice.runTurn` RPC call, which ends the stream.
          reply.end();
        });
        for await (const chunk of reply.stream()) {
          if (turnAborted) generatorResumed = true;
          yield chunk;
        }
      },
      createDriver: () => driver,
    });
    const events: VoiceCallEvent[] = [];
    client.on((event) => events.push(event));
    await client.connect();

    reply.push('Sentence one. Sentence two. ');
    await vi.waitFor(() => expect(driver.playStarts).toEqual(['tts:Sentence one.']));
    driver.finishPlayback();
    await vi.waitFor(() =>
      expect(driver.playStarts).toEqual(['tts:Sentence one.', 'tts:Sentence two.']),
    );

    driver.triggerBargeIn();
    await vi.waitFor(() => expect(events.some((e) => e.type === 'interrupted')).toBe(true));

    // The generation is aborted...
    expect(turnAborted).toBe(true);
    // ...and playback is stopped, not merely left to run out.
    expect(driver.stopPlaybackCalls).toBe(1);

    // Nothing further is spoken from the aborted turn.
    reply.push('Sentence three. ');
    reply.end();
    await vi.waitFor(() => expect(driver.captureCalls).toBeGreaterThanOrEqual(2));
    expect(driver.playStarts).toEqual(['tts:Sentence one.', 'tts:Sentence two.']);
    expect(generatorResumed).toBe(false);
    expect(events.some((e) => e.type === 'reply_complete')).toBe(false);

    await client.disconnect();
  });

  it('persists the honestly-played prefix, marked [interrupted]', async () => {
    const driver = new ControlledVoiceIoDriver();
    driver.utterances.push({ audioBase64: 'CAPTURED', mimeType: 'audio/webm' });
    const reply = new ReplyStream();

    const client = createBatchVoiceCallClient({
      transcribe: () => Promise.resolve('tell me a long story'),
      synthesize: (text) => Promise.resolve({ audioBase64: `tts:${text}`, mimeType: 'audio/mp3' }),
      runAgentTurn: (_text, signal) => {
        // Aborting the turn ends the upstream reply stream, as it does in
        // production (`runBrowserVoiceTurn` forwards the signal into the
        // `voice.runTurn` RPC call).
        signal.addEventListener('abort', () => reply.end(), { once: true });
        return reply.stream();
      },
      createDriver: () => driver,
    });
    const events: VoiceCallEvent[] = [];
    client.on((event) => events.push(event));
    await client.connect();

    // Three sentences are generated; only the first finishes playing.
    reply.push('Sentence one. Sentence two. Sentence three. ');
    await vi.waitFor(() => expect(driver.playStarts).toEqual(['tts:Sentence one.']));
    driver.finishPlayback();
    await vi.waitFor(() =>
      expect(driver.playStarts).toEqual(['tts:Sentence one.', 'tts:Sentence two.']),
    );
    driver.triggerBargeIn();

    await vi.waitFor(() => expect(events.some((e) => e.type === 'interrupted')).toBe(true));

    // The interrupted event carries ONLY what was actually heard — not the
    // sentence cut off mid-playout, and not the generated-but-unplayed tail.
    expect(events.find((e) => e.type === 'interrupted')).toEqual({
      type: 'interrupted',
      text: 'Sentence one.',
    });

    // And that honest prefix is what the transcript persists, marked.
    const messages = projectToChat(events);
    const agentMessage = messages[messages.length - 1];
    expect(agentMessage?.role === 'assistant' && agentMessage.blocks).toEqual([
      { kind: 'text', content: 'Sentence one. [interrupted]' },
    ]);

    await client.disconnect();
  });
});

describe('talk-mode pin — thinking earcon gate', () => {
  it('fires once per captured utterance before transcription when the chime is on', async () => {
    const driver = new ControlledVoiceIoDriver();
    driver.utterances.push({ audioBase64: 'CAPTURED', mimeType: 'audio/webm' });
    let earconsAtTranscribe = -1;

    const client = createBatchVoiceCallClient({
      transcribe: () => {
        earconsAtTranscribe = driver.earconCalls;
        return Promise.resolve('hello');
      },
      runAgentTurn: async function* () {
        yield 'Hi.';
      },
      createDriver: () => driver,
      chime: true,
    });
    const events: VoiceCallEvent[] = [];
    client.on((event) => events.push(event));
    await client.connect();

    await vi.waitFor(() => expect(events.some((e) => e.type === 'reply_complete')).toBe(true));
    expect(driver.earconCalls).toBe(1);
    expect(earconsAtTranscribe).toBe(1);
    await client.disconnect();
  });

  it('stays silent when the chime setting is off, without changing the turn', async () => {
    const driver = new ControlledVoiceIoDriver();
    driver.utterances.push({ audioBase64: 'CAPTURED', mimeType: 'audio/webm' });

    const client = createBatchVoiceCallClient({
      transcribe: () => Promise.resolve('hello'),
      runAgentTurn: async function* () {
        yield 'Hi.';
      },
      createDriver: () => driver,
      chime: false,
    });
    const events: VoiceCallEvent[] = [];
    client.on((event) => events.push(event));
    await client.connect();

    await vi.waitFor(() => expect(events.some((e) => e.type === 'reply_complete')).toBe(true));
    expect(driver.earconCalls).toBe(0);
    expect(events.find((e) => e.type === 'utterance_committed')).toEqual({
      type: 'utterance_committed',
      text: 'hello',
    });
    await client.disconnect();
  });
});

describe('talk-mode pin — hallucinated utterances', () => {
  // The phantom-phrase filter itself lives server-side (VoiceService.transcribe,
  // pinned in apps/web-api/src/services/__tests__/voice.service.test.ts), which
  // rejects rather than returning text. What is pinned here is the client half:
  // a rejected transcription NEVER becomes an agent turn, and the call keeps
  // listening.
  it('drops a rejected phantom utterance instead of sending it as a turn', async () => {
    const driver = new ControlledVoiceIoDriver();
    driver.utterances.push({ audioBase64: 'PHANTOM', mimeType: 'audio/webm' });
    const runAgentTurn = vi.fn(async function* () {
      yield 'unreachable';
    });

    const client = createBatchVoiceCallClient({
      // "Thank you for watching" — the canonical Whisper phantom — is filtered
      // upstream and surfaces to the browser as a rejection.
      transcribe: () => Promise.reject(new Error('Could not transcribe audio — try again')),
      runAgentTurn,
      createDriver: () => driver,
    });
    const events: VoiceCallEvent[] = [];
    client.on((event) => events.push(event));
    await client.connect();

    await vi.waitFor(() => expect(driver.captureCalls).toBeGreaterThanOrEqual(2));
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'utterance_committed')).toBe(false);
    expect(events.filter((e) => e.type === 'reply_sentence')).toEqual([]);
    expect(events.find((e) => e.type === 'error')).toEqual({
      type: 'error',
      error: 'Could not transcribe audio — try again',
    });
    // Nothing is written to the transcript for a dropped utterance.
    expect(projectToChat(events)).toEqual([]);

    await client.disconnect();
  });

  it('drops an empty transcript without running a turn', async () => {
    const driver = new ControlledVoiceIoDriver();
    driver.utterances.push({ audioBase64: 'SILENCE', mimeType: 'audio/webm' });
    const runAgentTurn = vi.fn(async function* () {
      yield 'unreachable';
    });

    const client = createBatchVoiceCallClient({
      transcribe: () => Promise.resolve('   '),
      runAgentTurn,
      createDriver: () => driver,
    });
    const events: VoiceCallEvent[] = [];
    client.on((event) => events.push(event));
    await client.connect();

    await vi.waitFor(() => expect(driver.captureCalls).toBeGreaterThanOrEqual(2));
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'utterance_committed')).toBe(false);

    await client.disconnect();
  });
});
