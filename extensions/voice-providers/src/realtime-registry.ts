import type {
  RealtimeVoiceProviderFactory,
  RealtimeVoiceProviderRegistry,
} from '@ethosagent/types';
import { geminiLiveFactory } from './realtime-gemini';
import { openaiRealtimeFactory } from './realtime-openai';

// The REGISTRY CLASS lives beside its STT/TTS siblings in
// `packages/core/src/providers/realtime-registry.ts`. What lives here is the
// built-in roster — the provider implementations this package ships — because
// that is a statement about this extension, not about the kernel.

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
