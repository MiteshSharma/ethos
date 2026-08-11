import { DefaultSttProviderRegistry, DefaultTtsProviderRegistry } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { AgentEvent, Logger, SttProvider, TtsProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { WiringConfig } from '../index';
import { buildVoiceStack, createPcmToPath } from '../voice-stack';

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
    caps: { kind: 'stt', formats: ['wav'], local, contractVersion: 1 },
    transcribe: async () => 'hello from the batch provider',
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

function deps(cfg: WiringConfig, storage = new InMemoryStorage()) {
  return { config: cfg, storage, dataDir: '/home/u/.ethos', logger, ...registries() };
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

  // The construction blocker this task existed to remove: VoiceSession's
  // `resolveStt` throws for a batch-only provider unless `pcmToPath` is
  // supplied, and nothing in production supplied one.
  it('drives a batch-only STT provider end to end via a Storage-written WAV', async () => {
    const storage = new InMemoryStorage();
    const seenPaths: string[] = [];
    const sttProviders = new DefaultSttProviderRegistry();
    sttProviders.register('local-stt', () => ({
      name: 'local-stt',
      caps: { kind: 'stt' as const, formats: ['wav' as const], local: true, contractVersion: 1 },
      transcribe: async (audioPath: string) => {
        seenPaths.push(audioPath);
        // The provider reads a real file: assert it exists WHILE transcribing.
        expect(await storage.exists(audioPath)).toBe(true);
        return 'the buffered utterance';
      },
    }));
    const ttsProviders = new DefaultTtsProviderRegistry();
    ttsProviders.register('local-tts', () => batchTts('local-tts', true));

    const stack = await buildVoiceStack({
      config: config({ voice: { bots: [] } }),
      storage,
      dataDir: '/home/u/.ethos',
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
    // Session-keyed path: sanitized for the filesystem, with a digest of the
    // ORIGINAL lane key so two lanes can never share one utterance file.
    expect(seenPaths[0]).toMatch(
      /^\/home\/u\/\.ethos\/tmp\/voice\/voice_bot_caller_one-[0-9a-f]{8}\.wav$/,
    );
    // Captured audio does not outlive the transcription that consumed it.
    expect(await storage.exists(seenPaths[0] ?? '')).toBe(false);
    await stack?.close();
  });

  // No process-global voice state: two lanes must not share an audio artifact.
  it('keeps per-lane utterance audio in distinct, non-colliding files', async () => {
    const storage = new InMemoryStorage();
    const paths = new Set<string>();
    const stack = await buildVoiceStack(deps(config({ voice: { bots: [] } }), storage));
    if (!stack) throw new Error('expected a voice stack');

    for (const laneKey of ['voice:bot:a:b', 'voice:bot:a_b', 'voice:bot:other']) {
      const pcmToPath = createPcmToPath({
        storage,
        dir: '/home/u/.ethos/tmp/voice',
        laneKey,
      });
      paths.add(await pcmToPath([{ data: Int16Array.from([1, 2]), sampleRate: 16_000 }]));
    }

    // `a:b` and `a_b` sanitize identically — only the digest keeps them apart.
    expect(paths.size).toBe(3);
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
});
