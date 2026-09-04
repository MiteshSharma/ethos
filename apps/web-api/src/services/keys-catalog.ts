// Static declarative catalog of the credentials the Keys settings pane knows
// about, by vault ref. Pure data — no I/O, no state. `KeysService` reads it and
// partitions the vault against it.
//
// Refs are VAULT refs (slash-separated), not config keys (dot-separated). A
// config key like `auxiliary.compression.apiKey` is minted into the vault as
// `auxiliary/compression/apiKey` by `secretRefForConfigKey` in
// `@ethosagent/config` — that slash form is what `SecretsResolver.list()`
// returns and what belongs here.
//
// Deliberately ABSENT:
//   • LLM provider keys (`providers/<name>/apiKey` for anthropic, openai-as-a-
//     model-provider, …) — they stay exclusively in the Models pane. A second
//     write path onto the same refs is how two UIs start disagreeing.
//   • Memory backends — none needs an external key, and an always-empty
//     category is worse than no category.

import type { KeyCategoryId } from '@ethosagent/web-contracts';

/** How an entry's value(s) map onto vault refs. */
export type KeyFieldShape =
  /** One ref holding one value. `field` names it for the form. */
  | { kind: 'single'; field: string }
  /** One credential spread over sibling refs under `refPattern`. */
  | { kind: 'multi'; fields: { key: string; label: string; refSuffix: string }[] }
  /** One ref holding a structured document (e.g. an OAuth token set). Never
   *  writable through this service — see `KeysService.set`. */
  | { kind: 'blob'; parse: (raw: string) => Record<string, unknown> | null };

/** The canonical category list lives in `@ethosagent/web-contracts`
 *  (`KEY_CATEGORY_IDS`) — the one definition the contract enum, this catalog,
 *  `KeysService`'s emit order and the web app's settings taxonomy all derive
 *  from. Adding a category is a one-line edit there. */
export type KeyCategory = KeyCategoryId;

export interface KeyCatalogEntry {
  /** Stable id — what `set`/`clear` address. */
  id: string;
  category: KeyCategory;
  label: string;
  /** Vault ref for a `single`/`blob` entry; the parent prefix for a `multi`. */
  refPattern: string;
  shape: KeyFieldShape;
  /** Where the operator goes to obtain this credential. */
  getKeyUrl?: string;
  /** Closed union — only these three have a real live probe today
   *  (`NamedSecretsService.testKey`). Adding others is an explicit non-goal. */
  probe?: 'exa' | 'tavily' | 'brave';
  /** `refPattern` carries a `<n>` placeholder standing for ONE ref segment —
   *  a per-bot key, a per-app key, a roster entry name, a webhook id. The
   *  entry is expanded by `expandEntry` against what `secrets.list()` actually
   *  returns, never against a guessed array length: the segment is a
   *  `deriveBotKey` hash as often as it is `0`, and the indices present are
   *  frequently non-contiguous (delete bot 1 of three and `0` and `2` remain).
   *  An index with no ref in the vault yields no row — there is nothing to
   *  show — and every matching ref yields exactly one, so the partition holds. */
  indexed?: boolean;
  /** Read-only mirror of a `NamedSecretsService` entry. The value is owned by
   *  the named-secrets vault manager and edited from the Security pane;
   *  `set`/`clear` here reject. */
  reflectsNamedSecret?: boolean;
}

/**
 * The `blob` parse for `providers/codex/tokens` — an ALLOWLIST, and the whole
 * reason `blob` exists as a shape.
 *
 * The stored document is `JSON.stringify(CodexCredentials)`
 * (`extensions/llm-codex/src/token-store.ts`), which today carries
 * `accessToken`, `refreshToken`, `idToken`, `accountId`, `expiresAt` and
 * `updatedAt`. Three of those are bearer credentials. This function names the
 * two that are safe to show and returns nothing else, so a field added to
 * `CodexCredentials` tomorrow is invisible here by default rather than
 * surfaced by default — the failure mode of a denylist.
 *
 * It is the FIRST of three gates on the same two fields, and not the only one:
 * `BLOB_DETAIL_KEYS` in `keys.service.ts` filters again on the way out, and
 * `KeyBlobDetailsSchema` in `packages/web-contracts/src/router.ts` is a closed
 * schema that REJECTS an unknown key at the contract boundary. That last gate
 * is what makes a refactor of this function unable to leak on its own.
 */
