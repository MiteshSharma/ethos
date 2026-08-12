import {
  resolveSttProvider,
  resolveTtsProvider,
  resolveTtsProviderForPersonality,
  resolveVoicePreferences,
  selectTtsEntry,
  ttsEntryProviderConfig,
  type VoiceResolution,
} from '@ethosagent/core';
import {
  isStreamingTtsProvider,
  type PersonalityVoiceConfig,
  type SecretsResolver,
  type SttProvider,
  type SttProviderRegistry,
  type TtsProvider,
  type TtsProviderEntry,
  type TtsProviderRegistry,
} from '@ethosagent/types';
import { isHallucination, truncateAtSentenceBoundary } from '@ethosagent/voice-text';

/**
 * Just enough of a personality registry to answer "how does this one sound".
 * Structural so the service does not depend on the concrete registry class —
 * and so a test can hand it a literal.
 */
export interface VoicePersonalityLookup {
  get(id: string): { voice?: PersonalityVoiceConfig } | undefined;
}

/** Per-call voice selection inputs. See {@link VoiceService.synthesize}. */
export interface SynthesisVoiceOptions {
  /** Global default the caller read from config — lowest precedence. */
  voice?: string;
  /** Personality speaking; its `voice` block beats `voice` above. */
  personalityId?: string;
  /** BCP-47 tag, selecting from the personality's language→voice map. */
  language?: string;
  /**
   * Audition an unsaved selection. `provider` names a roster entry and `voice`
   * the voice id; together they stand IN PLACE OF the personality's own `voice`
   * block, so the personality editor can preview a choice that is not on disk.
   *
   * It is not a privileged path: `provider` is a roster label like any other,
   * an unknown one falls back to the default entry, and the egress gate still
   * keys on the provider that actually gets constructed.
   */
  override?: { provider?: string; voice?: string };
}

