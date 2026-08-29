// The named STT roster: `voice.stt.providers.<name>.*` in config, picked per
// personality by `voice.stt_provider`. The mirror of
// voice-roster-resolution.test.ts, case for case.
//
// The property that matters most here is the security one, and it matters MORE
// than on the TTS side: TTS ships text off the machine, STT ships the captured
// microphone audio. A roster key is a LABEL the operator typed; the local-only
// egress gate keys on the underlying registered provider id and the caps of the
// provider that was actually constructed. If the gate ever keyed on the label,
// naming a cloud transcriber `local-whisper` would walk raw voice straight
// through a local-only deployment.

import type { SttProvider, SttProviderEntry } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { DefaultSttProviderRegistry } from '../providers/stt-registry';
import {
  resolveSttProviderForPersonality,
  selectSttEntry,
  sttEntryProviderConfig,
} from '../providers/voice-resolution';

/** Records the factory config it was constructed with and every transcribe call. */
interface SpyStt extends SttProvider {
  readonly config: Record<string, unknown>;
  readonly heard: Array<{ bytes: number; language: string | undefined }>;
}

function spyStt(name: string, local: boolean, config: Record<string, unknown>): SpyStt {
  const heard: Array<{ bytes: number; language: string | undefined }> = [];
  return {
    name,
    caps: { kind: 'stt', formats: ['wav'], local, contractVersion: 2 },
    config,
    heard,
    transcribeBuffer: async (audio, opts) => {
      heard.push({ bytes: audio.data.length, language: opts?.language });
      return 'transcript';
    },
  };
}

function registry(): DefaultSttProviderRegistry {
  const reg = new DefaultSttProviderRegistry();
  reg.register('command-stt', (ctx) => spyStt('command-stt', true, ctx.config));
  reg.register('openai-stt', (ctx) => spyStt('openai-stt', false, ctx.config));
  reg.register('local-stt', (ctx) => spyStt('local-stt', true, ctx.config));
  return reg;
}

const WHISPER_CLI: SttProviderEntry = {
  provider: 'command-stt',
  command: 'whisper-cli -f {input_path} -o {output_path}',
  timeout: 45,
};
const SPANISH: SttProviderEntry = {
  provider: 'openai-stt',
  apiKey: 'sk-spanish',
  model: 'whisper-1',
};
const ROSTER: Record<string, SttProviderEntry> = {
  'whisper-cli': WHISPER_CLI,
  spanish: SPANISH,
};

/** `auxiliary.asr` — the default entry, as every surface holds it. */
const DEFAULT_NAME = 'local-stt';
const DEFAULT_CONFIG = { baseUrl: 'http://localhost:8000/v1', model: 'faster-whisper' };

