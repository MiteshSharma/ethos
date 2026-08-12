import { DefaultSttProviderRegistry, DefaultTtsProviderRegistry } from '@ethosagent/core';
import type {
  AgentEvent,
  Logger,
  PersonalityConfig,
  SttProvider,
  TtsProvider,
} from '@ethosagent/types';
import { STT_CONTRACT_VERSION } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { WiringConfig } from '../index';
import { buildVoiceStack } from '../voice-stack';

const warnings: string[] = [];
const logger: Logger = {
  info: () => {},
  warn: (msg: string) => warnings.push(msg),
  error: () => {},
  debug: () => {},
  child: () => logger,
};

function batchStt(name: string, local: boolean): SttProvider {
  return {
    name,
    caps: { kind: 'stt', formats: ['wav'], local, contractVersion: STT_CONTRACT_VERSION },
    transcribeBuffer: async () => 'hello from the batch provider',
  };
}

function batchTts(name: string, local: boolean): TtsProvider {
  return {
    name,
    caps: { kind: 'tts', formats: ['wav'], local, contractVersion: 1 },
    synthesize: async () => ({ audio: new Uint8Array([1, 2]), format: 'wav' as const }),
  };
}

function registries(): {
  sttProviders: DefaultSttProviderRegistry;
  ttsProviders: DefaultTtsProviderRegistry;
} {
  const sttProviders = new DefaultSttProviderRegistry();
  sttProviders.register('local-stt', () => batchStt('local-stt', true));
  sttProviders.register('cloud-stt', () => batchStt('cloud-stt', false));
  const ttsProviders = new DefaultTtsProviderRegistry();
  ttsProviders.register('local-tts', () => batchTts('local-tts', true));
  ttsProviders.register('cloud-tts', () => batchTts('cloud-tts', false));
  return { sttProviders, ttsProviders };
}

function config(overrides: Partial<WiringConfig> = {}): WiringConfig {
  return {
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    apiKey: 'k',
    auxiliaryAsr: { provider: 'local-stt' },
    auxiliaryTts: { provider: 'local-tts' },
    ...overrides,
  };
}

function deps(cfg: WiringConfig) {
  return { config: cfg, logger, ...registries() };
}

/** Minimal personality carrying only the `voice` block under test. */
function personalityWithVoice(voice: PersonalityConfig['voice']): PersonalityConfig {
  return { id: 'v', name: 'V', ...(voice ? { voice } : {}) };
}

/** A runner that closes the turn immediately — these tests exercise wiring, not turns. */
const runner = {
  async *run(): AsyncGenerator<AgentEvent> {
    yield { type: 'done', text: '', turnCount: 1 };
  },
};

