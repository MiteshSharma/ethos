// Shared test doubles for the voice-session suites. Not a *.test.ts file, so
// vitest does not run it as a suite.

import type {
  AgentEvent,
  PcmChunk,
  StreamingSttProvider,
  StreamingTtsProvider,
  SttProvider,
  TtsProvider,
} from '@ethosagent/types';
import { STT_CONTRACT_VERSION } from '@ethosagent/types';
import type { AgentTurnRunner, Vad, VoiceSessionEvent } from '../types';
import type { VoiceSession } from '../voice-session';

export function speechFrame(len = 320): PcmChunk {
  return { data: new Int16Array(len).fill(12000), sampleRate: 16000 };
}

export function silenceFrame(len = 320): PcmChunk {
  return { data: new Int16Array(len), sampleRate: 16000 };
}

export class FakeVad implements Vad {
  process(chunk: PcmChunk): { speech: boolean } {
    return { speech: chunk.data.some((v) => v !== 0) };
  }
}

export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/**
 * A hand-driven clock with timer support, for deterministic tests of the
 * filler debounce / tick interval. Same shape as `RealtimeControlLane`'s test
 * harness (`apps/web-api/src/voice/__tests__/realtime-control-lane.test.ts`) —
 * nothing here uses real timers, so a debounce is verified by advancing a
 * clock, not by sleeping.
 */
export class FakeTimerClock {
  private t = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();

  now = (): number => this.t;
  setTimer = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  clearTimer = (handle: unknown): void => {
    if (typeof handle === 'number') this.timers.delete(handle);
  };

  /** True while at least one timer is scheduled and has not fired. */
  hasPending(): boolean {
    return this.timers.size > 0;
  }

  /** Advance by `ms`, firing every timer due on the way, in due order. */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const timer = this.timers.get(nextId);
      this.timers.delete(nextId);
      if (!timer) break;
      this.t = timer.at;
      timer.fn();
    }
    this.t = target;
  }
}

export const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

export function streamingStt(text: string): StreamingSttProvider {
  return {
    name: 'fake-stt',
    caps: { kind: 'stt', formats: ['pcm'], streaming: true, contractVersion: STT_CONTRACT_VERSION },
    transcribeBuffer: async () => text,
    async *transcribeStream() {
      yield { text, isFinal: true };
    },
  };
}

export function batchStt(text: string): SttProvider {
  return {
    name: 'fake-batch-stt',
    caps: { kind: 'stt', formats: ['pcm'], contractVersion: STT_CONTRACT_VERSION },
    transcribeBuffer: async () => text,
  };
}

export function streamingTts(): StreamingTtsProvider {
  return {
    name: 'fake-tts',
    caps: { kind: 'tts', formats: ['pcm'], streaming: true, contractVersion: 1 },
    synthesize: async () => ({ audio: new Uint8Array([1]), format: 'pcm' }),
    async *synthesizeStream(text) {
      for await (const t of text) yield { audio: new Uint8Array([t.length & 0xff]), format: 'pcm' };
    },
  };
}

export function batchTts(): TtsProvider {
  return {
    name: 'fake-batch-tts',
    caps: { kind: 'tts', formats: ['pcm'], contractVersion: 1 },
    synthesize: async () => ({ audio: new Uint8Array([2]), format: 'pcm' }),
  };
}

export function scriptedRunner(events: AgentEvent[]): AgentTurnRunner {
  return {
    async *run() {
      for (const event of events) yield event;
    },
  };
}

export function feed(
  session: VoiceSession,
  clock: { advance: (ms: number) => void },
  frame: PcmChunk,
  count: number,
  stepMs = 20,
): void {
  for (let i = 0; i < count; i++) {
    clock.advance(stepMs);
    session.pushAudio(frame);
  }
}

export async function waitForEvent(
  events: VoiceSessionEvent[],
  type: VoiceSessionEvent['type'],
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!events.some((e) => e.type === type)) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${type}`);
    await tick();
  }
}

/**
 * Wait until `clock` has a scheduled timer — i.e. `VoiceSession` has armed the
 * filler debounce or the tick interval. Polls microtasks only; `FakeTimerClock`
 * never runs real time.
 */
export async function waitForTimer(clock: FakeTimerClock, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!clock.hasPending()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for a scheduled timer');
    await tick();
  }
}
