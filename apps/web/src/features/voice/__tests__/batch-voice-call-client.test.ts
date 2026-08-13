import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type BatchVoiceCallDeps,
  createBatchVoiceCallClient,
  createBrowserVoiceIoDriver,
  type SynthesizedClip,
  type UtteranceCapture,
  type VoiceIoDriver,
} from '../batch-voice-call-client';
import type { VoiceCallEvent } from '../voice-call-client';

// Fake browser-audio driver: feeds preloaded utterances, records play() calls,
// and lets a test trigger barge-in on demand — so the whole client loop runs in
// the node vitest env with no getUserMedia / AudioContext / MediaRecorder.
class FakeVoiceIoDriver implements VoiceIoDriver {
  readonly utterances: UtteranceCapture[] = [];
  readonly playCalls: string[] = [];
  captureCalls = 0;
  earconCalls = 0;
  started = false;
  stopped = false;
  blockPlayback = false;
  private bargeEnabled = false;
  private readonly bargeListeners = new Set<() => void>();

  start(): Promise<void> {
    this.started = true;
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
    // No more preloaded utterances — resolve null once disconnect aborts, so
    // the loop terminates cleanly under the test's control.
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve(null);
        return;
      }
      signal.addEventListener('abort', () => resolve(null), { once: true });
    });
  }

  play(audioBase64: string, _mimeType: string, signal: AbortSignal): Promise<void> {
    this.playCalls.push(audioBase64);
    if (!this.blockPlayback) return Promise.resolve();
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
        once: true,
      });
    });
  }

  playEarcon(): void {
    this.earconCalls++;
  }

  onBargeIn(listener: () => void): () => void {
    this.bargeListeners.add(listener);
    return () => this.bargeListeners.delete(listener);
  }

  setBargeInEnabled(enabled: boolean): void {
    this.bargeEnabled = enabled;
  }

  triggerBargeIn(): void {
    if (!this.bargeEnabled) return;
    for (const listener of [...this.bargeListeners]) listener();
  }

  stopPlayback(): void {}

  stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }
}

function collect(client: ReturnType<typeof createBatchVoiceCallClient>): VoiceCallEvent[] {
  const events: VoiceCallEvent[] = [];
  client.on((event) => events.push(event));
  return events;
}

function texts(events: VoiceCallEvent[], type: 'reply_sentence'): string[] {
  return events
    .filter((e): e is Extract<VoiceCallEvent, { type: 'reply_sentence' }> => e.type === type)
    .map((e) => e.text);
}

// Sentence splitting itself is tested in @ethosagent/voice-text — the client
// imports that one implementation. What is tested here is the loop around it.

