// Test doubles for the platform-voice adapter suites. Not a *.test.ts file, so
// vitest does not run it as a suite. `FakeVoiceTransport` is the in-memory
// VoiceTransport used to drive a full call without any real WebRTC/telephony.

import type {
  AgentEvent,
  PcmChunk,
  StreamingSttProvider,
  StreamingTtsProvider,
} from '@ethosagent/types';
import { STT_CONTRACT_VERSION } from '@ethosagent/types';
import type { AgentTurnRunner, Vad } from '@ethosagent/voice-session';
import type { OutboundCallHandle, OutboundCallRequest, SipTrunkClient } from '../sip/trunk-client';
import type { OutboundAudioFrame, VoiceTransport } from '../transport';

export class FakeVoiceTransport implements VoiceTransport {
  readonly callerId: string;
  connected = false;
  readonly sentAudio: OutboundAudioFrame[] = [];
  private handlers: Array<(chunk: PcmChunk) => void> = [];

  constructor(callerId: string) {
    this.callerId = callerId;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  onAudio(handler: (chunk: PcmChunk) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  sendAudio(frame: OutboundAudioFrame): void {
    this.sentAudio.push(frame);
  }

  /** Test driver: simulate one inbound audio frame from the participant. */
  emit(chunk: PcmChunk): void {
    for (const handler of this.handlers) handler(chunk);
  }
}

/** In-memory SipTrunkClient — records outbound calls without any real SIP
 *  trunk. `calls` is the assertion surface (empty ⇒ no call was placed). */
export class FakeSipTrunkClient implements SipTrunkClient {
  readonly calls: OutboundCallRequest[] = [];
  private seq = 0;

  async createOutboundCall(req: OutboundCallRequest): Promise<OutboundCallHandle> {
    this.calls.push(req);
    this.seq += 1;
    return { callId: `call-${this.seq}`, roomName: req.roomName, toNumber: req.toNumber };
  }
}

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

export function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
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

export function scriptedRunner(events: AgentEvent[]): AgentTurnRunner {
  return {
    async *run() {
      for (const event of events) yield event;
    },
  };
}

export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Feed `count` frames through the transport, advancing the injected clock so
 *  the VoiceSession's endpoint detector commits deterministically. */
export function feedTransport(
  transport: FakeVoiceTransport,
  clock: { advance: (ms: number) => void },
  frame: PcmChunk,
  count: number,
  stepMs = 20,
): void {
  for (let i = 0; i < count; i++) {
    clock.advance(stepMs);
    transport.emit(frame);
  }
}
