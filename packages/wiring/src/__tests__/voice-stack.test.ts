import type { VoiceBargeInConfig, VoiceBargeInTuning } from '@ethosagent/config';
import {
  AgentLoop,
  DefaultSttProviderRegistry,
  DefaultTtsProviderRegistry,
} from '@ethosagent/core';
import type { LiveKitRoomClient } from '@ethosagent/platform-voice';
import type {
  AgentEvent,
  LLMProvider,
  Logger,
  PersonalityConfig,
  SttProvider,
  TtsProvider,
} from '@ethosagent/types';
import { STT_CONTRACT_VERSION } from '@ethosagent/types';
import type { AgentTurnRunner, VoiceSession, VoiceSessionConfig } from '@ethosagent/voice-session';
import { describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../core/src/__tests__/helpers/test-safety';
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

/** A room client that connects to nothing — enough to build an adapter. */
function fakeRoomClient(): LiveKitRoomClient {
  return {
    connect: async () => {},
    disconnect: async () => {},
    onRemoteAudio: () => () => {},
    publishAudio: () => {},
    remoteIdentity: () => 'caller',
  };
}

/** What `LiveKitRoomClient.onRemoteAudio` hands back: one inbound PCM frame. */
type RemoteAudioHandler = (frame: { samples: Int16Array; sampleRate: number }) => void;

/** A runner that closes the turn immediately — these tests exercise wiring, not turns. */
const runner = {
  async *run(): AsyncGenerator<AgentEvent> {
    yield { type: 'done', text: '', turnCount: 1 };
  },
};

describe('buildVoiceStack', () => {
  it('is a clean no-op when nothing at all is configured', async () => {
    expect(
      await buildVoiceStack(deps(config({ auxiliaryAsr: undefined, auxiliaryTts: undefined }))),
    ).toBeNull();
  });

  // Before this fallback existed, ANY deployment with no `voice.*` block
  // returned null here — including the shape `docs/using/how-to/local-voice.md`
  // documents (only `auxiliary.asr`/`auxiliary.tts`, no `voice.*` at all),
  // which broke the browser talk lane for every local-only deployment the
  // moment it moved onto `VoiceSession`. `config()` defaults to exactly this
  // shape, so the plain no-override call below is the regression case.
  it('falls back to a minimal stack when only auxiliary.asr/auxiliary.tts are configured', async () => {
    const stack = await buildVoiceStack(deps(config()));
    expect(stack).not.toBeNull();
    expect(stack?.sttProviderId).toBe('local-stt');
    expect(stack?.ttsProviderId).toBe('local-tts');
    // No `voice.livekit`/`voice.trunk` in this shape — telephony stays
    // unavailable, honestly, rather than half-wired.
    expect(stack?.createLiveKitAdapter).toBeUndefined();
    expect(stack?.createSipAdapter).toBeUndefined();

    // The same call `browser-voice-session.ts` makes for a talk-mode connection.
    const session = await stack?.createSession({
      laneKey: 'voice:web:browser:client-1',
      runner,
      surface: 'browser',
    });
    expect(session?.getState()).toBe('idle');
    await stack?.close();
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

    const session = await stack?.createSession({ laneKey: 'voice:bot:+15551230000', runner });
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
    const session = await stack?.createSession({
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
      const session = await stack.createSession({
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
      await expect(stack?.createSession({ laneKey: 'voice:b:c', runner })).rejects.toThrow(
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
      expect(await stack?.createSession({ laneKey: 'voice:b:c', runner })).toBeDefined();
      await stack?.close();
    });
  });

  describe('transport construction', () => {
    it('does not build LiveKit or SIP when they are not configured', async () => {
      const stack = await buildVoiceStack(deps(config({ voice: { bots: [] } })));
      expect(stack?.createLiveKitAdapter).toBeUndefined();
      expect(stack?.createSipAdapter).toBeUndefined();
      expect(stack?.sipTrunk).toBeUndefined();
      await stack?.close();
    });

    it('warns instead of throwing when LiveKit is configured with no media binding', async () => {
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
      expect(stack?.createSipAdapter).toBeUndefined();
      expect(warnings.some((w) => w.includes('media transports are unavailable'))).toBe(true);
      await stack?.close();
    });

    // E2: `VoiceStack.sipTrunk` used to be undefined in EVERY shipped
    // deployment, because the only way to get one was an app that passed a
    // client and no in-repo app did. The control plane is signed-JWT + HTTPS,
    // so it now builds itself from the credentials already in config.
    it('derives the SIP trunk from voice.trunk + voice.livekit with no app binding', async () => {
      warnings.length = 0;
      const stack = await buildVoiceStack(
        deps(
          config({
            voice: {
              bots: [],
              livekit: { url: 'wss://lk.example', apiKey: 'k', apiSecret: 's' },
              trunk: { provider: 'livekit', trunkId: 'T1', fromNumber: '+15550001111' },
            },
          }),
        ),
      );
      expect(stack?.sipTrunk).toBeDefined();
      expect(stack?.fromNumber).toBe('+15550001111');
      expect(warnings.some((w) => w.includes('telephony is unavailable'))).toBe(false);
      await stack?.close();
    });

    it('an explicitly supplied trunk wins over the derived one', async () => {
      const injected = {
        createOutboundCall: async () => ({ callId: 'c', toNumber: '', roomName: '' }),
      };
      const stack = await buildVoiceStack({
        ...deps(
          config({
            voice: {
              bots: [],
              livekit: { url: 'wss://lk.example', apiKey: 'k', apiSecret: 's' },
              trunk: { provider: 'livekit', trunkId: 'T1' },
            },
          }),
        ),
        trunk: injected,
      });
      expect(stack?.sipTrunk).toBe(injected);
      await stack?.close();
    });

    it('warns when a trunk is configured without the LiveKit credentials it signs with', async () => {
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

    // The media binding is app-supplied; the TOKEN MINTER is not. Before this,
    // `voice.livekit.apiKey`/`apiSecret` were parsed and never read.
    it('builds both adapter factories from a media binding alone — no app token minter', async () => {
      const stack = await buildVoiceStack({
        ...deps(
          config({
            voice: {
              bots: [
                { id: 'reception', match: '+1555*', bind: { type: 'personality', name: 'r' } },
              ],
              livekit: { url: 'wss://lk.example', apiKey: 'k', apiSecret: 's' },
            },
          }),
        ),
        livekit: { createClient: () => fakeRoomClient() },
      });
      expect(stack?.createLiveKitAdapter).toBeDefined();
      expect(stack?.createSipAdapter).toBeDefined();
      await stack?.close();
    });

    // The lane-key segment is the whole point of a separate SIP factory: a
    // phone leg and the same person's browser session are different
    // conversations and must not share a session row.
    it('stamps laneKind sip on the SIP adapter and livekit on the room adapter', async () => {
      const stack = await buildVoiceStack({
        ...deps(
          config({
            voice: {
              bots: [],
              livekit: { url: 'wss://lk.example', apiKey: 'k', apiSecret: 's' },
            },
          }),
        ),
        livekit: { createClient: () => fakeRoomClient() },
      });
      const opts = {
        bot: { id: 'reception', match: '+1555*' },
        roomName: 'call-1',
        callerId: '+15551230000',
        runner,
      };
      const sip = await stack?.createSipAdapter?.(opts);
      const room = await stack?.createLiveKitAdapter?.(opts);
      expect(sip?.laneKey).toBe('voice:reception:sip:%2B15551230000');
      expect(room?.laneKey).toBe('voice:reception:livekit:%2B15551230000');
      await stack?.close();
    });
  });

  // The gates are deployment-wide STATE — one limiter, one window, one budget.
  // A second instance is a second cap.
  describe('inbound hardening gates', () => {
    it('defaults to a concurrency cap of 2 and an unlimited budget', async () => {
      const stack = await buildVoiceStack(deps(config({ voice: { bots: [] } })));
      const gates = stack?.inbound;
      expect(gates?.prewarm).toBe('allowlisted');
      expect(gates?.rateLimit).toBeUndefined();
      expect(gates?.budget.exceeded()).toBe(false);
      expect(gates?.concurrency.tryAcquire('c1')).toBe(true);
      expect(gates?.concurrency.tryAcquire('c2')).toBe(true);
      expect(gates?.concurrency.tryAcquire('c3')).toBe(false);
      await stack?.close();
    });

    it('builds each gate from voice.inbound.* — one instance per deployment', async () => {
      const stack = await buildVoiceStack(
        deps(
          config({
            voice: {
              bots: [],
              inbound: {
                allowlist: ['+1555*'],
                receptionist: 'reception',
                concurrencyCap: 1,
                perCallerPerHour: 1,
                dailyBudgetUsd: 5,
                prewarm: 'none',
                owner: { platform: 'telegram', chatId: 'C1' },
              },
            },
          }),
        ),
      );
      const gates = stack?.inbound;
      expect(gates?.allowlist).toEqual(['+1555*']);
      expect(gates?.receptionist).toBe('reception');
      expect(gates?.prewarm).toBe('none');
      expect(gates?.owner).toEqual({ platform: 'telegram', chatId: 'C1' });
      expect(gates?.concurrency.tryAcquire('a')).toBe(true);
      expect(gates?.concurrency.tryAcquire('b')).toBe(false);
      expect(gates?.rateLimit?.tryConsume('+15551230000')).toBe(true);
      expect(gates?.rateLimit?.tryConsume('+15551230000')).toBe(false);
      gates?.budget.record(5);
      expect(gates?.budget.exceeded()).toBe(true);
      await stack?.close();
    });
  });

  // A21 — the provider, not just the voice id, follows the personality.
  describe('per-personality provider roster', () => {
    it('two personalities naming different roster entries get different providers', async () => {
      const stack = await buildVoiceStack(
        deps(
          config({
            voice: {
              bots: [],
              tts: { providers: { studio: { provider: 'cloud-tts' } } },
              stt: { providers: { studio: { provider: 'cloud-stt' } } },
            },
          }),
        ),
      );
      if (!stack) throw new Error('expected a voice stack');
      const spoken = await stack.createSession({
        laneKey: 'voice:b:a',
        runner,
        personality: {
          id: 'p2',
          name: 'P2',
          voice: { tts_provider: 'studio', stt_provider: 'studio' },
        },
      });
      const plain = await stack.createSession({ laneKey: 'voice:b:b', runner });
      // The session stamps its providers' own names into every span it writes.
      expect(spoken.getState()).toBe('idle');
      expect(plain.getState()).toBe('idle');
      expect(stack.ttsProviderId).toBe('local-tts');
      await stack.close();
    });

    // The adversarial shape: the roster KEY is a label the operator typed. The
    // gate keys on the entry's underlying provider and the constructed
    // provider's caps, so a cloud entry called `local-*` is still refused.
    it('refuses a roster entry named local-* backed by a non-local provider', async () => {
      const stack = await buildVoiceStack(
        deps(
          config({
            voice: {
              bots: [],
              trustedPlugins: [],
              tts: { providers: { 'local-studio': { provider: 'cloud-tts' } } },
            },
          }),
        ),
      );
      if (!stack) throw new Error('expected a voice stack');
      await expect(
        stack.createSession({
          laneKey: 'voice:b:a',
          runner,
          personality: { id: 'p', name: 'P', voice: { tts_provider: 'local-studio' } },
        }),
      ).rejects.toThrow(/cloud-tts/);
      // ...while the default entry, which really is local, still serves.
      expect(await stack.createSession({ laneKey: 'voice:b:b', runner })).toBeDefined();
      await stack.close();
    });
  });

  it('warns but still builds when a configured provider is unknown', async () => {
    warnings.length = 0;
    const stack = await buildVoiceStack(
      deps(config({ voice: { bots: [] }, auxiliaryAsr: { provider: 'nope-stt' } })),
    );
    expect(stack).not.toBeNull();
    expect(stack?.providerError).toContain('nope-stt');
    await expect(stack?.createSession({ laneKey: 'voice:b:c', runner })).rejects.toThrow(
      /nope-stt/,
    );
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

      const session = await stack.createSession({
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

    // L5 — `voice.model` used to be a knob nothing read. These drive a real
    // `AgentLoop` from real audio and assert on the model string the LLM
    // PROVIDER was asked for, so the whole hop (lane -> pinned runner -> turn
    // setup -> CompletionOptions) has to be live for them to pass.
    describe('fast-lane model', () => {
      /** The model the provider served for one spoken turn on this lane. */
      async function modelUsedFor(personality?: PersonalityConfig): Promise<string> {
        const served: string[] = [];
        const llm: LLMProvider = {
          name: 'mock',
          model: 'deployment-default',
          maxContextTokens: 200_000,
          supportsCaching: false,
          supportsThinking: false,
          async *complete(_messages, _tools, completionOpts) {
            served.push(completionOpts.modelOverride ?? 'deployment-default');
            yield { type: 'text_delta', text: 'Hello there.' };
            yield { type: 'done', finishReason: 'end_turn' };
          },
          async countTokens() {
            return 10;
          },
        };
        const loop = new AgentLoop({ llm, safety: createTestSafety() });

        const stack = await buildVoiceStack(deps(config({ voice: { bots: [] } })));
        if (!stack) throw new Error('expected a voice stack');
        const session = await stack.createSession({
          laneKey: 'voice:bot:caller',
          runner: loop,
          ...(personality ? { personality } : {}),
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
        const first = served[0];
        if (!first) throw new Error('the turn never reached the provider');
        return first;
      }

      it('sends the model the personality declares in voice.model', async () => {
        await expect(modelUsedFor(personalityWithVoice({ model: 'fast-haiku' }))).resolves.toBe(
          'fast-haiku',
        );
      });

      it('sends the deployment default when the personality declares no voice.model', async () => {
        await expect(modelUsedFor(personalityWithVoice({ tts_voice: 'af_mine' }))).resolves.toBe(
          'deployment-default',
        );
      });

      // The interface exists so voice-session never imports core. If AgentLoop
      // stops fitting it, the production runner stops being injectable — which
      // is a compile error here and a runtime drive below.
      it('AgentLoop satisfies AgentTurnRunner', async () => {
        const llm: LLMProvider = {
          name: 'mock',
          model: 'deployment-default',
          maxContextTokens: 200_000,
          supportsCaching: false,
          supportsThinking: false,
          async *complete() {
            yield { type: 'text_delta', text: 'hi' };
            yield { type: 'done', finishReason: 'end_turn' };
          },
          async countTokens() {
            return 1;
          },
        };
        const asRunner: AgentTurnRunner = new AgentLoop({ llm, safety: createTestSafety() });

        const types: string[] = [];
        for await (const event of asRunner.run('hi', { modelOverride: 'fast-haiku' })) {
          types.push(event.type);
        }
        expect(types).toContain('done');
      });
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

  // `voice.bargeIn.<surface>` parsed, validated, round-tripped through the web
  // Settings page — and was read by NOTHING. An operator could tune a phone
  // line's cough filter and change no behaviour at all. These drive real PCM
  // through the real SIP adapter, so the numbers have to land on the VAD and
  // the endpoint detector for any of them to pass.
  describe('voice.bargeIn tuning reaches the lane it names', () => {
    /**
     * Open one adapter under `bargeIn`, speak, go quiet, and report whether the
     * utterance ever reached the recognizer.
     *
     * The recognizer is the probe because it sits on the far side of BOTH knobs
     * this block wires: audio that the VAD refused to call speech never becomes
     * an utterance, and an utterance the endpoint detector never closes is never
     * transcribed. Frames are pushed in a tight loop, so wall-clock silence is
     * ~0 ms — which is exactly why an untuned lane (400 ms default) commits
     * nothing and a lane tuned to `silenceMs: 0` commits.
     */
    async function transcribedAfterSpeaking(opts: {
      bargeIn?: VoiceBargeInConfig;
      /** Frame amplitude; 12_000 is RMS 0.366, well over the 0.02 default. */
      amplitude?: number;
      speechFrames?: number;
      sessionConfig?: VoiceSessionConfig;
      adapter?: 'sip' | 'livekit';
    }): Promise<boolean> {
      let transcribed = false;
      const sttProviders = new DefaultSttProviderRegistry();
      sttProviders.register('local-stt', () => ({
        name: 'local-stt',
        caps: {
          kind: 'stt' as const,
          formats: ['wav' as const],
          local: true,
          contractVersion: STT_CONTRACT_VERSION,
        },
        transcribeBuffer: async () => {
          transcribed = true;
          return '';
        },
      }));
      const ttsProviders = new DefaultTtsProviderRegistry();
      ttsProviders.register('local-tts', () => batchTts('local-tts', true));

      // Collected rather than assigned to a `let`: the subscription happens
      // inside `onRemoteAudio`, which control-flow analysis cannot see, so a
      // nullable local would still read as `null` at the call sites below.
      const subscribers: RemoteAudioHandler[] = [];
      const client: LiveKitRoomClient = {
        connect: async () => {},
        disconnect: async () => {},
        onRemoteAudio: (handler) => {
          subscribers.push(handler);
          return () => {};
        },
        publishAudio: () => {},
        remoteIdentity: () => 'caller',
      };

      const stack = await buildVoiceStack({
        config: config({
          voice: {
            bots: [],
            livekit: { url: 'wss://lk.example', apiKey: 'k', apiSecret: 's' },
            ...(opts.bargeIn ? { bargeIn: opts.bargeIn } : {}),
          },
        }),
        logger,
        sttProviders,
        ttsProviders,
        livekit: { createClient: () => client },
      });
      if (!stack) throw new Error('expected a voice stack');
      const build =
        opts.adapter === 'livekit' ? stack.createLiveKitAdapter : stack.createSipAdapter;
      if (!build) throw new Error('expected an adapter factory');
      const adapter = await build({
        bot: { id: 'reception', match: '+1555*' },
        roomName: 'call-1',
        callerId: '+15551230000',
        runner,
        ...(opts.sessionConfig ? { sessionConfig: opts.sessionConfig } : {}),
      });
      await adapter.start();
      const push = subscribers[0];
      if (!push) throw new Error('the transport never subscribed to remote audio');
      for (let i = 0; i < (opts.speechFrames ?? 10); i++) {
        push({ samples: new Int16Array(320).fill(opts.amplitude ?? 12_000), sampleRate: 16_000 });
      }
      for (let i = 0; i < 6; i++) push({ samples: new Int16Array(320), sampleRate: 16_000 });
      // Every stub resolves immediately; one macrotask is enough for the turn
      // this harness cares about to have run or provably not run.
      await new Promise((resolve) => setTimeout(resolve, 10));
      await adapter.stop();
      await stack.close();
      return transcribed;
    }

    const call = (tuning: VoiceBargeInConfig['call']): VoiceBargeInConfig => ({ call: tuning });

    it('leaves the built-in defaults alone when no bargeIn block is configured', async () => {
      // Nothing commits inside 0 ms of silence — the 400 ms endpoint default.
      await expect(transcribedAfterSpeaking({})).resolves.toBe(false);
      // ...and the energy/attack defaults still pass ordinary speech through,
      // which is what makes the negative above an endpoint result and not a
      // VAD that stopped hearing anything.
      await expect(
        transcribedAfterSpeaking({ sessionConfig: { endpointSilenceMs: 0 } }),
      ).resolves.toBe(true);
    });

    it('applies voice.bargeIn.call.silenceMs to the call lane endpoint detector', async () => {
      await expect(transcribedAfterSpeaking({ bargeIn: call({ silenceMs: 0 }) })).resolves.toBe(
        true,
      );
    });

    it('applies voice.bargeIn.call.energyThreshold to the call lane VAD', async () => {
      // RMS 0.366 is under a 0.9 floor: loud, and not speech.
      await expect(
        transcribedAfterSpeaking({ bargeIn: call({ silenceMs: 0, energyThreshold: 0.9 }) }),
      ).resolves.toBe(false);
    });

    it('applies voice.bargeIn.call.minSpeechMs as the call lane attack filter', async () => {
      // 10 frames × 20 ms = 200 ms of energy. Under a 400 ms floor it is a
      // cough; over a 100 ms one it is a voice.
      await expect(
        transcribedAfterSpeaking({ bargeIn: call({ silenceMs: 0, minSpeechMs: 400 }) }),
      ).resolves.toBe(false);
      await expect(
        transcribedAfterSpeaking({ bargeIn: call({ silenceMs: 0, minSpeechMs: 100 }) }),
      ).resolves.toBe(true);
    });

    it('does not let another surface tune the call lane', async () => {
      await expect(
        transcribedAfterSpeaking({ bargeIn: { satellite: { silenceMs: 0 } } }),
      ).resolves.toBe(false);
    });

    it('lets an explicit per-lane sessionConfig win over the surface tuning', async () => {
      await expect(
        transcribedAfterSpeaking({
          bargeIn: call({ silenceMs: 5_000 }),
          sessionConfig: { endpointSilenceMs: 0 },
        }),
      ).resolves.toBe(true);
    });

    // The room adapter is deliberately unmapped: `voice.bargeIn` names `call`
    // and `satellite`, and a LiveKit room participant is a lane kind of its
    // own. Pinned so a later "obvious" mapping is a decision someone makes
    // rather than one that leaks in.
    it('does not apply the call tuning to the LiveKit room lane', async () => {
      await expect(
        transcribedAfterSpeaking({ bargeIn: call({ silenceMs: 0 }), adapter: 'livekit' }),
      ).resolves.toBe(false);
    });
  });

  // Conflict 2 (plan §7, L1): the browser pipeline lane opens a `VoiceSession`
  // directly (no adapter — `browser-voice-session.ts` calls `createSession`
  // itself), so it is exercised here by pushing PCM straight at the session
  // rather than through a transport, same probe (did the recognizer see an
  // utterance) as the SIP/LiveKit suite above.
  describe('the browser surface', () => {
    async function transcribedAfterSpeakingOnBrowser(opts: {
      bargeIn?: VoiceBargeInConfig;
      bargeInFallback?: VoiceBargeInTuning;
      amplitude?: number;
      /** Defaults to 20 (400ms) — safely over the 250ms browser default floor. */
      speechFrames?: number;
      sessionConfig?: VoiceSessionConfig;
    }): Promise<boolean> {
      let transcribed = false;
      const sttProviders = new DefaultSttProviderRegistry();
      sttProviders.register('local-stt', () => ({
        name: 'local-stt',
        caps: {
          kind: 'stt' as const,
          formats: ['wav' as const],
          local: true,
          contractVersion: STT_CONTRACT_VERSION,
        },
        transcribeBuffer: async () => {
          transcribed = true;
          return '';
        },
      }));
      const ttsProviders = new DefaultTtsProviderRegistry();
      ttsProviders.register('local-tts', () => batchTts('local-tts', true));

      const stack = await buildVoiceStack({
        config: config({
          voice: { bots: [], ...(opts.bargeIn ? { bargeIn: opts.bargeIn } : {}) },
        }),
        logger,
        sttProviders,
        ttsProviders,
      });
      if (!stack) throw new Error('expected a voice stack');
      const session = await stack.createSession({
        laneKey: 'voice:web:browser:client-1',
        runner,
        surface: 'browser',
        ...(opts.bargeInFallback ? { bargeInFallback: opts.bargeInFallback } : {}),
        ...(opts.sessionConfig ? { sessionConfig: opts.sessionConfig } : {}),
      });
      for (let i = 0; i < (opts.speechFrames ?? 20); i++) {
        session.pushAudio({
          data: new Int16Array(320).fill(opts.amplitude ?? 12_000),
          sampleRate: 16_000,
        });
      }
      for (let i = 0; i < 6; i++) {
        session.pushAudio({ data: new Int16Array(320), sampleRate: 16_000 });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      await stack.close();
      return transcribed;
    }

    it('applies voice.bargeIn.browser to the browser lane', async () => {
      await expect(
        transcribedAfterSpeakingOnBrowser({ bargeIn: { browser: { silenceMs: 0 } } }),
      ).resolves.toBe(true);
    });

    it('falls back to the legacy display.voice_* tuning when voice.bargeIn.browser is unset', async () => {
      await expect(
        transcribedAfterSpeakingOnBrowser({ bargeInFallback: { silenceMs: 0 } }),
      ).resolves.toBe(true);
    });

    it('lets an explicit voice.bargeIn.browser win over the legacy fallback', async () => {
      // `voice.bargeIn.browser.silenceMs: 5_000` must decide this, not the
      // fallback's `silenceMs: 0` — so nothing commits inside the harness's
      // ~0 ms of wall-clock silence.
      await expect(
        transcribedAfterSpeakingOnBrowser({
          bargeIn: { browser: { silenceMs: 5_000 } },
          bargeInFallback: { silenceMs: 0 },
        }),
      ).resolves.toBe(false);
    });

    it('applies the browser default tuning with no bargeIn block and no fallback', async () => {
      // Neither `voice.bargeIn.browser` nor the legacy fallback is set, so the
      // browser lane lands on `DEFAULT_BROWSER_BARGE_IN`'s 700 ms silenceMs —
      // still nowhere near the harness's ~0 ms of wall-clock silence, so
      // nothing commits. (Confirms the floor applies, not that "no defaults"
      // apply — see the positive-coverage tests below for that.)
      await expect(transcribedAfterSpeakingOnBrowser({})).resolves.toBe(false);
    });

    it('applies the browser default energyThreshold with no bargeIn block and no fallback', async () => {
      // RMS ≈0.031 (amplitude 1_000) clears EnergyVad's bare 0.02 default but
      // sits under the new 0.06 browser default — not speech.
      await expect(
        transcribedAfterSpeakingOnBrowser({
          amplitude: 1_000,
          sessionConfig: { endpointSilenceMs: 0 },
        }),
      ).resolves.toBe(false);
      // RMS ≈0.366 (amplitude 12_000) is clearly over 0.06 — speech.
      await expect(
        transcribedAfterSpeakingOnBrowser({
          amplitude: 12_000,
          sessionConfig: { endpointSilenceMs: 0 },
        }),
      ).resolves.toBe(true);
    });

    it('applies the browser default minSpeechMs with no bargeIn block and no fallback', async () => {
      // 5 frames × 20 ms = 100 ms of loud energy — under the 250 ms floor, a
      // cough rather than a voice.
      await expect(
        transcribedAfterSpeakingOnBrowser({
          speechFrames: 5,
          sessionConfig: { endpointSilenceMs: 0 },
        }),
      ).resolves.toBe(false);
      // 15 frames × 20 ms = 300 ms — safely over the 250 ms floor.
      await expect(
        transcribedAfterSpeakingOnBrowser({
          speechFrames: 15,
          sessionConfig: { endpointSilenceMs: 0 },
        }),
      ).resolves.toBe(true);
    });

    it('falls back to the browser defaults for fields an operator leaves unset', async () => {
      // Only `energyThreshold` is configured (set low, so it is never the
      // thing gating the result); `minSpeechMs` must still fall through to
      // the 250 ms browser default rather than EnergyVad's bare 0 ms — a
      // 100 ms burst (5 frames) stays below that floor and never registers,
      // while a 300 ms burst (15 frames) clears it.
      await expect(
        transcribedAfterSpeakingOnBrowser({
          bargeIn: { browser: { energyThreshold: 0.01 } },
          speechFrames: 5,
          sessionConfig: { endpointSilenceMs: 0 },
        }),
      ).resolves.toBe(false);
      await expect(
        transcribedAfterSpeakingOnBrowser({
          bargeIn: { browser: { energyThreshold: 0.01 } },
          speechFrames: 15,
          sessionConfig: { endpointSilenceMs: 0 },
        }),
      ).resolves.toBe(true);
    });
  });

  // `voice.filler.*` — the tool-call filler/tick keep-alive, threaded into
  // `VoiceSessionConfig`. An EXPLICIT `enabled` is deployment-wide like
  // `bargeIn` is per-surface: it applies uniformly (unlike `bargeIn`, there is
  // no per-surface block). Absent `enabled`, the DEFAULT is surface-scoped —
  // browser only — see the `default enable is surface-scoped` describe below.
  // Real timers, bounded to well under a second: `VoiceSession` itself takes
  // no injectable clock/timer from this layer, and the interval under test is
  // short enough that a real wait is fast and not flaky.
  describe('voice.filler wiring', () => {
    /** A runner that holds a tool call open until `release()` is called. */
    function toolRunner(): { runner: AgentTurnRunner; release: () => void } {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        runner: {
          async *run(): AsyncGenerator<AgentEvent> {
            yield { type: 'tool_start', toolCallId: 't1', toolName: 'search', args: {} };
            await gate;
            yield {
              type: 'tool_end',
              toolCallId: 't1',
              toolName: 'search',
              ok: true,
              durationMs: 5,
            };
            yield { type: 'text_delta', text: 'Found it.' };
          },
        },
        release,
      };
    }

    async function speakOneUtterance(session: VoiceSession): Promise<void> {
      // 15 frames × 20 ms = 300 ms — safely over the browser surface's new
      // 250 ms minSpeechMs default (call/satellite/no-surface lanes are
      // unaffected by the raise; they still use EnergyVad's bare 0ms floor).
      for (let i = 0; i < 15; i++) {
        session.pushAudio({ data: new Int16Array(320).fill(12_000), sampleRate: 16_000 });
      }
      for (let i = 0; i < 6; i++) {
        session.pushAudio({ data: new Int16Array(320), sampleRate: 16_000 });
      }
    }

    it('applies voice.filler.afterMs/text/tickIntervalMs to a slow tool call', async () => {
      const stack = await buildVoiceStack(
        deps(
          config({
            voice: { bots: [], filler: { afterMs: 50, text: 'One sec.', tickIntervalMs: 60 } },
          }),
        ),
      );
      if (!stack) throw new Error('expected a voice stack');
      const { runner: toolCall, release } = toolRunner();
      const session = await stack.createSession({
        laneKey: 'voice:bot:filler-on',
        runner: toolCall,
        surface: 'browser',
        sessionConfig: { endpointSilenceMs: 0 },
      });

      const events: string[] = [];
      let fillerText = '';
      session.on((e) => {
        events.push(e.type);
        if (e.type === 'filler') fillerText = e.text;
      });
      await speakOneUtterance(session);

      // Long enough for both the 50ms filler debounce and at least one 60ms
      // tick to fire, short enough to keep the test fast.
      await new Promise((resolve) => setTimeout(resolve, 150));
      release();
      await session.idle();
      await stack.close();

      expect(events).toContain('filler');
      expect(fillerText).toBe('One sec.');
      expect(events).toContain('tick');
      expect(events).toContain('reply_complete');
    });

    it('turns off both the filler and the tick when voice.filler.enabled is false', async () => {
      const stack = await buildVoiceStack(
        deps(
          config({
            voice: { bots: [], filler: { enabled: false, afterMs: 10, tickIntervalMs: 10 } },
          }),
        ),
      );
      if (!stack) throw new Error('expected a voice stack');
      const { runner: toolCall, release } = toolRunner();
      const session = await stack.createSession({
        laneKey: 'voice:bot:filler-off',
        runner: toolCall,
        sessionConfig: { endpointSilenceMs: 0 },
      });

      const events: string[] = [];
      session.on((e) => events.push(e.type));
      await speakOneUtterance(session);

      await new Promise((resolve) => setTimeout(resolve, 100));
      release();
      await session.idle();
      await stack.close();

      expect(events).not.toContain('filler');
      expect(events).not.toContain('tick');
      expect(events).toContain('reply_complete');
    });

    it('lets an explicit sessionConfig override the deployment-wide filler default', async () => {
      const stack = await buildVoiceStack(
        deps(config({ voice: { bots: [], filler: { afterMs: 5_000, tickIntervalMs: 5_000 } } })),
      );
      if (!stack) throw new Error('expected a voice stack');
      const { runner: toolCall, release } = toolRunner();
      const session = await stack.createSession({
        laneKey: 'voice:bot:filler-override',
        runner: toolCall,
        // A caller naming its own filler config wins over the 5s deployment
        // default — same precedence as `endpointSilenceMs` above.
        sessionConfig: { endpointSilenceMs: 0, fillerAfterMs: 30, tickIntervalMs: 40 },
      });

      const events: string[] = [];
      session.on((e) => events.push(e.type));
      await speakOneUtterance(session);

      await new Promise((resolve) => setTimeout(resolve, 100));
      release();
      await session.idle();
      await stack.close();

      expect(events).toContain('filler');
      expect(events).toContain('tick');
    });

    // Bug: the filler/tick default used to apply uniformly to every lane
    // (`fillerEnabled = filler.enabled ?? true`), so ANY existing deployment
    // with a `voice.*` block configured for phone or satellite would, the
    // moment this shipped, start speaking the filler line and playing tick
    // tones on those surfaces too — a silent behavior change to channels this
    // feature was never scoped to touch. The default must be browser-only;
    // an explicit `voice.filler.enabled` always overrides it, everywhere.
    describe('voice.filler — default enable is surface-scoped', () => {
      async function fillerEventsFor(opts: {
        surface?: 'call' | 'satellite' | 'browser';
        enabled?: boolean;
      }): Promise<string[]> {
        const stack = await buildVoiceStack(
          deps(
            config({
              voice: {
                bots: [],
                filler: {
                  ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
                  afterMs: 10,
                  tickIntervalMs: 10,
                },
              },
            }),
          ),
        );
        if (!stack) throw new Error('expected a voice stack');
        const { runner: toolCall, release } = toolRunner();
        const session = await stack.createSession({
          laneKey: 'voice:bot:filler-default-scope',
          runner: toolCall,
          ...(opts.surface ? { surface: opts.surface } : {}),
          sessionConfig: { endpointSilenceMs: 0 },
        });
        const events: string[] = [];
        session.on((e) => events.push(e.type));
        await speakOneUtterance(session);
        await new Promise((resolve) => setTimeout(resolve, 80));
        release();
        await session.idle();
        await stack.close();
        return events;
      }

      it('defaults ON for the browser surface', async () => {
        const events = await fillerEventsFor({ surface: 'browser' });
        expect(events).toContain('filler');
        expect(events).toContain('tick');
      });

      it('defaults OFF for the call surface', async () => {
        const events = await fillerEventsFor({ surface: 'call' });
        expect(events).not.toContain('filler');
        expect(events).not.toContain('tick');
      });

      it('defaults OFF for the satellite surface', async () => {
        const events = await fillerEventsFor({ surface: 'satellite' });
        expect(events).not.toContain('filler');
        expect(events).not.toContain('tick');
      });

      it('defaults OFF for a lane with no surface of its own', async () => {
        const events = await fillerEventsFor({});
        expect(events).not.toContain('filler');
        expect(events).not.toContain('tick');
      });

      it('an explicit voice.filler.enabled: true turns it on for call and satellite too', async () => {
        const call = await fillerEventsFor({ surface: 'call', enabled: true });
        expect(call).toContain('filler');
        expect(call).toContain('tick');

        const satellite = await fillerEventsFor({ surface: 'satellite', enabled: true });
        expect(satellite).toContain('filler');
        expect(satellite).toContain('tick');
      });

      it('an explicit voice.filler.enabled: false turns it off for the browser surface too', async () => {
        const events = await fillerEventsFor({ surface: 'browser', enabled: false });
        expect(events).not.toContain('filler');
        expect(events).not.toContain('tick');
      });
    });
  });
});
