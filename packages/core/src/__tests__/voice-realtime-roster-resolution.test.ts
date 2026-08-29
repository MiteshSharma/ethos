// The named realtime roster: `voice.realtime.providers.<name>.*` in config,
// picked per personality by `voice.realtime_provider`, with
// `voice.realtime.default` as the deployment's answer when a personality names
// none. The third sibling of voice-roster-resolution.test.ts (TTS) and
// voice-stt-roster-resolution.test.ts (STT), case for case.
//
// The security property matters MOST here. A realtime session is duplex: the
// microphone goes up continuously AND the model's voice comes back, and on the
// browser-direct path the page connects to the provider itself with a minted
// credential. If the egress gate ever keyed on the roster LABEL, naming a
// hosted speech-to-speech model `local-realtime` would open a live microphone
// feed to a third party on a deployment configured local-only — and would hand
// the page a token to keep doing it.

import type {
  RealtimeEphemeralToken,
  RealtimeProviderEntry,
  RealtimeSession,
  RealtimeSessionOptions,
  RealtimeVoiceProvider,
} from '@ethosagent/types';
import { REALTIME_CONTRACT_VERSION } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { DefaultRealtimeVoiceProviderRegistry } from '../providers/realtime-registry';
import {
  realtimeEntryProviderConfig,
  resolveRealtimeProviderForPersonality,
  selectRealtimeEntry,
} from '../providers/voice-resolution';

/** Counts every session opened and every browser token minted, process-wide. */
const opened: string[] = [];
const minted: string[] = [];

interface SpyRealtime extends RealtimeVoiceProvider {
  readonly config: Record<string, unknown>;
}

function spyRealtime(name: string, local: boolean, config: Record<string, unknown>): SpyRealtime {
  return {
    name,
    caps: {
      kind: 'realtime',
      inputSampleRate: 24_000,
      outputSampleRate: 24_000,
      local,
      ephemeralToken: true,
      contractVersion: REALTIME_CONTRACT_VERSION,
    },
    config,
    open: (_opts: RealtimeSessionOptions): Promise<RealtimeSession> => {
      opened.push(name);
      return Promise.reject(new Error('the test never expects a real session'));
    },
    mintEphemeralToken: (): Promise<RealtimeEphemeralToken> => {
      minted.push(name);
      return Promise.resolve({ token: 'ek_should_never_exist', expiresAt: 0, url: 'wss://x' });
    },
  };
}

function registry(): DefaultRealtimeVoiceProviderRegistry {
  const reg = new DefaultRealtimeVoiceProviderRegistry();
  reg.register('openai-realtime', (ctx) => spyRealtime('openai-realtime', false, ctx.config));
  reg.register('gemini-live', (ctx) => spyRealtime('gemini-live', false, ctx.config));
  reg.register('on-box-realtime', (ctx) => spyRealtime('on-box-realtime', true, ctx.config));
  return reg;
}

const LIVE: RealtimeProviderEntry = {
  provider: 'openai-realtime',
  apiKey: 'sk-live',
  model: 'gpt-realtime',
  voice: 'marin',
  costPerMinuteUsd: 0.06,
};
const CHEAP: RealtimeProviderEntry = { provider: 'gemini-live', apiKey: 'gk-cheap' };
const ROSTER: Record<string, RealtimeProviderEntry> = { live: LIVE, cheap: CHEAP };

describe('selectRealtimeEntry', () => {
  it('picks the roster entry a personality names', () => {
    const selection = selectRealtimeEntry({ requestedName: 'cheap', roster: ROSTER });
    expect(selection).toMatchObject({ entryName: 'cheap', reason: 'roster' });
    expect(selection.entry).toBe(CHEAP);
  });

  it('falls back to voice.realtime.default when the personality names none', () => {
    const selection = selectRealtimeEntry({ roster: ROSTER, defaultEntryName: 'live' });
    expect(selection).toMatchObject({ entryName: 'live', reason: 'default' });
    expect(selection.entry).toBe(LIVE);
  });

  it('falls back to the deployment default — with the reason preserved — on an unknown name', () => {
    const warn = vi.fn();
    const logger = {
      info() {},
      warn,
      error() {},
      debug() {},
      child() {
        return this;
      },
    };
    const selection = selectRealtimeEntry({
      requestedName: 'a-machine-that-does-not-have-this',
      roster: ROSTER,
      defaultEntryName: 'live',
      logger,
    });
    expect(selection).toMatchObject({
      entryName: 'live',
      reason: 'unknown_name',
      requestedName: 'a-machine-that-does-not-have-this',
    });
    // The log names the REALTIME default key, not the TTS or STT one — a
    // mixed-up message here sends an operator to the wrong config key.
    expect(warn.mock.calls[0]?.[0]).toContain('voice.realtime.default');
  });

  it('reports no entry at all when neither the name nor the default resolves', () => {
    // Realtime's honest "nothing configured" — unlike TTS/STT there is no
    // `auxiliary.*` entry underneath to quietly serve instead.
    expect(selectRealtimeEntry({ roster: ROSTER }).entry).toBeUndefined();
    expect(
      selectRealtimeEntry({ roster: ROSTER, defaultEntryName: 'not-here' }).entry,
    ).toBeUndefined();
  });
});

