// Per-personality voice on the CHANNEL path (voice V1a §4 / task A16).
//
// `resolveVoicePreferences` used to have exactly one consumer — the
// wiring-built `VoiceSession` stack — so a personality's `voice.tts_voice`
// showed up in its character sheet and changed nothing you could hear on the
// two surfaces people actually reach first. This is the gateway half.
//
// Every assertion below is on what the TTS PROVIDER received. "The right
// function was called" is not the property under test; "the reply came out in
// the personality's voice" is, and only the provider's argument says so.

import type { AgentLoop } from '@ethosagent/core';
import { DefaultHookRegistry, DefaultTtsProviderRegistry } from '@ethosagent/core';
import type {
  DeliveryResult,
  InboundMessage,
  PersonalityVoiceConfig,
  PlatformAdapter,
  TtsProvider,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';

/** Records every `synthesize` call's voice argument. */
function recordingTts(): { provider: TtsProvider; voices: Array<string | undefined> } {
  const voices: Array<string | undefined> = [];
  return {
    voices,
    provider: {
      name: 'local-tts',
      caps: { kind: 'tts', formats: ['wav'], local: true, contractVersion: 1 },
      synthesize: async (_text, opts) => {
        voices.push(opts?.voice);
        return { audio: new Uint8Array([1]), format: 'wav' as const };
      },
    },
  };
}

function stubLoop(): AgentLoop {
  const hooks = new DefaultHookRegistry();
  return {
    hooks,
    run: vi.fn(async function* () {
      yield { type: 'text_delta' as const, text: 'here you go' };
      yield { type: 'done' as const, text: 'here you go', turnCount: 1 };
    }),
  } as unknown as AgentLoop;
}

function adapter(): PlatformAdapter {
  return {
    id: 'telegram:bot-1',
    displayName: 'Telegram',
    capabilities: { platform: 'telegram' },
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    async start() {},
    async stop() {},
    async send(): Promise<DeliveryResult> {
      return { ok: true, messageId: 'm1' };
    },
    onMessage() {},
    async health() {
      return { ok: true };
    },
  };
}

function inbound(text: string): InboundMessage {
  return {
    platform: 'telegram',
    botKey: 'bot-1',
    chatId: 'C1',
    userId: 'U1',
    text,
    isDm: true,
    isGroupMention: false,
    messageId: `msg-${Math.random()}`,
    raw: null,
  };
}

/**
 * Drive one full turn to the point where the reply is synthesized, and return
 * the voice ids the TTS provider was handed.
 */
async function spokenVoices(opts: {
  personalityVoice?: PersonalityVoiceConfig;
  globalTtsVoice?: string;
}): Promise<Array<string | undefined>> {
  const { provider, voices } = recordingTts();
  const ttsRegistry = new DefaultTtsProviderRegistry();
  ttsRegistry.register('local-tts', () => provider);

  const gateway = new Gateway({
    bots: [
      {
        botKey: 'bot-1',
        loop: stubLoop(),
        binding: { type: 'personality', name: 'voice' },
      },
    ],
    ttsProviderRegistry: ttsRegistry,
    ttsProviderName: 'local-tts',
    ...(opts.globalTtsVoice ? { ttsProviderConfig: { voice: opts.globalTtsVoice } } : {}),
    // Speak on every reply so the test does not need an inbound voice note to
    // reach the synthesis path.
    defaultVoiceMode: 'all',
    personalityDirectory: {
      refresh: async () => {},
      has: () => true,
      list: () => [{ id: 'voice', name: 'Voice', isDefault: true }],
      voice: () => opts.personalityVoice,
    },
    clarifySweepIntervalMs: 0,
  });

  await gateway.handleMessage(inbound('say something'), adapter());
  return voices;
}

describe('gateway channel TTS — personality voice', () => {
  it('speaks in the personality voice, not the global default', async () => {
    const voices = await spokenVoices({
      personalityVoice: { tts_voice: 'af_bella' },
      globalTtsVoice: 'am_michael',
    });
    expect(voices).toEqual(['af_bella']);
  });

  it('falls back to the global config voice when the personality declares none', async () => {
    const voices = await spokenVoices({ globalTtsVoice: 'am_michael' });
    expect(voices).toEqual(['am_michael']);
  });

  it('passes no voice at all when neither is configured — the provider default stands', async () => {
    const voices = await spokenVoices({});
    expect(voices).toEqual([undefined]);
  });

  it('honours the personality voice even with no global default', async () => {
    const voices = await spokenVoices({ personalityVoice: { tts_voice: 'ef_dora' } });
    expect(voices).toEqual(['ef_dora']);
  });

  it('a personality with only a language map still falls back to global', async () => {
    // The gateway has no per-turn language signal today, so a language-only
    // block cannot select — and must not silently blank the global voice.
    const voices = await spokenVoices({
      personalityVoice: { languages: { es: 'ef_dora' } },
      globalTtsVoice: 'am_michael',
    });
    expect(voices).toEqual(['am_michael']);
  });

  it('works without the optional `voice()` seam — legacy deployments unchanged', async () => {
    const { provider, voices } = recordingTts();
    const ttsRegistry = new DefaultTtsProviderRegistry();
    ttsRegistry.register('local-tts', () => provider);
    const gateway = new Gateway({
      bots: [
        { botKey: 'bot-1', loop: stubLoop(), binding: { type: 'personality', name: 'voice' } },
      ],
      ttsProviderRegistry: ttsRegistry,
      ttsProviderName: 'local-tts',
      ttsProviderConfig: { voice: 'am_michael' },
      defaultVoiceMode: 'all',
      personalityDirectory: {
        refresh: async () => {},
        has: () => true,
        list: () => [],
      },
      clarifySweepIntervalMs: 0,
    });

    await gateway.handleMessage(inbound('say something'), adapter());
    expect(voices).toEqual(['am_michael']);
  });
});
