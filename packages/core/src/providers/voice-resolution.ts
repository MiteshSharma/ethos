// The ONE place a voice provider is resolved from config.
//
// Every surface that speaks or listens — the gateway (voice notes), web-api
// (browser talk-mode), the wiring-constructed VoiceSession stack, and later the
// satellite — calls these functions instead of reaching into the registry
// itself. Duplicated resolution is the failure mode this exists to prevent:
// config names one provider, a second code path constructs another, and
// nothing in the telemetry says which one actually ran. A successful
// resolution carries `providerId`, which callers stamp into the per-turn voice
// spans so "which provider served this turn" is answerable after the fact.
//
// The local-only egress gate lives here too, for the same reason: a gate each
// surface re-implements is a gate with holes. `trustedVoicePlugins` semantics:
//   - undefined          → gate OFF (no allowlist configured; legacy default)
//   - a set (even empty) → gate ON: `caps.local` providers always pass;
//                          everything else must be named in the set.

import type {
  Logger,
  PersonalityVoiceConfig,
  SecretsResolver,
  SttProvider,
  SttProviderEntry,
  SttProviderRegistry,
  TtsProvider,
  TtsProviderEntry,
  TtsProviderRegistry,
} from '@ethosagent/types';

/** Why a resolution produced no provider. */
export type VoiceResolutionErrorCode =
  /** No provider name (or no registry) configured for this kind. */
  | 'not_configured'
  /** A name was configured, but no factory is registered under it. */
  | 'unknown_provider'
  /** The provider is non-local and absent from `trustedVoicePlugins`. */
  | 'untrusted_provider'
  /** The factory threw (bad credentials, unreachable server, …). */
  | 'init_failed';

export type VoiceResolution<P> =
  | { ok: true; provider: P; providerId: string }
  | { ok: false; code: VoiceResolutionErrorCode; error: string; providerId?: string };

export interface ResolveVoiceProviderOptions {
  /** Provider id from config. Absent/empty → `not_configured`. */
  providerName: string | undefined;
  /** Factory config (apiKey / baseUrl / model / voice / …). */
  providerConfig?: Record<string, unknown>;
  secrets?: SecretsResolver;
  logger?: Logger;
  /**
   * Local-only egress gate. `undefined` disables the gate; a set (including an
   * empty one) enables it — `caps.local` providers always pass, every other
   * provider must be listed.
   */
  trustedVoicePlugins?: ReadonlySet<string>;
}

export interface ResolveSttOptions extends ResolveVoiceProviderOptions {
  /** Registry to resolve from. Absent → `not_configured`. */
  registry: SttProviderRegistry | undefined;
}

export interface ResolveTtsOptions extends ResolveVoiceProviderOptions {
  /** Registry to resolve from. Absent → `not_configured`. */
  registry: TtsProviderRegistry | undefined;
}

const NOOP_SECRETS: SecretsResolver = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  list: async () => [],
};

const NOOP_LOGGER: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return this;
  },
};

