import type { RealtimeVoiceProvider } from '@ethosagent/types';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createFakeRealtimeServer,
  REALTIME_CONTRACT_CHECKS,
  type RealtimeConformanceTarget,
  runRealtimeContractSuite,
} from '../realtime-conformance';
import { downsample24kTo16k, GeminiLiveProvider } from '../realtime-gemini';

const target: RealtimeConformanceTarget = {
  label: 'gemini-live',
  createProvider: (socketFactory) => new GeminiLiveProvider({ apiKey: 'test-key', socketFactory }),
  confirmSession: [{ setupComplete: {} }],
  audioDelta: (pcmBase64) => ({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcmBase64 } }] },
    },
  }),
  // Gemini streams transcripts with NO finality flag — `turnComplete` is the
  // only boundary — so the settled text is the accumulation of the deltas.
  userTranscript: {
    partial: { serverContent: { inputTranscription: { text: 'what is the weather' } } },
    partialText: 'what is the weather',
    final: { serverContent: { turnComplete: true } },
    finalText: 'what is the weather',
  },
  assistantTranscript: {
    partial: { serverContent: { outputTranscription: { text: 'it is sunny' } } },
    partialText: 'it is sunny',
    final: { serverContent: { turnComplete: true } },
    finalText: 'it is sunny',
  },
  toolCall: (callId, name, args) => ({ toolCall: { functionCalls: [{ id: callId, name, args }] } }),
  // Not "the user started speaking" but "I stopped because they did" — the same
  // barge-in trigger arriving from the other side of the decision.
  speechStarted: { serverContent: { interrupted: true } },
  providerError: {
    frame: { error: { code: 'INVALID_ARGUMENT', message: 'unsupported voice' } },
    error: 'unsupported voice',
    code: 'INVALID_ARGUMENT',
  },
  expectAudioWrite: (sent, pcm) => {
    if (sent.length !== 1) return [`expected 1 audio frame, got ${sent.length}`];
    const frame = sent[0] as { realtimeInput?: { audio?: { mimeType?: string; data?: string } } };
    const errors: string[] = [];
    if (frame.realtimeInput?.audio?.mimeType !== 'audio/pcm;rate=16000') {
      errors.push(`audio mimeType was "${frame.realtimeInput?.audio?.mimeType}"`);
    }
    // The caller hands 24 kHz (the declared caps rate); the wire takes 16 kHz.
    const expected = Buffer.from(downsample24kTo16k(pcm)).toString('base64');
    if (frame.realtimeInput?.audio?.data !== expected) {
      errors.push('audio frame did not carry the 16 kHz decimation of the supplied PCM');
    }
    return errors;
  },
  expectToolResultWrite: (sent, callId, output) => {
    if (sent.length !== 1) return [`expected 1 toolResponse frame, got ${sent.length}`];
    const frame = sent[0] as {
      toolResponse?: {
        functionResponses?: Array<{ id?: string; name?: string; response?: { output?: string } }>;
      };
    };
    const response = frame.toolResponse?.functionResponses?.[0];
    const errors: string[] = [];
    if (!response) return ['frame carried no functionResponses'];
    if (response.id !== callId) errors.push(`functionResponse id was "${response.id}"`);
    if (response.name !== 'lookup') errors.push(`functionResponse name was "${response.name}"`);
    if (response.response?.output !== output) {
      errors.push(`functionResponse output was "${response.response?.output}"`);
    }
    return errors;
  },
  // Gemini cancels generation server-side the moment its VAD hears the user, so
  // there is nothing for the client to write. The contract only obliges
  // `interrupt()` to resolve — this is the asymmetry it has to absorb.
  expectInterruptWrite: (sent) =>
    sent.length === 0 ? [] : [`expected no cancel frame, got ${JSON.stringify(sent)}`],
};

describe('gemini-live — shared realtime contract suite', () => {
  let results: Map<string, string[]>;

  beforeAll(async () => {
    const checks = await runRealtimeContractSuite(target);
    results = new Map(checks.map((check) => [check.name, check.errors]));
  });

  for (const name of REALTIME_CONTRACT_CHECKS) {
    it(name, () => {
      expect(results.get(name) ?? ['the check did not run']).toEqual([]);
    });
  }
});

