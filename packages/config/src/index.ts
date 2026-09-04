import { homedir } from 'node:os';
import { join } from 'node:path';
import { deriveBotKey as deriveBotKeyFromSeed } from '@ethosagent/core';
import type { ChannelFilterConfig, ChannelPlatformConfig } from '@ethosagent/safety-channel';
import { detectSecrets } from '@ethosagent/safety-redact';
import { REF_TO_ENV } from '@ethosagent/storage-fs';
import type {
  LogLevel,
  ModelProfile,
  RealtimeProviderEntry,
  RetentionConfig,
  RetentionEventsConfig,
  SecretsResolver,
  Storage,
  SttProviderEntry,
  TtsProviderEntry,
} from '@ethosagent/types';

// ---------------------------------------------------------------------------
// ${secrets:ref} substitution
// ---------------------------------------------------------------------------

const SECRETS_REF_RE = /\$\{secrets:([^}]+)\}/g;

async function resolveSecretValue(value: string, secrets: SecretsResolver): Promise<string> {
  const matches = [...value.matchAll(SECRETS_REF_RE)];
  if (matches.length === 0) return value;
  let resolved = value;
  for (const m of matches) {
    const ref = m[1];
    if (!ref) continue;
    const secret = await secrets.get(ref);
    if (secret === null) {
      const envKey = REF_TO_ENV.get(ref);
      if (envKey) {
        throw new Error(
          `Secret not found: ${ref}\n\n` +
            `This secret can be provided by ANY of (highest precedence first):\n` +
            `  1. ~/.ethos/.env file with ${envKey}=<value>\n` +
            `  2. environment variable ${envKey}  (e.g. set by systemd EnvironmentFile, docker -e, or your shell)\n` +
            `  3. ~/.ethos/secrets/${ref}  (file mode 0600 — lowest-precedence fallback)\n\n` +
            `Run \`ethos secrets set ${ref} <value>\` to store it as the on-disk fallback.`,
        );
      }
      throw new Error(
        `Secret not found: ${ref}. Run 'ethos secrets set ${ref} <value>' to store it.`,
      );
    }
    resolved = resolved.replace(m[0], () => secret);
  }
  return resolved;
}

/**
 * Public single-value counterpart of `resolveConfigSecrets`, for surfaces that
 * hold one credential-bearing string rather than a whole `EthosConfig` (the
 * web's own config reader). Throws when a referenced secret is missing —
 * failing loudly beats handing a provider the literal reference string.
 */
export async function resolveSecretRef(value: string, secrets: SecretsResolver): Promise<string> {
  return resolveSecretValue(value, secrets);
}

// ---------------------------------------------------------------------------
// ${secrets:ref} externalization (write path)
// ---------------------------------------------------------------------------

/** True when `value` is ENTIRELY `${secrets:…}` reference(s) — i.e. it carries
 *  no literal credential material. */
function isSecretRef(value: string): boolean {
  return value.replace(SECRETS_REF_RE, '').trim().length === 0;
}

const SINGLE_SECRET_REF_RE = /^\$\{secrets:([^}]+)\}$/;

/**
 * The vault ref a stored config value points at, or `null` when it points at
 * none (a legacy plaintext value predating externalization never had material
 * stored, so there is nothing to delete).
 *
 * The read-back counterpart of `externalizeSecret`, and the ONE parser for the
 * `${secrets:…}` wire format on the removal path. Read the ref that was
 * WRITTEN — never re-derive one: ref names embed context the value alone does
 * not carry (provider name, bot key, content hash), and `externalizeSecret`'s
 * idempotent branch means a field keeps whatever ref it was first minted with.
 * Re-minting from what is on disk would name a ref the vault has never heard
 * of and orphan the real one.
 *
 * Deliberately strict: the whole value must be exactly one reference. A value
 * that merely CONTAINS a reference (`Bearer ${secrets:x}`) or concatenates
 * several yields `null`. Callers use this to decide which credential material
 * to DELETE, so a loose parse deletes material something else still needs.
 */
export function secretRefFromValue(value: string): string | null {
  return value.match(SINGLE_SECRET_REF_RE)?.[1] ?? null;
}

/**
 * Store a credential in the vault and return the `${secrets:<ref>}` reference
 * that belongs in config.yaml. This is the ONLY way a credential-bearing field
 * reaches disk (G-SEC / ARCHITECTURE.md §V S9 — config references a secret by
 * name, never by value).
 *
 * Idempotent: a value that is ALREADY a reference is returned untouched.
 * Re-wrapping would corrupt the config and orphan the stored secret, so that
 * branch is the load-bearing one on every rewrite of an existing config.
 * Empty / undefined values are returned unchanged — there is nothing to store.
 */
export async function externalizeSecret(
  value: string,
  ref: string,
  secrets: SecretsResolver,
): Promise<string>;
export async function externalizeSecret(
  value: string | undefined,
  ref: string,
  secrets: SecretsResolver,
): Promise<string | undefined>;
export async function externalizeSecret(
  value: string | undefined,
  ref: string,
  secrets: SecretsResolver,
): Promise<string | undefined> {
  if (value === undefined || value === '') return value;
  if (isSecretRef(value)) return value;
  await secrets.set(ref, value);
  return `\${secrets:${ref}}`;
}

/** Context `secretRefForConfigKey` needs for the keys whose ref embeds a value
 *  from elsewhere in the config. */
export interface SecretRefContext {
  /** The `provider:` value — names the ref for the top-level `apiKey`. */
  provider?: string;
  /** Provider-chain names by index. `providers.<n>.apiKey` refs embed the
   *  provider name, matching what `ethos fallback add` already mints. */
  providerChain?: readonly string[];
  /** Stable botKey per `telegram.bots.<n>` — `deriveBotKey(bot)`. Keys the
   *  ref by identity rather than array position, matching what the web
   *  Communications tab (PlatformsRepository) already mints. Falls back to
   *  the index when the caller can't supply one. */
  telegramBotKeys?: readonly (string | undefined)[];
  /** Stable botKey per `slack.apps.<n>` — see `telegramBotKeys`. */
  slackAppKeys?: readonly (string | undefined)[];
  /** Stable identity per rotation key in `~/.ethos/keys.json` —
   *  `rotationKeyId(profile)`. See `telegramBotKeys`. */
  rotationKeyIds?: readonly (string | undefined)[];
}

/** Flat key → ref, for keys whose ref name doesn't follow from the key path. */
const STATIC_SECRET_REFS: Record<string, string> = {
  telegramToken: 'telegram/token',
  discordToken: 'discord/token',
  slackBotToken: 'slack/botToken',
  slackAppToken: 'slack/appToken',
  slackSigningSecret: 'slack/signingSecret',
  emailPassword: 'email/password',
};

/** Indexed key families. The ref is keyed by the entry's stable botKey when the
 *  caller supplies one, so reordering the array can't point two entries at one
 *  ref; the array index is the fallback. */
const INDEXED_SECRET_REFS: ReadonlyArray<{
  re: RegExp;
  ref: (m: RegExpMatchArray, ctx: SecretRefContext) => string;
}> = [
  {
    // `webhookSecretToken` rides the same rule as `token` so it is keyed by the
    // bot's stable botKey too — the catch-all below would key it by array index
    // instead, and reordering the roster would then point two bots at one ref.
    re: /^telegram\.bots\.(\d+)\.(token|webhookSecretToken)$/,
    ref: (m, ctx) => `telegram/bots/${ctx.telegramBotKeys?.[Number(m[1])] ?? m[1]}/${m[2]}`,
  },
  {
    re: /^slack\.apps\.(\d+)\.(botToken|appToken|signingSecret)$/,
    ref: (m, ctx) => `slack/apps/${ctx.slackAppKeys?.[Number(m[1])] ?? m[1]}/${m[2]}`,
  },
  {
    // `~/.ethos/keys.json`, not config.yaml — the rotation pool is a second
    // file through the same ref minter. `rotation/` is the prefix `ethos keys`
    // has always used, so it can't collide with the `providers/…` refs above.
    re: /^keys\.(\d+)\.apiKey$/,
    ref: (m, ctx) => `rotation/${ctx.rotationKeyIds?.[Number(m[1])] ?? m[1]}`,
  },
];

/** Credential leaves `SECRET_FIELD_NAMES` doesn't list (it catches these by
 *  regex instead). The write path can't rely on a regex — it must externalize
 *  them by name. */
const EXTRA_SECRET_LEAVES = new Set(['apiSecret', 'secret', 'previousSecret']);

/**
 * Map a flat config key (`apiKey`, `telegram.bots.0.token`, `webhooks.x.secret`)
 * to the vault ref its value belongs at, or `null` when the key carries no
 * credential.
 *
 * The single ref-naming scheme: both config serializers — `writeConfig` here
 * and `ConfigRepository` in apps/web-api — go through it, so a rewrite from
 * either surface lands on the same ref instead of minting a second one and
 * orphaning the first.
 */
