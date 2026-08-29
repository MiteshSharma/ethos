import type {
  StreamingTtsProvider,
  VoiceCapabilities,
  VoiceProviderFactoryContext,
} from '@ethosagent/types';
import { streamOpenAiCompat, synthesizeOpenAiCompat } from './openai-compat';

// Local TTS over an OpenAI-compatible endpoint (e.g. kokoro-fastapi). API key is
// OPTIONAL — local servers usually need none. `voice` is a free-form, server-
// specific id (Kokoro: `af_bella`, `am_adam`, …) passed straight through, so no
// fixed voice list is enforced (`caps.voices` is omitted).
export class LocalTtsProvider implements StreamingTtsProvider {
  readonly name = 'local-tts';
  readonly caps: VoiceCapabilities;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly defaultVoice: string;

  constructor(opts: { apiKey?: string; model?: string; baseUrl?: string; voice?: string } = {}) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'kokoro';
    this.baseUrl = opts.baseUrl ?? 'http://localhost:8880/v1';
    this.defaultVoice = opts.voice ?? 'af_bella';
    this.caps = {
      kind: 'tts',
      formats: ['opus'],
      local: true,
      streaming: true,
      contractVersion: 1,
    };
  }

  async synthesize(
    text: string,
    opts?: { voice?: string; speed?: number; signal?: AbortSignal },
  ): Promise<{ audio: Uint8Array; format: 'opus' }> {
    const voice = opts?.voice ?? this.defaultVoice;
    const speed = opts?.speed ?? 1.0;

    return synthesizeOpenAiCompat({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      model: this.model,
      voice,
      input: text,
      speed,
      label: 'Local TTS',
      signal: opts?.signal,
    });
  }

  /**
   * Streaming synthesis over the same OpenAI-compatible route. kokoro-fastapi
   * streams `/v1/audio/speech` as chunked transfer, so playout starts on the
   * first chunk rather than on the completed sentence. One request per piece,
   * sequential, so audio stays in text order.
   */
  async *synthesizeStream(
    text: AsyncIterable<string>,
    opts?: { voice?: string; speed?: number; signal?: AbortSignal },
  ): AsyncIterable<{ audio: Uint8Array; format: 'opus' }> {
    for await (const piece of text) {
      if (piece.trim().length === 0) continue;
      yield* streamOpenAiCompat({
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
        model: this.model,
        voice: opts?.voice ?? this.defaultVoice,
        input: piece,
        speed: opts?.speed ?? 1.0,
        label: 'Local TTS',
        signal: opts?.signal,
      });
    }
  }
}

export function localTtsFactory(ctx: VoiceProviderFactoryContext): LocalTtsProvider {
  return new LocalTtsProvider({
    apiKey: ctx.config.apiKey as string | undefined,
    model: ctx.config.model as string | undefined,
    baseUrl: ctx.config.baseUrl as string | undefined,
    voice: ctx.config.voice as string | undefined,
  });
}