describe('gemini-live wire details', () => {
  it('connects with the key as a query parameter and no Authorization header', async () => {
    const server = createFakeRealtimeServer();
    const provider = new GeminiLiveProvider({ apiKey: 'gk-test', socketFactory: server.factory });
    const session = await provider.open({ instructions: 'be brief' });

    expect(server.init?.url).toBe(
      'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=gk-test',
    );
    expect(server.init?.headers).toBeUndefined();
    await session.close();
  });

  it('sends a setup handshake carrying instructions, voice, language and tools', async () => {
    const server = createFakeRealtimeServer();
    const provider = new GeminiLiveProvider({
      apiKey: 'k',
      model: 'gemini-live-2.5-flash-preview',
      socketFactory: server.factory,
    });
    const session = await provider.open({
      instructions: 'You are Ethos.',
      voice: 'Puck',
      language: 'en-GB',
      tools: [
        { name: 'agent_consult', description: 'ask the agent', parameters: { type: 'object' } },
      ],
    });

    expect(server.sent[0]).toEqual({
      setup: {
        model: 'models/gemini-live-2.5-flash-preview',
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } },
            languageCode: 'en-GB',
          },
        },
        systemInstruction: { parts: [{ text: 'You are Ethos.' }] },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        tools: [
          {
            functionDeclarations: [
              {
                name: 'agent_consult',
                description: 'ask the agent',
                parameters: { type: 'object' },
              },
            ],
          },
        ],
      },
    });
    await session.close();
  });

  it('declares no browser-direct credential and no verbatim say()', async () => {
    // Typed as the contract, not the class: `mintEphemeralToken` is optional on
    // `RealtimeVoiceProvider`, and its absence is the whole point of the check.
    const provider: RealtimeVoiceProvider = new GeminiLiveProvider({ apiKey: 'k' });
    expect(provider.caps.ephemeralToken).toBe(false);
    expect(provider.mintEphemeralToken).toBeUndefined();

    const server = createFakeRealtimeServer();
    const relayed = new GeminiLiveProvider({ apiKey: 'k', socketFactory: server.factory });
    const session = await relayed.open({ instructions: 'x' });
    expect(session.say).toBeUndefined();
    await session.close();
  });

  it('surfaces goAway as a recoverable error before the socket actually closes', async () => {
    const server = createFakeRealtimeServer();
    const provider = new GeminiLiveProvider({ apiKey: 'k', socketFactory: server.factory });
    const session = await provider.open({ instructions: 'x' });
    const seen: Array<{ type: string; code?: string }> = [];
    const drain = (async () => {
      for await (const event of session.events) {
        seen.push(
          event.type === 'error' ? { type: event.type, code: event.code } : { type: event.type },
        );
      }
    })();

    server.deliver({ setupComplete: {} });
    server.deliver({ goAway: { timeLeft: '10s' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    server.drop('server closed the session');
    await drain;

    expect(seen).toEqual([
      { type: 'session_open' },
      { type: 'error', code: 'go_away' },
      { type: 'closed' },
    ]);
  });
});

describe('downsample24kTo16k', () => {
  it('decimates 3 input samples to 2 output samples', () => {
    const input = new Int16Array([0, 3000, 6000, 9000, 12_000, 15_000]);
    const out = downsample24kTo16k(new Uint8Array(input.buffer));
    expect(out.byteLength).toBe(8);

    const samples = new Int16Array(out.buffer, out.byteOffset, out.byteLength / 2);
    // positions 0, 1.5, 3, 4.5 → exact, midpoint, exact, midpoint
    expect(Array.from(samples)).toEqual([0, 4500, 9000, 13_500]);
  });

  it('handles a lone trailing sample without reading past the buffer', () => {
    const input = new Int16Array([1000, 2000, 3000, 4000]);
    const out = downsample24kTo16k(new Uint8Array(input.buffer));
    expect(out.byteLength).toBe(4);
  });
});