describe('createBatchVoiceCallClient — full turn cycle', () => {
  it('listens → commits an utterance → speaks sentences in order → completes → listens again', async () => {
    const driver = new FakeVoiceIoDriver();
    driver.utterances.push({ audioBase64: 'UTTER', mimeType: 'audio/webm' });

    const synthOrder: string[] = [];
    const deps: BatchVoiceCallDeps = {
      transcribe: () => Promise.resolve('  hello there  '),
      synthesize: (text): Promise<SynthesizedClip> => {
        synthOrder.push(text);
        return Promise.resolve({ audioBase64: `tts:${text}`, mimeType: 'audio/mp3' });
      },
      runAgentTurn: async function* () {
        yield 'Hi friend. ';
        yield 'How are you?';
      },
      createDriver: () => driver,
    };

    const client = createBatchVoiceCallClient(deps);
    const events = collect(client);
    await client.connect();

    await vi.waitFor(() => expect(events.some((e) => e.type === 'reply_complete')).toBe(true));

    // The endpoint is reported first, before the transcribe round trip — that
    // is what puts the UI in `thinking` when the user actually stopped talking.
    expect(events[0]).toEqual({ type: 'speech_end' });
    // Transcript trimmed and committed.
    expect(events.find((e) => e.type === 'utterance_committed')).toEqual({
      type: 'utterance_committed',
      text: 'hello there',
    });
    // Sentences split, synthesized, and played in order.
    expect(texts(events, 'reply_sentence')).toEqual(['Hi friend.', 'How are you?']);
    expect(synthOrder).toEqual(['Hi friend.', 'How are you?']);
    expect(driver.playCalls).toEqual(['tts:Hi friend.', 'tts:How are you?']);
    // reply_complete carries the whole reply.
    expect(events.find((e) => e.type === 'reply_complete')).toEqual({
      type: 'reply_complete',
      text: 'Hi friend. How are you?',
    });

    // Hands-free: the loop returns to listening (captures again).
    await vi.waitFor(() => expect(driver.captureCalls).toBeGreaterThanOrEqual(2));
    await client.disconnect();
    expect(driver.stopped).toBe(true);
  });

  it('drops an empty transcript without running an agent turn', async () => {
    const driver = new FakeVoiceIoDriver();
    driver.utterances.push({ audioBase64: 'UTTER', mimeType: 'audio/webm' });

    const runAgentTurn = vi.fn(async function* () {
      yield 'unreachable';
    });
    const client = createBatchVoiceCallClient({
      transcribe: () => Promise.resolve('   '),
      runAgentTurn,
      createDriver: () => driver,
    });
    const events = collect(client);
    await client.connect();

    // Loop moves on to the next capture without committing anything.
    await vi.waitFor(() => expect(driver.captureCalls).toBeGreaterThanOrEqual(2));
    expect(events.some((e) => e.type === 'utterance_committed')).toBe(false);
    // The floor goes back to the user: the endpoint said "thinking", so
    // something has to say "listening" again or the strip sticks there.
    expect(events.map((e) => e.type)).toEqual(['speech_end', 'utterance_dropped']);
    expect(runAgentTurn).not.toHaveBeenCalled();
    // The earcon still fired — the utterance was captured, just transcribed to
    // nothing. Acknowledgement happens on capture, before transcription.
    expect(driver.earconCalls).toBe(1);
    await client.disconnect();
  });

  it('fires the processing earcon once per captured utterance, before transcription', async () => {
    const driver = new FakeVoiceIoDriver();
    driver.utterances.push({ audioBase64: 'UTTER', mimeType: 'audio/webm' });

    let earconAtTranscribe = -1;
    const client = createBatchVoiceCallClient({
      transcribe: () => {
        earconAtTranscribe = driver.earconCalls;
        return Promise.resolve('hello');
      },
      runAgentTurn: async function* () {
        yield 'Hi.';
      },
      createDriver: () => driver,
    });
    const events = collect(client);
    await client.connect();

    await vi.waitFor(() => expect(events.some((e) => e.type === 'reply_complete')).toBe(true));
    // Exactly one earcon for the one captured utterance...
    expect(driver.earconCalls).toBe(1);
    // ...and it fired BEFORE transcription began.
    expect(earconAtTranscribe).toBe(1);
    await client.disconnect();
  });

  it('does not fire the earcon when chime is disabled, but still runs the turn', async () => {
    const driver = new FakeVoiceIoDriver();
    driver.utterances.push({ audioBase64: 'UTTER', mimeType: 'audio/webm' });

    const client = createBatchVoiceCallClient({
      transcribe: () => Promise.resolve('hello'),
      runAgentTurn: async function* () {
        yield 'Hi.';
      },
      createDriver: () => driver,
      chime: false,
    });
    const events = collect(client);
    await client.connect();

    await vi.waitFor(() => expect(events.some((e) => e.type === 'reply_complete')).toBe(true));
    // The earcon never fired for the captured utterance...
    expect(driver.earconCalls).toBe(0);
    // ...but the rest of the turn still ran: committed and replied.
    expect(events.find((e) => e.type === 'utterance_committed')).toEqual({
      type: 'utterance_committed',
      text: 'hello',
    });
    expect(texts(events, 'reply_sentence')).toEqual(['Hi.']);
    await client.disconnect();
  });

  it('surfaces the reply as text (no synthesis) when no TTS is configured', async () => {
    const driver = new FakeVoiceIoDriver();
    driver.utterances.push({ audioBase64: 'UTTER', mimeType: 'audio/webm' });

    const client = createBatchVoiceCallClient({
      transcribe: () => Promise.resolve('hi'),
      runAgentTurn: async function* () {
        yield 'Text only. ';
      },
      createDriver: () => driver,
    });
    const events = collect(client);
    await client.connect();

    await vi.waitFor(() => expect(events.some((e) => e.type === 'reply_complete')).toBe(true));
    expect(texts(events, 'reply_sentence')).toEqual(['Text only.']);
    expect(driver.playCalls).toEqual([]); // nothing synthesized → nothing played
    await client.disconnect();
  });
});