/** One selectable TTS entry and the voice ids it advertises. */
export interface TtsEntryInfo {
  /** Registered provider id the entry names. Null = nothing configured. */
  providerId: string | null;
  /** `caps.voices`. Null = the provider takes open-ended voice ids. */
  voices: string[] | null;
}

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
  /** `voice.providers.*` as stored, with API keys already resolved. */
  voiceProviders?: Readonly<Record<string, TtsProviderEntry>> | null;
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
  /**
   * Named TTS roster (`voice.providers.*`). A personality's `voice.provider`
   * picks from it; everything else uses the default entry below. Absent → this
   * surface behaves exactly as it did before rosters existed.
   */
  private readonly ttsRoster: Readonly<Record<string, TtsProviderEntry>> | undefined;
  /** Cache key is the ENTRY that served — `''` for the default entry. */
  private ttsProvider: TtsProvider | null = null;
  private resolvedTtsName: string | undefined;
  private resolvedTtsEntryKey = '';

  /**
   * Local-only voice-egress allowlist. Undefined → gate off. Threaded into the
   * SHARED resolution path so the browser talk lane enforces exactly the same
   * rule as the gateway and the wiring-built VoiceSession stack.
   */
  private readonly trustedVoicePlugins: ReadonlySet<string> | undefined;

  /**
   * Personality lookup for per-personality voice. Optional: absent → every
   * reply speaks in the global `auxiliary.tts.voice`, which is what this
   * surface did before personalities could declare a voice.
   */
  private readonly personalities: VoicePersonalityLookup | undefined;

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
    ttsRoster?: Readonly<Record<string, TtsProviderEntry>>;
    trustedVoicePlugins?: ReadonlySet<string>;
    personalities?: VoicePersonalityLookup;
  }) {
    this.sttRegistry = opts.sttRegistry;
    this.initialProviderName = opts.providerName;
    this.initialProviderConfig = opts.providerConfig ?? {};
    this.secrets = opts.secrets;
    this.configGetter = opts.configGetter;
    this.ttsRegistry = opts.ttsRegistry;
    this.initialTtsProviderName = opts.ttsProviderName;
    this.initialTtsProviderConfig = opts.ttsProviderConfig ?? {};
    this.ttsRoster = opts.ttsRoster;
    this.trustedVoicePlugins = opts.trustedVoicePlugins;
    this.personalities = opts.personalities;
  }

  /**
   * The `voice` block this reply is spoken with.
   *
   * An `override` is expressed AS a voice block rather than as a second
   * resolution path, so a previewed selection travels the same precedence and
   * the same egress gate as a stored one — there is one way to pick a voice.
   */
  private personalityVoice(
    opts: SynthesisVoiceOptions | undefined,
  ): PersonalityVoiceConfig | undefined {
    const override = opts?.override;
    if (override?.provider || override?.voice) {
      return {
        ...(override.provider ? { provider: override.provider } : {}),
        ...(override.voice ? { tts_voice: override.voice } : {}),
      };
    }
    return opts?.personalityId ? this.personalities?.get(opts.personalityId)?.voice : undefined;
  }

  /**
   * The voice this reply should be spoken in.
   *
   * Precedence lives in ONE function for the whole repo
   * (`resolveVoicePreferences`, `@ethosagent/core`): language-specific voice >
   * personality voice > global config, evaluated WITHIN the provider that was
   * chosen. The global rung is the chosen roster entry's own `voice` when a
   * roster entry served, and otherwise what the browser read out of Settings —
   * so a personality that declares its own voice is heard over it rather than
   * being silently overridden by the default the client happened to send.
   */
  private voiceFor(
    opts: SynthesisVoiceOptions | undefined,
    globalTtsVoice: string | undefined,
  ): string | undefined {
    const personality = this.personalityVoice(opts);
    return resolveVoicePreferences({
      ...(personality ? { personality } : {}),
      ...(globalTtsVoice ? { globalTtsVoice } : {}),
      ...(opts?.language ? { language: opts.language } : {}),
    }).ttsVoice;
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

  /**
   * Resolve the TTS provider for this reply.
   *
   * Roster-aware: the speaking personality's `voice.provider` picks an entry
   * from `voice.providers.*`; no name, or a name this deployment does not
   * have, falls back to the default `auxiliary.tts` entry the constructor (or
   * live Settings) supplied. The chosen entry's voice comes back as
   * `globalTtsVoice` so the voice precedence is evaluated within it.
   */
  private async resolveTts(
    personality?: PersonalityVoiceConfig,
    clientVoice?: string,
  ): Promise<{
    resolution: VoiceResolution<TtsProvider>;
    globalTtsVoice: string | undefined;
  }> {
    const { name, config, roster } = await this.ttsDefaults();

    // Pure decision — it names the entry and the voice rung, and keys the
    // memo. `resolveTtsProviderForPersonality` below stays the authority on
    // which provider id is actually constructed and gated.
    const selection = selectTtsEntry({
      ...(personality?.provider ? { requestedName: personality.provider } : {}),
      ...(roster ? { roster } : {}),
    });
    // Lowest voice rung, evaluated within the chosen provider. On a roster
    // entry that is the entry's own voice and nothing else — the Settings
    // default belongs to `auxiliary.tts`, and its voice ids need not exist on
    // a different provider.
    const defaultVoice = typeof config.voice === 'string' ? config.voice : undefined;
    const globalTtsVoice = selection.entry ? selection.entry.voice : (clientVoice ?? defaultVoice);

    // The memo holds ONE provider — the last entry that spoke. It stays valid
    // while the same entry serves, and the key carries the entry's FIELDS, not
    // just its name: the roster is editable from Settings, so `studio` after an
    // edit is a different provider than `studio` before it.
    const entryKey = `${selection.entryName ?? ''} ${JSON.stringify(selection.entry ?? null)}`;
    const cachedId = this.resolvedTtsName;
    if (
      this.ttsProvider &&
      cachedId !== undefined &&
      entryKey === this.resolvedTtsEntryKey &&
      (selection.entry !== undefined || cachedId === name)
    ) {
      return {
        resolution: { ok: true, provider: this.ttsProvider, providerId: cachedId },
        globalTtsVoice,
      };
    }

    const { resolution } = await resolveTtsProviderForPersonality({
      registry: this.ttsRegistry,
      ...(personality ? { personality } : {}),
      ...(roster ? { roster } : {}),
      ...(name ? { defaultProviderName: name } : {}),
      defaultProviderConfig: config,
      ...(this.secrets ? { secrets: this.secrets } : {}),
      ...(this.trustedVoicePlugins ? { trustedVoicePlugins: this.trustedVoicePlugins } : {}),
    });
    if (resolution.ok) {
      this.ttsProvider = resolution.provider;
      this.resolvedTtsName = resolution.providerId;
      this.resolvedTtsEntryKey = entryKey;
    } else {
      this.ttsProvider = null;
      this.resolvedTtsName = undefined;
      this.resolvedTtsEntryKey = '';
    }
    return { resolution, globalTtsVoice };
  }

  /**
   * The default TTS entry and the roster, boot values overlaid with live config.
   *
   * The default entry keeps the rule it has always had: the constructor's
   * provider wins, and live Settings fill in only when boot supplied none. The
   * ROSTER is the other way round — it is edited from Settings, so a boot
   * snapshot is stale the moment an operator adds an entry, and a roster the
   * getter returns replaces it.
   */
  private async ttsDefaults(): Promise<{
    name: string | undefined;
    config: Record<string, unknown>;
    roster: Readonly<Record<string, TtsProviderEntry>> | undefined;
  }> {
    let name = this.initialTtsProviderName;
    let config: Record<string, unknown> = this.initialTtsProviderConfig;
    const live = this.configGetter ? await this.configGetter().catch(() => null) : null;
    if (!name && live?.voiceTtsProvider) {
      name = live.voiceTtsProvider;
      config = {
        apiKey: live.voiceTtsApiKey ?? undefined,
        voice: live.voiceTtsVoice ?? undefined,
        baseUrl: live.voiceTtsBaseUrl ?? undefined,
        model: live.voiceTtsModel ?? undefined,
      };
    }
    return { name, config, roster: live?.voiceProviders ?? this.ttsRoster };
  }

  /**
   * Every TTS entry a personality can name, and the voice ids each advertises.
   *
   * Providers are CONSTRUCTED (that is the only way to read `caps.voices`) but
   * never asked to synthesize, so this makes no network call and moves no
   * audio. An entry whose provider will not construct — no credential, an
   * unregistered id, refused by the egress gate — reports the id it names with
   * `voices: null`, which reads as "open-ended" at the surface. That is the
   * honest answer: we do not know its voices, so do not offer a list.
   */
  async listTtsEntries(): Promise<{
    default: TtsEntryInfo;
    roster: Record<string, TtsEntryInfo>;
  }> {
    const { name, config, roster } = await this.ttsDefaults();
    const describe = async (
      providerId: string | undefined,
      providerConfig: Record<string, unknown>,
    ): Promise<TtsEntryInfo> => {
      if (!providerId) return { providerId: null, voices: null };
      const resolution = await resolveTtsProvider({
        registry: this.ttsRegistry,
        providerName: providerId,
        providerConfig,
        ...(this.secrets ? { secrets: this.secrets } : {}),
        ...(this.trustedVoicePlugins ? { trustedVoicePlugins: this.trustedVoicePlugins } : {}),
      });
      return {
        providerId,
        voices: resolution.ok ? (resolution.provider.caps.voices ?? null) : null,
      };
    };
    const entries: Record<string, TtsEntryInfo> = {};
    for (const [entryName, entry] of Object.entries(roster ?? {})) {
      entries[entryName] = await describe(entry.provider, ttsEntryProviderConfig(entry));
    }
    return { default: await describe(name, config), roster: entries };
  }

  async synthesize(
    text: string,
    opts?: SynthesisVoiceOptions,
  ): Promise<{
    audio: string;
    format: 'opus' | 'mp3' | 'wav' | 'pcm';
    mimeType: string;
    provider: string;
  }> {
    const { resolution, globalTtsVoice } = await this.resolveTts(
      this.personalityVoice(opts),
      opts?.voice,
    );
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

    const voice = this.voiceFor(opts, globalTtsVoice);
    const result = await provider.synthesize(input, voice ? { voice } : {});
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
    opts?: SynthesisVoiceOptions & { signal?: AbortSignal },
  ): AsyncIterable<{
    audio: Uint8Array;
    format: 'opus' | 'mp3' | 'wav' | 'pcm';
    provider: string;
  }> {
    const { resolution, globalTtsVoice } = await this.resolveTts(
      this.personalityVoice(opts),
      opts?.voice,
    );
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
    const voice = this.voiceFor(opts, globalTtsVoice);
    const synthOpts = {
      ...(voice ? { voice } : {}),
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
