import type {
  RealtimeVoiceProviderFactory,
  RealtimeVoiceProviderRegistry,
} from '@ethosagent/types';

/**
 * The exact structural mirror of `DefaultSttProviderRegistry` /
 * `DefaultTtsProviderRegistry`, including the duplicate-registration throw — a
 * second registration under a live name is a wiring mistake, and silently
 * overwriting it makes the wrong provider own the microphone.
 */
export class DefaultRealtimeVoiceProviderRegistry implements RealtimeVoiceProviderRegistry {
  private readonly factories = new Map<string, RealtimeVoiceProviderFactory>();

  register(name: string, factory: RealtimeVoiceProviderFactory): void {
    if (this.factories.has(name)) {
      throw new Error(`Realtime voice provider "${name}" is already registered`);
    }
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
