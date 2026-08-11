import type { SttProvider, TtsProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { DefaultSttProviderRegistry } from '../providers/stt-registry';
import { DefaultTtsProviderRegistry } from '../providers/tts-registry';
import {
  resolveSttProvider,
  resolveTtsProvider,
  unwrapVoiceResolution,
  VoiceProviderError,
} from '../providers/voice-resolution';

function fakeStt(name: string, local: boolean): SttProvider {
  return {
    name,
    caps: { kind: 'stt', formats: ['wav'], local, contractVersion: 1 },
    transcribe: async () => 'hello',
  };
}

function fakeTts(name: string, local: boolean): TtsProvider {
  return {
    name,
    caps: { kind: 'tts', formats: ['wav'], local, contractVersion: 1 },
    synthesize: async () => ({ audio: new Uint8Array([1]), format: 'wav' as const }),
  };
}

function sttRegistry(): DefaultSttProviderRegistry {
  const registry = new DefaultSttProviderRegistry();
  registry.register('local-stt', () => fakeStt('local-stt', true));
  registry.register('cloud-stt', () => fakeStt('cloud-stt', false));
  registry.register('boom-stt', () => {
    throw new Error('no credentials');
  });
  return registry;
}

describe('resolveSttProvider', () => {
  it('resolves a configured provider and reports the provider id that ran', async () => {
    const result = await resolveSttProvider({
      registry: sttRegistry(),
      providerName: 'local-stt',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.providerId).toBe('local-stt');
    expect(result.provider.name).toBe('local-stt');
  });

  it('reports not_configured with no name and with no registry', async () => {
    const noName = await resolveSttProvider({ registry: sttRegistry(), providerName: undefined });
    expect(noName).toMatchObject({ ok: false, code: 'not_configured' });

    const noRegistry = await resolveSttProvider({ registry: undefined, providerName: 'local-stt' });
    expect(noRegistry).toMatchObject({ ok: false, code: 'not_configured' });
  });

  it('reports unknown_provider for a name with no registered factory', async () => {
    const result = await resolveSttProvider({
      registry: sttRegistry(),
      providerName: 'nope-stt',
    });
    expect(result).toMatchObject({ ok: false, code: 'unknown_provider', providerId: 'nope-stt' });
  });

  it('reports init_failed when the factory throws', async () => {
    const result = await resolveSttProvider({
      registry: sttRegistry(),
      providerName: 'boom-stt',
    });
    expect(result).toMatchObject({ ok: false, code: 'init_failed' });
    if (result.ok) return;
    expect(result.error).toContain('no credentials');
  });
});

describe('trustedVoicePlugins egress gate', () => {
  it('is off when trustedVoicePlugins is undefined — a cloud provider resolves', async () => {
    const result = await resolveSttProvider({
      registry: sttRegistry(),
      providerName: 'cloud-stt',
    });
    expect(result.ok).toBe(true);
  });

  it('refuses a non-local STT provider with a clear typed error when trust is local-only', async () => {
    const result = await resolveSttProvider({
      registry: sttRegistry(),
      providerName: 'cloud-stt',
      trustedVoicePlugins: new Set(),
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'untrusted_provider',
      providerId: 'cloud-stt',
    });
    if (result.ok) return;
    expect(result.error).toContain('refusing to send audio off this machine');
  });

  it('lets local providers through even when the allowlist is empty', async () => {
    const result = await resolveSttProvider({
      registry: sttRegistry(),
      providerName: 'local-stt',
      trustedVoicePlugins: new Set(),
    });
    expect(result.ok).toBe(true);
  });

  it('lets an explicitly trusted non-local provider through', async () => {
    const result = await resolveSttProvider({
      registry: sttRegistry(),
      providerName: 'cloud-stt',
      trustedVoicePlugins: new Set(['cloud-stt']),
    });
    expect(result.ok).toBe(true);
  });

  it('applies the same gate to TTS', async () => {
    const registry = new DefaultTtsProviderRegistry();
    registry.register('local-tts', () => fakeTts('local-tts', true));
    registry.register('cloud-tts', () => fakeTts('cloud-tts', false));

    const refused = await resolveTtsProvider({
      registry,
      providerName: 'cloud-tts',
      trustedVoicePlugins: new Set(['local-tts']),
    });
    expect(refused).toMatchObject({ ok: false, code: 'untrusted_provider' });

    const allowed = await resolveTtsProvider({
      registry,
      providerName: 'local-tts',
      trustedVoicePlugins: new Set(['local-tts']),
    });
    expect(allowed.ok).toBe(true);
  });
});

describe('unwrapVoiceResolution', () => {
  it('returns the provider on success', async () => {
    const resolution = await resolveSttProvider({
      registry: sttRegistry(),
      providerName: 'local-stt',
    });
    expect(unwrapVoiceResolution(resolution).providerId).toBe('local-stt');
  });

  it('throws VoiceProviderError carrying the failure code', async () => {
    const resolution = await resolveSttProvider({
      registry: sttRegistry(),
      providerName: 'cloud-stt',
      trustedVoicePlugins: new Set(),
    });
    try {
      unwrapVoiceResolution(resolution);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(VoiceProviderError);
      expect((err as VoiceProviderError).code).toBe('untrusted_provider');
      expect((err as VoiceProviderError).providerId).toBe('cloud-stt');
    }
  });
});
