import type {
  RealtimeVoiceProviderFactory,
  RealtimeVoiceProviderRegistry,
} from '@ethosagent/types';
import { geminiLiveFactory } from './realtime-gemini';
import { openaiRealtimeFactory } from './realtime-openai';

/**
 * The exact structural mirror of `DefaultSttProviderRegistry` /
 * `DefaultTtsProviderRegistry` (`packages/core/src/providers/`), including the
 * duplicate-registration throw — a second registration under a live name is a
 * wiring mistake, and silently overwriting it makes the wrong provider handle
 * the microphone.
 *
 * It lives HERE rather than beside its two siblings only because this task's
 * file scope stops at `extensions/voice-providers/`. Moving it to
 * `packages/core/src/providers/realtime-registry.ts` is a pure relocation and
 * belongs in the wiring task that consumes it.
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

/**
 * The realtime providers that ship in this repo, keyed by the id an operator
 * writes in `voice.realtime.providers.<label>.provider`.
 */
export const BUILT_IN_REALTIME_PROVIDERS: Record<string, RealtimeVoiceProviderFactory> = {
  'openai-realtime': openaiRealtimeFactory,
  'gemini-live': geminiLiveFactory,
};

/** Register every built-in on `registry`. Wiring calls this once at startup. */
export function registerBuiltInRealtimeProviders(registry: RealtimeVoiceProviderRegistry): void {
  for (const [name, factory] of Object.entries(BUILT_IN_REALTIME_PROVIDERS)) {
    registry.register(name, factory);
  }
}