async function resolve<P extends { caps: { local?: boolean } }>(
  kind: 'stt' | 'tts',
  opts: ResolveVoiceProviderOptions,
  lookup: ((name: string) => ((ctx: FactoryContext) => P | Promise<P>) | undefined) | undefined,
): Promise<VoiceResolution<P>> {
  const label = kind.toUpperCase();
  const name = opts.providerName?.trim();
  if (!name || !lookup) {
    return { ok: false, code: 'not_configured', error: `No ${label} provider configured` };
  }

  const factory = lookup(name);
  if (!factory) {
    return {
      ok: false,
      code: 'unknown_provider',
      providerId: name,
      error: `Unknown ${label} provider "${name}" — not registered`,
    };
  }

  let provider: P;
  try {
    provider = await factory({
      config: opts.providerConfig ?? {},
      secrets: opts.secrets ?? NOOP_SECRETS,
      logger: opts.logger ?? NOOP_LOGGER,
    });
  } catch (err) {
    return {
      ok: false,
      code: 'init_failed',
      providerId: name,
      error: `${label} provider "${name}" failed to initialize: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (opts.trustedVoicePlugins !== undefined && provider.caps.local !== true) {
    if (!opts.trustedVoicePlugins.has(name)) {
      return {
        ok: false,
        code: 'untrusted_provider',
        providerId: name,
        error:
          `${label} provider "${name}" is not local and is not in voice.trustedPlugins — ` +
          'refusing to send audio off this machine',
      };
    }
  }

  return { ok: true, provider, providerId: name };
}

interface FactoryContext {
  config: Record<string, unknown>;
  secrets: SecretsResolver;
  logger: Logger;
}

/** Resolve the configured STT provider. The single STT resolution path. */
export function resolveSttProvider(opts: ResolveSttOptions): Promise<VoiceResolution<SttProvider>> {
  const registry = opts.registry;
  return resolve<SttProvider>('stt', opts, registry ? (name) => registry.get(name) : undefined);
}

/** Resolve the configured TTS provider. The single TTS resolution path. */
export function resolveTtsProvider(opts: ResolveTtsOptions): Promise<VoiceResolution<TtsProvider>> {
  const registry = opts.registry;
  return resolve<TtsProvider>('tts', opts, registry ? (name) => registry.get(name) : undefined);
}

/** Error carrying the resolution failure code, for callers that throw. */
export class VoiceProviderError extends Error {
  readonly code: VoiceResolutionErrorCode;
  readonly providerId: string | undefined;

  constructor(failure: { code: VoiceResolutionErrorCode; error: string; providerId?: string }) {
    super(failure.error);
    this.name = 'VoiceProviderError';
    this.code = failure.code;
    this.providerId = failure.providerId;
  }
}

/** Unwrap a resolution, throwing {@link VoiceProviderError} on failure. */
export function unwrapVoiceResolution<P>(resolution: VoiceResolution<P>): {
  provider: P;
  providerId: string;
} {
  if (!resolution.ok) throw new VoiceProviderError(resolution);
  return { provider: resolution.provider, providerId: resolution.providerId };
}

// ---------------------------------------------------------------------------
// Voice provider rosters — TTS and STT, mirrored
//
// A deployment can configure several named providers per kind
// (`voice.tts.providers.*` / `voice.stt.providers.*` in `~/.ethos/config.yaml`)
// and a personality picks one by name (`voice.tts_provider` /
// `voice.stt_provider`). `auxiliary.tts` and `auxiliary.asr` stay the DEFAULT
// entries, so a config that declares no roster behaves exactly as it did.
//
// The two kinds share ONE selection function and ONE resolution shape,
// parameterised by kind and entry type. They are the same decision made about
// different hardware; two copies would be two places for the fallback rule —
// or the gate — to drift.
//
// The roster key is a label the operator typed. It is not a provider id and it
// is never what the egress gate keys on: selection happens here, the gate keys
// on the selected entry's `provider` (and the constructed provider's `caps`),
// so naming a cloud entry `local-kokoro` cannot walk it past a local-only gate.
// ---------------------------------------------------------------------------

/** Why a given roster entry was selected. */
export type VoiceEntrySelectionReason =
  /** The personality named a roster entry and it exists. */
  | 'roster'
  /** No name given (or an empty one) — the default `auxiliary.*` entry. */
  | 'default'
  /** A name was given but no roster entry carries it — fell back to the default. */
  | 'unknown_name';

export interface VoiceEntrySelection<E> {
  /**
   * The roster entry that serves this turn. `undefined` means "the default
   * entry" — `auxiliary.tts` / `auxiliary.asr`, whose provider name and factory
   * config the caller already holds.
   */
  entry: E | undefined;
  /** Roster key that served, when a roster entry did. */
  entryName: string | undefined;
  reason: VoiceEntrySelectionReason;
  /** The name the personality asked for, when it did not resolve. */
  requestedName?: string;
}

export type TtsEntrySelection = VoiceEntrySelection<TtsProviderEntry>;
export type SttEntrySelection = VoiceEntrySelection<SttProviderEntry>;

export interface SelectVoiceEntryOptions<E> {
  /** `voice.tts_provider` / `voice.stt_provider` for the personality this turn. */
  requestedName?: string;
  /** `voice.<kind>.providers.*` — roster key → entry. */
  roster?: Readonly<Record<string, E>>;
  /** Logs the unknown-name fallback. Optional; the reason is returned either way. */
  logger?: Logger;
}

export type SelectTtsEntryOptions = SelectVoiceEntryOptions<TtsProviderEntry>;
export type SelectSttEntryOptions = SelectVoiceEntryOptions<SttProviderEntry>;

/**
 * Pick the roster entry for a turn:
 *
 *   1. `requestedName` names a roster entry → that entry (`roster`).
 *   2. `requestedName` is present but unknown → the default entry
 *      (`unknown_name`). A personality shared between machines must still
 *      speak — and still be heard — on one that lacks its preferred provider,
 *      but the fallback is a returned reason (and a log line), never silence.
 *   3. No name → the default entry (`default`).
 *
 * Pure: it decides, it does not construct. The "default entry" is expressed as
 * `entry: undefined` so a caller that holds `auxiliary.tts` / `auxiliary.asr` as
 * a name + config pair (every surface does) needs no second representation.
 */
function selectVoiceEntry<E>(
  kind: 'stt' | 'tts',
  opts: SelectVoiceEntryOptions<E>,
): VoiceEntrySelection<E> {
  const requested = opts.requestedName?.trim();
  if (!requested) return { entry: undefined, entryName: undefined, reason: 'default' };

  const entry = opts.roster?.[requested];
  if (!entry) {
    const defaultKey = kind === 'tts' ? 'auxiliary.tts' : 'auxiliary.asr';
    opts.logger?.warn(
      `voice: ${kind.toUpperCase()} provider "${requested}" is not in voice.${kind}.providers — ` +
        `falling back to the default ${defaultKey} entry`,
    );
    return {
      entry: undefined,
      entryName: undefined,
      reason: 'unknown_name',
      requestedName: requested,
    };
  }
  return { entry, entryName: requested, reason: 'roster' };
}

/**
 * Pick the TTS entry for a turn. See {@link selectVoiceEntry}.
 *
 * Voice-id precedence is unchanged and applies WITHIN the chosen entry: pass
 * `selection.entry?.voice` (falling back to the default entry's voice) as
 * `globalTtsVoice` to {@link resolveVoicePreferences}, so a language-specific
 * voice still beats `tts_voice`, which still beats the entry's own default.
 */
export function selectTtsEntry(opts: SelectTtsEntryOptions): TtsEntrySelection {
  return selectVoiceEntry('tts', opts);
}

/** Pick the STT entry for a turn. The exact mirror of {@link selectTtsEntry}. */
export function selectSttEntry(opts: SelectSttEntryOptions): SttEntrySelection {
  return selectVoiceEntry('stt', opts);
}

/**
 * Factory config for one roster entry: every field EXCEPT `provider`, which
 * names the provider and is not a knob the factory reads.
 *
 * Written once for both kinds — an entry is a flat record of scalars, and
 * spelling out per-kind field lists here would be a third place (after the
 * config parser and serializer) for the two to drift.
 */
function voiceEntryProviderConfig<E extends { provider: string }>(
  entry: E | undefined,
): Record<string, unknown> {
  if (!entry) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'provider' || value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/** Factory config for one TTS roster entry. */
export function ttsEntryProviderConfig(
  entry: TtsProviderEntry | undefined,
): Record<string, unknown> {
  return voiceEntryProviderConfig(entry);
}

/** Factory config for one STT roster entry. */
export function sttEntryProviderConfig(
  entry: SttProviderEntry | undefined,
): Record<string, unknown> {
  return voiceEntryProviderConfig(entry);
}

interface ResolveVoiceForPersonalityOptions<E> {
  /** `voice.<kind>.providers.*`. */
  roster?: Readonly<Record<string, E>>;
  /** `auxiliary.tts.provider` / `auxiliary.asr.provider` — the default's id. */
  defaultProviderName?: string;
  /** `auxiliary.tts.*` / `auxiliary.asr.*` as factory config. */
  defaultProviderConfig?: Record<string, unknown>;
  secrets?: SecretsResolver;
  logger?: Logger;
  /** Local-only egress gate; see {@link ResolveVoiceProviderOptions}. */
  trustedVoicePlugins?: ReadonlySet<string>;
}

export interface ResolveTtsForPersonalityOptions
  extends ResolveVoiceForPersonalityOptions<TtsProviderEntry> {
  /** Registry to resolve from. Absent → `not_configured`. */
  registry: TtsProviderRegistry | undefined;
  /** The speaking personality's `voice` block; `tts_provider` names the entry. */
  personality?: PersonalityVoiceConfig;
}

export interface ResolveSttForPersonalityOptions
  extends ResolveVoiceForPersonalityOptions<SttProviderEntry> {
  /** Registry to resolve from. Absent → `not_configured`. */
  registry: SttProviderRegistry | undefined;
  /** The listening personality's `voice` block; `stt_provider` names the entry. */
  personality?: PersonalityVoiceConfig;
}

export interface TtsProviderForPersonality {
  /** The resolution, keyed on the entry's UNDERLYING provider id. */
  resolution: VoiceResolution<TtsProvider>;
  /** Which entry was chosen, and why — observable rather than inferred. */
  selection: TtsEntrySelection;
  /**
   * The chosen entry's own voice id — the lowest rung of the voice precedence,
   * evaluated WITHIN the chosen provider. Feed it to
   * {@link resolveVoicePreferences} as `globalTtsVoice`.
   */
  globalTtsVoice: string | undefined;
}

export interface SttProviderForPersonality {
  /** The resolution, keyed on the entry's UNDERLYING provider id. */
  resolution: VoiceResolution<SttProvider>;
  /** Which entry was chosen, and why — observable rather than inferred. */
  selection: SttEntrySelection;
}

/**
 * Select this personality's TTS entry and resolve its provider.
 *
 * The security-relevant line: `providerName` is `entry.provider` — the
 * registered provider id — never the roster key. The trust gate therefore
 * tests the id that is actually about to run, alongside the caps of the
 * provider that was actually constructed. A roster entry called
 * `local-anything` backed by a non-local provider is refused exactly as if the
 * operator had named that provider directly.
 */
export async function resolveTtsProviderForPersonality(
  opts: ResolveTtsForPersonalityOptions,
): Promise<TtsProviderForPersonality> {
  const selection = selectTtsEntry({
    ...(opts.personality?.tts_provider ? { requestedName: opts.personality.tts_provider } : {}),
    ...(opts.roster ? { roster: opts.roster } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  const defaultConfig = opts.defaultProviderConfig ?? {};
  const providerConfig = selection.entry ? ttsEntryProviderConfig(selection.entry) : defaultConfig;
  const entryVoice = providerConfig.voice;
  const resolution = await resolveTtsProvider({
    registry: opts.registry,
    providerName: selection.entry?.provider ?? opts.defaultProviderName,
    providerConfig,
    ...(opts.secrets ? { secrets: opts.secrets } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.trustedVoicePlugins ? { trustedVoicePlugins: opts.trustedVoicePlugins } : {}),
  });
  return {
    resolution,
    selection,
    globalTtsVoice: typeof entryVoice === 'string' ? entryVoice : undefined,
  };
}

/**
 * Select this personality's STT entry and resolve its provider. The exact
 * mirror of {@link resolveTtsProviderForPersonality}, including the security
 * line: the gate keys on `entry.provider` and the constructed provider's
 * `caps.local`, never on the roster label. An entry called `local-whisper`
 * backed by a cloud transcriber is refused before a byte of captured audio
 * leaves the machine.
 */
export async function resolveSttProviderForPersonality(
  opts: ResolveSttForPersonalityOptions,
): Promise<SttProviderForPersonality> {
  const selection = selectSttEntry({
    ...(opts.personality?.stt_provider ? { requestedName: opts.personality.stt_provider } : {}),
    ...(opts.roster ? { roster: opts.roster } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  const providerConfig = selection.entry
    ? sttEntryProviderConfig(selection.entry)
    : (opts.defaultProviderConfig ?? {});
  const resolution = await resolveSttProvider({
    registry: opts.registry,
    providerName: selection.entry?.provider ?? opts.defaultProviderName,
    providerConfig,
    ...(opts.secrets ? { secrets: opts.secrets } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.trustedVoicePlugins ? { trustedVoicePlugins: opts.trustedVoicePlugins } : {}),
  });
  return { resolution, selection };
}

// ---------------------------------------------------------------------------
// Personality voice preferences
// ---------------------------------------------------------------------------

export interface ResolveVoicePreferencesOptions {
  /** `PersonalityConfig.voice` for the personality speaking this turn. */
  personality?: PersonalityVoiceConfig;
  /** Global default from `auxiliary.tts.voice` in `~/.ethos/config.yaml`. */
  globalTtsVoice?: string;
  /** Global fast-lane model default, when a deployment configures one. */
  globalModel?: string;
  /** Global tier default. */
  globalTier?: 'pipeline' | 'realtime';
  /** BCP-47 tag of the turn, selecting from the language→voice map. */
  language?: string;
}

export interface ResolvedVoicePreferences {
  /** Voice id to hand the TTS provider. Undefined → the provider's own default. */
  ttsVoice?: string;
  /** Which tier this personality wants. Undefined → the deployment decides. */
  tier?: 'pipeline' | 'realtime';
  /** Fast-lane model for spoken turns. Undefined → the personality's normal model. */
  model?: string;
}

/**
 * Resolve the effective voice preferences for a turn: personality first,
 * global config as the fallback.
 *
 * Voice is part of a personality's identity, not a deployment setting — a
 * deployment picks the PROVIDER, the personality picks how it SOUNDS. So the
 * `voice` block wins wherever it speaks, and silence in it means "inherit".
 * Language-specific entries beat the personality's default voice, because a
 * personality that declares a Spanish voice means it when speaking Spanish.
 *
 * Sole resolution path for this precedence: the character sheet, the session
 * builder, and (later) the realtime tier all read the same answer.
 */
export function resolveVoicePreferences(
  opts: ResolveVoicePreferencesOptions,
): ResolvedVoicePreferences {
  const personality = opts.personality;
  const languageVoice = opts.language ? personality?.languages?.[opts.language] : undefined;
  const ttsVoice = languageVoice ?? personality?.tts_voice ?? opts.globalTtsVoice;
  const tier = personality?.tier ?? opts.globalTier;
  const model = personality?.model ?? opts.globalModel;
  return {
    ...(ttsVoice ? { ttsVoice } : {}),
    ...(tier ? { tier } : {}),
    ...(model ? { model } : {}),
  };
}
