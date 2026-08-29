import type { RealtimeVoiceProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createFakeRealtimeServer } from '../realtime-conformance';
import { GeminiLiveProvider } from '../realtime-gemini';

// The shared 11-check contract suite runs from `realtime-contract.test.ts`,
// which drives every REGISTERED provider. What stays here is this provider's
// own wire detail — the part no other provider shares.

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