export function parseCodexTokens(raw: string): Record<string, unknown> | null {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof doc !== 'object' || doc === null) return null;
  const record = doc as Record<string, unknown>;
  const accountId = record.accountId;
  const expiresAt = record.expiresAt;
  const out: Record<string, unknown> = {};
  if (typeof accountId === 'string') out.accountId = accountId;
  if (typeof expiresAt === 'string') out.expiresAt = expiresAt;
  return Object.keys(out).length > 0 ? out : null;
}

export const KEY_CATALOG: readonly KeyCatalogEntry[] = [
  // --- Tools -------------------------------------------------------------
  {
    id: 'tools.exa',
    category: 'tools',
    label: 'Exa',
    refPattern: 'providers/exa/apiKey',
    shape: { kind: 'single', field: 'apiKey' },
    getKeyUrl: 'https://dashboard.exa.ai/api-keys',
    probe: 'exa',
    reflectsNamedSecret: true,
  },
  {
    id: 'tools.tavily',
    category: 'tools',
    label: 'Tavily',
    refPattern: 'providers/tavily/apiKey',
    shape: { kind: 'single', field: 'apiKey' },
    getKeyUrl: 'https://app.tavily.com/home',
    probe: 'tavily',
    reflectsNamedSecret: true,
  },
  {
    id: 'tools.brave',
    category: 'tools',
    label: 'Brave Search',
    refPattern: 'providers/brave/apiKey',
    shape: { kind: 'single', field: 'apiKey' },
    getKeyUrl: 'https://brave.com/search/api/',
    probe: 'brave',
    reflectsNamedSecret: true,
  },
  {
    // One key, two consumers: the `x_search` tool and the Grok LLM provider.
    // It stays under `tools` rather than moving or being duplicated — a second
    // row against the same ref is a second write path, which the header note
    // above rules out, and `tools.openai` below is the same shape already
    // (`providers/openai/apiKey` serves image generation and the OpenAI
    // provider). The Models pane edits the provider side; this row is the
    // tool-side view of the same credential.
    id: 'tools.xai',
    category: 'tools',
    label: 'xAI (Grok + X search)',
    refPattern: 'providers/xai/apiKey',
    shape: { kind: 'single', field: 'apiKey' },
    getKeyUrl: 'https://console.x.ai/',
  },
  {
    id: 'tools.reddit',
    category: 'tools',
    label: 'Reddit',
    refPattern: 'providers/reddit',
    shape: {
      kind: 'multi',
      fields: [
        { key: 'clientId', label: 'Client ID', refSuffix: 'client_id' },
        { key: 'clientSecret', label: 'Client secret', refSuffix: 'client_secret' },
      ],
    },
    getKeyUrl: 'https://www.reddit.com/prefs/apps',
  },
  {
    id: 'tools.openai',
    category: 'tools',
    label: 'OpenAI (image generation)',
    refPattern: 'providers/openai/apiKey',
    shape: { kind: 'single', field: 'apiKey' },
    getKeyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'tools.replicate',
    category: 'tools',
    label: 'Replicate (image generation)',
    refPattern: 'providers/replicate/apiToken',
    shape: { kind: 'single', field: 'apiToken' },
    getKeyUrl: 'https://replicate.com/account/api-tokens',
  },

  // --- Voice -------------------------------------------------------------
  // Refs verified against `externalizeConfigSecrets` in @ethosagent/config:
  // the three rosters go through `voice.<kind>.providers.<name>.apiKey` and
  // land on `voice/<kind>/providers/<name>/apiKey`; the roster key IS the ref
  // segment, so `<n>` here is a provider NAME, not a number.
  {
    id: 'voice.tts',
    category: 'voice',
    label: 'Text-to-speech provider',
    refPattern: 'voice/tts/providers/<n>/apiKey',
    shape: { kind: 'single', field: 'apiKey' },
    indexed: true,
  },
  {
    id: 'voice.stt',
    category: 'voice',
    label: 'Speech-to-text provider',
    refPattern: 'voice/stt/providers/<n>/apiKey',
    shape: { kind: 'single', field: 'apiKey' },
    indexed: true,
  },
  {
    id: 'voice.realtime',
    category: 'voice',
    label: 'Realtime voice provider',
    refPattern: 'voice/realtime/providers/<n>/apiKey',
    shape: { kind: 'single', field: 'apiKey' },
    indexed: true,
  },
  {
    // `voice.livekit` validation requires url + apiKey + apiSecret together,
    // so the pair is genuinely one credential — hence `multi`.
    id: 'voice.livekit',
    category: 'voice',
    label: 'LiveKit',
    refPattern: 'voice/livekit',
    shape: {
      kind: 'multi',
      fields: [
        { key: 'apiKey', label: 'API key', refSuffix: 'apiKey' },
        { key: 'apiSecret', label: 'API secret', refSuffix: 'apiSecret' },
      ],
    },
    getKeyUrl: 'https://cloud.livekit.io/',
  },
  {
    // The leaf is `webhookSecret`, NOT `webhookSecretToken` — that name belongs
    // to Telegram. `VoiceTrunkConfig.webhookSecret` reaches the vault through
    // the catch-all leaf rule (`EXTRA_SECRET_LEAVES` has `secret`), giving
    // `voice/trunk/webhookSecret`.
    id: 'voice.trunk',
    category: 'voice',
    label: 'SIP trunk',
    refPattern: 'voice/trunk',
    shape: {
      kind: 'multi',
      fields: [
        { key: 'password', label: 'Trunk password', refSuffix: 'password' },
        { key: 'webhookSecret', label: 'Webhook secret', refSuffix: 'webhookSecret' },
      ],
    },
  },

  // --- Gateway -----------------------------------------------------------
  // The single-bot refs come from `STATIC_SECRET_REFS`, which renames them:
  // `telegramToken` -> `telegram/token`, `slackBotToken` -> `slack/botToken`,
  // `emailPassword` -> `email/password`. The flat config key is NOT the ref.
  {
    id: 'gateway.telegram',
    category: 'gateway',
    label: 'Telegram bot token',
    refPattern: 'telegram/token',
    shape: { kind: 'single', field: 'token' },
    getKeyUrl: 'https://core.telegram.org/bots#botfather',
  },
  {
    // `INDEXED_SECRET_REFS` keys these by the bot's stable `deriveBotKey`
    // when one is available and by the array index otherwise, so the segment
    // is opaque — expanded, never enumerated.
    id: 'gateway.telegram.bot',
    category: 'gateway',
    label: 'Telegram bot',
    refPattern: 'telegram/bots/<n>',
    shape: {
      kind: 'multi',
      fields: [
        { key: 'token', label: 'Bot token', refSuffix: 'token' },
        {
          key: 'webhookSecretToken',
          label: 'Webhook secret token',
          refSuffix: 'webhookSecretToken',
        },
      ],
    },
    indexed: true,
  },
  {
    id: 'gateway.discord',
    category: 'gateway',
    label: 'Discord bot token',
    refPattern: 'discord/token',
    shape: { kind: 'single', field: 'token' },
    getKeyUrl: 'https://discord.com/developers/applications',
  },
  {
    id: 'gateway.slack',
    category: 'gateway',
    label: 'Slack',
    refPattern: 'slack',
    shape: {
      kind: 'multi',
      fields: [
        { key: 'botToken', label: 'Bot token', refSuffix: 'botToken' },
        { key: 'appToken', label: 'App token', refSuffix: 'appToken' },
        { key: 'signingSecret', label: 'Signing secret', refSuffix: 'signingSecret' },
      ],
    },
    getKeyUrl: 'https://api.slack.com/apps',
  },
  {
    id: 'gateway.slack.app',
    category: 'gateway',
    label: 'Slack app',
    refPattern: 'slack/apps/<n>',
    shape: {
      kind: 'multi',
      fields: [
        { key: 'botToken', label: 'Bot token', refSuffix: 'botToken' },
        { key: 'appToken', label: 'App token', refSuffix: 'appToken' },
        { key: 'signingSecret', label: 'Signing secret', refSuffix: 'signingSecret' },
      ],
    },
    indexed: true,
  },
  {
    id: 'gateway.email',
    category: 'gateway',
    label: 'Email password',
    refPattern: 'email/password',
    shape: { kind: 'single', field: 'password' },
  },
  {
    // `webhooks.<hookId>.secret` reaches the vault through the catch-all leaf
    // rule, so `<n>` is the operator's own hook id.
    id: 'gateway.webhook',
    category: 'gateway',
    label: 'Inbound webhook secret',
    refPattern: 'webhooks/<n>/secret',
    shape: { kind: 'single', field: 'secret' },
    indexed: true,
  },

  // --- Settings ----------------------------------------------------------
  {
    id: 'settings.auxiliary.compression',
    category: 'settings',
    label: 'Auxiliary — compression',
    refPattern: 'auxiliary/compression/apiKey',
    shape: { kind: 'single', field: 'apiKey' },
  },
  {
    id: 'settings.auxiliary.vision',
    category: 'settings',
    label: 'Auxiliary — vision',
    refPattern: 'auxiliary/vision/apiKey',
    shape: { kind: 'single', field: 'apiKey' },
  },
  {
    id: 'settings.auxiliary.web',
    category: 'settings',
    label: 'Auxiliary — web',
    refPattern: 'auxiliary/web/apiKey',
    shape: { kind: 'single', field: 'apiKey' },
  },
  {
    id: 'settings.auxiliary.asr',
    category: 'settings',
    label: 'Auxiliary — speech-to-text',
    refPattern: 'auxiliary/asr/apiKey',
    shape: { kind: 'single', field: 'apiKey' },
  },
  {
    id: 'settings.auxiliary.tts',
    category: 'settings',
    label: 'Auxiliary — text-to-speech',
    refPattern: 'auxiliary/tts/apiKey',
    shape: { kind: 'single', field: 'apiKey' },
  },
  {
    id: 'settings.langfuse',
    category: 'settings',
    label: 'Langfuse export secret key',
    refPattern: 'telemetry/export/langfuse/secretKey',
    shape: { kind: 'single', field: 'secretKey' },
  },
  {
    id: 'settings.pauseLifecycle',
    category: 'settings',
    label: 'Pause-lifecycle orchestrator token',
    refPattern: 'pauseLifecycle/http/token',
    shape: { kind: 'single', field: 'token' },
  },
  {
    id: 'settings.memoryCapture',
    category: 'settings',
    label: 'Memory capture',
    refPattern: 'memoryCapture/apiKey',
    shape: { kind: 'single', field: 'apiKey' },
  },

  // --- Connections -------------------------------------------------------
  {
    // Written by the CLI device-auth flow (`CodexTokenStore.save`), never by a
    // form — hence `blob`, which `KeysService.set` refuses. `CodexTokenStore`
    // has no `revoke()`, so the only honest action is deleting the local
    // document: "Disconnect", not "Revoke". Nothing is revoked upstream.
    id: 'connections.codex',
    category: 'connections',
    label: 'Codex (ChatGPT sign-in)',
    refPattern: 'providers/codex/tokens',
    shape: { kind: 'blob', parse: parseCodexTokens },
  },
];

