import type { RealtimeVoiceProvider, RealtimeVoiceProviderFactory } from '@ethosagent/types';
import { REALTIME_CONTRACT_VERSION } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { DefaultRealtimeVoiceProviderRegistry } from '../providers/realtime-registry';

// The registry class only. Which providers SHIP is a statement about
// `extensions/voice-providers`, and is tested there.

function stubFactory(name: string): RealtimeVoiceProviderFactory {
  return (): RealtimeVoiceProvider => ({
    name,
    caps: {
      kind: 'realtime',
      inputSampleRate: 16_000,
      outputSampleRate: 24_000,
      contractVersion: REALTIME_CONTRACT_VERSION,
    },
    open: () => Promise.reject(new Error('stub')),
  });
}

describe('DefaultRealtimeVoiceProviderRegistry', () => {
  it('registers and resolves a factory by name', () => {
    const registry = new DefaultRealtimeVoiceProviderRegistry();
    registry.register('a', stubFactory('a'));
    expect(registry.get('a')).toBeDefined();
    expect(registry.list()).toEqual(['a']);
  });

  it('refuses to overwrite a live registration', () => {
    // Silently overwriting would put a DIFFERENT provider on the microphone
    // than the one the operator configured — the same reason the STT and TTS
    // registries throw here.
    const registry = new DefaultRealtimeVoiceProviderRegistry();
    registry.register('a', stubFactory('a'));
    expect(() => registry.register('a', stubFactory('other'))).toThrow(/already registered/);
  });

  it('unregister frees the name again', () => {
    const registry = new DefaultRealtimeVoiceProviderRegistry();
    registry.register('a', stubFactory('a'));
    registry.register('b', stubFactory('b'));
    registry.unregister('a');
    expect(registry.get('a')).toBeUndefined();
    expect(registry.list()).toEqual(['b']);
  });

  it('returns undefined for a name nobody registered', () => {
    expect(new DefaultRealtimeVoiceProviderRegistry().get('nope')).toBeUndefined();
  });
});
