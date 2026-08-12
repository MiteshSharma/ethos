import { describe, expect, it } from 'vitest';
import {
  REALTIME_AUDIO_FORMAT,
  REALTIME_CONTRACT_VERSION,
  type RealtimeEphemeralToken,
  type RealtimeEvent,
  type RealtimeSession,
  type RealtimeVoiceProvider,
} from '../voice-realtime';

// `packages/types` is interfaces-only, so most of this file is a compile-time
// assertion wearing a test's clothes: if the contract stops being implementable
// the typecheck fails, and the runtime expectations below only pin the two
// constants and the fixture's observable behaviour.

const EVENTS: RealtimeEvent[] = [
  { type: 'session_open', sessionId: 's1', model: 'fake-realtime' },
  { type: 'audio', pcm: new Uint8Array([0, 1, 2, 3]), sampleRate: 24_000 },
  { type: 'transcript', role: 'user', text: 'hello', isFinal: true },
  { type: 'transcript', role: 'assistant', text: 'hi', isFinal: false },
  { type: 'tool_call', callId: 'c1', name: 'read_file', args: { path: 'a.txt' } },
  { type: 'speech_started' },
  { type: 'response_done', responseId: 'r1' },
  { type: 'error', error: 'transport hiccup', code: 'transport_error' },
  { type: 'closed', reason: 'client closed' },
];

function describeEvent(event: RealtimeEvent): string {
  switch (event.type) {
    case 'session_open':
      return `open:${event.sessionId}`;
    case 'audio':
      return `audio:${event.pcm.length}@${event.sampleRate}`;
    case 'transcript':
      return `transcript:${event.role}:${event.isFinal ? 'final' : 'partial'}:${event.text}`;
    case 'tool_call':
      return `tool:${event.name}:${event.callId}`;
    case 'speech_started':
      return 'speech_started';
    case 'response_done':
      return `done:${event.responseId ?? ''}`;
    case 'error':
      return `error:${event.code}`;
    case 'closed':
      return `closed:${event.reason}`;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

const sentAudio: Uint8Array[] = [];
const toolResults: Array<[string, string]> = [];
const calls: string[] = [];

const session: RealtimeSession = {
  events: {
    async *[Symbol.asyncIterator]() {
      for (const event of EVENTS) yield event;
    },
  },
  async sendAudio(pcm) {
    sentAudio.push(pcm);
  },
  async sendToolResult(callId, output) {
    toolResults.push([callId, output]);
  },
  async interrupt() {
    calls.push('interrupt');
  },
  async close() {
    calls.push('close');
  },
  async say(text) {
    calls.push(`say:${text}`);
  },
};

const provider: RealtimeVoiceProvider = {
  name: 'fake-realtime',
  caps: {
    kind: 'realtime',
    inputSampleRate: 24_000,
    outputSampleRate: 24_000,
    local: false,
    voices: ['alloy'],
    languages: ['en'],
    ephemeralToken: true,
    contractVersion: REALTIME_CONTRACT_VERSION,
  },
  async open() {
    return session;
  },
  async mintEphemeralToken(): Promise<RealtimeEphemeralToken> {
    return { token: 'ek_fake', expiresAt: 1_700_000_000_000, url: 'wss://example/rt', model: 'm' };
  },
};

// A provider with no browser-direct path and no `say` still satisfies the
// contract — both are optional, and this is the shape a local provider takes.
const minimalProvider: RealtimeVoiceProvider = {
  name: 'minimal-realtime',
  // Asymmetric on purpose: the contract carries two rates because a provider
  // is not obliged to listen and speak at the same one.
  caps: {
    kind: 'realtime',
    inputSampleRate: 16_000,
    outputSampleRate: 24_000,
    local: true,
    contractVersion: 1,
  },
  async open() {
    return {
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'closed', reason: 'not implemented' } satisfies RealtimeEvent;
        },
      },
      async sendAudio() {},
      async sendToolResult() {},
      async interrupt() {},
      async close() {},
    };
  },
};

describe('realtime voice contract', () => {
  it('pins the contract version and the single audio format', () => {
    expect(REALTIME_CONTRACT_VERSION).toBe(1);
    expect(REALTIME_AUDIO_FORMAT).toBe('pcm_s16le');
  });

  it('is re-exported from the package barrel', async () => {
    const types = await import('../index');
    expect(types.REALTIME_CONTRACT_VERSION).toBe(REALTIME_CONTRACT_VERSION);
    expect(types.REALTIME_AUDIO_FORMAT).toBe(REALTIME_AUDIO_FORMAT);
  });

  it('handles every RealtimeEvent variant exhaustively', () => {
    expect(EVENTS.map(describeEvent)).toEqual([
      'open:s1',
      'audio:4@24000',
      'transcript:user:final:hello',
      'transcript:assistant:partial:hi',
      'tool:read_file:c1',
      'speech_started',
      'done:r1',
      'error:transport_error',
      'closed:client closed',
    ]);
  });

  it('is implementable — a session drives duplex audio, tools and barge-in', async () => {
    const opened = await provider.open({
      instructions: 'You are a test personality.',
      voice: 'alloy',
      tools: [{ name: 'read_file', description: 'read a file', parameters: { type: 'object' } }],
    });

    const seen: string[] = [];
    for await (const event of opened.events) {
      seen.push(event.type);
      if (event.type === 'speech_started') await opened.interrupt();
      if (event.type === 'tool_call') await opened.sendToolResult(event.callId, 'file contents');
    }

    await opened.sendAudio(new Uint8Array([7, 7]));
    await opened.say?.('one moment');
    await opened.close();

    expect(seen).toEqual(EVENTS.map((e) => e.type));
    expect(toolResults).toEqual([['c1', 'file contents']]);
    expect(sentAudio).toHaveLength(1);
    expect(calls).toEqual(['interrupt', 'say:one moment', 'close']);
  });

  it('mints an ephemeral token with an absolute expiry', async () => {
    const token = await provider.mintEphemeralToken?.({ instructions: 'hi' });
    expect(token?.token).toBe('ek_fake');
    expect(token?.expiresAt).toBeGreaterThan(0);
    expect(token?.url).toBe('wss://example/rt');
  });

  it('admits a provider that omits both optional methods', async () => {
    expect(minimalProvider.mintEphemeralToken).toBeUndefined();
    const opened = await minimalProvider.open({ instructions: 'hi' });
    expect(opened.say).toBeUndefined();
    const events: RealtimeEvent[] = [];
    for await (const event of opened.events) events.push(event);
    expect(events).toEqual([{ type: 'closed', reason: 'not implemented' }]);
  });
});
