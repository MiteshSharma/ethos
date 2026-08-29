import { REALTIME_BOUNDARY_POLICY } from '@ethosagent/tools-voice';
import type {
  RealtimeEphemeralToken,
  RealtimeSession,
  RealtimeSessionOptions,
  RealtimeVoiceProvider,
  RealtimeVoiceProviderRegistry,
} from '@ethosagent/types';
import { REALTIME_CONTRACT_VERSION } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { type RealtimeSessionSurface, VoiceService } from '../voice.service';

// What the ephemeral credential is minted WITH — the personality's identity,
// the boundary policy, the advertised tools and the voice. A realtime session is
// configured exactly once, at open; there is no second chance to tell a live
// model who it is.

const mintCalls: RealtimeSessionOptions[] = [];

function provider(): RealtimeVoiceProvider {
  return {
    name: 'openai-realtime',
    caps: {
      kind: 'realtime',
      inputSampleRate: 24_000,
      outputSampleRate: 24_000,
      local: false,
      ephemeralToken: true,
      contractVersion: REALTIME_CONTRACT_VERSION,
    },
    open: (): Promise<RealtimeSession> => Promise.reject(new Error('never opened here')),
    mintEphemeralToken: (opts): Promise<RealtimeEphemeralToken> => {
      mintCalls.push(opts);
      return Promise.resolve({
        token: 'ek',
        expiresAt: 1,
        url: 'wss://example',
        model: 'gpt-realtime',
      });
    },
  };
}

const registry: RealtimeVoiceProviderRegistry = {
  register: vi.fn(),
  unregister: vi.fn(),
  get: (name) => (name === 'openai-realtime' ? () => provider() : undefined),
  list: () => ['openai-realtime'],
};

function service(opts: {
  surface?: RealtimeSessionSurface;
  personalityVoice?: Record<string, { voice?: Record<string, unknown> }>;
  entryVoice?: string;
}): VoiceService {
  return new VoiceService({
    realtimeRegistry: registry,
    realtimeRoster: {
      live: {
        provider: 'openai-realtime',
        apiKey: 'k',
        model: 'gpt-realtime',
        ...(opts.entryVoice ? { voice: opts.entryVoice } : {}),
      },
    },
    realtimeDefault: 'live',
    ...(opts.surface ? { realtimeSurface: opts.surface } : {}),
    ...(opts.personalityVoice
      ? { personalities: { get: (id: string) => opts.personalityVoice?.[id] } }
      : {}),
  });
}

const surface = (instructions: string, tools: string[]): RealtimeSessionSurface => ({
  describe: async () => ({
    instructions,
    tools: tools.map((name) => ({ name, description: name, parameters: {} })),
  }),
});

describe('realtime session configuration at mint', () => {
  it('sends the personality identity plus the boundary policy as instructions', async () => {
    mintCalls.length = 0;
    await service({
      surface: surface(`I am Ada.\n\n${REALTIME_BOUNDARY_POLICY}`, ['agent_consult']),
    }).mintRealtimeToken({ personalityId: 'ada' });

    expect(mintCalls[0]?.instructions).toContain('I am Ada.');
    expect(mintCalls[0]?.instructions).toContain(REALTIME_BOUNDARY_POLICY);
  });

  it('advertises the tools the surface generated', async () => {
    mintCalls.length = 0;
    await service({ surface: surface('soul', ['agent_consult']) }).mintRealtimeToken({});

    expect(mintCalls[0]?.tools?.map((t) => t.name)).toEqual(['agent_consult']);
  });

  it('keeps a live session usable when the surface throws', async () => {
    // A malformed personality on disk must not take voice down. The session
    // still hears and speaks; it just has no identity — which is exactly the
    // state this deployment was in before the seam existed.
    mintCalls.length = 0;
    const broken: RealtimeSessionSurface = {
      describe: () => Promise.reject(new Error('SOUL.md is a directory')),
    };
    const result = await service({ surface: broken }).mintRealtimeToken({});

    expect(result.ok).toBe(true);
    expect(mintCalls[0]?.instructions).toBe('');
    expect(mintCalls[0]?.tools).toBeUndefined();
  });

  it('a personality voice beats the roster entry default', async () => {
    // Same precedence function the pipeline tier uses. Switching tiers must not
    // switch who you are talking to.
    mintCalls.length = 0;
    await service({
      entryVoice: 'marin',
      personalityVoice: { ada: { voice: { tts_voice: 'cedar' } } },
    }).mintRealtimeToken({ personalityId: 'ada' });

    expect(mintCalls[0]?.voice).toBe('cedar');
  });

  it('falls back to the roster entry voice when the personality declares none', async () => {
    mintCalls.length = 0;
    await service({ entryVoice: 'marin' }).mintRealtimeToken({});

    expect(mintCalls[0]?.voice).toBe('marin');
  });
});
