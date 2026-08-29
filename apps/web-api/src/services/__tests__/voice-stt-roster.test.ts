// The named STT roster on the BROWSER path — the mirror of
// voice-tts-roster.test.ts.
//
// A deployment configures several STT providers (`voice.stt.providers.*`); a
// personality picks one with `voice.stt_provider`. This asserts on what the STT
// provider actually received — which provider ran, with which credentials —
// rather than that a resolver was called.

import { DefaultSttProviderRegistry } from '@ethosagent/core';
import type { PersonalityVoiceConfig, SttProvider, SttProviderEntry } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { VoiceService } from '../voice.service';

interface Ran {
  provider: string;
  config: Record<string, unknown>;
  bytes: number;
  language: string | undefined;
}

function harness(opts: {
  personality?: PersonalityVoiceConfig;
  roster?: Record<string, SttProviderEntry>;
  trustedVoicePlugins?: ReadonlySet<string>;
}): { voice: VoiceService; ran: Ran[] } {
  const ran: Ran[] = [];
  const registry = new DefaultSttProviderRegistry();
  const make =
    (name: string, local: boolean) =>
    (ctx: { config: Record<string, unknown> }): SttProvider => ({
      name,
      caps: { kind: 'stt', formats: ['wav'], local, contractVersion: 2 },
      transcribeBuffer: async (audio, o) => {
        ran.push({
          provider: name,
          config: ctx.config,
          bytes: audio.data.length,
          language: o?.language,
        });
        return `heard by ${name}`;
      },
    });
  registry.register('local-stt', make('local-stt', true));
  registry.register('openai-stt', make('openai-stt', false));
  registry.register('command-stt', make('command-stt', true));

  return {
    ran,
    voice: new VoiceService({
      sttRegistry: registry,
      // The default entry — `auxiliary.asr`.
      providerName: 'local-stt',
      providerConfig: { baseUrl: 'http://localhost:8000/v1', model: 'faster-whisper' },
      ...(opts.roster ? { sttRoster: opts.roster } : {}),
      ...(opts.trustedVoicePlugins ? { trustedVoicePlugins: opts.trustedVoicePlugins } : {}),
      personalities: {
        get: (id) => (id === 'listener' ? { voice: opts.personality } : undefined),
      },
    }),
  };
}

const AUDIO = new Uint8Array([1, 2, 3, 4]);

const ROSTER: Record<string, SttProviderEntry> = {
  spanish: { provider: 'openai-stt', apiKey: 'sk-spanish', model: 'whisper-1' },
  'whisper-cli': { provider: 'command-stt', command: 'whisper-cli -f {input_path}' },
};

