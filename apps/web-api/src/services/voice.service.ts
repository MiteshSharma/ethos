import { resolveSttProvider, resolveTtsProvider, type VoiceResolution } from '@ethosagent/core';
import {
  isStreamingTtsProvider,
  type SecretsResolver,
  type SttProvider,
  type SttProviderRegistry,
  type TtsProvider,
  type TtsProviderRegistry,
} from '@ethosagent/types';
import { isHallucination, truncateAtSentenceBoundary } from '@ethosagent/voice-text';

/** Live-config shape the Settings tab persists. */
interface LiveVoiceConfig {
  voiceProvider?: string | null;
  voiceApiKey?: string | null;
  voiceBaseUrl?: string | null;
  voiceModel?: string | null;
  voiceTtsProvider?: string | null;
  voiceTtsApiKey?: string | null;
  voiceTtsVoice?: string | null;
  voiceTtsBaseUrl?: string | null;
  voiceTtsModel?: string | null;
}

export class VoiceService {
  private readonly sttRegistry: SttProviderRegistry | undefined;
  private readonly initialProviderName: string | undefined;
  private readonly initialProviderConfig: Record<string, unknown>;
  private readonly secrets: SecretsResolver | undefined;
  private readonly configGetter?: () => Promise<LiveVoiceConfig | null>;
  private provider: SttProvider | null = null;
  private resolvedName: string | undefined;

  private readonly ttsRegistry: TtsProviderRegistry | undefined;
  private readonly initialTtsProviderName: string | undefined;
  private readonly initialTtsProviderConfig: Record<string, unknown>;
  private ttsProvider: TtsProvider | null = null;
  private resolvedTtsName: string | undefined;

  /**
   * Local-only voice-egress allowlist. Undefined → gate off. Threaded into the
   * SHARED resolution path so the browser talk lane enforces exactly the same
   * rule as the gateway and the wiring-built VoiceSession stack.
   */
  private readonly trustedVoicePlugins: ReadonlySet<string> | undefined;

  get isConfigured(): boolean {
    return Boolean(this.sttRegistry && this.initialProviderName);
  }

  get isTtsConfigured(): boolean {
    return Boolean(this.ttsRegistry && this.initialTtsProviderName);
  }

  constructor(opts: {
    sttRegistry?: SttProviderRegistry;
    providerName?: string;
    providerConfig?: Record<string, unknown>;
    secrets?: SecretsResolver;
    configGetter?: () => Promise<LiveVoiceConfig | null>;
    ttsRegistry?: TtsProviderRegistry;
    ttsProviderName?: string;
    ttsProviderConfig?: Record<string, unknown>;
    trustedVoicePlugins?: ReadonlySet<string>;
  }) {
    this.sttRegistry = opts.sttRegistry;
    this.initialProviderName = opts.providerName;
    this.initialProviderConfig = opts.providerConfig ?? {};
    this.secrets = opts.secrets;
    this.configGetter = opts.configGetter;
    this.ttsRegistry = opts.ttsRegistry;
    this.initialTtsProviderName = opts.ttsProviderName;
    this.initialTtsProviderConfig = opts.ttsProviderConfig ?? {};
    this.trustedVoicePlugins = opts.trustedVoicePlugins;
  }

  private async resolve(): Promise<VoiceResolution<SttProvider>> {
    let name = this.initialProviderName;
    let config: Record<string, unknown> = this.initialProviderConfig;

    if (!name && this.configGetter) {
      const live = await this.configGetter().catch(() => null);
      if (live?.voiceProvider) {
        name = live.voiceProvider;
        config = {
          apiKey: live.voiceApiKey ?? undefined,
          baseUrl: live.voiceBaseUrl ?? undefined,
          model: live.voiceModel ?? undefined,
        };
      }
    }

    const cachedName = this.resolvedName;
    if (cachedName !== undefined && cachedName === name && this.provider) {
      return { ok: true, provider: this.provider, providerId: cachedName };
    }

    const resolution = await resolveSttProvider({
      registry: this.sttRegistry,
      providerName: name,
      providerConfig: config,
      ...(this.secrets ? { secrets: this.secrets } : {}),
      ...(this.trustedVoicePlugins ? { trustedVoicePlugins: this.trustedVoicePlugins } : {}),
    });
    if (resolution.ok) {
      this.provider = resolution.provider;
      this.resolvedName = resolution.providerId;
    } else {
      this.provider = null;
      this.resolvedName = undefined;
    }
    return resolution;
  }

