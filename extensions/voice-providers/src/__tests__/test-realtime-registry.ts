import type {
  RealtimeVoiceProviderFactory,
  RealtimeVoiceProviderRegistry,
} from '@ethosagent/types';

// A throwaway registry so this extension's tests can register the built-ins
// without depending on the kernel: the registry CLASS lives beside its STT/TTS
// siblings in `packages/core` and is tested there.

export class TestRealtimeRegistry implements RealtimeVoiceProviderRegistry {
  private readonly factories = new Map<string, RealtimeVoiceProviderFactory>();

  register(name: string, factory: RealtimeVoiceProviderFactory): void {
    this.factories.set(name, factory);
  }

  unregister(name: string): void {
    this.factories.delete(name);
  }

  get(name: string): RealtimeVoiceProviderFactory | undefined {
    return this.factories.get(name);
  }

  list(): string[] {
    return [...this.factories.keys()];
  }
}
