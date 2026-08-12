// What the personality editor's voice fields are built on: which TTS entries
// exist, which voice ids each one will actually accept, and previewing a
// selection that is not on disk yet.
//
// The two questions the UI cannot answer for itself are answered here rather
// than by a table of provider names in the browser: a provider advertises its
// own `caps.voices`, and only the server can construct it to ask.

import { DefaultTtsProviderRegistry } from '@ethosagent/core';
import type { PersonalityVoiceConfig, TtsProvider, TtsProviderEntry } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { VoiceService } from '../voice.service';

interface Ran {
  provider: string;
  voice: string | undefined;
}

/**
 * `openai-tts` publishes a fixed voice list and needs a key; `local-tts`
 * (Kokoro) takes open-ended ids and advertises none. Those two shapes are the
 * whole reason the surface has to ask.
 */
function harness(opts: {
  roster?: Record<string, TtsProviderEntry>;
  personality?: PersonalityVoiceConfig;
  trustedVoicePlugins?: ReadonlySet<string>;
  defaultEntry?: { provider: string; config: Record<string, unknown> };
}): { voice: VoiceService; ran: Ran[] } {
  const ran: Ran[] = [];
  const registry = new DefaultTtsProviderRegistry();
  const make =
    (name: string, caps: { local: boolean; voices?: string[] }, requiresKey = false) =>
    (ctx: { config: Record<string, unknown> }): TtsProvider => {
      if (requiresKey && !ctx.config.apiKey) throw new Error(`${name} requires apiKey`);
      return {
        name,
        caps: {
          kind: 'tts',
          formats: ['wav'],
          local: caps.local,
          ...(caps.voices ? { voices: caps.voices } : {}),
          contractVersion: 1,
        },
        synthesize: async (_text, o) => {
          ran.push({ provider: name, voice: o?.voice });
          return { audio: new Uint8Array([1, 2]), format: 'wav' as const };
        },
      };
    };
  registry.register(
    'openai-tts',
    make('openai-tts', { local: false, voices: ['alloy', 'nova', 'shimmer'] }, true),
  );
  registry.register('local-tts', make('local-tts', { local: true }));

  const fallback = opts.defaultEntry ?? {
    provider: 'local-tts',
    config: { voice: 'af_bella' },
  };
  return {
    ran,
    voice: new VoiceService({
      ttsRegistry: registry,
      ttsProviderName: fallback.provider,
      ttsProviderConfig: fallback.config,
      ...(opts.roster ? { ttsRoster: opts.roster } : {}),
      ...(opts.trustedVoicePlugins ? { trustedVoicePlugins: opts.trustedVoicePlugins } : {}),
      personalities: { get: (id) => (id === 'talker' ? { voice: opts.personality } : undefined) },
    }),
  };
}

describe('VoiceService.listTtsEntries', () => {
  it('reports the default entry and every roster entry with the voices it advertises', async () => {
    const { voice, ran } = harness({
      roster: {
        studio: { provider: 'openai-tts', apiKey: 'sk-studio' },
        kokoro: { provider: 'local-tts', baseUrl: 'http://localhost:8880/v1' },
      },
    });

    const entries = await voice.listTtsEntries();
    expect(entries.default).toEqual({ providerId: 'local-tts', voices: null });
    // A fixed list → the editor renders a select of exactly these.
    expect(entries.roster.studio).toEqual({
      providerId: 'openai-tts',
      voices: ['alloy', 'nova', 'shimmer'],
    });
    // No list → open-ended ids → the editor renders free text.
    expect(entries.roster.kokoro).toEqual({ providerId: 'local-tts', voices: null });
    // Reading capabilities must never make a sound.
    expect(ran).toEqual([]);
  });

  it('says "open-ended" rather than guessing when an entry will not construct', async () => {
    // No apiKey — `openai-tts` throws. We do not know its voices on this
    // machine, so the honest answer is a free-text field, not a list.
    const { voice } = harness({ roster: { studio: { provider: 'openai-tts' } } });
    expect(await voice.listTtsEntries()).toMatchObject({
      roster: { studio: { providerId: 'openai-tts', voices: null } },
    });
  });

  it('offers no voice list for an entry the egress gate refuses', async () => {
    const { voice } = harness({
      roster: { studio: { provider: 'openai-tts', apiKey: 'sk-studio' } },
      trustedVoicePlugins: new Set(),
    });
    expect((await voice.listTtsEntries()).roster.studio).toEqual({
      providerId: 'openai-tts',
      voices: null,
    });
  });

  it('reports nothing configured when there is no provider at all', async () => {
    const voice = new VoiceService({});
    expect(await voice.listTtsEntries()).toEqual({
      default: { providerId: null, voices: null },
      roster: {},
    });
  });
});

describe('VoiceService.synthesize — preview override', () => {
  it('speaks through the named entry and voice the editor is showing', async () => {
    const { voice, ran } = harness({
      roster: { studio: { provider: 'openai-tts', apiKey: 'sk-studio', voice: 'alloy' } },
    });

    const result = await voice.synthesize('preview', {
      override: { provider: 'studio', voice: 'shimmer' },
    });

    expect(result.provider).toBe('openai-tts');
    // The previewed voice beats the entry's own default — that is the point of
    // auditioning a selection.
    expect(ran).toEqual([{ provider: 'openai-tts', voice: 'shimmer' }]);
  });

  it('beats the stored voice of the personality being edited', async () => {
    const { voice, ran } = harness({
      personality: { tts_provider: 'studio', tts_voice: 'alloy' },
      roster: { studio: { provider: 'openai-tts', apiKey: 'sk-studio' } },
    });

    await voice.synthesize('preview', {
      personalityId: 'talker',
      override: { voice: 'nova' },
    });

    // No provider in the override → the default entry, because the override
    // stands IN PLACE OF the personality's voice block rather than merging with
    // it. What you hear is exactly what the form is showing.
    expect(ran).toEqual([{ provider: 'local-tts', voice: 'nova' }]);
  });

  it('falls back to the default entry when the previewed name is not configured', async () => {
    const { voice, ran } = harness({ roster: {} });
    const result = await voice.synthesize('preview', {
      override: { provider: 'elevenlabs-studio', voice: 'af_sky' },
    });
    // The surface reports the provider that ACTUALLY spoke, so the fallback is
    // visible instead of silent.
    expect(result.provider).toBe('local-tts');
    expect(ran).toEqual([{ provider: 'local-tts', voice: 'af_sky' }]);
  });

  it('an override cannot walk a non-local provider past the egress gate', async () => {
    const { voice, ran } = harness({
      roster: { 'local-sounding': { provider: 'openai-tts', apiKey: 'sk-studio' } },
      trustedVoicePlugins: new Set(),
    });
    await expect(
      voice.synthesize('preview', { override: { provider: 'local-sounding' } }),
    ).rejects.toThrow(/not local/);
    expect(ran).toEqual([]);
  });
});