export function secretRefForConfigKey(key: string, ctx: SecretRefContext = {}): string | null {
  // `toolSettings.<id>.web_search.secret` is a secret NAME, not a value
  // (WebSearchToolSetting) — externalizing it would break the binding.
  if (key.startsWith('toolSettings.')) return null;
  if (key === 'apiKey') return `providers/${ctx.provider ?? 'default'}/apiKey`;
  const chain = key.match(/^providers\.(\d+)\.apiKey$/);
  if (chain?.[1] !== undefined) {
    const name = ctx.providerChain?.[Number(chain[1])];
    return name ? `providers/${chain[1]}/${name}/apiKey` : `providers/${chain[1]}/apiKey`;
  }
  const staticRef = STATIC_SECRET_REFS[key];
  if (staticRef) return staticRef;
  for (const rule of INDEXED_SECRET_REFS) {
    const m = key.match(rule.re);
    if (m) return rule.ref(m, ctx);
  }
  // Catch-all: any other key whose LEAF names a credential field. Keeps keys
  // this table doesn't enumerate (notably apps/web-api's passthrough block,
  // which round-trips keys it never models) from reaching disk in plaintext.
  // `auxiliary.tts.apiKey` → `auxiliary/tts/apiKey`.
  const leaf = key.slice(key.lastIndexOf('.') + 1);
  if (SECRET_FIELD_NAMES.has(leaf) || EXTRA_SECRET_LEAVES.has(leaf)) {
    return key.replace(/\./g, '/');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Key rotation pool
// ---------------------------------------------------------------------------

export interface KeyProfile {
  apiKey: string;
  priority: number;
  label?: string;
}

export async function readKeys(storage: Storage, secrets?: SecretsResolver): Promise<KeyProfile[]> {
  const src = await storage.read(join(ethosDir(), 'keys.json'));
  if (!src) return [];
  try {
    const keys = JSON.parse(src) as KeyProfile[];
    if (secrets) {
      for (const k of keys) {
        k.apiKey = await resolveSecretValue(k.apiKey, secrets);
      }
    }
    return keys;
  } catch {
    return [];
  }
}

/**
 * Stable identity for a rotation key, used to name its vault ref.
 *
 * `KeyProfile` has no id field and `label` is optional and not unique, so
 * there is nothing to key on but the material itself — the same position
 * `telegram.bots.<n>` is in when the operator omits `id:`. Hashing the value
 * gives a ref that survives reordering, is identical across rewrites, and
 * leaks nothing. Reuses core's `deriveBotKey` rather than hashing here: two
 * implementations of the algorithm is two ways for it to diverge.
 *
 * Only meaningful for a plaintext value. A profile that already carries a
 * `${secrets:…}` reference keeps whatever ref it was minted with — the ref
 * derived here is discarded by `externalizeSecret`'s idempotent branch.
 */
function rotationKeyId(profile: KeyProfile): string {
  return deriveBotKeyFromSeed(profile.apiKey);
}

/**
 * Write-path mirror of `readKeys`: `apiKey` — the one credential-bearing
 * field on `KeyProfile` — is moved into the vault and replaced by its
 * `${secrets:<ref>}` reference. `priority` and `label` carry no credential
 * and are serialized as-is.
 *
 * Existing installs migrate implicitly: the first `writeKeys` after upgrade
 * lifts whatever plaintext keys.json still carries into `~/.ethos/secrets/`.
 */
async function externalizeRotationKeys(
  keys: KeyProfile[],
  secrets: SecretsResolver,
): Promise<KeyProfile[]> {
  const ctx: SecretRefContext = { rotationKeyIds: keys.map(rotationKeyId) };
  const out: KeyProfile[] = [];
  for (const [i, profile] of keys.entries()) {
    const key = `keys.${i}.apiKey`;
    const ref = secretRefForConfigKey(key, ctx);
    if (ref === null) throw new Error(`No secret ref is defined for config key '${key}'`);
    out.push({ ...profile, apiKey: await externalizeSecret(profile.apiKey, ref, secrets) });
  }
  return out;
}

/**
 * Serialize `~/.ethos/keys.json` (the key-rotation pool).
 *
 * `secrets` is REQUIRED for the same reason it is on `writeConfig`: an
 * omittable control is not a guarantee. Every key value is externalized into
 * the vault before serialization, so the file holds ordering and refs only
 * (G-SEC / ARCHITECTURE.md §V S9).
 */
export async function writeKeys(
  storage: Storage,
  keys: KeyProfile[],
  secrets: SecretsResolver,
): Promise<void> {
  const externalized = await externalizeRotationKeys(keys, secrets);
  // Fail-closed gate: the same field policy `writeConfig` applies, on exactly
  // what is about to be serialized. Reused rather than re-implemented so the
  // two write paths can never disagree about what counts as plaintext.
  validateNoPlaintextSecrets({ keys: externalized });
  await storage.mkdir(ethosDir());
  // 0o600 — keys file contains rotation key refs and ordering; restrict to owner.
  await storage.write(join(ethosDir(), 'keys.json'), `${JSON.stringify(externalized, null, 2)}\n`, {
    mode: 0o600,
  });
}

/**
 * The vault ref a rotation profile's `apiKey` points at, or `null` when it
 * points at none — a legacy plaintext profile predating externalization never
 * had material stored, so there is nothing to delete.
 *
 * The removal-side counterpart of `externalizeRotationKeys`. `rotationKeyId`
 * hashes the key VALUE, but `readKeys(storage)` — what `ethos keys` uses —
 * hands back the reference string, so the ref is parsed out of it by
 * `secretRefFromValue` rather than re-derived. The profile-shaped signature is
 * what the rotation-pool callers read against; the parsing itself lives in one
 * place.
 *
 * Refs are content-addressed, so two profiles holding the SAME key value share
 * one ref. Callers deleting on removal must check the surviving profiles first.
 */
export function rotationSecretRef(profile: KeyProfile): string | null {
  return secretRefFromValue(profile.apiKey);
}

export interface ActiveContext {
  /** 'personality' = single agent; 'team' = coordinator against a named mesh */
  type: 'personality' | 'team';
  name: string;
}

/** A personality's binding for the `web_search` tool. `secret` is a NAME
 *  only (e.g. `exa-main`) — resolves to `providers/<provider>/<name>` in the
 *  vault. Never a value (§V S9). */
export interface WebSearchToolSetting {
  provider?: 'exa' | 'tavily' | 'brave';
  secret?: string;
}

/** Per-personality tool config. Only `web_search` is modeled in v1. */
export interface PersonalityToolSettings {
  web_search?: WebSearchToolSetting;
}

/** Global FALLBACK map: personality ID (or `_default`) → per-tool config. */
export type ToolSettingsMap = Record<string, PersonalityToolSettings>;

/**
 * Per-bot routing binding. The bot's external identity (@handle, OAuth app)
 * is fixed to one destination — either a single personality or a team's
 * coordinator. `/personality` switching inside the bot's chats is disabled
 * by default; flip `allowSlashSwitch` only for the rare flexible bot.
 */
export interface BotBinding {
  type: 'personality' | 'team';
  name: string;
  allowSlashSwitch?: boolean;
}

export interface TelegramBotConfig {
  /** Stable identifier used in lane keys + logs. Defaults to a short
   *  sha256 of `token` when omitted. */
  id?: string;
  token: string;
  bind: BotBinding;
  piiRedaction?: boolean;
  /**
   * Receive updates over an inbound webhook instead of long-polling.
   * Default `false` — long-poll, exactly today's behaviour.
   *
   * The four fields below mirror `TelegramAdapterConfig`'s already-implemented
   * field names 1:1 (`extensions/platform-telegram/src/index.ts`) on purpose:
   * they are passed straight through at the one construction site, with no
   * translation layer (plan/phases/telegram-slack-webhook-mode.md §2a).
   */
  useWebhook?: boolean;
  /**
   * Full public URL Telegram POSTs updates to — INCLUDING the
   * `/telegram/webhook/<botKey>` path segment, since the host server routes
   * on that path in multi-bot deployments (§7, §8). Required when
   * `useWebhook` is true.
   */
  webhookUrl?: string;
  /**
   * Shared secret Telegram echoes in `X-Telegram-Bot-Api-Secret-Token`.
   * Required when `useWebhook` is true. Validated by grammy inside
   * `webhookCallback` — no verification code lives here.
   *
   * The adapter already throws when `useWebhook` is set without `webhookUrl`
   * or `webhookSecretToken`, so this layer only passes the values through and
   * deliberately does not duplicate that validation (§2a).
   *
   * A credential: treated exactly like `token` by the secret externalizer, so
   * it can be supplied as `${secrets:<ref>}` and never reaches disk in
   * cleartext.
   */
  webhookSecretToken?: string;
  /**
   * Discard updates Telegram queued while the process was down. Default
   * `true`, preserving the literal that used to be hardcoded at the call site.
   *
   * Only affects POLL-mode bots: grammy's `bot.start()` calls
   * `deleteWebhook({ drop_pending_updates })` on every invocation, so every
   * restart drops the backlog. In webhook mode `bot.start()` is never called
   * and this flag does nothing. A bot that stays on poll mode under a
   * sleep/wake deployment should set this `false`, so a restart after a sleep
   * window does not wipe the backlog Telegram queued while the process was
   * paused (§6).
   */
  dropPendingUpdates?: boolean;
}

export interface SlackAppConfig {
  id?: string;
  botToken: string;
  /**
   * Socket-Mode app-level token. Optional: required only when `mode.socket`
   * is in effect (which is the default). HTTP-mode apps have no Socket-Mode
   * connection and therefore no app token. Enforcement lives in the adapter,
   * not here (§8).
   */
  appToken?: string;
  signingSecret: string;
  bind: BotBinding;
  piiRedaction?: boolean;
  /**
   * Inbound transport. Absent = today's behaviour: Socket Mode.
   *
   * An additive boolean pair (§3b), and a MUTUALLY EXCLUSIVE one: Socket Mode
   * and HTTP Events are two transports for the SAME inbound event stream —
   * Slack's own dashboard treats them as alternatives, and there is no reason
   * to receive every event twice. The adapter throws when both are `true`;
   * this layer only records what the operator wrote.
   */
  mode?: {
    /** Connect over Socket Mode. Default `true`. Requires `appToken`. */
    socket?: boolean;
    /** Receive Events API deliveries over inbound HTTP. Default `false`. */
    http?: boolean;
  };
  /**
   * Route segment this app's HTTP receiver is mounted at, under
   * `/slack/events/`. Absent = the app's botKey. HTTP mode only.
   */
  webhookPath?: string;
  /** Channel mode for channels with no per-channel override. Absent = the
   *  adapter's own default (`mention_only`). */
  defaultChannelMode?: 'mention_only' | 'thread_follow' | 'all';
  /** Slack emoji name (no colons) reacted onto inbound messages to
   *  acknowledge receipt. Absent = the adapter's default (`eyes`). */
  receiptReaction?: string;
  /** Slack user IDs allowed to run `/ethos` and see the App Home tab's private
   *  sections. Narrows `channel_filter.slack` (`ownerUserId` +
   *  `recipientAllowlist`); it cannot widen it, so an id listed here that is
   *  not allowlisted on the message surface stays denied. Empty/absent = the
   *  `channel_filter.slack` allowlist alone. Both empty = nobody. */
  allowedSlashUsers?: string[];
  /** Slack `bot_id`s whose messages reach the agent. Empty/absent drops every
   *  bot/workflow message, which is the behaviour before this key existed. */
  allowedBotIds?: string[];
  /** Reply length (characters) above which the adapter posts a lead message
   *  plus the full answer as `answer.md` instead of a chunk wall. Absent = the
   *  adapter's default (9000); `0` disables the fallback. */
  longReplyThresholdChars?: number;
}

/**
 * Per-team runtime knobs that the gateway honors when a bot binds to
 * `bind.type === 'team'`. Keyed by team manifest name.
 */
export interface TeamRuntimeConfig {
  /** Stop the team supervisor when the gateway shuts down. Default false:
   *  supervisors are long-lived and outlive the gateway. */
  autoStop?: boolean;
}

export interface WhatsAppConfig {
  id?: string;
  session_dir?: string;
  default_mode?: 'all' | 'mention_only';
  allowed_numbers?: string[];
  /** When set, the adapter links via phone-number pairing code instead of QR.
   *  Stored as entered; the adapter strips non-digits before requesting. */
  phone_number?: string;
  /** Optional personality/team binding. Unlike slack/telegram (which require
   *  a bind), WhatsApp bind is optional — bind-less entries fall back to the
   *  default personality in the gateway. */
  bind?: BotBinding;
  piiRedaction?: boolean;
}

/**
 * Real-time voice bot binding (plan/phases/gap-voice-realtime.md §3(b),(e)).
 * Mirrors `telegram.bots[]`: one entry binds a personality/team to the voice
 * lane the bot answers. `match` is the room name or E.164 number pattern the
 * concrete transport routes on — it replaces `token`, since a voice bot has no
 * chat-platform token. The botKey derives from `id` (explicit) or `match`,
 * feeding the lane key `voice:<botKey>:<callerId>`.
 *
 * LiveKit / SIP-trunk connection keys are deliberately NOT modeled here yet;
 * they land with the concrete transport under `voice.livekit.*` / `voice.trunk.*`
 * in a later, isolated step. This step adds only the personality↔voice-bot
 * binding shape.
 */
export interface VoiceBotConfig {
  /** Stable identifier used in lane keys + logs. Defaults to a short
   *  sha256 of `match` when omitted. */
  id?: string;
  /** Room name or E.164 phone-number pattern this bot answers. */
  match: string;
  bind: BotBinding;
}

/**
 * LiveKit connection keys for the real-time voice transport
 * (plan/phases/gap-voice-realtime.md §3(b)). `url` is the LiveKit server/room
 * URL; `apiKey`/`apiSecret` are the LiveKit project credentials the token
 * minter signs access tokens with. All three are required together — a partial
 * block surfaces as a parse error. The concrete transport
 * (`@ethosagent/platform-voice`) consumes these; the native `@livekit/rtc-node`
 * / `livekit-server-sdk` bindings are supplied at the app layer, not committed.
 */
export interface VoiceLiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

/**
 * SIP trunk config for telephony (plan/phases/gap-voice-realtime.md §4 Phase C).
 * A rented PSTN number + SIP trunk (Twilio/Telnyx/…) is pointed at LiveKit SIP,
 * so an inbound/outbound phone call becomes just another LiveKit participant
 * bridged into a room. This block holds the trunk-level connection facts; the
 * per-number → personality routing reuses `voice.bots[]` (a bot's `match` is an
 * E.164 number/pattern, its `bind` names the personality/team — no separate
 * mapping structure).
 *
 * `provider` + `trunkId` are required together. `password`, like
 * `voice.livekit.apiSecret`, is read as a literal — the concrete SIP binding
 * (`livekit-server-sdk` SIP API) is supplied at the app layer, not committed.
 */
export interface VoiceTrunkConfig {
  /** Telephony trunk provider bridged into LiveKit SIP. Selects which inbound
   *  webhook signature scheme the listener verifies with — the providers do not
   *  agree on how a request is signed, so this is the one fact the verifier
   *  cannot infer from the payload. */
  provider: 'twilio' | 'telnyx' | 'generic' | 'livekit';
  /** LiveKit SIP trunk id the number is attached to (inbound + outbound). */
  trunkId: string;
  /** Caller-ID number presented on outbound `call` (E.164). Optional. */
  fromNumber?: string;
  /** SIP registrar/auth username for outbound trunk auth. Optional. */
  username?: string;
  /** SIP auth password/token. Optional; read as a literal (like apiSecret). */
  password?: string;
  /**
   * Shared secret the inbound-webhook listener verifies the trunk's signature
   * against. Separate from `password`: that one authenticates US to the trunk
   * on an outbound leg, this one authenticates the TRUNK to us on an inbound
   * one, and a deployment that rotates one must not be forced to rotate the
   * other. Externalized to the vault exactly like `password`.
   */
  webhookSecret?: string;
  /**
   * HTTP path the gateway's inbound listener mounts the trunk webhook at, e.g.
   * `/voice/inbound`. Must start with `/`. Left undefined when absent — the
   * default belongs to the listener that serves the route, not to the parser
   * that reads the file.
   */
  webhookPath?: string;
  /**
   * Preferred call codec. `opus` where the trunk carries it (wideband, the
   * better ear), `g711` for the narrowband PSTN fallback every trunk speaks.
   * Absent leaves the choice to the bridge's own negotiation.
   */
  codec?: 'opus' | 'g711';
}

/**
 * Inbound-call policy: who gets through, what it may cost, and who hears about
 * it (plan/phases/voice-v4-telephony.md — inbound hardening).
 *
 * A phone number is the one surface strangers can reach without being invited,
 * so the answering rules are DEPLOYMENT facts, not personality identity: the
 * same receptionist personality behind a personal line and behind a business
 * line should reasonably disagree about allowlists, budgets and who to notify.
 */
export interface VoiceInboundConfig {
  /**
   * Caller numbers that reach the owner's own personality with pre-warm on
   * ring. E.164 patterns using the same `*` wildcard grammar as
   * `voice.bots[].match` (`matchesVoicePattern`), so one grammar governs every
   * number match in the system.
   *
   * Absent = no allowlist configured, which the consumer reads as "screen
   * everyone through the receptionist". An operator wanting an explicitly
   * EMPTY allowlist cannot express it here: a flat `key: value` line with no
   * value does not parse, so absent and empty are the same file. Say
   * `voice.inbound.receptionist` instead — that IS the empty-allowlist policy.
   */
  allowlist?: string[];
  /** Personality id answering callers that are not on the allowlist. Runs in a
   *  restricted scope — no owner memory, no privileged tools. */
  receptionist?: string;
  /** Ceiling on concurrent inbound calls; over-cap callers get busy handling.
   *  Positive integer. Absent = the consumer's default (2). */
  concurrencyCap?: number;
  /** Per-caller call ceiling inside a rolling hour — the anti-hammering knob.
   *  Positive integer. */
  perCallerPerHour?: number;
  /** Daily spend ceiling in USD across all inbound calls. Positive number. */
  dailyBudgetUsd?: number;
  /**
   * Which callers get the realtime provider socket opened during ring.
   * `allowlisted` (known callers only — pre-warm where the call is almost
   * certainly worth answering), `none` (always warm on answer), `all` (warm
   * every ring, and pay for the ones that get screened).
   */
  prewarm?: 'allowlisted' | 'none' | 'all';
  /**
   * Where call summaries and capacity/refusal notices are delivered. `platform`
   * and `chatId` are required together — a destination missing either half is a
   * parse error rather than a half-built route that silently drops the one
   * notification the operator configured this block to receive.
   */
  owner?: { platform: string; chatId: string; botKey?: string };
}

/**
 * The audio surfaces whose barge-in sensitivity tunes separately.
 *
 * Three, since L1 (plan §7 "Conflict 2"): the browser talk lane's pipeline tier
 * now runs on the SAME `VoiceSession` orchestrator as `call`/`satellite`, so it
 * gets the same tuner. `voice.bargeIn.browser` always wins when present; the
 * legacy flat `display.voice_*` keys (Settings → Voice → Advanced voice
 * tuning) are read through as a fallback ONLY when `voice.bargeIn.browser` is
 * absent — see `readLegacyBrowserBargeInTuning` in
 * `apps/web-api/src/services/config.service.ts`. `display.voice_speech_threshold`
 * / `display.voice_speech_min_ms` have no counterpart here: they tuned the
 * browser's own local endpointer, which the streaming pipeline lane no longer
 * has.
 */
export type VoiceBargeInSurface = 'call' | 'satellite' | 'browser';

/** Barge-in / VAD thresholds for one surface. Every field optional — an
 *  operator tunes the one knob a room is wrong about, not all three. */
export interface VoiceBargeInTuning {
  /** Input energy above which the caller counts as speaking, 0 < x <= 1. */
  energyThreshold?: number;
  /** Milliseconds of speech before a barge-in is believed. Positive integer. */
  minSpeechMs?: number;
  /** Milliseconds of silence that end an utterance. Positive integer. */
  silenceMs?: number;
}

/**
 * Per-surface barge-in sensitivity. A phone line is noisier than a room and a
 * satellite sits across that room, so one global threshold is wrong on at least
 * one of the two — this is the config that lets each be right.
 *
 * Partial on purpose: only the surfaces the operator declared are present, so a
 * consumer can tell "tuned to this" from "never tuned" and apply its own
 * default to the rest.
 */
export type VoiceBargeInConfig = Partial<Record<VoiceBargeInSurface, VoiceBargeInTuning>>;

/**
 * `voice.filler.*` — the spoken/tick keep-alive `VoiceSession` plays during a
 * long tool call (`extensions/voice-session/src/voice-session.ts`). A SETTING,
 * not personality identity (plan/phases/voice-live-personality.md §9): the
 * line and its cadence are the operator's call, the same as barge-in tuning,
 * and apply uniformly across every lane (call, satellite, browser) — unlike
 * `bargeIn`, there is no per-surface split, because the gap this covers (a
 * silent tool call) is the same gap on every surface.
 */
export interface VoiceFillerConfig {
  /** Master switch. Absent = true = on. */
  enabled?: boolean;
  /** Debounce (ms) before speaking the filler line. Absent = the built-in default. */
  afterMs?: number;
  /** Spoken filler text. Absent = the built-in default. */
  text?: string;
  /** Repeat interval (ms) for the non-speech tick cue. Absent = the built-in default. */
  tickIntervalMs?: number;
}

/**
 * One wake-phrase → personality route (`voice.wake.routes.<id>`).
 *
 * Lives here, next to `VoiceBotConfig` / `VoiceTrunkConfig`, rather than in
 * `@ethosagent/types`: a wake route is a DEPLOYMENT routing fact the operator
 * writes in `config.yaml`, not a runtime contract the kernel resolves. Nothing
 * in `packages/core` reads it — which is exactly why `TtsProviderEntry` had to
 * live in contracts and this does not.
 */
export interface WakeRouteConfig {
  /** The spoken trigger, e.g. `hey engineer`. */
  phrase: string;
  /** Personality id this phrase wakes. Validated against the registry at dispatch. */
  personality: string;
  /**
   * Opt-in for a PRIVILEGED personality (eng-review D13). The default wake
   * surface exposes only unprivileged personalities: anyone within earshot can
   * trigger a wake, so a personality with consequential tools must be named
   * explicitly here before a voice from across the room can reach it. Absent =
   * false = not wake-reachable if the personality is privileged.
   */
  privileged?: boolean;
  /** Route off without deleting it. Absent = enabled. */
  enabled?: boolean;
}

export interface ProviderConfig {
  provider: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Azure-only: REST API version (e.g. `2024-10-21`). Required when
   *  `provider === 'azure'`; ignored otherwise. */
  apiVersion?: string;
  /** Bedrock-only: AWS region for the Bedrock runtime endpoint (e.g.
   *  `us-west-2`). Defaults to `us-east-1`; ignored otherwise. */
  region?: string;
  /** Bedrock-only: named AWS profile from `~/.aws/config` (e.g. an SSO profile
   *  after `aws sso login`), used when no static keys are configured; ignored
   *  otherwise. Named `awsProfile`, not `profile`, because `profile` already
   *  means a per-model `ModelProfile` (`models.*`) in this config. */
  awsProfile?: string;
}

/**
 * FW-16 / context-economy Phase 1 — user-defined `/name` shortcuts.
 * `exec` runs an operator-authored shell command; `reply` returns a canned
 * string with no shell involved. `gateway: true` (default false) exposes the
 * command to channel messages via the `gateway_message` claiming hook;
 * `channels` optionally restricts that exposure to the listed platforms.
 * Channel text is only ever exact-matched against `/name` — it is never
 * interpolated into `command`.
 */
export type QuickCommandConfig =
  | { type: 'exec'; command: string; gateway?: boolean; channels?: string[] }
  | { type: 'reply'; reply: string; gateway?: boolean; channels?: string[] };

/**
 * Auxiliary model wiring for non-primary work. Today the only consumer is
 * context compression: `semantic_summary` runs its summarizer on this
 * (typically cheap) model so a compacting turn costs ~one Haiku-tier call
 * instead of a full main-model re-prompt. `provider` / `apiKey` / `baseUrl`
 * default to the primary provider's values when unset.
 */
export interface AuxiliaryCompressionConfig {
  model: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Proactive memory capture (memory-experience pillar B). Default-OFF: absent or
 * `enabled !== true` means no capture runner is wired and behaviour is
 * unchanged (opt-in for one release). `model` (+ optional provider/apiKey/
 * baseUrl) selects the cheap auxiliary model for the single extraction call per
 * turn; when unset the primary model is reused. Rate caps default to 6/hour,
 * 30/day per scope. Config keys:
 *   memoryCapture.enabled: true
 *   memoryCapture.model: claude-haiku-4-5-20251001
 *   memoryCapture.maxPerHour: 6
 *   memoryCapture.maxPerDay: 30
 */
export interface MemoryCaptureConfig {
  enabled?: boolean;
  model?: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  maxPerHour?: number;
  maxPerDay?: number;
}

/**
 * Bring-your-own-vault memory backend (memory-lifecycle L1). Read only when
 * `memory: vault`. Parsed from flat `memoryVault.<field>` keys:
 *   memoryVault.path: /Users/you/Documents/ObsidianVault
 *   memoryVault.agentDir: Ethos
 *   memoryVault.prefetch: MEMORY.md, USER.md
 *   memoryVault.exclude: Archive, Templates
 */
export interface MemoryVaultConfig {
  /** Absolute path to the vault root (the Obsidian folder). */
  path?: string;
  /** Subtree the agent owns; scopes route beneath it. Default `Ethos`. */
  agentDir?: string;
  /** Keys prefetched into the prompt tail. Default `MEMORY.md`, `USER.md`. */
  prefetch?: string[];
  /** Directory / file names hidden from list + search. */
  exclude?: string[];
}

/**
 * Approve-before-store gate (memory-lifecycle L2, §3b). Default-OFF: absent or
 * `mode: off` means every memory write lands durably as before (opt-in for one
 * release, matching the capture/dedup-hatch precedent). Parsed from flat
 * `memoryApproval.<field>` keys:
 *   memoryApproval.mode: automated   # off | automated | all
 *   memoryApproval.cap: 200          # per-scope queue hard cap
 *   memoryApproval.ttlDays: 30       # pending candidates auto-reject after N days
 *
 * `automated` gates the autonomous writers (`capture`, `dream`); `all` also
 * gates explicit tool/consolidation writes. Approved candidates replay through
 * the provenance history under their original source plus `approvedBy`.
 */
export interface MemoryApprovalConfig {
  mode?: 'off' | 'automated' | 'all';
  /** Per-scope pending-queue hard cap. At cap the oldest is dropped. Default 200. */
  cap?: number;
  /** Pending candidate TTL in days; expired candidates auto-reject. Default 30. */
  ttlDays?: number;
}

/**
 * Importance scoring + decay tuning (memory-experience pillar C, §4.2/§4.3).
 * All optional — the nightly pass applies defaults (30-day half-life, 0.05
 * archive threshold, USER.md exempt). Parsed from flat `memoryConsolidation.<field>`
 * keys.
 */
export interface MemoryConsolidationConfig {
  // Importance scoring + decay tuning (memory-experience pillar C, §4.2/§4.3).
  /** Recency half-life in days. Default 30. */
  halfLifeDays?: number;
  /** Effective weight below which a section is archived. Default 0.05. */
  threshold?: number;
  /** Exempt USER.md from decay entirely. Default true. */
  exemptUser?: boolean;
  // Silent memory-flush turn (context-compaction Phase 3). At a soft threshold
  // (default 70% of the model-aware gate) a non-persisted agentic turn,
  // restricted to the memory tools, consolidates durable facts into
  // MEMORY.md / USER.md before auto-compaction later drops raw history.
  /** Enable the opt-in silent memory-flush turn. */
  enabled?: boolean;
  /** Soft threshold (fraction of the model-aware gate) that triggers the flush. Default 0.7. */
  flushThreshold?: number;
  /** Timebox for the flush turn in ms. Default 30000. */
  timeboxMs?: number;
  /** Max tokens for the flush turn. Default 1024. */
  maxTokens?: number;
  /** Max delta chars written per flush. Default 4000. */
  maxDeltaChars?: number;
  /** Minimum messages since last flush before another runs. Default 8. */
  minMessagesSinceFlush?: number;
}

/**
 * tools-vision P2 — auxiliary vision model wiring. `vision_analyze` uses this
 * (typically vision-capable) model when the active personality's primary
 * model can't handle images / PDFs, or when the user wants to route vision
 * traffic to a cheaper model. `provider` / `apiKey` / `baseUrl` default to
 * the primary provider's values when unset, same as compression.
 */
export interface AuxiliaryVisionConfig {
  model: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * tools-web — auxiliary model for web_extract summarization. Same shape as
 * compression/vision. When set, web_extract summarizes large pages via this
 * (typically cheap) model instead of returning truncated raw text.
 */
export interface AuxiliaryWebConfig {
  model: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * tools-web — web search/extract backend selection, plus the web API
 * server's bind address, port, and CORS origins (`web.host` / `web.port` /
 * `web.corsOrigins`). Two unrelated features share this block because the
 * config-file key is `web.*` in both cases — do not split into two
 * top-level `web:` keys.
 */
export interface WebConfig {
  search_backend?: 'exa' | 'tavily' | 'brave';
  extract_backend?: 'htmltext';
  /** `--web-host` / `ETHOS_WEB_HOST` default when unset. */
  host?: string;
  /** `--web-port` / `ETHOS_WEB_PORT` default when unset. */
  port?: number;
  /** `ETHOS_API_CORS_ORIGINS` default when unset. Comma-separated origins or `*`. */
  corsOrigins?: string;
}

/**
 * Remote model catalog configuration. Controls how Ethos fetches and caches
 * the centralized model metadata catalog (capabilities, context windows, pricing).
 */
export interface ModelCatalogConfig {
  /** Whether remote catalog fetching is enabled. Default true. */
  enabled?: boolean;
  /** URL of the catalog JSON endpoint. Default: https://ethos-agent.ai/api/model-catalog.json */
  url?: string;
  /** Cache TTL in hours. Default: 24. */
  ttlHours?: number;
  /** Per-provider URL overrides for catalog endpoints. */
  providers?: Record<string, { url: string }>;
}

export interface AwsSecretsConfig {
  enabled?: boolean;
  region?: string;
  prefix?: string;
  endpoint?: string;
}

export interface AwsConfig {
  secrets?: AwsSecretsConfig;
}

/**
 * Langfuse export target (analytics-observability plan, Part E / D7).
 * `secretKey` is a real credential and is vaulted like every other provider
 * secret in this codebase (see `SECRET_FIELD_NAMES`); `publicKey` is not —
 * Langfuse's own docs treat it the same as a client id.
 */
export interface TelemetryLangfuseExportConfig {
  /** Default false — export is opt-in. */
  enabled?: boolean;
  baseUrl?: string;
  publicKey?: string;
  secretKey?: string;
}

export interface TelemetryExportConfig {
  langfuse?: TelemetryLangfuseExportConfig;
}

export interface TelemetryConfig {
  export?: TelemetryExportConfig;
}

/** Per-hook inbound webhook config (`webhooks.<hookId>.*` keys). */
export interface WebhookHookConfig {
  personalityId: string;
  secret: string;
  sessionKey?: string;
  /** Prefilter script (scripts-dir relative, .sh/.py) run with the raw
   *  request body on stdin before any turn is dispatched. */
  prefilter?: string;
  /** Wall-clock limit for the prefilter in seconds. Default 30, max 600. */
  prefilterTimeoutSeconds?: number;
  /** 'sync' (default) holds the connection for the agent's reply;
   *  'ack' responds 202 immediately and runs the turn detached. */
  mode?: 'sync' | 'ack';
  /** Accepted event names (comma-separated in the file). Absent accepts every
   *  request — the pre-existing behavior. */
  events?: string[];
  /** Request header carrying the event name. Default `'x-event-type'`.
   *  Requires `events`. */
  eventHeader?: string;
  /** Dotted path into the JSON body holding the event name, used when the
   *  header is absent. Default `'event'`; e.g. `'meta.event'`. Requires
   *  `events`. */
  eventField?: string;
  /** Relay the payload and dispatch no turn at all — the model is never
   *  involved, and the `prompt`/`text` body requirement does not apply.
   *  Requires at least one `deliver` target. */
  deliverOnly?: boolean;
  /** Extra destinations for this hook's content, fanned out alongside (never
   *  instead of) the HTTP response. Written as numbered keys:
   *  `webhooks.<id>.deliver.0.type` etc. */
  deliver?: WebhookDeliveryTargetConfig[];
  /** Payload-integrity signing, ADDITIVE to the bearer `secret` and never a
   *  replacement for it: when set, both gates must pass. Written as nested
   *  keys: `webhooks.<id>.hmac.secret` etc. */
  hmac?: WebhookHmacConfig;
  /** Per-hook request throttle. Absent → unlimited, the pre-existing
   *  behavior. Written as nested keys: `webhooks.<id>.rateLimit.maxPerMinute`
   *  etc. */
  rateLimit?: WebhookRateLimitConfig;
}

/**
 * One `webhooks.<id>.rateLimit` block. The limiter it configures is
 * in-process and keyed by hookId — the gateway is a single-process model, so
 * there is no shared bucket to coordinate.
 */
export interface WebhookRateLimitConfig {
  /** Requests allowed per minute. Also the bucket size. */
  maxPerMinute?: number;
  /** Lockout applied once the bucket empties. Default 600 (10 minutes). */
  lockoutSeconds?: number;
}

/**
 * One `webhooks.<id>.hmac` block. The signature is computed over the raw
 * request body and compared against `secret` — or `previousSecret`, which
 * exists so an operator can roll the sender's key without a synchronized
 * cutover.
 */
export interface WebhookHmacConfig {
  /** Shared signing secret. Externalized to the vault by the writer. */
  secret: string;
  /** Header carrying the bare hex signature. Default `'x-signature'`. */
  header?: string;
  /** Hash algorithm. Default `'sha256'`; see `WEBHOOK_HMAC_ALGORITHMS`. */
  algorithm?: string;
  /** Previous secret, still accepted during a rotation window. Externalized
   *  to the vault by the writer, exactly like `secret`. */
  previousSecret?: string;
}

/**
 * Algorithms an operator may name in `webhooks.<id>.hmac.algorithm`.
 *
 * Deliberately a short allowlist rather than a passthrough: the value reaches
 * `createHmac`, and an arbitrary operator string there is a footgun (a typo
 * throws at request time, and exotic OpenSSL digests are not something a
 * webhook sender emits). These three cover every signing scheme shipped by the
 * senders this feature exists for.
 */
export const WEBHOOK_HMAC_ALGORITHMS = ['sha256', 'sha1', 'sha512'] as const;

/**
 * One `webhooks.<id>.deliver.<n>` destination.
 *
 * - `log` — the process log. Carries no other field.
 * - `platform` — a live adapter, named by `adapterId` (exactly
 *   `PlatformAdapter.id`, e.g. `telegram:tg-a`), plus the `chatId` to send to
 *   and an optional `threadId` for a sub-conversation.
 */
export type WebhookDeliveryTargetConfig =
  | { type: 'log' }
  | { type: 'platform'; adapterId: string; chatId: string; threadId?: string };

/**
 * On-disk schema version for `~/.ethos/config.yaml`. Bump on a breaking
 * field rename, type change, or required-field addition; do NOT bump on
 * additive optional fields. The loader uses this to drive migrations in
 * future releases without guessing whether an unknown field is an
 * operator typo or an older shape.
 *
 * Current shape lives at version 1. Pre-versioned configs (created before
 * this field shipped) load with a one-line deprecation warning and are
 * treated as `1`; the writer always emits the current value going
 * forward.
 */
export const CURRENT_ETHOS_CONFIG_SCHEMA_VERSION = 1;

/**
 * Background sub-agent job config (`background:` section). All fields optional;
 * omitted values fall back to the defaults in `backgroundDefaults()`. Lives in
 * ~/.ethos/config.yaml, NOT on PersonalityConfig (frozen schema).
 *
 * Distinct from the FW-13 `backgroundMaxConcurrent` scalar (config key
 * `background.max_concurrent`) — that governs interactive background sessions;
 * this section governs the Background Sub-Agents job pool.
 */
export interface BackgroundConfig {
  /** Master switch. Default resolved by the wiring layer per surface, not here. */
  enabled?: boolean;
  /** Separate concurrency pool size for background jobs (additive to interactive). Default 2. */
  maxConcurrentJobs?: number;
  /** Max simultaneous active (queued|running) jobs per root session. Default 3. */
  maxJobsPerRoot?: number;
  /** Max simultaneous active jobs per personality. Default 5. */
  maxJobsPerPersonality?: number;
  /** Default per-job cost cap in USD when the tool call omits max_cost_usd. Default 1.00. */
  defaultMaxCostUsd?: number;
  /** Finite-by-default aggregate background spend cap per root, summed over rootSessionKey. Default 5.00. */
  maxRootBackgroundUsd?: number;
  /** Queued rows older than this at boot are expired (ms). Default 900000 (15 min). */
  queuedTtlMs?: number;
  /** Heartbeat staleness threshold (ms). Default 90000 (90s = 3 missed 30s beats). */
  staleMs?: number;
  /** Executor per-job heartbeat timer interval (ms). Default 30000. */
  heartbeatMs?: number;
  /** Terminal-row retention before GC (days). Default 30. */
  retentionDays?: number;
  /**
   * The Pi job runner (`@ethosagent/execution-pi`). Registered ONLY when
   * `image` is set: the host runs inside a container built from it, and there
   * is no sane default to guess — the reference must be digest-pinned, which
   * makes it a per-deployment fact. Absent means `delegate_task(runner: 'pi')`
   * answers `not_available`, which is the honest state of a machine that never
   * built the image.
   */
  pi?: {
    /** Digest-pinned image (`@sha256:`) with `pi` on PATH. See the package's docker/Dockerfile. */
    image: string;
    /** Container memory ceiling in MB. Default 2048 — a coding agent, not a shell. */
    memoryMb?: number;
    /** Host directory holding Pi's `auth.json`. Default `~/.pi/agent`. */
    configDir?: string;
  };
  /**
   * Real ACP-native coding-agent CLIs (`@ethosagent/execution-coding-agents`),
   * keyed by the id each entry registers its OWN `JobRunner` under
   * (`runner: 'claude'`, `runner: 'gemini'`, ...) — see
   * plan/phases/acp-job-runner.md's "Config shape". Each entry needs its own
   * digest-pinned `image`, same posture and reason as `pi.image` (D-ACP4): a
   * bare tag does not satisfy D4's containment claim.
   */
  acp?: {
    agents: Record<
      string,
      {
        /** The ACP agent binary to exec inside the container. */
        command: string;
        /** Args after `command`. Defaults to none. */
        args?: string[];
        /** Digest-pinned image (`@sha256:`) with `command` reachable inside it. */
        image: string;
      }
    >;
  };
}

/**
 * Canonical defaults for the `background:` section. `enabled` defaults to false;
 * the wiring layer may override per surface. All other fields are finite.
 */
export function backgroundDefaults(): Required<Omit<BackgroundConfig, 'enabled' | 'pi' | 'acp'>> & {
  enabled: boolean;
} {
  return {
    enabled: false,
    maxConcurrentJobs: 2,
    maxJobsPerRoot: 3,
    maxJobsPerPersonality: 5,
    defaultMaxCostUsd: 1.0,
    maxRootBackgroundUsd: 5.0,
    queuedTtlMs: 900_000,
    staleMs: 90_000,
    heartbeatMs: 30_000,
    retentionDays: 30,
  };
}

/**
 * Cron trigger surface (`cron:` section,
 * plan/phases/cron-fire-url-collapse.md). One presence-gated switch:
 * `cron.fireUrl` present means external mode (no in-process interval;
 * something outside the process drives `POST /cron/fire`), absent means local
 * mode (today's in-process `setInterval`). There is no third state, and in
 * particular no way to configure "nothing fires anything."
 *
 * Defaults are applied by the wiring layer (`@ethosagent/cron`'s
 * `buildCronTriggers`), not here — an absent `cron:` section means "use
 * today's behavior", i.e. local mode.
 *
 * `trigger` and `arming` are the legacy four-key surface, still parsed for one
 * release by the deprecation shim in `buildCronConfig`.
 */
export interface CronTopLevelConfig {
  /**
   * URL an external scheduler is expected to reach `POST /cron/fire` on.
   * Present → external mode; absent → local mode. Config key:
   *   cron.fireUrl: https://agent.example.com/cron/fire
   * Overridden by the `ETHOS_CRON_FIRE_URL` environment variable.
   *
   * WHY A URL AND NOT A BOOLEAN. Nothing reads this value today — no code path
   * fetches it, `NoopArmingBackend` is inert, and `HttpFireTrigger` is called
   * *by* the route rather than calling out. So it looks like a boolean wearing
   * a string, and the obvious "simplification" is `cron.external: true`. Do not
   * make it. First, it is the exact field a real `CronArmingBackend` will need
   * — the address it calls back on — so the boolean would have to be replaced
   * by this field later, breaking every operator's config at that point.
   * Second, it documents, in the file where an operator actually looks, WHERE
   * the external scheduler is expected to reach this process; a boolean
   * destroys that information. (plan/phases/cron-fire-url-collapse.md, N1.)
   */
  fireUrl?: string;
  /**
   * @deprecated Removed in 0.9.0. Replaced by `cron.fireUrl`: absent means
   * local mode, present means external mode. `external` no longer gates
   * anything — `POST /cron/fire` is mounted on every process that has an HTTP
   * surface, reachable only by a bearer key with the `cron` scope.
   */
  trigger?: {
    /** Run the in-process interval trigger. Default `true`. */
    local?: boolean;
    /** Mount `POST /cron/fire`, gated by a bearer key with the `cron` scope. Default `false`. */
    external?: boolean;
  };
  /**
   * @deprecated Removed in 0.9.0. `backend` never had an implementation other
   * than the inert `NoopArmingBackend` and was always ignored; `fireUrl` is
   * replaced by the top-level `cron.fireUrl`.
   */
  arming?: {
    /** Who gets told the next `nextRunAt`. Only `'none'` is implemented this phase. Default `'none'`. */
    backend?: string;
    /** Public URL the arming backend calls back on wake. Required for every backend except `'none'`. */
    fireUrl?: string | null;
  };
  /**
   * Cap on cron jobs executing at once across overlapping ticks. A due job
   * reached while the cap is met is left unclaimed and fires on a later tick.
   * Positive integer; absent = no cap (today's behavior). Config key:
   *   cron.maxParallelJobs: 2
   */
  maxParallelJobs?: number;
}

export interface EthosConfig {
  /**
   * On-disk schema version. Optional for backward compatibility — pre-
   * versioned configs are accepted as `1` with a deprecation warning.
   * Always written by `writeConfig` going forward.
   */
  schemaVersion?: number;
  provider: string;
  model: string;
  apiKey: string;
  personality: string;
  /** Memory backend: 'markdown' (default), 'vector' (semantic retrieval), or 'vault' (bring-your-own external directory) */
  memory?: 'markdown' | 'vector' | 'vault';
  /**
   * Per-key ceilings, in characters, for the markdown memory backend. A write
   * past the ceiling keeps the newest content and archives the trimmed prefix
   * into `memory-archive.md`. Both default to 524288 (512K). Named
   * `memoryCharLimits` on the type because `memory` is already the backend
   * selector; the flat config keys keep the block shape:
   *   memory.charLimits.memory: 524288
   *   memory.charLimits.user: 262144
   */
  memoryCharLimits?: { memory?: number; user?: number };
  /**
   * Execution-backend resource caps, forwarded to `ExecutionBackendConfig`.
   * `cpu` is the docker `--cpus` quota (default 2); `diskMb` is a best-effort
   * `--storage-opt size=<N>m` quota honoured only where the daemon's storage
   * driver and backing filesystem can enforce it (the backend warns and skips
   * otherwise). Flat keys:
   *   execution.docker.cpu: 4
   *   execution.docker.diskMb: 20480
   */
  execution?: { docker?: { cpu?: number; diskMb?: number } };
  baseUrl?: string;
  /** Azure-only: REST API version (e.g. `2024-10-21`). Required when
   *  `provider === 'azure'`; ignored otherwise. */
  apiVersion?: string;
  /** Bedrock-only: AWS region for the Bedrock runtime endpoint (e.g.
   *  `us-west-2`). Defaults to `us-east-1`; ignored otherwise. */
  region?: string;
  /** Bedrock-only: named AWS profile from `~/.aws/config` (e.g. an SSO profile
   *  after `aws sso login`), used when no static keys are configured; ignored
   *  otherwise. Named `awsProfile`, not `profile`, because `profile` already
   *  means a per-model `ModelProfile` (`models.*`) in this config. */
  awsProfile?: string;
  /**
   * Lane 0 (eng review D4) — operator override for the model's served context
   * window, in tokens. A window FACT (how many tokens the server accepts) —
   * not a compaction POLICY (`compaction.maxContextTokens` is the ceiling
   * compaction aims for, different semantics) — hence the name matches the
   * catalog's `contextWindow` field rather than the provider-internal
   * `maxContextTokens` it maps to. Wins over the window probe and the catalog
   * (precedence: config > probe > catalog > default). Flat-key shape:
   *   contextWindow: 8192
   */
  contextWindow?: number;
  /**
   * Lane 2a (eng review D6) — tool-definition ordering at the provider
   * serialization boundary. `'stable'` (the default) applies the
   * deterministic ASCII sort so the tool payload — part of the cacheable
   * request prefix — is byte-identical across restarts; `'insertion'`
   * restores the legacy registration-order bytes. Temporary rollback lever;
   * removal tracked in plan/uncompleted-tasks.md (D13). Flat-key shape:
   *   toolOrder: insertion
   */
  toolOrder?: 'insertion' | 'stable';
  /**
   * Lane 4a(d) — per-request deadline for the OpenAI-compat client, in
   * milliseconds. Absent → the OpenAI SDK default (10 minutes) stays in
   * force. The default is deliberately LONG: a cold local model load
   * (Ollama paging weights into RAM/VRAM on the first turn) legitimately
   * takes minutes, and a short default would break every fresh server
   * start. Set this only when you know your serving latency. Flat-key shape:
   *   requestTimeoutMs: 120000
   */
  requestTimeoutMs?: number;
  /**
   * Operator-tunable approval SLA, in milliseconds — how long a dangerous
   * tool call may sit waiting for a human Allow/Deny before it is
   * auto-denied. Absent → each approval store's own 10-minute default
   * (gateway `ApprovalCoordinator`, web-api `ApprovalsService`). `0` means
   * no timeout at all — the call waits forever. Flat-key shape:
   *   approvalTimeoutMs: 1800000
   */
  approvalTimeoutMs?: number;
  /**
   * Lane 4a(d) — retry count for the OpenAI-compat client. Absent → the
   * OpenAI SDK default (2 retries). Flat-key shape:
   *   maxRetries: 0
   */
  maxRetries?: number;
  /**
   * Lane 3(a) — total serialized tool-payload guard threshold, in chars.
   * Absent → the wiring default (128 KiB). Exceeding it fails startup on a
   * local dialect and warns on hosted ones, naming the offending tools.
   * Flat-key shape:
   *   toolPayloadLimitChars: 131072
   */
  toolPayloadLimitChars?: number;
  // Per-personality model overrides: maps personality ID → model ID string
  modelRouting?: Record<string, string>;
  /**
   * Global FALLBACK layer for per-personality tool config. Keyed by
   * personality ID (or `_default`). The personality's own `tools.yaml` is the
   * source of truth; this map only fills the gap for personalities (especially
   * read-only built-ins) that don't declare a tool. Only secret NAMES live
   * here — never values (§V S9). `web_search` is the sole consumer in v1.
   */
  toolSettings?: ToolSettingsMap;
  /**
   * §7 — per-model config profile overrides, merged OVER the catalog profile
   * for the same `(providerId, modelId)`. Keyed by `<providerId>/<modelId>`
   * (the model id itself may contain `/`, e.g. `openrouter/anthropic/...`).
   * Flat-key config shape (the first path segment is the providerId, the rest
   * is the modelId):
   *   models.ollama/llama3.2.sampling.temperature: 0.2
   *   models.ollama/llama3.2.sampling.topP: 0.9
   *   models.ollama/llama3.2.sampling.topK: 40
   *   models.ollama/llama3.2.sampling.minP: 0.05
   *   models.ollama/llama3.2.toolCallFormat: openai
   *   models.ollama/llama3.2.maxOutputTokens: 2048
   */
  models?: Record<string, ModelProfile>;
  /**
   * §5 — global context-compaction gate thresholds, as fractions of the
   * model's window in (0,1]. `pressure` is the gate (compact above it);
   * `target` is what compaction shrinks toward. A per-model catalog `profile`'s
   * `compaction` overrides these; both absent → hardcoded 0.8/0.7 defaults.
   * Flat-key config shape:
   *   compaction.pressure: 0.85
   *   compaction.target: 0.7
   *   compaction.gateDelta: 2000
   *
   * Phase 1c — `gateDelta` is a token headroom (integer ≥ 0, NOT a fraction)
   * added to the previous turn's actual input tokens so the gate fires slightly
   * before the next turn reaches pressure.
   *
   * Phase 3 — `autoCompact` gates the turn-end auto-compaction trigger
   * (default on since the context-economy Phase 2 eval-gated flip; set false
   * to disable). `retryOnOverflow`
   * (default on) turns a provider context-overflow rejection into a
   * compact-and-retry instead of a surfaced error. Flat-key config shape:
   *   compaction.autoCompact: false
   *   compaction.retryOnOverflow: false
   *
   * Phase 4 — `smallWindow` overrides small-window-mode auto-detection. `auto`
   * (default) applies the window (≤32k) + static-ratio (>40%) triggers; `on`
   * forces small-window mode; `off` disables it. Flat-key config shape:
   *   compaction.smallWindow: on
   *
   * Item 7 — `maxContextTokens` is an ABSOLUTE ceiling in tokens (integer > 0):
   * compaction fires above it even when the fractional gate has not been
   * reached, so a million-token window need not grow to 800k first. It applies
   * to both the pre-LLM gate and the turn-end trigger.
   * `minTailUserMessages` (integer ≥ 0, default 3) is the number of USER
   * messages every compaction keeps verbatim in the tail — `tailKeep` counts
   * rows of any role, and a tool-heavy tail can hold none. Flat-key shape:
   *   compaction.maxContextTokens: 400000
   *   compaction.minTailUserMessages: 3
   * `abortOnSummaryFailure` (default false) surfaces a failed emergency
   * summary as its own `compaction_summary_failed` error instead of masking it
   * as the generic overflow rejection:
   *   compaction.abortOnSummaryFailure: true
   */
  // biome-ignore format: keep the option shape on one line for readability.
  compaction?: { pressure?: number; target?: number; gateDelta?: number; autoCompact?: boolean; retryOnOverflow?: boolean; abortOnSummaryFailure?: boolean; smallWindow?: 'auto' | 'on' | 'off'; maxContextTokens?: number; minTailUserMessages?: number };
  /**
   * Call-capture personality binding (plan/phases/call-capture-extension.md
   * decision 3). Exactly one personality, system-wide, may hold the
   * `call_capture` toolset capability (declared in its `toolset.yaml`, not a
   * `PersonalityConfig` field); this names which one is actually bound.
   * Validated at wiring time — see `validateCallCaptureBinding` in
   * `@ethosagent/wiring`, called from `packages/wiring/src/build-infrastructure.ts`.
   * Flat-key config shape:
   *   callCapture.personalityId: assistant
   */
  callCapture?: { personalityId?: string };
  /**
   * Fallback provider chain. When 2+ entries are present, `createLLM` wraps
   * them in a `ChainedProvider` with automatic cooldown-based failover.
   * The primary `provider`/`apiKey`/`model` fields are used when absent or
   * when only one entry is present. Config format:
   *   providers.0.provider: anthropic
   *   providers.0.apiKey: sk-ant-...
   *   providers.0.model: claude-opus-4-7
   *   providers.1.provider: openrouter
   *   providers.1.apiKey: sk-or-...
   */
  providers?: ProviderConfig[];
  /**
   * Active chat target. Managed by `ethos set` — do not hand-edit.
   * Takes precedence over `personality` for `ethos chat` and `ethos serve`.
   * @internal
   */
  activeContext?: ActiveContext;
  // Platform tokens — legacy scalar shape (single bot / single app). When
  // `telegram.bots` / `slack.apps` is present the list-shape wins and these
  // are ignored. Existing configs continue to boot unchanged via the
  // deprecation shim in `applyPlatformShim`.
  telegramToken?: string;
  discordToken?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  slackSigningSecret?: string;
  /**
   * Multi-bot routing: one bot entry per @handle. Serialized as dotted
   * indexed keys, matching `providers.<n>.<field>`. Identifiers (id,
   * bind.name) are restricted to `[A-Za-z0-9_-]+` so they round-trip
   * through the line-based config format unambiguously. Example:
   *   telegram.bots.0.token: 123:ABC
   *   telegram.bots.0.bind.type: personality
   *   telegram.bots.0.bind.name: researcher
   */
  telegram?: { bots: TelegramBotConfig[] };
  /**
   * Multi-app routing: one entry per Slack app. Same indexed-key shape
   * as `telegram.bots`. Identifier rules apply. Example:
   *   slack.apps.0.botToken: xoxb-…
   *   slack.apps.0.appToken: xapp-…
   *   slack.apps.0.signingSecret: …
   *   slack.apps.0.bind.type: personality
   *   slack.apps.0.bind.name: coder
   */
  slack?: { apps: SlackAppConfig[] };
  /**
   * Discord-adapter knobs that are not per-bot credentials. Today only the
   * missed-message backfill: the first time the bot sees a channel it reads a
   * slice of recent history so its first reply is not context-blind.
   *
   * Config format:
   *   discord.missedMessageBackfill.enabled: false
   *   discord.missedMessageBackfill.windowSeconds: 3600
   *   discord.missedMessageBackfill.limit: 50
   */
  discord?: {
    missedMessageBackfill?: {
      /** Read history at all. Default `true` — today's behaviour. */
      enabled?: boolean;
      /**
       * Drop fetched messages older than this many seconds. Absent = no age
       * bound, which is today's behaviour. 1–604800 (7 days).
       */
      windowSeconds?: number;
      /**
       * How many messages to ask Discord for. 1–100 (the platform's own
       * `messages.fetch` ceiling). Default 50.
       */
      limit?: number;
    };
  };
  /** Per-team runtime knobs. Keyed by team manifest name (same identifier rules). */
  teams?: Record<string, TeamRuntimeConfig>;
  whatsapp?: WhatsAppConfig[];
  /**
   * Real-time voice bot routing (plan/phases/gap-voice-realtime.md §3(b)).
   * Same indexed-key shape as `telegram.bots`, but keyed on a room/number
   * `match` pattern instead of a token. Example:
   *   voice.bots.0.match: +15551234567
   *   voice.bots.0.bind.type: personality
   *   voice.bots.0.bind.name: receptionist
   * LiveKit transport keys live alongside the bots under `voice.livekit.*`;
   * SIP trunk keys (telephony) live under `voice.trunk.*`.
   *
   * `trustedPlugins` is the local-only voice-egress allowlist:
   *   voice.trustedPlugins: openai-tts, elevenlabs
   * Declaring the key AT ALL arms the gate — providers advertising
   * `caps.local` always pass, and every other provider must be named here or
   * its selection is refused before a single audio byte leaves the machine.
   * Absent (the default) leaves the gate off, which is why an empty list is a
   * meaningful value, not the same as omitting the key.
   *
   * `defaultMode` is the voice-reply mode a NEW channel lane starts in:
   *   voice.defaultMode: mirror_inbound
   * `off` never speaks back, `mirror_inbound` speaks when it was spoken to,
   * `all` speaks every reply. `/voice <mode>` overrides it per lane at runtime;
   * this is only where a lane starts. Absent = `mirror_inbound`.
   *
   * `tts.providers` / `stt.providers` are the named rosters — several
   * configured providers a personality can pick between by name
   * (`voice.tts_provider:` / `voice.stt_provider:` in its `config.yaml`). Three
   * dotted levels, each entry the same shape as `auxiliary.tts` / `auxiliary.asr`:
   *   voice.tts.providers.mac-say.provider: command-tts
   *   voice.tts.providers.mac-say.command: say -o {output_path} -f {input_path}
   *   voice.tts.providers.mac-say.outputFormat: wav
   *   voice.tts.providers.studio.provider: openai-tts
   *   voice.tts.providers.studio.apiKey: ${secrets:voice/tts/providers/studio/apiKey}
   *   voice.stt.providers.whisper-es.provider: local-stt
   *   voice.stt.providers.whisper-es.baseUrl: http://localhost:8000/v1
   * `auxiliary.tts` / `auxiliary.asr` remain the DEFAULT entries: a personality
   * that names no provider — or names one this machine does not have — uses
   * them, so a deployment with no roster is unchanged. Names are restricted to
   * `[A-Za-z0-9_-]+` so they round-trip through the line-based format.
   *
   * `voice.providers.<name>.*` is ACCEPTED on read as the older spelling of
   * `voice.tts.providers.<name>.*` — it shipped before STT had a roster, when
   * "providers" could only mean one thing. It is never written back: a config
   * re-serialized from either spelling carries only the new one.
   *
   * `realtime.providers` is the THIRD roster, on the same three dotted levels
   * and through the same builder — hosted speech-to-speech engines that own the
   * audio in both directions instead of a transcribe → think → speak pipeline:
   *   voice.realtime.providers.live.provider: openai-realtime
   *   voice.realtime.providers.live.apiKey: ${secrets:voice/realtime/providers/live/apiKey}
   *   voice.realtime.providers.live.costPerMinuteUsd: 0.06
   * `realtime.default` names the entry a deployment uses when a personality
   * names none, and `realtime.sessionBudgetUsd` caps the accrued cost of ONE
   * session (rate × audio minutes) before it is cut short.
   *
   * `tier` is the deployment's default voice engine: `realtime` runs talk mode
   * as one hosted duplex session, `pipeline` is the explicit private/offline
   * mode (STT → LLM → TTS, which is what local providers can serve). Absent
   * leaves the choice to the surface. Anything other than those two values is
   * ignored, the same way an unknown `defaultMode` is.
   */
  voice?: {
    /**
     * Per-channel TTS-out default: which platforms speak their replies without
     * being asked. Keyed by platform id (`telegram`, `slack`, `discord`,
     * `whatsapp`, `email` — see `VOICE_CHANNEL_PLATFORMS`), value
     * `true`/`false`.
     *
     *   voice.channels.slack.ttsOut: false
     *
     * A platform absent here inherits `voice.defaultMode`. An explicit `false`
     * means "never speak on this channel", and outranks a lane's mode — an
     * operator turning a channel off is a deployment decision, not a
     * conversational one. `/voice all` in a Slack lane with
     * `voice.channels.slack.ttsOut: false` stays silent. An unknown platform id
     * or a non-boolean value is ignored, the same way an unknown `tier` is.
     */
    channels?: Record<string, { ttsOut?: boolean }>;
    /**
     * ffmpeg transcode stage. Present because voice notes only render as voice
     * bubbles in the container each platform wants, and the host binary is the
     * one new runtime dependency this feature has. Out-of-range numbers are
     * dropped, not clamped.
     */
    transcode?: {
      /** Path or name of the ffmpeg binary. Default: `ffmpeg` on PATH. */
      ffmpegPath?: string;
      /** Target bitrate for compressed containers, kbps. 8–320. Default 32 (voice). */
      bitrateKbps?: number;
      /** Budget for one ffmpeg invocation, seconds. 1–600. Default 30. */
      timeout?: number;
    };
    /**
     * Retention for synthesized voice artifacts. An artifact is deleted the
     * moment its delivery obligation is confirmed; these two keys bound what
     * happens to the ones that are never confirmed.
     */
    artifacts?: {
      /**
       * Give up on an undelivered obligation after this many days and delete
       * its artifact. 1–365. Default 7.
       */
      abandonAfterDays?: number;
      /**
       * Total on-disk cap for the artifact directory, MiB. Oldest-first
       * eviction once exceeded — the backstop for runaway accumulation when
       * neither delivery nor abandonment has fired. 1–102400. Default 512.
       */
      maxTotalMb?: number;
    };
    /**
     * Wake-word satellites: "hey engineer" from across the room wakes THAT
     * personality, with its toolset, memory scope and model routing intact.
     *
     * Routing is a DEPLOYMENT concern and deliberately not a PersonalityConfig
     * field: which phrase reaches which personality depends on the room and the
     * people in it, and two deployments of one personality can reasonably
     * disagree. Voice IDENTITY — the TTS voice, language map, tier, fast-lane
     * model — is on `PersonalityConfig.voice` and stays there.
     *
     * Out-of-range numbers and unknown engine ids are ignored rather than
     * clamped, and a route id outside `[A-Za-z0-9_-]+` is dropped: a typo here
     * must not make the whole config unloadable.
     */
    wake?: {
      /** Master switch. Absent → satellites decide from their own persisted state. */
      enabled?: boolean;
      /** Wake matcher: `fallback` (built-in, no native deps) | `sherpa` | `openwakeword`. */
      engine?: 'fallback' | 'sherpa' | 'openwakeword';
      /** Match threshold, 0..1. Higher = fewer false accepts, more misses. */
      sensitivity?: number;
      /** Consecutive matching frames before a wake fires — the false-accept damper. */
      confirmationFrames?: number;
      /** Transcribe on the satellite instead of shipping audio upstream. */
      edgeStt?: boolean;
      /**
       * Seconds of silence that end the LISTENING state. Ends listening ONLY —
       * never the session (eng-review D15). A post-timeout re-wake resumes the
       * same conversation.
       */
      idleTimeout?: number;
      /** Phrase → personality. Key is an operator-chosen route id. */
      routes?: Record<string, WakeRouteConfig>;
      /** Per-satellite overrides, keyed by the node's stable id. */
      nodes?: Record<string, { inputDevice?: string; enabled?: boolean }>;
    };
    bots: VoiceBotConfig[];
    livekit?: VoiceLiveKitConfig;
    trunk?: VoiceTrunkConfig;
    /** Who may reach the number, what answering costs, and where the summary
     *  goes. See `VoiceInboundConfig`. */
    inbound?: VoiceInboundConfig;
    /** Per-surface barge-in sensitivity. See `VoiceBargeInConfig`. */
    bargeIn?: VoiceBargeInConfig;
    /** Tool-call filler/tick keep-alive. See `VoiceFillerConfig`. */
    filler?: VoiceFillerConfig;
    trustedPlugins?: string[];
    defaultMode?: 'off' | 'mirror_inbound' | 'all';
    tier?: 'pipeline' | 'realtime';
    tts?: { providers: Record<string, TtsProviderEntry> };
    stt?: { providers: Record<string, SttProviderEntry> };
    realtime?: {
      providers?: Record<string, RealtimeProviderEntry>;
      /** Roster entry name a deployment falls back to. Not a provider id. */
      default?: string;
      /** USD cap on ONE realtime session's accrued cost. */
      sessionBudgetUsd?: number;
    };
  };
  // Email platform
  emailImapHost?: string;
  emailImapPort?: number;
  emailUser?: string;
  emailPassword?: string;
  emailSmtpHost?: string;
  emailSmtpPort?: number;
  /** Show per-turn timing summary after every response. */
  verbose?: boolean;
  /**
   * FW-10 — chat-surface verbosity. Cycles via `/verbose`.
   *   `quiet`    final assistant text only — pipe-clean output
   *   `default`  text + tool chips + spinner + usage line
   *   `verbose`  also surfaces internal tool_progress events
   *   `debug`    also dumps raw event JSON
   */
  displayVerbosity?: 'quiet' | 'default' | 'verbose' | 'debug';
  /**
   * FW-9 — what Enter does mid-turn.
   *   `interrupt` (default) — abort in-flight run, start a new turn
   *   `queue`     FIFO-queue the input, run it after the current turn ends
   *   `steer`     inject as `[USER STEER]` on the next iteration's user message
   */
  displayBusyInputMode?: 'interrupt' | 'queue' | 'steer';
  /**
   * FW-11 — tool feed arg truncation. 0 = no truncation (default).
   */
  displayToolPreviewLength?: number;
  /**
   * FW-5 — show resume hint on chat exit. Defaults to true.
   * Set to false via `display.resume_hint: false` in config.yaml.
   */
  displayResumeHint?: boolean;
  /**
   * FW-6 — how many turn pairs to show in the recap panel on resume.
   * 0 disables the panel. Default 3. Range 0–10.
   */
  displayResumeRecapTurns?: number;
  /**
   * Named skin override (see `@ethosagent/design-tokens` built-in skins:
   * `default`, `mono`, `paper`). When set, the resolved tokens are wired
   * into both the TUI SkinContext and the Web ConfigProvider so the
   * visible palette matches the user's choice on every surface.
   */
  skin?: string;
  /**
   * FW-8 — CLI toolset override. Set by `--toolsets <list>` for this
   * invocation only. Never written to config.yaml.
   * @internal
   */
  cliToolsets?: string[];
  /**
   * FW-8 — CLI skill preload. Set by `-s <list>` for this invocation only.
   * Never written to config.yaml.
   * @internal
   */
  cliSkills?: string[];
  /**
   * FW-8 — Pre-loaded content for cliSkills. Populated by applyCliOverrides
   * so the hook in wiring.ts avoids a second readFileSync path.
   * @internal
   */
  cliSkillContents?: string[];
  /**
   * FW-16 — user-defined shell shortcuts, registered as `[quick]` slash commands.
   * Config format:
   *   quick_commands.status.type: exec
   *   quick_commands.status.command: git status
   *   quick_commands.status.gateway: true
   *   quick_commands.status.channels: telegram,slack
   */
  quick_commands?: Record<string, QuickCommandConfig>;
  /**
   * Context-economy Phase 1 — static per-channel toolset narrowing for the
   * gateway (platform → allowed tool names, intersect-only with the
   * personality toolset). Config format:
   *   channel_toolsets.whatsapp: read_file,memory_read
   */
  channelToolsets?: Record<string, string[]>;
  /** Global retention settings. Per-category TTLs. */
  retention?: RetentionConfig;
  /**
   * Per-personality overrides. Keyed by personality ID.
   * Only `retention` sub-block is supported here.
   */
  personalitiesConfig?: Record<string, { retention?: RetentionConfig }>;
  /**
   * Chapter 1 safety: per-platform sender allowlist + pairing config.
   * Parsed from `channel_filter.<platform>.<field>: <value>` keys in config.yaml.
   * When absent, the gateway allows all inbound messages (backward compat).
   * When present, the gateway enforces sender allowlists, DM pairing codes,
   * mention gating, and context-visibility stripping per platform.
   */
  channelFilter?: ChannelFilterConfig;
  /**
   * FW-29 — skill evolver cron registration.
   *   `evolverCronEnabled` — when true, registers an in-process cron job that
   *     runs `ethos evolve run --quiet` on the configured schedule.
   *   `evolverSchedule`   — 5-field cron expression (default: "0 3 * * *").
   */
  evolverCronEnabled?: boolean;
  evolverSchedule?: string;
  /**
   * FW-13 — background sessions.
   *   `backgroundMaxConcurrent` — max simultaneous background agent tasks (default 4).
   *     Config key: background.max_concurrent
   *   `displayBellOnComplete` — ring the terminal bell when a background task finishes.
   *     Config key: display.bell_on_complete
   *
   * NOTE: `backgroundMaxConcurrent` is superseded by the durable engine's
   * `background.maxConcurrentJobs` (`BackgroundJobConfig`). It is retained only
   * for config round-trip stability and is no longer read by any surface.
   */
  backgroundMaxConcurrent?: number;
  /**
   * Background Sub-Agents job pool config (`background:` section). Parsed from
   * flat `background.<snake_case>` keys; see `BackgroundConfig` for the fields
   * and `backgroundDefaults()` for the fallbacks.
   */
  background?: BackgroundConfig;
  /**
   * Cron trigger surface (plan/phases/cron-fire-url-collapse.md), parsed from
   * the `cron.fireUrl` / `cron.maxParallelJobs` keys. A fresh config.yaml with
   * no `cron:` section at all runs only the local interval trigger, unchanged.
   */
  cron?: CronTopLevelConfig;
  displayBellOnComplete?: boolean;
  displayDebugPanel?: boolean;
  displayDebugPanelModel?: string;
  /**
   * Per-surface opt-in for the "· remembered: …" capture notice (pillar B,
   * §3.3). CLI subtle-on when `true`; channels never surface it. Default
   * undefined (CLI decides its own default). Config key: display.memory_notices
   */
  displayMemoryNotices?: boolean;
  /**
   * Channel streaming draft edits (W3.1). Controls whether the gateway
   * delivers a turn's reply as live `editMessage` updates that grow in place
   * on edit-capable channels (Telegram, Slack):
   *   `'off'`  — never stream; one final message per turn.
   *   `'dms'`  — stream in direct messages only (default).
   *   `'all'`  — stream in DMs and group chats.
   * Config key: `display.streaming_edits`.
   */
  displayStreamingEdits?: 'off' | 'dms' | 'all';
  /**
   * Which treatment the Call Stage draws (DESIGN.md § "Call Stage").
   * Config key: `display.call_style`.
   *   `'personality'` (default) — each personality draws its own treatment:
   *     its `voice.call_style` if it declares one, otherwise a shape derived
   *     from its id.
   *   `'liquid' | 'orb' | 'rings'` — pin one treatment for every personality
   *     that has not declared its own.
   * Unset = `personality`.
   */
  displayCallStyle?: 'liquid' | 'orb' | 'rings' | 'personality';
  /**
   * What color the Call Stage draws in. Config key: `display.call_accent`.
   *   `'personality'` (default) — follow the active personality's `--accent`
   *   `'#RRGGBB'`               — an explicit hex
   * Anything else is ignored, so a typo falls back to the personality accent
   * rather than painting the call an unreadable color.
   */
  displayCallAccent?: string;
  /**
   * context_compression F1 — auxiliary model wiring. `auxiliary.compression`
   * configures the cheap summarizer that `semantic_summary` uses to condense
   * long histories. Config keys:
   *   auxiliary.compression.model: claude-haiku-4-5-20251001
   *   auxiliary.compression.provider: anthropic   (optional — defaults to `provider`)
   *   auxiliary.compression.apiKey: sk-ant-...     (optional — defaults to `apiKey`)
   *   auxiliary.compression.baseUrl: https://...   (optional — defaults to `baseUrl`)
   *
   * tools-vision P2 — `auxiliary.vision` configures the vision-capable model
   * `vision_analyze` routes to when the personality's primary model can't
   * process images / PDFs. Same shape as `compression`.
   *
   * tools-web — `auxiliary.web` configures the model `web_extract` uses to
   * summarize large pages. Same shape as `vision`.
   */
  auxiliary?: {
    compression?: AuxiliaryCompressionConfig;
    vision?: AuxiliaryVisionConfig;
    web?: AuxiliaryWebConfig;
    /** The DEFAULT STT entry. `command` is the shell template the `command-stt`
     *  provider runs (placeholders: {input_path}, {output_path}, {language});
     *  `timeout` is that command's budget, in seconds. Same shape as every
     *  `voice.stt.providers.<name>` roster entry, because it IS one — the one a
     *  personality gets when it names no other. */
    asr?: SttProviderEntry;
    /** The DEFAULT TTS entry. `command` is the shell template the `command-tts`
     *  provider runs (placeholders: {input_path}, {output_path}, {format},
     *  {voice}, {speed}); `outputFormat` is the container that command writes —
     *  and the extension `{output_path}` carries; `timeout` is its budget in
     *  seconds; `maxTextLength` caps the text handed to one synthesis call.
     *  Same shape as every `voice.tts.providers.<name>` roster entry, because it
     *  IS one — the one a personality gets when it names no other. */
    tts?: TtsProviderEntry;
  };
  /** tools-web — web_search/web_extract backend selection. */
  web?: WebConfig;
  /**
   * Inbound webhooks. Each hookId maps to a personality + a bearer secret.
   * Exposes POST /webhook/<hookId> on the gateway when non-empty.
   *   webhooks.<hookId>.personalityId: researcher
   *   webhooks.<hookId>.secret: <bearer-secret>
   *   webhooks.<hookId>.sessionKey: <optional-stable-session-key>
   *   webhooks.<hookId>.prefilter: <script under ~/.ethos/scripts/, .sh or .py>
   *   webhooks.<hookId>.prefilterTimeoutSeconds: 30   (max 600)
   *   webhooks.<hookId>.mode: sync | ack              (default sync)
   *   webhooks.<hookId>.events: push, issue.opened    (default: accept all)
   *   webhooks.<hookId>.eventHeader: x-github-event   (default x-event-type)
   *   webhooks.<hookId>.eventField: meta.event        (default event)
   *   webhooks.<hookId>.deliverOnly: true             (relay only, no turn)
   *   webhooks.<hookId>.deliver.0.type: platform | log
   *   webhooks.<hookId>.deliver.0.adapterId: telegram:tg-a
   *   webhooks.<hookId>.deliver.0.chatId: 12345
   *   webhooks.<hookId>.deliver.0.threadId: <optional-thread>
   *   webhooks.<hookId>.hmac.secret: <signing-secret>   (additive to secret)
   *   webhooks.<hookId>.hmac.header: x-hub-signature-256 (default x-signature)
   *   webhooks.<hookId>.hmac.algorithm: sha256 | sha1 | sha512  (default sha256)
   *   webhooks.<hookId>.hmac.previousSecret: <rotation-window-secret>
   *   webhooks.<hookId>.rateLimit.maxPerMinute: 60    (default: unlimited)
   *   webhooks.<hookId>.rateLimit.lockoutSeconds: 600 (default 600)
   */
  webhooks?: Record<string, WebhookHookConfig>;
  /**
   * Remote model catalog configuration. Controls how Ethos fetches and caches
   * the centralized model metadata catalog (capabilities, context windows, pricing).
   * Config keys:
   *   modelCatalog.enabled: false
   *   modelCatalog.url: https://custom.example.com/catalog.json
   *   modelCatalog.ttlHours: 12
   *   modelCatalog.providers.<id>.url: https://internal.example.com/anthropic.json
   */
  modelCatalog?: ModelCatalogConfig;
  /**
   * Logging settings. `rotation` controls when `~/.ethos/logs/errors.jsonl` is
   * rotated; `level` is the lowest severity `ConsoleLogger` prints (records
   * below it are dropped). Absent `level` means `'debug'` — everything prints,
   * which is what the framework did before the gate existed. Config keys:
   *   logs.rotation.maxBytes: 10485760
   *   logs.rotation.maxFiles: 5
   *   logs.rotation.enabled: false
   *   logs.level: info
   */
  logs?: {
    rotation?: {
      maxBytes?: number;
      maxFiles?: number;
      enabled?: boolean;
    };
    level?: LogLevel;
  };
  /**
   * AWS integration configuration. Currently supports Secrets Manager
   * as a secrets backend. Config keys:
   *   aws.secrets.enabled: true
   *   aws.secrets.region: us-east-1
   *   aws.secrets.prefix: ethos/engineer
   *   aws.secrets.endpoint: http://localhost:4566
   */
  aws?: AwsConfig;
  /** Public-facing URL of the web UI. Used as the OAuth redirect base.
   *  Resolution: ETHOS_PUBLIC_URL env > config.yaml webBaseUrl > localhost default. */
  webBaseUrl?: string;
  /** Storage-layer settings. Supports at-rest encryption via
   *  `storage.encryption: true` in config.yaml (requires ETHOS_STORAGE_KEY), and
   *  a pluggable backend via `storage.backend` (default `fs`). Set `s3` to
   *  target AWS S3 (or an S3-compatible endpoint) when `backend: s3`. */
  storage?: {
    encryption?: boolean;
    backend?: 'fs' | 's3';
    s3?: {
      bucket?: string;
      region?: string;
      prefix?: string;
      endpoint?: string;
      forcePathStyle?: boolean;
    };
  };
  /** Whether to auto-install plugins from plugins.lock on personality load.
   *  Config key: plugins.auto_install */
  pluginsAutoInstall?: boolean;
  /**
   * Web admin panel gate. The `/admin` page and the `admin.*` RPC namespace
   * are available only when `admin.enabled: true` is set explicitly —
   * default false. Config key: admin.enabled
   */
  admin?: { enabled?: boolean };
  /**
   * Agent-to-Agent (A2A) surface gate. The `/a2a`, `/a2a-auth`, and well-known
   * card routes plus the `a2a_send` tool are live only when `a2a.enabled: true`
   * is set explicitly — default false (A2A stays opt-in). Config key:
   * a2a.enabled. Supersedes the deprecated `ETHOS_A2A_ENABLED` env override.
   */
  a2a?: { enabled?: boolean };
  /**
   * Operator-controlled security settings.
   *
   * `trustedGitHubOrgs` — the GitHub organizations whose skills and plugins
   * resolve to the `trusted-repo` install tier. The configured list REPLACES
   * the shipped default (`ethosagent`, `anthropic`) rather than extending it,
   * so an operator can remove an org they do not trust. An explicitly empty
   * value is meaningful — it trusts no organization — and is distinct from the
   * key being absent, which leaves the default in force. Config keys:
   *   security.trusted_github_orgs: acme-corp, ethosagent
   *   security.trusted_github_orgs: ""     # trust no org
   */
  security?: { trustedGitHubOrgs?: string[] };
  /**
   * Governed-learning nightly pass scheduler (Phase 3c E). Default-off: when
   * absent or `enabled !== true`, no timer is created and behavior is
   * unchanged. When enabled, `ethos serve` / `ethos gateway start` fire the
   * nightly pass on `cron` (default `0 3 * * *`). Config keys:
   *   nightlyPass.enabled: true
   *   nightlyPass.cron: 0 3 * * *
   */
  nightlyPass?: { enabled?: boolean; cron?: string };
  /**
   * Scheduled local snapshots of `~/.ethos` (plan agent-state-backup §3).
   * ON unless explicitly disabled: an agent's state is its memory, its
   * sessions and its personalities, and the deployment that most needs a
   * backup is the one whose operator never went looking for the setting.
   * Rotation (`keep`) bounds what that costs on disk.
   *
   * `dir` defaults to `<ethosDir>/backups`, computed in code — `${ETHOS_HOME}`
   * is NOT a token config.yaml expands (D5). A relative value resolves under
   * the data dir. `scope` names are validated where the backup runs, not here;
   * the scope roster belongs to `@ethosagent/wiring`, which this package must
   * not depend on. Config keys:
   *   backup.enabled: true
   *   backup.cron: 0 4 * * *
   *   backup.scope: identity,state
   *   backup.keep: 7
   *   backup.dir: /mnt/snapshots
   */
  backup?: {
    enabled?: boolean;
    cron?: string;
    scope?: string[];
    keep?: number;
    dir?: string;
  };
  /**
   * Proactive memory capture (memory-experience pillar B). Default-off. See
   * `MemoryCaptureConfig`. Parsed from flat `memoryCapture.<field>` keys.
   */
  memoryCapture?: MemoryCaptureConfig;
  /**
   * Bring-your-own-vault backend settings (memory-lifecycle L1). Read only
   * when `memory: vault`. See `MemoryVaultConfig`. Parsed from flat
   * `memoryVault.<field>` keys.
   */
  memoryVault?: MemoryVaultConfig;
  /**
   * Approve-before-store gate (memory-lifecycle L2). Default-off. See
   * `MemoryApprovalConfig`. Parsed from flat `memoryApproval.<field>` keys.
   */
  memoryApproval?: MemoryApprovalConfig;
  /**
   * Importance scoring + decay tuning (memory-experience pillar C). Defaults
   * applied by the nightly pass when absent. See `MemoryConsolidationConfig`.
   * Parsed from flat `memoryConsolidation.<field>` keys.
   */
  memoryConsolidation?: MemoryConsolidationConfig;
  /**
   * Weekly governed-learning digest scheduler (Phase 3e). Default-off: when
   * absent or `enabled !== true`, no timer is created and behavior is
   * unchanged. When enabled, `ethos serve` / `ethos gateway start` build the
   * digest on `cron` (default `0 9 * * 1` — Monday 9am). `recipients` is the
   * email allowlist for the optional `--email` delivery path. Config keys:
   *   weeklyDigest.enabled: true
   *   weeklyDigest.cron: 0 9 * * 1
   *   weeklyDigest.recipients: alice@example.com, bob@example.com
   */
  weeklyDigest?: { enabled?: boolean; cron?: string; recipients?: string[] };
  /**
   * Kanban poll loop: periodically checks the board for tasks assigned to
   * this agent's personalityId with status=ready, and enqueues a stimulus.
   * Also runs board housekeeping (promote, rollup, reclaim).
   *
   * Config format:
   *   kanbanPoll.enabled: true
   *   kanbanPoll.intervalMs: 5000
   *   kanbanPoll.boardPath: ~/.ethos/teams/myteam/board.db
   */
  /**
   * Soft-warn tiers for the agent loop's tool-call budgets. Crossing one emits
   * a one-per-turn internal-audience `tool_progress` nudge; it never stops the
   * turn — that stays the job of the hard caps in `AgentLoopConfig.options`.
   * Absent = no warn, unchanged behaviour.
   *
   * Config format:
   *   toolLoop.maxToolCallsWarnAt: 40
   *   toolLoop.maxIdenticalToolCallsWarnAt: 10
   */
  toolLoop?: {
    /** Total tool calls in one turn at which to nudge. Positive integer. */
    maxToolCallsWarnAt?: number;
    /** Per-tool-name repeat count at which to nudge. Positive integer. */
    maxIdenticalToolCallsWarnAt?: number;
  };
  /**
   * Board-wide work-in-progress caps. Distinct from `kanbanPoll` (poll cadence)
   * — these bound how many tasks may be `running` at once, enforced by
   * `KanbanStore.updateStatus` on the transition into `running`. Absent = no
   * cap, unchanged behaviour.
   *
   * Config format:
   *   kanban.maxInProgress: 5
   *   kanban.maxInProgressPerProfile: 2
   */
  kanban?: {
    /** Max tasks in `running` across the whole board. Positive integer. */
    maxInProgress?: number;
    /** Max tasks in `running` per assignee. Positive integer. */
    maxInProgressPerProfile?: number;
  };
  /**
   * Playwright timeouts for the `browser` toolset. Both were hardcoded at the
   * call sites before they became configurable, so the defaults below are
   * exactly what those literals were.
   *
   * Config format:
   *   browser.navigationTimeoutMs: 30000
   *   browser.commandTimeoutMs: 10000
   */
  browser?: {
    /** Budget for one page load (`goto`/`goBack`), ms. 1000–600000. Default 30000. */
    navigationTimeoutMs?: number;
    /** Budget for one element interaction (`click`), ms. 1000–600000. Default 10000. */
    commandTimeoutMs?: number;
  };
  /**
   * Gateway-wide knobs that are not per-adapter credentials.
   *
   * `maxInboundMediaBytes` is an OVERRIDE, not a universal cap: each platform
   * adapter keeps its own default (the ceiling the platform itself imposes)
   * and only reads this when it is set. There is no central inbound-media
   * path to enforce it at — the value is threaded into each adapter at
   * construction.
   *
   * Config format:
   *   gateway.maxInboundMediaBytes: 52428800
   */
  gateway?: {
    /** Largest inbound attachment any adapter will download, bytes. 1024–134217728. */
    maxInboundMediaBytes?: number;
  };
  /**
   * Team-supervisor knobs. Named `teamSupervisor` rather than `gateway`
   * because the gateway process does not restart itself — member auto-restart
   * is owned by the supervisor that spawned them.
   *
   * Config format:
   *   teamSupervisor.restartLoopGuard.maxRestarts: 5
   *   teamSupervisor.restartLoopGuard.windowSeconds: 60
   */
  teamSupervisor?: {
    /**
     * Rolling-window brake on `auto_restart`. A member is respawned up to
     * `maxRestarts` times inside `windowSeconds`; the crash after that leaves
     * it marked failed. Unset means 5 respawns in 60 seconds — one MORE
     * respawn than the previous hardcoded guard, which gave up on the fifth
     * crash and so performed four restarts.
     */
    restartLoopGuard?: {
      /** Respawns allowed inside the window. 1–1000. Unset = 5. */
      maxRestarts?: number;
      /** Width of the rolling window, seconds. 1–86400. Default 60. */
      windowSeconds?: number;
    };
  };
  kanbanPoll?: {
    enabled?: boolean;
    /** Poll interval in milliseconds. Default 5000. */
    intervalMs?: number;
    /** Path to the board.db file. When serve is started with --team, this
     *  defaults to the team's board path. */
    boardPath?: string;
  };
  /**
   * Idle watcher: aggregates every subsystem's busy state into one answer so a
   * scale-to-zero host (Firecracker-style microVMs that pause between
   * messages) can be told "nothing is in flight, it is safe to stop this VM".
   *
   * An operator/deployment concern, NOT personality identity — two deployments
   * of the same personality trivially disagree about it (a laptop `pnpm dev`
   * wants it off, a hosted microVM wants it on), so it lives here rather than
   * on `PersonalityConfig`.
   *
   * `enabled` defaults to `false`: this must never activate by omission, since
   * an unarmed-but-wrong watcher exits a process mid-work. There is
   * deliberately NO key for the manager's instrumentation-gap check — that gate
   * is hard-coded, because letting an operator override it reintroduces the
   * silent-data-loss risk it exists to prevent.
   *
   * Config format:
   *   idleWatcher.enabled: false
   *   idleWatcher.idleThresholdMs: 120000
   *   idleWatcher.startupCooldownMs: 30000
   *   idleWatcher.checkIntervalMs: 15000
   *   idleWatcher.wakePathConfirmed: false
   */
  idleWatcher?: {
    /** Arming gate 1. Default false — the watcher is not even constructed. */
    enabled?: boolean;
    /** Arming gate 5 — consecutive idle duration required before exit fires. */
    idleThresholdMs?: number;
    /** Arming gate 4 — no evaluation for this long after boot. */
    startupCooldownMs?: number;
    /** How often the idle predicate is sampled. */
    checkIntervalMs?: number;
    /** Arming gate 3 — operator attestation that a wake path exists. */
    wakePathConfirmed?: boolean;
  };
  /**
   * Pause-clock correction (plan/phases/clock-tolerance-pass.md §7) — the
   * resume-side twin of `idleWatcher`. On a snapshotting host the guest's wall
   * clock does not advance while the VM is paused, so on resume every staleness
   * gate (job-store `reclaimStale`, kanban heartbeats, the delivery ledger's
   * abandon window) reads the pause as downtime. When enabled, the process runs
   * a clock-drift detector and boot reconciliation discounts the detected pause
   * from those gates.
   *
   * An operator/deployment concern, NOT personality identity — two deployments
   * of the same personality trivially disagree about it — so it lives here and
   * has no personality-facing key.
   *
   * Config format:
   *   pauseClockCorrection.enabled: false
   *   pauseClockCorrection.thresholdMs: 60000
   */
  pauseClockCorrection?: {
    /** Default false — every non-snapshotting deployment (bare metal, docker,
     *  `pnpm dev`) has no pause to discount. */
    enabled?: boolean;
    /** Wall-clock jump, in ms, above which a tick is treated as a resume rather
     *  than scheduler slack. Default 60_000. */
    thresholdMs?: number;
  };
  /**
   * Pause/resume lifecycle notifications to an external orchestrator — an
   * operator/deployment concern, NOT personality identity, same rationale as
   * `pauseClockCorrection` above.
   *
   * Config format:
   *   pauseLifecycle.http.url: https://orchestrator.example.com/tenants/<id>/idle
   *   pauseLifecycle.http.token: ${secrets:pauseLifecycle/http/token}
   *   pauseLifecycle.http.timeoutMs: 5000
   */
  pauseLifecycle?: {
    http?: {
      /** Orchestrator endpoint to notify. */
      url?: string;
      /** Bearer credential sent with the notification. Externalize via
       *  `${secrets:<ref>}` — see `SECRET_FIELD_NAMES`. */
      token?: string;
      /** Request timeout, in ms. */
      timeoutMs?: number;
    };
  };
  /**
   * Export/observability targets (analytics-observability plan, Part E).
   * Currently one leaf: Langfuse. Off by default.
   *
   * Config format:
   *   telemetry.export.langfuse.enabled: true
   *   telemetry.export.langfuse.baseUrl: https://cloud.langfuse.com
   *   telemetry.export.langfuse.publicKey: pk-lf-...
   *   telemetry.export.langfuse.secretKey: sk-lf-...
   */
  telemetry?: TelemetryConfig;
}

export function ethosDir(): string {
  const override = process.env.ETHOS_STATE_DIR;
  if (override) return override;
  return join(homedir(), '.ethos');
}

/**
 * Set to true once per process after emitting the pre-versioned-config
 * deprecation warning so we don't spam stderr across repeated reads.
 */
let preVersionedConfigWarned = false;

export async function readRawConfig(storage: Storage): Promise<EthosConfig | null> {
  const src = await storage.read(join(ethosDir(), 'config.yaml'));
  if (!src) return null;
  const parsed = parseConfigYaml(src);
  if (parsed.schemaVersion === undefined && !preVersionedConfigWarned) {
    preVersionedConfigWarned = true;
    console.warn(
      `\n[ethos] ~/.ethos/config.yaml is missing 'schemaVersion'. ` +
        `Treating as schemaVersion: ${CURRENT_ETHOS_CONFIG_SCHEMA_VERSION}. ` +
        `Re-running 'ethos setup' (or adding 'schemaVersion: ${CURRENT_ETHOS_CONFIG_SCHEMA_VERSION}' to the top of the file) ` +
        `will silence this warning and let future migrations key off the version.\n`,
    );
  }
  return parsed;
}

export async function readConfig(
  storage: Storage,
  secrets: SecretsResolver,
): Promise<EthosConfig | null> {
  const raw = await readRawConfig(storage);
  if (!raw) return null;
  return resolveConfigSecrets(raw, secrets);
}

/**
 * Write-path mirror of `resolveConfigSecrets`: every credential-bearing field
 * is moved into the vault and replaced by its `${secrets:<ref>}` reference.
 * Values that are already references pass through untouched, so rewriting an
 * externalized config is a no-op on the vault.
 *
 * Existing installs migrate implicitly — the first `writeConfig` after upgrade
 * lifts whatever plaintext the file still carries into `~/.ethos/secrets/`.
 */
async function externalizeConfigSecrets(
  config: EthosConfig,
  secrets: SecretsResolver,
): Promise<EthosConfig> {
  const ctx: SecretRefContext = {
    provider: config.provider,
    providerChain: config.providers?.map((p) => p.provider),
    telegramBotKeys: config.telegram?.bots.map((b) => deriveBotKey(b)),
    slackAppKeys: config.slack?.apps.map((a) => deriveBotKey(a)),
  };
  const ref = (key: string): string => {
    const r = secretRefForConfigKey(key, ctx);
    if (r === null) throw new Error(`No secret ref is defined for config key '${key}'`);
    return r;
  };

  const r = { ...config };
  r.apiKey = await externalizeSecret(r.apiKey, ref('apiKey'), secrets);
  r.telegramToken = await externalizeSecret(r.telegramToken, ref('telegramToken'), secrets);
  r.discordToken = await externalizeSecret(r.discordToken, ref('discordToken'), secrets);
  r.slackBotToken = await externalizeSecret(r.slackBotToken, ref('slackBotToken'), secrets);
  r.slackAppToken = await externalizeSecret(r.slackAppToken, ref('slackAppToken'), secrets);
  r.slackSigningSecret = await externalizeSecret(
    r.slackSigningSecret,
    ref('slackSigningSecret'),
    secrets,
  );
  r.emailPassword = await externalizeSecret(r.emailPassword, ref('emailPassword'), secrets);

  if (r.providers) {
    const out: ProviderConfig[] = [];
    for (const [i, p] of r.providers.entries()) {
      out.push({
        ...p,
        apiKey: await externalizeSecret(p.apiKey, ref(`providers.${i}.apiKey`), secrets),
      });
    }
    r.providers = out;
  }
  if (r.telegram?.bots) {
    const bots: TelegramBotConfig[] = [];
    for (const [i, bot] of r.telegram.bots.entries()) {
      bots.push({
        ...bot,
        token: await externalizeSecret(bot.token, ref(`telegram.bots.${i}.token`), secrets),
        webhookSecretToken: await externalizeSecret(
          bot.webhookSecretToken,
          ref(`telegram.bots.${i}.webhookSecretToken`),
          secrets,
        ),
      });
    }
    r.telegram = { ...r.telegram, bots };
  }
  if (r.slack?.apps) {
    const apps: SlackAppConfig[] = [];
    for (const [i, app] of r.slack.apps.entries()) {
      apps.push({
        ...app,
        botToken: await externalizeSecret(app.botToken, ref(`slack.apps.${i}.botToken`), secrets),
        appToken: await externalizeSecret(app.appToken, ref(`slack.apps.${i}.appToken`), secrets),
        signingSecret: await externalizeSecret(
          app.signingSecret,
          ref(`slack.apps.${i}.signingSecret`),
          secrets,
        ),
      });
    }
    r.slack = { ...r.slack, apps };
  }
  if (r.voice?.livekit) {
    const lk = r.voice.livekit;
    r.voice = {
      ...r.voice,
      livekit: {
        ...lk,
        apiKey: await externalizeSecret(lk.apiKey, ref('voice.livekit.apiKey'), secrets),
        apiSecret: await externalizeSecret(lk.apiSecret, ref('voice.livekit.apiSecret'), secrets),
      },
    };
  }
  if (r.voice?.trunk) {
    // Both trunk credentials take the same path: `password` authenticates us to
    // the trunk outbound, `webhookSecret` authenticates the trunk to us inbound.
    // Spread conditionally so a block carrying only one does not gain an
    // `undefined` key the serializer would then have to think about.
    const trunk = r.voice.trunk;
    r.voice = {
      ...r.voice,
      trunk: {
        ...trunk,
        ...(trunk.password
          ? {
              password: await externalizeSecret(
                trunk.password,
                ref('voice.trunk.password'),
                secrets,
              ),
            }
          : {}),
        ...(trunk.webhookSecret
          ? {
              webhookSecret: await externalizeSecret(
                trunk.webhookSecret,
                ref('voice.trunk.webhookSecret'),
                secrets,
              ),
            }
          : {}),
      },
    };
  }
  // Per-ENTRY refs. A roster key must not be able to route its credential
  // around the vault, so each entry externalizes exactly like
  // `auxiliary.tts.apiKey` does — `voice.tts.providers.<name>.apiKey` →
  // `voice/tts/providers/<name>/apiKey`, and the STT and realtime rosters the
  // same way. Same-named entries in different rosters therefore land on
  // different refs and cannot overwrite each other.
  const externalizeRoster = async <E extends { apiKey?: string }>(
    kind: 'tts' | 'stt' | 'realtime',
    roster: Record<string, E>,
  ): Promise<Record<string, E>> => {
    const out: Record<string, E> = {};
    for (const [name, entry] of Object.entries(roster)) {
      out[name] = entry.apiKey
        ? {
            ...entry,
            apiKey: await externalizeSecret(
              entry.apiKey,
              ref(`voice.${kind}.providers.${name}.apiKey`),
              secrets,
            ),
          }
        : entry;
    }
    return out;
  };
  if (r.voice?.tts?.providers) {
    r.voice = {
      ...r.voice,
      tts: { providers: await externalizeRoster('tts', r.voice.tts.providers) },
    };
  }
  if (r.voice?.stt?.providers) {
    r.voice = {
      ...r.voice,
      stt: { providers: await externalizeRoster('stt', r.voice.stt.providers) },
    };
  }
  if (r.voice?.realtime?.providers) {
    r.voice = {
      ...r.voice,
      realtime: {
        ...r.voice.realtime,
        providers: await externalizeRoster('realtime', r.voice.realtime.providers),
      },
    };
  }
  if (r.auxiliary) {
    const aux = { ...r.auxiliary };
    if (aux.compression?.apiKey) {
      aux.compression = {
        ...aux.compression,
        apiKey: await externalizeSecret(
          aux.compression.apiKey,
          ref('auxiliary.compression.apiKey'),
          secrets,
        ),
      };
    }
    if (aux.vision?.apiKey) {
      aux.vision = {
        ...aux.vision,
        apiKey: await externalizeSecret(aux.vision.apiKey, ref('auxiliary.vision.apiKey'), secrets),
      };
    }
    if (aux.web?.apiKey) {
      aux.web = {
        ...aux.web,
        apiKey: await externalizeSecret(aux.web.apiKey, ref('auxiliary.web.apiKey'), secrets),
      };
    }
    if (aux.asr?.apiKey) {
      aux.asr = {
        ...aux.asr,
        apiKey: await externalizeSecret(aux.asr.apiKey, ref('auxiliary.asr.apiKey'), secrets),
      };
    }
    if (aux.tts?.apiKey) {
      aux.tts = {
        ...aux.tts,
        apiKey: await externalizeSecret(aux.tts.apiKey, ref('auxiliary.tts.apiKey'), secrets),
      };
    }
    r.auxiliary = aux;
  }
  if (r.webhooks) {
    const hooks: Record<string, WebhookHookConfig> = {};
    for (const [id, hook] of Object.entries(r.webhooks)) {
      hooks[id] = {
        ...hook,
        secret: await externalizeSecret(hook.secret, ref(`webhooks.${id}.secret`), secrets),
        // The signing secrets are credentials too — a `previousSecret` left in
        // plaintext during a rotation window is exactly as usable as the
        // current one.
        ...(hook.hmac
          ? {
              hmac: {
                ...hook.hmac,
                secret: await externalizeSecret(
                  hook.hmac.secret,
                  ref(`webhooks.${id}.hmac.secret`),
                  secrets,
                ),
                ...(hook.hmac.previousSecret
                  ? {
                      previousSecret: await externalizeSecret(
                        hook.hmac.previousSecret,
                        ref(`webhooks.${id}.hmac.previousSecret`),
                        secrets,
                      ),
                    }
                  : {}),
              },
            }
          : {}),
      };
    }
    r.webhooks = hooks;
  }
  if (r.memoryCapture?.apiKey) {
    r.memoryCapture = {
      ...r.memoryCapture,
      apiKey: await externalizeSecret(r.memoryCapture.apiKey, ref('memoryCapture.apiKey'), secrets),
    };
  }
  if (r.telemetry?.export?.langfuse?.secretKey) {
    const lf = r.telemetry.export.langfuse;
    r.telemetry = {
      ...r.telemetry,
      export: {
        ...r.telemetry.export,
        langfuse: {
          ...lf,
          secretKey: await externalizeSecret(
            lf.secretKey,
            ref('telemetry.export.langfuse.secretKey'),
            secrets,
          ),
        },
      },
    };
  }
  if (r.pauseLifecycle?.http?.token) {
    const http = r.pauseLifecycle.http;
    r.pauseLifecycle = {
      ...r.pauseLifecycle,
      http: {
        ...http,
        token: await externalizeSecret(http.token, ref('pauseLifecycle.http.token'), secrets),
      },
    };
  }
  return r;
}

/**
 * Serialize `~/.ethos/config.yaml`.
 *
 * `secrets` is REQUIRED, not optional: every credential value is externalized
 * into the vault before serialization, and an optional resolver would be a
 * control a caller could silently omit — which is exactly how plaintext
 * credentials kept reaching disk (G-SEC).
 */
export async function writeConfig(
  storage: Storage,
  input: EthosConfig,
  secrets: SecretsResolver,
): Promise<void> {
  const config = await externalizeConfigSecrets(input, secrets);
  // Fail-closed gate: the same field policy `loadConfigStrict` enforces at
  // boot, applied to exactly what is about to be serialized. Reused rather
  // than re-implemented so the write and boot checks can never disagree.
  validateNoPlaintextSecrets(config);
  await storage.mkdir(ethosDir());
  const lines = [
    `schemaVersion: ${config.schemaVersion ?? CURRENT_ETHOS_CONFIG_SCHEMA_VERSION}`,
    `provider: ${config.provider}`,
    `model: ${config.model}`,
    `apiKey: ${config.apiKey}`,
    `personality: ${config.personality}`,
  ];
  if (config.memory) lines.push(`memory: ${config.memory}`);
  if (config.memoryCharLimits) {
    if (config.memoryCharLimits.memory !== undefined) {
      lines.push(`memory.charLimits.memory: ${config.memoryCharLimits.memory}`);
    }
    if (config.memoryCharLimits.user !== undefined) {
      lines.push(`memory.charLimits.user: ${config.memoryCharLimits.user}`);
    }
  }
  if (config.execution?.docker) {
    if (config.execution.docker.cpu !== undefined) {
      lines.push(`execution.docker.cpu: ${config.execution.docker.cpu}`);
    }
    if (config.execution.docker.diskMb !== undefined) {
      lines.push(`execution.docker.diskMb: ${config.execution.docker.diskMb}`);
    }
  }
  if (config.baseUrl) lines.push(`baseUrl: ${config.baseUrl}`);
  if (config.apiVersion) lines.push(`apiVersion: ${config.apiVersion}`);
  if (config.region) lines.push(`region: ${config.region}`);
  if (config.awsProfile) lines.push(`awsProfile: ${config.awsProfile}`);
  if (config.contextWindow !== undefined) lines.push(`contextWindow: ${config.contextWindow}`);
  if (config.toolOrder !== undefined) lines.push(`toolOrder: ${config.toolOrder}`);
  if (config.requestTimeoutMs !== undefined)
    lines.push(`requestTimeoutMs: ${config.requestTimeoutMs}`);
  if (config.approvalTimeoutMs !== undefined)
    lines.push(`approvalTimeoutMs: ${config.approvalTimeoutMs}`);
  if (config.maxRetries !== undefined) lines.push(`maxRetries: ${config.maxRetries}`);
  if (config.toolPayloadLimitChars !== undefined)
    lines.push(`toolPayloadLimitChars: ${config.toolPayloadLimitChars}`);
  if (config.modelRouting) {
    for (const [id, model] of Object.entries(config.modelRouting)) {
      lines.push(`modelRouting.${id}: ${model}`);
    }
  }
  if (config.toolSettings) {
    for (const [id, settings] of Object.entries(config.toolSettings)) {
      const ws = settings.web_search;
      if (ws?.provider) lines.push(`toolSettings.${id}.web_search.provider: ${ws.provider}`);
      if (ws?.secret) lines.push(`toolSettings.${id}.web_search.secret: ${ws.secret}`);
    }
  }
  if (config.models) {
    for (const [modelKey, profile] of Object.entries(config.models)) {
      if (profile.sampling) {
        for (const key of ['temperature', 'topP', 'topK', 'minP'] as const) {
          const v = profile.sampling[key];
          if (v !== undefined) lines.push(`models.${modelKey}.sampling.${key}: ${v}`);
        }
      }
      if (profile.toolCallFormat !== undefined) {
        lines.push(`models.${modelKey}.toolCallFormat: ${profile.toolCallFormat}`);
      }
      if (profile.maxOutputTokens !== undefined) {
        lines.push(`models.${modelKey}.maxOutputTokens: ${profile.maxOutputTokens}`);
      }
    }
  }
  if (config.compaction) {
    if (config.compaction.pressure !== undefined) {
      lines.push(`compaction.pressure: ${config.compaction.pressure}`);
    }
    if (config.compaction.target !== undefined) {
      lines.push(`compaction.target: ${config.compaction.target}`);
    }
    if (config.compaction.gateDelta !== undefined) {
      lines.push(`compaction.gateDelta: ${config.compaction.gateDelta}`);
    }
    if (config.compaction.autoCompact !== undefined) {
      lines.push(`compaction.autoCompact: ${config.compaction.autoCompact}`);
    }
    if (config.compaction.retryOnOverflow !== undefined) {
      lines.push(`compaction.retryOnOverflow: ${config.compaction.retryOnOverflow}`);
    }
    if (config.compaction.abortOnSummaryFailure !== undefined) {
      lines.push(`compaction.abortOnSummaryFailure: ${config.compaction.abortOnSummaryFailure}`);
    }
    if (config.compaction.smallWindow !== undefined) {
      lines.push(`compaction.smallWindow: ${config.compaction.smallWindow}`);
    }
    if (config.compaction.maxContextTokens !== undefined) {
      lines.push(`compaction.maxContextTokens: ${config.compaction.maxContextTokens}`);
    }
    if (config.compaction.minTailUserMessages !== undefined) {
      lines.push(`compaction.minTailUserMessages: ${config.compaction.minTailUserMessages}`);
    }
  }
  if (config.callCapture?.personalityId) {
    lines.push(`callCapture.personalityId: ${config.callCapture.personalityId}`);
  }
  if (config.memoryConsolidation) {
    const m = config.memoryConsolidation;
    if (m.enabled !== undefined) lines.push(`memoryConsolidation.enabled: ${m.enabled}`);
    if (m.flushThreshold !== undefined)
      lines.push(`memoryConsolidation.flushThreshold: ${m.flushThreshold}`);
    if (m.timeboxMs !== undefined) lines.push(`memoryConsolidation.timeboxMs: ${m.timeboxMs}`);
    if (m.maxTokens !== undefined) lines.push(`memoryConsolidation.maxTokens: ${m.maxTokens}`);
    if (m.maxDeltaChars !== undefined)
      lines.push(`memoryConsolidation.maxDeltaChars: ${m.maxDeltaChars}`);
    if (m.minMessagesSinceFlush !== undefined)
      lines.push(`memoryConsolidation.minMessagesSinceFlush: ${m.minMessagesSinceFlush}`);
  }
  if (config.activeContext) {
    lines.push(`activeContext.type: ${config.activeContext.type}`);
    lines.push(`activeContext.name: ${config.activeContext.name}`);
  }
  if (config.telegramToken) lines.push(`telegramToken: ${config.telegramToken}`);
  if (config.discordToken) lines.push(`discordToken: ${config.discordToken}`);
  if (config.slackBotToken) lines.push(`slackBotToken: ${config.slackBotToken}`);
  if (config.slackAppToken) lines.push(`slackAppToken: ${config.slackAppToken}`);
  if (config.slackSigningSecret) lines.push(`slackSigningSecret: ${config.slackSigningSecret}`);
  if (config.emailImapHost) lines.push(`emailImapHost: ${config.emailImapHost}`);
  if (config.emailImapPort) lines.push(`emailImapPort: ${config.emailImapPort}`);
  if (config.emailUser) lines.push(`emailUser: ${config.emailUser}`);
  if (config.emailPassword) lines.push(`emailPassword: ${config.emailPassword}`);
  if (config.emailSmtpHost) lines.push(`emailSmtpHost: ${config.emailSmtpHost}`);
  if (config.emailSmtpPort) lines.push(`emailSmtpPort: ${config.emailSmtpPort}`);
  if (config.verbose) lines.push('verbose: true');
  if (config.displayVerbosity) lines.push(`display.verbosity: ${config.displayVerbosity}`);
  if (config.displayBusyInputMode)
    lines.push(`display.busy_input_mode: ${config.displayBusyInputMode}`);
  if (config.displayToolPreviewLength !== undefined)
    lines.push(`display.tool_preview_length: ${config.displayToolPreviewLength}`);
  if (config.displayResumeHint === false) lines.push('display.resume_hint: false');
  if (config.displayResumeRecapTurns !== undefined)
    lines.push(`display.resume_recap_turns: ${config.displayResumeRecapTurns}`);
  if (config.displayBellOnComplete) lines.push('display.bell_on_complete: true');
  if (config.displayMemoryNotices !== undefined)
    lines.push(`display.memory_notices: ${config.displayMemoryNotices}`);
  if (config.displayStreamingEdits)
    lines.push(`display.streaming_edits: ${config.displayStreamingEdits}`);
  if (config.displayCallStyle) lines.push(`display.call_style: ${config.displayCallStyle}`);
  if (config.displayCallAccent) lines.push(`display.call_accent: ${config.displayCallAccent}`);
  if (config.displayDebugPanel) lines.push('display.debug_panel: true');
  if (config.displayDebugPanelModel)
    lines.push(`display.debug_panel_model: ${config.displayDebugPanelModel}`);
  if (config.skin) lines.push(`skin: ${config.skin}`);
  if (config.retention) {
    for (const [key, val] of retentionToLines(config.retention)) {
      lines.push(`retention.${key}: ${val}`);
    }
  }
  if (config.personalitiesConfig) {
    for (const [pid, pcfg] of Object.entries(config.personalitiesConfig)) {
      if (pcfg.retention) {
        for (const [key, val] of retentionToLines(pcfg.retention)) {
          lines.push(`personalities.${pid}.retention.${key}: ${val}`);
        }
      }
    }
  }
  if (config.evolverCronEnabled) lines.push('evolver.cron_enabled: true');
  if (config.evolverSchedule) lines.push(`evolver.schedule: ${config.evolverSchedule}`);
  if (config.backgroundMaxConcurrent !== undefined)
    lines.push(`background.max_concurrent: ${config.backgroundMaxConcurrent}`);
  if (config.background) {
    for (const [key, val] of backgroundToLines(config.background)) {
      lines.push(`background.${key}: ${val}`);
    }
  }
  if (config.telegram?.bots.length) {
    for (const [i, bot] of config.telegram.bots.entries()) {
      if (bot.id) lines.push(`telegram.bots.${i}.id: ${bot.id}`);
      lines.push(`telegram.bots.${i}.token: ${bot.token}`);
      lines.push(`telegram.bots.${i}.bind.type: ${bot.bind.type}`);
      lines.push(`telegram.bots.${i}.bind.name: ${bot.bind.name}`);
      if (bot.bind.allowSlashSwitch) {
        lines.push(`telegram.bots.${i}.bind.allowSlashSwitch: true`);
      }
      if (bot.useWebhook !== undefined) {
        lines.push(`telegram.bots.${i}.useWebhook: ${bot.useWebhook}`);
      }
      if (bot.webhookUrl) lines.push(`telegram.bots.${i}.webhookUrl: ${bot.webhookUrl}`);
      if (bot.webhookSecretToken) {
        lines.push(`telegram.bots.${i}.webhookSecretToken: ${bot.webhookSecretToken}`);
      }
      if (bot.dropPendingUpdates !== undefined) {
        lines.push(`telegram.bots.${i}.dropPendingUpdates: ${bot.dropPendingUpdates}`);
      }
    }
  }
  if (config.slack?.apps.length) {
    for (const [i, app] of config.slack.apps.entries()) {
      if (app.id) lines.push(`slack.apps.${i}.id: ${app.id}`);
      lines.push(`slack.apps.${i}.botToken: ${app.botToken}`);
      if (app.appToken) lines.push(`slack.apps.${i}.appToken: ${app.appToken}`);
      lines.push(`slack.apps.${i}.signingSecret: ${app.signingSecret}`);
      lines.push(`slack.apps.${i}.bind.type: ${app.bind.type}`);
      lines.push(`slack.apps.${i}.bind.name: ${app.bind.name}`);
      if (app.bind.allowSlashSwitch) {
        lines.push(`slack.apps.${i}.bind.allowSlashSwitch: true`);
      }
      if (app.defaultChannelMode) {
        lines.push(`slack.apps.${i}.defaultChannelMode: ${app.defaultChannelMode}`);
      }
      if (app.receiptReaction) {
        lines.push(`slack.apps.${i}.receiptReaction: ${app.receiptReaction}`);
      }
      if (app.allowedSlashUsers?.length) {
        lines.push(`slack.apps.${i}.allowedSlashUsers: ${app.allowedSlashUsers.join(',')}`);
      }
      if (app.allowedBotIds?.length) {
        lines.push(`slack.apps.${i}.allowedBotIds: ${app.allowedBotIds.join(',')}`);
      }
      if (app.longReplyThresholdChars !== undefined) {
        lines.push(`slack.apps.${i}.longReplyThresholdChars: ${app.longReplyThresholdChars}`);
      }
      if (app.mode?.socket !== undefined) {
        lines.push(`slack.apps.${i}.mode.socket: ${app.mode.socket}`);
      }
      if (app.mode?.http !== undefined) {
        lines.push(`slack.apps.${i}.mode.http: ${app.mode.http}`);
      }
      if (app.webhookPath) lines.push(`slack.apps.${i}.webhookPath: ${app.webhookPath}`);
    }
  }
  if (config.whatsapp?.length) {
    for (const [i, wa] of config.whatsapp.entries()) {
      if (wa.id) lines.push(`whatsapp.${i}.id: ${wa.id}`);
      if (wa.default_mode) lines.push(`whatsapp.${i}.default_mode: ${wa.default_mode}`);
      if (wa.session_dir) lines.push(`whatsapp.${i}.session_dir: ${wa.session_dir}`);
      if (wa.phone_number) lines.push(`whatsapp.${i}.phone_number: ${wa.phone_number}`);
      if (wa.allowed_numbers && wa.allowed_numbers.length > 0) {
        lines.push(`whatsapp.${i}.allowed_numbers: ${wa.allowed_numbers.join(',')}`);
      }
      if (wa.bind) {
        lines.push(`whatsapp.${i}.bind.type: ${wa.bind.type}`);
        lines.push(`whatsapp.${i}.bind.name: ${wa.bind.name}`);
        if (wa.bind.allowSlashSwitch) {
          lines.push(`whatsapp.${i}.bind.allowSlashSwitch: true`);
        }
      }
    }
  }
  if (config.voice) {
    for (const [i, bot] of config.voice.bots.entries()) {
      if (bot.id) lines.push(`voice.bots.${i}.id: ${bot.id}`);
      lines.push(`voice.bots.${i}.match: ${bot.match}`);
      lines.push(`voice.bots.${i}.bind.type: ${bot.bind.type}`);
      lines.push(`voice.bots.${i}.bind.name: ${bot.bind.name}`);
      if (bot.bind.allowSlashSwitch) {
        lines.push(`voice.bots.${i}.bind.allowSlashSwitch: true`);
      }
    }
    if (config.voice.livekit) {
      lines.push(`voice.livekit.url: ${config.voice.livekit.url}`);
      lines.push(`voice.livekit.apiKey: ${config.voice.livekit.apiKey}`);
      lines.push(`voice.livekit.apiSecret: ${config.voice.livekit.apiSecret}`);
    }
    if (config.voice.trunk) {
      const t = config.voice.trunk;
      lines.push(`voice.trunk.provider: ${t.provider}`);
      lines.push(`voice.trunk.trunkId: ${t.trunkId}`);
      if (t.fromNumber) lines.push(`voice.trunk.fromNumber: ${t.fromNumber}`);
      if (t.username) lines.push(`voice.trunk.username: ${t.username}`);
      if (t.password) lines.push(`voice.trunk.password: ${t.password}`);
      if (t.webhookSecret) lines.push(`voice.trunk.webhookSecret: ${t.webhookSecret}`);
      if (t.webhookPath) lines.push(`voice.trunk.webhookPath: ${t.webhookPath}`);
      if (t.codec) lines.push(`voice.trunk.codec: ${t.codec}`);
    }
    if (config.voice.inbound) {
      const ib = config.voice.inbound;
      if (ib.allowlist?.length) lines.push(`voice.inbound.allowlist: ${ib.allowlist.join(', ')}`);
      if (ib.receptionist) lines.push(`voice.inbound.receptionist: ${ib.receptionist}`);
      if (ib.concurrencyCap !== undefined) {
        lines.push(`voice.inbound.concurrencyCap: ${ib.concurrencyCap}`);
      }
      if (ib.perCallerPerHour !== undefined) {
        lines.push(`voice.inbound.perCallerPerHour: ${ib.perCallerPerHour}`);
      }
      if (ib.dailyBudgetUsd !== undefined) {
        lines.push(`voice.inbound.dailyBudgetUsd: ${ib.dailyBudgetUsd}`);
      }
      if (ib.prewarm) lines.push(`voice.inbound.prewarm: ${ib.prewarm}`);
      // `platform` and `chatId` are unconditional — an owner is only ever built
      // with both, and a half-written destination would round-trip to nothing.
      if (ib.owner) {
        lines.push(`voice.inbound.owner.platform: ${ib.owner.platform}`);
        lines.push(`voice.inbound.owner.chatId: ${ib.owner.chatId}`);
        if (ib.owner.botKey) lines.push(`voice.inbound.owner.botKey: ${ib.owner.botKey}`);
      }
    }
    for (const [surface, tuning] of Object.entries(config.voice.bargeIn ?? {})) {
      if (tuning.energyThreshold !== undefined) {
        lines.push(`voice.bargeIn.${surface}.energyThreshold: ${tuning.energyThreshold}`);
      }
      if (tuning.minSpeechMs !== undefined) {
        lines.push(`voice.bargeIn.${surface}.minSpeechMs: ${tuning.minSpeechMs}`);
      }
      if (tuning.silenceMs !== undefined) {
        lines.push(`voice.bargeIn.${surface}.silenceMs: ${tuning.silenceMs}`);
      }
    }
    if (config.voice.filler) {
      const fl = config.voice.filler;
      if (fl.enabled !== undefined) lines.push(`voice.filler.enabled: ${fl.enabled}`);
      if (fl.afterMs !== undefined) lines.push(`voice.filler.afterMs: ${fl.afterMs}`);
      if (fl.text) lines.push(`voice.filler.text: ${fl.text}`);
      if (fl.tickIntervalMs !== undefined) {
        lines.push(`voice.filler.tickIntervalMs: ${fl.tickIntervalMs}`);
      }
    }
    // Serialized whenever present, INCLUDING the empty list — an empty
    // allowlist is "trust nothing non-local", not "no opinion".
    if (config.voice.trustedPlugins !== undefined) {
      lines.push(`voice.trustedPlugins: ${config.voice.trustedPlugins.join(', ')}`);
    }
    if (config.voice.defaultMode) {
      lines.push(`voice.defaultMode: ${config.voice.defaultMode}`);
    }
    if (config.voice.tier) {
      lines.push(`voice.tier: ${config.voice.tier}`);
    }
    for (const [platform, entry] of Object.entries(config.voice.channels ?? {})) {
      if (entry.ttsOut !== undefined) {
        lines.push(`voice.channels.${platform}.ttsOut: ${entry.ttsOut}`);
      }
    }
    if (config.voice.transcode) {
      const tc = config.voice.transcode;
      if (tc.ffmpegPath) lines.push(`voice.transcode.ffmpegPath: ${tc.ffmpegPath}`);
      if (tc.bitrateKbps !== undefined)
        lines.push(`voice.transcode.bitrateKbps: ${tc.bitrateKbps}`);
      if (tc.timeout !== undefined) lines.push(`voice.transcode.timeout: ${tc.timeout}`);
    }
    if (config.voice.artifacts) {
      const ar = config.voice.artifacts;
      if (ar.abandonAfterDays !== undefined) {
        lines.push(`voice.artifacts.abandonAfterDays: ${ar.abandonAfterDays}`);
      }
      if (ar.maxTotalMb !== undefined) lines.push(`voice.artifacts.maxTotalMb: ${ar.maxTotalMb}`);
    }
    if (config.voice.wake) {
      const wk = config.voice.wake;
      if (wk.enabled !== undefined) lines.push(`voice.wake.enabled: ${wk.enabled}`);
      if (wk.engine) lines.push(`voice.wake.engine: ${wk.engine}`);
      if (wk.sensitivity !== undefined) lines.push(`voice.wake.sensitivity: ${wk.sensitivity}`);
      if (wk.confirmationFrames !== undefined) {
        lines.push(`voice.wake.confirmationFrames: ${wk.confirmationFrames}`);
      }
      if (wk.edgeStt !== undefined) lines.push(`voice.wake.edgeStt: ${wk.edgeStt}`);
      if (wk.idleTimeout !== undefined) lines.push(`voice.wake.idleTimeout: ${wk.idleTimeout}`);
      // `phrase` and `personality` are unconditional — a route is only ever
      // built with both, and a half-written route would round-trip to nothing.
      for (const [id, route] of Object.entries(wk.routes ?? {})) {
        lines.push(`voice.wake.routes.${id}.phrase: ${route.phrase}`);
        lines.push(`voice.wake.routes.${id}.personality: ${route.personality}`);
        if (route.privileged !== undefined) {
          lines.push(`voice.wake.routes.${id}.privileged: ${route.privileged}`);
        }
        if (route.enabled !== undefined) {
          lines.push(`voice.wake.routes.${id}.enabled: ${route.enabled}`);
        }
      }
      for (const [id, node] of Object.entries(wk.nodes ?? {})) {
        if (node.inputDevice) {
          lines.push(`voice.wake.nodes.${id}.inputDevice: ${node.inputDevice}`);
        }
        if (node.enabled !== undefined) {
          lines.push(`voice.wake.nodes.${id}.enabled: ${node.enabled}`);
        }
      }
    }
    // Always the NEW spelling, whichever one was read. A config parsed from
    // `voice.providers.*` re-serializes as `voice.tts.providers.*` and never
    // carries both.
    for (const [name, entry] of Object.entries(config.voice.tts?.providers ?? {})) {
      lines.push(
        ...voiceProviderEntryLines(`voice.tts.providers.${name}`, entry, TTS_ENTRY_FIELDS),
      );
    }
    for (const [name, entry] of Object.entries(config.voice.stt?.providers ?? {})) {
      lines.push(
        ...voiceProviderEntryLines(`voice.stt.providers.${name}`, entry, STT_ENTRY_FIELDS),
      );
    }
    for (const [name, entry] of Object.entries(config.voice.realtime?.providers ?? {})) {
      lines.push(
        ...voiceProviderEntryLines(
          `voice.realtime.providers.${name}`,
          entry,
          REALTIME_ENTRY_FIELDS,
        ),
      );
    }
    if (config.voice.realtime?.default) {
      lines.push(`voice.realtime.default: ${config.voice.realtime.default}`);
    }
    if (config.voice.realtime?.sessionBudgetUsd !== undefined) {
      lines.push(`voice.realtime.sessionBudgetUsd: ${config.voice.realtime.sessionBudgetUsd}`);
    }
  }
  if (config.teams) {
    for (const [name, tcfg] of Object.entries(config.teams)) {
      if (tcfg.autoStop) lines.push(`teams.${name}.autoStop: true`);
    }
  }
  if (config.quick_commands) {
    for (const [name, qc] of Object.entries(config.quick_commands)) {
      lines.push(`quick_commands.${name}.type: ${qc.type}`);
      if (qc.type === 'exec') {
        lines.push(`quick_commands.${name}.command: ${qc.command}`);
      } else {
        lines.push(`quick_commands.${name}.reply: ${qc.reply}`);
      }
      if (qc.gateway) lines.push(`quick_commands.${name}.gateway: true`);
      if (qc.channels && qc.channels.length > 0) {
        lines.push(`quick_commands.${name}.channels: ${qc.channels.join(',')}`);
      }
    }
  }
  if (config.channelToolsets) {
    for (const [platform, tools] of Object.entries(config.channelToolsets)) {
      lines.push(`channel_toolsets.${platform}: ${tools.join(',')}`);
    }
  }
  if (config.channelFilter) {
    for (const [platform, cfg] of Object.entries(config.channelFilter)) {
      if (cfg.enabled === false) lines.push(`channel_filter.${platform}.enable: false`);
      if (cfg.ownerUserId) lines.push(`channel_filter.${platform}.ownerUserId: ${cfg.ownerUserId}`);
      if (cfg.recipientAllowlist && cfg.recipientAllowlist.length > 0) {
        lines.push(
          `channel_filter.${platform}.recipientAllowlist: ${cfg.recipientAllowlist.join(',')}`,
        );
      }
      if (cfg.dmPolicy) lines.push(`channel_filter.${platform}.dmPolicy: ${cfg.dmPolicy}`);
      if (cfg.contextVisibility)
        lines.push(`channel_filter.${platform}.contextVisibility: ${cfg.contextVisibility}`);
    }
  }
  if (config.providers && config.providers.length > 0) {
    for (const [i, p] of config.providers.entries()) {
      lines.push(`providers.${i}.provider: ${p.provider}`);
      lines.push(`providers.${i}.apiKey: ${p.apiKey}`);
      if (p.model) lines.push(`providers.${i}.model: ${p.model}`);
      if (p.baseUrl) lines.push(`providers.${i}.baseUrl: ${p.baseUrl}`);
      if (p.apiVersion) lines.push(`providers.${i}.apiVersion: ${p.apiVersion}`);
      if (p.region) lines.push(`providers.${i}.region: ${p.region}`);
      if (p.awsProfile) lines.push(`providers.${i}.awsProfile: ${p.awsProfile}`);
    }
  }
  if (config.auxiliary?.compression) {
    const c = config.auxiliary.compression;
    lines.push(`auxiliary.compression.model: ${c.model}`);
    if (c.provider) lines.push(`auxiliary.compression.provider: ${c.provider}`);
    if (c.apiKey) lines.push(`auxiliary.compression.apiKey: ${c.apiKey}`);
    if (c.baseUrl) lines.push(`auxiliary.compression.baseUrl: ${c.baseUrl}`);
  }
  if (config.auxiliary?.vision) {
    const v = config.auxiliary.vision;
    lines.push(`auxiliary.vision.model: ${v.model}`);
    if (v.provider) lines.push(`auxiliary.vision.provider: ${v.provider}`);
    if (v.apiKey) lines.push(`auxiliary.vision.apiKey: ${v.apiKey}`);
    if (v.baseUrl) lines.push(`auxiliary.vision.baseUrl: ${v.baseUrl}`);
  }
  if (config.auxiliary?.web) {
    const w = config.auxiliary.web;
    lines.push(`auxiliary.web.model: ${w.model}`);
    if (w.provider) lines.push(`auxiliary.web.provider: ${w.provider}`);
    if (w.apiKey) lines.push(`auxiliary.web.apiKey: ${w.apiKey}`);
    if (w.baseUrl) lines.push(`auxiliary.web.baseUrl: ${w.baseUrl}`);
  }
  if (config.auxiliary?.asr) {
    lines.push(...voiceProviderEntryLines('auxiliary.asr', config.auxiliary.asr, STT_ENTRY_FIELDS));
  }
  if (config.auxiliary?.tts) {
    lines.push(...voiceProviderEntryLines('auxiliary.tts', config.auxiliary.tts, TTS_ENTRY_FIELDS));
  }
  if (config.web?.search_backend) lines.push(`web.search_backend: ${config.web.search_backend}`);
  if (config.web?.extract_backend) lines.push(`web.extract_backend: ${config.web.extract_backend}`);
  if (config.web?.host) lines.push(`web.host: ${config.web.host}`);
  if (config.web?.port !== undefined) lines.push(`web.port: ${config.web.port}`);
  if (config.web?.corsOrigins) lines.push(`web.corsOrigins: ${config.web.corsOrigins}`);
  if (config.webhooks) {
    for (const [hookId, hook] of Object.entries(config.webhooks)) {
      lines.push(`webhooks.${hookId}.personalityId: ${hook.personalityId}`);
      lines.push(`webhooks.${hookId}.secret: ${hook.secret}`);
      if (hook.sessionKey) lines.push(`webhooks.${hookId}.sessionKey: ${hook.sessionKey}`);
      if (hook.prefilter) lines.push(`webhooks.${hookId}.prefilter: ${hook.prefilter}`);
      if (hook.prefilterTimeoutSeconds !== undefined)
        lines.push(`webhooks.${hookId}.prefilterTimeoutSeconds: ${hook.prefilterTimeoutSeconds}`);
      if (hook.mode) lines.push(`webhooks.${hookId}.mode: ${hook.mode}`);
      if (hook.events?.length) lines.push(`webhooks.${hookId}.events: ${hook.events.join(', ')}`);
      if (hook.eventHeader) lines.push(`webhooks.${hookId}.eventHeader: ${hook.eventHeader}`);
      if (hook.eventField) lines.push(`webhooks.${hookId}.eventField: ${hook.eventField}`);
      // Only `true` is emitted: an explicit `false` and an absent key mean the
      // same thing, and the parser rejects any other spelling on the way back.
      if (hook.deliverOnly === true) lines.push(`webhooks.${hookId}.deliverOnly: true`);
      for (const [i, target] of (hook.deliver ?? []).entries()) {
        const key = `webhooks.${hookId}.deliver.${i}`;
        lines.push(`${key}.type: ${target.type}`);
        if (target.type === 'platform') {
          lines.push(`${key}.adapterId: ${target.adapterId}`);
          lines.push(`${key}.chatId: ${target.chatId}`);
          if (target.threadId) lines.push(`${key}.threadId: ${target.threadId}`);
        }
      }
      if (hook.hmac) {
        lines.push(`webhooks.${hookId}.hmac.secret: ${hook.hmac.secret}`);
        if (hook.hmac.header) lines.push(`webhooks.${hookId}.hmac.header: ${hook.hmac.header}`);
        if (hook.hmac.algorithm)
          lines.push(`webhooks.${hookId}.hmac.algorithm: ${hook.hmac.algorithm}`);
        if (hook.hmac.previousSecret)
          lines.push(`webhooks.${hookId}.hmac.previousSecret: ${hook.hmac.previousSecret}`);
      }
      if (hook.rateLimit) {
        if (hook.rateLimit.maxPerMinute !== undefined)
          lines.push(`webhooks.${hookId}.rateLimit.maxPerMinute: ${hook.rateLimit.maxPerMinute}`);
        if (hook.rateLimit.lockoutSeconds !== undefined)
          lines.push(
            `webhooks.${hookId}.rateLimit.lockoutSeconds: ${hook.rateLimit.lockoutSeconds}`,
          );
      }
    }
  }
  if (config.modelCatalog) {
    if (config.modelCatalog.enabled === false) lines.push('modelCatalog.enabled: false');
    if (config.modelCatalog.url) lines.push(`modelCatalog.url: ${config.modelCatalog.url}`);
    if (config.modelCatalog.ttlHours !== undefined)
      lines.push(`modelCatalog.ttlHours: ${config.modelCatalog.ttlHours}`);
    if (config.modelCatalog.providers) {
      for (const [id, p] of Object.entries(config.modelCatalog.providers)) {
        lines.push(`modelCatalog.providers.${id}.url: ${p.url}`);
      }
    }
  }
  if (config.logs?.rotation) {
    const r = config.logs.rotation;
    if (r.maxBytes !== undefined) lines.push(`logs.rotation.maxBytes: ${r.maxBytes}`);
    if (r.maxFiles !== undefined) lines.push(`logs.rotation.maxFiles: ${r.maxFiles}`);
    if (r.enabled === false) lines.push('logs.rotation.enabled: false');
  }
  if (config.logs?.level !== undefined) lines.push(`logs.level: ${config.logs.level}`);
  if (config.aws?.secrets) {
    const s = config.aws.secrets;
    if (s.enabled !== undefined) lines.push(`aws.secrets.enabled: ${s.enabled}`);
    if (s.region) lines.push(`aws.secrets.region: ${s.region}`);
    if (s.prefix) lines.push(`aws.secrets.prefix: ${s.prefix}`);
    if (s.endpoint) lines.push(`aws.secrets.endpoint: ${s.endpoint}`);
  }
  if (config.webBaseUrl) lines.push(`webBaseUrl: ${config.webBaseUrl}`);
  if (config.pluginsAutoInstall !== undefined)
    lines.push(`plugins.auto_install: ${config.pluginsAutoInstall}`);
  if (config.admin?.enabled !== undefined) lines.push(`admin.enabled: ${config.admin.enabled}`);
  if (config.a2a?.enabled !== undefined) lines.push(`a2a.enabled: ${config.a2a.enabled}`);
  // Written even when the list is empty — `""` is how "trust no org" survives
  // a round-trip, and dropping the line would silently restore the default.
  if (config.security?.trustedGitHubOrgs !== undefined)
    lines.push(
      `security.trusted_github_orgs: ${
        config.security.trustedGitHubOrgs.length > 0
          ? config.security.trustedGitHubOrgs.join(',')
          : '""'
      }`,
    );
  if (config.nightlyPass) {
    if (config.nightlyPass.enabled !== undefined)
      lines.push(`nightlyPass.enabled: ${config.nightlyPass.enabled}`);
    if (config.nightlyPass.cron) lines.push(`nightlyPass.cron: ${config.nightlyPass.cron}`);
  }
  if (config.backup) {
    const bk = config.backup;
    if (bk.enabled !== undefined) lines.push(`backup.enabled: ${bk.enabled}`);
    if (bk.cron) lines.push(`backup.cron: ${bk.cron}`);
    if (bk.scope && bk.scope.length > 0) lines.push(`backup.scope: ${bk.scope.join(',')}`);
    if (bk.keep !== undefined) lines.push(`backup.keep: ${bk.keep}`);
    if (bk.dir) lines.push(`backup.dir: ${bk.dir}`);
  }
  if (config.memoryCapture) {
    const mc = config.memoryCapture;
    if (mc.enabled !== undefined) lines.push(`memoryCapture.enabled: ${mc.enabled}`);
    if (mc.model) lines.push(`memoryCapture.model: ${mc.model}`);
    if (mc.provider) lines.push(`memoryCapture.provider: ${mc.provider}`);
    if (mc.apiKey) lines.push(`memoryCapture.apiKey: ${mc.apiKey}`);
    if (mc.baseUrl) lines.push(`memoryCapture.baseUrl: ${mc.baseUrl}`);
    if (mc.maxPerHour !== undefined) lines.push(`memoryCapture.maxPerHour: ${mc.maxPerHour}`);
    if (mc.maxPerDay !== undefined) lines.push(`memoryCapture.maxPerDay: ${mc.maxPerDay}`);
  }
  if (config.memoryVault) {
    const mv = config.memoryVault;
    if (mv.path) lines.push(`memoryVault.path: ${mv.path}`);
    if (mv.agentDir) lines.push(`memoryVault.agentDir: ${mv.agentDir}`);
    if (mv.prefetch && mv.prefetch.length > 0)
      lines.push(`memoryVault.prefetch: ${mv.prefetch.join(', ')}`);
    if (mv.exclude && mv.exclude.length > 0)
      lines.push(`memoryVault.exclude: ${mv.exclude.join(', ')}`);
  }
  if (config.memoryApproval) {
    const ma = config.memoryApproval;
    if (ma.mode !== undefined) lines.push(`memoryApproval.mode: ${ma.mode}`);
    if (ma.cap !== undefined) lines.push(`memoryApproval.cap: ${ma.cap}`);
    if (ma.ttlDays !== undefined) lines.push(`memoryApproval.ttlDays: ${ma.ttlDays}`);
  }
  if (config.memoryConsolidation) {
    const mco = config.memoryConsolidation;
    if (mco.halfLifeDays !== undefined)
      lines.push(`memoryConsolidation.halfLifeDays: ${mco.halfLifeDays}`);
    if (mco.threshold !== undefined) lines.push(`memoryConsolidation.threshold: ${mco.threshold}`);
    if (mco.exemptUser !== undefined)
      lines.push(`memoryConsolidation.exemptUser: ${mco.exemptUser}`);
  }
  if (config.weeklyDigest) {
    if (config.weeklyDigest.enabled !== undefined)
      lines.push(`weeklyDigest.enabled: ${config.weeklyDigest.enabled}`);
    if (config.weeklyDigest.cron) lines.push(`weeklyDigest.cron: ${config.weeklyDigest.cron}`);
    if (config.weeklyDigest.recipients && config.weeklyDigest.recipients.length > 0)
      lines.push(`weeklyDigest.recipients: ${config.weeklyDigest.recipients.join(',')}`);
  }
  if (config.toolLoop) {
    if (config.toolLoop.maxToolCallsWarnAt !== undefined)
      lines.push(`toolLoop.maxToolCallsWarnAt: ${config.toolLoop.maxToolCallsWarnAt}`);
    if (config.toolLoop.maxIdenticalToolCallsWarnAt !== undefined)
      lines.push(
        `toolLoop.maxIdenticalToolCallsWarnAt: ${config.toolLoop.maxIdenticalToolCallsWarnAt}`,
      );
  }
  if (config.cron) {
    // KNOWN HAZARD, mirrored not fixed: `cron.fireUrl` may have arrived from
    // ETHOS_CRON_FIRE_URL rather than the yaml (the parse folds the env
    // override into the config), so a writeConfig on a process started with
    // that variable bakes the env value into config.yaml. `pauseLifecycle.
    // http.url` behaves identically with ETHOS_ORCHESTRATOR_URL; we follow the
    // precedent rather than diverge from it. Fixing both at once is an
    // out-of-scope follow-up (plan/phases/cron-fire-url-collapse.md, N3).
    // The sentinel is NEVER serialized. It is an in-memory stand-in for a
    // legacy mode, not an address: persisting it would outlive the shim that
    // gives it meaning, so in 0.9.0 it would still read as external mode by
    // presence while the operator's config carried a nonsense address forever.
    // A legacy-external deployment therefore round-trips with no `cron.fireUrl`
    // line at all and keeps getting the deprecation warning until it writes a
    // real URL — which is the correct nag, not a regression.
    if (config.cron.fireUrl !== undefined && config.cron.fireUrl !== LEGACY_EXTERNAL_FIRE_URL) {
      lines.push(`cron.fireUrl: ${config.cron.fireUrl}`);
    }
    if (config.cron.maxParallelJobs !== undefined) {
      lines.push(`cron.maxParallelJobs: ${config.cron.maxParallelJobs}`);
    }
  }
  if (config.kanban) {
    if (config.kanban.maxInProgress !== undefined)
      lines.push(`kanban.maxInProgress: ${config.kanban.maxInProgress}`);
    if (config.kanban.maxInProgressPerProfile !== undefined)
      lines.push(`kanban.maxInProgressPerProfile: ${config.kanban.maxInProgressPerProfile}`);
  }
  if (config.browser) {
    if (config.browser.navigationTimeoutMs !== undefined)
      lines.push(`browser.navigationTimeoutMs: ${config.browser.navigationTimeoutMs}`);
    if (config.browser.commandTimeoutMs !== undefined)
      lines.push(`browser.commandTimeoutMs: ${config.browser.commandTimeoutMs}`);
  }
  if (config.gateway?.maxInboundMediaBytes !== undefined) {
    lines.push(`gateway.maxInboundMediaBytes: ${config.gateway.maxInboundMediaBytes}`);
  }
  if (config.teamSupervisor?.restartLoopGuard) {
    const rg = config.teamSupervisor.restartLoopGuard;
    if (rg.maxRestarts !== undefined)
      lines.push(`teamSupervisor.restartLoopGuard.maxRestarts: ${rg.maxRestarts}`);
    if (rg.windowSeconds !== undefined)
      lines.push(`teamSupervisor.restartLoopGuard.windowSeconds: ${rg.windowSeconds}`);
  }
  if (config.discord?.missedMessageBackfill) {
    const bf = config.discord.missedMessageBackfill;
    if (bf.enabled !== undefined)
      lines.push(`discord.missedMessageBackfill.enabled: ${bf.enabled}`);
    if (bf.windowSeconds !== undefined)
      lines.push(`discord.missedMessageBackfill.windowSeconds: ${bf.windowSeconds}`);
    if (bf.limit !== undefined) lines.push(`discord.missedMessageBackfill.limit: ${bf.limit}`);
  }
  if (config.kanbanPoll) {
    if (config.kanbanPoll.enabled !== undefined)
      lines.push(`kanbanPoll.enabled: ${config.kanbanPoll.enabled}`);
    if (config.kanbanPoll.intervalMs !== undefined)
      lines.push(`kanbanPoll.intervalMs: ${config.kanbanPoll.intervalMs}`);
    if (config.kanbanPoll.boardPath !== undefined)
      lines.push(`kanbanPoll.boardPath: ${config.kanbanPoll.boardPath}`);
  }
  if (config.idleWatcher) {
    const iw = config.idleWatcher;
    if (iw.enabled !== undefined) lines.push(`idleWatcher.enabled: ${iw.enabled}`);
    if (iw.idleThresholdMs !== undefined)
      lines.push(`idleWatcher.idleThresholdMs: ${iw.idleThresholdMs}`);
    if (iw.startupCooldownMs !== undefined)
      lines.push(`idleWatcher.startupCooldownMs: ${iw.startupCooldownMs}`);
    if (iw.checkIntervalMs !== undefined)
      lines.push(`idleWatcher.checkIntervalMs: ${iw.checkIntervalMs}`);
    if (iw.wakePathConfirmed !== undefined)
      lines.push(`idleWatcher.wakePathConfirmed: ${iw.wakePathConfirmed}`);
  }
  if (config.pauseClockCorrection) {
    const pcc = config.pauseClockCorrection;
    if (pcc.enabled !== undefined) lines.push(`pauseClockCorrection.enabled: ${pcc.enabled}`);
    if (pcc.thresholdMs !== undefined)
      lines.push(`pauseClockCorrection.thresholdMs: ${pcc.thresholdMs}`);
  }
  if (config.pauseLifecycle?.http) {
    const plh = config.pauseLifecycle.http;
    if (plh.url) lines.push(`pauseLifecycle.http.url: ${plh.url}`);
    if (plh.token) lines.push(`pauseLifecycle.http.token: ${plh.token}`);
    if (plh.timeoutMs !== undefined) lines.push(`pauseLifecycle.http.timeoutMs: ${plh.timeoutMs}`);
  }
  if (config.telemetry?.export?.langfuse) {
    const lf = config.telemetry.export.langfuse;
    if (lf.enabled !== undefined) lines.push(`telemetry.export.langfuse.enabled: ${lf.enabled}`);
    if (lf.baseUrl) lines.push(`telemetry.export.langfuse.baseUrl: ${lf.baseUrl}`);
    if (lf.publicKey) lines.push(`telemetry.export.langfuse.publicKey: ${lf.publicKey}`);
    if (lf.secretKey) lines.push(`telemetry.export.langfuse.secretKey: ${lf.secretKey}`);
  }
  await storage.write(join(ethosDir(), 'config.yaml'), `${lines.join('\n')}\n`, { mode: 0o600 });
}

export async function resolveConfigSecrets(
  config: EthosConfig,
  secrets: SecretsResolver,
): Promise<EthosConfig> {
  const r = { ...config };
  r.apiKey = await resolveSecretValue(r.apiKey, secrets);
  if (r.baseUrl) r.baseUrl = await resolveSecretValue(r.baseUrl, secrets);
  if (r.telegramToken) r.telegramToken = await resolveSecretValue(r.telegramToken, secrets);
  if (r.discordToken) r.discordToken = await resolveSecretValue(r.discordToken, secrets);
  if (r.slackBotToken) r.slackBotToken = await resolveSecretValue(r.slackBotToken, secrets);
  if (r.slackAppToken) r.slackAppToken = await resolveSecretValue(r.slackAppToken, secrets);
  if (r.slackSigningSecret)
    r.slackSigningSecret = await resolveSecretValue(r.slackSigningSecret, secrets);
  if (r.emailPassword) r.emailPassword = await resolveSecretValue(r.emailPassword, secrets);
  if (r.providers) {
    r.providers = await Promise.all(
      r.providers.map(async (p) => ({
        ...p,
        apiKey: await resolveSecretValue(p.apiKey, secrets),
      })),
    );
  }
  if (r.telegram?.bots) {
    r.telegram = {
      ...r.telegram,
      bots: await Promise.all(
        r.telegram.bots.map(async (bot) => ({
          ...bot,
          token: await resolveSecretValue(bot.token, secrets),
          ...(bot.webhookSecretToken !== undefined
            ? { webhookSecretToken: await resolveSecretValue(bot.webhookSecretToken, secrets) }
            : {}),
        })),
      ),
    };
  }
  if (r.slack?.apps) {
    r.slack = {
      ...r.slack,
      apps: await Promise.all(
        r.slack.apps.map(async (app) => ({
          ...app,
          botToken: await resolveSecretValue(app.botToken, secrets),
          // `appToken` is optional now (HTTP-mode apps have none), so it is
          // only resolved when present.
          ...(app.appToken !== undefined
            ? { appToken: await resolveSecretValue(app.appToken, secrets) }
            : {}),
          signingSecret: await resolveSecretValue(app.signingSecret, secrets),
        })),
      ),
    };
  }
  if (r.auxiliary?.compression?.apiKey) {
    r.auxiliary = {
      ...r.auxiliary,
      compression: {
        ...r.auxiliary.compression,
        apiKey: await resolveSecretValue(r.auxiliary.compression.apiKey, secrets),
      },
    };
  }
  if (r.auxiliary?.vision?.apiKey) {
    r.auxiliary = {
      ...r.auxiliary,
      vision: {
        ...r.auxiliary.vision,
        apiKey: await resolveSecretValue(r.auxiliary.vision.apiKey, secrets),
      },
    };
  }
  if (r.auxiliary?.web?.apiKey) {
    r.auxiliary = {
      ...r.auxiliary,
      web: {
        ...r.auxiliary.web,
        apiKey: await resolveSecretValue(r.auxiliary.web.apiKey, secrets),
      },
    };
  }
  if (r.auxiliary?.asr?.apiKey) {
    r.auxiliary = {
      ...r.auxiliary,
      asr: {
        ...r.auxiliary.asr,
        apiKey: await resolveSecretValue(r.auxiliary.asr.apiKey, secrets),
      },
    };
  }
  if (r.auxiliary?.tts?.apiKey) {
    r.auxiliary = {
      ...r.auxiliary,
      tts: {
        ...r.auxiliary.tts,
        apiKey: await resolveSecretValue(r.auxiliary.tts.apiKey, secrets),
      },
    };
  }
  if (r.voice?.livekit) {
    r.voice = {
      ...r.voice,
      livekit: {
        ...r.voice.livekit,
        apiKey: await resolveSecretValue(r.voice.livekit.apiKey, secrets),
        apiSecret: await resolveSecretValue(r.voice.livekit.apiSecret, secrets),
      },
    };
  }
  if (r.voice?.trunk) {
    const trunk = r.voice.trunk;
    r.voice = {
      ...r.voice,
      trunk: {
        ...trunk,
        ...(trunk.password ? { password: await resolveSecretValue(trunk.password, secrets) } : {}),
        ...(trunk.webhookSecret
          ? { webhookSecret: await resolveSecretValue(trunk.webhookSecret, secrets) }
          : {}),
      },
    };
  }
  const resolveRoster = async <E extends { apiKey?: string }>(
    roster: Record<string, E>,
  ): Promise<Record<string, E>> => {
    const out: Record<string, E> = {};
    for (const [name, entry] of Object.entries(roster)) {
      out[name] = entry.apiKey
        ? { ...entry, apiKey: await resolveSecretValue(entry.apiKey, secrets) }
        : entry;
    }
    return out;
  };
  if (r.voice?.tts?.providers) {
    r.voice = { ...r.voice, tts: { providers: await resolveRoster(r.voice.tts.providers) } };
  }
  if (r.voice?.stt?.providers) {
    r.voice = { ...r.voice, stt: { providers: await resolveRoster(r.voice.stt.providers) } };
  }
  if (r.voice?.realtime?.providers) {
    r.voice = {
      ...r.voice,
      realtime: {
        ...r.voice.realtime,
        providers: await resolveRoster(r.voice.realtime.providers),
      },
    };
  }
  if (r.webhooks) {
    const hooks: Record<string, WebhookHookConfig> = {};
    for (const [id, hook] of Object.entries(r.webhooks)) {
      hooks[id] = {
        ...hook,
        secret: await resolveSecretValue(hook.secret, secrets),
        ...(hook.hmac
          ? {
              hmac: {
                ...hook.hmac,
                secret: await resolveSecretValue(hook.hmac.secret, secrets),
                ...(hook.hmac.previousSecret
                  ? { previousSecret: await resolveSecretValue(hook.hmac.previousSecret, secrets) }
                  : {}),
              },
            }
          : {}),
      };
    }
    r.webhooks = hooks;
  }
  if (r.telemetry?.export?.langfuse?.secretKey) {
    const lf = r.telemetry.export.langfuse;
    const secretKey = r.telemetry.export.langfuse.secretKey;
    r.telemetry = {
      ...r.telemetry,
      export: {
        ...r.telemetry.export,
        langfuse: { ...lf, secretKey: await resolveSecretValue(secretKey, secrets) },
      },
    };
  }
  if (r.memoryCapture?.apiKey) {
    r.memoryCapture = {
      ...r.memoryCapture,
      apiKey: await resolveSecretValue(r.memoryCapture.apiKey, secrets),
    };
  }
  if (r.pauseLifecycle?.http?.token) {
    const http = r.pauseLifecycle.http;
    const token = r.pauseLifecycle.http.token;
    r.pauseLifecycle = {
      ...r.pauseLifecycle,
      http: { ...http, token: await resolveSecretValue(token, secrets) },
    };
  }
  return r;
}

/** Accepted `logs.level` values, ordered by severity. Mirrors `LogLevel`. */
const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function parseConfigYaml(src: string): EthosConfig {
  const kv: Record<string, string> = {};
  const modelRouting: Record<string, string> = {};
  const toolSettings: ToolSettingsMap = {};
  const activeContextKv: Record<string, string> = {};
  const providersKv: Record<number, Record<string, string>> = {};
  const retentionKv: Record<string, string> = {};
  const personalitiesRetKv: Record<string, Record<string, string>> = {};
  const displayKv: Record<string, string> = {};
  const evolverKv: Record<string, string> = {};
  const backgroundKv: Record<string, string> = {};
  /** `background.acp.agents.<name>.<field>` — the named ACP-agent roster (T4/I3). */
  const backgroundAcpAgentsKv: Record<string, Record<string, string>> = {};
  // The `cron:` section: `fireUrl` / `maxParallelJobs`, plus the deprecated
  // `trigger.<field>` / `arming.<field>` keys, which are stored under their
  // combined `subsection.field` name.
  const cronKv: Record<string, string> = {};
  const auxiliaryCompressionKv: Record<string, string> = {};
  const auxiliaryVisionKv: Record<string, string> = {};
  const auxiliaryWebKv: Record<string, string> = {};
  const auxiliaryAsrKv: Record<string, string> = {};
  const auxiliaryTtsKv: Record<string, string> = {};
  const webKv: Record<string, string> = {};
  const modelCatalogKv: Record<string, string> = {};
  const modelCatalogProvidersKv: Record<string, Record<string, string>> = {};
  // §7 — models.<providerId>/<modelId>.<field>: <value>. Keyed by the full
  // `<providerId>/<modelId>` string; field path → raw value.
  const modelsKv: Record<string, Record<string, string>> = {};
  // §5 — global compaction.<field>: <value> (pressure | target | ...flags).
  const compactionKv: Record<string, string> = {};
  // memory.charLimits.<memory|user>: <chars> — markdown-backend per-key ceilings.
  const memoryCharLimitsKv: Record<string, string> = {};
  // execution.docker.<cpu|diskMb>: <value> — container resource caps.
  const executionDockerKv: Record<string, string> = {};
  // kanban.<maxInProgress|maxInProgressPerProfile>: <n> — board WIP caps.
  const kanbanKv: Record<string, string> = {};
  // toolLoop.<field>: <n> — soft-warn tiers under the loop's hard tool caps.
  const toolLoopKv: Record<string, string> = {};
  // browser.<navigationTimeoutMs|commandTimeoutMs>: <ms> — Playwright budgets.
  const browserKv: Record<string, string> = {};
  // gateway.<field>: <value> — gateway-wide, non-credential knobs.
  const gatewayKv: Record<string, string> = {};
  // teamSupervisor.restartLoopGuard.<field>: <n> — member auto-restart brake.
  // Unset = 5 respawns in 60s (one more than the old hardcoded four).
  const restartLoopGuardKv: Record<string, string> = {};
  // discord.missedMessageBackfill.<field>: <value> — channel-history backfill.
  const discordBackfillKv: Record<string, string> = {};
  // Call-capture personality binding (decision 3) — callCapture.personalityId: <id>.
  const callCaptureKv: Record<string, string> = {};
  // Phase 3 — memoryConsolidation.<field>: <value> (silent flush config).
  const memoryConsolidationKv: Record<string, string> = {};
  // Scale-to-zero idle watcher — idleWatcher.<field>: <value>.
  const idleWatcherKv: Record<string, string> = {};
  // Resume-side clock correction — pauseClockCorrection.<field>: <value>.
  const pauseClockCorrectionKv: Record<string, string> = {};
  // Pause/resume lifecycle notifications — pauseLifecycle.http.<field>: <value>.
  const pauseLifecycleHttpKv: Record<string, string> = {};
  const logsRotationKv: Record<string, string> = {};
  const awsSecretsKv: Record<string, string> = {};
  const telemetryLangfuseKv: Record<string, string> = {};
  // Indexed list shapes: telegram.bots.<n>.<field> and slack.apps.<n>.<field>,
  // plus their nested `.bind.<field>` sub-keys. Per-team config keyed by name.
  const telegramBotsKv: Record<number, Record<string, string>> = {};
  const slackAppsKv: Record<number, Record<string, string>> = {};
  const whatsappKv: Record<number, Record<string, string>> = {};
  const voiceBotsKv: Record<number, Record<string, string>> = {};
  const voiceLiveKitKv: Record<string, string> = {};
  const voiceTrunkKv: Record<string, string> = {};
  /** `voice.inbound.<field>` — the scalar inbound-call policy knobs. */
  const voiceInboundKv: Record<string, string> = {};
  /** `voice.inbound.owner.<field>` — the notification destination, one level down. */
  const voiceInboundOwnerKv: Record<string, string> = {};
  /** `voice.bargeIn.<surface>.<field>` — VAD thresholds, keyed by surface. */
  const voiceBargeInKv: Record<string, Record<string, string>> = {};
  /** `voice.filler.<field>` — the tool-call filler/tick knobs, range-checked on the way in. */
  const voiceFillerKv: {
    enabled?: boolean;
    afterMs?: number;
    text?: string;
    tickIntervalMs?: number;
  } = {};
  /** `voice.tts.providers.<name>.<field>` — the named TTS roster, keyed by name. */
  const voiceTtsProvidersKv: Record<string, Record<string, string>> = {};
  /** The older `voice.providers.<name>.<field>` spelling, merged under the above. */
  const voiceTtsProvidersLegacyKv: Record<string, Record<string, string>> = {};
  /** `voice.stt.providers.<name>.<field>` — the named STT roster. */
  const voiceSttProvidersKv: Record<string, Record<string, string>> = {};
  /** `voice.realtime.providers.<name>.<field>` — the named realtime roster. */
  const voiceRealtimeProvidersKv: Record<string, Record<string, string>> = {};
  /** Raw `voice.trustedPlugins` line; `undefined` = key absent = gate off. */
  let voiceTrustedPluginsRaw: string | undefined;
  /** `voice.defaultMode`; `undefined` = key absent = the built-in default. */
  let voiceDefaultMode: 'off' | 'mirror_inbound' | 'all' | undefined;
  /** `voice.tier`; `undefined` = key absent = the surface decides. */
  let voiceTier: 'pipeline' | 'realtime' | undefined;
  /** `voice.realtime.default` — names a realtime roster entry. */
  let voiceRealtimeDefault: string | undefined;
  /** `voice.realtime.sessionBudgetUsd` — USD cap on one session's accrued cost. */
  let voiceRealtimeSessionBudgetUsd: number | undefined;
  /** `voice.channels.<platform>.ttsOut` — per-channel TTS-out overrides. */
  const voiceChannelsKv: Record<string, { ttsOut?: boolean }> = {};
  /** `voice.transcode.<field>` — ffmpeg stage knobs, range-checked on the way in. */
  const voiceTranscodeKv: { ffmpegPath?: string; bitrateKbps?: number; timeout?: number } = {};
  /** `voice.artifacts.<field>` — retention bounds, range-checked on the way in. */
  const voiceArtifactsKv: { abandonAfterDays?: number; maxTotalMb?: number } = {};
  /** `voice.wake.<field>` — satellite wake knobs, range-checked on the way in. */
  const voiceWakeKv: {
    enabled?: boolean;
    engine?: 'fallback' | 'sherpa' | 'openwakeword';
    sensitivity?: number;
    confirmationFrames?: number;
    edgeStt?: boolean;
    idleTimeout?: number;
  } = {};
  /** `voice.wake.routes.<id>.<field>` — raw route fields, keyed by route id. */
  const voiceWakeRoutesKv: Record<string, Record<string, string>> = {};
  /** `voice.wake.nodes.<id>.<field>` — per-satellite overrides, keyed by node id. */
  const voiceWakeNodesKv: Record<string, Record<string, string>> = {};
  const teamsKv: Record<string, Record<string, string>> = {};
  const webhooksKv: Record<string, Record<string, string>> = {};
  // FW-16 — quick_commands.<name>.<field>: <value>
  const qcKv: Record<string, Record<string, string>> = {};
  // Context-economy Phase 1 — channel_toolsets.<platform>: <tool,list>
  const channelToolsetsKv: Record<string, string> = {};
  // Chapter 1 safety: channel_filter.<platform>.<field>: <value>
  const channelFilterKv: Record<string, Record<string, string>> = {};
  for (const line of src.split('\n')) {
    // telegram.bots.<index>.bind.<field>: <value>
    const tbind = line.match(/^telegram\.bots\.(\d+)\.bind\.(\S+):\s*(.+)$/);
    if (tbind) {
      const idx = Number(tbind[1]);
      telegramBotsKv[idx] ??= {};
      telegramBotsKv[idx][`bind.${tbind[2]}`] = tbind[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // telegram.bots.<index>.<field>: <value>
    const tbot = line.match(/^telegram\.bots\.(\d+)\.(\S+):\s*(.+)$/);
    if (tbot) {
      const idx = Number(tbot[1]);
      telegramBotsKv[idx] ??= {};
      telegramBotsKv[idx][tbot[2]] = tbot[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // slack.apps.<index>.bind.<field>: <value>
    const sbind = line.match(/^slack\.apps\.(\d+)\.bind\.(\S+):\s*(.+)$/);
    if (sbind) {
      const idx = Number(sbind[1]);
      slackAppsKv[idx] ??= {};
      slackAppsKv[idx][`bind.${sbind[2]}`] = sbind[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // slack.apps.<index>.<field>: <value>
    const sapp = line.match(/^slack\.apps\.(\d+)\.(\S+):\s*(.+)$/);
    if (sapp) {
      const idx = Number(sapp[1]);
      slackAppsKv[idx] ??= {};
      slackAppsKv[idx][sapp[2]] = sapp[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // whatsapp.<index>.bind.<field>: <value>
    const wabind = line.match(/^whatsapp\.(\d+)\.bind\.(\S+):\s*(.+)$/);
    if (wabind) {
      const idx = Number(wabind[1]);
      whatsappKv[idx] ??= {};
      whatsappKv[idx][`bind.${wabind[2]}`] = wabind[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // whatsapp.<index>.<field>: <value>
    const wa = line.match(/^whatsapp\.(\d+)\.(\S+):\s*(.+)$/);
    if (wa) {
      const idx = Number(wa[1]);
      whatsappKv[idx] ??= {};
      whatsappKv[idx][wa[2]] = wa[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // voice.bots.<index>.bind.<field>: <value>
    const vbind = line.match(/^voice\.bots\.(\d+)\.bind\.(\S+):\s*(.+)$/);
    if (vbind) {
      const idx = Number(vbind[1]);
      voiceBotsKv[idx] ??= {};
      voiceBotsKv[idx][`bind.${vbind[2]}`] = vbind[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // voice.bots.<index>.<field>: <value>
    const vbot = line.match(/^voice\.bots\.(\d+)\.(\S+):\s*(.+)$/);
    if (vbot) {
      const idx = Number(vbot[1]);
      voiceBotsKv[idx] ??= {};
      voiceBotsKv[idx][vbot[2]] = vbot[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // voice.<tts|stt|realtime>.providers.<name>.<field>: <value> — the named
    // rosters. The name is anchored to the identifier charset so the split is
    // unambiguous and the last level is a plain field, exactly the way
    // `telegram.bots.<n>.<field>` is matched. One regex serves all three rosters
    // so they cannot acquire different name rules.
    const vprov = line.match(
      /^voice\.(tts|stt|realtime)\.providers\.([A-Za-z0-9_-]+)\.(\w+):\s*(.+)$/,
    );
    if (vprov) {
      const bag =
        vprov[1] === 'stt'
          ? voiceSttProvidersKv
          : vprov[1] === 'realtime'
            ? voiceRealtimeProvidersKv
            : voiceTtsProvidersKv;
      const name = vprov[2];
      bag[name] ??= {};
      bag[name][vprov[3]] = vprov[4].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // voice.realtime.default / voice.realtime.sessionBudgetUsd. Matched AFTER
    // the roster line above, whose third level is `providers` and whose tail
    // carries dots — so this `(\w+)` can never swallow a roster key.
    const vrt = line.match(/^voice\.realtime\.(\w+):\s*(.+)$/);
    if (vrt) {
      const value = vrt[2].trim().replace(/^["']|["']$/g, '');
      if (vrt[1] === 'default') {
        voiceRealtimeDefault = value;
      } else if (vrt[1] === 'sessionBudgetUsd') {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) voiceRealtimeSessionBudgetUsd = n;
      }
      continue;
    }
    // voice.providers.<name>.<field> — the OLDER spelling of the TTS roster,
    // from before STT had one. Read-time alias only: it is merged UNDER the new
    // spelling below (so a file carrying both is decided by the key, not by
    // line order) and re-serializes as `voice.tts.providers.*`.
    const vprovLegacy = line.match(/^voice\.providers\.([A-Za-z0-9_-]+)\.(\w+):\s*(.+)$/);
    if (vprovLegacy) {
      const name = vprovLegacy[1];
      voiceTtsProvidersLegacyKv[name] ??= {};
      voiceTtsProvidersLegacyKv[name][vprovLegacy[2]] = vprovLegacy[3]
        .trim()
        .replace(/^["']|["']$/g, '');
      continue;
    }
    // voice.livekit.<field>: <value>
    const vlk = line.match(/^voice\.livekit\.(\w+):\s*(.+)$/);
    if (vlk) {
      voiceLiveKitKv[vlk[1]] = vlk[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // voice.trunk.<field>: <value>
    const vtr = line.match(/^voice\.trunk\.(\w+):\s*(.+)$/);
    if (vtr) {
      voiceTrunkKv[vtr[1]] = vtr[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // voice.inbound.owner.<field>: <value> — matched BEFORE the scalar line
    // below, which the `\w+` in its key position could not have swallowed
    // anyway; the order is what makes that safe to read rather than to prove.
    const vino = line.match(/^voice\.inbound\.owner\.(\w+):\s*(.+)$/);
    if (vino) {
      voiceInboundOwnerKv[vino[1]] = vino[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // voice.inbound.<field>: <value>
    const vin = line.match(/^voice\.inbound\.(\w+):\s*(.+)$/);
    if (vin) {
      voiceInboundKv[vin[1]] = vin[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // voice.bargeIn.<surface>.<field>: <value>. The surface is anchored to the
    // identifier charset and validated by name in the builder — an unknown
    // surface is a parse error, not a dropped line, because a threshold typed
    // against a surface nothing reads is silently no tuning at all.
    const vbi = line.match(/^voice\.bargeIn\.([A-Za-z0-9_-]+)\.(\w+):\s*(.+)$/);
    if (vbi) {
      const surface = vbi[1];
      voiceBargeInKv[surface] ??= {};
      voiceBargeInKv[surface][vbi[2]] = vbi[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // voice.filler.<field> — the tool-call keep-alive knobs. An unknown value
    // is ignored rather than clamped or thrown on, same rule as `voice.wake`.
    const vfl = line.match(/^voice\.filler\.(\w+):\s*(.+)$/);
    if (vfl) {
      const field = vfl[1];
      const value = vfl[2].trim().replace(/^["']|["']$/g, '');
      if (field === 'enabled') {
        if (value === 'true' || value === 'false') voiceFillerKv.enabled = value === 'true';
      } else if (field === 'afterMs') {
        const n = parseBoundedInt(value, 0, 60_000);
        if (n !== undefined) voiceFillerKv.afterMs = n;
      } else if (field === 'text') {
        if (value) voiceFillerKv.text = value;
      } else if (field === 'tickIntervalMs') {
        const n = parseBoundedInt(value, 0, 60_000);
        if (n !== undefined) voiceFillerKv.tickIntervalMs = n;
      }
      continue;
    }
    // voice.trustedPlugins: <comma-separated provider ids>. Declaring the key
    // AT ALL turns the local-only egress gate on, so an empty value is
    // meaningful (= trust nothing non-local) and must not collapse to absent.
    const vtp = line.match(/^voice\.trustedPlugins:\s*(.*)$/);
    if (vtp) {
      voiceTrustedPluginsRaw = vtp[1].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // voice.defaultMode: off | mirror_inbound | all — where a new lane starts.
    const vdm = line.match(/^voice\.defaultMode:\s*(.+)$/);
    if (vdm) {
      const mode = vdm[1].trim().replace(/^["']|["']$/g, '');
      if (mode === 'off' || mode === 'mirror_inbound' || mode === 'all') {
        voiceDefaultMode = mode;
      }
      continue;
    }
    // voice.tier: pipeline | realtime — the deployment's default voice engine.
    // An unknown value is ignored rather than thrown on, exactly like the mode
    // above: a typo here must not make the whole config unloadable.
    const vtier = line.match(/^voice\.tier:\s*(.+)$/);
    if (vtier) {
      const tier = vtier[1].trim().replace(/^["']|["']$/g, '');
      if (tier === 'pipeline' || tier === 'realtime') voiceTier = tier;
      continue;
    }
    // voice.channels.<platform>.ttsOut: true | false — which channels speak
    // their replies without being asked. Only the platforms in
    // VOICE_CHANNEL_PLATFORMS are accepted; an unknown id or a non-boolean is
    // dropped, so a typo cannot invent a channel entry no adapter will read.
    const vch = line.match(/^voice\.channels\.([A-Za-z0-9_-]+)\.ttsOut:\s*(.+)$/);
    if (vch) {
      const platform = vch[1];
      const value = vch[2].trim().replace(/^["']|["']$/g, '');
      if (isVoiceChannelPlatform(platform) && (value === 'true' || value === 'false')) {
        voiceChannelsKv[platform] = { ttsOut: value === 'true' };
      }
      continue;
    }
    // voice.transcode.<field> — ffmpeg stage. Out-of-range or non-numeric
    // values are ignored, same rule as the mode and tier above.
    const vtc = line.match(/^voice\.transcode\.(\w+):\s*(.+)$/);
    if (vtc) {
      const value = vtc[2].trim().replace(/^["']|["']$/g, '');
      if (vtc[1] === 'ffmpegPath') {
        if (value) voiceTranscodeKv.ffmpegPath = value;
      } else if (vtc[1] === 'bitrateKbps') {
        const n = parseBoundedInt(value, 8, 320);
        if (n !== undefined) voiceTranscodeKv.bitrateKbps = n;
      } else if (vtc[1] === 'timeout') {
        const n = parseBoundedInt(value, 1, 600);
        if (n !== undefined) voiceTranscodeKv.timeout = n;
      }
      continue;
    }
    // voice.artifacts.<field> — retention for synthesized voice artifacts.
    const vart = line.match(/^voice\.artifacts\.(\w+):\s*(.+)$/);
    if (vart) {
      const value = vart[2].trim().replace(/^["']|["']$/g, '');
      if (vart[1] === 'abandonAfterDays') {
        const n = parseBoundedInt(value, 1, 365);
        if (n !== undefined) voiceArtifactsKv.abandonAfterDays = n;
      } else if (vart[1] === 'maxTotalMb') {
        const n = parseBoundedInt(value, 1, 102400);
        if (n !== undefined) voiceArtifactsKv.maxTotalMb = n;
      }
      continue;
    }
    // voice.wake.routes.<id>.<field> / voice.wake.nodes.<id>.<field> — the two
    // record-valued wake sub-blocks. One regex serves both so they cannot
    // acquire different id rules, and the id is anchored to the identifier
    // charset exactly like a provider roster name: a key the serializer could
    // not round-trip is dropped here rather than corrupting the file later.
    // Matched BEFORE the scalar `voice.wake.<field>` line below.
    const vwrec = line.match(/^voice\.wake\.(routes|nodes)\.([A-Za-z0-9_-]+)\.(\w+):\s*(.+)$/);
    if (vwrec) {
      const bag = vwrec[1] === 'routes' ? voiceWakeRoutesKv : voiceWakeNodesKv;
      const id = vwrec[2];
      bag[id] ??= {};
      bag[id][vwrec[3]] = vwrec[4].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // voice.wake.<field> — the scalar satellite knobs. An unknown engine and an
    // out-of-range number are ignored rather than clamped or thrown on, same
    // rule as the mode and tier above.
    const vwk = line.match(/^voice\.wake\.(\w+):\s*(.+)$/);
    if (vwk) {
      const field = vwk[1];
      const value = vwk[2].trim().replace(/^["']|["']$/g, '');
      if (field === 'enabled') {
        if (value === 'true' || value === 'false') voiceWakeKv.enabled = value === 'true';
      } else if (field === 'edgeStt') {
        if (value === 'true' || value === 'false') voiceWakeKv.edgeStt = value === 'true';
      } else if (field === 'engine') {
        if (value === 'fallback' || value === 'sherpa' || value === 'openwakeword') {
          voiceWakeKv.engine = value;
        }
      } else if (field === 'sensitivity') {
        const n = parseBoundedFloat(value, 0, 1);
        if (n !== undefined) voiceWakeKv.sensitivity = n;
      } else if (field === 'confirmationFrames') {
        const n = parseBoundedInt(value, 1, 10);
        if (n !== undefined) voiceWakeKv.confirmationFrames = n;
      } else if (field === 'idleTimeout') {
        const n = parseBoundedInt(value, 5, 600);
        if (n !== undefined) voiceWakeKv.idleTimeout = n;
      }
      continue;
    }
    // teams.<name>.<field>: <value>
    const tcfg = line.match(/^teams\.([^.]+)\.(\S+):\s*(.+)$/);
    if (tcfg) {
      const name = tcfg[1];
      teamsKv[name] ??= {};
      teamsKv[name][tcfg[2]] = tcfg[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // webhooks.<hookId>.<field>: <value>
    const whook = line.match(/^webhooks\.([^.]+)\.(\S+):\s*(.+)$/);
    if (whook) {
      const hookId = whook[1];
      webhooksKv[hookId] ??= {};
      webhooksKv[hookId][whook[2]] = whook[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // providers.<index>.<field>: <value>
    const prov = line.match(/^providers\.(\d+)\.(\S+):\s*(.+)$/);
    if (prov) {
      const idx = Number(prov[1]);
      providersKv[idx] ??= {};
      const field = prov[2]?.trim() ?? '';
      if (field) providersKv[idx][field] = prov[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // personalities.<id>.retention.<field>: <value>  (must come before modelRouting)
    const perp = line.match(/^personalities\.([^.]+)\.retention\.(events\.)?(\w+):\s*(.+)$/);
    if (perp) {
      const pid = perp[1];
      const key = `${perp[2] ?? ''}${perp[3]}`;
      personalitiesRetKv[pid] ??= {};
      personalitiesRetKv[pid][key] = perp[4].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // retention.<field>: <value>  or  retention.events.<subfield>: <value>
    const ret = line.match(/^retention\.(events\.)?(\w+):\s*(.+)$/);
    if (ret) {
      retentionKv[`${ret[1] ?? ''}${ret[2]}`] = ret[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // display.<field>: <value>
    const disp = line.match(/^display\.([a-z_]+):\s*(.+)$/);
    if (disp) {
      displayKv[disp[1]] = disp[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // evolver.<field>: <value>
    const evlv = line.match(/^evolver\.([a-z_]+):\s*(.+)$/);
    if (evlv) {
      evolverKv[evlv[1]] = evlv[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // background.acp.agents.<name>.<field>: <value> — the named ACP-agent
    // roster. Matched BEFORE the single-level `background.<field>` line below,
    // whose `[a-z_]+` cannot swallow a dotted key anyway, but ordering mirrors
    // the voice roster's own "roster before general" discipline.
    const bacp = line.match(/^background\.acp\.agents\.([A-Za-z0-9_-]+)\.(\w+):\s*(.+)$/);
    if (bacp) {
      const name = bacp[1];
      backgroundAcpAgentsKv[name] ??= {};
      backgroundAcpAgentsKv[name][bacp[2]] = bacp[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // background.<field>: <value>
    const bg = line.match(/^background\.([a-z_]+):\s*(.+)$/);
    if (bg) {
      backgroundKv[bg[1]] = bg[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // cron.trigger.<field>: <value>  or  cron.arming.<field>: <value>
    // DEPRECATED, removed in 0.9.0. Kept only so the shim in buildCronConfig
    // can see these keys — the flat-key parser has no catch-all, so deleting
    // this branch would silently drop them instead of warning.
    const cron = line.match(/^cron\.(trigger|arming)\.([a-zA-Z]+):\s*(.+)$/);
    if (cron) {
      cronKv[`${cron[1]}.${cron[2]}`] = cron[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // cron.fireUrl: <url>  — presence is the local/external mode switch.
    const cronFire = line.match(/^cron\.fireUrl:\s*(.+)$/);
    if (cronFire) {
      cronKv.fireUrl = cronFire[1].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // cron.maxParallelJobs: <n>  (scalar sibling of cron.fireUrl)
    const cronMax = line.match(/^cron\.maxParallelJobs:\s*(.+)$/);
    if (cronMax) {
      cronKv.maxParallelJobs = cronMax[1].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // auxiliary.compression.<field>: <value>
    const auxc = line.match(/^auxiliary\.compression\.(\w+):\s*(.+)$/);
    if (auxc) {
      auxiliaryCompressionKv[auxc[1]] = auxc[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // auxiliary.vision.<field>: <value>
    const auxv = line.match(/^auxiliary\.vision\.(\w+):\s*(.+)$/);
    if (auxv) {
      auxiliaryVisionKv[auxv[1]] = auxv[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // auxiliary.web.<field>: <value>
    const auxw = line.match(/^auxiliary\.web\.(\w+):\s*(.+)$/);
    if (auxw) {
      auxiliaryWebKv[auxw[1]] = auxw[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // auxiliary.asr.<field>: <value>
    const auxAsr = line.match(/^auxiliary\.asr\.(\w+):\s*(.+)$/);
    if (auxAsr) {
      auxiliaryAsrKv[auxAsr[1]] = auxAsr[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // auxiliary.tts.<field>: <value>
    const auxTts = line.match(/^auxiliary\.tts\.(\w+):\s*(.+)$/);
    if (auxTts) {
      auxiliaryTtsKv[auxTts[1]] = auxTts[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // web.<field>: <value>
    const web = line.match(/^web\.(\w+):\s*(.+)$/);
    if (web) {
      webKv[web[1]] = web[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // logs.rotation.<field>: <value>
    const lr = line.match(/^logs\.rotation\.(\w+):\s*(.+)$/);
    if (lr) {
      logsRotationKv[lr[1]] = lr[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // logs.level: <debug|info|warn|error>
    const ll = line.match(/^logs\.level:\s*(.+)$/);
    if (ll) {
      kv['logs.level'] = ll[1].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // aws.secrets.<field>: <value>
    const awss = line.match(/^aws\.secrets\.(\w+):\s*(.+)$/);
    if (awss) {
      awsSecretsKv[awss[1]] = awss[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // telemetry.export.langfuse.<field>: <value>
    const tel = line.match(/^telemetry\.export\.langfuse\.(\w+):\s*(.+)$/);
    if (tel) {
      telemetryLangfuseKv[tel[1]] = tel[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // modelCatalog.providers.<id>.url: <value>
    const mcp = line.match(/^modelCatalog\.providers\.([^.]+)\.(\S+):\s*(.+)$/);
    if (mcp) {
      const providerId = mcp[1];
      modelCatalogProvidersKv[providerId] ??= {};
      modelCatalogProvidersKv[providerId][mcp[2]] = mcp[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // modelCatalog.<field>: <value>
    const mc = line.match(/^modelCatalog\.(\w+):\s*(.+)$/);
    if (mc) {
      modelCatalogKv[mc[1]] = mc[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // models.<providerId>/<modelId>.<field>: <value>  (§7 per-model profile).
    // The model key is greedy `.+` so ids containing `/` and `.` round-trip;
    // the trailing field is one of a fixed set, anchored so the split is
    // unambiguous.
    const mdl = line.match(
      /^models\.(.+)\.(sampling\.(?:temperature|topP|topK|minP)|toolCallFormat|maxOutputTokens):\s*(.+)$/,
    );
    if (mdl) {
      const modelKey = mdl[1];
      modelsKv[modelKey] ??= {};
      modelsKv[modelKey][mdl[2]] = mdl[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // §5 / Phase 3 — compaction.<field>: <value>  (global gate + turn-end flags).
    const cmp = line.match(
      /^compaction\.(pressure|target|gateDelta|autoCompact|retryOnOverflow|abortOnSummaryFailure|smallWindow|maxContextTokens|minTailUserMessages):\s*(.+)$/,
    );
    if (cmp) {
      compactionKv[cmp[1]] = cmp[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // Call-capture personality binding (decision 3) — callCapture.personalityId: <id>
    const ccap = line.match(/^callCapture\.personalityId:\s*(.+)$/);
    if (ccap) {
      callCaptureKv.personalityId = ccap[1].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // Phase 3 — memoryConsolidation.<field>: <value>  (silent flush config).
    const mcz = line.match(
      /^memoryConsolidation\.(enabled|flushThreshold|timeboxMs|maxTokens|maxDeltaChars|minMessagesSinceFlush):\s*(.+)$/,
    );
    if (mcz) {
      memoryConsolidationKv[mcz[1]] = mcz[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // modelRouting.<personality>: <model>
    const mr = line.match(/^modelRouting\.(\S+):\s*(.+)$/);
    if (mr) {
      modelRouting[mr[1].trim()] = mr[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // toolSettings.<personality|_default>.web_search.<provider|secret>: <value>
    const tsMatch = line.match(/^toolSettings\.([^.]+)\.web_search\.(provider|secret):\s*(.+)$/);
    if (tsMatch) {
      const id = tsMatch[1].trim();
      const field = tsMatch[2];
      const val = tsMatch[3].trim().replace(/^["']|["']$/g, '');
      const slot = toolSettings[id] ?? {};
      toolSettings[id] = slot;
      const ws = slot.web_search ?? {};
      slot.web_search = ws;
      if (field === 'provider') {
        if (val === 'exa' || val === 'tavily' || val === 'brave') ws.provider = val;
      } else {
        ws.secret = val;
      }
      continue;
    }
    // activeContext.type / activeContext.name
    const ac = line.match(/^activeContext\.(\S+):\s*(.+)$/);
    if (ac) {
      activeContextKv[ac[1].trim()] = ac[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // channel_filter.<platform>.<field>: <value>
    const cf = line.match(/^channel_filter\.([^.]+)\.(\S+):\s*(.+)$/);
    if (cf) {
      const platform = cf[1];
      channelFilterKv[platform] ??= {};
      (channelFilterKv[platform] as Record<string, string>)[cf[2]] = cf[3]
        .trim()
        .replace(/^["']|["']$/g, '');
      continue;
    }
    // quick_commands.<name>.<field>: <value>
    const qc = line.match(/^quick_commands\.([^.]+)\.(\S+):\s*(.+)$/);
    if (qc) {
      const qname = qc[1];
      qcKv[qname] ??= {};
      (qcKv[qname] as Record<string, string>)[qc[2]] = qc[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // channel_toolsets.<platform>: <comma-separated tool names>
    const ct = line.match(/^channel_toolsets\.([^.:\s]+):\s*(.+)$/);
    if (ct) {
      channelToolsetsKv[ct[1]] = ct[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // storage.<field>: <value>
    const stg = line.match(/^storage\.([\w.]+):\s*(.+)$/);
    if (stg) {
      kv[`storage.${stg[1]}`] = stg[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // plugins.auto_install: <value>
    const pai = line.match(/^plugins\.auto_install:\s*(.+)$/);
    if (pai) {
      kv['plugins.auto_install'] = pai[1].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // admin.enabled: <value>
    const adm = line.match(/^admin\.enabled:\s*(.+)$/);
    if (adm) {
      kv['admin.enabled'] = adm[1].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // a2a.enabled: <value>
    const a2a = line.match(/^a2a\.enabled:\s*(.+)$/);
    if (a2a) {
      kv['a2a.enabled'] = a2a[1].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // security.trusted_github_orgs: <org,list>
    // `(.*)` — not `(.+)` — on purpose: an empty value is a meaningful
    // configuration ("trust no org"), distinct from the key being absent.
    const sec = line.match(/^security\.trusted_github_orgs:\s*(.*)$/);
    if (sec) {
      kv['security.trusted_github_orgs'] = sec[1].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // nightlyPass.<field>: <value>
    const np = line.match(/^nightlyPass\.(\w+):\s*(.+)$/);
    if (np) {
      kv[`nightlyPass.${np[1]}`] = np[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // backup.<field>: <value>
    const bk = line.match(/^backup\.(\w+):\s*(.+)$/);
    if (bk) {
      kv[`backup.${bk[1]}`] = bk[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // weeklyDigest.<field>: <value>
    const wd = line.match(/^weeklyDigest\.(\w+):\s*(.+)$/);
    if (wd) {
      kv[`weeklyDigest.${wd[1]}`] = wd[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // toolLoop.<field>: <value>  (soft-warn tiers; the hard caps are not config)
    const tl = line.match(/^toolLoop\.(maxToolCallsWarnAt|maxIdenticalToolCallsWarnAt):\s*(.+)$/);
    if (tl) {
      toolLoopKv[tl[1]] = tl[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // kanban.<field>: <value>  (board WIP caps; distinct from kanbanPoll)
    const kb = line.match(/^kanban\.(maxInProgress|maxInProgressPerProfile):\s*(.+)$/);
    if (kb) {
      kanbanKv[kb[1]] = kb[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // kanbanPoll.<field>: <value>
    const kp = line.match(/^kanbanPoll\.(\w+):\s*(.+)$/);
    if (kp) {
      kv[`kanbanPoll.${kp[1]}`] = kp[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // idleWatcher.<field>: <value>  (scale-to-zero watcher; default OFF).
    const iw = line.match(
      /^idleWatcher\.(enabled|idleThresholdMs|startupCooldownMs|checkIntervalMs|wakePathConfirmed):\s*(.+)$/,
    );
    if (iw) {
      idleWatcherKv[iw[1]] = iw[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // pauseClockCorrection.<field>: <value>  (resume clock correction; default OFF).
    const pcc = line.match(/^pauseClockCorrection\.(enabled|thresholdMs):\s*(.+)$/);
    if (pcc) {
      pauseClockCorrectionKv[pcc[1]] = pcc[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // pauseLifecycle.http.<field>: <value>  (orchestrator idle notification; default OFF).
    const plh = line.match(/^pauseLifecycle\.http\.(url|token|timeoutMs):\s*(.+)$/);
    if (plh) {
      pauseLifecycleHttpKv[plh[1]] = plh[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // memory.charLimits.<memory|user>: <chars>  (markdown per-key ceilings).
    const mcl = line.match(/^memory\.charLimits\.(memory|user):\s*(.+)$/);
    if (mcl) {
      memoryCharLimitsKv[mcl[1]] = mcl[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // execution.docker.<cpu|diskMb>: <value>  (container resource caps).
    const exd = line.match(/^execution\.docker\.(cpu|diskMb):\s*(.+)$/);
    if (exd) {
      executionDockerKv[exd[1]] = exd[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // browser.<navigationTimeoutMs|commandTimeoutMs>: <ms>  (Playwright budgets).
    const brw = line.match(/^browser\.(navigationTimeoutMs|commandTimeoutMs):\s*(.+)$/);
    if (brw) {
      browserKv[brw[1]] = brw[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // gateway.<field>: <value>  (gateway-wide, non-credential knobs).
    const gwy = line.match(/^gateway\.(maxInboundMediaBytes):\s*(.+)$/);
    if (gwy) {
      gatewayKv[gwy[1]] = gwy[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // teamSupervisor.restartLoopGuard.<field>: <n>  (member auto-restart brake).
    const trg = line.match(
      /^teamSupervisor\.restartLoopGuard\.(maxRestarts|windowSeconds):\s*(.+)$/,
    );
    if (trg) {
      restartLoopGuardKv[trg[1]] = trg[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // discord.missedMessageBackfill.<field>: <value>  (channel-history backfill).
    const dbf = line.match(
      /^discord\.missedMessageBackfill\.(enabled|windowSeconds|limit):\s*(.+)$/,
    );
    if (dbf) {
      discordBackfillKv[dbf[1]] = dbf[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // memoryCapture.<field>: <value>
    const mcap = line.match(/^memoryCapture\.(\w+):\s*(.+)$/);
    if (mcap) {
      kv[`memoryCapture.${mcap[1]}`] = mcap[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // memoryVault.<field>: <value>
    const mvault = line.match(/^memoryVault\.(\w+):\s*(.+)$/);
    if (mvault) {
      kv[`memoryVault.${mvault[1]}`] = mvault[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // memoryApproval.<field>: <value>
    const mappr = line.match(/^memoryApproval\.(\w+):\s*(.+)$/);
    if (mappr) {
      kv[`memoryApproval.${mappr[1]}`] = mappr[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // memoryConsolidation.<field>: <value>
    const mcon = line.match(/^memoryConsolidation\.(\w+):\s*(.+)$/);
    if (mcon) {
      kv[`memoryConsolidation.${mcon[1]}`] = mcon[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) kv[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  }

  const activeContextType = activeContextKv.type;
  const activeContextName = activeContextKv.name;
  const activeContext: ActiveContext | undefined =
    (activeContextType === 'personality' || activeContextType === 'team') && activeContextName
      ? { type: activeContextType, name: activeContextName }
      : undefined;

  const sortedProviderIdxs = Object.keys(providersKv)
    .map(Number)
    .sort((a, b) => a - b);
  const providers: ProviderConfig[] = sortedProviderIdxs
    .map((i): ProviderConfig | null => {
      const p = providersKv[i];
      if (!p?.provider) return null;
      return {
        provider: p.provider,
        apiKey: p.apiKey ?? '',
        model: p.model,
        baseUrl: p.baseUrl,
        apiVersion: p.apiVersion,
        region: p.region,
        awsProfile: p.awsProfile,
      };
    })
    .filter((p): p is ProviderConfig => p !== null);

  const retention = buildRetentionConfig(retentionKv);
  const personalitiesConfig = buildPersonalitiesConfig(personalitiesRetKv);
  const auxiliaryCompression: AuxiliaryCompressionConfig | undefined = auxiliaryCompressionKv.model
    ? {
        model: auxiliaryCompressionKv.model,
        ...(auxiliaryCompressionKv.provider ? { provider: auxiliaryCompressionKv.provider } : {}),
        ...(auxiliaryCompressionKv.apiKey ? { apiKey: auxiliaryCompressionKv.apiKey } : {}),
        ...(auxiliaryCompressionKv.baseUrl ? { baseUrl: auxiliaryCompressionKv.baseUrl } : {}),
      }
    : undefined;
  const auxiliaryVision: AuxiliaryVisionConfig | undefined = auxiliaryVisionKv.model
    ? {
        model: auxiliaryVisionKv.model,
        ...(auxiliaryVisionKv.provider ? { provider: auxiliaryVisionKv.provider } : {}),
        ...(auxiliaryVisionKv.apiKey ? { apiKey: auxiliaryVisionKv.apiKey } : {}),
        ...(auxiliaryVisionKv.baseUrl ? { baseUrl: auxiliaryVisionKv.baseUrl } : {}),
      }
    : undefined;
  const auxiliaryWeb: AuxiliaryWebConfig | undefined = auxiliaryWebKv.model
    ? {
        model: auxiliaryWebKv.model,
        ...(auxiliaryWebKv.provider ? { provider: auxiliaryWebKv.provider } : {}),
        ...(auxiliaryWebKv.apiKey ? { apiKey: auxiliaryWebKv.apiKey } : {}),
        ...(auxiliaryWebKv.baseUrl ? { baseUrl: auxiliaryWebKv.baseUrl } : {}),
      }
    : undefined;
  // The default entries go through the SAME builder as their rosters, so a
  // field the default supports is a field the roster supports. The timeout
  // shim wraps the two DEFAULT entries here rather than living inside the
  // builder, because the builder also builds roster entries — whose `timeout`
  // was always seconds on every surface and must not be rewritten.
  const auxTimeoutWarnings: string[] = [];
  const auxiliaryAsr = normalizeAuxEntryTimeout(
    buildVoiceProviderEntry<SttProviderEntry>(auxiliaryAsrKv, STT_ENTRY_FIELDS),
    'auxiliary.asr.timeout',
    auxTimeoutWarnings,
  );
  const auxiliaryTts = normalizeAuxEntryTimeout(
    buildVoiceProviderEntry<TtsProviderEntry>(auxiliaryTtsKv, TTS_ENTRY_FIELDS),
    'auxiliary.tts.timeout',
    auxTimeoutWarnings,
  );
  const webPort = webKv.port ? parseBoundedInt(webKv.port, 1, 65535) : undefined;
  const webConfig: WebConfig | undefined =
    webKv.search_backend ||
    webKv.extract_backend ||
    webKv.host ||
    webPort !== undefined ||
    webKv.corsOrigins
      ? {
          ...(webKv.search_backend === 'exa' ||
          webKv.search_backend === 'tavily' ||
          webKv.search_backend === 'brave'
            ? { search_backend: webKv.search_backend }
            : {}),
          ...(webKv.extract_backend === 'htmltext'
            ? { extract_backend: webKv.extract_backend }
            : {}),
          ...(webKv.host ? { host: webKv.host } : {}),
          ...(webPort !== undefined ? { port: webPort } : {}),
          ...(webKv.corsOrigins ? { corsOrigins: webKv.corsOrigins } : {}),
        }
      : undefined;
  const modelCatalogProviders: Record<string, { url: string }> | undefined =
    Object.keys(modelCatalogProvidersKv).length > 0
      ? Object.fromEntries(
          Object.entries(modelCatalogProvidersKv)
            .filter(([, v]) => v.url)
            .map(([id, v]) => [id, { url: v.url }]),
        )
      : undefined;
  const modelCatalogEnabled: boolean | undefined =
    modelCatalogKv.enabled === 'true'
      ? true
      : modelCatalogKv.enabled === 'false'
        ? false
        : undefined;
  const modelCatalog: ModelCatalogConfig | undefined =
    Object.keys(modelCatalogKv).length > 0 || modelCatalogProviders
      ? {
          ...(modelCatalogEnabled !== undefined ? { enabled: modelCatalogEnabled } : {}),
          ...(modelCatalogKv.url ? { url: modelCatalogKv.url } : {}),
          ...(modelCatalogKv.ttlHours ? { ttlHours: Number(modelCatalogKv.ttlHours) } : {}),
          ...(modelCatalogProviders ? { providers: modelCatalogProviders } : {}),
        }
      : undefined;
  const models = buildModelProfiles(modelsKv);
  const compaction = buildCompaction(compactionKv);
  const memoryCharLimits = buildMemoryCharLimits(memoryCharLimitsKv);
  const execution = buildExecutionConfig(executionDockerKv);
  const restartLoopGuard = buildRestartLoopGuard(restartLoopGuardKv);
  const discordBackfill = buildDiscordBackfill(discordBackfillKv);
  const callCapture = callCaptureKv.personalityId
    ? { personalityId: callCaptureKv.personalityId }
    : undefined;
  const memoryConsolidation = buildMemoryConsolidation(memoryConsolidationKv);
  const idleWatcher = buildIdleWatcher(idleWatcherKv);
  const pauseClockCorrection = buildPauseClockCorrection(pauseClockCorrectionKv);
  // ETHOS_ORCHESTRATOR_URL / ETHOS_ORCHESTRATOR_TOKEN win over the yaml value,
  // same precedence as ETHOS_PUBLIC_URL over webBaseUrl below.
  const pauseLifecycleHttpBuilt = buildPauseLifecycleHttp(pauseLifecycleHttpKv);
  const pauseLifecycleHttpUrl = process.env.ETHOS_ORCHESTRATOR_URL ?? pauseLifecycleHttpBuilt?.url;
  const pauseLifecycleHttpToken =
    process.env.ETHOS_ORCHESTRATOR_TOKEN ?? pauseLifecycleHttpBuilt?.token;
  const pauseLifecycleHttp =
    pauseLifecycleHttpBuilt ||
    pauseLifecycleHttpUrl !== undefined ||
    pauseLifecycleHttpToken !== undefined
      ? {
          ...pauseLifecycleHttpBuilt,
          ...(pauseLifecycleHttpUrl !== undefined ? { url: pauseLifecycleHttpUrl } : {}),
          ...(pauseLifecycleHttpToken !== undefined ? { token: pauseLifecycleHttpToken } : {}),
        }
      : undefined;
  // ETHOS_CRON_FIRE_URL wins over the yaml value, same precedence as
  // ETHOS_ORCHESTRATOR_URL over the pauseLifecycle url above. Deliberately NOT
  // derived from ETHOS_PUBLIC_URL (N2): a public URL answers "what is this
  // process's address", this answers "should this process stop running its own
  // clock", and plenty of deployments want the first without the second.
  const cronDeprecations: string[] = [];
  const cronBuilt = buildCronConfig(cronKv, cronDeprecations);
  const cronFireUrl = process.env.ETHOS_CRON_FIRE_URL ?? cronBuilt?.fireUrl;
  const cron =
    cronBuilt || cronFireUrl !== undefined
      ? {
          ...cronBuilt,
          ...(cronFireUrl !== undefined ? { fireUrl: cronFireUrl } : {}),
        }
      : undefined;
  const parsedMaxBytes = logsRotationKv.maxBytes ? Number(logsRotationKv.maxBytes) : undefined;
  const parsedMaxFiles = logsRotationKv.maxFiles ? Number(logsRotationKv.maxFiles) : undefined;
  const logsRotation =
    Object.keys(logsRotationKv).length > 0
      ? {
          ...(parsedMaxBytes && Number.isFinite(parsedMaxBytes) && parsedMaxBytes > 0
            ? { maxBytes: Math.floor(parsedMaxBytes) }
            : {}),
          ...(parsedMaxFiles && Number.isFinite(parsedMaxFiles) && parsedMaxFiles > 0
            ? { maxFiles: Math.floor(parsedMaxFiles) }
            : {}),
          ...(logsRotationKv.enabled !== undefined
            ? { enabled: logsRotationKv.enabled !== 'false' }
            : {}),
        }
      : undefined;
  // An unrecognised level is dropped rather than defaulted, so a typo never
  // silences output that was printing before.
  const rawLogLevel = kv['logs.level'];
  const logsLevel = LOG_LEVELS.find((l) => l === rawLogLevel);
  const awsSecrets: AwsSecretsConfig | undefined =
    Object.keys(awsSecretsKv).length > 0
      ? {
          ...(awsSecretsKv.enabled === 'true'
            ? { enabled: true }
            : awsSecretsKv.enabled === 'false'
              ? { enabled: false }
              : {}),
          ...(awsSecretsKv.region ? { region: awsSecretsKv.region } : {}),
          ...(awsSecretsKv.prefix ? { prefix: awsSecretsKv.prefix } : {}),
          ...(awsSecretsKv.endpoint ? { endpoint: awsSecretsKv.endpoint } : {}),
        }
      : undefined;
  const awsConfig: AwsConfig | undefined = awsSecrets ? { secrets: awsSecrets } : undefined;
  const telemetryLangfuse: TelemetryLangfuseExportConfig | undefined =
    Object.keys(telemetryLangfuseKv).length > 0
      ? {
          ...(telemetryLangfuseKv.enabled === 'true'
            ? { enabled: true }
            : telemetryLangfuseKv.enabled === 'false'
              ? { enabled: false }
              : {}),
          ...(telemetryLangfuseKv.baseUrl ? { baseUrl: telemetryLangfuseKv.baseUrl } : {}),
          ...(telemetryLangfuseKv.publicKey ? { publicKey: telemetryLangfuseKv.publicKey } : {}),
          ...(telemetryLangfuseKv.secretKey ? { secretKey: telemetryLangfuseKv.secretKey } : {}),
        }
      : undefined;
  const telemetryConfig: TelemetryConfig | undefined = telemetryLangfuse
    ? { export: { langfuse: telemetryLangfuse } }
    : undefined;
  const telegramResult = buildTelegramBots(telegramBotsKv);
  const slackResult = buildSlackApps(slackAppsKv);
  const whatsappResult = buildWhatsApps(whatsappKv);
  const voiceResult = buildVoiceBots(voiceBotsKv);
  const voiceLiveKitResult = buildVoiceLiveKit(voiceLiveKitKv);
  const voiceTrunkResult = buildVoiceTrunk(voiceTrunkKv);
  const voiceInboundResult = buildVoiceInbound(voiceInboundKv, voiceInboundOwnerKv);
  const voiceBargeInResult = buildVoiceBargeIn(voiceBargeInKv);
  const voiceFiller = Object.keys(voiceFillerKv).length > 0 ? voiceFillerKv : undefined;
  // Legacy `voice.providers.*` entries merge UNDER the new spelling, per name
  // and per field, so a file mid-migration keeps whichever fields it has
  // already moved and the new key always wins.
  const mergedTtsProvidersKv: Record<string, Record<string, string>> = {};
  for (const [name, fields] of Object.entries(voiceTtsProvidersLegacyKv)) {
    mergedTtsProvidersKv[name] = { ...fields };
  }
  for (const [name, fields] of Object.entries(voiceTtsProvidersKv)) {
    mergedTtsProvidersKv[name] = { ...mergedTtsProvidersKv[name], ...fields };
  }
  const voiceTtsProviders = buildVoiceProviderRoster<TtsProviderEntry>(
    mergedTtsProvidersKv,
    TTS_ENTRY_FIELDS,
  );
  const voiceSttProviders = buildVoiceProviderRoster<SttProviderEntry>(
    voiceSttProvidersKv,
    STT_ENTRY_FIELDS,
  );
  const voiceRealtimeProviders = buildVoiceProviderRoster<RealtimeProviderEntry>(
    voiceRealtimeProvidersKv,
    REALTIME_ENTRY_FIELDS,
  );
  // `default` and `sessionBudgetUsd` stand on their own: a deployment can name a
  // default (or cap a session) before its roster is typed in, and losing the cap
  // because the roster is momentarily empty would be the wrong way round.
  const voiceRealtime =
    voiceRealtimeProviders !== undefined ||
    voiceRealtimeDefault !== undefined ||
    voiceRealtimeSessionBudgetUsd !== undefined
      ? {
          ...(voiceRealtimeProviders ? { providers: voiceRealtimeProviders } : {}),
          ...(voiceRealtimeDefault ? { default: voiceRealtimeDefault } : {}),
          ...(voiceRealtimeSessionBudgetUsd !== undefined
            ? { sessionBudgetUsd: voiceRealtimeSessionBudgetUsd }
            : {}),
        }
      : undefined;
  // Each of the three V2 sub-sections stands on its own: an operator can cap
  // artifact disk before naming an ffmpeg path, and vice versa.
  const voiceChannels = Object.keys(voiceChannelsKv).length > 0 ? voiceChannelsKv : undefined;
  const voiceTranscode = Object.keys(voiceTranscodeKv).length > 0 ? voiceTranscodeKv : undefined;
  const voiceArtifacts = Object.keys(voiceArtifactsKv).length > 0 ? voiceArtifactsKv : undefined;
  // The wake block stands on its own too: an operator can set the engine before
  // typing a single route, and a routes-only config is the common first edit.
  const voiceWakeRoutes = buildWakeRoutes(voiceWakeRoutesKv);
  const voiceWakeNodes = buildWakeNodes(voiceWakeNodesKv);
  const voiceWake =
    Object.keys(voiceWakeKv).length > 0 ||
    voiceWakeRoutes !== undefined ||
    voiceWakeNodes !== undefined
      ? {
          ...voiceWakeKv,
          ...(voiceWakeRoutes ? { routes: voiceWakeRoutes } : {}),
          ...(voiceWakeNodes ? { nodes: voiceWakeNodes } : {}),
        }
      : undefined;
  const voiceSection =
    voiceResult.bots.length > 0 ||
    voiceLiveKitResult.livekit ||
    voiceTrunkResult.trunk ||
    voiceInboundResult.inbound ||
    voiceBargeInResult.bargeIn ||
    voiceFiller !== undefined ||
    voiceTrustedPluginsRaw !== undefined ||
    voiceDefaultMode !== undefined ||
    voiceTier !== undefined ||
    voiceTtsProviders !== undefined ||
    voiceSttProviders !== undefined ||
    voiceRealtime !== undefined ||
    voiceChannels !== undefined ||
    voiceTranscode !== undefined ||
    voiceArtifacts !== undefined ||
    voiceWake !== undefined
      ? {
          bots: voiceResult.bots,
          ...(voiceLiveKitResult.livekit ? { livekit: voiceLiveKitResult.livekit } : {}),
          ...(voiceTrunkResult.trunk ? { trunk: voiceTrunkResult.trunk } : {}),
          ...(voiceInboundResult.inbound ? { inbound: voiceInboundResult.inbound } : {}),
          ...(voiceBargeInResult.bargeIn ? { bargeIn: voiceBargeInResult.bargeIn } : {}),
          ...(voiceFiller ? { filler: voiceFiller } : {}),
          ...(voiceTrustedPluginsRaw !== undefined
            ? { trustedPlugins: splitList(voiceTrustedPluginsRaw) }
            : {}),
          ...(voiceDefaultMode ? { defaultMode: voiceDefaultMode } : {}),
          ...(voiceTier ? { tier: voiceTier } : {}),
          ...(voiceTtsProviders ? { tts: { providers: voiceTtsProviders } } : {}),
          ...(voiceSttProviders ? { stt: { providers: voiceSttProviders } } : {}),
          ...(voiceRealtime ? { realtime: voiceRealtime } : {}),
          ...(voiceChannels ? { channels: voiceChannels } : {}),
          ...(voiceTranscode ? { transcode: voiceTranscode } : {}),
          ...(voiceArtifacts ? { artifacts: voiceArtifacts } : {}),
          ...(voiceWake ? { wake: voiceWake } : {}),
        }
      : undefined;
  const teams = buildTeamsConfig(teamsKv);
  const webhooksResult = buildWebhooks(webhooksKv);
  const quick_commands = buildQuickCommands(qcKv);
  const channelToolsets = buildChannelToolsets(channelToolsetsKv);
  const channelFilter = buildChannelFilter(channelFilterKv);
  const parseErrors = [
    ...telegramResult.errors,
    ...slackResult.errors,
    ...whatsappResult.errors,
    ...voiceResult.errors,
    ...voiceLiveKitResult.errors,
    ...voiceTrunkResult.errors,
    ...voiceInboundResult.errors,
    ...voiceBargeInResult.errors,
    ...webhooksResult.errors,
  ];

  const pluginsAutoInstall: boolean | undefined =
    kv['plugins.auto_install'] === 'true'
      ? true
      : kv['plugins.auto_install'] === 'false'
        ? false
        : undefined;
  const parsedSchemaVersion = kv.schemaVersion ? Number(kv.schemaVersion) : undefined;
  const config: EthosConfig = {
    schemaVersion: Number.isFinite(parsedSchemaVersion) ? parsedSchemaVersion : undefined,
    provider: kv.provider ?? 'anthropic',
    model: kv.model ?? 'claude-opus-4-7',
    apiKey: kv.apiKey ?? '',
    personality: kv.personality ?? 'researcher',
    memory:
      kv.memory === 'vector'
        ? 'vector'
        : kv.memory === 'vault'
          ? 'vault'
          : kv.memory === 'markdown'
            ? 'markdown'
            : undefined,
    baseUrl: kv.baseUrl,
    apiVersion: kv.apiVersion,
    region: kv.region,
    awsProfile: kv.awsProfile,
    // Lane 0 (D4) — a window is a positive integer token count; anything else
    // (zero, negative, non-numeric) is dropped so a typo cannot poison the
    // provider's maxContextTokens.
    contextWindow: (() => {
      if (kv.contextWindow === undefined) return undefined;
      const n = Number(kv.contextWindow);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
    })(),
    // Lane 2a — only the two known values are accepted; anything else is
    // dropped so a typo cannot silently change the wire format.
    toolOrder:
      kv.toolOrder === 'insertion' ? 'insertion' : kv.toolOrder === 'stable' ? 'stable' : undefined,
    // Lane 4a(d) — a deadline is a positive integer millisecond count; a retry
    // count is a non-negative integer. Anything else is dropped so a typo
    // cannot silently change the client's request behavior.
    requestTimeoutMs: (() => {
      if (kv.requestTimeoutMs === undefined) return undefined;
      const n = Number(kv.requestTimeoutMs);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
    })(),
    // An approval SLA is a non-negative integer millisecond count. Unlike
    // `requestTimeoutMs`, `0` is MEANINGFUL here ("no timeout, wait forever")
    // rather than a typo — only negatives and non-numbers are dropped.
    approvalTimeoutMs: (() => {
      const raw = kv.approvalTimeoutMs;
      // An empty or blank value (`approvalTimeoutMs: ""`, or a bare key with
      // trailing whitespace) is a typo, not an intentional `0` — and
      // `Number('')` is `0`, which would silently disable the auto-deny
      // backstop. Treat it as absent so the store default applies.
      if (raw === undefined || raw.trim() === '') return undefined;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
    })(),
    maxRetries: (() => {
      const raw = kv.maxRetries;
      // Same empty-value hazard as `approvalTimeoutMs`: `0` is meaningful
      // ("never retry"), so `Number('') === 0` would silently turn retries off
      // on a typo instead of falling through to the provider default.
      if (raw === undefined || raw.trim() === '') return undefined;
      const n = Number(raw);
      return Number.isInteger(n) && n >= 0 ? n : undefined;
    })(),
    // Lane 3(a) — a payload limit is a positive integer char count; anything
    // else is dropped so a typo cannot disable (or zero) the guard.
    toolPayloadLimitChars: (() => {
      if (kv.toolPayloadLimitChars === undefined) return undefined;
      const n = Number(kv.toolPayloadLimitChars);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
    })(),
    modelRouting: Object.keys(modelRouting).length > 0 ? modelRouting : undefined,
    toolSettings: Object.keys(toolSettings).length > 0 ? toolSettings : undefined,
    models,
    compaction,
    memoryCharLimits,
    execution,
    callCapture,
    activeContext,
    providers: providers.length > 0 ? providers : undefined,
    telegramToken: kv.telegramToken,
    discordToken: kv.discordToken,
    slackBotToken: kv.slackBotToken,
    slackAppToken: kv.slackAppToken,
    slackSigningSecret: kv.slackSigningSecret,
    emailImapHost: kv.emailImapHost,
    emailImapPort: kv.emailImapPort ? Number(kv.emailImapPort) : undefined,
    emailUser: kv.emailUser,
    emailPassword: kv.emailPassword,
    emailSmtpHost: kv.emailSmtpHost,
    emailSmtpPort: kv.emailSmtpPort ? Number(kv.emailSmtpPort) : undefined,
    verbose: kv.verbose === 'true' ? true : undefined,
    displayVerbosity: parseVerbosity(displayKv.verbosity),
    displayBusyInputMode: parseBusyMode(displayKv.busy_input_mode),
    displayToolPreviewLength: parseToolPreviewLength(displayKv.tool_preview_length),
    displayResumeHint: displayKv.resume_hint === 'false' ? false : undefined,
    displayResumeRecapTurns: (() => {
      if (displayKv.resume_recap_turns === undefined) return undefined;
      const n = parseInt(displayKv.resume_recap_turns, 10);
      return Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : undefined;
    })(),
    skin: kv.skin || undefined,
    retention,
    personalitiesConfig,
    telegram: telegramResult.bots.length > 0 ? { bots: telegramResult.bots } : undefined,
    slack: slackResult.apps.length > 0 ? { apps: slackResult.apps } : undefined,
    whatsapp: whatsappResult.apps.length > 0 ? whatsappResult.apps : undefined,
    voice: voiceSection,
    teams,
    evolverCronEnabled: evolverKv.cron_enabled === 'true' ? true : undefined,
    evolverSchedule: evolverKv.schedule || undefined,
    backgroundMaxConcurrent: backgroundKv.max_concurrent
      ? Number(backgroundKv.max_concurrent)
      : undefined,
    background: buildBackgroundConfig(backgroundKv, backgroundAcpAgentsKv),
    cron,
    displayBellOnComplete: displayKv.bell_on_complete === 'true' ? true : undefined,
    displayMemoryNotices:
      displayKv.memory_notices === 'true'
        ? true
        : displayKv.memory_notices === 'false'
          ? false
          : undefined,
    displayDebugPanel: displayKv.debug_panel === 'true' ? true : undefined,
    displayDebugPanelModel: displayKv.debug_panel_model || undefined,
    displayStreamingEdits: parseStreamingEdits(displayKv.streaming_edits),
    displayCallStyle: parseCallStyle(displayKv.call_style),
    displayCallAccent: parseCallAccent(displayKv.call_accent),
    quick_commands,
    channelToolsets,
    channelFilter,
    auxiliary:
      auxiliaryCompression || auxiliaryVision || auxiliaryWeb || auxiliaryAsr || auxiliaryTts
        ? {
            ...(auxiliaryCompression ? { compression: auxiliaryCompression } : {}),
            ...(auxiliaryVision ? { vision: auxiliaryVision } : {}),
            ...(auxiliaryWeb ? { web: auxiliaryWeb } : {}),
            ...(auxiliaryAsr ? { asr: auxiliaryAsr } : {}),
            ...(auxiliaryTts ? { tts: auxiliaryTts } : {}),
          }
        : undefined,
    web: webConfig,
    webhooks: webhooksResult.webhooks,
    modelCatalog,
    logs:
      logsRotation || logsLevel
        ? {
            ...(logsRotation ? { rotation: logsRotation } : {}),
            ...(logsLevel ? { level: logsLevel } : {}),
          }
        : undefined,
    aws: awsConfig,
    telemetry: telemetryConfig,
    webBaseUrl: process.env.ETHOS_PUBLIC_URL ?? kv.webBaseUrl ?? undefined,
    storage: buildStorageConfig(kv),
    pluginsAutoInstall,
    admin:
      kv['admin.enabled'] !== undefined ? { enabled: kv['admin.enabled'] === 'true' } : undefined,
    a2a: kv['a2a.enabled'] !== undefined ? { enabled: kv['a2a.enabled'] === 'true' } : undefined,
    // `!== undefined` — not truthiness: an empty value must survive as `[]`
    // (trust no org) instead of collapsing back to the shipped default.
    security:
      kv['security.trusted_github_orgs'] !== undefined
        ? {
            trustedGitHubOrgs: kv['security.trusted_github_orgs']
              .split(/[,\s]+/)
              .map((o) => o.trim())
              .filter((o) => o.length > 0),
          }
        : undefined,
    backup: buildBackupConfig(kv),
    nightlyPass:
      kv['nightlyPass.enabled'] !== undefined || kv['nightlyPass.cron'] !== undefined
        ? {
            ...(kv['nightlyPass.enabled'] !== undefined
              ? { enabled: kv['nightlyPass.enabled'] === 'true' }
              : {}),
            ...(kv['nightlyPass.cron'] ? { cron: kv['nightlyPass.cron'] } : {}),
          }
        : undefined,
    memoryCapture: buildMemoryCaptureConfig(kv),
    memoryVault: buildMemoryVaultConfig(kv),
    memoryApproval: buildMemoryApprovalConfig(kv),
    memoryConsolidation: (() => {
      // Union of the silent memory-flush turn (context-compaction) and the
      // decay/importance tuning (memory-experience) — disjoint field sets, one key.
      const decay = buildMemoryConsolidationConfig(kv);
      if (!memoryConsolidation && !decay) return undefined;
      return { ...memoryConsolidation, ...decay };
    })(),
    weeklyDigest:
      kv['weeklyDigest.enabled'] !== undefined ||
      kv['weeklyDigest.cron'] !== undefined ||
      kv['weeklyDigest.recipients'] !== undefined
        ? {
            ...(kv['weeklyDigest.enabled'] !== undefined
              ? { enabled: kv['weeklyDigest.enabled'] === 'true' }
              : {}),
            ...(kv['weeklyDigest.cron'] ? { cron: kv['weeklyDigest.cron'] } : {}),
            ...(kv['weeklyDigest.recipients']
              ? {
                  recipients: kv['weeklyDigest.recipients']
                    .split(/[,\s]+/)
                    .map((r) => r.trim())
                    .filter((r) => r.length > 0),
                }
              : {}),
          }
        : undefined,
    toolLoop: buildToolLoop(toolLoopKv),
    kanban: buildKanban(kanbanKv),
    browser: buildBrowser(browserKv),
    gateway: buildGateway(gatewayKv),
    teamSupervisor: restartLoopGuard ? { restartLoopGuard } : undefined,
    discord: discordBackfill ? { missedMessageBackfill: discordBackfill } : undefined,
    kanbanPoll:
      kv['kanbanPoll.enabled'] !== undefined ||
      kv['kanbanPoll.intervalMs'] !== undefined ||
      kv['kanbanPoll.boardPath'] !== undefined
        ? {
            ...(kv['kanbanPoll.enabled'] !== undefined
              ? { enabled: kv['kanbanPoll.enabled'] === 'true' }
              : {}),
            ...(kv['kanbanPoll.intervalMs']
              ? { intervalMs: Number(kv['kanbanPoll.intervalMs']) }
              : {}),
            ...(kv['kanbanPoll.boardPath'] ? { boardPath: kv['kanbanPoll.boardPath'] } : {}),
          }
        : undefined,
    idleWatcher,
    pauseClockCorrection,
    pauseLifecycle: pauseLifecycleHttp ? { http: pauseLifecycleHttp } : undefined,
  };
  // Stash parse errors so the strict loader can surface them at boot.
  // readRawConfig (used by CLI commands that don't gateway-boot) ignores them
  // and continues with whatever entries did parse.
  parseErrorsByConfig.set(config, parseErrors);
  // Cron's deprecations lead: D3(b)'s behaviour-changing case is the one an
  // operator most needs to read, and it is already first within its own group.
  parseWarningsByConfig.set(config, [...cronDeprecations, ...auxTimeoutWarnings]);
  return config;
}

// Side-table keyed by the EthosConfig object identity. Avoids polluting
// the public type with an `@internal` field that downstream code would
// have to remember to ignore.
const parseErrorsByConfig = new WeakMap<EthosConfig, string[]>();

// The NON-fatal sibling: notices the parse can emit without the config being
// wrong. Kept out of `parseErrors` because the gateway exits non-zero on any
// entry there, and a boot warning that boots nothing is worse than the thing
// it warns about.
const parseWarningsByConfig = new WeakMap<EthosConfig, string[]>();

/**
 * Parse-time notices for a config returned by {@link readRawConfig} — the read
 * side of the two side-tables, for commands that read the raw config instead of
 * going through {@link loadConfigStrict} (`ethos doctor`).
 */
export function configParseNotices(config: EthosConfig): { errors: string[]; warnings: string[] } {
  return {
    errors: parseErrorsByConfig.get(config) ?? [],
    warnings: parseWarningsByConfig.get(config) ?? [],
  };
}

/**
 * Strict loader used by the gateway boot path. Returns the parsed config
 * along with any deprecation messages — from the legacy → list-shape shim and
 * from the parse itself — AND any parse-time errors for malformed bot entries.
 * Boot prints both and exits non-zero on errors so a typo never silently boots
 * zero bots. A deprecation is never fatal; a parse error always is, which is
 * why a value the parse quietly repaired belongs in `deprecations`.
 */
export interface LoadedConfig {
  config: EthosConfig;
  parseErrors: string[];
  deprecations: string[];
}

export async function loadConfigStrict(
  storage: Storage,
  secrets?: SecretsResolver,
): Promise<LoadedConfig | null> {
  const parsed = await readRawConfig(storage);
  if (!parsed) return null;
  if (secrets) validateNoPlaintextSecrets(parsed);
  const parseErrors = parseErrorsByConfig.get(parsed) ?? [];
  const parseWarnings = parseWarningsByConfig.get(parsed) ?? [];
  const resolved = secrets ? await resolveConfigSecrets(parsed, secrets) : parsed;
  const { config, deprecations } = applyPlatformShim(resolved);
  return { config, parseErrors, deprecations: [...parseWarnings, ...deprecations] };
}

// ---------------------------------------------------------------------------
// Plaintext secret detection
// ---------------------------------------------------------------------------

/**
 * Fields whose values MUST be entirely `${secrets:ref}` references when a
 * SecretsResolver is configured. These are known credential-bearing fields
 * regardless of whether the value matches a regex pattern.
 */
const SECRET_FIELD_NAMES = new Set([
  'apiKey',
  'token',
  'botToken',
  'appToken',
  'signingSecret',
  'password',
  'webhookSecret',
  'webhookSecretToken',
  'emailPassword',
  'discordToken',
  'slackBotToken',
  'slackAppToken',
  'slackSigningSecret',
  'telegramToken',
  'secretKey',
]);

/**
 * Walk every string value in `config` (including nested objects and arrays)
 * and throw if any value looks like a plaintext secret. Called from
 * `loadConfigStrict` *before* secrets resolution, so legitimate
 * `${secrets:ref}` references are still present and are explicitly skipped.
 *
 * Two-pass check:
 * 1. **Field-name check** — if the leaf field name is in SECRET_FIELD_NAMES,
 *    the ENTIRE value must be a secrets reference.
 * 2. **Regex catch-all** — for all other fields, run `detectSecrets`.
 *
 * Skips validation entirely when no SecretsResolver is configured (local dev
 * without secrets infrastructure).
 *
 * The check is purely structural, so the parameter is any on-disk object
 * graph, not only `EthosConfig` — `writeKeys` runs the same gate over
 * `~/.ethos/keys.json`.
 */
export function validateNoPlaintextSecrets(config: object): void {
  const violations: Array<{ field: string; label: string }> = [];
  walkStringValues(config, '', (field, value) => {
    const stripped = value.replace(SECRETS_REF_RE, '');
    if (stripped.length === 0) return;

    // Extract the leaf field name, stripping trailing array indices
    const raw = field.includes('.') ? field.slice(field.lastIndexOf('.') + 1) : field;
    const leaf = raw.replace(/\[\d+\]$/, '');

    if (SECRET_FIELD_NAMES.has(leaf)) {
      // Known secret field — entire value must be a secrets reference
      if (stripped.trim().length > 0) {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal label, not a template
        violations.push({ field, label: 'secret (field requires ${secrets:ref})' });
      }
      return;
    }

    const detections = detectSecrets(stripped);
    if (detections.length > 0) {
      violations.push({ field, label: detections[0].label });
    }
  });
  if (violations.length > 0) {
    const details = violations
      .map(
        (v) =>
          `  - field '${v.field}' appears to contain a plaintext ${v.label}. ` +
          `Use \${secrets:<ref>} substitution instead.`,
      )
      .join('\n');
    throw new Error(`Config validation failed: plaintext secret(s) detected.\n${details}`);
  }
}

function walkStringValues(
  obj: unknown,
  prefix: string,
  cb: (field: string, value: string) => void,
): void {
  if (typeof obj === 'string') {
    cb(prefix, obj);
    return;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      walkStringValues(obj[i], `${prefix}[${i}]`, cb);
    }
    return;
  }
  if (obj !== null && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      walkStringValues(value, prefix ? `${prefix}.${key}` : key, cb);
    }
  }
}

function parseVerbosity(v: string | undefined): EthosConfig['displayVerbosity'] {
  return v === 'quiet' || v === 'default' || v === 'verbose' || v === 'debug' ? v : undefined;
}

function parseBusyMode(v: string | undefined): EthosConfig['displayBusyInputMode'] {
  return v === 'interrupt' || v === 'queue' || v === 'steer' ? v : undefined;
}

function parseStreamingEdits(v: string | undefined): EthosConfig['displayStreamingEdits'] {
  return v === 'off' || v === 'dms' || v === 'all' ? v : undefined;
}

function parseCallStyle(v: string | undefined): EthosConfig['displayCallStyle'] {
  return v === 'liquid' || v === 'orb' || v === 'rings' || v === 'personality' ? v : undefined;
}

/** `personality` or a 6-digit hex. Anything else is dropped, not coerced. */
function parseCallAccent(v: string | undefined): string | undefined {
  if (v === 'personality') return v;
  return v !== undefined && /^#[0-9a-fA-F]{6}$/.test(v) ? v : undefined;
}

function parseToolPreviewLength(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return undefined;
  return n;
}

/**
 * Platform ids that may carry a `voice.channels.<platform>.ttsOut` override —
 * the channels that have an adapter able to act on it. Anything else is
 * ignored on read.
 */
export const VOICE_CHANNEL_PLATFORMS = [
  'telegram',
  'slack',
  'discord',
  'whatsapp',
  'email',
] as const;

/** Exported so the RPC boundary (web-api's ConfigService) can REFUSE a platform
 *  id this parser would silently drop, rather than keeping a second list. */
export function isVoiceChannelPlatform(v: string): boolean {
  return (VOICE_CHANNEL_PLATFORMS as readonly string[]).includes(v);
}

/** An integer inside [min, max], or `undefined` — never a clamped near-miss. */
function parseBoundedInt(v: string, min: number, max: number): number | undefined {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

/**
 * A finite number inside [min, max], or `undefined` — the float sibling of
 * `parseBoundedInt`, for the one wake bound (`sensitivity`) that is a fraction
 * rather than a count. Same contract: never a clamped near-miss.
 */
function parseBoundedFloat(v: string, min: number, max: number): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

/**
 * `voice.wake.routes.<id>` — phrase → personality.
 *
 * A route missing `phrase` OR `personality` is DROPPED entirely rather than
 * half-built: a phrase-less route can never fire and a personality-less one
 * would wake nothing, so keeping the remnant would hide the typo behind an
 * entry that looks configured in the Settings UI.
 */
function buildWakeRoutes(
  kv: Record<string, Record<string, string>>,
): Record<string, WakeRouteConfig> | undefined {
  const out: Record<string, WakeRouteConfig> = {};
  for (const [id, fields] of Object.entries(kv)) {
    const phrase = fields.phrase;
    const personality = fields.personality;
    if (!phrase || !personality) continue;
    // `privileged` and `enabled` stay ABSENT unless written: the consumer must
    // be able to tell "operator said no" from "operator never said".
    out[id] = {
      phrase,
      personality,
      ...(fields.privileged === 'true'
        ? { privileged: true }
        : fields.privileged === 'false'
          ? { privileged: false }
          : {}),
      ...(fields.enabled === 'true'
        ? { enabled: true }
        : fields.enabled === 'false'
          ? { enabled: false }
          : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `voice.wake.nodes.<id>` — per-satellite overrides. An entry with no
 *  recognised field is dropped rather than kept as an empty object. */
function buildWakeNodes(
  kv: Record<string, Record<string, string>>,
): Record<string, { inputDevice?: string; enabled?: boolean }> | undefined {
  const out: Record<string, { inputDevice?: string; enabled?: boolean }> = {};
  for (const [id, fields] of Object.entries(kv)) {
    const entry = {
      ...(fields.inputDevice ? { inputDevice: fields.inputDevice } : {}),
      ...(fields.enabled === 'true'
        ? { enabled: true }
        : fields.enabled === 'false'
          ? { enabled: false }
          : {}),
    };
    if (Object.keys(entry).length > 0) out[id] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function isAudioFormat(v: string | undefined): v is 'opus' | 'mp3' | 'wav' | 'pcm' {
  return v === 'opus' || v === 'mp3' || v === 'wav' || v === 'pcm';
}

// ---------------------------------------------------------------------------
// Voice provider entries — ONE builder and ONE serializer, parameterised by
// field set.
//
// There are five places an entry shape is read or written: the default TTS
// entry (`auxiliary.tts`), the TTS roster (`voice.tts.providers.<name>`), the
// default STT entry (`auxiliary.asr`), the STT roster
// (`voice.stt.providers.<name>`), and the realtime roster
// (`voice.realtime.providers.<name>`, which has no `auxiliary.*` default —
// `voice.realtime.default` names one of its own entries instead). Five
// hand-written field lists would be five chances for a roster to quietly stop
// supporting a field its default still has. So the field set is DATA — a spec
// keyed to the entry interface, checked by the compiler — and the code that
// walks it is written once.
// ---------------------------------------------------------------------------

/**
 * One field of a voice-provider entry. `name` is constrained to a key of `E`
 * other than `provider` (which every entry has and which is always written
 * first), so a spec cannot name a field the interface does not carry.
 */
interface VoiceEntryFieldSpec<E> {
  name: Exclude<keyof E, 'provider'> & string;
  kind: 'string' | 'audioFormat' | 'positiveNumber';
}

const TTS_ENTRY_FIELDS: readonly VoiceEntryFieldSpec<TtsProviderEntry>[] = [
  { name: 'model', kind: 'string' },
  { name: 'apiKey', kind: 'string' },
  { name: 'voice', kind: 'string' },
  { name: 'baseUrl', kind: 'string' },
  { name: 'command', kind: 'string' },
  { name: 'outputFormat', kind: 'audioFormat' },
  { name: 'timeout', kind: 'positiveNumber' },
  { name: 'maxTextLength', kind: 'positiveNumber' },
];

const STT_ENTRY_FIELDS: readonly VoiceEntryFieldSpec<SttProviderEntry>[] = [
  { name: 'model', kind: 'string' },
  { name: 'apiKey', kind: 'string' },
  { name: 'baseUrl', kind: 'string' },
  { name: 'command', kind: 'string' },
  { name: 'timeout', kind: 'positiveNumber' },
];

/**
 * No `command` and no `timeout`: a realtime provider is a duplex SESSION, not a
 * request you shell out for and time out. `costPerMinuteUsd` rides the existing
 * `positiveNumber` kind, so a rate of `0` reads as absent — which is what it
 * means for accrual, since a free minute costs nothing to charge.
 */
const REALTIME_ENTRY_FIELDS: readonly VoiceEntryFieldSpec<RealtimeProviderEntry>[] = [
  { name: 'model', kind: 'string' },
  { name: 'apiKey', kind: 'string' },
  { name: 'baseUrl', kind: 'string' },
  { name: 'voice', kind: 'string' },
  { name: 'costPerMinuteUsd', kind: 'positiveNumber' },
];

/**
 * One entry from its flat `<field>: <value>` map. No `provider` → no entry: an
 * entry that names nothing resolvable is dropped rather than half-built.
 *
 * The single `as E` is backed by the compiler: `VoiceEntryFieldSpec<E>` only
 * admits names that are keys of `E`, and every value written is one of the
 * kinds those keys declare.
 */
function buildVoiceProviderEntry<E extends { provider: string }>(
  kv: Record<string, string>,
  fields: readonly VoiceEntryFieldSpec<E>[],
): E | undefined {
  if (!kv.provider) return undefined;
  const out: Record<string, string | number> = { provider: kv.provider };
  for (const field of fields) {
    const raw = kv[field.name];
    if (!raw) continue;
    if (field.kind === 'positiveNumber') {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) out[field.name] = n;
    } else if (field.kind === 'audioFormat') {
      if (isAudioFormat(raw)) out[field.name] = raw;
    } else {
      out[field.name] = raw;
    }
  }
  return out as E;
}

/** The largest `timeout` a *correct* config can express: the roster field's own
 *  declared ceiling (`min(1).max(3600)` in `@ethosagent/web-contracts`). */
const AUX_TIMEOUT_MAX_SECONDS = 3600;

/**
 * SHIM — `auxiliary.{asr,tts}.timeout` is SECONDS (the `command-stt` /
 * `command-tts` providers multiply it by 1000), but the web UI shipped the
 * field labelled and bounded in milliseconds, so existing configs carry values
 * like `30000` — an 8h20m budget, i.e. a timeout that never fires.
 *
 * A value above {@link AUX_TIMEOUT_MAX_SECONDS} is therefore read as
 * milliseconds. That threshold is above the maximum a correct config can
 * express, so there is no legitimate value in the misfire range — no single
 * speech request has a multi-hour budget.
 *
 * Removed in the minor release after the one that ships the seconds label —
 * tracked as `aux-timeout-shim-removal` in `plan/uncompleted-tasks.md`.
 */
export function normalizeAuxTimeoutSeconds(raw: number): { seconds: number; coerced: boolean } {
  if (raw <= AUX_TIMEOUT_MAX_SECONDS) return { seconds: raw, coerced: false };
  return {
    seconds: Math.min(AUX_TIMEOUT_MAX_SECONDS, Math.max(1, Math.round(raw / 1000))),
    coerced: true,
  };
}

/** {@link normalizeAuxTimeoutSeconds} over one default entry, appending the
 *  one-per-load warning to `warnings` when it coerces. */
function normalizeAuxEntryTimeout<E extends { timeout?: number }>(
  entry: E | undefined,
  key: string,
  warnings: string[],
): E | undefined {
  if (!entry || entry.timeout === undefined) return entry;
  const { seconds, coerced } = normalizeAuxTimeoutSeconds(entry.timeout);
  if (!coerced) return entry;
  warnings.push(
    `${key}: ${entry.timeout} looks like milliseconds — this field is seconds. ` +
      `Reading it as ${seconds}s. Set it to ${seconds} in ~/.ethos/config.yaml to make it ` +
      'explicit; this shim is removed in the next minor.',
  );
  return { ...entry, timeout: seconds };
}

/**
 * Serialize one entry under `prefix` (`auxiliary.tts`, `auxiliary.asr`, or a
 * `voice.<kind>.providers.<name>` roster key). The write-side mirror of
 * {@link buildVoiceProviderEntry}, walking the SAME spec — a round-trip cannot
 * lose a field on only one of the two paths.
 */
function voiceProviderEntryLines<E extends { provider: string }>(
  prefix: string,
  entry: E,
  fields: readonly VoiceEntryFieldSpec<E>[],
): string[] {
  const lines = [`${prefix}.provider: ${entry.provider}`];
  for (const field of fields) {
    const value = entry[field.name];
    if (!value) continue;
    lines.push(`${prefix}.${field.name}: ${String(value)}`);
  }
  return lines;
}

/** A whole roster (`voice.tts.providers.*` / `voice.stt.providers.*`). */
function buildVoiceProviderRoster<E extends { provider: string }>(
  kv: Record<string, Record<string, string>>,
  fields: readonly VoiceEntryFieldSpec<E>[],
): Record<string, E> | undefined {
  const out: Record<string, E> = {};
  for (const [name, entryKv] of Object.entries(kv)) {
    const entry = buildVoiceProviderEntry(entryKv, fields);
    if (entry) out[name] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function buildRetentionConfig(kv: Record<string, string>): RetentionConfig | undefined {
  if (Object.keys(kv).length === 0) return undefined;
  const cfg: RetentionConfig = {};
  if (kv.messages) cfg.messages = kv.messages;
  if (kv.traces) cfg.traces = kv.traces;
  if (kv.spans) cfg.spans = kv.spans;
  if (kv.blobs) cfg.blobs = kv.blobs;
  if (kv.archive) cfg.archive = kv.archive;
  const ev: RetentionEventsConfig = {};
  if (kv['events.error']) ev.error = kv['events.error'];
  if (kv['events.audit']) ev.audit = kv['events.audit'];
  if (kv['events.channel']) ev.channel = kv['events.channel'];
  if (kv['events.install']) ev.install = kv['events.install'];
  if (Object.keys(ev).length > 0) cfg.events = ev;
  // Item 6 — post-prune VACUUM. `vacuumAfterPrune` is a strict boolean; a typo
  // leaves it undefined (opt-in stays off). `minVacuumIntervalDays` is a
  // non-negative integer number of days; anything else is dropped.
  if (kv.vacuumAfterPrune === 'true') cfg.vacuumAfterPrune = true;
  else if (kv.vacuumAfterPrune === 'false') cfg.vacuumAfterPrune = false;
  const minInterval = Number(kv.minVacuumIntervalDays);
  if (kv.minVacuumIntervalDays !== undefined && Number.isFinite(minInterval) && minInterval >= 0) {
    cfg.minVacuumIntervalDays = Math.floor(minInterval);
  }
  return cfg;
}

/**
 * Item 8 — per-key character ceilings for the markdown memory backend. Both
 * fields are positive integers; a non-numeric or non-positive value is dropped
 * so the provider keeps its 512K default. Returns `undefined` when nothing
 * survives, so an absent block never materialises an empty object.
 */
function buildMemoryCharLimits(
  kv: Record<string, string>,
): EthosConfig['memoryCharLimits'] | undefined {
  const result: NonNullable<EthosConfig['memoryCharLimits']> = {};
  for (const key of ['memory', 'user'] as const) {
    const raw = kv[key];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) result[key] = Math.floor(n);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Item 9 — docker execution-backend resource caps. `cpu` is a positive
 * (possibly fractional) core count, `diskMb` a positive integer; out-of-range
 * values are dropped so the backend keeps its `--cpus 2` / no-quota defaults.
 */
function buildExecutionConfig(kv: Record<string, string>): EthosConfig['execution'] | undefined {
  const docker: NonNullable<NonNullable<EthosConfig['execution']>['docker']> = {};
  const cpu = Number(kv.cpu);
  if (kv.cpu !== undefined && Number.isFinite(cpu) && cpu > 0) docker.cpu = cpu;
  const diskMb = Number(kv.diskMb);
  if (kv.diskMb !== undefined && Number.isFinite(diskMb) && diskMb > 0) {
    docker.diskMb = Math.floor(diskMb);
  }
  return Object.keys(docker).length > 0 ? { docker } : undefined;
}

/**
 * Parse the `background:` section from the shared `background.*` flat-key bag.
 * Only recognised Background Sub-Agents fields are picked — the FW-13
 * `background.max_concurrent` key belongs to `backgroundMaxConcurrent` and is
 * handled separately. Returns undefined when no recognised field is present so
 * `config.background` is only set when the section actually appears.
 *
 * `default_max_cost_usd` / `max_root_background_usd` may legitimately be the
 * literal `null` meaning "explicit opt-out / unbounded". At this config layer we
 * only parse finite numbers — a `null` (or any non-finite value) leaves the
 * field undefined; the wiring layer distinguishes absence from a tool-level
 * explicit null.
 */
function buildBackgroundConfig(
  kv: Record<string, string>,
  acpAgentsKv: Record<string, Record<string, string>>,
): BackgroundConfig | undefined {
  const cfg: BackgroundConfig = {};
  if (kv.enabled !== undefined) cfg.enabled = kv.enabled === 'true';
  const num = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const maxConcurrentJobs = num(kv.max_concurrent_jobs);
  if (maxConcurrentJobs !== undefined) cfg.maxConcurrentJobs = maxConcurrentJobs;
  const maxJobsPerRoot = num(kv.max_jobs_per_root);
  if (maxJobsPerRoot !== undefined) cfg.maxJobsPerRoot = maxJobsPerRoot;
  const maxJobsPerPersonality = num(kv.max_jobs_per_personality);
  if (maxJobsPerPersonality !== undefined) cfg.maxJobsPerPersonality = maxJobsPerPersonality;
  const defaultMaxCostUsd = num(kv.default_max_cost_usd);
  if (defaultMaxCostUsd !== undefined) cfg.defaultMaxCostUsd = defaultMaxCostUsd;
  const maxRootBackgroundUsd = num(kv.max_root_background_usd);
  if (maxRootBackgroundUsd !== undefined) cfg.maxRootBackgroundUsd = maxRootBackgroundUsd;
  const queuedTtlMs = num(kv.queued_ttl_ms);
  if (queuedTtlMs !== undefined) cfg.queuedTtlMs = queuedTtlMs;
  const staleMs = num(kv.stale_ms);
  if (staleMs !== undefined) cfg.staleMs = staleMs;
  const heartbeatMs = num(kv.heartbeat_ms);
  if (heartbeatMs !== undefined) cfg.heartbeatMs = heartbeatMs;
  const retentionDays = num(kv.retention_days);
  if (retentionDays !== undefined) cfg.retentionDays = retentionDays;
  // `pi_image` is the switch: no image, no Pi runner (see `BackgroundConfig.pi`).
  if (kv.pi_image) {
    const memoryMb = num(kv.pi_memory_mb);
    cfg.pi = {
      image: kv.pi_image,
      ...(memoryMb !== undefined ? { memoryMb } : {}),
      ...(kv.pi_config_dir ? { configDir: kv.pi_config_dir } : {}),
    };
  }
  // `background.acp.agents.<name>.{command,args,image}` — each entry needs
  // both `command` and `image` to be usable; an incomplete entry is dropped
  // rather than half-built, same discipline the voice provider roster uses
  // for a missing `provider` field.
  const acpAgents: Record<string, { command: string; args?: string[]; image: string }> = {};
  for (const [name, fields] of Object.entries(acpAgentsKv)) {
    if (!fields.command || !fields.image) continue;
    const args = fields.args
      ? fields.args
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    acpAgents[name] = {
      command: fields.command,
      ...(args && args.length > 0 ? { args } : {}),
      image: fields.image,
    };
  }
  if (Object.keys(acpAgents).length > 0) cfg.acp = { agents: acpAgents };
  if (Object.keys(cfg).length === 0) return undefined;
  return cfg;
}

/**
 * Placeholder address for a legacy deployment that expressed external mode as
 * `cron.trigger.local: false` + `cron.trigger.external: true` without ever
 * setting an `arming.fireUrl` — the documented shape of the old external
 * profile, since `arming.backend` defaulted to `'none'` and only a non-`none`
 * backend required an address. Under the collapsed surface the mode IS the
 * presence of `fireUrl`, so preserving that deployment's mode across the
 * upgrade requires *some* value here. Nothing reads it (see
 * `CronTopLevelConfig.fireUrl`), and the accompanying deprecation warning
 * tells the operator to replace it with their real URL. Goes away in 0.9.0
 * with the rest of the shim.
 *
 * IT MUST NEVER BE WRITTEN TO DISK, and must never be shown to an operator as
 * an address. It is not one: no scheduler lives there, and the operator
 * checklist promises `cron.fireUrl` is where their scheduler reaches this
 * process. `writeConfig` guards its emission on exactly this constant; any
 * future surface that serializes or displays `cron.fireUrl` must guard the
 * same way.
 */
const LEGACY_EXTERNAL_FIRE_URL = 'legacy:cron.trigger.external';

/**
 * Parse the `cron:` section from its flat-key bag (see `CronTopLevelConfig`).
 * Returns undefined when no recognised field is present so `config.cron` is
 * only set when the section actually appears — an absent section means
 * "today's behavior, unchanged".
 *
 * Also runs the one-release deprecation shim for the removed
 * `cron.trigger.*` / `cron.arming.*` keys, pushing operator-facing messages
 * onto `deprecations` (plan/phases/cron-fire-url-collapse.md, D3). Removed in
 * 0.9.0.
 */
function buildCronConfig(
  kv: Record<string, string>,
  deprecations: string[],
): CronTopLevelConfig | undefined {
  const trigger: NonNullable<CronTopLevelConfig['trigger']> = {};
  if (kv['trigger.local'] !== undefined) trigger.local = kv['trigger.local'] === 'true';
  if (kv['trigger.external'] !== undefined) trigger.external = kv['trigger.external'] === 'true';

  const arming: NonNullable<CronTopLevelConfig['arming']> = {};
  if (kv['arming.backend']) arming.backend = kv['arming.backend'];
  if (kv['arming.fireUrl']) arming.fireUrl = kv['arming.fireUrl'];

  const cfg: CronTopLevelConfig = {};

  // --- Deprecation shim (D3). Delete this whole block in 0.9.0. ------------
  //
  // THE SUBTLE RULE, which is not deducible from either key in isolation:
  // while ANY legacy `cron.trigger.*` key is present, the legacy keys decide
  // the MODE and a legacy `arming.fireUrl` supplies only the ADDRESS. Under
  // the old surface `arming.fireUrl` was orthogonal to the trigger booleans,
  // so an operator could set an address while leaving `trigger.local` at its
  // default `true`. Under the new surface a `fireUrl` IS the mode switch, so
  // naively aliasing `arming.fireUrl -> fireUrl` would turn that operator's
  // local interval off on upgrade — a silent outage introduced by the
  // migration shim itself. A bare `arming.fireUrl` with no legacy trigger key
  // does mean external mode; that one is a pure rename.
  const hasLegacyTrigger =
    kv['trigger.local'] !== undefined || kv['trigger.external'] !== undefined;
  const legacyLocal = kv['trigger.local'] !== 'false';
  const legacyExternal = kv['trigger.external'] === 'true';
  const legacyFireUrl = kv['arming.fireUrl'];

  let legacyMode: 'local' | 'external' | undefined;
  if (hasLegacyTrigger) {
    if (!legacyLocal && legacyExternal) {
      // (b) The coherent external deployment. Honoured: an operator here has a
      // real scheduler already hitting /cron/fire, and switching their
      // interval back on would change live behaviour during an upgrade.
      legacyMode = 'external';
      deprecations.push(
        'cron.trigger.local/external are deprecated. This deployment is running in external mode; express it as cron.fireUrl: <url> (or ETHOS_CRON_FIRE_URL).',
      );
    } else if (!legacyLocal) {
      // (b, alone) "Nothing fires cron jobs at all" — the state this whole
      // change exists to make unrepresentable. Deliberately behaviour-changing,
      // and deliberately first in the list. Safe because the missed-run policy
      // skips any job more than one tick interval stale, so re-enabling the
      // interval recomputes nextRunAt rather than stampeding a backlog.
      legacyMode = 'local';
      deprecations.unshift(
        "cron.trigger.local: false without cron.trigger.external was 'nothing fires cron jobs at all' — a state the new configuration cannot express. The in-process interval has been enabled. If this deployment is driven by an external scheduler, set cron.fireUrl: <url>.",
      );
    } else {
      legacyMode = 'local';
      if (legacyExternal) {
        // (a) Behaviour-preserving: the old hybrid profile (interval ticking
        // AND /cron/fire live) is what every serve/boot now gets by default.
        deprecations.push(
          "cron.trigger.external is deprecated and has no effect. POST /cron/fire is now always mounted for a bearer key with the 'cron' scope. To stop the in-process interval and let an external scheduler drive firing, set cron.fireUrl: <url>.",
        );
      } else {
        deprecations.push(
          'cron.trigger.local is deprecated and has no replacement: local mode is what you get when cron.fireUrl is absent. Remove the key.',
        );
      }
    }
  }

  // (c) `arming.backend` selected nothing — there has only ever been the inert
  // NoopArmingBackend. `none` was the documented default, so writing it down is
  // not a false belief and warns nothing; any other value is, and does.
  if (kv['arming.backend'] !== undefined && kv['arming.backend'] !== 'none') {
    deprecations.push(
      'cron.arming.backend is removed; no arming backend was ever implemented and the value was always ignored.',
    );
  }

  // Precedence: cron.fireUrl > cron.arming.fireUrl. (ETHOS_CRON_FIRE_URL wins
  // over both and is applied by the caller, alongside the other env overrides.)
  let fireUrl = kv.fireUrl;
  if (fireUrl === undefined && legacyMode === 'external') {
    fireUrl = legacyFireUrl ?? LEGACY_EXTERNAL_FIRE_URL;
  }
  if (legacyFireUrl !== undefined) {
    if (legacyMode === 'local') {
      // The subtle rule, made visible to the operator: their address was NOT
      // promoted, because promoting it would have flipped them to external mode.
      deprecations.push(
        'cron.arming.fireUrl was not migrated to cron.fireUrl because cron.trigger.local is set and cron.fireUrl would stop the in-process interval. This deployment stays in local mode. To move to external mode, delete the cron.trigger.* keys and set cron.fireUrl: <url>.',
      );
    } else {
      // (d) A pure rename: same field, same semantics.
      if (fireUrl === undefined) fireUrl = legacyFireUrl;
      deprecations.push('cron.arming.fireUrl is deprecated; rename it to cron.fireUrl.');
    }
  }
  // --- end deprecation shim ------------------------------------------------

  if (fireUrl !== undefined) cfg.fireUrl = fireUrl;
  if (Object.keys(trigger).length > 0) cfg.trigger = trigger;
  if (Object.keys(arming).length > 0) cfg.arming = arming;
  // Positive integer only — `0` would mean "never fire anything", which is a
  // typo rather than a setting, so it is dropped along with negatives.
  const maxParallel = Number(kv.maxParallelJobs);
  if (kv.maxParallelJobs !== undefined && Number.isFinite(maxParallel) && maxParallel > 0) {
    cfg.maxParallelJobs = Math.floor(maxParallel);
  }
  if (Object.keys(cfg).length === 0) return undefined;
  return cfg;
}

function buildStorageConfig(kv: Record<string, string>): EthosConfig['storage'] {
  const s3: NonNullable<NonNullable<EthosConfig['storage']>['s3']> = {};
  if (kv['storage.s3.bucket']) s3.bucket = kv['storage.s3.bucket'];
  if (kv['storage.s3.region']) s3.region = kv['storage.s3.region'];
  if (kv['storage.s3.prefix']) s3.prefix = kv['storage.s3.prefix'];
  if (kv['storage.s3.endpoint']) s3.endpoint = kv['storage.s3.endpoint'];
  if (kv['storage.s3.forcePathStyle'] === 'true') s3.forcePathStyle = true;
  const rawBackend = kv['storage.backend'];
  const backend: 'fs' | 's3' | undefined =
    rawBackend === 'fs' || rawBackend === 's3' ? rawBackend : undefined;
  const encryption = kv['storage.encryption'] === 'true';
  const hasS3 = s3.bucket !== undefined;
  if (!encryption && backend === undefined && !hasS3) return undefined;
  return {
    ...(encryption ? { encryption: true } : {}),
    ...(backend ? { backend } : {}),
    ...(hasS3 ? { s3 } : {}),
  };
}

function buildBackupConfig(kv: Record<string, string>): EthosConfig['backup'] {
  const present = Object.keys(kv).some((k) => k.startsWith('backup.'));
  if (!present) return undefined;
  const keepRaw = kv['backup.keep'];
  // Validated as a WHOLE string, not with `parseInt`, which stops at the first
  // non-digit: "7days" would parse as 7 and "1.5" as 1, both silently accepted
  // by a message that promises a positive integer. `isSafeInteger` then rejects
  // a value past 2^53 that `Number` would have rounded to something else.
  const keep = keepRaw !== undefined && /^\d+$/.test(keepRaw) ? Number(keepRaw) : Number.NaN;
  if (keepRaw !== undefined && !(Number.isSafeInteger(keep) && keep >= 1)) {
    throw new Error(`Invalid backup.keep "${keepRaw}". Expected a positive integer.`);
  }
  const scope = splitList(kv['backup.scope']);
  return {
    ...(kv['backup.enabled'] !== undefined ? { enabled: kv['backup.enabled'] === 'true' } : {}),
    ...(kv['backup.cron'] ? { cron: kv['backup.cron'] } : {}),
    ...(scope.length > 0 ? { scope } : {}),
    ...(keepRaw !== undefined ? { keep } : {}),
    ...(kv['backup.dir'] ? { dir: kv['backup.dir'] } : {}),
  };
}

function buildMemoryCaptureConfig(kv: Record<string, string>): MemoryCaptureConfig | undefined {
  const present = Object.keys(kv).some((k) => k.startsWith('memoryCapture.'));
  if (!present) return undefined;
  const maxPerHour = Number.parseInt(kv['memoryCapture.maxPerHour'] ?? '', 10);
  const maxPerDay = Number.parseInt(kv['memoryCapture.maxPerDay'] ?? '', 10);
  return {
    ...(kv['memoryCapture.enabled'] !== undefined
      ? { enabled: kv['memoryCapture.enabled'] === 'true' }
      : {}),
    ...(kv['memoryCapture.model'] ? { model: kv['memoryCapture.model'] } : {}),
    ...(kv['memoryCapture.provider'] ? { provider: kv['memoryCapture.provider'] } : {}),
    ...(kv['memoryCapture.apiKey'] ? { apiKey: kv['memoryCapture.apiKey'] } : {}),
    ...(kv['memoryCapture.baseUrl'] ? { baseUrl: kv['memoryCapture.baseUrl'] } : {}),
    ...(Number.isFinite(maxPerHour) ? { maxPerHour } : {}),
    ...(Number.isFinite(maxPerDay) ? { maxPerDay } : {}),
  };
}

function buildMemoryVaultConfig(kv: Record<string, string>): MemoryVaultConfig | undefined {
  const present = Object.keys(kv).some((k) => k.startsWith('memoryVault.'));
  if (!present) return undefined;
  const prefetch = splitList(kv['memoryVault.prefetch']);
  const exclude = splitList(kv['memoryVault.exclude']);
  return {
    ...(kv['memoryVault.path'] ? { path: kv['memoryVault.path'] } : {}),
    ...(kv['memoryVault.agentDir'] ? { agentDir: kv['memoryVault.agentDir'] } : {}),
    ...(prefetch.length > 0 ? { prefetch } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
  };
}

function buildMemoryApprovalConfig(kv: Record<string, string>): MemoryApprovalConfig | undefined {
  const present = Object.keys(kv).some((k) => k.startsWith('memoryApproval.'));
  if (!present) return undefined;
  const mode = kv['memoryApproval.mode'];
  if (mode !== undefined && mode !== 'off' && mode !== 'automated' && mode !== 'all') {
    throw new Error(`Invalid memoryApproval.mode "${mode}". Expected one of: off, automated, all.`);
  }
  const cap = Number.parseInt(kv['memoryApproval.cap'] ?? '', 10);
  const ttlDays = Number.parseInt(kv['memoryApproval.ttlDays'] ?? '', 10);
  if (kv['memoryApproval.cap'] !== undefined && (!Number.isFinite(cap) || cap <= 0)) {
    throw new Error(
      `Invalid memoryApproval.cap "${kv['memoryApproval.cap']}". Expected a positive integer.`,
    );
  }
  if (kv['memoryApproval.ttlDays'] !== undefined && (!Number.isFinite(ttlDays) || ttlDays <= 0)) {
    throw new Error(
      `Invalid memoryApproval.ttlDays "${kv['memoryApproval.ttlDays']}". Expected a positive integer.`,
    );
  }
  return {
    ...(mode !== undefined ? { mode: mode as MemoryApprovalConfig['mode'] } : {}),
    ...(Number.isFinite(cap) && cap > 0 ? { cap } : {}),
    ...(Number.isFinite(ttlDays) && ttlDays > 0 ? { ttlDays } : {}),
  };
}

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function buildMemoryConsolidationConfig(
  kv: Record<string, string>,
): MemoryConsolidationConfig | undefined {
  const present = Object.keys(kv).some((k) => k.startsWith('memoryConsolidation.'));
  if (!present) return undefined;
  const halfLifeDays = Number.parseFloat(kv['memoryConsolidation.halfLifeDays'] ?? '');
  const threshold = Number.parseFloat(kv['memoryConsolidation.threshold'] ?? '');
  return {
    ...(Number.isFinite(halfLifeDays) ? { halfLifeDays } : {}),
    ...(Number.isFinite(threshold) ? { threshold } : {}),
    ...(kv['memoryConsolidation.exemptUser'] !== undefined
      ? { exemptUser: kv['memoryConsolidation.exemptUser'] === 'true' }
      : {}),
  };
}

function buildBotBinding(
  kv: Record<string, string>,
  label: string,
): { bind: BotBinding | null; errors: string[] } {
  const type = kv['bind.type'];
  const name = kv['bind.name'];
  const errors: string[] = [];
  if (type !== 'personality' && type !== 'team') {
    errors.push(
      `${label}: missing or invalid 'bind.type' ` +
        `(got ${type === undefined ? 'nothing' : `'${type}'`}; ` +
        `must be 'personality' or 'team').`,
    );
  }
  if (!name) {
    errors.push(`${label}: missing required field 'bind.name'.`);
  }
  if (errors.length > 0) return { bind: null, errors };
  const allow = kv['bind.allowSlashSwitch'];
  const binding: BotBinding = { type: type as 'personality' | 'team', name: name as string };
  if (allow === 'true') binding.allowSlashSwitch = true;
  return { bind: binding, errors };
}

function sortedIndexes(kv: Record<number, Record<string, string>>): number[] {
  // Numeric sort — `Object.keys(...)` returns strings even on numeric-keyed
  // records, and the default lexicographic order would put index 10 before 2.
  return Object.keys(kv)
    .map(Number)
    .sort((a, b) => a - b);
}

function buildTelegramBots(kv: Record<number, Record<string, string>>): {
  bots: TelegramBotConfig[];
  errors: string[];
} {
  const bots: TelegramBotConfig[] = [];
  const errors: string[] = [];
  for (const idx of sortedIndexes(kv)) {
    const entry = kv[idx];
    if (!entry) continue;
    const label = `telegram.bots[${idx}]`;
    if (!entry.token) {
      errors.push(`${label}: missing required field 'token'.`);
      continue;
    }
    const result = buildBotBinding(entry, label);
    if (result.errors.length > 0) {
      errors.push(...result.errors);
      continue;
    }
    if (!result.bind) continue;
    const bot: TelegramBotConfig = {
      token: entry.token,
      bind: result.bind,
      ...(entry.id ? { id: entry.id } : {}),
    };
    // Presence, not truthiness: `dropPendingUpdates: false` must survive as
    // boolean `false` rather than collapsing into "absent" (which means "let
    // the adapter's `?? true` default apply").
    if (entry.useWebhook !== undefined) bot.useWebhook = entry.useWebhook === 'true';
    if (entry.webhookUrl) bot.webhookUrl = entry.webhookUrl;
    if (entry.webhookSecretToken) bot.webhookSecretToken = entry.webhookSecretToken;
    if (entry.dropPendingUpdates !== undefined) {
      bot.dropPendingUpdates = entry.dropPendingUpdates === 'true';
    }
    bots.push(bot);
  }
  return { bots, errors };
}

function buildSlackApps(kv: Record<number, Record<string, string>>): {
  apps: SlackAppConfig[];
  errors: string[];
} {
  const apps: SlackAppConfig[] = [];
  const errors: string[] = [];
  for (const idx of sortedIndexes(kv)) {
    const entry = kv[idx];
    if (!entry) continue;
    const label = `slack.apps[${idx}]`;
    // `appToken` is NOT required here: it is needed only in Socket Mode, and
    // that is enforced by the adapter, which knows the resolved mode (§8).
    const missing = (['botToken', 'signingSecret'] as const).filter((k) => !entry[k]);
    if (missing.length > 0) {
      errors.push(`${label}: missing required field(s) ${missing.join(', ')}.`);
      continue;
    }
    const result = buildBotBinding(entry, label);
    if (result.errors.length > 0) {
      errors.push(...result.errors);
      continue;
    }
    if (!result.bind) continue;
    const app: SlackAppConfig = {
      botToken: entry.botToken,
      signingSecret: entry.signingSecret,
      bind: result.bind,
      ...(entry.id ? { id: entry.id } : {}),
      ...(entry.appToken ? { appToken: entry.appToken } : {}),
    };
    const mode = entry.defaultChannelMode;
    if (mode) {
      if (mode !== 'mention_only' && mode !== 'thread_follow' && mode !== 'all') {
        errors.push(
          `${label}: invalid defaultChannelMode '${mode}' (expected 'mention_only', 'thread_follow' or 'all').`,
        );
        continue;
      }
      app.defaultChannelMode = mode;
    }
    if (entry.receiptReaction) app.receiptReaction = entry.receiptReaction;
    if (entry.allowedSlashUsers) {
      const users = entry.allowedSlashUsers
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (users.length > 0) app.allowedSlashUsers = users;
    }
    if (entry.allowedBotIds) {
      const botIds = entry.allowedBotIds
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (botIds.length > 0) app.allowedBotIds = botIds;
    }
    if (entry.longReplyThresholdChars) {
      const threshold = Number(entry.longReplyThresholdChars);
      if (!Number.isInteger(threshold) || threshold < 0) {
        errors.push(
          `${label}: invalid longReplyThresholdChars '${entry.longReplyThresholdChars}' (expected a non-negative integer; 0 disables).`,
        );
        continue;
      }
      app.longReplyThresholdChars = threshold;
    }
    // `mode.socket` / `mode.http` arrive as flat `mode.<field>` keys, the same
    // way `bind.<field>` does. Absent = undefined, so the adapter's defaults
    // (socket on, http off) apply and today's behaviour is unchanged.
    const transport: NonNullable<SlackAppConfig['mode']> = {};
    if (entry['mode.socket'] !== undefined) transport.socket = entry['mode.socket'] === 'true';
    if (entry['mode.http'] !== undefined) transport.http = entry['mode.http'] === 'true';
    if (Object.keys(transport).length > 0) app.mode = transport;
    if (entry.webhookPath) app.webhookPath = entry.webhookPath;
    apps.push(app);
  }
  return { apps, errors };
}

function buildWhatsApps(kv: Record<number, Record<string, string>>): {
  apps: WhatsAppConfig[];
  errors: string[];
} {
  const apps: WhatsAppConfig[] = [];
  const errors: string[] = [];
  for (const idx of sortedIndexes(kv)) {
    const entry = kv[idx];
    if (!entry) continue;
    const label = `whatsapp[${idx}]`;
    const app: WhatsAppConfig = {};
    if (entry.id) app.id = entry.id;
    if (entry.session_dir) app.session_dir = entry.session_dir;
    if (entry.phone_number) app.phone_number = entry.phone_number;
    if (entry.default_mode) {
      if (entry.default_mode === 'all' || entry.default_mode === 'mention_only') {
        app.default_mode = entry.default_mode;
      } else {
        errors.push(
          `${label}: invalid default_mode '${entry.default_mode}' (expected 'all' or 'mention_only').`,
        );
        continue;
      }
    }
    if (entry.allowed_numbers) {
      const numbers = entry.allowed_numbers
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (numbers.length > 0) app.allowed_numbers = numbers;
    }
    // WhatsApp bind is optional. Only build (and validate) a binding when the
    // operator supplied both bind.type and bind.name; otherwise leave it
    // undefined so the gateway falls back to the default personality.
    if (entry['bind.type'] && entry['bind.name']) {
      const result = buildBotBinding(entry, label);
      if (result.errors.length > 0) {
        errors.push(...result.errors);
        continue;
      }
      if (result.bind) app.bind = result.bind;
    }
    apps.push(app);
  }
  return { apps, errors };
}

function buildVoiceBots(kv: Record<number, Record<string, string>>): {
  bots: VoiceBotConfig[];
  errors: string[];
} {
  const bots: VoiceBotConfig[] = [];
  const errors: string[] = [];
  for (const idx of sortedIndexes(kv)) {
    const entry = kv[idx];
    if (!entry) continue;
    const label = `voice.bots[${idx}]`;
    if (!entry.match) {
      errors.push(`${label}: missing required field 'match'.`);
      continue;
    }
    const result = buildBotBinding(entry, label);
    if (result.errors.length > 0) {
      errors.push(...result.errors);
      continue;
    }
    if (!result.bind) continue;
    bots.push({ match: entry.match, bind: result.bind, ...(entry.id ? { id: entry.id } : {}) });
  }
  return { bots, errors };
}

function buildVoiceLiveKit(kv: Record<string, string>): {
  livekit?: VoiceLiveKitConfig;
  errors: string[];
} {
  // Absent block is valid — LiveKit keys are optional.
  if (Object.keys(kv).length === 0) return { errors: [] };
  const errors: string[] = [];
  const { url, apiKey, apiSecret } = kv;
  if (!url || !apiKey || !apiSecret) {
    if (!url) errors.push("voice.livekit: missing required field 'url'.");
    if (!apiKey) errors.push("voice.livekit: missing required field 'apiKey'.");
    if (!apiSecret) errors.push("voice.livekit: missing required field 'apiSecret'.");
    return { errors };
  }
  return { livekit: { url, apiKey, apiSecret }, errors: [] };
}

const VOICE_TRUNK_PROVIDERS = ['twilio', 'telnyx', 'generic', 'livekit'] as const;

const VOICE_TRUNK_CODECS = ['opus', 'g711'] as const;

function buildVoiceTrunk(kv: Record<string, string>): {
  trunk?: VoiceTrunkConfig;
  errors: string[];
} {
  // Absent block is valid — SIP trunk keys are optional.
  if (Object.keys(kv).length === 0) return { errors: [] };
  const errors: string[] = [];
  const { provider, trunkId, fromNumber, username, password, webhookSecret, webhookPath, codec } =
    kv;
  if (!provider) errors.push("voice.trunk: missing required field 'provider'.");
  else if (!(VOICE_TRUNK_PROVIDERS as readonly string[]).includes(provider)) {
    errors.push(
      `voice.trunk: invalid provider '${provider}' (expected one of: ${VOICE_TRUNK_PROVIDERS.join(', ')}).`,
    );
  }
  if (!trunkId) errors.push("voice.trunk: missing required field 'trunkId'.");
  if (webhookPath !== undefined && !webhookPath.startsWith('/')) {
    errors.push(`voice.trunk.webhookPath: must start with '/' (got '${webhookPath}').`);
  }
  if (codec !== undefined && !(VOICE_TRUNK_CODECS as readonly string[]).includes(codec)) {
    errors.push(
      `voice.trunk.codec: invalid codec '${codec}' (expected one of: ${VOICE_TRUNK_CODECS.join(', ')}).`,
    );
  }
  if (errors.length > 0) return { errors };
  return {
    trunk: {
      provider: provider as VoiceTrunkConfig['provider'],
      trunkId,
      ...(fromNumber ? { fromNumber } : {}),
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
      ...(webhookSecret ? { webhookSecret } : {}),
      ...(webhookPath ? { webhookPath } : {}),
      ...(codec ? { codec: codec as VoiceTrunkConfig['codec'] } : {}),
    },
    errors: [],
  };
}

const VOICE_PREWARM_MODES = ['allowlisted', 'none', 'all'] as const;
const VOICE_INBOUND_FIELDS = [
  'allowlist',
  'receptionist',
  'concurrencyCap',
  'perCallerPerHour',
  'dailyBudgetUsd',
  'prewarm',
] as const;
const VOICE_INBOUND_OWNER_FIELDS = ['platform', 'chatId', 'botKey'] as const;

/**
 * `voice.inbound.*` — who reaches the number and what answering may cost.
 *
 * Loud rather than lenient, unlike the `voice.wake.*` knobs above: a dropped
 * wake threshold costs a slightly worse match, while a dropped budget or
 * concurrency cap costs real money on a surface strangers can dial. Every
 * malformed value is a parse error naming its own key.
 */
function buildVoiceInbound(
  kv: Record<string, string>,
  ownerKv: Record<string, string>,
): { inbound?: VoiceInboundConfig; errors: string[] } {
  if (Object.keys(kv).length === 0 && Object.keys(ownerKv).length === 0) return { errors: [] };
  const errors: string[] = [];
  for (const field of Object.keys(kv)) {
    if (!(VOICE_INBOUND_FIELDS as readonly string[]).includes(field)) {
      errors.push(
        `voice.inbound.${field}: unknown field (expected one of: ${VOICE_INBOUND_FIELDS.join(', ')}).`,
      );
    }
  }
  for (const field of Object.keys(ownerKv)) {
    if (!(VOICE_INBOUND_OWNER_FIELDS as readonly string[]).includes(field)) {
      errors.push(
        `voice.inbound.owner.${field}: unknown field (expected one of: ${VOICE_INBOUND_OWNER_FIELDS.join(', ')}).`,
      );
    }
  }
  /** A count is a positive integer; zero and fractions are refusals, not caps. */
  const positiveInt = (field: string): number | undefined => {
    const raw = kv[field];
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      errors.push(`voice.inbound.${field}: must be a positive integer (got '${raw}').`);
      return undefined;
    }
    return n;
  };
  const concurrencyCap = positiveInt('concurrencyCap');
  const perCallerPerHour = positiveInt('perCallerPerHour');
  let dailyBudgetUsd: number | undefined;
  if (kv.dailyBudgetUsd !== undefined) {
    const n = Number(kv.dailyBudgetUsd);
    if (!Number.isFinite(n) || n <= 0) {
      errors.push(
        `voice.inbound.dailyBudgetUsd: must be a positive number (got '${kv.dailyBudgetUsd}').`,
      );
    } else {
      dailyBudgetUsd = n;
    }
  }
  if (
    kv.prewarm !== undefined &&
    !(VOICE_PREWARM_MODES as readonly string[]).includes(kv.prewarm)
  ) {
    errors.push(
      `voice.inbound.prewarm: invalid value '${kv.prewarm}' (expected one of: ${VOICE_PREWARM_MODES.join(', ')}).`,
    );
  }
  const { platform, chatId, botKey } = ownerKv;
  if (Object.keys(ownerKv).length > 0) {
    if (!platform) errors.push("voice.inbound.owner: missing required field 'platform'.");
    if (!chatId) errors.push("voice.inbound.owner: missing required field 'chatId'.");
  }
  if (errors.length > 0) return { errors };
  const allowlist = splitList(kv.allowlist);
  return {
    inbound: {
      ...(allowlist.length > 0 ? { allowlist } : {}),
      ...(kv.receptionist ? { receptionist: kv.receptionist } : {}),
      ...(concurrencyCap !== undefined ? { concurrencyCap } : {}),
      ...(perCallerPerHour !== undefined ? { perCallerPerHour } : {}),
      ...(dailyBudgetUsd !== undefined ? { dailyBudgetUsd } : {}),
      ...(kv.prewarm ? { prewarm: kv.prewarm as VoiceInboundConfig['prewarm'] } : {}),
      ...(platform && chatId ? { owner: { platform, chatId, ...(botKey ? { botKey } : {}) } } : {}),
    },
    errors: [],
  };
}

const VOICE_BARGE_IN_SURFACES = ['call', 'satellite', 'browser'] as const;
const VOICE_BARGE_IN_FIELDS = ['energyThreshold', 'minSpeechMs', 'silenceMs'] as const;

/**
 * `voice.bargeIn.<surface>.<field>` — VAD thresholds per audio surface.
 *
 * Loud for the same reason `voice.inbound` is: a threshold typed against a
 * misspelled surface or field is not "a slightly different setting", it is no
 * setting at all, and the operator would only find out from a line the agent
 * kept talking over.
 */
function buildVoiceBargeIn(kv: Record<string, Record<string, string>>): {
  bargeIn?: VoiceBargeInConfig;
  errors: string[];
} {
  if (Object.keys(kv).length === 0) return { errors: [] };
  const errors: string[] = [];
  const out: VoiceBargeInConfig = {};
  for (const [surface, fields] of Object.entries(kv)) {
    if (!(VOICE_BARGE_IN_SURFACES as readonly string[]).includes(surface)) {
      errors.push(
        `voice.bargeIn.${surface}: unknown surface (expected one of: ${VOICE_BARGE_IN_SURFACES.join(', ')}).`,
      );
      continue;
    }
    const tuning: VoiceBargeInTuning = {};
    for (const [field, raw] of Object.entries(fields)) {
      const key = `voice.bargeIn.${surface}.${field}`;
      if (field === 'energyThreshold') {
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0 || n > 1) {
          errors.push(`${key}: must be a number in (0, 1] (got '${raw}').`);
        } else {
          tuning.energyThreshold = n;
        }
      } else if (field === 'minSpeechMs' || field === 'silenceMs') {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1) {
          errors.push(`${key}: must be a positive integer (got '${raw}').`);
        } else {
          tuning[field] = n;
        }
      } else {
        errors.push(
          `${key}: unknown field (expected one of: ${VOICE_BARGE_IN_FIELDS.join(', ')}).`,
        );
      }
    }
    out[surface as VoiceBargeInSurface] = tuning;
  }
  if (errors.length > 0) return { errors };
  return { bargeIn: out, errors: [] };
}

function buildTeamsConfig(
  kv: Record<string, Record<string, string>>,
): Record<string, TeamRuntimeConfig> | undefined {
  const names = Object.keys(kv);
  if (names.length === 0) return undefined;
  const out: Record<string, TeamRuntimeConfig> = {};
  for (const name of names) {
    const entry = kv[name];
    if (!entry) continue;
    const cfg: TeamRuntimeConfig = {};
    if (entry.autoStop === 'true') cfg.autoStop = true;
    out[name] = cfg;
  }
  return out;
}

/**
 * Group a hook's flat `deliver.<n>.<field>` keys into an ordered target list.
 *
 * The webhooks kv map stores whatever followed `webhooks.<id>.` as a literal
 * dotted key, so the numbered-array convention `telegram.bots.<n>.*` gets from
 * its own regex has to be reconstructed here. Indices are sorted numerically
 * (`sortedIndexes`'s reason: lexicographic order puts 10 before 2) and must be
 * a gapless 0..n-1 run — a gap means an operator deleted or mistyped a target
 * and should hear about it rather than have the list silently renumber.
 */
function buildWebhookDeliverTargets(
  entry: Record<string, string>,
  hookId: string,
): { targets: WebhookDeliveryTargetConfig[]; errors: string[] } {
  const errors: string[] = [];
  const byIndex = new Map<number, Record<string, string>>();
  for (const [key, value] of Object.entries(entry)) {
    const m = key.match(/^deliver\.([^.]+)\.(\S+)$/);
    if (!m) continue;
    const rawIndex = m[1] ?? '';
    const field = m[2] ?? '';
    if (!/^\d+$/.test(rawIndex)) {
      errors.push(
        `webhooks.${hookId}: deliver index '${rawIndex}' must be a non-negative integer.`,
      );
      continue;
    }
    const idx = Number(rawIndex);
    const bag = byIndex.get(idx) ?? {};
    bag[field] = value;
    byIndex.set(idx, bag);
  }
  if (errors.length > 0) return { targets: [], errors };
  const indexes = [...byIndex.keys()].sort((a, b) => a - b);
  const gapAt = indexes.findIndex((n, i) => n !== i);
  if (gapAt !== -1) {
    errors.push(
      `webhooks.${hookId}: deliver indexes must run 0..${indexes.length - 1} with no gaps ` +
        `(got ${indexes.join(', ')}).`,
    );
    return { targets: [], errors };
  }
  const targets: WebhookDeliveryTargetConfig[] = [];
  for (const idx of indexes) {
    const fields = byIndex.get(idx);
    if (!fields) continue;
    const label = `webhooks.${hookId}: deliver.${idx}`;
    const type = fields.type;
    if (type !== 'log' && type !== 'platform') {
      errors.push(
        `${label}.type must be 'log' or 'platform' ` +
          `(got ${type === undefined ? 'nothing' : `'${type}'`}).`,
      );
      continue;
    }
    if (type === 'log') {
      // A `log` target carries no destination. Silently ignoring a stray
      // adapterId/chatId would hide the far likelier reading: the operator
      // meant `type: platform` and this payload is going nowhere.
      const stray = (['adapterId', 'chatId', 'threadId'] as const).filter(
        (k) => fields[k] !== undefined,
      );
      if (stray.length > 0) {
        errors.push(`${label} is a 'log' target and must not set ${stray.join(', ')}.`);
        continue;
      }
      targets.push({ type: 'log' });
      continue;
    }
    const missing = (['adapterId', 'chatId'] as const).filter((k) => !fields[k]);
    if (missing.length > 0) {
      errors.push(`${label} is a 'platform' target and requires ${missing.join(', ')}.`);
      continue;
    }
    targets.push({
      type: 'platform',
      adapterId: fields.adapterId,
      chatId: fields.chatId,
      ...(fields.threadId ? { threadId: fields.threadId } : {}),
    });
  }
  return { targets, errors };
}

function buildWebhooks(kv: Record<string, Record<string, string>>): {
  webhooks: Record<string, WebhookHookConfig> | undefined;
  errors: string[];
} {
  const ids = Object.keys(kv);
  if (ids.length === 0) return { webhooks: undefined, errors: [] };
  const webhooks: Record<string, WebhookHookConfig> = {};
  const errors: string[] = [];
  for (const hookId of ids) {
    const entry = kv[hookId];
    if (!entry) continue;
    if (!entry.personalityId) {
      errors.push(`webhooks.${hookId}: missing required field 'personalityId'.`);
      continue;
    }
    if (!entry.secret) {
      errors.push(`webhooks.${hookId}: missing required field 'secret'.`);
      continue;
    }
    if (entry.mode !== undefined && entry.mode !== 'sync' && entry.mode !== 'ack') {
      errors.push(`webhooks.${hookId}: mode must be 'sync' or 'ack'.`);
      continue;
    }
    let prefilterTimeoutSeconds: number | undefined;
    if (entry.prefilterTimeoutSeconds !== undefined) {
      if (!entry.prefilter) {
        errors.push(`webhooks.${hookId}: prefilterTimeoutSeconds requires 'prefilter'.`);
        continue;
      }
      const n = Number(entry.prefilterTimeoutSeconds);
      if (!Number.isInteger(n) || n < 1 || n > 600) {
        errors.push(
          `webhooks.${hookId}: prefilterTimeoutSeconds must be an integer between 1 and 600.`,
        );
        continue;
      }
      prefilterTimeoutSeconds = n;
    }
    const events = splitList(entry.events);
    if (entry.events !== undefined && events.length === 0) {
      errors.push(`webhooks.${hookId}: events must list at least one event name.`);
      continue;
    }
    if (entry.eventHeader !== undefined && events.length === 0) {
      errors.push(`webhooks.${hookId}: eventHeader requires 'events'.`);
      continue;
    }
    if (entry.eventField !== undefined && events.length === 0) {
      errors.push(`webhooks.${hookId}: eventField requires 'events'.`);
      continue;
    }
    let deliverOnly: boolean | undefined;
    if (entry.deliverOnly !== undefined) {
      if (entry.deliverOnly !== 'true' && entry.deliverOnly !== 'false') {
        errors.push(`webhooks.${hookId}: deliverOnly must be 'true' or 'false'.`);
        continue;
      }
      deliverOnly = entry.deliverOnly === 'true';
    }
    const deliverResult = buildWebhookDeliverTargets(entry, hookId);
    if (deliverResult.errors.length > 0) {
      errors.push(...deliverResult.errors);
      continue;
    }
    const deliver = deliverResult.targets;
    if (deliverOnly === true && deliver.length === 0) {
      // No turn AND no destination is a hook that accepts a payload and drops
      // it — never what the operator meant.
      errors.push(`webhooks.${hookId}: deliverOnly requires at least one 'deliver' target.`);
      continue;
    }
    // The webhooks kv map keys by whatever followed `webhooks.<id>.`, so the
    // nested-object convention (`telegram.bots.<n>.bind.type`) arrives here as
    // the literal keys 'hmac.secret', 'hmac.header', …
    const hmacSecret = entry['hmac.secret'];
    const hmacHeader = entry['hmac.header'];
    const hmacAlgorithm = entry['hmac.algorithm'];
    const hmacPreviousSecret = entry['hmac.previousSecret'];
    if (!hmacSecret && (hmacHeader || hmacAlgorithm || hmacPreviousSecret)) {
      errors.push(`webhooks.${hookId}: missing required field 'hmac.secret'.`);
      continue;
    }
    if (
      hmacAlgorithm !== undefined &&
      !WEBHOOK_HMAC_ALGORITHMS.includes(hmacAlgorithm as (typeof WEBHOOK_HMAC_ALGORITHMS)[number])
    ) {
      errors.push(
        `webhooks.${hookId}: hmac.algorithm must be one of ` +
          `${WEBHOOK_HMAC_ALGORITHMS.join(', ')}.`,
      );
      continue;
    }
    // Same nested-key convention as `hmac.*` above: the kv map keys by
    // whatever followed `webhooks.<id>.`, so these arrive as literal dotted
    // keys rather than a nested object.
    let rateLimit: WebhookRateLimitConfig | undefined;
    const rawMaxPerMinute = entry['rateLimit.maxPerMinute'];
    const rawLockoutSeconds = entry['rateLimit.lockoutSeconds'];
    if (rawLockoutSeconds !== undefined && rawMaxPerMinute === undefined) {
      errors.push(
        `webhooks.${hookId}: rateLimit.lockoutSeconds requires 'rateLimit.maxPerMinute'.`,
      );
      continue;
    }
    if (rawMaxPerMinute !== undefined) {
      const n = Number(rawMaxPerMinute);
      if (!Number.isInteger(n) || n < 1 || n > 100_000) {
        errors.push(
          `webhooks.${hookId}: rateLimit.maxPerMinute must be an integer between 1 and 100000.`,
        );
        continue;
      }
      let lockoutSeconds: number | undefined;
      if (rawLockoutSeconds !== undefined) {
        const l = Number(rawLockoutSeconds);
        if (!Number.isInteger(l) || l < 1 || l > 86_400) {
          errors.push(
            `webhooks.${hookId}: rateLimit.lockoutSeconds must be an integer between 1 and 86400.`,
          );
          continue;
        }
        lockoutSeconds = l;
      }
      rateLimit = {
        maxPerMinute: n,
        ...(lockoutSeconds !== undefined ? { lockoutSeconds } : {}),
      };
    }
    const hmac: WebhookHmacConfig | undefined = hmacSecret
      ? {
          secret: hmacSecret,
          ...(hmacHeader ? { header: hmacHeader } : {}),
          ...(hmacAlgorithm ? { algorithm: hmacAlgorithm } : {}),
          ...(hmacPreviousSecret ? { previousSecret: hmacPreviousSecret } : {}),
        }
      : undefined;
    webhooks[hookId] = {
      personalityId: entry.personalityId,
      secret: entry.secret,
      ...(entry.sessionKey ? { sessionKey: entry.sessionKey } : {}),
      ...(entry.prefilter ? { prefilter: entry.prefilter } : {}),
      ...(prefilterTimeoutSeconds !== undefined ? { prefilterTimeoutSeconds } : {}),
      ...(entry.mode ? { mode: entry.mode } : {}),
      ...(events.length > 0 ? { events } : {}),
      ...(entry.eventHeader ? { eventHeader: entry.eventHeader } : {}),
      ...(entry.eventField ? { eventField: entry.eventField } : {}),
      // Only `true` is carried: `deliverOnly: false` and an absent key mean
      // exactly the same thing (dispatch a turn), so collapsing them keeps the
      // writer's output lossless without a presence/truthiness distinction the
      // field does not have.
      ...(deliverOnly === true ? { deliverOnly: true } : {}),
      ...(deliver.length > 0 ? { deliver } : {}),
      ...(hmac ? { hmac } : {}),
      ...(rateLimit ? { rateLimit } : {}),
    };
  }
  return { webhooks: Object.keys(webhooks).length > 0 ? webhooks : undefined, errors };
}

/**
 * Derive a stable `botKey` for a bot config. Explicit `id` wins; otherwise
 * delegates to `deriveBotKey` from `@ethosagent/core` with the token as
 * seed. Stable across boots; safe to log.
 *
 * Operators who want a readable identifier should set an explicit `id:`
 * in the config.
 */
export function deriveBotKey(
  bot: { id?: string } & ({ token: string } | { botToken: string }),
): string {
  if (bot.id) return bot.id;
  const seed = 'token' in bot ? bot.token : bot.botToken;
  return deriveBotKeyFromSeed(seed);
}

/**
 * Apply the legacy → list-shape shim. Configs written before multi-bot
 * routing kept a scalar `telegramToken`/`slack*` triple; synthesize a
 * one-entry `telegram.bots` / `slack.apps` so downstream code sees one
 * shape. Returns the deprecation messages the caller should surface.
 *
 * Legacy bots always bind to `config.personality` — never to
 * `config.activeContext`. `activeContext` is internal, mutable CLI/session
 * state (managed by `ethos set`); routing platform traffic by it would
 * mean a `/personality` switch in the CLI silently redirects Telegram or
 * Slack traffic after the next restart. Operators who want a team-bound
 * legacy bot must migrate to the explicit list shape.
 */
export function applyPlatformShim(config: EthosConfig): {
  config: EthosConfig;
  deprecations: string[];
} {
  const deprecations: string[] = [];
  let out = config;

  if (config.telegramToken && (config.telegram?.bots?.length ?? 0) === 0) {
    const bind: BotBinding = { type: 'personality', name: config.personality };
    out = { ...out, telegram: { bots: [{ token: config.telegramToken, bind }] } };
    deprecations.push(
      "Config field 'telegramToken' is deprecated. Use the list form: " +
        "'telegram.bots.0.token: <token>' + 'telegram.bots.0.bind.type: personality' + " +
        "'telegram.bots.0.bind.name: <id>'.",
    );
  }

  if (
    config.slackBotToken &&
    config.slackAppToken &&
    config.slackSigningSecret &&
    (config.slack?.apps?.length ?? 0) === 0
  ) {
    const bind: BotBinding = { type: 'personality', name: config.personality };
    out = {
      ...out,
      slack: {
        apps: [
          {
            botToken: config.slackBotToken,
            appToken: config.slackAppToken,
            signingSecret: config.slackSigningSecret,
            bind,
          },
        ],
      },
    };
    deprecations.push(
      "Config fields 'slackBotToken'/'slackAppToken'/'slackSigningSecret' are deprecated. " +
        "Use the list form: 'slack.apps.0.botToken: <token>' + " +
        "'slack.apps.0.appToken: <token>' + 'slack.apps.0.signingSecret: <secret>' + " +
        "'slack.apps.0.bind.type: personality' + 'slack.apps.0.bind.name: <id>'.",
    );
  }

  return { config: out, deprecations };
}

// Identifiers (bot id, bind.name, team key) are interpolated into the
// dotted line-based config format. Anything outside `[A-Za-z0-9_-]` either
// can't round-trip (dot = field separator) or quietly corrupts the file
// (`#` starts a comment, quotes change quoting semantics, whitespace
// truncates parsing). Reject up front so writeConfig never emits data it
// can't parse back unambiguously.
const SAFE_IDENT = /^[A-Za-z0-9_-]+$/;

function rejectUnsafeIdent(label: string, value: string, errors: string[]): void {
  if (!SAFE_IDENT.test(value)) {
    errors.push(
      `${label}: '${value}' must match /^[A-Za-z0-9_-]+$/ — dots, whitespace, '#', and quotes are reserved by the config format.`,
    );
  }
}

/**
 * Does a bot binding speak for `personalityId` — directly, or because the bot
 * is bound to a team that contains it?
 *
 * This is the authorization predicate behind channel-addressable cron delivery
 * (plan/phases/recipes-gallery.md §1, refusal rule 1): it is what stops
 * personality A's scheduled output being delivered through personality B's
 * bot. It lives here, next to `validateBotBindings`, because both the web API's
 * delivery-target resolver and the gateway's delivery guard must agree on it —
 * two copies of a security rule is two rules.
 *
 * `teamMembers` resolves a team name to its member personality ids. Callers
 * that cannot read team manifests (or deployments with no teams) pass one that
 * returns an empty list; a `team` bind then resolves to nothing rather than to
 * everything.
 */
export function bindResolvesToPersonality(
  bind: BotBinding,
  personalityId: string,
  teamMembers: (teamName: string) => readonly string[],
): boolean {
  if (bind.type === 'personality') return bind.name === personalityId;
  return teamMembers(bind.name).includes(personalityId);
}

/**
 * Validate that every bot binding points at a personality or team that
 * actually exists. Returns the list of human-readable error messages;
 * an empty list means the config is consistent. Boot code prints these
 * and exits non-zero rather than starting bots that will silently route
 * to nowhere.
 */
export function validateBotBindings(
  config: EthosConfig,
  deps: { personalityIds: ReadonlySet<string>; teamNames: ReadonlySet<string> },
): string[] {
  const errors: string[] = [];

  // Single namespace across telegram + slack: even though lane keys are
  // platform-scoped, an explicit `id: 'prod'` shared across platforms is a
  // foot-gun for future maintainers writing per-bot lookups. Reject up
  // front instead of waiting for someone to log just the `botKey` and
  // wonder why two bots collide.
  const seenIds = new Set<string>();

  const checkBind = (
    label: string,
    botId: string | undefined,
    bind: BotBinding,
    botKey: string,
  ): void => {
    if (botId !== undefined) rejectUnsafeIdent(`${label}.id`, botId, errors);
    rejectUnsafeIdent(`${label}.bind.name`, bind.name, errors);
    if (seenIds.has(botKey)) {
      errors.push(`${label}: duplicate botKey '${botKey}'. Set an explicit 'id:' to disambiguate.`);
    }
    seenIds.add(botKey);
    if (bind.type === 'personality' && !deps.personalityIds.has(bind.name)) {
      errors.push(
        `${label}: bind.name='${bind.name}' is not a known personality. ` +
          'Add the personality under ~/.ethos/personalities/, or fix the binding.',
      );
    }
    if (bind.type === 'team' && !deps.teamNames.has(bind.name)) {
      errors.push(
        `${label}: bind.name='${bind.name}' is not a known team. ` +
          `Add a team manifest at ~/.ethos/teams/${bind.name}.yaml, or fix the binding.`,
      );
    }
  };

  for (const [i, bot] of (config.telegram?.bots ?? []).entries()) {
    checkBind(`telegram.bots[${i}]`, bot.id, bot.bind, deriveBotKey(bot));
  }
  for (const [i, app] of (config.slack?.apps ?? []).entries()) {
    checkBind(`slack.apps[${i}]`, app.id, app.bind, deriveBotKey(app));
  }
  for (const [i, wa] of (config.whatsapp ?? []).entries()) {
    // WhatsApp bind is optional — skip entries without one. WhatsApp has no
    // token, so derive the botKey from the explicit id (positional fallback).
    if (!wa.bind) continue;
    checkBind(`whatsapp[${i}]`, wa.id, wa.bind, wa.id ?? `whatsapp[${i}]`);
  }
  for (const [i, vb] of (config.voice?.bots ?? []).entries()) {
    // Voice bots have no token — derive the botKey from the explicit id or the
    // room/number `match` seed (same primitive every adapter/config uses).
    checkBind(`voice.bots[${i}]`, vb.id, vb.bind, vb.id ?? deriveBotKeyFromSeed(vb.match));
  }
  for (const name of Object.keys(config.teams ?? {})) {
    rejectUnsafeIdent(`teams.<key>`, name, errors);
  }
  return errors;
}

function buildQuickCommands(
  kv: Record<string, Record<string, string>>,
): Record<string, QuickCommandConfig> | undefined {
  const result: Record<string, QuickCommandConfig> = {};
  for (const [name, fields] of Object.entries(kv)) {
    const channels = fields.channels
      ? fields.channels
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const shared = {
      ...(fields.gateway === 'true' ? { gateway: true } : {}),
      ...(channels && channels.length > 0 ? { channels } : {}),
    };
    if (fields.type === 'exec' && fields.command) {
      result[name] = { type: 'exec', command: fields.command, ...shared };
    } else if (fields.type === 'reply' && fields.reply) {
      result[name] = { type: 'reply', reply: fields.reply, ...shared };
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function buildChannelToolsets(kv: Record<string, string>): Record<string, string[]> | undefined {
  const result: Record<string, string[]> = {};
  for (const [platform, raw] of Object.entries(kv)) {
    const tools = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (tools.length > 0) result[platform] = tools;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * §7 — assemble per-model profile overrides from parsed flat keys. Numeric
 * fields are dropped when non-finite; `toolCallFormat` is dropped unless it is
 * a known enum value. A model key with no valid fields is omitted.
 */
function buildModelProfiles(
  kv: Record<string, Record<string, string>>,
): Record<string, ModelProfile> | undefined {
  const result: Record<string, ModelProfile> = {};
  for (const [modelKey, fields] of Object.entries(kv)) {
    const profile: ModelProfile = {};
    const sampling: Record<string, number> = {};
    for (const key of ['temperature', 'topP', 'topK', 'minP'] as const) {
      const raw = fields[`sampling.${key}`];
      if (raw === undefined) continue;
      const n = Number(raw);
      if (Number.isFinite(n)) sampling[key] = n;
    }
    if (Object.keys(sampling).length > 0) profile.sampling = sampling;
    if (fields.toolCallFormat === 'openai' || fields.toolCallFormat === 'text-xml') {
      profile.toolCallFormat = fields.toolCallFormat;
    }
    if (fields.maxOutputTokens !== undefined) {
      const n = Number(fields.maxOutputTokens);
      if (Number.isFinite(n)) profile.maxOutputTokens = n;
    }
    if (Object.keys(profile).length > 0) result[modelKey] = profile;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * §5 — assemble the global compaction thresholds from parsed flat keys.
 * `pressure`/`target` are kept only when they parse to a finite fraction in
 * (0,1]; out-of-range or non-numeric values are dropped. Returns `undefined`
 * when neither field survives, so the gate falls back to its 0.8/0.7 defaults.
 */
function buildCompaction(kv: Record<string, string>): EthosConfig['compaction'] | undefined {
  const result: NonNullable<EthosConfig['compaction']> = {};
  for (const key of ['pressure', 'target'] as const) {
    const raw = kv[key];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && n <= 1) result[key] = n;
  }
  // Phase 1c — gateDelta is a token headroom (non-negative integer), not a
  // fraction; validated on a different range from pressure/target.
  const rawDelta = kv.gateDelta;
  if (rawDelta !== undefined) {
    const d = Number(rawDelta);
    if (Number.isFinite(d) && d >= 0) result.gateDelta = Math.floor(d);
  }
  // Phase 3 — boolean flags for the turn-end trigger + overflow-retry.
  if (kv.autoCompact === 'true') result.autoCompact = true;
  else if (kv.autoCompact === 'false') result.autoCompact = false;
  if (kv.retryOnOverflow === 'true') result.retryOnOverflow = true;
  else if (kv.retryOnOverflow === 'false') result.retryOnOverflow = false;
  // Item 7 — surface a failed emergency summary as its own error instead of
  // masking it as the generic overflow rejection. Default off.
  if (kv.abortOnSummaryFailure === 'true') result.abortOnSummaryFailure = true;
  else if (kv.abortOnSummaryFailure === 'false') result.abortOnSummaryFailure = false;
  // Phase 4 — small-window-mode override (auto | on | off).
  if (kv.smallWindow === 'auto' || kv.smallWindow === 'on' || kv.smallWindow === 'off') {
    result.smallWindow = kv.smallWindow;
  }
  // Item 7 — absolute ceiling (positive integer tokens) + guaranteed user tail
  // (non-negative integer). Out-of-range values are dropped, as above.
  const rawCeiling = kv.maxContextTokens;
  if (rawCeiling !== undefined) {
    const c = Number(rawCeiling);
    if (Number.isFinite(c) && c > 0) result.maxContextTokens = Math.floor(c);
  }
  const rawTail = kv.minTailUserMessages;
  if (rawTail !== undefined) {
    const t = Number(rawTail);
    if (Number.isFinite(t) && t >= 0) result.minTailUserMessages = Math.floor(t);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Tool-loop soft-warn tiers from the flat `toolLoop.<field>` keys. Positive
 * integers — `0` would nudge on every turn before a single tool ran, which is a
 * typo, not a setting. Returns `undefined` when nothing survives, leaving the
 * loop with no warn tier at all.
 */
function buildToolLoop(kv: Record<string, string>): EthosConfig['toolLoop'] | undefined {
  const result: NonNullable<EthosConfig['toolLoop']> = {};
  for (const key of ['maxToolCallsWarnAt', 'maxIdenticalToolCallsWarnAt'] as const) {
    const raw = kv[key];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) result[key] = Math.floor(n);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Playwright timeouts from the flat `browser.<field>` keys. Bounded to
 * 1s–10min: below a second no page load completes, and past ten minutes the
 * tool's own result budget has long since become the real limit. Out-of-range
 * values are dropped, leaving the call sites on their built-in defaults.
 */
function buildBrowser(kv: Record<string, string>): EthosConfig['browser'] | undefined {
  const result: NonNullable<EthosConfig['browser']> = {};
  for (const key of ['navigationTimeoutMs', 'commandTimeoutMs'] as const) {
    const raw = kv[key];
    if (raw === undefined) continue;
    const n = parseBoundedInt(raw, 1_000, 600_000);
    if (n !== undefined) result[key] = n;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Gateway-wide knobs from the flat `gateway.<field>` keys.
 * `maxInboundMediaBytes` is bounded to 1 KiB–128 MiB: smaller than a kilobyte
 * rejects every real attachment, and every adapter buffers the whole download
 * in memory (`arrayBuffer()`), so the ceiling is what a Node heap can hold from
 * an untrusted sender — 128 MiB is over 5x the largest per-adapter default
 * (25 MB) and above every platform's own attachment limit. Out-of-range values
 * are dropped, leaving each adapter on its own platform default.
 */
function buildGateway(kv: Record<string, string>): EthosConfig['gateway'] | undefined {
  const raw = kv.maxInboundMediaBytes;
  if (raw === undefined) return undefined;
  const n = parseBoundedInt(raw, 1024, 134_217_728);
  return n === undefined ? undefined : { maxInboundMediaBytes: n };
}

/**
 * Member auto-restart brake from the flat
 * `teamSupervisor.restartLoopGuard.<field>` keys. Both are positive integers —
 * `0` restarts would mean `auto_restart: true` never restarts anything, which
 * is what `auto_restart: false` already says. Returns `undefined` when nothing
 * survives, leaving the supervisor on its 5-restarts-in-60s defaults.
 */
function buildRestartLoopGuard(
  kv: Record<string, string>,
): NonNullable<EthosConfig['teamSupervisor']>['restartLoopGuard'] | undefined {
  const result: NonNullable<NonNullable<EthosConfig['teamSupervisor']>['restartLoopGuard']> = {};
  const maxRestarts = kv.maxRestarts;
  if (maxRestarts !== undefined) {
    const n = parseBoundedInt(maxRestarts, 1, 1000);
    if (n !== undefined) result.maxRestarts = n;
  }
  const windowSeconds = kv.windowSeconds;
  if (windowSeconds !== undefined) {
    const n = parseBoundedInt(windowSeconds, 1, 86_400);
    if (n !== undefined) result.windowSeconds = n;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Discord channel-history backfill from the flat
 * `discord.missedMessageBackfill.<field>` keys. `limit` stops at 100 because
 * that is Discord's own `messages.fetch` ceiling — asking for more is an error
 * at the API, not a bigger read. Returns `undefined` when nothing survives, so
 * the adapter keeps today's unbounded-window, 50-message behaviour.
 */
function buildDiscordBackfill(
  kv: Record<string, string>,
): NonNullable<EthosConfig['discord']>['missedMessageBackfill'] | undefined {
  const result: NonNullable<NonNullable<EthosConfig['discord']>['missedMessageBackfill']> = {};
  if (kv.enabled === 'true') result.enabled = true;
  else if (kv.enabled === 'false') result.enabled = false;
  const windowSeconds = kv.windowSeconds;
  if (windowSeconds !== undefined) {
    const n = parseBoundedInt(windowSeconds, 1, 604_800);
    if (n !== undefined) result.windowSeconds = n;
  }
  const limit = kv.limit;
  if (limit !== undefined) {
    const n = parseBoundedInt(limit, 1, 100);
    if (n !== undefined) result.limit = n;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Board WIP caps from the flat `kanban.<field>` keys. Both are positive
 * integers — `0` would mean "no task may ever run", which is a typo, not a
 * setting, so it is dropped along with negatives and non-numerics. Returns
 * `undefined` when nothing survives, leaving the board uncapped.
 */
function buildKanban(kv: Record<string, string>): EthosConfig['kanban'] | undefined {
  const result: NonNullable<EthosConfig['kanban']> = {};
  for (const key of ['maxInProgress', 'maxInProgressPerProfile'] as const) {
    const raw = kv[key];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) result[key] = Math.floor(n);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Phase 3 — assemble the memory-consolidation (silent flush) config from parsed
 * flat keys. `flushThreshold` is a fraction in (0,1]; the caps are non-negative
 * integers. Returns `undefined` when nothing survives so the loop stays opt-out.
 */
function buildMemoryConsolidation(
  kv: Record<string, string>,
): EthosConfig['memoryConsolidation'] | undefined {
  const result: NonNullable<EthosConfig['memoryConsolidation']> = {};
  if (kv.enabled === 'true') result.enabled = true;
  else if (kv.enabled === 'false') result.enabled = false;
  const threshold = kv.flushThreshold;
  if (threshold !== undefined) {
    const n = Number(threshold);
    if (Number.isFinite(n) && n > 0 && n <= 1) result.flushThreshold = n;
  }
  for (const key of ['timeboxMs', 'maxTokens', 'maxDeltaChars', 'minMessagesSinceFlush'] as const) {
    const raw = kv[key];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) result[key] = Math.floor(n);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Assemble the scale-to-zero idle-watcher config from parsed flat keys.
 * Returns `undefined` when nothing survives, so the watcher stays off.
 *
 * Both booleans are parsed STRICTLY — only a literal `true` is true. A typo
 * must never arm the watcher, and `wakePathConfirmed` is an operator
 * attestation, not a guess.
 *
 * The three `*Ms` keys require a POSITIVE integer. A blank value
 * (`idleThresholdMs: ""`, or a key whose value is only whitespace) is a typo,
 * and `Number('')` is `0` — which here would mean a zero-length idle threshold
 * or a zero cooldown, i.e. exit on the first sample. Treat blank as absent so
 * the manager default applies. (Unlike `approvalTimeoutMs`, `0` is meaningless
 * for all three, so it is rejected rather than honoured.)
 */
function buildIdleWatcher(kv: Record<string, string>): EthosConfig['idleWatcher'] | undefined {
  const result: NonNullable<EthosConfig['idleWatcher']> = {};
  if (kv.enabled !== undefined) result.enabled = kv.enabled === 'true';
  if (kv.wakePathConfirmed !== undefined)
    result.wakePathConfirmed = kv.wakePathConfirmed === 'true';
  for (const key of ['idleThresholdMs', 'startupCooldownMs', 'checkIntervalMs'] as const) {
    const raw = kv[key];
    if (raw === undefined || raw.trim() === '') continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) result[key] = n;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Parse `pauseClockCorrection.<field>` (plan/phases/clock-tolerance-pass.md §7).
 * Returns undefined when the section is absent so `enabled` stays false by
 * omission — an absent section must mean today's behaviour, byte for byte.
 * A blank or non-positive `thresholdMs` is treated as absent so the detector's
 * own default applies, the same hazard `buildIdleWatcher` guards against.
 */
function buildPauseClockCorrection(
  kv: Record<string, string>,
): EthosConfig['pauseClockCorrection'] | undefined {
  const result: NonNullable<EthosConfig['pauseClockCorrection']> = {};
  if (kv.enabled !== undefined) result.enabled = kv.enabled === 'true';
  const raw = kv.thresholdMs;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) result.thresholdMs = n;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Parse `pauseLifecycle.http.<field>`. Returns undefined when the section is
 * absent so an absent section behaves identically to before the feature
 * existed — same contract as `buildPauseClockCorrection` above.
 */
function buildPauseLifecycleHttp(
  kv: Record<string, string>,
): NonNullable<EthosConfig['pauseLifecycle']>['http'] | undefined {
  const result: NonNullable<NonNullable<EthosConfig['pauseLifecycle']>['http']> = {};
  if (kv.url) result.url = kv.url;
  if (kv.token) result.token = kv.token;
  const raw = kv.timeoutMs;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) result.timeoutMs = n;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function buildChannelFilter(
  kv: Record<string, Record<string, string>>,
): ChannelFilterConfig | undefined {
  const platforms = Object.keys(kv);
  if (platforms.length === 0) return undefined;
  const out: ChannelFilterConfig = {};
  for (const platform of platforms) {
    const entry = kv[platform];
    if (!entry) continue;
    const cfg: ChannelPlatformConfig = {};
    if (entry.enable === 'false') cfg.enabled = false;
    else if (entry.enable === 'true') cfg.enabled = true;
    if (entry.ownerUserId) cfg.ownerUserId = entry.ownerUserId;
    if (entry.recipientAllowlist) {
      cfg.recipientAllowlist = entry.recipientAllowlist
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (
      entry.dmPolicy === 'pairing' ||
      entry.dmPolicy === 'allowlist' ||
      entry.dmPolicy === 'queue' ||
      entry.dmPolicy === 'reject' ||
      entry.dmPolicy === 'silent-drop'
    ) {
      cfg.dmPolicy = entry.dmPolicy;
    }
    if (
      entry.contextVisibility === 'all' ||
      entry.contextVisibility === 'allowlist' ||
      entry.contextVisibility === 'allowlist_quote'
    ) {
      cfg.contextVisibility = entry.contextVisibility;
    }
    out[platform] = cfg;
  }
  return out;
}

function buildPersonalitiesConfig(
  kv: Record<string, Record<string, string>>,
): Record<string, { retention?: RetentionConfig }> | undefined {
  if (Object.keys(kv).length === 0) return undefined;
  const out: Record<string, { retention?: RetentionConfig }> = {};
  for (const [pid, retKv] of Object.entries(kv)) {
    const retention = buildRetentionConfig(retKv);
    if (retention) out[pid] = { retention };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Serialize a RetentionConfig to dotted key-value pairs. */
function retentionToLines(cfg: RetentionConfig): Array<[string, string]> {
  const lines: Array<[string, string]> = [];
  if (cfg.messages) lines.push(['messages', cfg.messages]);
  if (cfg.traces) lines.push(['traces', cfg.traces]);
  if (cfg.spans) lines.push(['spans', cfg.spans]);
  if (cfg.blobs) lines.push(['blobs', cfg.blobs]);
  if (cfg.archive) lines.push(['archive', cfg.archive]);
  if (cfg.events) {
    if (cfg.events.error) lines.push(['events.error', cfg.events.error]);
    if (cfg.events.audit) lines.push(['events.audit', cfg.events.audit]);
    if (cfg.events.channel) lines.push(['events.channel', cfg.events.channel]);
    if (cfg.events.install) lines.push(['events.install', cfg.events.install]);
  }
  if (cfg.vacuumAfterPrune !== undefined) {
    lines.push(['vacuumAfterPrune', String(cfg.vacuumAfterPrune)]);
  }
  if (cfg.minVacuumIntervalDays !== undefined) {
    lines.push(['minVacuumIntervalDays', String(cfg.minVacuumIntervalDays)]);
  }
  return lines;
}

/**
 * Serialize the `background:` section to flat `[key, value]` pairs, emitting
 * only fields actually present on the config so parse→serialize→parse round-
 * trips are stable (absent fields fall back to `backgroundDefaults()`, never
 * written out).
 */
function backgroundToLines(bg: BackgroundConfig): Array<[string, string]> {
  const lines: Array<[string, string]> = [];
  if (bg.enabled !== undefined) lines.push(['enabled', String(bg.enabled)]);
  if (bg.maxConcurrentJobs !== undefined)
    lines.push(['max_concurrent_jobs', String(bg.maxConcurrentJobs)]);
  if (bg.maxJobsPerRoot !== undefined) lines.push(['max_jobs_per_root', String(bg.maxJobsPerRoot)]);
  if (bg.maxJobsPerPersonality !== undefined)
    lines.push(['max_jobs_per_personality', String(bg.maxJobsPerPersonality)]);
  if (bg.defaultMaxCostUsd !== undefined)
    lines.push(['default_max_cost_usd', String(bg.defaultMaxCostUsd)]);
  if (bg.maxRootBackgroundUsd !== undefined)
    lines.push(['max_root_background_usd', String(bg.maxRootBackgroundUsd)]);
  if (bg.queuedTtlMs !== undefined) lines.push(['queued_ttl_ms', String(bg.queuedTtlMs)]);
  if (bg.staleMs !== undefined) lines.push(['stale_ms', String(bg.staleMs)]);
  if (bg.heartbeatMs !== undefined) lines.push(['heartbeat_ms', String(bg.heartbeatMs)]);
  if (bg.retentionDays !== undefined) lines.push(['retention_days', String(bg.retentionDays)]);
  return lines;
}