describe('selectSttEntry', () => {
  it('picks the roster entry a personality names', () => {
    const selection = selectSttEntry({ requestedName: 'spanish', roster: ROSTER });
    expect(selection).toMatchObject({ entryName: 'spanish', reason: 'roster' });
    expect(selection.entry).toBe(SPANISH);
  });

  it('falls back to the default entry when no name is given', () => {
    expect(selectSttEntry({ roster: ROSTER })).toEqual({
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
    const selection = selectSttEntry({
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
    // The log names the STT default, not the TTS one — a mixed-up message here
    // would send an operator to the wrong config key.
    expect(warn.mock.calls[0]?.[0]).toContain('auxiliary.asr');
  });

  it('treats a whitespace-only name as no name at all', () => {
    expect(selectSttEntry({ requestedName: '   ', roster: ROSTER }).reason).toBe('default');
  });
});

describe('resolveSttProviderForPersonality', () => {
  it('constructs the named entry with that entry’s own knobs — not the default’s', async () => {
    const { resolution, selection } = await resolveSttProviderForPersonality({
      registry: registry(),
      personality: { stt_provider: 'spanish' },
      roster: ROSTER,
      defaultProviderName: DEFAULT_NAME,
      defaultProviderConfig: DEFAULT_CONFIG,
    });

    expect(selection).toMatchObject({ entryName: 'spanish', reason: 'roster' });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    // The provider id that ran is the entry's UNDERLYING provider, not its label.
    expect(resolution.providerId).toBe('openai-stt');
    expect((resolution.provider as SpyStt).config).toEqual({
      apiKey: 'sk-spanish',
      model: 'whisper-1',
    });
    // Nothing from the default entry leaked in.
    expect((resolution.provider as SpyStt).config.baseUrl).toBeUndefined();
  });

  it('uses the default auxiliary.asr entry when the personality names no provider', async () => {
    const { resolution, selection } = await resolveSttProviderForPersonality({
      registry: registry(),
      personality: { tts_voice: 'af_sky' },
      roster: ROSTER,
      defaultProviderName: DEFAULT_NAME,
      defaultProviderConfig: DEFAULT_CONFIG,
    });

    expect(selection.reason).toBe('default');
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.providerId).toBe('local-stt');
    expect((resolution.provider as SpyStt).config).toEqual(DEFAULT_CONFIG);
  });

  it('does not confuse the TTS choice for the STT one', async () => {
    // A personality that picks a TTS entry and says nothing about its ear must
    // be heard by the DEFAULT transcriber, not by an STT entry of the same name.
    const { resolution, selection } = await resolveSttProviderForPersonality({
      registry: registry(),
      personality: { tts_provider: 'spanish' },
      roster: ROSTER,
      defaultProviderName: DEFAULT_NAME,
      defaultProviderConfig: DEFAULT_CONFIG,
    });
    expect(selection.reason).toBe('default');
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.providerId).toBe('local-stt');
  });

  it('falls back to the default entry — never an error — when the name is unknown here', async () => {
    const { resolution, selection } = await resolveSttProviderForPersonality({
      registry: registry(),
      // A personality shared from a machine that has a `deepgram` entry.
      personality: { stt_provider: 'deepgram' },
      roster: ROSTER,
      defaultProviderName: DEFAULT_NAME,
      defaultProviderConfig: DEFAULT_CONFIG,
    });

    expect(selection).toMatchObject({ reason: 'unknown_name', requestedName: 'deepgram' });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.providerId).toBe('local-stt');
  });

  it('reports not_configured when neither the roster nor a default entry answers', async () => {
    const { resolution } = await resolveSttProviderForPersonality({
      registry: registry(),
      personality: { stt_provider: 'spanish' },
    });
    expect(resolution).toMatchObject({ ok: false, code: 'not_configured' });
  });
});

describe('STT egress gate keys on the resolved provider, never on the roster label', () => {
  // The adversarial case: an operator (or a shared personality) names a CLOUD
  // transcriber something local-sounding, on a deployment whose gate is armed
  // local-only. If the gate tested the label, this would ship captured audio
  // off the machine.
  const DISGUISED: Record<string, SttProviderEntry> = {
    'local-whisper': { provider: 'openai-stt', apiKey: 'sk-exfil' },
    'totally-offline': { provider: 'command-stt', command: 'whisper-cli -f {input_path}' },
  };

  it('refuses a roster entry named "local-whisper" that is backed by a non-local provider', async () => {
    const { resolution, selection } = await resolveSttProviderForPersonality({
      registry: registry(),
      personality: { stt_provider: 'local-whisper' },
      roster: DISGUISED,
      // Gate armed, allowlist empty: only `caps.local` providers may listen.
      trustedVoicePlugins: new Set<string>(),
    });

    expect(selection.entryName).toBe('local-whisper');
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.code).toBe('untrusted_provider');
    // The refusal names the provider that was actually about to run.
    expect(resolution.providerId).toBe('openai-stt');
    expect(resolution.error).toContain('openai-stt');
    expect(resolution.error).not.toContain('local-whisper');
  });

  it('still admits a roster entry whose underlying provider really is local', async () => {
    const { resolution } = await resolveSttProviderForPersonality({
      registry: registry(),
      personality: { stt_provider: 'totally-offline' },
      roster: DISGUISED,
      trustedVoicePlugins: new Set<string>(),
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.providerId).toBe('command-stt');
  });

  it('admits a non-local roster entry only when its UNDERLYING id is allowlisted', async () => {
    const byLabel = await resolveSttProviderForPersonality({
      registry: registry(),
      personality: { stt_provider: 'local-whisper' },
      roster: DISGUISED,
      // Allowlisting the LABEL must not help.
      trustedVoicePlugins: new Set(['local-whisper']),
    });
    expect(byLabel.resolution).toMatchObject({ ok: false, code: 'untrusted_provider' });

    const byProviderId = await resolveSttProviderForPersonality({
      registry: registry(),
      personality: { stt_provider: 'local-whisper' },
      roster: DISGUISED,
      trustedVoicePlugins: new Set(['openai-stt']),
    });
    expect(byProviderId.resolution.ok).toBe(true);
  });
});

describe('sttEntryProviderConfig', () => {
  it('passes every configured knob through and omits the provider id itself', () => {
    expect(sttEntryProviderConfig(WHISPER_CLI)).toEqual({
      command: 'whisper-cli -f {input_path} -o {output_path}',
      timeout: 45,
    });
    expect(sttEntryProviderConfig(undefined)).toEqual({});
  });
});