/** Every vault ref a catalog entry claims. A ref claimed here is NOT a custom
 *  ref, whether or not it currently holds a value. */
export function refsForEntry(entry: KeyCatalogEntry): string[] {
  if (entry.shape.kind === 'multi') {
    return entry.shape.fields.map((f) => `${entry.refPattern}/${f.refSuffix}`);
  }
  return [entry.refPattern];
}

/** The one ref segment an `indexed` entry does not know until it reads the
 *  vault: a bot key, an app key, a roster provider name, a webhook id. */
const INDEX_PLACEHOLDER = '<n>';

/**
 * Expand one catalog entry into the concrete entries the vault actually holds.
 *
 * A non-indexed entry is itself, always — an unset credential still deserves a
 * row saying so. An indexed entry is expanded ONLY against `refs`: the segment
 * is opaque (a `deriveBotKey` hash as often as an array index) and the indices
 * present are routinely non-contiguous, so there is no length to count up to
 * and guessing one would either invent empty rows or hide real keys.
 */
export function expandEntry(entry: KeyCatalogEntry, refs: readonly string[]): KeyCatalogEntry[] {
  if (!entry.indexed) return [entry];
  const patterns = refsForEntry(entry).map(patternToRegExp);
  const indices = new Set<string>();
  for (const ref of refs) {
    for (const pattern of patterns) {
      const index = ref.match(pattern)?.[1];
      if (index !== undefined) indices.add(index);
    }
  }
  return [...indices].sort().map((index) => ({
    ...entry,
    indexed: false,
    id: `${entry.id}.${index}`,
    label: `${entry.label} — ${index}`,
    refPattern: entry.refPattern.split(INDEX_PLACEHOLDER).join(index),
  }));
}

/** `telegram/bots/<n>/token` → /^telegram\/bots\/([^\/]+)\/token$/. The
 *  capture is one segment, so a deeper ref can never masquerade as an index. */
function patternToRegExp(pattern: string): RegExp {
  const parts = pattern.split(INDEX_PLACEHOLDER).map(escapeRegExp);
  return new RegExp(`^${parts.join('([^/]+)')}$`);
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
