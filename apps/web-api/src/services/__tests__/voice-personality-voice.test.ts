// Per-personality voice on the BROWSER path (voice V1a §4 / task A16).
//
// Talk-mode used to hand the server the global `auxiliary.tts.voice` it read
// out of Settings, and the server passed it straight to the provider — so a
// personality's declared voice changed its character sheet and nothing you
// could hear. The fix is not "send the personality's voice from the browser":
// it is to send WHO is speaking and let the one shared precedence function
// decide, so this surface cannot drift from the gateway's answer.
//
// Precedence under test, end to end, asserted on the argument the TTS provider
// actually received:
//
//   voice.languages.<tag>  >  voice.tts_voice  >  the caller's global voice

import { DefaultTtsProviderRegistry } from '@ethosagent/core';
import type { PersonalityVoiceConfig, TtsProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { VoiceService } from '../voice.service';

function recordingTts(): { provider: TtsProvider; voices: Array<string | undefined> } {
  const voices: Array<string | undefined> = [];
  return {
    voices,
    provider: {
      name: 'local-tts',
      caps: { kind: 'tts', formats: ['wav'], local: true, contractVersion: 1 },
      synthesize: async (_text, opts) => {
        voices.push(opts?.voice);
        return { audio: new Uint8Array([1, 2]), format: 'wav' as const };
      },
    },
  };
}

function service(personalityVoice?: PersonalityVoiceConfig): {
  voice: VoiceService;
  voices: Array<string | undefined>;
} {
  const { provider, voices } = recordingTts();
  const registry = new DefaultTtsProviderRegistry();
  registry.register('local-tts', () => provider);
  return {
    voices,
    voice: new VoiceService({
      ttsRegistry: registry,
      ttsProviderName: 'local-tts',
      personalities: {
        get: (id) => (id === 'voice' ? { voice: personalityVoice } : undefined),
      },
    }),
  };
}

const TALKER: PersonalityVoiceConfig = {
  tts_voice: 'af_bella',
  languages: { es: 'ef_dora' },
};

describe('VoiceService.synthesize — personality voice precedence', () => {
  it('prefers the personality voice over the global default the client sent', async () => {
    const { voice, voices } = service(TALKER);
    await voice.synthesize('hola', { voice: 'am_michael', personalityId: 'voice' });
    expect(voices).toEqual(['af_bella']);
  });

  it('prefers a language-specific voice over the personality default', async () => {
    const { voice, voices } = service(TALKER);
    await voice.synthesize('hola', {
      voice: 'am_michael',
      personalityId: 'voice',
      language: 'es',
    });
    expect(voices).toEqual(['ef_dora']);
  });

  it('falls back to the global voice for a language the personality does not map', async () => {
    const { voice, voices } = service({ languages: { es: 'ef_dora' } });
    await voice.synthesize('hello', {
      voice: 'am_michael',
      personalityId: 'voice',
      language: 'ja',
    });
    expect(voices).toEqual(['am_michael']);
  });

  it('falls back to the global voice when the personality declares none', async () => {
    const { voice, voices } = service(undefined);
    await voice.synthesize('hello', { voice: 'am_michael', personalityId: 'voice' });
    expect(voices).toEqual(['am_michael']);
  });

  it('passes no voice when nothing is configured — the provider default stands', async () => {
    const { voice, voices } = service(undefined);
    await voice.synthesize('hello');
    expect(voices).toEqual([undefined]);
  });

  it('an unknown personality id degrades to the global voice, it does not throw', async () => {
    const { voice, voices } = service(TALKER);
    await voice.synthesize('hello', { voice: 'am_michael', personalityId: 'nobody' });
    expect(voices).toEqual(['am_michael']);
  });

  it('without a personality registry wired, the global voice is used', async () => {
    const { provider, voices } = recordingTts();
    const registry = new DefaultTtsProviderRegistry();
    registry.register('local-tts', () => provider);
    const voice = new VoiceService({ ttsRegistry: registry, ttsProviderName: 'local-tts' });
    await voice.synthesize('hello', { voice: 'am_michael', personalityId: 'voice' });
    expect(voices).toEqual(['am_michael']);
  });
});

describe('VoiceService.synthesizeStream — same precedence on the WS lane', () => {
  async function drain(stream: AsyncIterable<unknown>): Promise<void> {
    for await (const _ of stream) {
      // consume
    }
  }

  it('prefers the personality voice over the global default', async () => {
    const { voice, voices } = service(TALKER);
    await drain(voice.synthesizeStream('hola', { voice: 'am_michael', personalityId: 'voice' }));
    expect(voices).toEqual(['af_bella']);
  });

  it('prefers a language-specific voice over the personality default', async () => {
    const { voice, voices } = service(TALKER);
    await drain(
      voice.synthesizeStream('hola', {
        voice: 'am_michael',
        personalityId: 'voice',
        language: 'es',
      }),
    );
    expect(voices).toEqual(['ef_dora']);
  });

  it('falls back to the global default with no personality', async () => {
    const { voice, voices } = service(undefined);
    await drain(voice.synthesizeStream('hello', { voice: 'am_michael' }));
    expect(voices).toEqual(['am_michael']);
  });
});
