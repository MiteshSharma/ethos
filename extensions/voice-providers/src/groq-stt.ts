import type {
  SttAudio,
  SttProvider,
  VoiceCapabilities,
  VoiceProviderFactoryContext,
} from '@ethosagent/types';
import { STT_CONTRACT_VERSION } from '@ethosagent/types';
import { transcribeOpenAiCompat } from './openai-compat';

// Groq serves the OpenAI transcription API verbatim at `/openai/v1`, so it
// rides the shared transport rather than hand-rolling a second multipart
// builder (which is how it ended up hard-coding `audio.ogg` for every upload).
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

export class GroqSttProvider implements SttProvider {
  readonly name = 'groq-stt';
  readonly caps: VoiceCapabilities;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(opts: { apiKey: string; model?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'whisper-large-v3';
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
      baseUrl: GROQ_BASE_URL,
      apiKey: this.apiKey,
      model: this.model,
      audio,
      label: 'Groq STT',
      ...(opts?.language ? { language: opts.language } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }
}

export function groqSttFactory(ctx: VoiceProviderFactoryContext): GroqSttProvider {
  const apiKey = ctx.config.apiKey as string;
  if (!apiKey) throw new Error('Groq STT requires apiKey');
  return new GroqSttProvider({
    apiKey,
    model: ctx.config.model as string | undefined,
  });
}
