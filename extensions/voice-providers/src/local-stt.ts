import type {
  SttAudio,
  SttProvider,
  VoiceCapabilities,
  VoiceProviderFactoryContext,
} from '@ethosagent/types';
import { STT_CONTRACT_VERSION } from '@ethosagent/types';
import { transcribeOpenAiCompat } from './openai-compat';

// Local STT over an OpenAI-compatible endpoint (e.g. faster-whisper-server /
// Speaches serving Whisper large v3). API key is OPTIONAL — local servers
// usually need none. `model` is free-form and server-specific (e.g.
// `whisper-large-v3` or `Systran/faster-whisper-large-v3`).
export class LocalSttProvider implements SttProvider {
  readonly name = 'local-stt';
  readonly caps: VoiceCapabilities;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(opts: { apiKey?: string; model?: string; baseUrl?: string } = {}) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'whisper-large-v3';
    this.baseUrl = opts.baseUrl ?? 'http://localhost:8000/v1';
    this.caps = {
      kind: 'stt',
      formats: ['opus', 'mp3', 'wav'],
      local: true,
      contractVersion: STT_CONTRACT_VERSION,
    };
  }

  async transcribeBuffer(
    audio: SttAudio,
    opts?: { language?: string; signal?: AbortSignal },
  ): Promise<string> {
    return transcribeOpenAiCompat({
      baseUrl: this.baseUrl,
      ...(this.apiKey ? { apiKey: this.apiKey } : {}),
      model: this.model,
      audio,
      label: 'Local STT',
      ...(opts?.language ? { language: opts.language } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }
}

export function localSttFactory(ctx: VoiceProviderFactoryContext): LocalSttProvider {
  return new LocalSttProvider({
    apiKey: ctx.config.apiKey as string | undefined,
    model: ctx.config.model as string | undefined,
    baseUrl: ctx.config.baseUrl as string | undefined,
  });
}
