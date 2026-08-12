// The built-in voice provider roster — ONE list.
//
// `build-infrastructure` populates the live registries from here, and
// diagnostics (`ethos doctor`) build a throwaway pair from the same function,
// so "which providers exist" can never disagree between the running system and
// the thing that reports on it.

import {
  DefaultRealtimeVoiceProviderRegistry,
  DefaultSttProviderRegistry,
  DefaultTtsProviderRegistry,
} from '@ethosagent/core';
import type {
  RealtimeVoiceProviderRegistry,
  SttProviderRegistry,
  TtsProviderRegistry,
} from '@ethosagent/types';
import {
  commandSttFactory,
  commandTtsFactory,
  groqSttFactory,
  localSttFactory,
  localTtsFactory,
  openaiSttFactory,
  openaiTtsFactory,
  registerBuiltInRealtimeProviders,
} from '@ethosagent/voice-providers';

/**
 * Fresh registries holding every first-party voice provider. Plugins register
 * additional ones on the live instances via `registerSttProvider` /
 * `registerTtsProvider`.
 *
 * `command-stt` / `command-tts` are the recipe path — whisper.cpp, Piper,
 * macOS `say` — behind an operator-supplied command template. Both advertise
 * `caps.local`, so they pass the `trustedVoicePlugins` egress gate without an
 * allowlist entry.
 */
export function createBuiltinVoiceRegistries(): {
  sttProviders: SttProviderRegistry;
  ttsProviders: TtsProviderRegistry;
  realtimeProviders: RealtimeVoiceProviderRegistry;
} {
  const sttProviders = new DefaultSttProviderRegistry();
  sttProviders.register('openai-stt', openaiSttFactory);
  sttProviders.register('groq-stt', groqSttFactory);
  sttProviders.register('local-stt', localSttFactory);
  sttProviders.register('command-stt', commandSttFactory);

  const ttsProviders = new DefaultTtsProviderRegistry();
  ttsProviders.register('openai-tts', openaiTtsFactory);
  ttsProviders.register('local-tts', localTtsFactory);
  ttsProviders.register('command-tts', commandTtsFactory);

  // Hosted speech-to-speech. A third KIND rather than a variation on the other
  // two: one duplex session owns the audio in both directions. Neither built-in
  // is `caps.local`, so both must be named in `voice.trustedPlugins` on a
  // deployment that armed the local-only egress gate.
  const realtimeProviders = new DefaultRealtimeVoiceProviderRegistry();
  registerBuiltInRealtimeProviders(realtimeProviders);

  return { sttProviders, ttsProviders, realtimeProviders };
}
