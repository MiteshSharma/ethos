import type { ConfigGetData, ConfigUpdatePatch, VoiceBargeInPatch } from './config-types';

// ---------------------------------------------------------------------------
// Telephony (voice V4) — `voice.trunk.*`, `voice.livekit.*`, `voice.inbound.*`,
// `voice.bargeIn.*`, `voice.bots[]`.
//
// Every one of these keys was previously reachable only by hand-editing
// config.yaml. A phone number is the surface strangers can dial, so its
// allowlist, its budget and the personality that answers it have to be visible
// where the deployment is managed — a yaml-only telephony key is a guard nobody
// can see.
//
// The patch builder is at module scope, pure, and exported: THREE of these keys
// come in blocks the CLI parser will not load half of (provider+trunkId,
// url+apiKey+apiSecret, platform+chatId), so "can this form save half a block"
// is a question that has to be answerable without mounting the form.
// ---------------------------------------------------------------------------

export const TRUNK_PROVIDERS = ['twilio', 'telnyx', 'generic', 'livekit'] as const;
export const TRUNK_CODECS = ['opus', 'g711'] as const;
const INBOUND_PREWARMS = ['allowlisted', 'none', 'all'] as const;
/** The surfaces `voice.bargeIn.<surface>` accepts. `browser` since L1 (plan §7
 *  "Conflict 2") — the browser pipeline lane runs on the same `VoiceSession`
 *  orchestrator as `call`/`satellite` now and tunes through the same
 *  mechanism, so it gets the same generic row. The legacy `display.voice_*`
 *  sliders that used to be the browser's only tuner are reduced to the two
 *  knobs that still do something live (the batch-fallback client's own local
 *  VAD) — see `VOICE_TUNING_CONTROLS` in `panes/voice.tsx`. */
export const BARGE_IN_SURFACES = ['call', 'satellite', 'browser'] as const;
type BargeInSurface = (typeof BARGE_IN_SURFACES)[number];

export const BARGE_IN_SURFACE_LABELS: Record<BargeInSurface, string> = {
  call: 'Phone call',
  satellite: 'Wake satellite',
  browser: 'Browser (this device)',
};

function trunkProviderOrNull(value: string): (typeof TRUNK_PROVIDERS)[number] | null {
  return TRUNK_PROVIDERS.find((p) => p === value) ?? null;
}

function trunkCodecOrNull(value: string): (typeof TRUNK_CODECS)[number] | null {
  return TRUNK_CODECS.find((c) => c === value) ?? null;
}

function inboundPrewarmOrNull(value: string): (typeof INBOUND_PREWARMS)[number] | null {
  return INBOUND_PREWARMS.find((p) => p === value) ?? null;
}

export interface VoiceBargeInForm {
  energyThreshold: number | null;
  minSpeechMs: number | null;
  silenceMs: number | null;
}

/** Every surface gets a slot, tuned or not, so the form always has a row per
 *  surface to render. An untuned surface is all-null and the patch builder drops
 *  it again — round-tripping "never tuned" rather than writing defaults over it. */
export function voiceBargeInFromConfig(
  map: ConfigGetData['voiceBargeIn'],
): Record<string, VoiceBargeInForm> {
  const out: Record<string, VoiceBargeInForm> = {};
  for (const surface of BARGE_IN_SURFACES) {
    const entry = map[surface];
    out[surface] = {
      energyThreshold: entry?.energyThreshold ?? null,
      minSpeechMs: entry?.minSpeechMs ?? null,
      silenceMs: entry?.silenceMs ?? null,
    };
  }
  return out;
}

export interface VoiceTelephonyFormValues {
  voiceTrunkProvider: string;
  voiceTrunkId: string;
  voiceTrunkFromNumber: string;
  voiceTrunkUsername: string;
  /** Write-only. Blank KEEPS the stored secret — the browser only ever saw a
   *  preview, so it has nothing to type back. */
  voiceTrunkPassword: string;
  voiceTrunkWebhookSecret: string;
  voiceTrunkWebhookPath: string;
  voiceTrunkCodec: string;
  voiceLivekitUrl: string;
  voiceLivekitApiKey: string;
  voiceLivekitApiSecret: string;
  voiceInboundAllowlist: string[];
  voiceInboundReceptionist: string;
  voiceInboundConcurrencyCap: number | null;
  voiceInboundPerCallerPerHour: number | null;
  voiceInboundDailyBudgetUsd: number | null;
  voiceInboundPrewarm: string;
  voiceInboundOwnerPlatform: string;
  voiceInboundOwnerChatId: string;
  voiceInboundOwnerBotKey: string;
  voiceBargeIn: Record<string, VoiceBargeInForm>;
}

