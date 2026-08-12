import type {
  SttAudio,
  SttProvider,
  VoiceCapabilities,
  VoiceProviderFactoryContext,
} from '@ethosagent/types';
import { STT_CONTRACT_VERSION } from '@ethosagent/types';
import { transcribeOpenAiCompat } from './openai-compat';

export class OpenAiSttProvider implements SttProvider {
  readonly name: string;
  readonly caps: VoiceCapabilities;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(opts: { name?: string; apiKey: string; model?: string; baseUrl?: string }) {
    this.name = opts.name ?? 'openai-stt';
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'whisper-1';
    this.baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1';
    this.caps = {
      kind: 'stt',
      formats: ['opus', 'mp3', 'wav'],
      local: false,
      contractVersion: STT_CONTRACT_VERSION,
    };
  }

  async transcribeBuffer(
    audio: SttAudio,
    opts?: { language?: string; signal?: AbortSignal },
  ): Promise<string> {
    return transcribeOpenAiCompat({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      model: this.model,
      audio,
      label: 'OpenAI STT',
      ...(opts?.language ? { language: opts.language } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }
}

export function openaiSttFactory(ctx: VoiceProviderFactoryContext): OpenAiSttProvider {
  const apiKey = ctx.config.apiKey as string;
  if (!apiKey) throw new Error('OpenAI STT requires apiKey');
  return new OpenAiSttProvider({
    apiKey,
    model: ctx.config.model as string | undefined,
    baseUrl: ctx.config.baseUrl as string | undefined,
  });
}