describe('resolveRealtimeProviderForPersonality', () => {
  it('constructs the named entry with that entry’s own knobs', async () => {
    const { resolution, selection } = await resolveRealtimeProviderForPersonality({
      registry: registry(),
      personality: { realtime_provider: 'live' },
      roster: ROSTER,
      defaultEntryName: 'cheap',
    });

    expect(selection).toMatchObject({ entryName: 'live', reason: 'roster' });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    // The provider id that ran is the entry's UNDERLYING provider, not its label.
    expect(resolution.providerId).toBe('openai-realtime');
    expect((resolution.provider as SpyRealtime).config).toEqual({
      apiKey: 'sk-live',
      model: 'gpt-realtime',
      voice: 'marin',
      costPerMinuteUsd: 0.06,
    });
  });

  it('uses voice.realtime.default when the personality names no provider', async () => {
    const { resolution, selection } = await resolveRealtimeProviderForPersonality({
      registry: registry(),
      personality: { tts_voice: 'af_sky' },
      roster: ROSTER,
      defaultEntryName: 'cheap',
    });
    expect(selection.reason).toBe('default');
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.providerId).toBe('gemini-live');
  });

  it('does not confuse the TTS or STT choice for the realtime one', async () => {
    const { resolution, selection } = await resolveRealtimeProviderForPersonality({
      registry: registry(),
      personality: { tts_provider: 'live', stt_provider: 'live' },
      roster: ROSTER,
      defaultEntryName: 'cheap',
    });
    expect(selection.reason).toBe('default');
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.providerId).toBe('gemini-live');
  });

  it('reports not_configured when neither the roster nor a default answers', async () => {
    const { resolution } = await resolveRealtimeProviderForPersonality({
      registry: registry(),
      personality: { realtime_provider: 'live' },
    });
    expect(resolution).toMatchObject({ ok: false, code: 'not_configured' });
  });
});

describe('realtime egress gate keys on the resolved provider, never on the roster label', () => {
  // The adversarial case: an operator (or a shared personality) names a HOSTED
  // speech-to-speech model something local-sounding, on a deployment whose gate
  // is armed local-only.
  const DISGUISED: Record<string, RealtimeProviderEntry> = {
    'local-realtime': { provider: 'openai-realtime', apiKey: 'sk-exfil' },
    'totally-offline': { provider: 'on-box-realtime' },
  };

  it('refuses a roster entry named "local-realtime" backed by a hosted provider', async () => {
    opened.length = 0;
    minted.length = 0;

    const { resolution, selection } = await resolveRealtimeProviderForPersonality({
      registry: registry(),
      personality: { realtime_provider: 'local-realtime' },
      roster: DISGUISED,
      // Gate armed, allowlist empty: only `caps.local` providers may run.
      trustedVoicePlugins: new Set<string>(),
    });

    expect(selection.entryName).toBe('local-realtime');
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.code).toBe('untrusted_provider');
    // The refusal names the provider that was actually about to run.
    expect(resolution.providerId).toBe('openai-realtime');
    expect(resolution.error).toContain('openai-realtime');
    expect(resolution.error).not.toContain('local-realtime');
    // Nothing leaks the operator's key into the refusal an operator will read.
    expect(resolution.error).not.toContain('sk-exfil');

    // The whole point: the microphone never opened and the browser never got a
    // credential to open it with. A gate that refused AFTER either of these
    // would already have leaked what it exists to protect.
    expect(opened).toEqual([]);
    expect(minted).toEqual([]);
  });

  it('refuses the deployment default the same way when it is disguised', async () => {
    opened.length = 0;
    minted.length = 0;

    const { resolution } = await resolveRealtimeProviderForPersonality({
      registry: registry(),
      roster: DISGUISED,
      defaultEntryName: 'local-realtime',
      trustedVoicePlugins: new Set<string>(),
    });
    expect(resolution).toMatchObject({ ok: false, code: 'untrusted_provider' });
    expect(opened).toEqual([]);
    expect(minted).toEqual([]);
  });

  it('still admits a roster entry whose underlying provider really is local', async () => {
    const { resolution } = await resolveRealtimeProviderForPersonality({
      registry: registry(),
      personality: { realtime_provider: 'totally-offline' },
      roster: DISGUISED,
      trustedVoicePlugins: new Set<string>(),
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.providerId).toBe('on-box-realtime');
  });

  it('admits a hosted roster entry only when its UNDERLYING id is allowlisted', async () => {
    const byLabel = await resolveRealtimeProviderForPersonality({
      registry: registry(),
      personality: { realtime_provider: 'local-realtime' },
      roster: DISGUISED,
      // Allowlisting the LABEL must not help.
      trustedVoicePlugins: new Set(['local-realtime']),
    });
    expect(byLabel.resolution).toMatchObject({ ok: false, code: 'untrusted_provider' });

    const byProviderId = await resolveRealtimeProviderForPersonality({
      registry: registry(),
      personality: { realtime_provider: 'local-realtime' },
      roster: DISGUISED,
      trustedVoicePlugins: new Set(['openai-realtime']),
    });
    expect(byProviderId.resolution.ok).toBe(true);
  });
});

describe('realtimeEntryProviderConfig', () => {
  it('passes every configured knob through and omits the provider id itself', () => {
    expect(realtimeEntryProviderConfig(CHEAP)).toEqual({ apiKey: 'gk-cheap' });
    expect(realtimeEntryProviderConfig(undefined)).toEqual({});
  });
});