  private async resolveTts(): Promise<VoiceResolution<TtsProvider>> {
    let name = this.initialTtsProviderName;
    let config: Record<string, unknown> = this.initialTtsProviderConfig;

    if (!name && this.configGetter) {
      const live = await this.configGetter().catch(() => null);
      if (live?.voiceTtsProvider) {
        name = live.voiceTtsProvider;
        config = {
          apiKey: live.voiceTtsApiKey ?? undefined,
          voice: live.voiceTtsVoice ?? undefined,
          baseUrl: live.voiceTtsBaseUrl ?? undefined,
          model: live.voiceTtsModel ?? undefined,
        };
      }
    }

    const cachedTtsName = this.resolvedTtsName;
    if (cachedTtsName !== undefined && cachedTtsName === name && this.ttsProvider) {
      return { ok: true, provider: this.ttsProvider, providerId: cachedTtsName };
    }

    const resolution = await resolveTtsProvider({
      registry: this.ttsRegistry,
      providerName: name,
      providerConfig: config,
      ...(this.secrets ? { secrets: this.secrets } : {}),
      ...(this.trustedVoicePlugins ? { trustedVoicePlugins: this.trustedVoicePlugins } : {}),
    });
    if (resolution.ok) {
      this.ttsProvider = resolution.provider;
      this.resolvedTtsName = resolution.providerId;
    } else {
      this.ttsProvider = null;
      this.resolvedTtsName = undefined;
    }
    return resolution;
  }

  async synthesize(
    text: string,
    voice?: string,
  ): Promise<{
    audio: string;
    format: 'opus' | 'mp3' | 'wav' | 'pcm';
    mimeType: string;
    provider: string;
  }> {
    const resolution = await this.resolveTts();
    if (!resolution.ok) {
      throw new Error(
        resolution.code === 'not_configured'
          ? 'No TTS provider configured — set auxiliary.tts in config'
          : resolution.error,
      );
    }
    const provider = resolution.provider;

    const maxChars = provider.caps.maxInputChars;
    const input = maxChars ? truncateAtSentenceBoundary(text, maxChars) : text;

    const result = await provider.synthesize(input, { voice });
    const base64 = Buffer.from(result.audio).toString('base64');
    const formatMimeMap: Record<string, string> = {
      opus: 'audio/ogg;codecs=opus',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      pcm: 'audio/pcm',
    };
    return {
      audio: base64,
      format: result.format,
      mimeType: formatMimeMap[result.format] ?? 'audio/ogg',
      // Which provider ACTUALLY ran, not which one config named.
      provider: resolution.providerId,
    };
  }

  /**
   * Streaming synthesis for the binary WS lane: audio chunks as the provider
   * produces them, so the browser can start playing sentence N while N+1 is
   * still being generated. A provider without `caps.streaming` yields exactly
   * one chunk — same bytes, same order, just no early start.
   */
  async *synthesizeStream(
    text: string,
    opts?: { voice?: string; signal?: AbortSignal },
  ): AsyncIterable<{
    audio: Uint8Array;
    format: 'opus' | 'mp3' | 'wav' | 'pcm';
    provider: string;
  }> {
    const resolution = await this.resolveTts();
    if (!resolution.ok) {
      throw new Error(
        resolution.code === 'not_configured'
          ? 'No TTS provider configured — set auxiliary.tts in config'
          : resolution.error,
      );
    }
    const provider = resolution.provider;
    const providerId = resolution.providerId;
    const maxChars = provider.caps.maxInputChars;
    const input = maxChars ? truncateAtSentenceBoundary(text, maxChars) : text;
    const synthOpts = {
      ...(opts?.voice ? { voice: opts.voice } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    };

    if (isStreamingTtsProvider(provider)) {
      for await (const chunk of provider.synthesizeStream(once(input), synthOpts)) {
        yield { ...chunk, provider: providerId };
      }
      return;
    }
    const single = await provider.synthesize(input, synthOpts);
    yield { ...single, provider: providerId };
  }

  /**
   * Transcribe raw utterance bytes. The WS lane hands PCM-derived WAV straight
   * from memory; the batch RPC decodes base64 first and lands here too, so both
   * surfaces share one hallucination filter and one provider resolution.
   */
  async transcribeBytes(
    data: Uint8Array,
    mimeType: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; provider: string }> {
    const resolution = await this.resolve();
    if (!resolution.ok) {
      throw new Error(
        resolution.code === 'not_configured'
          ? 'No STT provider configured — set auxiliary.asr in config'
          : resolution.error,
      );
    }

    const raw = await resolution.provider.transcribeBuffer(
      { data, mimeType },
      signal ? { signal } : undefined,
    );
    if (isHallucination(raw)) {
      throw new Error('Could not transcribe audio — try again');
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error('Could not transcribe audio — try again');
    }
    return { text: trimmed, provider: resolution.providerId };
  }

  async transcribe(audioBase64: string, mimeType: string): Promise<string> {
    // The browser's utterance goes to the provider as bytes. It used to land
    // in a temp file first, purely so the provider could read it back — a
    // write, a read and a cleanup obligation on captured voice, for a payload
    // that never needed to touch this disk.
    const buf = Buffer.from(audioBase64, 'base64');
    const result = await this.transcribeBytes(
      new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      mimeType,
    );
    return result.text;
  }
}

/** One-shot async iterable — the streaming TTS contract consumes text lazily. */
async function* once(text: string): AsyncIterable<string> {
  yield text;
}
