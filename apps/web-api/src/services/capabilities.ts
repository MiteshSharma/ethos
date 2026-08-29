import type { ConfigService } from './config.service';
import type { VoiceService } from './voice.service';

// Single source of truth for the capability booleans shared by `rpc/meta.ts`
// (`meta.capabilities`) and `routes/openai/capabilities.ts` (`GET
// /v1/capabilities`). Both surfaces call this — do not fork a second
// computation.

export interface CoreCapabilities {
  [key: string]: boolean;
  byok: boolean;
  voice_stt: boolean;
  voice_tts: boolean;
}

export async function computeCoreCapabilities(opts: {
  voice?: VoiceService;
  config: ConfigService;
}): Promise<CoreCapabilities> {
  let voiceStt = opts.voice?.isConfigured ?? false;
  if (!voiceStt) {
    const cfg = await opts.config.get().catch(() => null);
    if (cfg?.voiceProvider) voiceStt = true;
  }
  let voiceTts = opts.voice?.isTtsConfigured ?? false;
  if (!voiceTts) {
    const cfg = await opts.config.get().catch(() => null);
    if (cfg?.voiceTtsProvider) voiceTts = true;
  }
  return {
    byok: true,
    voice_stt: voiceStt,
    voice_tts: voiceTts,
  };
}
