// The local-only voice-egress gate, enforced at the gateway.
//
// The gate existed in the gateway before this suite, but no production caller
// ever passed `trustedVoicePlugins`, so it was decorative. These tests drive
// the constructed Gateway through the SHARED resolution path in
// `@ethosagent/core` and assert what actually happens to a non-local provider.

import type { AgentLoop } from '@ethosagent/core';
import { DefaultSttProviderRegistry, DefaultTtsProviderRegistry } from '@ethosagent/core';
import type { SttProvider, TtsProvider } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';

function stt(name: string, local: boolean): SttProvider {
  return {
    name,
    caps: { kind: 'stt', formats: ['wav'], local, contractVersion: 1 },
    transcribe: async () => 'transcript',
  };
}

function tts(name: string, local: boolean): TtsProvider {
  return {
    name,
    caps: { kind: 'tts', formats: ['wav'], local, contractVersion: 1 },
    synthesize: async () => ({ audio: new Uint8Array([1]), format: 'wav' as const }),
  };
}

function stubLoop() {
  return {
    run: vi.fn(async function* () {
      yield { type: 'done' as const, text: '', turnCount: 1 };
    }),
    hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
  } as unknown as AgentLoop;
}

function registries() {
  const sttRegistry = new DefaultSttProviderRegistry();
  sttRegistry.register('local-stt', () => stt('local-stt', true));
  sttRegistry.register('cloud-stt', () => stt('cloud-stt', false));
  const ttsRegistry = new DefaultTtsProviderRegistry();
  ttsRegistry.register('local-tts', () => tts('local-tts', true));
  ttsRegistry.register('cloud-tts', () => tts('cloud-tts', false));
  return { sttRegistry, ttsRegistry };
}

function gateway(opts: {
  sttProviderName: string;
  ttsProviderName: string;
  trustedVoicePlugins?: ReadonlySet<string>;
}): Gateway {
  const { sttRegistry, ttsRegistry } = registries();
  return new Gateway({
    loop: stubLoop(),
    sttProviderRegistry: sttRegistry,
    sttProviderName: opts.sttProviderName,
    ttsProviderRegistry: ttsRegistry,
    ttsProviderName: opts.ttsProviderName,
    ...(opts.trustedVoicePlugins ? { trustedVoicePlugins: opts.trustedVoicePlugins } : {}),
  });
}

describe('gateway voice egress gate', () => {
  it('with only local providers trusted, a non-local selection is refused with a clear reason', async () => {
    const gw = gateway({
      sttProviderName: 'cloud-stt',
      ttsProviderName: 'cloud-tts',
      trustedVoicePlugins: new Set(),
    });

    const resolved = await gw.voiceProviderStatus();

    expect(resolved.stt).toBeUndefined();
    expect(resolved.sttError).toContain('refusing to send audio off this machine');
    expect(resolved.sttError).toContain('cloud-stt');
  });

  it('lets a local provider through even with an empty allowlist', async () => {
    const gw = gateway({
      sttProviderName: 'local-stt',
      ttsProviderName: 'local-tts',
      trustedVoicePlugins: new Set(),
    });

    const resolved = await gw.voiceProviderStatus();

    expect(resolved.stt).toBe('local-stt');
    expect(resolved.sttError).toBeUndefined();
  });

  it('lets an explicitly trusted non-local provider through', async () => {
    const gw = gateway({
      sttProviderName: 'cloud-stt',
      ttsProviderName: 'cloud-tts',
      trustedVoicePlugins: new Set(['cloud-stt', 'cloud-tts']),
    });

    const resolved = await gw.voiceProviderStatus();

    expect(resolved.stt).toBe('cloud-stt');
  });

  it('leaves the gate off — and the cloud provider usable — when no allowlist is passed', async () => {
    const gw = gateway({ sttProviderName: 'cloud-stt', ttsProviderName: 'cloud-tts' });

    const resolved = await gw.voiceProviderStatus();

    expect(resolved.stt).toBe('cloud-stt');
    expect(resolved.sttError).toBeUndefined();
  });

  it('reports an unknown provider instead of silently having no voice', async () => {
    const gw = gateway({ sttProviderName: 'nope-stt', ttsProviderName: 'local-tts' });

    const resolved = await gw.voiceProviderStatus();

    expect(resolved.stt).toBeUndefined();
    expect(resolved.sttError).toContain('not registered');
  });
});
