import { randomBytes } from 'node:crypto';
import {
  isVoiceChannelPlatform,
  normalizeAuxTimeoutSeconds,
  secretRefFromValue,
  VOICE_CHANNEL_PLATFORMS,
  type VoiceBargeInTuning,
} from '@ethosagent/config';
import { EthosError, type SecretsResolver } from '@ethosagent/types';
import {
  type ConfigRepository,
  parseRealtimeRoster,
  parseSttRoster,
  parseTtsRoster,
  type RawProviderEntry,
} from '../repositories/config.repository';

// Read/update the parts of `~/.ethos/config.yaml` the web UI exposes. The
// raw API key NEVER leaves this layer — `get` returns a redacted preview
// (`sk-…abc1`) so the UI can show "which key is active" without leaking
// it. `update` accepts a fresh key but does not echo it back.

// Voice VAD / barge-in tuning surfaced as flat `display.voice_*` passthrough
// keys. These defaults MUST stay byte-equal to `DEFAULT_VOICE_TUNING` in
// apps/web/src/features/voice/batch-voice-call-client.ts (the driver's single
// source of truth) — web-api can't import the browser bundle, so the values are
// duplicated here. `min`/`max` mirror the Zod bounds on ConfigUpdateInput; the
// service clamps to them so a direct (non-RPC) caller can't persist out-of-range.
type VoiceTuningField =
  | 'voiceEndpointSilenceMs'
  | 'voiceBargeThreshold'
  | 'voiceBargeSustainMs'
  | 'voiceSpeechThreshold'
  | 'voiceSpeechMinMs';
interface VoiceTuningSpec {
  field: VoiceTuningField;
  default: number;
  min: number;
  max: number;
}
const VOICE_TUNING = {
  'display.voice_endpoint_silence_ms': {
    field: 'voiceEndpointSilenceMs',
    default: 700,
    min: 300,
    max: 1500,
  },
  'display.voice_barge_threshold': {
    field: 'voiceBargeThreshold',
    default: 0.06,
    min: 0.02,
    max: 0.2,
  },
  'display.voice_barge_sustain_ms': {
    field: 'voiceBargeSustainMs',
    default: 250,
    min: 100,
    max: 800,
  },
  'display.voice_speech_threshold': {
    field: 'voiceSpeechThreshold',
    default: 0.02,
    min: 0.005,
    max: 0.1,
  },
  'display.voice_speech_min_ms': { field: 'voiceSpeechMinMs', default: 150, min: 100, max: 500 },
} satisfies Record<string, VoiceTuningSpec>;

/** Resolve a stored `display.voice_*` value to a number, falling back to its
 *  default when unset or unparseable. */