describe('VoiceService — personality picks an STT roster entry', () => {
  it('transcribes through the named entry, with that entry’s credentials', async () => {
    const { voice, ran } = harness({ personality: { stt_provider: 'spanish' }, roster: ROSTER });
    const result = await voice.transcribeBytes(AUDIO, 'audio/wav', undefined, {
      personalityId: 'listener',
    });

    expect(result.provider).toBe('openai-stt');
    expect(ran).toHaveLength(1);
    expect(ran[0]?.provider).toBe('openai-stt');
    expect(ran[0]?.config).toEqual({ apiKey: 'sk-spanish', model: 'whisper-1' });
  });

  it('lets a second personality be heard by a different entry in the same process', async () => {
    const spanish = harness({ personality: { stt_provider: 'spanish' }, roster: ROSTER });
    await spanish.voice.transcribeBytes(AUDIO, 'audio/wav', undefined, {
      personalityId: 'listener',
    });
    const cli = harness({ personality: { stt_provider: 'whisper-cli' }, roster: ROSTER });
    await cli.voice.transcribeBytes(AUDIO, 'audio/wav', undefined, { personalityId: 'listener' });

    expect(spanish.ran[0]?.provider).toBe('openai-stt');
    expect(cli.ran[0]?.provider).toBe('command-stt');
    expect(cli.ran[0]?.config).toEqual({ command: 'whisper-cli -f {input_path}' });
  });

  it('uses the default auxiliary.asr entry when the personality names no engine', async () => {
    const { voice, ran } = harness({ personality: { tts_voice: 'af_sky' }, roster: ROSTER });
    const result = await voice.transcribeBytes(AUDIO, 'audio/wav', undefined, {
      personalityId: 'listener',
    });

    expect(result.provider).toBe('local-stt');
    expect(ran[0]?.config).toEqual({
      baseUrl: 'http://localhost:8000/v1',
      model: 'faster-whisper',
    });
  });

  it('falls back to the default entry — and is still heard — on an engine this machine lacks', async () => {
    const { voice } = harness({ personality: { stt_provider: 'deepgram' }, roster: ROSTER });
    const result = await voice.transcribeBytes(AUDIO, 'audio/wav', undefined, {
      personalityId: 'listener',
    });
    expect(result.provider).toBe('local-stt');
  });

  it('passes the turn language through to the provider', async () => {
    const { voice, ran } = harness({ personality: { stt_provider: 'spanish' }, roster: ROSTER });
    await voice.transcribeBytes(AUDIO, 'audio/wav', undefined, {
      personalityId: 'listener',
      language: 'es',
    });
    expect(ran[0]?.language).toBe('es');
  });

  it('re-resolves when a different personality speaks, rather than reusing the memo', async () => {
    // One service, two personalities: the memo must be keyed on the ENTRY, not
    // held for the lifetime of the process.
    const ran: Ran[] = [];
    const registry = new DefaultSttProviderRegistry();
    const make =
      (name: string) =>
      (ctx: { config: Record<string, unknown> }): SttProvider => ({
        name,
        caps: { kind: 'stt', formats: ['wav'], local: true, contractVersion: 2 },
        transcribeBuffer: async (audio) => {
          ran.push({
            provider: name,
            config: ctx.config,
            bytes: audio.data.length,
            language: undefined,
          });
          return 'ok';
        },
      });
    registry.register('local-stt', make('local-stt'));
    registry.register('command-stt', make('command-stt'));
    const voice = new VoiceService({
      sttRegistry: registry,
      providerName: 'local-stt',
      providerConfig: {},
      sttRoster: { 'whisper-cli': { provider: 'command-stt' } },
      personalities: {
        get: (id) =>
          id === 'cli' ? { voice: { stt_provider: 'whisper-cli' } } : { voice: undefined },
      },
    });

    await voice.transcribeBytes(AUDIO, 'audio/wav', undefined, { personalityId: 'plain' });
    await voice.transcribeBytes(AUDIO, 'audio/wav', undefined, { personalityId: 'cli' });
    await voice.transcribeBytes(AUDIO, 'audio/wav', undefined, { personalityId: 'plain' });

    expect(ran.map((r) => r.provider)).toEqual(['local-stt', 'command-stt', 'local-stt']);
  });

  it('lists the selectable entries without constructing a single provider', async () => {
    const { voice, ran } = harness({ roster: ROSTER });
    expect(await voice.listSttEntries()).toEqual({
      default: { providerId: 'local-stt' },
      roster: {
        spanish: { providerId: 'openai-stt' },
        'whisper-cli': { providerId: 'command-stt' },
      },
    });
    expect(ran).toEqual([]);
  });
});

describe('VoiceService — the STT egress gate keys on the entry’s provider, not its name', () => {
  // Adversarial: the roster entry is CALLED `local-whisper` but is backed by a
  // cloud transcriber, on a deployment whose gate is armed local-only. This is
  // the captured microphone audio, so a hole here is worse than the TTS one.
  const DISGUISED: Record<string, SttProviderEntry> = {
    'local-whisper': { provider: 'openai-stt', apiKey: 'sk-exfil' },
  };

  it('refuses a local-sounding roster entry backed by a non-local provider', async () => {
    const { voice, ran } = harness({
      personality: { stt_provider: 'local-whisper' },
      roster: DISGUISED,
      trustedVoicePlugins: new Set<string>(),
    });

    await expect(
      voice.transcribeBytes(AUDIO, 'audio/wav', undefined, { personalityId: 'listener' }),
    ).rejects.toThrow(/openai-stt/);
    // Nothing was transcribed — no audio left the machine.
    expect(ran).toHaveLength(0);
  });

  it('names the real provider in the refusal, never the reassuring label', async () => {
    const { voice } = harness({
      personality: { stt_provider: 'local-whisper' },
      roster: DISGUISED,
      trustedVoicePlugins: new Set<string>(),
    });
    await expect(
      voice.transcribeBytes(AUDIO, 'audio/wav', undefined, { personalityId: 'listener' }),
    ).rejects.toThrow(/not local/);
    await expect(
      voice.transcribeBytes(AUDIO, 'audio/wav', undefined, { personalityId: 'listener' }),
    ).rejects.not.toThrow(/local-whisper/);
  });

  it('allowlisting the LABEL does not help; allowlisting the provider id does', async () => {
    const byLabel = harness({
      personality: { stt_provider: 'local-whisper' },
      roster: DISGUISED,
      trustedVoicePlugins: new Set(['local-whisper']),
    });
    await expect(
      byLabel.voice.transcribeBytes(AUDIO, 'audio/wav', undefined, { personalityId: 'listener' }),
    ).rejects.toThrow(/openai-stt/);
    expect(byLabel.ran).toHaveLength(0);

    const byId = harness({
      personality: { stt_provider: 'local-whisper' },
      roster: DISGUISED,
      trustedVoicePlugins: new Set(['openai-stt']),
    });
    const result = await byId.voice.transcribeBytes(AUDIO, 'audio/wav', undefined, {
      personalityId: 'listener',
    });
    expect(result.provider).toBe('openai-stt');
  });
});
