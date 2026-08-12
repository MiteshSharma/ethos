// The named TTS roster: `voice.providers.<name>.*` in config, picked per
// personality by `voice.provider`.
//
// The property that matters most here is the security one. A roster key is a
// LABEL the operator typed; the local-only egress gate keys on the underlying
// registered provider id and the caps of the provider that was actually
// constructed. If the gate ever keyed on the label, naming a cloud entry
// `local-kokoro` would walk it straight through a local-only deployment.

import type { TtsProvider, TtsProviderEntry } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { DefaultTtsProviderRegistry } from '../providers/tts-registry';
import {
  resolveTtsProviderForPersonality,
  resolveVoicePreferences,
  selectTtsEntry,
  ttsEntryProviderConfig,
} from '../providers/voice-resolution';

/** Records the factory config it was constructed with and the synthesize args. */
interface SpyTts extends TtsProvider {
  readonly config: Record<string, unknown>;
  readonly spokenWith: Array<{ text: string; voice: string | undefined }>;
}

function spyTts(name: string, local: boolean, config: Record<string, unknown>): SpyTts {
  const spokenWith: Array<{ text: string; voice: string | undefined }> = [];
  return {
    name,
    caps: { kind: 'tts', formats: ['wav'], local, contractVersion: 1 },
    config,
    spokenWith,
    synthesize: async (text, opts) => {
      spokenWith.push({ text, voice: opts?.voice });
      return { audio: new Uint8Array([1]), format: 'wav' as const };
    },
  };
}

function registry(): DefaultTtsProviderRegistry {
  const reg = new DefaultTtsProviderRegistry();
  reg.register('command-tts', (ctx) => spyTts('command-tts', true, ctx.config));
  reg.register('openai-tts', (ctx) => spyTts('openai-tts', false, ctx.config));
  reg.register('kokoro-tts', (ctx) => spyTts('kokoro-tts', true, ctx.config));
  return reg;
}

const MAC_SAY: TtsProviderEntry = {
  provider: 'command-tts',
  command: 'say -o {output_path} -f {input_path}',
  outputFormat: 'wav',
  voice: 'Samantha',
};
const STUDIO: TtsProviderEntry = {
  provider: 'openai-tts',
  apiKey: 'sk-studio',
  model: 'gpt-4o-mini-tts',
  voice: 'alloy',
};
const ROSTER: Record<string, TtsProviderEntry> = { 'mac-say': MAC_SAY, studio: STUDIO };

/** `auxiliary.tts` — the default entry, expressed the way every surface holds it. */
const DEFAULT_NAME = 'kokoro-tts';
const DEFAULT_CONFIG = { baseUrl: 'http://localhost:8880/v1', voice: 'af_bella' };

describe('selectTtsEntry', () => {
  it('picks the roster entry a personality names', () => {
    const selection = selectTtsEntry({ requestedName: 'studio', roster: ROSTER });
    expect(selection).toMatchObject({ entryName: 'studio', reason: 'roster' });
    expect(selection.entry).toBe(STUDIO);
  });

  it('falls back to the default entry when no name is given', () => {
    expect(selectTtsEntry({ roster: ROSTER })).toEqual({
      entry: undefined,
      entryName: undefined,
      reason: 'default',
    });
  });

  it('falls back to the default entry — with a typed reason and a log — on an unknown name', () => {
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
    const selection = selectTtsEntry({
      requestedName: 'a-machine-that-does-not-have-this',
      roster: ROSTER,
      logger,
    });
    expect(selection).toEqual({
      entry: undefined,
      entryName: undefined,
      reason: 'unknown_name',
      requestedName: 'a-machine-that-does-not-have-this',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('a-machine-that-does-not-have-this');
  });

  it('treats a whitespace-only name as no name at all', () => {
    expect(selectTtsEntry({ requestedName: '   ', roster: ROSTER }).reason).toBe('default');
  });
});

describe('resolveTtsProviderForPersonality', () => {
  it('constructs the named entry with that entry’s own knobs — not the default’s', async () => {
    const { resolution, selection } = await resolveTtsProviderForPersonality({
      registry: registry(),
      personality: { provider: 'studio' },
      roster: ROSTER,
      defaultProviderName: DEFAULT_NAME,
      defaultProviderConfig: DEFAULT_CONFIG,
    });

    expect(selection).toMatchObject({ entryName: 'studio', reason: 'roster' });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    // The provider id that ran is the entry's UNDERLYING provider, not its label.
    expect(resolution.providerId).toBe('openai-tts');
    expect((resolution.provider as SpyTts).config).toEqual({
      apiKey: 'sk-studio',
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
    });
    // Nothing from the default entry leaked in.
    expect((resolution.provider as SpyTts).config.baseUrl).toBeUndefined();
  });

  it('uses the default auxiliary.tts entry when the personality names no provider', async () => {
    const { resolution, selection, globalTtsVoice } = await resolveTtsProviderForPersonality({
      registry: registry(),
      personality: { tts_voice: 'af_sky' },
      roster: ROSTER,
      defaultProviderName: DEFAULT_NAME,
      defaultProviderConfig: DEFAULT_CONFIG,
    });

    expect(selection.reason).toBe('default');
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.providerId).toBe('kokoro-tts');
    expect((resolution.provider as SpyTts).config).toEqual(DEFAULT_CONFIG);
    expect(globalTtsVoice).toBe('af_bella');
  });

  it('falls back to the default entry — never an error — when the name is unknown here', async () => {
    const { resolution, selection } = await resolveTtsProviderForPersonality({
      registry: registry(),
      // A personality shared from a machine that has an `elevenlabs` entry.
      personality: { provider: 'elevenlabs' },
      roster: ROSTER,
      defaultProviderName: DEFAULT_NAME,
      defaultProviderConfig: DEFAULT_CONFIG,
    });

    expect(selection).toMatchObject({ reason: 'unknown_name', requestedName: 'elevenlabs' });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.providerId).toBe('kokoro-tts');
  });

  it('reports not_configured when neither the roster nor a default entry answers', async () => {
    const { resolution } = await resolveTtsProviderForPersonality({
      registry: registry(),
      personality: { provider: 'studio' },
    });
    expect(resolution).toMatchObject({ ok: false, code: 'not_configured' });
  });
});