/** What `config.get` said is already on disk. Only the redacted previews are
 *  needed: they are how the builder knows a secret EXISTS without having it. */
export interface VoiceTelephonyStoredSecrets {
  voiceTrunkPasswordPreview: string | null;
  voiceTrunkWebhookSecretPreview: string | null;
  voiceLivekitApiKeyPreview: string | null;
  voiceLivekitApiSecretPreview: string | null;
}

export type VoiceTelephonyPatch = Pick<
  ConfigUpdatePatch,
  | 'voiceTrunkProvider'
  | 'voiceTrunkId'
  | 'voiceTrunkFromNumber'
  | 'voiceTrunkUsername'
  | 'voiceTrunkPassword'
  | 'voiceTrunkWebhookSecret'
  | 'voiceTrunkWebhookPath'
  | 'voiceTrunkCodec'
  | 'voiceLivekitUrl'
  | 'voiceLivekitApiKey'
  | 'voiceLivekitApiSecret'
  | 'voiceInboundAllowlist'
  | 'voiceInboundReceptionist'
  | 'voiceInboundConcurrencyCap'
  | 'voiceInboundPerCallerPerHour'
  | 'voiceInboundDailyBudgetUsd'
  | 'voiceInboundPrewarm'
  | 'voiceInboundOwnerPlatform'
  | 'voiceInboundOwnerChatId'
  | 'voiceInboundOwnerBotKey'
  | 'voiceBargeIn'
>;

export type VoiceTelephonyPatchResult =
  | { ok: true; patch: VoiceTelephonyPatch }
  | { ok: false; error: string };

/**
 * Form values → the telephony half of a `config.update` patch.
 *
 * Three invariants, each of which the CLI parser turns into a load failure
 * rather than a warning if the form gets it wrong:
 *
 *  1. **A block is all or nothing.** `voice.trunk.*` needs provider AND
 *     trunkId; `voice.livekit.*` needs url AND apiKey AND apiSecret;
 *     `voice.inbound.owner.*` needs platform AND chatId. Clearing the ANCHOR
 *     (provider / url / platform) clears the whole block and the rest of the
 *     fields are not sent — half a block on disk is a parse error, so "clear
 *     the trunk" has to mean the block. Filling the anchor without its partner
 *     is refused HERE, with a sentence, rather than saved and discovered on a
 *     ringing phone.
 *  2. **A blank secret keeps the stored one.** The browser is handed a preview,
 *     never a credential, so blank cannot mean "erase" — it would delete a
 *     password every time somebody saved an unrelated field. LiveKit's
 *     all-or-nothing check therefore counts a STORED secret as present.
 *  3. **An empty allowlist clears the key.** `voice.inbound.allowlist: []` is
 *     not expressible in the flat config format, and the policy it would mean
 *     ("nobody is trusted") is spelled `voice.inbound.receptionist`.
 */