describe('buildVoiceStack', () => {
  it('is a clean no-op when no voice block is configured', async () => {
    expect(await buildVoiceStack(deps(config()))).toBeNull();
  });

  it('constructs a VoiceSession from real config without throwing', async () => {
    const stack = await buildVoiceStack(
      deps(
        config({
          voice: { bots: [{ match: '+1555*', bind: { type: 'personality', name: 'a' } }] },
        }),
      ),
    );
    expect(stack).not.toBeNull();
    expect(stack?.sttProviderId).toBe('local-stt');
    expect(stack?.ttsProviderId).toBe('local-tts');
    expect(stack?.providerError).toBeUndefined();

    const session = stack?.createSession({ laneKey: 'voice:bot:+15551230000', runner });
    expect(session?.getState()).toBe('idle');
    await stack?.close();
  });

  // `auxiliary.*.outputFormat` / `timeout` / `maxTextLength` were parsed and
  // then dropped before they reached a factory — documented knobs that did
  // nothing. The provider config assembled here is the one the factory reads.
  it('forwards the per-provider knobs to the provider factories', async () => {
    let sttConfig: Record<string, unknown> = {};
    let ttsConfig: Record<string, unknown> = {};
    const sttProviders = new DefaultSttProviderRegistry();
    sttProviders.register('local-stt', (ctx) => {
      sttConfig = ctx.config;
      return batchStt('local-stt', true);
    });
    const ttsProviders = new DefaultTtsProviderRegistry();
    ttsProviders.register('local-tts', (ctx) => {
      ttsConfig = ctx.config;
      return batchTts('local-tts', true);
    });

    const stack = await buildVoiceStack({
      config: config({
        voice: { bots: [] },
        auxiliaryAsr: { provider: 'local-stt', command: 'transcribe {input_path}', timeout: 300 },
        auxiliaryTts: {
          provider: 'local-tts',
          command: 'say --file-format=WAVE -o {output_path} -f {input_path}',
          outputFormat: 'wav',
          timeout: 45,
          maxTextLength: 2000,
        },
      }),
      logger,
      sttProviders,
      ttsProviders,
    });

    expect(sttConfig).toMatchObject({ command: 'transcribe {input_path}', timeout: 300 });
    expect(ttsConfig).toMatchObject({ outputFormat: 'wav', timeout: 45, maxTextLength: 2000 });
    await stack?.close();
  });

  it('maps voice.bots[] to bot identities in config order', async () => {
    const stack = await buildVoiceStack(
      deps(
        config({
          voice: {
            bots: [
              { id: 'reception', match: '+15551234567', bind: { type: 'personality', name: 'r' } },
              { match: '+1555*', bind: { type: 'personality', name: 'fallback' } },
            ],
          },
        }),
      ),
    );
    expect(stack?.bots).toEqual([{ id: 'reception', match: '+15551234567' }, { match: '+1555*' }]);
    await stack?.close();
  });

  // The construction blocker this task existed to remove: a batch-only
  // provider used to need an injected `pcmToPath`, and nothing in production
  // supplied one. With the buffer contract there is nothing to inject.
  it('drives a batch-only STT provider end to end on in-memory WAV bytes', async () => {
    const seen: Array<{ data: Uint8Array; mimeType?: string }> = [];
    const sttProviders = new DefaultSttProviderRegistry();
    sttProviders.register('local-stt', () => ({
      name: 'local-stt',
      caps: {
        kind: 'stt' as const,
        formats: ['wav' as const],
        local: true,
        contractVersion: STT_CONTRACT_VERSION,
      },
      transcribeBuffer: async (audio: { data: Uint8Array; mimeType?: string }) => {
        seen.push(audio);
        return 'the buffered utterance';
      },
    }));
    const ttsProviders = new DefaultTtsProviderRegistry();
    ttsProviders.register('local-tts', () => batchTts('local-tts', true));

    const stack = await buildVoiceStack({
      config: config({ voice: { bots: [] } }),
      logger,
      sttProviders,
      ttsProviders,
    });
    const session = stack?.createSession({
      laneKey: 'voice:bot:caller one',
      runner,
      sessionConfig: { endpointSilenceMs: 0 },
    });
    expect(session).toBeDefined();
    if (!session) return;

    const transcripts: string[] = [];
    session.on((e) => {
      if (e.type === 'utterance_committed') transcripts.push(e.text);
    });
    for (let i = 0; i < 5; i++) {
      session.pushAudio({ data: new Int16Array(320).fill(12_000), sampleRate: 16_000 });
    }
    for (let i = 0; i < 6; i++) {
      session.pushAudio({ data: new Int16Array(320), sampleRate: 16_000 });
    }
    await session.idle();

    expect(transcripts).toEqual(['the buffered utterance']);
    // The provider got a real WAV, in memory — 44-byte RIFF header and all.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.mimeType).toBe('audio/wav');
    const wav = seen[0]?.data ?? new Uint8Array();
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(wav.byteLength).toBeGreaterThan(44);
    await stack?.close();
  });

  // No process-global voice state: two lanes must not see each other's audio.
  // There is no shared temp file to collide on any more, so the invariant is
  // asserted where it now lives — the per-session buffer.
  it("keeps two lanes' utterances separate", async () => {
    const byProvider: Uint8Array[] = [];
    const sttProviders = new DefaultSttProviderRegistry();
    sttProviders.register('local-stt', () => ({
      name: 'local-stt',
      caps: {
        kind: 'stt' as const,
        formats: ['wav' as const],
        local: true,
        contractVersion: STT_CONTRACT_VERSION,
      },
      transcribeBuffer: async (audio: { data: Uint8Array }) => {
        byProvider.push(audio.data);
        return `utterance ${byProvider.length}`;
      },
    }));
    const ttsProviders = new DefaultTtsProviderRegistry();
    ttsProviders.register('local-tts', () => batchTts('local-tts', true));

    const stack = await buildVoiceStack({
      config: config({ voice: { bots: [] } }),
      logger,
      sttProviders,
      ttsProviders,
    });
    if (!stack) throw new Error('expected a voice stack');

    const transcripts: string[] = [];
    for (const [laneKey, level] of [
      ['voice:bot:a:b', 8_000],
      ['voice:bot:a_b', 12_000],
    ] as const) {
      const session = stack.createSession({
        laneKey,
        runner,
        sessionConfig: { endpointSilenceMs: 0 },
      });
      session.on((e) => {
        if (e.type === 'utterance_committed') transcripts.push(e.text);
      });
      for (let i = 0; i < 5; i++) {
        session.pushAudio({ data: new Int16Array(320).fill(level), sampleRate: 16_000 });
      }
      for (let i = 0; i < 6; i++) {
        session.pushAudio({ data: new Int16Array(320), sampleRate: 16_000 });
      }
      await session.idle();
    }

    expect(transcripts).toEqual(['utterance 1', 'utterance 2']);
    // `a:b` and `a_b` used to sanitize to the same filename; with no file to
    // share, the two lanes' audio simply never meets.
    expect(byProvider).toHaveLength(2);
    expect(Array.from(byProvider[0] ?? [])).not.toEqual(Array.from(byProvider[1] ?? []));
    await stack.close();
  });

  describe('trustedVoicePlugins egress gate', () => {
    it('is off when voice.trustedPlugins is absent — a cloud provider still resolves', async () => {
      const stack = await buildVoiceStack(
        deps(
          config({
            voice: { bots: [] },
            auxiliaryAsr: { provider: 'cloud-stt' },
            auxiliaryTts: { provider: 'cloud-tts' },
          }),
        ),
      );
      expect(stack?.providerError).toBeUndefined();
      expect(stack?.trustedVoicePlugins).toBeUndefined();
      await stack?.close();
    });

    it('refuses a non-local provider when only local providers are trusted', async () => {
      const stack = await buildVoiceStack(
        deps(
          config({
            voice: { bots: [], trustedPlugins: [] },
            auxiliaryAsr: { provider: 'cloud-stt' },
            auxiliaryTts: { provider: 'local-tts' },
          }),
        ),
      );
      expect(stack?.providerError).toContain('refusing to send audio off this machine');
      expect(() => stack?.createSession({ laneKey: 'voice:b:c', runner })).toThrow(
        /not local and is not in voice.trustedPlugins/,
      );
      await stack?.close();
    });

    it('allows a non-local provider that is explicitly listed', async () => {
      const stack = await buildVoiceStack(
        deps(
          config({
            voice: { bots: [], trustedPlugins: ['cloud-stt', 'cloud-tts'] },
            auxiliaryAsr: { provider: 'cloud-stt' },
            auxiliaryTts: { provider: 'cloud-tts' },
          }),
        ),
      );
      expect(stack?.providerError).toBeUndefined();
      expect(stack?.createSession({ laneKey: 'voice:b:c', runner })).toBeDefined();
      await stack?.close();
    });
  });

  describe('transport construction', () => {
    it('does not build LiveKit or SIP when they are not configured', async () => {
      const stack = await buildVoiceStack(deps(config({ voice: { bots: [] } })));
      expect(stack?.createLiveKitAdapter).toBeUndefined();
      expect(stack?.sipTrunk).toBeUndefined();
      await stack?.close();
    });

    it('warns instead of throwing when LiveKit is configured with no native binding', async () => {
      warnings.length = 0;
      const stack = await buildVoiceStack(
        deps(
          config({
            voice: {
              bots: [],
              livekit: { url: 'wss://lk.example', apiKey: 'k', apiSecret: 's' },
            },
          }),
        ),
      );
      expect(stack?.createLiveKitAdapter).toBeUndefined();
      expect(warnings.some((w) => w.includes('LiveKit transport is unavailable'))).toBe(true);
      await stack?.close();
    });

    it('warns instead of throwing when a SIP trunk is configured with no client', async () => {
      warnings.length = 0;
      const stack = await buildVoiceStack(
        deps(
          config({
            voice: { bots: [], trunk: { provider: 'twilio', trunkId: 'T1', fromNumber: '+1555' } },
          }),
        ),
      );
      expect(stack?.sipTrunk).toBeUndefined();
      expect(stack?.fromNumber).toBe('+1555');
      expect(warnings.some((w) => w.includes('telephony is unavailable'))).toBe(true);
      await stack?.close();
    });
  });

  it('warns but still builds when a configured provider is unknown', async () => {
    warnings.length = 0;
    const stack = await buildVoiceStack(
      deps(config({ voice: { bots: [] }, auxiliaryAsr: { provider: 'nope-stt' } })),
    );
    expect(stack).not.toBeNull();
    expect(stack?.providerError).toContain('nope-stt');
    expect(() => stack?.createSession({ laneKey: 'voice:b:c', runner })).toThrow(/nope-stt/);
    await stack?.close();
  });

  // `PersonalityConfig.voice` is not decorative: a deployment picks the
  // PROVIDER, the personality picks how it sounds. These pin the precedence at
  // the construction site that actually serves a turn.
  describe('personality voice takes precedence over global config', () => {
    /** Drive one spoken turn and report the voice id the TTS provider saw. */
    async function voiceUsedFor(opts: {
      globalVoice?: string;
      personality?: PersonalityConfig;
      language?: string;
    }): Promise<string | undefined> {
      const spoken: Array<string | undefined> = [];
      const sttProviders = new DefaultSttProviderRegistry();
      sttProviders.register('local-stt', () => batchStt('local-stt', true));
      const ttsProviders = new DefaultTtsProviderRegistry();
      ttsProviders.register('local-tts', () => ({
        name: 'local-tts',
        caps: { kind: 'tts' as const, formats: ['wav' as const], local: true, contractVersion: 1 },
        synthesize: async (_text: string, o?: { voice?: string }) => {
          spoken.push(o?.voice);
          return { audio: new Uint8Array([1]), format: 'wav' as const };
        },
      }));

      const stack = await buildVoiceStack({
        config: config({
          voice: { bots: [] },
          ...(opts.globalVoice
            ? { auxiliaryTts: { provider: 'local-tts', voice: opts.globalVoice } }
            : {}),
        }),
        logger,
        sttProviders,
        ttsProviders,
      });
      if (!stack) throw new Error('expected a voice stack');

      const session = stack.createSession({
        laneKey: 'voice:bot:caller',
        runner: {
          async *run(): AsyncGenerator<AgentEvent> {
            yield { type: 'text_delta', text: 'Hello there.' };
            yield { type: 'done', text: 'Hello there.', turnCount: 1 };
          },
        },
        ...(opts.personality ? { personality: opts.personality } : {}),
        ...(opts.language ? { language: opts.language } : {}),
        sessionConfig: { endpointSilenceMs: 0 },
      });
      for (let i = 0; i < 5; i++) {
        session.pushAudio({ data: new Int16Array(320).fill(12_000), sampleRate: 16_000 });
      }
      for (let i = 0; i < 6; i++) {
        session.pushAudio({ data: new Int16Array(320), sampleRate: 16_000 });
      }
      await session.idle();
      await stack.close();
      return spoken[0];
    }

    it('uses the global voice when the personality declares none', async () => {
      await expect(voiceUsedFor({ globalVoice: 'af_global' })).resolves.toBe('af_global');
    });

    it('prefers the personality voice over the global default', async () => {
      await expect(
        voiceUsedFor({
          globalVoice: 'af_global',
          personality: personalityWithVoice({ tts_voice: 'af_mine' }),
        }),
      ).resolves.toBe('af_mine');
    });

    it('inherits the global voice when the personality block omits tts_voice', async () => {
      await expect(
        voiceUsedFor({
          globalVoice: 'af_global',
          personality: personalityWithVoice({ model: 'haiku' }),
        }),
      ).resolves.toBe('af_global');
    });

    it("prefers a language-specific voice over the personality's default", async () => {
      await expect(
        voiceUsedFor({
          globalVoice: 'af_global',
          personality: personalityWithVoice({
            tts_voice: 'af_mine',
            languages: { es: 'ef_dora' },
          }),
          language: 'es',
        }),
      ).resolves.toBe('ef_dora');
    });

    it('falls back to the personality default for an unmapped language', async () => {
      await expect(
        voiceUsedFor({
          globalVoice: 'af_global',
          personality: personalityWithVoice({
            tts_voice: 'af_mine',
            languages: { es: 'ef_dora' },
          }),
          language: 'de',
        }),
      ).resolves.toBe('af_mine');
    });
  });
});