describe('createBatchVoiceCallClient — barge-in', () => {
  it('aborts the turn, emits interrupted, and returns to listening', async () => {
    const driver = new FakeVoiceIoDriver();
    driver.blockPlayback = true; // hold playout so barge-in lands mid-turn
    driver.utterances.push({ audioBase64: 'UTTER', mimeType: 'audio/webm' });

    let turnAborted = false;
    const client = createBatchVoiceCallClient({
      transcribe: () => Promise.resolve('tell me a long story'),
      synthesize: (text) => Promise.resolve({ audioBase64: `tts:${text}`, mimeType: 'audio/mp3' }),
      runAgentTurn: async function* (_text, signal) {
        signal.addEventListener('abort', () => {
          turnAborted = true;
        });
        yield 'Once upon a time. ';
        yield 'The end.';
      },
      createDriver: () => driver,
    });
    const events = collect(client);
    await client.connect();

    // Wait until the first sentence is playing (blocked), then speak over it.
    await vi.waitFor(() => expect(driver.playCalls.length).toBeGreaterThanOrEqual(1));
    driver.triggerBargeIn();

    await vi.waitFor(() => expect(events.some((e) => e.type === 'interrupted')).toBe(true));
    expect(turnAborted).toBe(true);

    // Recovers hands-free: the loop listens for the next utterance.
    await vi.waitFor(() => expect(driver.captureCalls).toBeGreaterThanOrEqual(2));
    await client.disconnect();
  });
});

describe('createBrowserVoiceIoDriver — tuning injection', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses the injected barge-in tuning instead of the built-in default', async () => {
    vi.useFakeTimers();
    // A constant byte level fed to the analyser: 128 = silence, 200 = speech
    // (rms ≈ 0.56, above any threshold used here).
    let level = 128;
    const analyser = {
      fftSize: 2048,
      getByteTimeDomainData: (data: Uint8Array) => data.fill(level),
    };
    const track = { enabled: true, stop: () => {} };
    const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: () => Promise.resolve(stream) },
    });
    vi.stubGlobal(
      'AudioContext',
      class {
        state = 'running';
        currentTime = 0;
        createMediaStreamSource() {
          return { connect() {} };
        }
        createAnalyser() {
          return analyser;
        }
        close() {
          return Promise.resolve();
        }
      },
    );

    // bargeSustainMs 400 (default is 250). The barge monitor ticks every 80ms and
    // accumulates while speech stays above threshold.
    const driver = createBrowserVoiceIoDriver({
      tuning: { bargeSustainMs: 400, bargeThreshold: 0.05 },
    });
    await driver.start();
    let fired = 0;
    driver.onBargeIn(() => {
      fired++;
    });
    level = 200; // sustained speech
    driver.setBargeInEnabled(true);

    // At 320ms the DEFAULT (250ms) would already have fired — the injected 400ms
    // must not.
    vi.advanceTimersByTime(320);
    expect(fired).toBe(0);
    // The injected 400ms threshold is reached on the next tick.
    vi.advanceTimersByTime(80);
    expect(fired).toBe(1);

    await driver.stop();
  });
});
