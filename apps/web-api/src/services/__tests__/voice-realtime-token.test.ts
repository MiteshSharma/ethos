import type {
  RealtimeEphemeralToken,
  RealtimeProviderEntry,
  RealtimeSession,
  RealtimeVoiceProvider,
  RealtimeVoiceProviderFactory,
  RealtimeVoiceProviderRegistry,
} from '@ethosagent/types';
import { REALTIME_CONTRACT_VERSION } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { VoiceService } from '../voice.service';

// `voice.realtimeToken` — the browser-direct credential, or a typed reason why
// not. What the browser does with each reason is `talk-mode-client.test.ts`;
// what makes each reason happen is here.

const OPERATOR_KEY = 'sk-operator-do-not-leak';

/** Counts every session opened and every credential minted. */
const opened: string[] = [];
const minted: string[] = [];

function provider(opts: {
  name: string;
  local?: boolean;
  ephemeralToken?: boolean;
  inputSampleRate?: number;
  outputSampleRate?: number;
  mint?: () => Promise<RealtimeEphemeralToken>;
}): RealtimeVoiceProvider {
  const canMint = opts.ephemeralToken !== false;
  return {
    name: opts.name,
    caps: {
      kind: 'realtime',
      inputSampleRate: opts.inputSampleRate ?? 24_000,
      outputSampleRate: opts.outputSampleRate ?? 24_000,
      local: opts.local ?? false,
      ephemeralToken: canMint,
      contractVersion: REALTIME_CONTRACT_VERSION,
    },
    open: (): Promise<RealtimeSession> => {
      opened.push(opts.name);
      return Promise.reject(new Error('the test never opens a real session'));
    },
    ...(canMint
      ? {
          mintEphemeralToken: (): Promise<RealtimeEphemeralToken> => {
            minted.push(opts.name);
            return (
              opts.mint?.() ??
              Promise.resolve({
                token: 'ek_browser',
                expiresAt: 1_700_000_000_000,
                url: 'wss://api.openai.com/v1/realtime?model=gpt-realtime',
                model: 'gpt-realtime',
              })
            );
          },
        }
      : {}),
  };
}

function registry(factories: Record<string, RealtimeVoiceProviderFactory>) {
  const reg: RealtimeVoiceProviderRegistry = {
    register: vi.fn(),
    unregister: vi.fn(),
    get: (name) => factories[name],
    list: () => Object.keys(factories),
  };
  return reg;
}

const OPENAI_ENTRY: RealtimeProviderEntry = {
  provider: 'openai-realtime',
  apiKey: OPERATOR_KEY,
  model: 'gpt-realtime',
  voice: 'marin',
};

function service(opts: {
  roster?: Record<string, RealtimeProviderEntry>;
  realtimeDefault?: string;
  tier?: 'pipeline' | 'realtime';
  trustedVoicePlugins?: ReadonlySet<string>;
  personalityVoice?: Record<string, { voice?: Record<string, unknown> }>;
  mint?: () => Promise<RealtimeEphemeralToken>;
  registryOverride?: RealtimeVoiceProviderRegistry;
}): VoiceService {
  const reg =
    opts.registryOverride ??
    registry({
      'openai-realtime': () =>
        provider({ name: 'openai-realtime', ...(opts.mint ? { mint: opts.mint } : {}) }),
      'gemini-live': () =>
        provider({
          name: 'gemini-live',
          ephemeralToken: false,
          inputSampleRate: 16_000,
          outputSampleRate: 24_000,
        }),
      'on-box': () => provider({ name: 'on-box', local: true }),
      'broken-realtime': () => {
        throw new Error(`factory blew up and echoed the key ${OPERATOR_KEY}`);
      },
    });
  return new VoiceService({
    realtimeRegistry: reg,
    ...(opts.roster ? { realtimeRoster: opts.roster } : {}),
    ...(opts.realtimeDefault ? { realtimeDefault: opts.realtimeDefault } : {}),
    ...(opts.tier ? { tier: opts.tier } : {}),
    ...(opts.trustedVoicePlugins ? { trustedVoicePlugins: opts.trustedVoicePlugins } : {}),
    ...(opts.personalityVoice
      ? { personalities: { get: (id: string) => opts.personalityVoice?.[id] } }
      : {}),
  });
}