describe('egress gate keys on the resolved provider, never on the roster label', () => {
  // The adversarial case: an operator (or a shared personality) names a CLOUD
  // entry something local-sounding, on a deployment whose gate is armed
  // local-only. If the gate tested the label, this would ship audio off the
  // machine.
  const DISGUISED: Record<string, TtsProviderEntry> = {
    'local-kokoro': { provider: 'openai-tts', apiKey: 'sk-exfil' },
    'totally-offline': { provider: 'command-tts', command: 'say -o {output_path}' },
  };

  it('refuses a roster entry named "local-kokoro" that is backed by a non-local provider', async () => {
    const { resolution, selection } = await resolveTtsProviderForPersonality({
      registry: registry(),
      personality: { provider: 'local-kokoro' },
      roster: DISGUISED,
      // Gate armed, allowlist empty: only `caps.local` providers may speak.
      trustedVoicePlugins: new Set<string>(),
    });

    expect(selection.entryName).toBe('local-kokoro');
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.code).toBe('untrusted_provider');
    // The refusal names the provider that was actually about to run.
    expect(resolution.providerId).toBe('openai-tts');
    expect(resolution.error).toContain('openai-tts');
    expect(resolution.error).not.toContain('local-kokoro');
  });

  it('still admits a roster entry whose underlying provider really is local', async () => {
    const { resolution } = await resolveTtsProviderForPersonality({
      registry: registry(),
      personality: { provider: 'totally-offline' },
      roster: DISGUISED,
      trustedVoicePlugins: new Set<string>(),
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.providerId).toBe('command-tts');
  });

  it('admits a non-local roster entry only when its UNDERLYING id is allowlisted', async () => {
    const byLabel = await resolveTtsProviderForPersonality({
      registry: registry(),
      personality: { provider: 'local-kokoro' },
      roster: DISGUISED,
      // Allowlisting the LABEL must not help.
      trustedVoicePlugins: new Set(['local-kokoro']),
    });
    expect(byLabel.resolution).toMatchObject({ ok: false, code: 'untrusted_provider' });

    const byProviderId = await resolveTtsProviderForPersonality({
      registry: registry(),
      personality: { provider: 'local-kokoro' },
      roster: DISGUISED,
      trustedVoicePlugins: new Set(['openai-tts']),
    });
    expect(byProviderId.resolution.ok).toBe(true);
  });
});

describe('voice precedence within the chosen roster entry', () => {
  async function speak(personality: {
    provider?: string;
    tts_voice?: string;
    languages?: Record<string, string>;
  }): Promise<string | undefined> {
    const { resolution, globalTtsVoice } = await resolveTtsProviderForPersonality({
      registry: registry(),
      personality,
      roster: ROSTER,
      defaultProviderName: DEFAULT_NAME,
      defaultProviderConfig: DEFAULT_CONFIG,
    });
    if (!resolution.ok) throw new Error('expected the provider to resolve');
    const prefs = resolveVoicePreferences({
      personality,
      ...(globalTtsVoice ? { globalTtsVoice } : {}),
      language: 'es',
    });
    await resolution.provider.synthesize('hola', prefs.ttsVoice ? { voice: prefs.ttsVoice } : {});
    return (resolution.provider as SpyTts).spokenWith[0]?.voice;
  }

  it("uses the entry's own voice when the personality declares none", async () => {
    expect(await speak({ provider: 'studio' })).toBe('alloy');
  });

  it("prefers the personality's tts_voice over the entry's voice", async () => {
    expect(await speak({ provider: 'studio', tts_voice: 'nova' })).toBe('nova');
  });

  it('prefers a language-specific voice over both', async () => {
    expect(
      await speak({ provider: 'studio', tts_voice: 'nova', languages: { es: 'shimmer' } }),
    ).toBe('shimmer');
  });

  it("falls back to the DEFAULT entry's voice when no roster entry is chosen", async () => {
    expect(await speak({})).toBe('af_bella');
  });
});

describe('ttsEntryProviderConfig', () => {
  it('passes every configured knob through and omits the provider id itself', () => {
    expect(ttsEntryProviderConfig(MAC_SAY)).toEqual({
      command: 'say -o {output_path} -f {input_path}',
      outputFormat: 'wav',
      voice: 'Samantha',
    });
    expect(ttsEntryProviderConfig(undefined)).toEqual({});
  });
});