export function voiceTelephonyPatch(
  values: VoiceTelephonyFormValues,
  stored: VoiceTelephonyStoredSecrets,
): VoiceTelephonyPatchResult {
  const trunkProvider = trunkProviderOrNull(values.voiceTrunkProvider);
  const trunkId = values.voiceTrunkId.trim();
  const webhookPath = values.voiceTrunkWebhookPath.trim();

  let trunk: VoiceTelephonyPatch;
  if (trunkProvider === null) {
    trunk = { voiceTrunkProvider: null };
  } else if (!trunkId) {
    return {
      ok: false,
      error:
        'Telephony: a trunk needs both a provider and a trunk id. Add the trunk id, or clear the provider to remove telephony entirely.',
    };
  } else if (webhookPath && !webhookPath.startsWith('/')) {
    return { ok: false, error: 'Telephony: the webhook path must start with “/”.' };
  } else {
    trunk = {
      voiceTrunkProvider: trunkProvider,
      voiceTrunkId: trunkId,
      voiceTrunkFromNumber: values.voiceTrunkFromNumber.trim() || null,
      voiceTrunkUsername: values.voiceTrunkUsername.trim() || null,
      voiceTrunkWebhookPath: webhookPath || null,
      voiceTrunkCodec: trunkCodecOrNull(values.voiceTrunkCodec),
      ...(values.voiceTrunkPassword ? { voiceTrunkPassword: values.voiceTrunkPassword } : {}),
      ...(values.voiceTrunkWebhookSecret
        ? { voiceTrunkWebhookSecret: values.voiceTrunkWebhookSecret }
        : {}),
    };
  }

  const livekitUrl = values.voiceLivekitUrl.trim();
  let livekit: VoiceTelephonyPatch;
  if (!livekitUrl) {
    livekit = { voiceLivekitUrl: null };
  } else {
    const hasKey = Boolean(values.voiceLivekitApiKey || stored.voiceLivekitApiKeyPreview);
    const hasSecret = Boolean(values.voiceLivekitApiSecret || stored.voiceLivekitApiSecretPreview);
    if (!hasKey || !hasSecret) {
      return {
        ok: false,
        error:
          'LiveKit: the server URL needs an API key and an API secret with it. Add both, or clear the URL to remove the LiveKit block.',
      };
    }
    livekit = {
      voiceLivekitUrl: livekitUrl,
      ...(values.voiceLivekitApiKey ? { voiceLivekitApiKey: values.voiceLivekitApiKey } : {}),
      ...(values.voiceLivekitApiSecret
        ? { voiceLivekitApiSecret: values.voiceLivekitApiSecret }
        : {}),
    };
  }

  const ownerPlatform = values.voiceInboundOwnerPlatform.trim();
  const ownerChatId = values.voiceInboundOwnerChatId.trim();
  let owner: VoiceTelephonyPatch;
  if (!ownerPlatform) {
    owner = { voiceInboundOwnerPlatform: null };
  } else if (!ownerChatId) {
    return {
      ok: false,
      error:
        'Call notices: a destination needs both a platform and a chat id. Add the chat id, or clear the platform to stop delivering call summaries.',
    };
  } else {
    owner = {
      voiceInboundOwnerPlatform: ownerPlatform,
      voiceInboundOwnerChatId: ownerChatId,
      voiceInboundOwnerBotKey: values.voiceInboundOwnerBotKey.trim() || null,
    };
  }

  const allowlist = values.voiceInboundAllowlist.map((n) => n.trim()).filter((n) => n.length > 0);

  const bargeIn: Record<string, VoiceBargeInPatch> = {};
  for (const surface of BARGE_IN_SURFACES) {
    const tuning = values.voiceBargeIn[surface];
    if (!tuning) continue;
    const entry: VoiceBargeInPatch = {
      ...(tuning.energyThreshold === null ? {} : { energyThreshold: tuning.energyThreshold }),
      ...(tuning.minSpeechMs === null ? {} : { minSpeechMs: tuning.minSpeechMs }),
      ...(tuning.silenceMs === null ? {} : { silenceMs: tuning.silenceMs }),
    };
    // A surface with nothing set was never tuned, which is a different fact
    // from "tuned to the defaults" — so it is omitted, not written empty.
    if (Object.keys(entry).length > 0) bargeIn[surface] = entry;
  }

  return {
    ok: true,
    patch: {
      ...trunk,
      ...livekit,
      ...owner,
      voiceInboundAllowlist: allowlist.length > 0 ? allowlist : null,
      voiceInboundReceptionist: values.voiceInboundReceptionist.trim() || null,
      voiceInboundConcurrencyCap: values.voiceInboundConcurrencyCap ?? null,
      voiceInboundPerCallerPerHour: values.voiceInboundPerCallerPerHour ?? null,
      voiceInboundDailyBudgetUsd: values.voiceInboundDailyBudgetUsd ?? null,
      voiceInboundPrewarm: inboundPrewarmOrNull(values.voiceInboundPrewarm),
      voiceBargeIn: bargeIn,
    },
  };
}