describe('mintRealtimeToken — the happy path', () => {
  it('mints a browser credential and reports BOTH sample rates', async () => {
    const result = await service({
      roster: { live: OPENAI_ENTRY },
      realtimeDefault: 'live',
    }).mintRealtimeToken({});

    expect(result).toEqual({
      ok: true,
      // The REGISTERED provider id, never the roster label.
      providerId: 'openai-realtime',
      model: 'gpt-realtime',
      token: 'ek_browser',
      expiresAt: 1_700_000_000_000,
      url: 'wss://api.openai.com/v1/realtime?model=gpt-realtime',
      inputSampleRate: 24_000,
      outputSampleRate: 24_000,
    });
  });

  it('lets a personality name its own realtime entry', async () => {
    const svc = service({
      roster: {
        live: OPENAI_ENTRY,
        cheap: { provider: 'gemini-live', apiKey: 'gk' },
      },
      realtimeDefault: 'cheap',
      personalityVoice: { scout: { voice: { realtime_provider: 'live' } } },
    });
    const result = await svc.mintRealtimeToken({ personalityId: 'scout' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.providerId).toBe('openai-realtime');
  });
});

describe('mintRealtimeToken — the typed refusals', () => {
  it('not_configured: no roster and no default', async () => {
    const result = await service({}).mintRealtimeToken({});
    expect(result).toMatchObject({ ok: false, reason: 'not_configured', providerId: null });
  });

  it('unknown_entry: the personality names an entry this deployment lacks', async () => {
    const result = await service({
      roster: { live: OPENAI_ENTRY },
      personalityVoice: { scout: { voice: { realtime_provider: 'eu-live' } } },
    }).mintRealtimeToken({ personalityId: 'scout' });
    expect(result).toMatchObject({ ok: false, reason: 'unknown_entry' });
    expect(result.ok === false && result.message).toContain('eu-live');
  });

  it('untrusted_provider: the local-only gate refuses a hosted model, naming the REAL provider', async () => {
    opened.length = 0;
    minted.length = 0;

    const result = await service({
      // The adversarial label: a hosted provider dressed up as a local one.
      roster: { 'local-realtime': OPENAI_ENTRY },
      realtimeDefault: 'local-realtime',
      trustedVoicePlugins: new Set<string>(),
    }).mintRealtimeToken({});

    expect(result).toMatchObject({
      ok: false,
      reason: 'untrusted_provider',
      providerId: 'openai-realtime',
    });
    if (result.ok) return;
    expect(result.message).toContain('openai-realtime');
    expect(result.message).not.toContain('local-realtime');
    // Refused BEFORE anything happened: no session, no credential.
    expect(opened).toEqual([]);
    expect(minted).toEqual([]);
  });

  it('no_browser_token: a server-relayed provider cannot hand a page a credential', async () => {
    // Gemini Live by design. Fully usable server-side; just not browser-direct.
    const result = await service({
      roster: { cheap: { provider: 'gemini-live', apiKey: 'gk' } },
      realtimeDefault: 'cheap',
    }).mintRealtimeToken({});
    expect(result).toMatchObject({
      ok: false,
      reason: 'no_browser_token',
      providerId: 'gemini-live',
    });
  });

  it('provider_unavailable: the provider would not construct', async () => {
    const result = await service({
      roster: { live: { provider: 'broken-realtime', apiKey: OPERATOR_KEY } },
      realtimeDefault: 'live',
    }).mintRealtimeToken({});
    expect(result).toMatchObject({ ok: false, reason: 'provider_unavailable' });
  });

  it('provider_unavailable: the mint itself failed', async () => {
    const result = await service({
      roster: { live: OPENAI_ENTRY },
      realtimeDefault: 'live',
      mint: () => Promise.reject(new Error(`Incorrect API key provided: ${OPERATOR_KEY}`)),
    }).mintRealtimeToken({});
    expect(result).toMatchObject({ ok: false, reason: 'provider_unavailable' });
  });

  it('pipeline_preferred: the deployment asked for the local pipeline', async () => {
    const result = await service({
      roster: { live: OPENAI_ENTRY },
      realtimeDefault: 'live',
      tier: 'pipeline',
    }).mintRealtimeToken({});
    expect(result).toMatchObject({ ok: false, reason: 'pipeline_preferred' });
  });

  it('pipeline_preferred: a personality overrides a realtime deployment', async () => {
    // Personality first, deployment second — one precedence rule, resolved by
    // `resolveVoicePreferences` for the whole repo.
    const result = await service({
      roster: { live: OPENAI_ENTRY },
      realtimeDefault: 'live',
      tier: 'realtime',
      personalityVoice: { quiet: { voice: { tier: 'pipeline' } } },
    }).mintRealtimeToken({ personalityId: 'quiet' });
    expect(result).toMatchObject({ ok: false, reason: 'pipeline_preferred' });
  });

  it('a personality asking for realtime beats a pipeline deployment default', async () => {
    const result = await service({
      roster: { live: OPENAI_ENTRY },
      realtimeDefault: 'live',
      tier: 'pipeline',
      personalityVoice: { chatty: { voice: { tier: 'realtime' } } },
    }).mintRealtimeToken({ personalityId: 'chatty' });
    expect(result.ok).toBe(true);
  });
});

describe('mintRealtimeToken — no refusal ever carries key material', () => {
  it('keeps the operator key out of every refusal message', async () => {
    const cases = await Promise.all([
      service({}).mintRealtimeToken({}),
      service({
        roster: { live: OPENAI_ENTRY },
        realtimeDefault: 'live',
        trustedVoicePlugins: new Set<string>(),
      }).mintRealtimeToken({}),
      service({
        roster: { live: { provider: 'broken-realtime', apiKey: OPERATOR_KEY } },
        realtimeDefault: 'live',
      }).mintRealtimeToken({}),
      service({
        roster: { live: OPENAI_ENTRY },
        realtimeDefault: 'live',
        // A real provider's rejection body echoes part of the key back. That
        // string must not reach the browser.
        mint: () => Promise.reject(new Error(`Incorrect API key provided: ${OPERATOR_KEY}`)),
      }).mintRealtimeToken({}),
    ]);

    for (const result of cases) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.message).not.toContain(OPERATOR_KEY);
      expect(result.message).not.toContain('sk-');
    }
  });
});
