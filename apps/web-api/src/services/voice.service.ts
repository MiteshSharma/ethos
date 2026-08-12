import {
  resolveRealtimeProviderForPersonality,
  resolveSttProviderForPersonality,
  resolveTtsProvider,
  resolveTtsProviderForPersonality,
  resolveVoicePreferences,
  selectRealtimeEntry,
  selectSttEntry,
  selectTtsEntry,
  ttsEntryProviderConfig,
  type VoiceResolution,
} from '@ethosagent/core';
import {
  isStreamingTtsProvider,
  type PersonalityVoiceConfig,
  type RealtimeProviderEntry,
  type RealtimeToolDefinition,
  type RealtimeVoiceProviderRegistry,
  type SecretsResolver,
  type SttProvider,
  type SttProviderEntry,
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

/** Per-call transcription inputs. See {@link VoiceService.transcribeBytes}. */
export interface TranscriptionVoiceOptions {
  /**
   * Personality listening to this utterance. Its `voice.stt_provider` picks an
   * entry from the STT roster; absent → the default `auxiliary.asr` entry, which
   * is what this surface did before rosters existed.
   */
  personalityId?: string;
  /** BCP-47 tag handed to the provider, when the surface knows it. */
  language?: string;
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

/**
 * One selectable STT entry. No `voices` twin: an ear has no voice ids, and
 * inventing a null field for symmetry would be symmetry for its own sake.
 */
export interface SttEntryInfo {
  /** Registered provider id the entry names. Null = nothing configured. */
  providerId: string | null;
}

/** One selectable REALTIME entry. Same shape and same reasoning as the STT one. */
export interface RealtimeEntryInfo {
  /** Registered provider id the entry names (`openai-realtime`), never the label. */
  providerId: string | null;
}

/**
 * Why the browser is not getting a realtime session. Mirrors the
 * `voice.realtimeToken` contract in `@ethosagent/web-contracts` — kept as a
 * local union rather than an import so the service does not depend on the RPC
 * layer that wraps it.
 */
export type RealtimeRefusalReason =
  | 'pipeline_preferred'
  | 'not_configured'
  | 'unknown_entry'
  | 'untrusted_provider'
  | 'no_browser_token'
  | 'provider_unavailable';

export type RealtimeTokenResult =
  | {
      ok: true;
      providerId: string;
      model: string | null;
      token: string;
      expiresAt: number;
      url: string;
      inputSampleRate: number;
      outputSampleRate: number;
    }
  | { ok: false; reason: RealtimeRefusalReason; message: string; providerId: string | null };

/**
 * How a realtime session is CONFIGURED — the personality's identity and the
 * tools it may call, resolved at mint time.
 *
 * A seam rather than an inline lookup because the two halves live in different
 * layers: the identity is a file under `~/.ethos/personalities/`, and the tool
 * list is generated from the wired tool registry (`deriveRealtimeToolset` in
 * `@ethosagent/tools-voice`). Absent → a session with no instructions and no
 * tools, which is what B4 shipped and what a deployment with no agent wired
 * still gets.
 */
export interface RealtimeSessionSurface {
  describe(personalityId?: string): Promise<{
    instructions: string;
    tools: RealtimeToolDefinition[];
  }>;
}

/** Per-call realtime inputs. See {@link VoiceService.mintRealtimeToken}. */
export interface RealtimeTokenOptions {
  /** Personality about to talk; picks the roster entry and the tier. */
  personalityId?: string;
  /** BCP-47 tag hinting the spoken language, when the surface knows it. */
  language?: string;
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
  /** `voice.tts.providers.*` as stored, with API keys already resolved. */
  voiceTtsProviders?: Readonly<Record<string, TtsProviderEntry>> | null;
  /** `voice.stt.providers.*` as stored, with API keys already resolved. */
  voiceSttProviders?: Readonly<Record<string, SttProviderEntry>> | null;
  /** `voice.realtime.providers.*` as stored, with API keys already resolved. */
  voiceRealtimeProviders?: Readonly<Record<string, RealtimeProviderEntry>> | null;
  /** `voice.realtime.default` — the roster key a personality that names none gets. */
  voiceRealtimeDefault?: string | null;
  /** `voice.tier` — the deployment's default voice engine. */
  voiceTier?: 'pipeline' | 'realtime' | null;
  /** `voice.realtime.sessionBudgetUsd` — USD cap on ONE realtime session. */
  voiceRealtimeSessionBudgetUsd?: number | null;
}

/**
 * What one realtime call costs per audio minute, and the cap on its total.
 *
 * Both halves come from the same place the mint reads — the roster entry the
 * personality resolves to, and the deployment's session budget — because a
 * session priced by one selection and capped by another is not a budget.
 * `costPerMinuteUsd` absent means the entry is UNPRICED: cost unknown, not zero.
 */
export interface RealtimeSessionCost {
  costPerMinuteUsd?: number;
  sessionBudgetUsd?: number;
  /**
   * Registered provider id of the selected entry (`openai-realtime`), never the
   * roster label. The control lane stamps it on this call's latency spans, so
   * "620 ms" is attributable to a provider rather than to the tier at large.
   */
  providerId?: string;
}

export class VoiceService {
  private readonly sttRegistry: SttProviderRegistry | undefined;
  private readonly initialProviderName: string | undefined;
  private readonly initialProviderConfig: Record<string, unknown>;
  private readonly secrets: SecretsResolver | undefined;
  private readonly configGetter?: () => Promise<LiveVoiceConfig | null>;
  /**
   * Named STT roster (`voice.stt.providers.*`). A personality's
   * `voice.stt_provider` picks from it; everything else uses the default
   * `auxiliary.asr` entry. Absent → this surface behaves exactly as it did
   * before rosters existed.
   */
  private readonly sttRoster: Readonly<Record<string, SttProviderEntry>> | undefined;
  /** Memo of the last entry that transcribed. Keyed by that entry's FIELDS. */
  private provider: SttProvider | null = null;
  private resolvedName: string | undefined;
  private resolvedSttEntryKey = '';

  private readonly ttsRegistry: TtsProviderRegistry | undefined;
  private readonly initialTtsProviderName: string | undefined;
  private readonly initialTtsProviderConfig: Record<string, unknown>;
  /**
   * Named TTS roster (`voice.tts.providers.*`). A personality's
   * `voice.tts_provider` picks from it; everything else uses the default entry
   * below. Absent → this surface behaves exactly as it did before rosters
   * existed.
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

  /**
   * Realtime (speech-to-speech) registry and boot roster. Nothing is memoized
   * the way STT/TTS providers are: a realtime provider is constructed to mint
   * ONE short-lived credential and then discarded, so a cache would hold a
   * configured secret open for no gain.
   */
  private readonly realtimeRegistry: RealtimeVoiceProviderRegistry | undefined;
  private readonly realtimeRoster: Readonly<Record<string, RealtimeProviderEntry>> | undefined;
  private readonly realtimeDefaultEntry: string | undefined;
  private readonly tier: 'pipeline' | 'realtime' | undefined;
  /**
   * Boot snapshot of the TYPED `voice.realtime.sessionBudgetUsd`, forwarded
   * through wiring like `realtimeDefault` and `tier` are.
   *
   * It exists because the live-config path is not always there. `configGetter`
   * is optional — a `VoiceService` built without one (a surface with no config
   * repo, a test, an embedder) read the cap from nowhere and reported no cap,
   * and "no cap" is indistinguishable from "uncapped by choice" at every point
   * downstream. A cap that silently does not apply is worse than no cap, so the
   * parsed value now reaches this class by a route that does not depend on a
   * second, optional one. Live config still wins when it is present: an
   * operator who just lowered the cap in Settings means the next call.
   */
  private readonly realtimeSessionBudgetUsd: number | undefined;

  /** Personality identity + advertised tools for a realtime session. */
  private readonly realtimeSurface: RealtimeSessionSurface | undefined;

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
    sttRoster?: Readonly<Record<string, SttProviderEntry>>;
    secrets?: SecretsResolver;
    configGetter?: () => Promise<LiveVoiceConfig | null>;
    ttsRegistry?: TtsProviderRegistry;
    ttsProviderName?: string;
    ttsProviderConfig?: Record<string, unknown>;
    ttsRoster?: Readonly<Record<string, TtsProviderEntry>>;
    realtimeRegistry?: RealtimeVoiceProviderRegistry;
    realtimeRoster?: Readonly<Record<string, RealtimeProviderEntry>>;
    /** `voice.realtime.default`. */
    realtimeDefault?: string;
    /** `voice.tier`. */
    tier?: 'pipeline' | 'realtime';
    /** `voice.realtime.sessionBudgetUsd`, from typed config at boot. */
    realtimeSessionBudgetUsd?: number;
    trustedVoicePlugins?: ReadonlySet<string>;
    personalities?: VoicePersonalityLookup;
    /** See {@link RealtimeSessionSurface}. */
    realtimeSurface?: RealtimeSessionSurface;
  }) {
    this.sttRegistry = opts.sttRegistry;
    this.initialProviderName = opts.providerName;
    this.initialProviderConfig = opts.providerConfig ?? {};
    this.sttRoster = opts.sttRoster;
    this.secrets = opts.secrets;
    this.configGetter = opts.configGetter;
    this.ttsRegistry = opts.ttsRegistry;
    this.initialTtsProviderName = opts.ttsProviderName;
    this.initialTtsProviderConfig = opts.ttsProviderConfig ?? {};
    this.ttsRoster = opts.ttsRoster;
    this.realtimeRegistry = opts.realtimeRegistry;
    this.realtimeRoster = opts.realtimeRoster;
    this.realtimeDefaultEntry = opts.realtimeDefault;
    this.tier = opts.tier;
    this.realtimeSessionBudgetUsd = opts.realtimeSessionBudgetUsd;
    this.trustedVoicePlugins = opts.trustedVoicePlugins;
    this.personalities = opts.personalities;
    this.realtimeSurface = opts.realtimeSurface;
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
        ...(override.provider ? { tts_provider: override.provider } : {}),
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

  /**
   * The default STT entry and the roster, boot values overlaid with live config.
   *
   * Same rule as {@link ttsDefaults}: the constructor's provider wins for the
   * DEFAULT entry and live Settings fill in only when boot supplied none, while
   * the ROSTER is edited from Settings and so a getter-supplied roster replaces
   * the boot snapshot outright.
   */
  private async sttDefaults(): Promise<{
    name: string | undefined;
    config: Record<string, unknown>;
    roster: Readonly<Record<string, SttProviderEntry>> | undefined;
  }> {
    let name = this.initialProviderName;
    let config: Record<string, unknown> = this.initialProviderConfig;
    const live = this.configGetter ? await this.configGetter().catch(() => null) : null;
    if (!name && live?.voiceProvider) {
      name = live.voiceProvider;
      config = {
        apiKey: live.voiceApiKey ?? undefined,
        baseUrl: live.voiceBaseUrl ?? undefined,
        model: live.voiceModel ?? undefined,
      };
    }
    return { name, config, roster: live?.voiceSttProviders ?? this.sttRoster };
  }

  /**
   * Resolve the STT provider for this utterance.
   *
   * Roster-aware, mirroring {@link resolveTts}: the listening personality's
   * `voice.stt_provider` picks an entry from `voice.stt.providers.*`; no name,
   * or a name this deployment does not have, falls back to the default
   * `auxiliary.asr` entry.
   */
  private async resolve(
    personality?: PersonalityVoiceConfig,
  ): Promise<VoiceResolution<SttProvider>> {
    const { name, config, roster } = await this.sttDefaults();

    // Pure decision — it names the entry and keys the memo.
    // `resolveSttProviderForPersonality` stays the authority on which provider
    // id is actually constructed and gated.
    const selection = selectSttEntry({
      ...(personality?.stt_provider ? { requestedName: personality.stt_provider } : {}),
      ...(roster ? { roster } : {}),
    });

    // The memo holds ONE provider — the last entry that transcribed. The key
    // carries the entry's FIELDS, not just its name: the roster is editable
    // from Settings, so `whisper-es` after an edit is a different provider than
    // `whisper-es` before it.
    const entryKey = `${selection.entryName ?? ''} ${JSON.stringify(selection.entry ?? null)}`;
    const cachedId = this.resolvedName;
    if (
      this.provider &&
      cachedId !== undefined &&
      entryKey === this.resolvedSttEntryKey &&
      (selection.entry !== undefined || cachedId === name)
    ) {
      return { ok: true, provider: this.provider, providerId: cachedId };
    }

    const { resolution } = await resolveSttProviderForPersonality({
      registry: this.sttRegistry,
      ...(personality ? { personality } : {}),
      ...(roster ? { roster } : {}),
      ...(name ? { defaultProviderName: name } : {}),
      defaultProviderConfig: config,
      ...(this.secrets ? { secrets: this.secrets } : {}),
      ...(this.trustedVoicePlugins ? { trustedVoicePlugins: this.trustedVoicePlugins } : {}),
    });
    if (resolution.ok) {
      this.provider = resolution.provider;
      this.resolvedName = resolution.providerId;
      this.resolvedSttEntryKey = entryKey;
    } else {
      this.provider = null;
      this.resolvedName = undefined;
      this.resolvedSttEntryKey = '';
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
      ...(personality?.tts_provider ? { requestedName: personality.tts_provider } : {}),
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
    return { name, config, roster: live?.voiceTtsProviders ?? this.ttsRoster };
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

  /**
   * Every STT entry a personality can name, and the provider id each names.
   *
   * Unlike {@link listTtsEntries} this constructs NOTHING: there is no
   * `caps.voices` equivalent to read for an ear, so building a transcriber just
   * to name it would spend credentials and connections for an answer already in
   * the config.
   */
  async listSttEntries(): Promise<{
    default: SttEntryInfo;
    roster: Record<string, SttEntryInfo>;
  }> {
    const { name, roster } = await this.sttDefaults();
    const entries: Record<string, SttEntryInfo> = {};
    for (const [entryName, entry] of Object.entries(roster ?? {})) {
      entries[entryName] = { providerId: entry.provider };
    }
    return { default: { providerId: name ?? null }, roster: entries };
  }

  /**
   * Every REALTIME entry a personality can name, and the provider id each names.
   *
   * Construction-free like {@link listSttEntries}, and for a sharper reason: a
   * realtime provider is built to mint ONE credential, so constructing the whole
   * roster to label a form would spend a credential per entry per page load.
   *
   * No synthetic default entry. `voice.realtime.default` names a roster label,
   * so the label is what comes back — a UI that invented a "Default" row here
   * would be offering a selection that resolves to nothing on a deployment with
   * an empty roster.
   */
  async listRealtimeEntries(): Promise<{
    roster: Record<string, RealtimeEntryInfo>;
    defaultEntryName: string | null;
  }> {
    const { roster, defaultEntry } = await this.realtimeDefaults();
    const entries: Record<string, RealtimeEntryInfo> = {};
    for (const [entryName, entry] of Object.entries(roster ?? {})) {
      entries[entryName] = { providerId: entry.provider };
    }
    return { roster: entries, defaultEntryName: defaultEntry ?? null };
  }

  /**
   * The realtime roster, boot values overlaid with live config.
   *
   * Same rule as {@link ttsDefaults} for the roster half — it is edited from
   * Settings → Voice, so a getter-supplied roster replaces the boot snapshot
   * outright and an entry added a minute ago is usable without a restart. The
   * default-entry name and the tier follow the same rule for the same reason.
   */
  private async realtimeDefaults(): Promise<{
    roster: Readonly<Record<string, RealtimeProviderEntry>> | undefined;
    defaultEntry: string | undefined;
    tier: 'pipeline' | 'realtime' | undefined;
    sessionBudgetUsd: number | undefined;
  }> {
    const live = this.configGetter ? await this.configGetter().catch(() => null) : null;
    const budget = live?.voiceRealtimeSessionBudgetUsd;
    return {
      roster: live?.voiceRealtimeProviders ?? this.realtimeRoster,
      defaultEntry: live?.voiceRealtimeDefault ?? this.realtimeDefaultEntry,
      tier: live?.voiceTier ?? this.tier,
      // A live NUMBER wins — an operator who just lowered the cap in Settings
      // means the next call. A live ABSENCE does not: it falls through to the
      // boot snapshot rather than erasing it. The two agree in the normal case,
      // and where they disagree the disagreement is a read that failed or a
      // deployment with no config repo, neither of which is an instruction to
      // stop capping. Removing a cap therefore takes effect on restart, which
      // is the direction to be wrong in when the subject is money.
      sessionBudgetUsd: typeof budget === 'number' ? budget : this.realtimeSessionBudgetUsd,
    };
  }

  /**
   * The per-audio-minute rate and the cap for the call `personalityId` is about
   * to make.
   *
   * The rate is the SELECTED roster entry's — the same selection
   * {@link mintRealtimeToken} makes, run through the same pure function, so the
   * session that gets billed and the session that gets minted are the same one.
   * Nothing is constructed: this decides, it does not open a provider.
   */
  async realtimeSessionCost(personalityId?: string): Promise<RealtimeSessionCost> {
    const { roster, defaultEntry, sessionBudgetUsd } = await this.realtimeDefaults();
    const personality = personalityId ? this.personalities?.get(personalityId)?.voice : undefined;
    const requested = personality?.realtime_provider;
    const selection = selectRealtimeEntry({
      ...(requested ? { requestedName: requested } : {}),
      ...(roster ? { roster } : {}),
      ...(defaultEntry ? { defaultEntryName: defaultEntry } : {}),
    });
    const rate = selection.entry?.costPerMinuteUsd;
    return {
      ...(typeof rate === 'number' ? { costPerMinuteUsd: rate } : {}),
      ...(sessionBudgetUsd !== undefined ? { sessionBudgetUsd } : {}),
      ...(selection.entry?.provider ? { providerId: selection.entry.provider } : {}),
    };
  }

  /**
   * Mint a browser-direct realtime credential for `personalityId`, or say why
   * not.
   *
   * The refusal is TYPED rather than thrown because none of these are errors:
   * a deployment with no realtime provider, a personality that prefers the
   * pipeline, and a local-only gate refusing a hosted model are all legitimate
   * states the browser renders differently and then continues the call on the
   * pipeline tier. Throwing would collapse them into one red box.
   *
   * Nothing in a refusal carries key material. The provider id is named
   * (that is the point — an operator needs to know WHICH provider was refused),
   * but factory/mint failure text is replaced with a fixed sentence, because a
   * provider's own error body is free to echo part of the credential back.
   */
  async mintRealtimeToken(opts?: RealtimeTokenOptions): Promise<RealtimeTokenResult> {
    const personality = opts?.personalityId
      ? this.personalities?.get(opts.personalityId)?.voice
      : undefined;
    const { roster, defaultEntry, tier } = await this.realtimeDefaults();

    // Tier precedence lives in ONE function for the whole repo: the
    // personality's `voice.tier` beats the deployment's `voice.tier`. Absent
    // from both means "try realtime" — the plan's default where a provider is
    // configured — so only an explicit `pipeline` refuses here.
    const preferences = resolveVoicePreferences({
      ...(personality ? { personality } : {}),
      ...(tier ? { globalTier: tier } : {}),
    });
    if (preferences.tier === 'pipeline') {
      return {
        ok: false,
        reason: 'pipeline_preferred',
        message: 'Voice is configured to run on the local pipeline for this personality.',
        providerId: null,
      };
    }

    const { resolution, selection } = await resolveRealtimeProviderForPersonality({
      registry: this.realtimeRegistry,
      ...(personality ? { personality } : {}),
      ...(roster ? { roster } : {}),
      ...(defaultEntry ? { defaultEntryName: defaultEntry } : {}),
      ...(this.secrets ? { secrets: this.secrets } : {}),
      ...(this.trustedVoicePlugins ? { trustedVoicePlugins: this.trustedVoicePlugins } : {}),
    });

    if (!resolution.ok) {
      return realtimeRefusal(resolution, selection.requestedName ?? defaultEntry);
    }

    const provider = resolution.provider;
    const mint = provider.mintEphemeralToken?.bind(provider);
    if (provider.caps.ephemeralToken !== true || !mint) {
      // Gemini Live lands here BY DESIGN — it is server-relayed and has no
      // browser-direct credential to hand out. Fully usable server-side.
      return {
        ok: false,
        reason: 'no_browser_token',
        message:
          `Realtime provider "${resolution.providerId}" cannot issue a browser credential, ` +
          'so this browser cannot connect to it directly.',
        providerId: resolution.providerId,
      };
    }

    const entryModel = selection.entry?.model;
    // The session's identity and its tool list, baked into the credential. Both
    // are resolved BEFORE the mint call: a session is configured once, at open,
    // and there is no second chance to tell a live realtime model who it is.
    // A surface that throws must not take the call down — a session with no
    // instructions still hears and speaks, it just has no personality, which is
    // exactly the state this deployment was in before the seam existed.
    const surface = await this.realtimeSurface
      ?.describe(opts?.personalityId)
      .catch(() => undefined);
    // The voice follows the ONE precedence function the rest of this file uses
    // (`resolveVoicePreferences`): the personality's own `voice.tts_voice`
    // beats the roster entry's default. A realtime provider speaks with the
    // same voice the pipeline tier would have used for this personality —
    // switching tiers must not switch who you are talking to.
    const voice = resolveVoicePreferences({
      ...(personality ? { personality } : {}),
      ...(selection.entry?.voice ? { globalTtsVoice: selection.entry.voice } : {}),
      ...(opts?.language ? { language: opts.language } : {}),
    }).ttsVoice;
    let token: Awaited<ReturnType<typeof mint>>;
    try {
      token = await mint({
        instructions: surface?.instructions ?? '',
        ...(surface?.tools?.length ? { tools: surface.tools } : {}),
        ...(entryModel ? { model: entryModel } : {}),
        ...(voice ? { voice } : {}),
        ...(opts?.language ? { language: opts.language } : {}),
      });
    } catch {
      // Deliberately NOT the provider's own message: a mint rejection body is
      // free to echo part of the API key back, and this string is rendered to
      // a browser.
      return {
        ok: false,
        reason: 'provider_unavailable',
        message: `Realtime provider "${resolution.providerId}" would not issue a session credential.`,
        providerId: resolution.providerId,
      };
    }

    return {
      ok: true,
      providerId: resolution.providerId,
      model: token.model ?? entryModel ?? null,
      token: token.token,
      expiresAt: token.expiresAt,
      url: token.url,
      inputSampleRate: provider.caps.inputSampleRate,
      outputSampleRate: provider.caps.outputSampleRate,
    };
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
    opts?: TranscriptionVoiceOptions,
  ): Promise<{ text: string; provider: string }> {
    const personality = opts?.personalityId
      ? this.personalities?.get(opts.personalityId)?.voice
      : undefined;
    const resolution = await this.resolve(personality);
    if (!resolution.ok) {
      throw new Error(
        resolution.code === 'not_configured'
          ? 'No STT provider configured — set auxiliary.asr in config'
          : resolution.error,
      );
    }

    const raw = await resolution.provider.transcribeBuffer(
      { data, mimeType },
      {
        ...(opts?.language ? { language: opts.language } : {}),
        ...(signal ? { signal } : {}),
      },
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

  async transcribe(
    audioBase64: string,
    mimeType: string,
    opts?: TranscriptionVoiceOptions,
  ): Promise<string> {
    // The browser's utterance goes to the provider as bytes. It used to land
    // in a temp file first, purely so the provider could read it back — a
    // write, a read and a cleanup obligation on captured voice, for a payload
    // that never needed to touch this disk.
    const buf = Buffer.from(audioBase64, 'base64');
    const result = await this.transcribeBytes(
      new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      mimeType,
      undefined,
      opts,
    );
    return result.text;
  }
}

/** One-shot async iterable — the streaming TTS contract consumes text lazily. */
async function* once(text: string): AsyncIterable<string> {
  yield text;
}

/**
 * Translate a failed realtime resolution into a renderable refusal.
 *
 * `untrusted_provider` passes the resolver's own message through: it names the
 * REAL provider (never the roster label) and carries no credential, and an
 * operator debugging a local-only gate needs exactly that sentence. Every other
 * failure gets a fixed string, because a factory's throw text is arbitrary and
 * this ends up in a browser.
 */
function realtimeRefusal(
  resolution: Extract<VoiceResolution<unknown>, { ok: false }>,
  requestedEntry: string | undefined,
): RealtimeTokenResult {
  const providerId = resolution.providerId ?? null;
  switch (resolution.code) {
    case 'untrusted_provider':
      return {
        ok: false,
        reason: 'untrusted_provider',
        message: resolution.error,
        providerId,
      };
    case 'not_configured':
      return requestedEntry
        ? {
            ok: false,
            reason: 'unknown_entry',
            message: `This deployment has no realtime voice entry named "${requestedEntry}".`,
            providerId,
          }
        : {
            ok: false,
            reason: 'not_configured',
            message: 'No realtime voice provider is configured for this deployment.',
            providerId,
          };
    default:
      return {
        ok: false,
        reason: 'provider_unavailable',
        message: providerId
          ? `Realtime provider "${providerId}" is unavailable.`
          : 'The configured realtime voice provider is unavailable.',
        providerId,
      };
  }
}
