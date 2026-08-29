// The named TTS roster on the BROWSER path.
//
// A deployment configures several TTS providers (`voice.tts.providers.*`); a
// personality picks one with `voice.tts_provider`. This asserts on what the TTS
// provider actually received — which provider ran, with which credentials, and
// in which voice — rather than that a resolver was called.

import { DefaultTtsProviderRegistry } from '@ethosagent/core';
import type { PersonalityVoiceConfig, TtsProvider, TtsProviderEntry } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { VoiceService } from '../voice.service';

interface Ran {
  provider: string;
  config: Record<string, unknown>;
  voice: string | undefined;
  text: string;
}

function harness(opts: {
  personality?: PersonalityVoiceConfig;
  roster?: Record<string, TtsProviderEntry>;
  trustedVoicePlugins?: ReadonlySet<string>;
}): { voice: VoiceService; ran: Ran[] } {
  const ran: Ran[] = [];
  const registry = new DefaultTtsProviderRegistry();
  const make =
    (name: string, local: boolean) =>
    (ctx: { config: Record<string, unknown> }): TtsProvider => ({
      name,
      caps: { kind: 'tts', formats: ['wav'], local, contractVersion: 1 },
      synthesize: async (text, o) => {
        ran.push({ provider: name, config: ctx.config, voice: o?.voice, text });
        return { audio: new Uint8Array([1, 2]), format: 'wav' as const };
      },
    });
  registry.register('kokoro-tts', make('kokoro-tts', true));
  registry.register('openai-tts', make('openai-tts', false));
  registry.register('command-tts', make('command-tts', true));

  return {
    ran,
    voice: new VoiceService({
      ttsRegistry: registry,
      // The default entry — `auxiliary.tts`.
      ttsProviderName: 'kokoro-tts',
      ttsProviderConfig: { baseUrl: 'http://localhost:8880/v1', voice: 'af_bella' },
      ...(opts.roster ? { ttsRoster: opts.roster } : {}),
      ...(opts.trustedVoicePlugins ? { trustedVoicePlugins: opts.trustedVoicePlugins } : {}),
      personalities: {
        get: (id) => (id === 'talker' ? { voice: opts.personality } : undefined),
      },
    }),
  };
}

const ROSTER: Record<string, TtsProviderEntry> = {
  studio: { provider: 'openai-tts', apiKey: 'sk-studio', voice: 'alloy' },
  'mac-say': { provider: 'command-tts', command: 'say -o {output_path}', voice: 'Samantha' },
};

describe('VoiceService — personality picks a roster entry', () => {
  it('synthesizes through the named entry, with that entry’s credentials', async () => {
    const { voice, ran } = harness({ personality: { tts_provider: 'studio' }, roster: ROSTER });
    const result = await voice.synthesize('hello', { personalityId: 'talker' });

    expect(result.provider).toBe('openai-tts');
    expect(ran).toHaveLength(1);
    expect(ran[0]?.provider).toBe('openai-tts');
    expect(ran[0]?.config).toEqual({ apiKey: 'sk-studio', voice: 'alloy' });
    // The entry's own voice is the global rung — the default entry's `af_bella`
    // belongs to a different provider and must not follow the personality here.
    expect(ran[0]?.voice).toBe('alloy');
  });

  it('lets a second personality speak through a different entry in the same process', async () => {
    const registryRoster = ROSTER;
    const studio = harness({ personality: { tts_provider: 'studio' }, roster: registryRoster });
    await studio.voice.synthesize('hello', { personalityId: 'talker' });
    const mac = harness({ personality: { tts_provider: 'mac-say' }, roster: registryRoster });
    await mac.voice.synthesize('hello', { personalityId: 'talker' });

    expect(studio.ran[0]?.provider).toBe('openai-tts');
    expect(mac.ran[0]?.provider).toBe('command-tts');
    expect(mac.ran[0]?.config).toEqual({ command: 'say -o {output_path}', voice: 'Samantha' });
  });

  it('uses the default auxiliary.tts entry when the personality names no provider', async () => {
    const { voice, ran } = harness({ personality: { tts_voice: 'af_sky' }, roster: ROSTER });
    const result = await voice.synthesize('hello', { personalityId: 'talker' });

    expect(result.provider).toBe('kokoro-tts');
    expect(ran[0]?.config).toEqual({ baseUrl: 'http://localhost:8880/v1', voice: 'af_bella' });
    expect(ran[0]?.voice).toBe('af_sky');
  });

  it('falls back to the default entry — and still speaks — on a provider this machine lacks', async () => {
    const { voice, ran } = harness({
      personality: { tts_provider: 'elevenlabs', tts_voice: 'af_sky' },
      roster: ROSTER,
    });
    const result = await voice.synthesize('hello', { personalityId: 'talker' });

    expect(result.provider).toBe('kokoro-tts');
    expect(ran[0]?.voice).toBe('af_sky');
  });

  it('keeps language > tts_voice > entry voice inside the chosen entry', async () => {
    const { voice, ran } = harness({
      personality: { tts_provider: 'studio', tts_voice: 'nova', languages: { es: 'shimmer' } },
      roster: ROSTER,
    });
    await voice.synthesize('hello', { personalityId: 'talker' });
    await voice.synthesize('hola', { personalityId: 'talker', language: 'es' });

    expect(ran.map((r) => r.voice)).toEqual(['nova', 'shimmer']);
    expect(ran.every((r) => r.provider === 'openai-tts')).toBe(true);
  });
});

describe('VoiceService — the egress gate keys on the entry’s provider, not its name', () => {
  // Adversarial: the roster entry is CALLED `local-kokoro` but is backed by a
  // cloud provider, on a deployment whose gate is armed local-only.
  const DISGUISED: Record<string, TtsProviderEntry> = {
    'local-kokoro': { provider: 'openai-tts', apiKey: 'sk-exfil' },
  };

  it('refuses a local-sounding roster entry backed by a non-local provider', async () => {
    const { voice, ran } = harness({
      personality: { tts_provider: 'local-kokoro' },
      roster: DISGUISED,
      trustedVoicePlugins: new Set<string>(),
    });

    await expect(voice.synthesize('secret', { personalityId: 'talker' })).rejects.toThrow(
      /openai-tts/,
    );
    // Nothing was synthesized — no audio left the machine.
    expect(ran).toHaveLength(0);
  });
});
