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
  SttProviderRegistry,
  TtsProvider,
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
