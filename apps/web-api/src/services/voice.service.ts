import { randomBytes } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  SecretsResolver,
  SttProvider,
  SttProviderRegistry,
  TtsProvider,
  TtsProviderRegistry,
} from '@ethosagent/types';
import { isHallucination, truncateAtSentenceBoundary } from '@ethosagent/voice-text';

export class VoiceService {
  private readonly sttRegistry: SttProviderRegistry | undefined;
  private readonly initialProviderName: string | undefined;
  private readonly initialProviderConfig: Record<string, unknown>;
  private readonly secrets: SecretsResolver | undefined;
  private readonly configGetter?: () => Promise<{
    voiceProvider?: string | null;
    voiceApiKey?: string | null;
    voiceBaseUrl?: string | null;
    voiceModel?: string | null;
    voiceTtsProvider?: string | null;
    voiceTtsApiKey?: string | null;
    voiceTtsVoice?: string | null;
    voiceTtsBaseUrl?: string | null;
    voiceTtsModel?: string | null;
  } | null>;
  private provider: SttProvider | null = null;
  private resolvedName: string | undefined;

  private readonly ttsRegistry: TtsProviderRegistry | undefined;
  private readonly initialTtsProviderName: string | undefined;
  private readonly initialTtsProviderConfig: Record<string, unknown>;
  private ttsProvider: TtsProvider | null = null;
  private resolvedTtsName: string | undefined;

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
    configGetter?: () => Promise<{
      voiceProvider?: string | null;
      voiceApiKey?: string | null;
      voiceBaseUrl?: string | null;
      voiceModel?: string | null;
      voiceTtsProvider?: string | null;
      voiceTtsApiKey?: string | null;
      voiceTtsVoice?: string | null;
      voiceTtsBaseUrl?: string | null;
      voiceTtsModel?: string | null;
    } | null>;
    ttsRegistry?: TtsProviderRegistry;
    ttsProviderName?: string;
    ttsProviderConfig?: Record<string, unknown>;
  }) {
    this.sttRegistry = opts.sttRegistry;
    this.initialProviderName = opts.providerName;
    this.initialProviderConfig = opts.providerConfig ?? {};
    this.secrets = opts.secrets;
    this.configGetter = opts.configGetter;
    this.ttsRegistry = opts.ttsRegistry;
    this.initialTtsProviderName = opts.ttsProviderName;
    this.initialTtsProviderConfig = opts.ttsProviderConfig ?? {};
  }

  private async resolve(): Promise<SttProvider | null> {
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

    if (this.resolvedName === name && this.provider) return this.provider;
    if (!this.sttRegistry || !name) return null;

    const factory = this.sttRegistry.get(name);
    if (!factory) return null;
    try {
      const noopSecrets: SecretsResolver = {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
        list: async () => [],
      };
      this.provider = await factory({
        config,
        secrets: this.secrets ?? noopSecrets,
        logger: {
          info() {},
          warn() {},
          error() {},
          debug() {},
          child() {
            return this;
          },
        },
      });
      this.resolvedName = name;
    } catch {
      this.provider = null;
    }
    return this.provider;
  }

  private async resolveTts(): Promise<TtsProvider | null> {
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

    if (this.resolvedTtsName === name && this.ttsProvider) return this.ttsProvider;
    if (!this.ttsRegistry || !name) return null;

    const factory = this.ttsRegistry.get(name);
    if (!factory) return null;
    try {
      const noopSecrets: SecretsResolver = {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
        list: async () => [],
      };
      this.ttsProvider = await factory({
        config,
        secrets: this.secrets ?? noopSecrets,
        logger: {
          info() {},
          warn() {},
          error() {},
          debug() {},
          child() {
            return this;
          },
        },
      });
      this.resolvedTtsName = name;
    } catch {
      this.ttsProvider = null;
    }
    return this.ttsProvider;
  }

  async synthesize(
    text: string,
    voice?: string,
  ): Promise<{ audio: string; format: 'opus' | 'mp3' | 'wav' | 'pcm'; mimeType: string }> {
    const provider = await this.resolveTts();
    if (!provider) throw new Error('No TTS provider configured — set auxiliary.tts in config');

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
    };
  }

  async transcribe(audioBase64: string, mimeType: string): Promise<string> {
    const provider = await this.resolve();
    if (!provider) {
      throw new Error('No STT provider configured — set auxiliary.asr in config');
    }

    const buf = Buffer.from(audioBase64, 'base64');
    const ext = mimeType.includes('webm') ? '.webm' : mimeType.includes('ogg') ? '.ogg' : '.wav';
    const tempPath = join(tmpdir(), `ethos-web-stt-${randomBytes(8).toString('hex')}${ext}`);

    try {
      await writeFile(tempPath, buf);
      const raw = await provider.transcribe(tempPath);
      if (isHallucination(raw)) {
        throw new Error('Could not transcribe audio — try again');
      }
      const trimmed = raw.trim();
      if (!trimmed) {
        throw new Error('Could not transcribe audio — try again');
      }
      return trimmed;
    } finally {
      await unlink(tempPath).catch(() => {});
    }
  }
}