function readVoiceTuning(
  passthrough: Record<string, string>,
  key: string,
  fallback: number,
): number {
  const raw = passthrough[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * `display.voice_*` → `VoiceBargeInTuning` compatibility read-through for the
 * BROWSER surface (Conflict 2, L1 — plan §7). `voice.bargeIn.browser` is the
 * modern knob; these flat keys predate it and must keep tuning calls until an
 * operator migrates. Unlike {@link readVoiceTuning}, this does NOT apply
 * `VOICE_TUNING`'s defaults — only a key the operator actually SET is
 * returned, so a deployment that never touched `display.voice_*` contributes
 * nothing here and the session keeps its own built-in defaults, exactly as it
 * did before `voice.bargeIn.browser` existed. The caller
 * (`buildVoiceStack`'s `createSession`) applies precedence: an explicit
 * `voice.bargeIn.browser` always wins over this fallback.
 *
 * Only three of the five `display.voice_*` knobs have a `VoiceBargeInTuning`
 * counterpart. `display.voice_speech_threshold` / `display.voice_speech_min_ms`
 * tuned the browser's own local endpointer, which the streaming pipeline lane
 * no longer has (`VoiceSession` owns VAD/endpointing now) — there is nothing
 * left for them to read into here.
 */
export function readLegacyBrowserBargeInTuning(
  passthrough: Record<string, string>,
): VoiceBargeInTuning {
  const read = (key: keyof typeof VOICE_TUNING): number | undefined => {
    const spec = VOICE_TUNING[key];
    const raw = passthrough[key];
    if (raw === undefined || raw === '') return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n)) return undefined;
    return Math.min(spec.max, Math.max(spec.min, n));
  };
  const energyThreshold = read('display.voice_barge_threshold');
  const minSpeechMs = read('display.voice_barge_sustain_ms');
  const silenceMs = read('display.voice_endpoint_silence_ms');
  return {
    ...(energyThreshold !== undefined ? { energyThreshold } : {}),
    ...(minSpeechMs !== undefined ? { minSpeechMs } : {}),
    ...(silenceMs !== undefined ? { silenceMs } : {}),
  };
}

// ---------------------------------------------------------------------------
// Settings-page passthrough groups
//
// Every field below maps 1:1 onto a flat config.yaml key that has no other UI
// home (channel bots, teams, evolver, and toolSettings are managed by their
// own RPC namespaces). All of them live in the repository's `passthrough`
// map — the repo round-trips unknown keys verbatim, so the service is the
// single place that knows the key names, defaults, and bounds. Bounds mirror
// packages/config's own parse validation; the RPC layer re-enforces them via
// the Zod schemas in @ethosagent/web-contracts.
// ---------------------------------------------------------------------------

/** `retention.<subkey>` / `personalities.<id>.retention.<subkey>` subkeys. */
export type RetentionSubkey =
  | 'messages'
  | 'traces'
  | 'spans'
  | 'blobs'
  | 'archive'
  | 'events.error'
  | 'events.audit'
  | 'events.channel'
  | 'events.install';

const RETENTION_SUBKEYS: readonly RetentionSubkey[] = [
  'messages',
  'traces',
  'spans',
  'blobs',
  'archive',
  'events.error',
  'events.audit',
  'events.channel',
  'events.install',
];

/** Duration grammar accepted by extensions/observability-sqlite parseDuration. */
const RETENTION_DURATION_RE = /^(forever|\d+[dwmy])$/;

/** Record keys serialized as `<prefix>.<key>.<field>` config.yaml lines must
 *  survive the line-based format — same identifier rule as bot ids. */
const RECORD_KEY_RE = /^[A-Za-z0-9_-]+$/;

/** Redacted view of one auxiliary model slot (`auxiliary.<slot>.*`). */
export interface AuxModelGetResult {
  model: string | null;
  provider: string | null;
  apiKeyPreview: string | null;
  baseUrl: string | null;
}

/** Update shape for an auxiliary model slot; null clears the stored key. */
export interface AuxModelUpdateInput {
  model?: string | null;
  provider?: string | null;
  /** Write-only; never echoed back. */
  apiKey?: string | null;
  baseUrl?: string | null;
}

/** One inbound webhook (`webhooks.<hookId>.*`) with the secret redacted. */
export interface WebhookGetResult {
  personalityId: string;
  secretPreview: string;
  sessionKey: string | null;
  prefilter: string | null;
  prefilterTimeoutSeconds: number | null;
  mode: 'sync' | 'ack';
}

/** Update shape for one webhook. `secret` is write-only: omitted keeps the
 *  stored secret; a brand-new hook without one gets a generated secret. */
export interface WebhookUpdateInput {
  personalityId: string;
  secret?: string;
  sessionKey?: string;
  prefilter?: string;
  prefilterTimeoutSeconds?: number;
  mode?: 'sync' | 'ack';
}

/** One `/name` quick command (`quick_commands.<name>.*`). */
export type QuickCommandGetResult =
  | { type: 'exec'; command: string; gateway: boolean; channels: string[] }
  | { type: 'reply'; reply: string; gateway: boolean; channels: string[] };

export type QuickCommandUpdateInput =
  | { type: 'exec'; command: string; gateway?: boolean; channels?: string[] }
  | { type: 'reply'; reply: string; gateway?: boolean; channels?: string[] };

/** One entry of the named TTS roster (`voice.tts.providers.<name>.*`), API key
 *  redacted to a preview exactly like `auxiliary.tts.apiKey`. */
export interface VoiceProviderGetResult {
  provider: string;
  model: string | null;
  apiKeyPreview: string | null;
  voice: string | null;
  baseUrl: string | null;
  command: string | null;
  outputFormat: 'opus' | 'mp3' | 'wav' | 'pcm' | null;
  /** Seconds — the unit `command-tts` reads. */
  timeout: number | null;
  maxTextLength: number | null;
}

/** Update shape for one TTS roster entry. `apiKey` is write-only: the form never
 *  receives it, so an omitted field KEEPS the stored key rather than clearing
 *  it (same rule as `webhooks.<id>.secret`). */
export interface VoiceProviderUpdateInput {
  provider: string;
  model?: string;
  apiKey?: string;
  voice?: string;
  baseUrl?: string;
  command?: string;
  outputFormat?: 'opus' | 'mp3' | 'wav' | 'pcm';
  timeout?: number;
  maxTextLength?: number;
}

/** One entry of the named STT roster (`voice.stt.providers.<name>.*`). The
 *  mirror of {@link VoiceProviderGetResult} over the STT field set. */
export interface VoiceSttProviderGetResult {
  provider: string;
  model: string | null;
  apiKeyPreview: string | null;
  baseUrl: string | null;
  command: string | null;
  /** Seconds — the unit `command-stt` reads. */
  timeout: number | null;
}

/** Update shape for one STT roster entry. Same write-only `apiKey` rule. */
export interface VoiceSttProviderUpdateInput {
  provider: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  command?: string;
  timeout?: number;
}

/** One entry of the named realtime roster (`voice.realtime.providers.<name>.*`).
 *  The speech-to-speech sibling of the two above — no command or timeout,
 *  because there is no shelled-out request to bound; instead a per-minute rate,
 *  which is what a duplex session is billed on. */
export interface VoiceRealtimeProviderGetResult {
  provider: string;
  model: string | null;
  apiKeyPreview: string | null;
  baseUrl: string | null;
  voice: string | null;
  /** USD per minute of audio. */
  costPerMinuteUsd: number | null;
}

/** Update shape for one realtime roster entry. Same write-only `apiKey` rule. */
export interface VoiceRealtimeProviderUpdateInput {
  provider: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  voice?: string;
  costPerMinuteUsd?: number;
}

// -- passthrough read helpers ------------------------------------------------

function passStr(p: Record<string, string>, key: string): string | null {
  const v = p[key];
  return v ? v : null;
}

function passNum(p: Record<string, string>, key: string, fallback: number): number {
  const raw = p[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function passNumOrNull(p: Record<string, string>, key: string): number | null {
  const raw = p[key];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * SHIM — `auxiliary.{asr,tts}.timeout` is seconds, but the Settings page
 * shipped it labelled and bounded in milliseconds, so a stored value may be ms.
 * The parse-site shim in `@ethosagent/config` does NOT reach here: this reads
 * the raw passthrough map, not the typed `EthosConfig.auxiliary`. Same helper,
 * second read path — so the page shows what the runtime is actually using, and
 * the operator's next Save writes it back in seconds.
 *
 * Removed with the parse-site shim (`aux-timeout-shim-removal`).
 */
function auxTimeoutSeconds(raw: number | null): number | null {
  return raw === null ? null : normalizeAuxTimeoutSeconds(raw).seconds;
}

/** `fallback` when unset; otherwise strict `'true'` comparison. */
function passBool(p: Record<string, string>, key: string, fallback: boolean): boolean {
  const v = p[key];
  if (v === undefined || v === '') return fallback;
  return v === 'true';
}

/** Comma-separated list value → trimmed entries (matches packages/config splitList). */
function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Like {@link pickEnum} but with no default — an unset key stays null. */
function pickEnumOrNull<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): T | null {
  return allowed.find((a) => a === value) ?? null;
}

function pickEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  const match = allowed.find((a) => a === value);
  return match ?? fallback;
}

function parseRetentionMap(
  p: Record<string, string>,
  prefix: string,
): Partial<Record<RetentionSubkey, string>> {
  const out: Partial<Record<RetentionSubkey, string>> = {};
  for (const sub of RETENTION_SUBKEYS) {
    const v = p[`${prefix}${sub}`];
    if (v && RETENTION_DURATION_RE.test(v)) out[sub] = v;
  }
  return out;
}

function parsePersonalityRetention(
  p: Record<string, string>,
): Record<string, Partial<Record<RetentionSubkey, string>>> {
  const pids = new Set<string>();
  for (const key of Object.keys(p)) {
    const m = key.match(/^personalities\.([^.]+)\.retention\./);
    if (m?.[1]) pids.add(m[1]);
  }
  const out: Record<string, Partial<Record<RetentionSubkey, string>>> = {};
  for (const pid of pids) {
    const map = parseRetentionMap(p, `personalities.${pid}.retention.`);
    if (Object.keys(map).length > 0) out[pid] = map;
  }
  return out;
}

function parseWebhooks(p: Record<string, string>): Record<string, WebhookGetResult> {
  const out: Record<string, WebhookGetResult> = {};
  for (const [key, value] of Object.entries(p)) {
    const m = key.match(
      /^webhooks\.([^.]+)\.(personalityId|secret|sessionKey|prefilter|prefilterTimeoutSeconds|mode)$/,
    );
    const id = m?.[1];
    const field = m?.[2];
    if (!id || !field) continue;
    const slot = out[id] ?? {
      personalityId: '',
      secretPreview: '<unset>',
      sessionKey: null,
      prefilter: null,
      prefilterTimeoutSeconds: null,
      mode: 'sync' as const,
    };
    out[id] = slot;
    switch (field) {
      case 'personalityId':
        slot.personalityId = value;
        break;
      case 'secret':
        slot.secretPreview = redactKey(value);
        break;
      case 'sessionKey':
        slot.sessionKey = value || null;
        break;
      case 'prefilter':
        slot.prefilter = value || null;
        break;
      case 'prefilterTimeoutSeconds': {
        const n = Number(value);
        if (Number.isInteger(n)) slot.prefilterTimeoutSeconds = n;
        break;
      }
      case 'mode':
        if (value === 'ack') slot.mode = 'ack';
        break;
    }
  }
  return out;
}

function parseQuickCommands(p: Record<string, string>): Record<string, QuickCommandGetResult> {
  const bag: Record<string, Record<string, string>> = {};
  for (const [key, value] of Object.entries(p)) {
    const m = key.match(/^quick_commands\.([^.]+)\.(type|command|reply|gateway|channels)$/);
    const name = m?.[1];
    const field = m?.[2];
    if (!name || !field) continue;
    const slot = bag[name] ?? {};
    bag[name] = slot;
    slot[field] = value;
  }
  const out: Record<string, QuickCommandGetResult> = {};
  for (const [name, kv] of Object.entries(bag)) {
    const gateway = kv.gateway === 'true';
    const channels = splitList(kv.channels);
    if (kv.type === 'exec' && kv.command) {
      out[name] = { type: 'exec', command: kv.command, gateway, channels };
    } else if (kv.type === 'reply' && kv.reply) {
      out[name] = { type: 'reply', reply: kv.reply, gateway, channels };
    }
  }
  return out;
}

/**
 * The named rosters, redacted for the browser.
 *
 * Entry discovery is `parseTtsRoster` / `parseSttRoster` (the repository), so
 * this surface and the VoiceService that actually speaks and listens through
 * them agree on what an entry is; the only thing added here is redaction — the
 * raw key never leaves this layer, same as `auxiliary.tts.apiKey`.
 */
async function parseVoiceTtsProviders(
  p: Record<string, string>,
  keyPreview: (value: string | undefined) => Promise<string | null>,
): Promise<Record<string, VoiceProviderGetResult>> {
  const out: Record<string, VoiceProviderGetResult> = {};
  for (const [name, entry] of Object.entries(parseTtsRoster(p))) {
    out[name] = {
      provider: entry.provider,
      model: entry.model ?? null,
      apiKeyPreview: await keyPreview(entry.apiKey),
      voice: entry.voice ?? null,
      baseUrl: entry.baseUrl ?? null,
      command: entry.command ?? null,
      outputFormat: entry.outputFormat ?? null,
      timeout: entry.timeout ?? null,
      maxTextLength: entry.maxTextLength ?? null,
    };
  }
  return out;
}

async function parseVoiceSttProviders(
  p: Record<string, string>,
  keyPreview: (value: string | undefined) => Promise<string | null>,
): Promise<Record<string, VoiceSttProviderGetResult>> {
  const out: Record<string, VoiceSttProviderGetResult> = {};
  for (const [name, entry] of Object.entries(parseSttRoster(p))) {
    out[name] = {
      provider: entry.provider,
      model: entry.model ?? null,
      apiKeyPreview: await keyPreview(entry.apiKey),
      baseUrl: entry.baseUrl ?? null,
      command: entry.command ?? null,
      timeout: entry.timeout ?? null,
    };
  }
  return out;
}

async function parseVoiceRealtimeProviders(
  p: Record<string, string>,
  keyPreview: (value: string | undefined) => Promise<string | null>,
): Promise<Record<string, VoiceRealtimeProviderGetResult>> {
  const out: Record<string, VoiceRealtimeProviderGetResult> = {};
  for (const [name, entry] of Object.entries(parseRealtimeRoster(p))) {
    out[name] = {
      provider: entry.provider,
      model: entry.model ?? null,
      apiKeyPreview: await keyPreview(entry.apiKey),
      baseUrl: entry.baseUrl ?? null,
      voice: entry.voice ?? null,
      costPerMinuteUsd: entry.costPerMinuteUsd ?? null,
    };
  }
  return out;
}

/**
 * `voice.channels.<platform>.ttsOut` → a flat platform→boolean map.
 *
 * Unknown platforms and non-boolean values are dropped, matching what the
 * yaml parser in `@ethosagent/config` already did to them on load — the read
 * path reports what the deployment ACTUALLY has, not what someone typed. The
 * write path is stricter; see `validateSettingsPatch`.
 */
function parseVoiceChannelTtsOut(p: Record<string, string>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(p)) {
    const platform = key.match(/^voice\.channels\.([^.]+)\.ttsOut$/)?.[1];
    if (!platform || !isVoiceChannelPlatform(platform)) continue;
    if (value === 'true' || value === 'false') out[platform] = value === 'true';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Telephony (`voice.trunk` / `voice.livekit` / `voice.inbound` /
// `voice.bargeIn` / `voice.bots`)
//
// All five families are passthrough keys — the repository round-trips them
// verbatim and the CLI's own parser is the one that gives them meaning. What
// this layer adds is redaction (the trunk password, the webhook secret and the
// LiveKit credentials never leave here in the clear) and refusal of values the
// CLI parser would reject, so a bad save is a response the operator sees rather
// than a parse error on the agent's next boot.
// ---------------------------------------------------------------------------

/** The audio surfaces `voice.bargeIn.<surface>` accepts. Mirrors
 *  `VOICE_BARGE_IN_SURFACES` in packages/config — web-api has no dependency on
 *  it, the same precedent as VOICE_TUNING above. `browser` since L1 (plan §7
 *  "Conflict 2"): the browser pipeline lane runs on the same `VoiceSession`
 *  orchestrator as `call`/`satellite` now, and reads the legacy
 *  `display.voice_*` keys at the top of this file as a fallback only when
 *  `voice.bargeIn.browser` is not configured — see
 *  `readLegacyBrowserBargeInTuning` below. */
export const VOICE_BARGE_IN_SURFACES = ['call', 'satellite', 'browser'] as const;

export type VoiceBargeInSurface = (typeof VOICE_BARGE_IN_SURFACES)[number];

const VOICE_TRUNK_PROVIDERS = ['twilio', 'telnyx', 'generic', 'livekit'] as const;
const VOICE_TRUNK_CODECS = ['opus', 'g711'] as const;
const VOICE_INBOUND_PREWARM_MODES = ['allowlisted', 'none', 'all'] as const;

/** The three `voice.livekit.*` keys the CLI parser requires together — a block
 *  missing any one of them is a parse error, not a partial config. */
const VOICE_LIVEKIT_KEYS = [
  'voice.livekit.url',
  'voice.livekit.apiKey',
  'voice.livekit.apiSecret',
] as const;

export interface VoiceBargeInTuningResult {
  energyThreshold: number | null;
  minSpeechMs: number | null;
  silenceMs: number | null;
}

export interface VoiceBargeInTuningUpdate {
  energyThreshold?: number;
  minSpeechMs?: number;
  silenceMs?: number;
}

export interface VoiceBotGetResult {
  id: string | null;
  match: string;
  bind: { type: 'personality' | 'team'; name: string; allowSlashSwitch: boolean };
}

export interface VoiceBotUpdateInput {
  id?: string;
  match: string;
  bind: { type: 'personality' | 'team'; name: string; allowSlashSwitch?: boolean };
}

/**
 * `voice.bargeIn.<surface>.<field>` → a surface → thresholds map.
 *
 * Unknown surfaces and fields are dropped on READ, matching what the CLI's
 * parser reports for a file it refused to build a tuning from — the read path
 * describes what the deployment actually has. The write path refuses them; see
 * `validateSettingsPatch`.
 */
function parseVoiceBargeIn(p: Record<string, string>): Record<string, VoiceBargeInTuningResult> {
  const out: Record<string, VoiceBargeInTuningResult> = {};
  for (const key of Object.keys(p)) {
    const surface = key.match(/^voice\.bargeIn\.([^.]+)\.[^.]+$/)?.[1];
    if (!surface || !(VOICE_BARGE_IN_SURFACES as readonly string[]).includes(surface)) continue;
    out[surface] ??= { energyThreshold: null, minSpeechMs: null, silenceMs: null };
  }
  for (const surface of Object.keys(out)) {
    out[surface] = {
      energyThreshold: passNumOrNull(p, `voice.bargeIn.${surface}.energyThreshold`),
      minSpeechMs: passNumOrNull(p, `voice.bargeIn.${surface}.minSpeechMs`),
      silenceMs: passNumOrNull(p, `voice.bargeIn.${surface}.silenceMs`),
    };
  }
  return out;
}

/**
 * `voice.bots.<n>.*` → the routing table, in file order.
 *
 * Indexes are sorted NUMERICALLY, not lexicographically: `Object.keys` on the
 * flat map yields strings, and the default sort would put bot 10 before bot 2 —
 * a table that reorders itself the moment a deployment has ten numbers.
 * Entries missing `match` or a complete `bind` are dropped, exactly as the CLI
 * parser drops them.
 */
function parseVoiceBots(p: Record<string, string>): VoiceBotGetResult[] {
  const indexes = new Set<number>();
  for (const key of Object.keys(p)) {
    const idx = key.match(/^voice\.bots\.(\d+)\./)?.[1];
    if (idx !== undefined) indexes.add(Number(idx));
  }
  const bots: VoiceBotGetResult[] = [];
  for (const idx of [...indexes].sort((a, b) => a - b)) {
    const match = p[`voice.bots.${idx}.match`];
    const type = p[`voice.bots.${idx}.bind.type`];
    const name = p[`voice.bots.${idx}.bind.name`];
    if (!match || !name || (type !== 'personality' && type !== 'team')) continue;
    bots.push({
      id: passStr(p, `voice.bots.${idx}.id`),
      match,
      bind: {
        type,
        name,
        allowSlashSwitch: p[`voice.bots.${idx}.bind.allowSlashSwitch`] === 'true',
      },
    });
  }
  return bots;
}

function parseChannelToolsets(p: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(p)) {
    const m = key.match(/^channel_toolsets\.([^.]+)$/);
    if (m?.[1]) out[m[1]] = splitList(value);
  }
  return out;
}

/** `voice.trunk.*` update fields. Listed rather than derived so the "did the
 *  operator touch the trunk at all" question has one answer. */
const TRUNK_PATCH_KEYS = [
  'voiceTrunkProvider',
  'voiceTrunkId',
  'voiceTrunkFromNumber',
  'voiceTrunkUsername',
  'voiceTrunkPassword',
  'voiceTrunkWebhookSecret',
  'voiceTrunkWebhookPath',
  'voiceTrunkCodec',
] as const;

const LIVEKIT_PATCH_KEYS = [
  'voiceLivekitUrl',
  'voiceLivekitApiKey',
  'voiceLivekitApiSecret',
] as const;

/** Every telephony update field, in one list: it decides whether `update` has
 *  to read the current config back (for secret carry-over and the
 *  required-together checks) and it is spliced into SETTINGS_PATCH_KEYS so none
 *  of these ever reaches the repository's typed patch. */
const TELEPHONY_PATCH_KEYS = [
  ...TRUNK_PATCH_KEYS,
  ...LIVEKIT_PATCH_KEYS,
  'voiceInboundAllowlist',
  'voiceInboundReceptionist',
  'voiceInboundConcurrencyCap',
  'voiceInboundPerCallerPerHour',
  'voiceInboundDailyBudgetUsd',
  'voiceInboundPrewarm',
  'voiceInboundOwnerPlatform',
  'voiceInboundOwnerChatId',
  'voiceInboundOwnerBotKey',
  'voiceBargeIn',
  'voiceBots',
] as const;

/** ConfigUpdateInput fields handled via passthrough writes — stripped from the
 *  repository patch (the repo only knows its typed RawConfig fields). */
const SETTINGS_PATCH_KEYS = [
  'apiVersion',
  'verbose',
  'displayVerbosity',
  'displayBusyInputMode',
  'displayToolPreviewLength',
  'displayResumeHint',
  'displayResumeRecapTurns',
  'displayBellOnComplete',
  'compaction',
  'memoryVault',
  'memoryApproval',
  'memoryConsolidation',
  'memoryCapture',
  'background',
  'retention',
  'personalityRetention',
  'webhooks',
  'quickCommands',
  'channelToolsets',
  'voiceTtsProviders',
  'voiceSttProviders',
  'voiceRealtimeProviders',
  'voiceChannelTtsOut',
  'wakeRoutes',
  'nightlyPass',
  'weeklyDigest',
  'modelCatalog',
  'logsRotation',
  'webSearchBackend',
  'webExtractBackend',
  'auxCompression',
  'auxVision',
  'auxWeb',
  'a2aEnabled',
  'pluginsAutoInstall',
  'webBaseUrl',
  ...TELEPHONY_PATCH_KEYS,
] as const;

// -- update-patch validation -------------------------------------------------
// Mirrors packages/config's parse validation so a direct (non-RPC) caller
// can't persist values the CLI loader would reject or silently drop. The RPC
// layer re-enforces the same bounds via Zod in @ethosagent/web-contracts.

function invalidValue(field: string, requirement: string): never {
  throw new EthosError({
    code: 'CONFIG_INVALID',
    cause: `${field} ${requirement}`,
    action: 'Correct the value and retry the update.',
  });
}

function checkFraction(field: string, v: number | null | undefined): void {
  if (v === undefined || v === null) return;
  if (!Number.isFinite(v) || v <= 0 || v > 1) invalidValue(field, 'must be a fraction in (0,1]');
}

function checkInt(
  field: string,
  v: number | null | undefined,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): void {
  if (v === undefined || v === null) return;
  if (!Number.isInteger(v) || v < min || v > max) {
    invalidValue(
      field,
      max === Number.MAX_SAFE_INTEGER
        ? `must be an integer >= ${min}`
        : `must be an integer between ${min} and ${max}`,
    );
  }
}

function checkNonNegative(field: string, v: number | null | undefined): void {
  if (v === undefined || v === null) return;
  if (!Number.isFinite(v) || v < 0) invalidValue(field, 'must be a non-negative number');
}

function checkPositive(field: string, v: number | null | undefined): void {
  if (v === undefined || v === null) return;
  if (!Number.isFinite(v) || v <= 0) invalidValue(field, 'must be a positive number');
}

function checkRecordKey(field: string, key: string): void {
  if (!RECORD_KEY_RE.test(key)) {
    invalidValue(field, 'must be an identifier matching [A-Za-z0-9_-]+');
  }
}

function checkRetentionMap(field: string, map: Partial<Record<RetentionSubkey, string>>): void {
  for (const [sub, dur] of Object.entries(map)) {
    if (!(RETENTION_SUBKEYS as readonly string[]).includes(sub)) {
      invalidValue(`${field}.${sub}`, 'is not a retention subkey');
    }
    if (dur !== undefined && !RETENTION_DURATION_RE.test(dur)) {
      invalidValue(`${field}.${sub}`, "must be 'forever' or <n> followed by d|w|m|y");
    }
  }
}

function validateSettingsPatch(patch: ConfigUpdateInput): void {
  checkInt('displayToolPreviewLength', patch.displayToolPreviewLength, 0);
  checkInt('displayResumeRecapTurns', patch.displayResumeRecapTurns, 0, 10);
  if (patch.compaction) {
    checkFraction('compaction.pressure', patch.compaction.pressure);
    checkFraction('compaction.target', patch.compaction.target);
    checkInt('compaction.gateDelta', patch.compaction.gateDelta, 0);
  }
  if (patch.memoryApproval) {
    const mode = patch.memoryApproval.mode;
    if (mode !== undefined && mode !== null && !['off', 'automated', 'all'].includes(mode)) {
      invalidValue('memoryApproval.mode', "must be one of 'off', 'automated', 'all'");
    }
    checkInt('memoryApproval.cap', patch.memoryApproval.cap, 1);
    checkInt('memoryApproval.ttlDays', patch.memoryApproval.ttlDays, 1);
  }
  if (patch.memoryConsolidation) {
    const m = patch.memoryConsolidation;
    checkPositive('memoryConsolidation.halfLifeDays', m.halfLifeDays);
    if (m.threshold !== undefined && m.threshold !== null) {
      if (!Number.isFinite(m.threshold) || m.threshold < 0 || m.threshold > 1) {
        invalidValue('memoryConsolidation.threshold', 'must be a number in [0,1]');
      }
    }
    checkFraction('memoryConsolidation.flushThreshold', m.flushThreshold);
    checkInt('memoryConsolidation.timeboxMs', m.timeboxMs, 0);
    checkInt('memoryConsolidation.maxTokens', m.maxTokens, 0);
    checkInt('memoryConsolidation.maxDeltaChars', m.maxDeltaChars, 0);
    checkInt('memoryConsolidation.minMessagesSinceFlush', m.minMessagesSinceFlush, 0);
  }
  if (patch.memoryCapture) {
    checkInt('memoryCapture.maxPerHour', patch.memoryCapture.maxPerHour, 1);
    checkInt('memoryCapture.maxPerDay', patch.memoryCapture.maxPerDay, 1);
  }
  if (patch.background) {
    const b = patch.background;
    checkInt('background.maxConcurrentJobs', b.maxConcurrentJobs, 1);
    checkInt('background.maxJobsPerRoot', b.maxJobsPerRoot, 1);
    checkInt('background.maxJobsPerPersonality', b.maxJobsPerPersonality, 1);
    checkNonNegative('background.defaultMaxCostUsd', b.defaultMaxCostUsd);
    checkNonNegative('background.maxRootBackgroundUsd', b.maxRootBackgroundUsd);
    checkInt('background.queuedTtlMs', b.queuedTtlMs, 0);
    checkInt('background.staleMs', b.staleMs, 0);
    checkInt('background.heartbeatMs', b.heartbeatMs, 0);
    checkInt('background.retentionDays', b.retentionDays, 1);
  }
  if (patch.modelCatalog) checkPositive('modelCatalog.ttlHours', patch.modelCatalog.ttlHours);
  if (patch.logsRotation) {
    checkInt('logsRotation.maxBytes', patch.logsRotation.maxBytes, 1);
    checkInt('logsRotation.maxFiles', patch.logsRotation.maxFiles, 1);
  }
  if (patch.retention) checkRetentionMap('retention', patch.retention);
  if (patch.personalityRetention) {
    for (const [pid, map] of Object.entries(patch.personalityRetention)) {
      checkRecordKey(`personalityRetention.${pid}`, pid);
      if (map) checkRetentionMap(`personalityRetention.${pid}`, map);
    }
  }
  if (patch.channelToolsets) {
    for (const platform of Object.keys(patch.channelToolsets)) {
      checkRecordKey(`channelToolsets.${platform}`, platform);
    }
  }
  if (patch.quickCommands) {
    for (const [name, qc] of Object.entries(patch.quickCommands)) {
      checkRecordKey(`quickCommands.${name}`, name);
      if (!qc) continue;
      if (qc.type === 'exec' && !qc.command) {
        invalidValue(`quickCommands.${name}.command`, 'is required for type exec');
      }
      if (qc.type === 'reply' && !qc.reply) {
        invalidValue(`quickCommands.${name}.reply`, 'is required for type reply');
      }
    }
  }
  if (patch.voiceTtsProviders) {
    for (const [name, entry] of Object.entries(patch.voiceTtsProviders)) {
      // The name becomes a `voice.tts.providers.<name>.<field>` line; outside
      // this charset the CLI's parser would not match it and the entry would
      // vanish on the next read.
      checkRecordKey(`voiceTtsProviders.${name}`, name);
      if (!entry?.provider) {
        invalidValue(`voiceTtsProviders.${name}.provider`, 'is required');
      }
      checkInt(`voiceTtsProviders.${name}.timeout`, entry.timeout, 1, 3600);
      checkInt(`voiceTtsProviders.${name}.maxTextLength`, entry.maxTextLength, 100, 100_000);
    }
  }
  if (patch.voiceSttProviders) {
    for (const [name, entry] of Object.entries(patch.voiceSttProviders)) {
      checkRecordKey(`voiceSttProviders.${name}`, name);
      if (!entry?.provider) {
        invalidValue(`voiceSttProviders.${name}.provider`, 'is required');
      }
      checkInt(`voiceSttProviders.${name}.timeout`, entry.timeout, 1, 3600);
    }
  }
  if (patch.voiceRealtimeProviders) {
    for (const [name, entry] of Object.entries(patch.voiceRealtimeProviders)) {
      checkRecordKey(`voiceRealtimeProviders.${name}`, name);
      if (!entry?.provider) {
        invalidValue(`voiceRealtimeProviders.${name}.provider`, 'is required');
      }
      // A rate is money per minute, so fractions are the norm — `checkPositive`,
      // not `checkInt`. The CLI's parser drops a non-positive rate; refusing it
      // here means the operator hears about it instead of it vanishing.
      checkPositive(`voiceRealtimeProviders.${name}.costPerMinuteUsd`, entry.costPerMinuteUsd);
    }
  }
  if (patch.wakeRoutes) {
    for (const [id, route] of Object.entries(patch.wakeRoutes)) {
      // The id becomes a `voice.wake.routes.<id>.<field>` line; outside this
      // charset neither parser would match it and the route would vanish on
      // the next read — a wake phrase that silently stops existing.
      checkRecordKey(`wakeRoutes.${id}`, id);
      if (!route?.phrase?.trim()) invalidValue(`wakeRoutes.${id}.phrase`, 'is required');
      if (!route?.personality?.trim()) {
        invalidValue(`wakeRoutes.${id}.personality`, 'is required');
      }
    }
  }
  checkPositive('voiceRealtimeSessionBudgetUsd', patch.voiceRealtimeSessionBudgetUsd);
  // Telephony. Bounds mirror packages/config, which makes these PARSE ERRORS
  // rather than dropping them — a budget or concurrency cap that silently
  // vanished is real money on a surface strangers can dial.
  if (
    patch.voiceTrunkProvider !== undefined &&
    patch.voiceTrunkProvider !== null &&
    !(VOICE_TRUNK_PROVIDERS as readonly string[]).includes(patch.voiceTrunkProvider)
  ) {
    invalidValue('voiceTrunkProvider', `must be one of ${VOICE_TRUNK_PROVIDERS.join(', ')}`);
  }
  if (
    patch.voiceTrunkCodec !== undefined &&
    patch.voiceTrunkCodec !== null &&
    !(VOICE_TRUNK_CODECS as readonly string[]).includes(patch.voiceTrunkCodec)
  ) {
    invalidValue('voiceTrunkCodec', `must be one of ${VOICE_TRUNK_CODECS.join(', ')}`);
  }
  if (patch.voiceTrunkWebhookPath && !patch.voiceTrunkWebhookPath.startsWith('/')) {
    invalidValue('voiceTrunkWebhookPath', "must start with '/'");
  }
  if (
    patch.voiceInboundPrewarm !== undefined &&
    patch.voiceInboundPrewarm !== null &&
    !(VOICE_INBOUND_PREWARM_MODES as readonly string[]).includes(patch.voiceInboundPrewarm)
  ) {
    invalidValue('voiceInboundPrewarm', `must be one of ${VOICE_INBOUND_PREWARM_MODES.join(', ')}`);
  }
  checkInt('voiceInboundConcurrencyCap', patch.voiceInboundConcurrencyCap, 1);
  checkInt('voiceInboundPerCallerPerHour', patch.voiceInboundPerCallerPerHour, 1);
  checkPositive('voiceInboundDailyBudgetUsd', patch.voiceInboundDailyBudgetUsd);
  if (patch.voiceBargeIn) {
    for (const [surface, tuning] of Object.entries(patch.voiceBargeIn)) {
      // REFUSED, not dropped: a threshold typed against a misspelled surface is
      // not a slightly different setting, it is no tuning at all — and here
      // there is a caller waiting to be told.
      if (!(VOICE_BARGE_IN_SURFACES as readonly string[]).includes(surface)) {
        invalidValue(
          `voiceBargeIn.${surface}`,
          `is not a barge-in surface (${VOICE_BARGE_IN_SURFACES.join(', ')})`,
        );
      }
      if (!tuning) continue;
      const energy = tuning.energyThreshold;
      if (energy !== undefined && (!Number.isFinite(energy) || energy <= 0 || energy > 1)) {
        invalidValue(`voiceBargeIn.${surface}.energyThreshold`, 'must be a number in (0, 1]');
      }
      checkInt(`voiceBargeIn.${surface}.minSpeechMs`, tuning.minSpeechMs, 1);
      checkInt(`voiceBargeIn.${surface}.silenceMs`, tuning.silenceMs, 1);
    }
  }
  if (patch.voiceBots) {
    for (const [index, bot] of patch.voiceBots.entries()) {
      if (!bot?.match?.trim()) invalidValue(`voiceBots.${index}.match`, 'is required');
      // The id becomes part of a `voice.bots.<n>.id` line and is read back as a
      // lane-key component; outside this charset it would not survive the round
      // trip.
      if (bot.id !== undefined) checkRecordKey(`voiceBots.${index}.id`, bot.id);
      if (bot.bind?.type !== 'personality' && bot.bind?.type !== 'team') {
        invalidValue(`voiceBots.${index}.bind.type`, "must be 'personality' or 'team'");
      }
      if (!bot.bind?.name?.trim()) invalidValue(`voiceBots.${index}.bind.name`, 'is required');
    }
  }
  if (patch.voiceChannelTtsOut) {
    for (const platform of Object.keys(patch.voiceChannelTtsOut)) {
      // REFUSED, not dropped — the opposite of what the yaml parser does with
      // the same typo. There a bad hand-edit must not make the config
      // unloadable, so an unknown platform is ignored; here there is a caller
      // waiting on a response, and silently discarding their toggle would leave
      // the Settings page showing a switch that never took.
      if (!isVoiceChannelPlatform(platform)) {
        invalidValue(
          `voiceChannelTtsOut.${platform}`,
          `is not a voice channel platform (${VOICE_CHANNEL_PLATFORMS.join(', ')})`,
        );
      }
    }
  }
  // Bounds mirror the `parseBoundedInt` ranges in packages/config, which DROPS
  // an out-of-range value; a direct (non-RPC) caller hears about it instead.
  checkInt('voiceTranscodeBitrateKbps', patch.voiceTranscodeBitrateKbps, 8, 320);
  checkInt('voiceTranscodeTimeoutSec', patch.voiceTranscodeTimeoutSec, 1, 600);
  checkInt('voiceArtifactAbandonAfterDays', patch.voiceArtifactAbandonAfterDays, 1, 365);
  checkInt('voiceArtifactMaxTotalMb', patch.voiceArtifactMaxTotalMb, 1, 102_400);
  if (patch.webhooks) {
    for (const [hookId, hook] of Object.entries(patch.webhooks)) {
      checkRecordKey(`webhooks.${hookId}`, hookId);
      if (!hook) continue;
      if (!hook.personalityId) {
        invalidValue(`webhooks.${hookId}.personalityId`, 'is required');
      }
      if (hook.mode !== undefined && hook.mode !== 'sync' && hook.mode !== 'ack') {
        invalidValue(`webhooks.${hookId}.mode`, "must be 'sync' or 'ack'");
      }
      if (hook.prefilterTimeoutSeconds !== undefined) {
        if (!hook.prefilter) {
          invalidValue(`webhooks.${hookId}.prefilterTimeoutSeconds`, "requires 'prefilter'");
        }
        checkInt(
          `webhooks.${hookId}.prefilterTimeoutSeconds`,
          hook.prefilterTimeoutSeconds,
          1,
          600,
        );
      }
    }
  }
}

function parseWebSearchBackend(v: string | undefined): 'exa' | 'tavily' | 'brave' | null {
  return v === 'exa' || v === 'tavily' || v === 'brave' ? v : null;
}

async function parseAuxModel(
  p: Record<string, string>,
  prefix: string,
  keyPreview: (value: string | undefined) => Promise<string | null>,
): Promise<AuxModelGetResult> {
  return {
    model: passStr(p, `${prefix}.model`),
    provider: passStr(p, `${prefix}.provider`),
    apiKeyPreview: await keyPreview(p[`${prefix}.apiKey`]),
    baseUrl: passStr(p, `${prefix}.baseUrl`),
  };
}

export interface ConfigGetResult {
  provider: string;
  model: string;
  apiKeyPreview: string;
  baseUrl: string | null;
  personality: string;
  memory: 'markdown' | 'vector' | 'vault';
  modelRouting: Record<string, string>;
  skin: string;
  providers: Array<{
    provider: string;
    model: string | null;
    apiKeyPreview: string;
    baseUrl: string | null;
  }>;
  approvalMode: 'manual' | 'smart' | 'off';
  verbosity: 'concise' | 'balanced' | 'verbose';
  debugMode: boolean;
  contextLayering: boolean;
  debugPanelEnabled: boolean;
  debugPanelModel: string | null;
  adminEnabled: boolean;
  streamingEdits: 'off' | 'dms' | 'all';
  /** Call Stage treatment (display.call_style): `personality` or a pinned one. */
  callStyle: 'liquid' | 'orb' | 'rings' | 'personality';
  /** In-call overlay color (display.call_accent): `personality` or a hex. */
  callAccent: string;
  autoCompact: boolean;
  memoryConsolidationEnabled: boolean;
  memoryCaptureEnabled: boolean;
  memoryCaptureModel: string | null;
  memoryNotices: boolean;
  voiceChime: boolean;
  voiceEndpointSilenceMs: number;
  voiceBargeThreshold: number;
  voiceBargeSustainMs: number;
  voiceSpeechThreshold: number;
  voiceSpeechMinMs: number;
  voiceProvider: string | null;
  voiceApiKeyPreview: string | null;
  voiceBaseUrl: string | null;
  voiceModel: string | null;
  voiceTtsProvider: string | null;
  voiceTtsApiKeyPreview: string | null;
  voiceTtsVoice: string | null;
  voiceTtsBaseUrl: string | null;
  voiceTtsModel: string | null;
  /** `auxiliary.asr.command` / `auxiliary.tts.command` — the shell templates the
   *  `command-stt` / `command-tts` providers run. */
  voiceSttCommand: string | null;
  voiceTtsCommand: string | null;
  voiceTtsOutputFormat: 'opus' | 'mp3' | 'wav' | 'pcm' | null;
  voiceTtsTimeoutMs: number | null;
  voiceTtsMaxTextLength: number | null;
  voiceSttTimeoutMs: number | null;
  /** `null` = the key is absent = the local-only egress gate is OFF. */
  voiceTrustedPlugins: string[] | null;
  voiceDefaultMode: 'off' | 'mirror_inbound' | 'all' | null;
  /** `voice.channels.<platform>.ttsOut` — an absent platform has no override. */
  voiceChannelTtsOut: Record<string, boolean>;
  voiceTranscodeFfmpegPath: string | null;
  voiceTranscodeBitrateKbps: number | null;
  /** `voice.transcode.timeout`, SECONDS. */
  voiceTranscodeTimeoutSec: number | null;
  voiceArtifactAbandonAfterDays: number | null;
  voiceArtifactMaxTotalMb: number | null;
  // Settings-page additions — see the passthrough-groups comment above.
  apiVersion: string | null;
  verbose: boolean;
  displayVerbosity: 'quiet' | 'default' | 'verbose' | 'debug';
  displayBusyInputMode: 'interrupt' | 'queue' | 'steer';
  displayToolPreviewLength: number;
  displayResumeHint: boolean;
  displayResumeRecapTurns: number;
  displayBellOnComplete: boolean;
  compaction: {
    pressure: number | null;
    target: number | null;
    gateDelta: number | null;
    retryOnOverflow: boolean;
    smallWindow: 'auto' | 'on' | 'off';
  };
  memoryVault: {
    path: string | null;
    agentDir: string | null;
    prefetch: string[];
    exclude: string[];
  };
  memoryApproval: {
    mode: 'off' | 'automated' | 'all';
    cap: number;
    ttlDays: number;
  };
  memoryConsolidation: {
    halfLifeDays: number;
    threshold: number;
    exemptUser: boolean;
    flushThreshold: number;
    timeboxMs: number;
    maxTokens: number;
    maxDeltaChars: number;
    minMessagesSinceFlush: number;
  };
  memoryCapture: {
    provider: string | null;
    apiKeyPreview: string | null;
    baseUrl: string | null;
    maxPerHour: number;
    maxPerDay: number;
  };
  background: {
    enabled: boolean;
    maxConcurrentJobs: number;
    maxJobsPerRoot: number;
    maxJobsPerPersonality: number;
    defaultMaxCostUsd: number;
    maxRootBackgroundUsd: number;
    queuedTtlMs: number;
    staleMs: number;
    heartbeatMs: number;
    retentionDays: number;
  };
  retention: Partial<Record<RetentionSubkey, string>>;
  personalityRetention: Record<string, Partial<Record<RetentionSubkey, string>>>;
  webhooks: Record<string, WebhookGetResult>;
  quickCommands: Record<string, QuickCommandGetResult>;
  channelToolsets: Record<string, string[]>;
  /** `voice.tts.providers.*` — the named TTS roster. `auxiliary.tts` is the
   *  default entry and lives in the `voiceTts*` fields above, not here. */
  voiceTtsProviders: Record<string, VoiceProviderGetResult>;
  /** `voice.stt.providers.*` — the named STT roster. `auxiliary.asr` is the
   *  default entry and lives in the `voice*` STT fields above, not here. */
  voiceSttProviders: Record<string, VoiceSttProviderGetResult>;
  /** `voice.realtime.providers.*` — the named realtime roster. This one has no
   *  `auxiliary.*` default entry; `voiceRealtimeDefault` names one of these. */
  voiceRealtimeProviders: Record<string, VoiceRealtimeProviderGetResult>;
  /** `voice.realtime.default` — a roster label, never a provider id. */
  voiceRealtimeDefault: string | null;
  /** `voice.tier` — the deployment's default voice engine. */
  voiceTier: 'pipeline' | 'realtime' | null;
  /** `voice.realtime.sessionBudgetUsd` — USD cap on one session. */
  voiceRealtimeSessionBudgetUsd: number | null;
  // -- Telephony (`voice.trunk` / `voice.livekit` / `voice.inbound` /
  //    `voice.bargeIn` / `voice.bots`) ---------------------------------------
  voiceTrunkProvider: (typeof VOICE_TRUNK_PROVIDERS)[number] | null;
  voiceTrunkId: string | null;
  voiceTrunkFromNumber: string | null;
  voiceTrunkUsername: string | null;
  /** REDACTED. The raw password never leaves this layer. */
  voiceTrunkPasswordPreview: string | null;
  /** REDACTED. The raw webhook secret never leaves this layer. */
  voiceTrunkWebhookSecretPreview: string | null;
  voiceTrunkWebhookPath: string | null;
  voiceTrunkCodec: (typeof VOICE_TRUNK_CODECS)[number] | null;
  voiceLivekitUrl: string | null;
  /** REDACTED. */
  voiceLivekitApiKeyPreview: string | null;
  /** REDACTED. */
  voiceLivekitApiSecretPreview: string | null;
  /** Null = key absent = "screen everyone"; an empty list is not expressible
   *  on disk (a flat `key:` line with no value does not parse). */
  voiceInboundAllowlist: string[] | null;
  voiceInboundReceptionist: string | null;
  voiceInboundConcurrencyCap: number | null;
  voiceInboundPerCallerPerHour: number | null;
  voiceInboundDailyBudgetUsd: number | null;
  voiceInboundPrewarm: (typeof VOICE_INBOUND_PREWARM_MODES)[number] | null;
  voiceInboundOwnerPlatform: string | null;
  voiceInboundOwnerChatId: string | null;
  voiceInboundOwnerBotKey: string | null;
  /** Keyed by surface; an absent surface was never tuned. */
  voiceBargeIn: Record<string, VoiceBargeInTuningResult>;
  voiceBots: VoiceBotGetResult[];
  nightlyPass: { enabled: boolean; cron: string };
  weeklyDigest: { enabled: boolean; cron: string; recipients: string[] };
  modelCatalog: { enabled: boolean; url: string | null; ttlHours: number };
  logsRotation: { enabled: boolean; maxBytes: number | null; maxFiles: number | null };
  webSearchBackend: 'exa' | 'tavily' | 'brave' | null;
  webExtractBackend: 'htmltext' | null;
  auxCompression: AuxModelGetResult;
  auxVision: AuxModelGetResult;
  auxWeb: AuxModelGetResult;
  a2aEnabled: boolean;
  pluginsAutoInstall: boolean | null;
  webBaseUrl: string | null;
}

export interface ConfigUpdateInput {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  personality?: string;
  memory?: 'markdown' | 'vector' | 'vault';
  modelRouting?: Record<string, string>;
  skin?: string;
  providers?: Array<{
    provider: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
  }>;
  approvalMode?: 'manual' | 'smart' | 'off';
  verbosity?: 'concise' | 'balanced' | 'verbose';
  debugMode?: boolean;
  contextLayering?: boolean;
  debugPanelEnabled?: boolean;
  debugPanelModel?: string | null;
  adminEnabled?: boolean;
  streamingEdits?: 'off' | 'dms' | 'all';
  callStyle?: 'liquid' | 'orb' | 'rings' | 'personality';
  callAccent?: string;
  autoCompact?: boolean;
  memoryConsolidationEnabled?: boolean;
  memoryCaptureEnabled?: boolean;
  memoryCaptureModel?: string;
  memoryNotices?: boolean;
  voiceChime?: boolean;
  voiceEndpointSilenceMs?: number;
  voiceBargeThreshold?: number;
  voiceBargeSustainMs?: number;
  voiceSpeechThreshold?: number;
  voiceSpeechMinMs?: number;
  voiceProvider?: string;
  voiceApiKey?: string;
  voiceBaseUrl?: string;
  voiceModel?: string;
  voiceTtsProvider?: string;
  voiceTtsApiKey?: string;
  voiceTtsVoice?: string;
  voiceTtsBaseUrl?: string;
  voiceTtsModel?: string;
  voiceSttCommand?: string | null;
  voiceTtsCommand?: string | null;
  voiceTtsOutputFormat?: 'opus' | 'mp3' | 'wav' | 'pcm' | null;
  voiceTtsTimeoutMs?: number | null;
  voiceTtsMaxTextLength?: number | null;
  voiceSttTimeoutMs?: number | null;
  voiceTrustedPlugins?: string[] | null;
  voiceDefaultMode?: 'off' | 'mirror_inbound' | 'all' | null;
  /** `voice.channels.<platform>.ttsOut`. Present REPLACES the whole map — an
   *  omitted platform loses its override and inherits `voice.defaultMode`
   *  again. An unrecognized platform id is refused, not dropped. */
  voiceChannelTtsOut?: Record<string, boolean>;
  /** `voice.transcode.ffmpegPath`; null clears the key. */
  voiceTranscodeFfmpegPath?: string | null;
  /** `voice.transcode.bitrateKbps`, 8–320; null clears the key. */
  voiceTranscodeBitrateKbps?: number | null;
  /** `voice.transcode.timeout`, SECONDS, 1–600; null clears the key. */
  voiceTranscodeTimeoutSec?: number | null;
  /** `voice.artifacts.abandonAfterDays`, 1–365; null clears the key. */
  voiceArtifactAbandonAfterDays?: number | null;
  /** `voice.artifacts.maxTotalMb`, 1–102400; null clears the key. */
  voiceArtifactMaxTotalMb?: number | null;
  /** `voice.tts.providers.*`. Present REPLACES the whole roster — an omitted
   *  entry is a deletion, and its vault key is dropped with it. */
  voiceTtsProviders?: Record<string, VoiceProviderUpdateInput>;
  /** `voice.stt.providers.*`. Same full-replacement rule. */
  voiceSttProviders?: Record<string, VoiceSttProviderUpdateInput>;
  /** `voice.realtime.providers.*`. Same full-replacement rule. */
  voiceRealtimeProviders?: Record<string, VoiceRealtimeProviderUpdateInput>;
  /** `voice.realtime.default`; null clears the key. */
  voiceRealtimeDefault?: string | null;
  /** `voice.tier`; null clears the key. */
  voiceTier?: 'pipeline' | 'realtime' | null;
  /** `voice.realtime.sessionBudgetUsd`; null clears the cap. */
  voiceRealtimeSessionBudgetUsd?: number | null;
  // -- Telephony -------------------------------------------------------------
  // The four secrets are WRITE-ONLY and never echoed back, so a blank or
  // omitted value KEEPS the stored one — the browser only ever saw a preview,
  // and treating blank as "erase" would delete a credential on every unrelated
  // save. `null` clears one.
  //
  // `voiceTrunkProvider: null` drops the whole `voice.trunk.*` block and
  // `voiceLivekitUrl: null` the whole `voice.livekit.*` block (secrets
  // included): the CLI parser needs provider+trunkId and url+apiKey+apiSecret
  // together, so a block that lost its anchor would not load.
  /** `voice.trunk.provider`; null clears the whole trunk block. */
  voiceTrunkProvider?: (typeof VOICE_TRUNK_PROVIDERS)[number] | null;
  voiceTrunkId?: string | null;
  voiceTrunkFromNumber?: string | null;
  voiceTrunkUsername?: string | null;
  /** Write-only; blank keeps the stored secret, null clears it. */
  voiceTrunkPassword?: string | null;
  /** Write-only; blank keeps the stored secret, null clears it. */
  voiceTrunkWebhookSecret?: string | null;
  /** Must start with `/`. */
  voiceTrunkWebhookPath?: string | null;
  voiceTrunkCodec?: (typeof VOICE_TRUNK_CODECS)[number] | null;
  /** `voice.livekit.url`; null clears the whole LiveKit block. */
  voiceLivekitUrl?: string | null;
  /** Write-only; blank keeps, null clears. */
  voiceLivekitApiKey?: string | null;
  /** Write-only; blank keeps, null clears. */
  voiceLivekitApiSecret?: string | null;
  /** Null or an empty list clears the key. */
  voiceInboundAllowlist?: string[] | null;
  voiceInboundReceptionist?: string | null;
  voiceInboundConcurrencyCap?: number | null;
  voiceInboundPerCallerPerHour?: number | null;
  voiceInboundDailyBudgetUsd?: number | null;
  voiceInboundPrewarm?: (typeof VOICE_INBOUND_PREWARM_MODES)[number] | null;
  /** Null clears the whole `voice.inbound.owner.*` block — platform and chatId
   *  are required together. */
  voiceInboundOwnerPlatform?: string | null;
  voiceInboundOwnerChatId?: string | null;
  voiceInboundOwnerBotKey?: string | null;
  /** `voice.bargeIn.*`. Present = REPLACE the whole block; an omitted surface
   *  loses its tuning. An unknown surface is refused, not dropped. */
  voiceBargeIn?: Record<string, VoiceBargeInTuningUpdate>;
  /** `voice.bots[]`. Present = REPLACE the whole list, renumbered from 0; a
   *  removed row is a deletion. */
  voiceBots?: VoiceBotUpdateInput[];
  // Settings-page additions. For every scalar below, `null` (or '') deletes
  // the config.yaml key so the built-in default applies again; `undefined`
  // leaves it unchanged. Record fields are full replacements.
  apiVersion?: string | null;
  verbose?: boolean | null;
  displayVerbosity?: 'quiet' | 'default' | 'verbose' | 'debug' | null;
  displayBusyInputMode?: 'interrupt' | 'queue' | 'steer' | null;
  displayToolPreviewLength?: number | null;
  displayResumeHint?: boolean | null;
  displayResumeRecapTurns?: number | null;
  displayBellOnComplete?: boolean | null;
  compaction?: {
    pressure?: number | null;
    target?: number | null;
    gateDelta?: number | null;
    retryOnOverflow?: boolean | null;
    smallWindow?: 'auto' | 'on' | 'off' | null;
  };
  memoryVault?: {
    path?: string | null;
    agentDir?: string | null;
    prefetch?: string[] | null;
    exclude?: string[] | null;
  };
  memoryApproval?: {
    mode?: 'off' | 'automated' | 'all' | null;
    cap?: number | null;
    ttlDays?: number | null;
  };
  memoryConsolidation?: {
    halfLifeDays?: number | null;
    threshold?: number | null;
    exemptUser?: boolean | null;
    flushThreshold?: number | null;
    timeboxMs?: number | null;
    maxTokens?: number | null;
    maxDeltaChars?: number | null;
    minMessagesSinceFlush?: number | null;
  };
  memoryCapture?: {
    provider?: string | null;
    /** Write-only; never echoed back. */
    apiKey?: string | null;
    baseUrl?: string | null;
    maxPerHour?: number | null;
    maxPerDay?: number | null;
  };
  background?: {
    enabled?: boolean | null;
    maxConcurrentJobs?: number | null;
    maxJobsPerRoot?: number | null;
    maxJobsPerPersonality?: number | null;
    defaultMaxCostUsd?: number | null;
    maxRootBackgroundUsd?: number | null;
    queuedTtlMs?: number | null;
    staleMs?: number | null;
    heartbeatMs?: number | null;
    retentionDays?: number | null;
  };
  retention?: Partial<Record<RetentionSubkey, string>>;
  personalityRetention?: Record<string, Partial<Record<RetentionSubkey, string>>>;
  webhooks?: Record<string, WebhookUpdateInput>;
  quickCommands?: Record<string, QuickCommandUpdateInput>;
  channelToolsets?: Record<string, string[]>;
  /**
   * `voice.wake.routes.<id>` — the wake-phrase → personality table, replaced
   * wholesale (a present key drops every existing route first, like the voice
   * rosters above). A route the operator deleted in the UI must actually stop
   * answering the door, so a merge would be the wrong semantics here.
   */
  wakeRoutes?: Record<
    string,
    { phrase: string; personality: string; privileged?: boolean; enabled?: boolean }
  >;
  nightlyPass?: { enabled?: boolean | null; cron?: string | null };
  weeklyDigest?: { enabled?: boolean | null; cron?: string | null; recipients?: string[] | null };
  modelCatalog?: { enabled?: boolean | null; url?: string | null; ttlHours?: number | null };
  logsRotation?: { enabled?: boolean | null; maxBytes?: number | null; maxFiles?: number | null };
  webSearchBackend?: 'exa' | 'tavily' | 'brave' | null;
  webExtractBackend?: 'htmltext' | null;
  auxCompression?: AuxModelUpdateInput;
  auxVision?: AuxModelUpdateInput;
  auxWeb?: AuxModelUpdateInput;
  a2aEnabled?: boolean | null;
  pluginsAutoInstall?: boolean | null;
  webBaseUrl?: string | null;
}

export interface ConfigServiceOptions {
  config: ConfigRepository;
  /** Resolves `${secrets:ref}` indirection in stored API keys (admin
   *  provider health checks). Optional — when omitted, secret-ref keys
   *  resolve to '' so checks fail honestly instead of probing with the
   *  literal reference string. */
  secrets?: SecretsResolver;
  /**
   * Validates the personality a `voice.bots[]` entry binds to.
   *
   * A seam, not a dependency on the whole service: the only question asked is
   * "does this id exist", and the answer has to come from the registry the
   * gateway will resolve against. Optional because a deployment (or a test)
   * without it still has a working config writer — the check is then skipped,
   * the same way `secrets` degrades.
   */
  personalities?: { exists(id: string): Promise<boolean> };
  /**
   * Fired after a successful `update()` write lands.
   *
   * A seam, not a dependency: this service must not know that wake satellites
   * exist, but a Settings save is the one moment the pushed routing table can
   * change, and eng-review D5 makes that save the trigger for the push. The
   * composition root closes over whatever needs telling. Awaited so a caller
   * that reads back immediately sees the effect, but a listener that throws
   * must not fail the config write that already landed.
   */
  onUpdated?: () => void | Promise<void>;
}

export class ConfigService {
  constructor(private readonly opts: ConfigServiceOptions) {}

  async get(): Promise<ConfigGetResult> {
    const raw = await this.opts.config.read();
    if (!raw?.provider) {
      throw new EthosError({
        code: 'CONFIG_MISSING',
        cause: 'Config not found at ~/.ethos/config.yaml',
        action: 'Run onboarding from the web UI or `ethos setup` from the CLI.',
      });
    }
    const p = raw.passthrough;
    return {
      provider: raw.provider ?? '',
      model: raw.model ?? '',
      apiKeyPreview: (await this.keyPreview(raw.apiKey)) ?? redactKey(undefined),
      baseUrl: raw.baseUrl ?? null,
      personality: raw.personality ?? 'researcher',
      memory: raw.memory ?? 'markdown',
      modelRouting: raw.modelRouting,
      skin: raw.skin ?? 'default',
      providers: await Promise.all(
        raw.providers.map(async (p) => ({
          provider: p.provider,
          model: p.model ?? null,
          apiKeyPreview: (await this.keyPreview(p.apiKey)) ?? redactKey(undefined),
          baseUrl: p.baseUrl ?? null,
        })),
      ),
      approvalMode: raw.approvalMode ?? 'manual',
      verbosity: raw.verbosity ?? 'balanced',
      debugMode: raw.debugMode ?? false,
      contextLayering: raw.contextLayering ?? false,
      debugPanelEnabled: raw.debugPanelEnabled ?? false,
      debugPanelModel: raw.debugPanelModel ?? null,
      adminEnabled: raw.passthrough['admin.enabled'] === 'true',
      streamingEdits: parseStreamingEdits(raw.passthrough['display.streaming_edits']),
      callStyle: parseCallStyle(raw.passthrough['display.call_style']),
      callAccent: parseCallAccent(raw.passthrough['display.call_accent']),
      // Default ON since the context-economy Phase 2 flip — off only when
      // explicitly disabled.
      autoCompact: raw.passthrough['compaction.autoCompact'] !== 'false',
      memoryConsolidationEnabled: raw.passthrough['memoryConsolidation.enabled'] === 'true',
      memoryCaptureEnabled: raw.passthrough['memoryCapture.enabled'] === 'true',
      memoryCaptureModel: raw.passthrough['memoryCapture.model'] || null,
      memoryNotices: raw.passthrough['display.memory_notices'] === 'true',
      // Default ON — the talk-mode chime plays unless explicitly disabled.
      voiceChime: raw.passthrough['display.voice_chime'] !== 'false',
      voiceEndpointSilenceMs: readVoiceTuning(
        raw.passthrough,
        'display.voice_endpoint_silence_ms',
        VOICE_TUNING['display.voice_endpoint_silence_ms'].default,
      ),
      voiceBargeThreshold: readVoiceTuning(
        raw.passthrough,
        'display.voice_barge_threshold',
        VOICE_TUNING['display.voice_barge_threshold'].default,
      ),
      voiceBargeSustainMs: readVoiceTuning(
        raw.passthrough,
        'display.voice_barge_sustain_ms',
        VOICE_TUNING['display.voice_barge_sustain_ms'].default,
      ),
      voiceSpeechThreshold: readVoiceTuning(
        raw.passthrough,
        'display.voice_speech_threshold',
        VOICE_TUNING['display.voice_speech_threshold'].default,
      ),
      voiceSpeechMinMs: readVoiceTuning(
        raw.passthrough,
        'display.voice_speech_min_ms',
        VOICE_TUNING['display.voice_speech_min_ms'].default,
      ),
      voiceProvider: raw.voiceProvider ?? null,
      voiceApiKeyPreview: await this.keyPreview(raw.voiceApiKey),
      voiceBaseUrl: raw.voiceBaseUrl ?? null,
      voiceModel: raw.voiceModel ?? null,
      voiceTtsProvider: raw.voiceTtsProvider ?? null,
      voiceTtsApiKeyPreview: await this.keyPreview(raw.voiceTtsApiKey),
      voiceTtsVoice: raw.voiceTtsVoice ?? null,
      voiceTtsBaseUrl: raw.voiceTtsBaseUrl ?? null,
      voiceTtsModel: raw.voiceTtsModel ?? null,
      voiceSttCommand: passStr(p, 'auxiliary.asr.command'),
      voiceTtsCommand: passStr(p, 'auxiliary.tts.command'),
      voiceTtsOutputFormat: pickEnumOrNull(p['auxiliary.tts.outputFormat'], [
        'opus',
        'mp3',
        'wav',
        'pcm',
      ]),
      voiceTtsTimeoutMs: auxTimeoutSeconds(passNumOrNull(p, 'auxiliary.tts.timeout')),
      voiceTtsMaxTextLength: passNumOrNull(p, 'auxiliary.tts.maxTextLength'),
      voiceSttTimeoutMs: auxTimeoutSeconds(passNumOrNull(p, 'auxiliary.asr.timeout')),
      // An absent key = the gate is off, which is NOT the same as an allowlist
      // that happens to be empty.
      voiceTrustedPlugins:
        p['voice.trustedPlugins'] === undefined ? null : splitList(p['voice.trustedPlugins']),
      voiceDefaultMode: pickEnumOrNull(p['voice.defaultMode'], ['off', 'mirror_inbound', 'all']),
      voiceChannelTtsOut: parseVoiceChannelTtsOut(p),
      voiceTranscodeFfmpegPath: passStr(p, 'voice.transcode.ffmpegPath'),
      voiceTranscodeBitrateKbps: passNumOrNull(p, 'voice.transcode.bitrateKbps'),
      voiceTranscodeTimeoutSec: passNumOrNull(p, 'voice.transcode.timeout'),
      voiceArtifactAbandonAfterDays: passNumOrNull(p, 'voice.artifacts.abandonAfterDays'),
      voiceArtifactMaxTotalMb: passNumOrNull(p, 'voice.artifacts.maxTotalMb'),
      voiceRealtimeDefault: passStr(p, 'voice.realtime.default'),
      voiceTier: pickEnumOrNull(p['voice.tier'], ['pipeline', 'realtime']),
      voiceRealtimeSessionBudgetUsd: passNumOrNull(p, 'voice.realtime.sessionBudgetUsd'),
      voiceTrunkProvider: pickEnumOrNull(p['voice.trunk.provider'], VOICE_TRUNK_PROVIDERS),
      voiceTrunkId: passStr(p, 'voice.trunk.trunkId'),
      voiceTrunkFromNumber: passStr(p, 'voice.trunk.fromNumber'),
      voiceTrunkUsername: passStr(p, 'voice.trunk.username'),
      voiceTrunkPasswordPreview: await this.keyPreview(p['voice.trunk.password']),
      voiceTrunkWebhookSecretPreview: await this.keyPreview(p['voice.trunk.webhookSecret']),
      voiceTrunkWebhookPath: passStr(p, 'voice.trunk.webhookPath'),
      voiceTrunkCodec: pickEnumOrNull(p['voice.trunk.codec'], VOICE_TRUNK_CODECS),
      voiceLivekitUrl: passStr(p, 'voice.livekit.url'),
      voiceLivekitApiKeyPreview: await this.keyPreview(p['voice.livekit.apiKey']),
      voiceLivekitApiSecretPreview: await this.keyPreview(p['voice.livekit.apiSecret']),
      // Absent key = no allowlist = "screen everyone", which is NOT the same as
      // an allowlist that happens to be empty (same distinction the
      // `voice.trustedPlugins` read above draws).
      voiceInboundAllowlist:
        p['voice.inbound.allowlist'] === undefined ? null : splitList(p['voice.inbound.allowlist']),
      voiceInboundReceptionist: passStr(p, 'voice.inbound.receptionist'),
      voiceInboundConcurrencyCap: passNumOrNull(p, 'voice.inbound.concurrencyCap'),
      voiceInboundPerCallerPerHour: passNumOrNull(p, 'voice.inbound.perCallerPerHour'),
      voiceInboundDailyBudgetUsd: passNumOrNull(p, 'voice.inbound.dailyBudgetUsd'),
      voiceInboundPrewarm: pickEnumOrNull(p['voice.inbound.prewarm'], VOICE_INBOUND_PREWARM_MODES),
      voiceInboundOwnerPlatform: passStr(p, 'voice.inbound.owner.platform'),
      voiceInboundOwnerChatId: passStr(p, 'voice.inbound.owner.chatId'),
      voiceInboundOwnerBotKey: passStr(p, 'voice.inbound.owner.botKey'),
      voiceBargeIn: parseVoiceBargeIn(p),
      voiceBots: parseVoiceBots(p),
      apiVersion: passStr(p, 'apiVersion'),
      verbose: passBool(p, 'verbose', false),
      displayVerbosity: pickEnum(
        p['display.verbosity'],
        ['quiet', 'default', 'verbose', 'debug'],
        'default',
      ),
      displayBusyInputMode: pickEnum(
        p['display.busy_input_mode'],
        ['interrupt', 'queue', 'steer'],
        'interrupt',
      ),
      displayToolPreviewLength: passNum(p, 'display.tool_preview_length', 0),
      displayResumeHint: passBool(p, 'display.resume_hint', true),
      displayResumeRecapTurns: passNum(p, 'display.resume_recap_turns', 3),
      displayBellOnComplete: passBool(p, 'display.bell_on_complete', false),
      compaction: {
        pressure: passNumOrNull(p, 'compaction.pressure'),
        target: passNumOrNull(p, 'compaction.target'),
        gateDelta: passNumOrNull(p, 'compaction.gateDelta'),
        // Default ON — only an explicit false disables the overflow retry.
        retryOnOverflow: p['compaction.retryOnOverflow'] !== 'false',
        smallWindow: pickEnum(p['compaction.smallWindow'], ['auto', 'on', 'off'], 'auto'),
      },
      memoryVault: {
        path: passStr(p, 'memoryVault.path'),
        agentDir: passStr(p, 'memoryVault.agentDir'),
        prefetch: splitList(p['memoryVault.prefetch']),
        exclude: splitList(p['memoryVault.exclude']),
      },
      memoryApproval: {
        mode: pickEnum(p['memoryApproval.mode'], ['off', 'automated', 'all'], 'off'),
        cap: passNum(p, 'memoryApproval.cap', 200),
        ttlDays: passNum(p, 'memoryApproval.ttlDays', 30),
      },
      memoryConsolidation: {
        halfLifeDays: passNum(p, 'memoryConsolidation.halfLifeDays', 30),
        threshold: passNum(p, 'memoryConsolidation.threshold', 0.05),
        // Default ON — USER.md is exempt from decay unless explicitly disabled.
        exemptUser: p['memoryConsolidation.exemptUser'] !== 'false',
        flushThreshold: passNum(p, 'memoryConsolidation.flushThreshold', 0.7),
        timeboxMs: passNum(p, 'memoryConsolidation.timeboxMs', 30_000),
        maxTokens: passNum(p, 'memoryConsolidation.maxTokens', 1024),
        maxDeltaChars: passNum(p, 'memoryConsolidation.maxDeltaChars', 4000),
        minMessagesSinceFlush: passNum(p, 'memoryConsolidation.minMessagesSinceFlush', 8),
      },
      memoryCapture: {
        provider: passStr(p, 'memoryCapture.provider'),
        apiKeyPreview: await this.keyPreview(p['memoryCapture.apiKey']),
        baseUrl: passStr(p, 'memoryCapture.baseUrl'),
        maxPerHour: passNum(p, 'memoryCapture.maxPerHour', 6),
        maxPerDay: passNum(p, 'memoryCapture.maxPerDay', 30),
      },
      // Defaults mirror backgroundDefaults() in packages/config — web-api has
      // no @ethosagent/config dependency, so the values are duplicated here
      // (same precedent as VOICE_TUNING above).
      background: {
        enabled: passBool(p, 'background.enabled', false),
        maxConcurrentJobs: passNum(p, 'background.max_concurrent_jobs', 2),
        maxJobsPerRoot: passNum(p, 'background.max_jobs_per_root', 3),
        maxJobsPerPersonality: passNum(p, 'background.max_jobs_per_personality', 5),
        defaultMaxCostUsd: passNum(p, 'background.default_max_cost_usd', 1),
        maxRootBackgroundUsd: passNum(p, 'background.max_root_background_usd', 5),
        queuedTtlMs: passNum(p, 'background.queued_ttl_ms', 900_000),
        staleMs: passNum(p, 'background.stale_ms', 90_000),
        heartbeatMs: passNum(p, 'background.heartbeat_ms', 30_000),
        retentionDays: passNum(p, 'background.retention_days', 30),
      },
      retention: parseRetentionMap(p, 'retention.'),
      personalityRetention: parsePersonalityRetention(p),
      webhooks: parseWebhooks(p),
      quickCommands: parseQuickCommands(p),
      channelToolsets: parseChannelToolsets(p),
      voiceTtsProviders: await parseVoiceTtsProviders(p, (v) => this.keyPreview(v)),
      voiceSttProviders: await parseVoiceSttProviders(p, (v) => this.keyPreview(v)),
      voiceRealtimeProviders: await parseVoiceRealtimeProviders(p, (v) => this.keyPreview(v)),
      nightlyPass: {
        enabled: passBool(p, 'nightlyPass.enabled', false),
        cron: p['nightlyPass.cron'] || '0 3 * * *',
      },
      weeklyDigest: {
        enabled: passBool(p, 'weeklyDigest.enabled', false),
        cron: p['weeklyDigest.cron'] || '0 9 * * 1',
        recipients: splitList(p['weeklyDigest.recipients']),
      },
      modelCatalog: {
        enabled: passBool(p, 'modelCatalog.enabled', true),
        url: passStr(p, 'modelCatalog.url'),
        ttlHours: passNum(p, 'modelCatalog.ttlHours', 24),
      },
      logsRotation: {
        enabled: passBool(p, 'logs.rotation.enabled', true),
        maxBytes: passNumOrNull(p, 'logs.rotation.maxBytes'),
        maxFiles: passNumOrNull(p, 'logs.rotation.maxFiles'),
      },
      webSearchBackend: parseWebSearchBackend(p['web.search_backend']),
      webExtractBackend: p['web.extract_backend'] === 'htmltext' ? 'htmltext' : null,
      auxCompression: await parseAuxModel(p, 'auxiliary.compression', (v) => this.keyPreview(v)),
      auxVision: await parseAuxModel(p, 'auxiliary.vision', (v) => this.keyPreview(v)),
      auxWeb: await parseAuxModel(p, 'auxiliary.web', (v) => this.keyPreview(v)),
      a2aEnabled: passBool(p, 'a2a.enabled', false),
      pluginsAutoInstall:
        p['plugins.auto_install'] === undefined ? null : p['plugins.auto_install'] === 'true',
      webBaseUrl: passStr(p, 'webBaseUrl'),
    };
  }

  /**
   * Whether the web admin panel is enabled. Gated by `admin.enabled: true`
   * in ~/.ethos/config.yaml — default false; admin access must be enabled
   * explicitly. Missing config counts as disabled.
   */
  async adminEnabled(): Promise<boolean> {
    const raw = await this.opts.config.read();
    return raw?.passthrough['admin.enabled'] === 'true';
  }

  /**
   * Resolve the stored credentials for a provider so admin health checks
   * probe with the real key. The raw key still never crosses the RPC
   * boundary — it travels provider-ward only. Prefers the provider-chain
   * entry; falls back to the primary provider fields. Returns null when
   * the provider isn't configured.
   */
  async resolveProviderCredentials(
    provider: string,
  ): Promise<{ apiKey: string; baseUrl?: string } | null> {
    const raw = await this.opts.config.read();
    if (!raw) return null;
    const entry = raw.providers.find((p) => p.provider === provider);
    if (entry) {
      return {
        apiKey: await this.resolveSecretRefs(entry.apiKey ?? ''),
        ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      };
    }
    if (raw.provider === provider) {
      return {
        apiKey: await this.resolveSecretRefs(raw.apiKey ?? ''),
        ...(raw.baseUrl ? { baseUrl: raw.baseUrl } : {}),
      };
    }
    return null;
  }

  /** Redacted preview of a stored credential. Values in config.yaml are
   *  `${secrets:<ref>}` references (G-SEC), so resolve before redacting —
   *  redacting the reference itself would render `${s…Key}` and tell the
   *  user nothing about which key is set. */
  private async keyPreview(value: string | undefined): Promise<string | null> {
    if (!value) return null;
    return redactKey(await this.resolveSecretRefs(value));
  }

  /** Substitute `${secrets:ref}` references via the resolver. An
   *  unresolvable reference (or no resolver) yields '' — the caller's
   *  health check then fails honestly rather than probing with a
   *  literal `${secrets:...}` string. */
  private async resolveSecretRefs(value: string): Promise<string> {
    const matches = [...value.matchAll(SECRETS_REF_RE)];
    if (matches.length === 0) return value;
    if (!this.opts.secrets) return '';
    let resolved = value;
    for (const m of matches) {
      const ref = m[1];
      if (!ref) continue;
      const secret = await this.opts.secrets.get(ref);
      if (secret === null) return '';
      resolved = resolved.replace(m[0], () => secret);
    }
    return resolved;
  }

  async update(patch: ConfigUpdateInput): Promise<void> {
    // Empty-string apiKey would erase the existing key. Treat as no-op.
    const cleaned: typeof patch = { ...patch };
    if (cleaned.apiKey !== undefined && cleaned.apiKey === '') delete cleaned.apiKey;

    // These behavior flags are flat config keys (`admin.enabled`,
    // `display.streaming_edits`, `compaction.autoCompact`, …), not typed fields
    // on the repository's RawConfig. Translate each into a passthrough write and
    // strip it from the patch so it doesn't reach the repository. Passthrough
    // merges add/overwrite only, so writing `memoryConsolidation.enabled` here
    // preserves the sibling `memoryConsolidation.*` decay-tuning keys.
    const passthroughPatch: Record<string, string> = {};
    if (patch.adminEnabled !== undefined) {
      passthroughPatch['admin.enabled'] = patch.adminEnabled ? 'true' : 'false';
    }
    if (patch.streamingEdits !== undefined) {
      passthroughPatch['display.streaming_edits'] = patch.streamingEdits;
    }
    if (patch.callStyle !== undefined) {
      passthroughPatch['display.call_style'] = patch.callStyle;
    }
    if (patch.callAccent !== undefined) {
      passthroughPatch['display.call_accent'] = parseCallAccent(patch.callAccent);
    }
    if (patch.autoCompact !== undefined) {
      passthroughPatch['compaction.autoCompact'] = patch.autoCompact ? 'true' : 'false';
    }
    if (patch.memoryConsolidationEnabled !== undefined) {
      passthroughPatch['memoryConsolidation.enabled'] = patch.memoryConsolidationEnabled
        ? 'true'
        : 'false';
    }
    if (patch.memoryCaptureEnabled !== undefined) {
      passthroughPatch['memoryCapture.enabled'] = patch.memoryCaptureEnabled ? 'true' : 'false';
    }
    if (patch.memoryCaptureModel !== undefined) {
      passthroughPatch['memoryCapture.model'] = patch.memoryCaptureModel;
    }
    if (patch.memoryNotices !== undefined) {
      passthroughPatch['display.memory_notices'] = patch.memoryNotices ? 'true' : 'false';
    }
    if (patch.voiceChime !== undefined) {
      passthroughPatch['display.voice_chime'] = patch.voiceChime ? 'true' : 'false';
    }
    // Voice tuning: clamp each provided value to its range and persist as a
    // string under its flat `display.voice_*` key. Clamp defends direct callers;
    // the RPC layer already rejects out-of-range via the Zod bounds.
    for (const [key, spec] of Object.entries(VOICE_TUNING)) {
      const value = patch[spec.field];
      if (value === undefined) continue;
      const clamped = Math.min(spec.max, Math.max(spec.min, value));
      passthroughPatch[key] = String(clamped);
      delete cleaned[spec.field];
    }

    // Settings-page passthrough groups. Bounds are validated (mirroring
    // packages/config's parse validation) so a direct — non-RPC — caller
    // can't persist values the CLI loader would reject or drop.
    validateSettingsPatch(patch);
    // Scalars: undefined = leave unchanged; null (or '') = delete the key so
    // the built-in default applies again; anything else = stringify and set.
    const deleteKeys: string[] = [];
    const set = (key: string, v: string | number | boolean | null | undefined): void => {
      if (v === undefined) return;
      if (v === null || v === '') {
        deleteKeys.push(key);
        return;
      }
      passthroughPatch[key] = String(v);
    };
    const setList = (key: string, v: string[] | null | undefined, sep = ','): void => {
      if (v === undefined) return;
      if (v === null || v.length === 0) {
        deleteKeys.push(key);
        return;
      }
      passthroughPatch[key] = v.join(sep);
    };

    set('apiVersion', patch.apiVersion);
    set('verbose', patch.verbose);
    set('display.verbosity', patch.displayVerbosity);
    set('display.busy_input_mode', patch.displayBusyInputMode);
    set('display.tool_preview_length', patch.displayToolPreviewLength);
    set('display.resume_hint', patch.displayResumeHint);
    set('display.resume_recap_turns', patch.displayResumeRecapTurns);
    set('display.bell_on_complete', patch.displayBellOnComplete);
    if (patch.compaction) {
      set('compaction.pressure', patch.compaction.pressure);
      set('compaction.target', patch.compaction.target);
      set('compaction.gateDelta', patch.compaction.gateDelta);
      set('compaction.retryOnOverflow', patch.compaction.retryOnOverflow);
      set('compaction.smallWindow', patch.compaction.smallWindow);
    }
    if (patch.memoryVault) {
      set('memoryVault.path', patch.memoryVault.path);
      set('memoryVault.agentDir', patch.memoryVault.agentDir);
      // ', ' separator matches packages/config's writeConfig serialization.
      setList('memoryVault.prefetch', patch.memoryVault.prefetch, ', ');
      setList('memoryVault.exclude', patch.memoryVault.exclude, ', ');
    }
    if (patch.memoryApproval) {
      set('memoryApproval.mode', patch.memoryApproval.mode);
      set('memoryApproval.cap', patch.memoryApproval.cap);
      set('memoryApproval.ttlDays', patch.memoryApproval.ttlDays);
    }
    if (patch.memoryConsolidation) {
      set('memoryConsolidation.halfLifeDays', patch.memoryConsolidation.halfLifeDays);
      set('memoryConsolidation.threshold', patch.memoryConsolidation.threshold);
      set('memoryConsolidation.exemptUser', patch.memoryConsolidation.exemptUser);
      set('memoryConsolidation.flushThreshold', patch.memoryConsolidation.flushThreshold);
      set('memoryConsolidation.timeboxMs', patch.memoryConsolidation.timeboxMs);
      set('memoryConsolidation.maxTokens', patch.memoryConsolidation.maxTokens);
      set('memoryConsolidation.maxDeltaChars', patch.memoryConsolidation.maxDeltaChars);
      set(
        'memoryConsolidation.minMessagesSinceFlush',
        patch.memoryConsolidation.minMessagesSinceFlush,
      );
    }
    if (patch.memoryCapture) {
      set('memoryCapture.provider', patch.memoryCapture.provider);
      set('memoryCapture.apiKey', patch.memoryCapture.apiKey);
      set('memoryCapture.baseUrl', patch.memoryCapture.baseUrl);
      set('memoryCapture.maxPerHour', patch.memoryCapture.maxPerHour);
      set('memoryCapture.maxPerDay', patch.memoryCapture.maxPerDay);
    }
    if (patch.background) {
      set('background.enabled', patch.background.enabled);
      set('background.max_concurrent_jobs', patch.background.maxConcurrentJobs);
      set('background.max_jobs_per_root', patch.background.maxJobsPerRoot);
      set('background.max_jobs_per_personality', patch.background.maxJobsPerPersonality);
      set('background.default_max_cost_usd', patch.background.defaultMaxCostUsd);
      set('background.max_root_background_usd', patch.background.maxRootBackgroundUsd);
      set('background.queued_ttl_ms', patch.background.queuedTtlMs);
      set('background.stale_ms', patch.background.staleMs);
      set('background.heartbeat_ms', patch.background.heartbeatMs);
      set('background.retention_days', patch.background.retentionDays);
    }
    if (patch.nightlyPass) {
      set('nightlyPass.enabled', patch.nightlyPass.enabled);
      set('nightlyPass.cron', patch.nightlyPass.cron);
    }
    if (patch.weeklyDigest) {
      set('weeklyDigest.enabled', patch.weeklyDigest.enabled);
      set('weeklyDigest.cron', patch.weeklyDigest.cron);
      setList('weeklyDigest.recipients', patch.weeklyDigest.recipients);
    }
    if (patch.modelCatalog) {
      set('modelCatalog.enabled', patch.modelCatalog.enabled);
      set('modelCatalog.url', patch.modelCatalog.url);
      set('modelCatalog.ttlHours', patch.modelCatalog.ttlHours);
    }
    if (patch.logsRotation) {
      set('logs.rotation.enabled', patch.logsRotation.enabled);
      set('logs.rotation.maxBytes', patch.logsRotation.maxBytes);
      set('logs.rotation.maxFiles', patch.logsRotation.maxFiles);
    }
    set('web.search_backend', patch.webSearchBackend);
    set('web.extract_backend', patch.webExtractBackend);
    const setAux = (prefix: string, aux: AuxModelUpdateInput | undefined): void => {
      if (!aux) return;
      set(`${prefix}.model`, aux.model);
      set(`${prefix}.provider`, aux.provider);
      set(`${prefix}.apiKey`, aux.apiKey);
      set(`${prefix}.baseUrl`, aux.baseUrl);
    };
    setAux('auxiliary.compression', patch.auxCompression);
    setAux('auxiliary.vision', patch.auxVision);
    setAux('auxiliary.web', patch.auxWeb);
    // Voice keys with no other UI home. `auxiliary.*` keys the CLI parses but
    // the repository does not model, plus the two `voice.*` keys.
    set('auxiliary.asr.command', patch.voiceSttCommand);
    set('auxiliary.tts.command', patch.voiceTtsCommand);
    set('auxiliary.tts.outputFormat', patch.voiceTtsOutputFormat);
    set('auxiliary.tts.timeout', patch.voiceTtsTimeoutMs);
    set('auxiliary.tts.maxTextLength', patch.voiceTtsMaxTextLength);
    set('auxiliary.asr.timeout', patch.voiceSttTimeoutMs);
    set('voice.defaultMode', patch.voiceDefaultMode);
    set('voice.transcode.ffmpegPath', patch.voiceTranscodeFfmpegPath);
    set('voice.transcode.bitrateKbps', patch.voiceTranscodeBitrateKbps);
    // The yaml key is `timeout`; the field says `Sec` because the unit is the
    // one thing a bare `timeout` next to five `*Ms` neighbours cannot convey.
    set('voice.transcode.timeout', patch.voiceTranscodeTimeoutSec);
    set('voice.artifacts.abandonAfterDays', patch.voiceArtifactAbandonAfterDays);
    set('voice.artifacts.maxTotalMb', patch.voiceArtifactMaxTotalMb);
    set('voice.tier', patch.voiceTier);
    set('voice.realtime.default', patch.voiceRealtimeDefault);
    set('voice.realtime.sessionBudgetUsd', patch.voiceRealtimeSessionBudgetUsd);
    // Clearing the list removes the key, which turns the egress gate off — the
    // gate is armed by DECLARING the key, so there is nothing to keep here.
    setList('voice.trustedPlugins', patch.voiceTrustedPlugins, ', ');
    set('a2a.enabled', patch.a2aEnabled);
    set('plugins.auto_install', patch.pluginsAutoInstall);
    set('webBaseUrl', patch.webBaseUrl);

    // Record groups replace their whole key family: every existing key under
    // the prefix is deleted, then the provided entries are re-written. The
    // read below also supplies stored webhook secrets so an update that omits
    // `secret` keeps the existing one.
    const replacesRecords =
      patch.retention !== undefined ||
      patch.personalityRetention !== undefined ||
      patch.webhooks !== undefined ||
      patch.quickCommands !== undefined ||
      patch.channelToolsets !== undefined ||
      patch.voiceTtsProviders !== undefined ||
      patch.voiceSttProviders !== undefined ||
      patch.voiceRealtimeProviders !== undefined ||
      patch.voiceChannelTtsOut !== undefined ||
      patch.wakeRoutes !== undefined ||
      patch.voiceBargeIn !== undefined ||
      patch.voiceBots !== undefined;
    // The telephony blocks need the same read for two more reasons: a write-only
    // secret has to re-write the value already on disk, and the required-field
    // check below asks what the block looks like AFTER the patch lands.
    const touchesTelephony = TELEPHONY_PATCH_KEYS.some((key) => patch[key] !== undefined);
    const currentPassthrough =
      replacesRecords || touchesTelephony
        ? ((await this.opts.config.read())?.passthrough ?? {})
        : {};
    const deletePrefix = (prefix: string): void => {
      for (const key of Object.keys(currentPassthrough)) {
        if (key.startsWith(prefix)) deleteKeys.push(key);
      }
    };
    if (patch.retention !== undefined) {
      deletePrefix('retention.');
      for (const [sub, dur] of Object.entries(patch.retention)) {
        set(`retention.${sub}`, dur);
      }
    }
    if (patch.personalityRetention !== undefined) {
      for (const key of Object.keys(currentPassthrough)) {
        if (/^personalities\.[^.]+\.retention\./.test(key)) deleteKeys.push(key);
      }
      for (const [pid, map] of Object.entries(patch.personalityRetention)) {
        if (!map) continue;
        for (const [sub, dur] of Object.entries(map)) {
          set(`personalities.${pid}.retention.${sub}`, dur);
        }
      }
    }
    if (patch.voiceChannelTtsOut !== undefined) {
      // Full replacement, same rule as the rosters: an omitted platform is not
      // "unchanged", it is "no override" — which is a different deployment
      // decision from `false` and has to be expressible.
      deletePrefix('voice.channels.');
      for (const [platform, ttsOut] of Object.entries(patch.voiceChannelTtsOut)) {
        set(`voice.channels.${platform}.ttsOut`, ttsOut);
      }
    }
    if (patch.channelToolsets !== undefined) {
      deletePrefix('channel_toolsets.');
      for (const [platform, tools] of Object.entries(patch.channelToolsets)) {
        setList(`channel_toolsets.${platform}`, tools);
      }
    }
    if (patch.quickCommands !== undefined) {
      deletePrefix('quick_commands.');
      for (const [name, qc] of Object.entries(patch.quickCommands)) {
        if (!qc) continue;
        set(`quick_commands.${name}.type`, qc.type);
        if (qc.type === 'exec') set(`quick_commands.${name}.command`, qc.command);
        else set(`quick_commands.${name}.reply`, qc.reply);
        if (qc.gateway) set(`quick_commands.${name}.gateway`, true);
        if (qc.channels && qc.channels.length > 0) {
          setList(`quick_commands.${name}.channels`, qc.channels);
        }
      }
    }
    // Write-only key, shared by all three rosters: a provided value wins,
    // otherwise the stored one is re-written so a form that never saw the key
    // cannot erase it. The value re-written is the `${secrets:…}` reference,
    // which `externalizeSecret` passes through untouched — no second vault
    // entry. The stored key is looked up under the OLD spelling too, so an
    // operator who saves an existing `voice.providers.*` entry keeps its
    // credential.
    const carryRosterKey = (
      kind: 'tts' | 'stt' | 'realtime',
      name: string,
      provided?: string,
    ): void => {
      const apiKey =
        provided ||
        currentPassthrough[`voice.${kind}.providers.${name}.apiKey`] ||
        (kind === 'tts' ? currentPassthrough[`voice.providers.${name}.apiKey`] : undefined);
      if (apiKey) passthroughPatch[`voice.${kind}.providers.${name}.apiKey`] = apiKey;
    };
    if (patch.voiceTtsProviders !== undefined) {
      // Both spellings are dropped, and only the new one is written back: a
      // save from Settings migrates a legacy roster rather than duplicating it.
      deletePrefix('voice.providers.');
      deletePrefix('voice.tts.providers.');
      for (const [name, entry] of Object.entries(patch.voiceTtsProviders)) {
        if (!entry) continue;
        set(`voice.tts.providers.${name}.provider`, entry.provider);
        set(`voice.tts.providers.${name}.model`, entry.model);
        carryRosterKey('tts', name, entry.apiKey);
        set(`voice.tts.providers.${name}.voice`, entry.voice);
        set(`voice.tts.providers.${name}.baseUrl`, entry.baseUrl);
        set(`voice.tts.providers.${name}.command`, entry.command);
        set(`voice.tts.providers.${name}.outputFormat`, entry.outputFormat);
        set(`voice.tts.providers.${name}.timeout`, entry.timeout);
        set(`voice.tts.providers.${name}.maxTextLength`, entry.maxTextLength);
      }
    }
    if (patch.voiceSttProviders !== undefined) {
      deletePrefix('voice.stt.providers.');
      for (const [name, entry] of Object.entries(patch.voiceSttProviders)) {
        if (!entry) continue;
        set(`voice.stt.providers.${name}.provider`, entry.provider);
        set(`voice.stt.providers.${name}.model`, entry.model);
        carryRosterKey('stt', name, entry.apiKey);
        set(`voice.stt.providers.${name}.baseUrl`, entry.baseUrl);
        set(`voice.stt.providers.${name}.command`, entry.command);
        set(`voice.stt.providers.${name}.timeout`, entry.timeout);
      }
    }
    if (patch.voiceRealtimeProviders !== undefined) {
      deletePrefix('voice.realtime.providers.');
      for (const [name, entry] of Object.entries(patch.voiceRealtimeProviders)) {
        if (!entry) continue;
        set(`voice.realtime.providers.${name}.provider`, entry.provider);
        set(`voice.realtime.providers.${name}.model`, entry.model);
        carryRosterKey('realtime', name, entry.apiKey);
        set(`voice.realtime.providers.${name}.baseUrl`, entry.baseUrl);
        set(`voice.realtime.providers.${name}.voice`, entry.voice);
        set(`voice.realtime.providers.${name}.costPerMinuteUsd`, entry.costPerMinuteUsd);
      }
    }
    if (patch.wakeRoutes !== undefined) {
      // Wholesale replacement — see the field's docs. `privileged` and
      // `enabled` are written only when explicitly false/true so a hand-written
      // config that never said either keeps saying nothing.
      deletePrefix('voice.wake.routes.');
      for (const [id, route] of Object.entries(patch.wakeRoutes)) {
        if (!route) continue;
        set(`voice.wake.routes.${id}.phrase`, route.phrase);
        set(`voice.wake.routes.${id}.personality`, route.personality);
        if (route.privileged !== undefined) {
          set(`voice.wake.routes.${id}.privileged`, route.privileged);
        }
        if (route.enabled !== undefined) {
          set(`voice.wake.routes.${id}.enabled`, route.enabled);
        }
      }
    }
    // -- Telephony ------------------------------------------------------------
    // Write-only credential, same rule the rosters use: a provided value wins,
    // otherwise the stored `${secrets:…}` reference is re-written so a form that
    // only ever saw a preview cannot erase the key. `null` is the explicit
    // "clear it", which is the one thing a blank field must NOT mean here.
    const carrySecret = (key: string, provided: string | null | undefined): void => {
      if (provided === null) {
        deleteKeys.push(key);
        return;
      }
      const value = provided || currentPassthrough[key];
      if (value) passthroughPatch[key] = value;
    };
    // The trunk and LiveKit blocks are ANCHORED: the CLI parser requires
    // provider+trunkId (and url+apiKey+apiSecret) together, so clearing the
    // anchor has to take the whole family — including the vault-backed secrets —
    // rather than leaving a half block that fails to load.
    if (patch.voiceTrunkProvider === null) {
      deletePrefix('voice.trunk.');
    } else if (TRUNK_PATCH_KEYS.some((key) => patch[key] !== undefined)) {
      set('voice.trunk.provider', patch.voiceTrunkProvider);
      set('voice.trunk.trunkId', patch.voiceTrunkId);
      set('voice.trunk.fromNumber', patch.voiceTrunkFromNumber);
      set('voice.trunk.username', patch.voiceTrunkUsername);
      set('voice.trunk.webhookPath', patch.voiceTrunkWebhookPath);
      set('voice.trunk.codec', patch.voiceTrunkCodec);
      carrySecret('voice.trunk.password', patch.voiceTrunkPassword);
      carrySecret('voice.trunk.webhookSecret', patch.voiceTrunkWebhookSecret);
    }
    if (patch.voiceLivekitUrl === null) {
      deletePrefix('voice.livekit.');
    } else if (LIVEKIT_PATCH_KEYS.some((key) => patch[key] !== undefined)) {
      set('voice.livekit.url', patch.voiceLivekitUrl);
      carrySecret('voice.livekit.apiKey', patch.voiceLivekitApiKey);
      carrySecret('voice.livekit.apiSecret', patch.voiceLivekitApiSecret);
    }
    // ', ' matches the separator packages/config's writeConfig serializes with.
    setList('voice.inbound.allowlist', patch.voiceInboundAllowlist, ', ');
    set('voice.inbound.receptionist', patch.voiceInboundReceptionist);
    set('voice.inbound.concurrencyCap', patch.voiceInboundConcurrencyCap);
    set('voice.inbound.perCallerPerHour', patch.voiceInboundPerCallerPerHour);
    set('voice.inbound.dailyBudgetUsd', patch.voiceInboundDailyBudgetUsd);
    set('voice.inbound.prewarm', patch.voiceInboundPrewarm);
    // The owner destination is anchored the same way: platform and chatId are
    // required together, and half a route silently drops the one notification
    // the block was configured to deliver.
    if (patch.voiceInboundOwnerPlatform === null) {
      deletePrefix('voice.inbound.owner.');
    } else {
      set('voice.inbound.owner.platform', patch.voiceInboundOwnerPlatform);
      set('voice.inbound.owner.chatId', patch.voiceInboundOwnerChatId);
      set('voice.inbound.owner.botKey', patch.voiceInboundOwnerBotKey);
    }
    if (patch.voiceBargeIn !== undefined) {
      deletePrefix('voice.bargeIn.');
      for (const [surface, tuning] of Object.entries(patch.voiceBargeIn)) {
        if (!tuning) continue;
        set(`voice.bargeIn.${surface}.energyThreshold`, tuning.energyThreshold);
        set(`voice.bargeIn.${surface}.minSpeechMs`, tuning.minSpeechMs);
        set(`voice.bargeIn.${surface}.silenceMs`, tuning.silenceMs);
      }
    }
    if (patch.voiceBots !== undefined) {
      // Renumbered from 0 on every save: the index is positional, not an
      // identity (that is what `id` is for), and leaving gaps would make the
      // next save's ordering depend on which row was deleted.
      deletePrefix('voice.bots.');
      for (const [index, bot] of patch.voiceBots.entries()) {
        if (!bot) continue;
        if (bot.id) set(`voice.bots.${index}.id`, bot.id);
        set(`voice.bots.${index}.match`, bot.match);
        set(`voice.bots.${index}.bind.type`, bot.bind.type);
        set(`voice.bots.${index}.bind.name`, bot.bind.name);
        // Written only when true, matching writeConfig — a config that never
        // said `allowSlashSwitch` keeps saying nothing.
        if (bot.bind.allowSlashSwitch) set(`voice.bots.${index}.bind.allowSlashSwitch`, true);
      }
    }
    if (patch.webhooks !== undefined) {
      deletePrefix('webhooks.');
      for (const [hookId, hook] of Object.entries(patch.webhooks)) {
        if (!hook) continue;
        set(`webhooks.${hookId}.personalityId`, hook.personalityId);
        // Write-only secret: provided value wins, then the stored secret,
        // then a generated one for a brand-new hook. Never echoed back.
        const secret =
          hook.secret ??
          currentPassthrough[`webhooks.${hookId}.secret`] ??
          randomBytes(24).toString('base64url');
        passthroughPatch[`webhooks.${hookId}.secret`] = secret;
        if (hook.sessionKey) set(`webhooks.${hookId}.sessionKey`, hook.sessionKey);
        if (hook.prefilter) set(`webhooks.${hookId}.prefilter`, hook.prefilter);
        if (hook.prefilterTimeoutSeconds !== undefined) {
          set(`webhooks.${hookId}.prefilterTimeoutSeconds`, hook.prefilterTimeoutSeconds);
        }
        if (hook.mode) set(`webhooks.${hookId}.mode`, hook.mode);
      }
    }
    // Required-together checks, run against the block as it will be ON DISK
    // rather than against the patch: a form that sends only `trunkId` leaves a
    // provider already in the file perfectly valid, and a form that clears the
    // provider while leaving a password behind does not. Only the merged view
    // can tell those apart.
    const keysAfterWrite = (prefix: string): Set<string> => {
      const keys = new Set(Object.keys(currentPassthrough).filter((k) => k.startsWith(prefix)));
      for (const key of deleteKeys) if (key.startsWith(prefix)) keys.delete(key);
      for (const key of Object.keys(passthroughPatch)) if (key.startsWith(prefix)) keys.add(key);
      return keys;
    };
    const requireTogether = (prefix: string, required: readonly string[]): void => {
      const keys = keysAfterWrite(prefix);
      if (keys.size === 0) return;
      for (const key of required) {
        if (!keys.has(key)) {
          invalidValue(key, `is required whenever any ${prefix}* key is set`);
        }
      }
    };
    if (touchesTelephony) {
      requireTogether('voice.trunk.', ['voice.trunk.provider', 'voice.trunk.trunkId']);
      requireTogether('voice.livekit.', VOICE_LIVEKIT_KEYS);
      requireTogether('voice.inbound.owner.', [
        'voice.inbound.owner.platform',
        'voice.inbound.owner.chatId',
      ]);
    }
    // A bot bound to a personality that does not exist fails SILENTLY on a
    // ringing phone — the call connects to nothing. The editor is the last place
    // the operator can still see the typo, so it is refused here, the same check
    // `WakeRoutesService` makes for a wake phrase. Team binds are not checked:
    // a team is not in the personality registry.
    const personalities = this.opts.personalities;
    if (personalities && patch.voiceBots) {
      for (const [index, bot] of patch.voiceBots.entries()) {
        if (bot?.bind.type !== 'personality') continue;
        if (!(await personalities.exists(bot.bind.name))) {
          invalidValue(
            `voiceBots.${index}.bind.name`,
            `names unknown personality '${bot.bind.name}'`,
          );
        }
      }
    }

    for (const key of SETTINGS_PATCH_KEYS) delete cleaned[key];

    // A key both deleted (prefix replacement) and re-set in the same patch
    // must survive — the delete pass runs first, so drop it from the list.
    const finalDeletes = [...new Set(deleteKeys)].filter((k) => !(k in passthroughPatch));
    // `webhooks.<id>.secret` and the roster `apiKey`s are all externalized, and
    // the config key is the only thing pointing at the vault entry. Dropping the
    // key alone leaves the material behind forever, so parse the ref that was
    // STORED and hand it to the post-write cleanup.
    //
    // A ref that some SURVIVING key still carries is not dropped: the legacy →
    // `voice.tts.providers.*` migration deletes the old key while re-writing
    // its exact `${secrets:…}` value under the new one, and deleting the vault
    // entry there would blank a credential the operator never touched.
    const survivingRefs = new Set(
      Object.values(passthroughPatch)
        .map((v) => (typeof v === 'string' ? secretRefFromValue(v) : null))
        .filter((ref): ref is string => ref !== null),
    );
    const droppedSecretRefs = finalDeletes
      .filter(
        (k) =>
          /^webhooks\.[^.]+\.secret$/.test(k) ||
          /^voice\.(?:(?:tts|stt|realtime)\.)?providers\.[^.]+\.apiKey$/.test(k) ||
          // Telephony credentials. Reachable from the UI for the first time in
          // this phase, and both are cleared by dropping their whole block
          // (`voiceTrunkProvider: null`, `voiceLivekitUrl: null`), which deletes
          // the only config key pointing at the vault entry.
          /^voice\.trunk\.(?:password|webhookSecret)$/.test(k) ||
          /^voice\.livekit\.(?:apiKey|apiSecret)$/.test(k),
      )
      .map((k) => secretRefFromValue(currentPassthrough[k] ?? ''))
      .filter((ref): ref is string => ref !== null && !survivingRefs.has(ref));
    if (finalDeletes.length > 0) {
      await this.opts.config.deletePassthroughKeys(finalDeletes);
    }

    const passthrough = Object.keys(passthroughPatch).length > 0 ? passthroughPatch : undefined;
    delete cleaned.adminEnabled;
    delete cleaned.streamingEdits;
    delete cleaned.callStyle;
    delete cleaned.callAccent;
    delete cleaned.autoCompact;
    delete cleaned.memoryConsolidationEnabled;
    delete cleaned.memoryCaptureEnabled;
    delete cleaned.memoryCaptureModel;
    delete cleaned.memoryNotices;
    delete cleaned.voiceChime;
    // Written above as flat config keys; never repository fields.
    delete cleaned.voiceSttCommand;
    delete cleaned.voiceTtsCommand;
    delete cleaned.voiceTtsOutputFormat;
    delete cleaned.voiceTtsTimeoutMs;
    delete cleaned.voiceTtsMaxTextLength;
    delete cleaned.voiceSttTimeoutMs;
    delete cleaned.voiceTrustedPlugins;
    delete cleaned.voiceDefaultMode;
    delete cleaned.voiceTranscodeFfmpegPath;
    delete cleaned.voiceTranscodeBitrateKbps;
    delete cleaned.voiceTranscodeTimeoutSec;
    delete cleaned.voiceArtifactAbandonAfterDays;
    delete cleaned.voiceArtifactMaxTotalMb;
    delete cleaned.voiceTier;
    delete cleaned.voiceRealtimeDefault;
    delete cleaned.voiceRealtimeSessionBudgetUsd;

    // Convert providers to repository format when present.
    let repoProviders: RawProviderEntry[] | undefined;
    if (cleaned.providers) {
      repoProviders = cleaned.providers.map((p) => {
        const entry: RawProviderEntry = { provider: p.provider };
        if (p.model) entry.model = p.model;
        if (p.apiKey) entry.apiKey = p.apiKey;
        if (p.baseUrl) entry.baseUrl = p.baseUrl;
        return entry;
      });
    }

    await this.opts.config.update({
      ...cleaned,
      ...(repoProviders !== undefined ? { providers: repoProviders } : {}),
      ...(passthrough !== undefined ? { passthrough } : {}),
      ...(patch.voiceProvider !== undefined
        ? { voiceProvider: patch.voiceProvider || undefined }
        : {}),
      ...(patch.voiceApiKey !== undefined ? { voiceApiKey: patch.voiceApiKey || undefined } : {}),
      ...(patch.voiceBaseUrl !== undefined
        ? { voiceBaseUrl: patch.voiceBaseUrl || undefined }
        : {}),
      ...(patch.voiceModel !== undefined ? { voiceModel: patch.voiceModel || undefined } : {}),
      ...(patch.voiceTtsProvider !== undefined
        ? { voiceTtsProvider: patch.voiceTtsProvider || undefined }
        : {}),
      ...(patch.voiceTtsApiKey !== undefined
        ? { voiceTtsApiKey: patch.voiceTtsApiKey || undefined }
        : {}),
      ...(patch.voiceTtsVoice !== undefined
        ? { voiceTtsVoice: patch.voiceTtsVoice || undefined }
        : {}),
      ...(patch.voiceTtsBaseUrl !== undefined
        ? { voiceTtsBaseUrl: patch.voiceTtsBaseUrl || undefined }
        : {}),
      ...(patch.voiceTtsModel !== undefined
        ? { voiceTtsModel: patch.voiceTtsModel || undefined }
        : {}),
    });

    await this.deleteOrphanedSecrets(droppedSecretRefs);
    try {
      await this.opts.onUpdated?.();
    } catch {
      // The write landed; a broken listener is not the caller's problem.
    }
  }

  /**
   * Drop vault entries whose last config reference was just removed.
   *
   * Runs AFTER the config write, never before: delete-first plus a failed
   * write leaves config referencing material that is gone, while write-first
   * leaves at worst vault litter. `ConfigRepository.deletePassthroughKeys` is
   * deliberately vault-blind — it is the shared "drop a config key" primitive —
   * so the deletion belongs here, alongside the caller that knows the key
   * carried a credential (same shape as PlatformsRepository's removals).
   *
   * Refs still named by a surviving passthrough entry are kept: deleting one
   * would break that entry. Webhook refs embed the webhook id so a collision
   * needs a hand-edited config.yaml, but the check costs one read and the
   * failure mode it guards is a live credential deleted out from under a hook.
   *
   * A failing delete propagates (ARCHITECTURE.md §V S7 — no silent failure).
   * The config change already landed; the error is how the operator learns
   * credential material was left behind.
   */
  private async deleteOrphanedSecrets(refs: string[]): Promise<void> {
    const secrets = this.opts.secrets;
    if (!secrets || refs.length === 0) return;
    const surviving = new Set<string>();
    const after = await this.opts.config.read();
    for (const value of Object.values(after?.passthrough ?? {})) {
      const ref = secretRefFromValue(value);
      if (ref) surviving.add(ref);
    }
    for (const ref of new Set(refs)) {
      if (surviving.has(ref)) continue;
      await secrets.delete(ref);
    }
  }
}

// `${secrets:ref}` — same indirection syntax the CLI's config loader
// resolves (apps/ethos/src/config.ts).
const SECRETS_REF_RE = /\$\{secrets:([^}]+)\}/g;

/** Coerce the stored `display.streaming_edits` value to the enum. Unset or
 *  unrecognized falls back to the effective default, `'dms'`. */
function parseStreamingEdits(value: string | undefined): 'off' | 'dms' | 'all' {
  return value === 'off' || value === 'all' ? value : 'dms';
}

/** `display.call_style` — the Call Stage treatment. Unset = `personality`,
 *  which lets each personality draw its own (declared or derived). */
function parseCallStyle(value: string | undefined): 'liquid' | 'orb' | 'rings' | 'personality' {
  return value === 'orb' || value === 'rings' || value === 'liquid' ? value : 'personality';
}

/**
 * `display.call_accent` — `personality` or a 6-digit hex. Anything else (a typo,
 * a hand-edited config) resolves to `personality` rather than reaching a canvas
 * fillStyle.
 */
function parseCallAccent(value: string | undefined): string {
  return value !== undefined && /^#[0-9a-fA-F]{6}$/.test(value) ? value : 'personality';
}

// ---------------------------------------------------------------------------
// API-key redaction
// ---------------------------------------------------------------------------

/**
 * Render a redacted preview of the active API key. Designed so the user can
 * confirm "which key" is set without leaking enough to use it. Format:
 *   • `sk-…abc1`  — first 3 chars + last 4 (10+ char keys)
 *   • `…abc1`     — last 4 only (6-9 char keys)
 *   • `<unset>`   — empty / undefined
 */
export function redactKey(key: string | undefined): string {
  if (!key) return '<unset>';
  if (key.length >= 10) return `${key.slice(0, 3)}…${key.slice(-4)}`;
  if (key.length >= 6) return `…${key.slice(-4)}`;
  return '<short>'; // <6 chars — almost certainly not a real key
}
