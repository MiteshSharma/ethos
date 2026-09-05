import { join } from 'node:path';
import { secretRefFromValue } from '@ethosagent/config';
import { deriveBotKey } from '@ethosagent/core';
import type { SecretsResolver, Storage } from '@ethosagent/types';
import type {
  BotBinding,
  ChannelPlatformFilter,
  PlatformId,
  PlatformStatus,
  SlackAppEntry,
  TelegramBotEntry,
  WhatsAppChannelMode,
  WhatsAppEntry,
} from '@ethosagent/web-contracts';
import { WhatsAppChannelModeSchema } from '@ethosagent/web-contracts';
import type { ConfigRepository, RawConfig } from './config.repository';

// Per-platform connection inventory + setup over the same
// ~/.ethos/config.yaml the gateway reads. Keys are flat
// (telegramToken, slackBotToken, …); the repository owns the per-
// platform field-name mapping so the service never knows about it.
//
// Secret-shaped fields (tokens, passwords, signing secrets) round
// through the injected SecretsResolver: the plaintext lands in
// ~/.ethos/secrets/<ref>, and the passthrough YAML stores only
// `${secrets:<ref>}`. The gateway's resolveConfigSecrets() inlines
// these at boot. Non-secret fields (imap host/port, user) stay as
// plaintext in passthrough — they aren't sensitive.
//
// Sensitive values never leave this layer — the repository only emits
// PlatformStatus { configured, fields: { name → bool } } and never
// returns raw token values to callers.

/**
 * The stored `default_mode` string, narrowed to the modes the adapter and the
 * wire schema BOTH accept.
 *
 * Parsed against the schema rather than compared against a hand-written pair.
 * The two-value version of this line (`=== 'all' ? 'all' : 'mention_only'`)
 * type-checked forever while quietly rewriting every `observe` bot into a
 * `mention_only` one on the way to the Platforms table — a display that
 * contradicted the config file it claimed to be showing. Widening the enum in
 * `@ethosagent/web-contracts` now widens this too, because there is one list.
 *
 * An unrecognised value falls back to `mention_only`: the config validator
 * rejects those at startup, so anything reaching here is hand-edited garbage,
 * and the quiet mode is the safe guess for garbage.
 */
function whatsAppMode(raw: string | undefined): WhatsAppChannelMode {
  const parsed = WhatsAppChannelModeSchema.safeParse(raw);
  return parsed.success ? parsed.data : 'mention_only';
}

interface PlatformDefinition {
  /** Form field names the UI uses. */
  fields: readonly string[];
  /** Field name → flat key in config.yaml. */
  toConfigKey: Record<string, string>;
  /** Field name → secret ref path (under ~/.ethos/secrets/). Fields
   *  not listed here are stored as plaintext in passthrough. */
  secretRef: Record<string, string>;
}

const PLATFORMS: Record<PlatformId, PlatformDefinition> = {
  telegram: {
    fields: ['token'],
    toConfigKey: { token: 'telegramToken' },
    secretRef: { token: 'telegram/token' },
  },
  discord: {
    fields: ['token'],
    toConfigKey: { token: 'discordToken' },
    secretRef: { token: 'discord/token' },
  },
  slack: {
    fields: ['botToken', 'appToken', 'signingSecret'],
    toConfigKey: {
      botToken: 'slackBotToken',
      appToken: 'slackAppToken',
      signingSecret: 'slackSigningSecret',
    },
    secretRef: {
      botToken: 'slack/botToken',
      appToken: 'slack/appToken',
      signingSecret: 'slack/signingSecret',
    },
  },
  email: {
    fields: ['imapHost', 'imapPort', 'user', 'password', 'smtpHost', 'smtpPort'],
    toConfigKey: {
      imapHost: 'emailImapHost',
      imapPort: 'emailImapPort',
      user: 'emailUser',
      password: 'emailPassword',
      smtpHost: 'emailSmtpHost',
      smtpPort: 'emailSmtpPort',
    },
    secretRef: {
      password: 'email/password',
    },
  },
  // WhatsApp pairs via QR code (handled by setup-whatsapp.ts SSE), not
  // config-form fields — so it has no settable secret fields here. The
  // entry exists only to satisfy Record<PlatformId, …>; whatsapp is not in
  // ALL_PLATFORM_IDS, so listStatus() never enumerates it.
  whatsapp: {
    fields: [],
    toConfigKey: {},
    secretRef: {},
  },
};

const ALL_PLATFORM_IDS: readonly PlatformId[] = [
  'telegram',
  'slack',
  'discord',
  'email',
  'whatsapp',
] as const;

// Sentinel botKey for the synthesized legacy single-bot entries
// (telegramToken / slack*Token triple). The Communications tab can
// pass this through removeTelegramBot / removeSlackApp and the
// repository routes it back to the legacy `clear()` path. Distinct
// from any sha256 prefix (length ≠ 24).
const LEGACY_TELEGRAM_BOT_KEY = 'legacy-telegram';
const LEGACY_SLACK_BOT_KEY = 'legacy-slack';

// Mirrors sanitizeBotKey in extensions/platform-whatsapp/src/session-store.ts —
// the Baileys session dir for a bot is `<sessionDir>/<sanitized botKey>/`.
function sanitizeBotKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export interface PlatformsRepositoryOptions {
  config: ConfigRepository;
  secrets: SecretsResolver;
  /** `~/.ethos` root. Used to resolve the default WhatsApp session dir
   *  (`<dataDir>/whatsapp/`) when an entry sets no `session_dir`. */
  dataDir?: string;
  /** Storage backend for the `paired` check (whether a bot's Baileys
   *  session dir holds saved credentials). Omitted in unit tests that
   *  don't exercise pairing — `paired` is then always false. */
  storage?: Storage;
}

export class PlatformsRepository {
  constructor(private readonly opts: PlatformsRepositoryOptions) {}

  async listStatus(): Promise<PlatformStatus[]> {
    const passthrough = await this.passthrough();
    const statuses = ALL_PLATFORM_IDS.map((id) => {
      const status = this.statusFor(id, passthrough);
      // Multi-bot platforms: also configured when indexed bot entries exist,
      // even when the legacy single-token key is absent.
      if (id === 'telegram' && !status.configured) {
        if (Object.keys(passthrough).some((k) => k.startsWith('telegram.bots.'))) {
          return { ...status, configured: true };
        }
      }
      if (id === 'slack' && !status.configured) {
        if (Object.keys(passthrough).some((k) => k.startsWith('slack.apps.'))) {
          return { ...status, configured: true };
        }
      }
      return status;
    });
    // WhatsApp's PlatformDefinition has no settable fields (it pairs via QR,
    // not config-form tokens), so statusFor() always reports configured=false.
    // Special-case it: configured when any `whatsapp.<n>` entry exists, and
    // surface a `paired` indicator (any configured bot has a non-empty
    // Baileys session dir) on the fields map — the only boolean channel the
    // frozen PlatformStatus schema offers.
    const wa = statuses.find((s) => s.id === 'whatsapp');
    if (wa) {
      const entries = await this.listWhatsApp();
      wa.configured = entries.length > 0;
      wa.fields = { paired: entries.some((e) => e.paired) };
    }
    return statuses;
  }

  async getStatus(id: PlatformId): Promise<PlatformStatus> {
    return this.statusFor(id, await this.passthrough());
  }

  /**
   * Apply per-field updates. Empty-string / missing fields preserve
   * the existing value (so users can rotate one secret without
   * re-entering all the others). Secret-shaped fields go through the
   * resolver; non-secret fields land directly in passthrough.
   * Returns the post-write status.
   */
  async set(id: PlatformId, fields: Record<string, string>): Promise<PlatformStatus> {
    const def = PLATFORMS[id];
    const passthroughPatch: Record<string, string> = {};

    for (const fieldName of def.fields) {
      const incoming = fields[fieldName];
      if (incoming === undefined || incoming === '') continue;
      const configKey = def.toConfigKey[fieldName];
      if (!configKey) continue;
      const secretRef = def.secretRef[fieldName];
      if (secretRef) {
        await this.opts.secrets.set(secretRef, incoming);
        passthroughPatch[configKey] = `\${secrets:${secretRef}}`;
      } else {
        passthroughPatch[configKey] = incoming;
      }
    }

    if (Object.keys(passthroughPatch).length > 0) {
      await this.opts.config.update({ passthrough: passthroughPatch });
    }
    return this.getStatus(id);
  }

  async clear(id: PlatformId): Promise<PlatformStatus> {
    const def = PLATFORMS[id];
    const passthrough = await this.passthrough();
    const keys = def.fields
      .map((f) => def.toConfigKey[f])
      .filter((k): k is string => typeof k === 'string');
    // Delete the underlying secrets too — config refs would otherwise
    // dangle and the resolver list would mislead a future audit.
    for (const fieldName of def.fields) {
      const configKey = def.toConfigKey[fieldName];
      if (!configKey) continue;
      const value = passthrough[configKey];
      if (!value) continue;
      const ref = secretRefFromValue(value);
      if (ref) await this.opts.secrets.delete(ref);
    }
    if (keys.length > 0) await this.opts.config.deletePassthroughKeys(keys);
    return this.getStatus(id);
  }

  private async passthrough(): Promise<Record<string, string>> {
    const raw = await this.opts.config.read();
    return raw?.passthrough ?? {};
  }

  private async rawConfig(): Promise<RawConfig | null> {
    return this.opts.config.read();
  }

  /** Parse all `telegram.bots.N.*` passthrough keys into grouped entries. */
  private parseTelegramIndices(
    passthrough: Record<string, string>,
  ): Map<number, Record<string, string>> {
    const byIndex = new Map<number, Record<string, string>>();
    for (const [key, value] of Object.entries(passthrough)) {
      const m = key.match(/^telegram\.bots\.(\d+)\.(.+)$/);
      if (!m) continue;
      const idx = Number(m[1]);
      const sub = m[2] as string;
      const entry = byIndex.get(idx) ?? {};
      entry[sub] = value;
      byIndex.set(idx, entry);
    }
    return byIndex;
  }

  /** Parse all `slack.apps.N.*` passthrough keys into grouped entries. */
  private parseSlackIndices(
    passthrough: Record<string, string>,
  ): Map<number, Record<string, string>> {
    const byIndex = new Map<number, Record<string, string>>();
    for (const [key, value] of Object.entries(passthrough)) {
      const m = key.match(/^slack\.apps\.(\d+)\.(.+)$/);
      if (!m) continue;
      const idx = Number(m[1]);
      const sub = m[2] as string;
      const entry = byIndex.get(idx) ?? {};
      entry[sub] = value;
      byIndex.set(idx, entry);
    }
    return byIndex;
  }

  private entryToBotKey(fields: Record<string, string>, seed: string): string {
    return fields.id ?? deriveBotKey(seed);
  }

  // ---------------------------------------------------------------------------
  // Multi-bot Telegram
  // ---------------------------------------------------------------------------

  async listTelegramBots(): Promise<TelegramBotEntry[]> {
    const raw = await this.rawConfig();
    const passthrough = raw?.passthrough ?? {};
    const byIndex = this.parseTelegramIndices(passthrough);
    const result: TelegramBotEntry[] = [];
    for (const [, fields] of [...byIndex.entries()].sort(([a], [b]) => a - b)) {
      const bindType = fields['bind.type'];
      const bindName = fields['bind.name'];
      if (!bindName || (bindType !== 'personality' && bindType !== 'team')) continue;
      const token = fields.token ?? '';
      const botKey = this.entryToBotKey(fields, token);
      result.push({
        botKey,
        tokenConfigured: token.length > 0,
        bind: { type: bindType, name: bindName },
        username: fields.username,
      });
    }
    // Legacy single-bot shim — mirrors applyPlatformShim() in
    // apps/ethos/src/config.ts. Surfaces a CLI-set `telegramToken`
    // alongside multi-bot entries so the web Communications tab sees
    // what the gateway sees. Only synthesizes when no multi-bot
    // entries exist (gateway's shim has the same condition).
    if (result.length === 0) {
      const legacyToken = passthrough.telegramToken ?? '';
      if (legacyToken.length > 0) {
        result.push({
          botKey: LEGACY_TELEGRAM_BOT_KEY,
          tokenConfigured: true,
          bind: { type: 'personality', name: raw?.personality ?? '' },
        });
      }
    }
    return result;
  }

  async addTelegramBot(
    token: string,
    bind: BotBinding,
    username?: string,
  ): Promise<TelegramBotEntry> {
    const passthrough = await this.passthrough();
    const byIndex = this.parseTelegramIndices(passthrough);
    const nextIndex = byIndex.size > 0 ? Math.max(...byIndex.keys()) + 1 : 0;
    const botKey = deriveBotKey(token);
    const secretRef = `telegram/bots/${botKey}/token`;
    await this.opts.secrets.set(secretRef, token);
    await this.opts.config.update({
      passthrough: {
        [`telegram.bots.${nextIndex}.id`]: botKey,
        [`telegram.bots.${nextIndex}.token`]: `\${secrets:${secretRef}}`,
        [`telegram.bots.${nextIndex}.bind.type`]: bind.type,
        [`telegram.bots.${nextIndex}.bind.name`]: bind.name,
        ...(username ? { [`telegram.bots.${nextIndex}.username`]: username } : {}),
      },
    });
    return { botKey, tokenConfigured: true, bind, username };
  }

  async removeTelegramBot(botKey: string): Promise<void> {
    if (botKey === LEGACY_TELEGRAM_BOT_KEY) {
      await this.clear('telegram');
      return;
    }
    const passthrough = await this.passthrough();
    const byIndex = this.parseTelegramIndices(passthrough);
    let targetIndex: number | undefined;
    let targetFields: Record<string, string> | undefined;
    for (const [idx, fields] of byIndex.entries()) {
      const token = fields.token ?? '';
      if (this.entryToBotKey(fields, token) === botKey) {
        targetIndex = idx;
        targetFields = fields;
        break;
      }
    }
    if (targetIndex === undefined || !targetFields) return;
    const tokenValue = targetFields.token ?? '';
    const ref = secretRefFromValue(tokenValue);
    if (ref) await this.opts.secrets.delete(ref);
    const toDelete = Object.keys(passthrough).filter((k) =>
      k.startsWith(`telegram.bots.${targetIndex}.`),
    );
    await this.opts.config.deletePassthroughKeys(toDelete);
    await this.reindexTelegramBots();
  }

  private async reindexTelegramBots(): Promise<void> {
    const passthrough = await this.passthrough();
    const byIndex = this.parseTelegramIndices(passthrough);
    const allKeys = Object.keys(passthrough).filter((k) => k.startsWith('telegram.bots.'));
    if (allKeys.length > 0) await this.opts.config.deletePassthroughKeys(allKeys);
    const sorted = [...byIndex.entries()].sort(([a], [b]) => a - b);
    const newPassthrough: Record<string, string> = {};
    for (const [newIdx, [, fields]] of sorted.entries()) {
      for (const [sub, value] of Object.entries(fields)) {
        newPassthrough[`telegram.bots.${newIdx}.${sub}`] = value;
      }
    }
    if (Object.keys(newPassthrough).length > 0) {
      await this.opts.config.update({ passthrough: newPassthrough });
    }
  }

  // ---------------------------------------------------------------------------
  // Multi-bot Slack
  // ---------------------------------------------------------------------------

  async listSlackApps(): Promise<SlackAppEntry[]> {
    const raw = await this.rawConfig();
    const passthrough = raw?.passthrough ?? {};
    const byIndex = this.parseSlackIndices(passthrough);
    const result: SlackAppEntry[] = [];
    for (const [, fields] of [...byIndex.entries()].sort(([a], [b]) => a - b)) {
      const bindType = fields['bind.type'];
      const bindName = fields['bind.name'];
      if (!bindName || (bindType !== 'personality' && bindType !== 'team')) continue;
      const botToken = fields.botToken ?? '';
      const botKey = this.entryToBotKey(fields, botToken);
      result.push({
        botKey,
        botTokenConfigured: botToken.length > 0,
        appTokenConfigured: (fields.appToken ?? '').length > 0,
        signingSecretConfigured: (fields.signingSecret ?? '').length > 0,
        bind: { type: bindType, name: bindName },
      });
    }
    // Legacy single-app shim — synthesizes one entry from the CLI's
    // slack*Token triple when no multi-app entries exist. Matches
    // applyPlatformShim()'s three-field guard: all three must be
    // present.
    if (result.length === 0) {
      const botToken = passthrough.slackBotToken ?? '';
      const appToken = passthrough.slackAppToken ?? '';
      const signingSecret = passthrough.slackSigningSecret ?? '';
      if (botToken.length > 0 && appToken.length > 0 && signingSecret.length > 0) {
        result.push({
          botKey: LEGACY_SLACK_BOT_KEY,
          botTokenConfigured: true,
          appTokenConfigured: true,
          signingSecretConfigured: true,
          bind: { type: 'personality', name: raw?.personality ?? '' },
        });
      }
    }
    return result;
  }

  async addSlackApp(
    tokens: { botToken: string; appToken: string; signingSecret: string },
    bind: BotBinding,
  ): Promise<SlackAppEntry> {
    const passthrough = await this.passthrough();
    const byIndex = this.parseSlackIndices(passthrough);
    const nextIndex = byIndex.size > 0 ? Math.max(...byIndex.keys()) + 1 : 0;
    const botKey = deriveBotKey(tokens.botToken);
    const botTokenRef = `slack/apps/${botKey}/botToken`;
    const appTokenRef = `slack/apps/${botKey}/appToken`;
    const signingSecretRef = `slack/apps/${botKey}/signingSecret`;
    await this.opts.secrets.set(botTokenRef, tokens.botToken);
    await this.opts.secrets.set(appTokenRef, tokens.appToken);
    await this.opts.secrets.set(signingSecretRef, tokens.signingSecret);
    await this.opts.config.update({
      passthrough: {
        [`slack.apps.${nextIndex}.id`]: botKey,
        [`slack.apps.${nextIndex}.botToken`]: `\${secrets:${botTokenRef}}`,
        [`slack.apps.${nextIndex}.appToken`]: `\${secrets:${appTokenRef}}`,
        [`slack.apps.${nextIndex}.signingSecret`]: `\${secrets:${signingSecretRef}}`,
        [`slack.apps.${nextIndex}.bind.type`]: bind.type,
        [`slack.apps.${nextIndex}.bind.name`]: bind.name,
      },
    });
    return {
      botKey,
      botTokenConfigured: true,
      appTokenConfigured: true,
      signingSecretConfigured: true,
      bind,
    };
  }

  async removeSlackApp(botKey: string): Promise<void> {
    if (botKey === LEGACY_SLACK_BOT_KEY) {
      await this.clear('slack');
      return;
    }
    const passthrough = await this.passthrough();
    const byIndex = this.parseSlackIndices(passthrough);
    let targetIndex: number | undefined;
    let targetFields: Record<string, string> | undefined;
    for (const [idx, fields] of byIndex.entries()) {
      const botToken = fields.botToken ?? '';
      if (this.entryToBotKey(fields, botToken) === botKey) {
        targetIndex = idx;
        targetFields = fields;
        break;
      }
    }
    if (targetIndex === undefined || !targetFields) return;
    for (const fieldName of ['botToken', 'appToken', 'signingSecret']) {
      const value = targetFields[fieldName] ?? '';
      const ref = secretRefFromValue(value);
      if (ref) await this.opts.secrets.delete(ref);
    }
    const toDelete = Object.keys(passthrough).filter((k) =>
      k.startsWith(`slack.apps.${targetIndex}.`),
    );
    await this.opts.config.deletePassthroughKeys(toDelete);
    await this.reindexSlackApps();
  }

  private async reindexSlackApps(): Promise<void> {
    const passthrough = await this.passthrough();
    const byIndex = this.parseSlackIndices(passthrough);
    const allKeys = Object.keys(passthrough).filter((k) => k.startsWith('slack.apps.'));
    if (allKeys.length > 0) await this.opts.config.deletePassthroughKeys(allKeys);
    const sorted = [...byIndex.entries()].sort(([a], [b]) => a - b);
    const newPassthrough: Record<string, string> = {};
    for (const [newIdx, [, fields]] of sorted.entries()) {
      for (const [sub, value] of Object.entries(fields)) {
        newPassthrough[`slack.apps.${newIdx}.${sub}`] = value;
      }
    }
    if (Object.keys(newPassthrough).length > 0) {
      await this.opts.config.update({ passthrough: newPassthrough });
    }
  }

  // ---------------------------------------------------------------------------
  // Multi-bot WhatsApp
  //
  // Unlike Telegram/Slack, WhatsApp has no tokens/secrets and no bind. An
  // entry is just routing knobs (`id`, `default_mode`, `allowed_numbers`,
  // `session_dir`) written as flat `whatsapp.<n>.*` passthrough keys — the
  // exact shape apps/ethos/src/config.ts serializes and parses. Pairing is
  // out-of-band (QR via setup-whatsapp); `paired` is derived from whether the
  // Baileys session dir on disk holds saved credentials.
  // ---------------------------------------------------------------------------

  /** Parse all `whatsapp.<n>.*` passthrough keys into grouped entries. */
  private parseWhatsAppIndices(
    passthrough: Record<string, string>,
  ): Map<number, Record<string, string>> {
    const byIndex = new Map<number, Record<string, string>>();
    for (const [key, value] of Object.entries(passthrough)) {
      const m = key.match(/^whatsapp\.(\d+)\.(.+)$/);
      if (!m) continue;
      const idx = Number(m[1]);
      const sub = m[2] as string;
      const entry = byIndex.get(idx) ?? {};
      entry[sub] = value;
      byIndex.set(idx, entry);
    }
    return byIndex;
  }

  /** Default base session dir when an entry sets no `session_dir`, matching the
   *  gateway's `waCfg.session_dir ?? join(ethosDir(), 'whatsapp')`. */
  private whatsAppBaseSessionDir(fields: Record<string, string>): string {
    return fields.session_dir ?? join(this.opts.dataDir ?? '', 'whatsapp');
  }

  /** botKey derivation matching the adapter:
   *  `id ?? wa-<sanitized session-dir tail>`. */
  private whatsAppBotKey(fields: Record<string, string>): string {
    if (fields.id) return fields.id;
    const baseDir = this.whatsAppBaseSessionDir(fields);
    return `wa-${baseDir.replace(/[^a-zA-Z0-9]/g, '').slice(-16)}`;
  }

  /** True when the Baileys per-bot session dir holds saved credentials.
   *  Requires a Storage; without one (unit tests), always false. */
  private async whatsAppPaired(fields: Record<string, string>, botKey: string): Promise<boolean> {
    const storage = this.opts.storage;
    if (!storage) return false;
    const dir = join(this.whatsAppBaseSessionDir(fields), sanitizeBotKey(botKey));
    return (await storage.list(dir)).length > 0;
  }

  async listWhatsApp(): Promise<WhatsAppEntry[]> {
    const passthrough = await this.passthrough();
    const byIndex = this.parseWhatsAppIndices(passthrough);
    const result: WhatsAppEntry[] = [];
    for (const [, fields] of [...byIndex.entries()].sort(([a], [b]) => a - b)) {
      const botKey = this.whatsAppBotKey(fields);
      const allowedRaw = fields.allowed_numbers ?? '';
      // `bind` is required when saving via botsAddWhatsApp but optional on the
      // entry — a legacy bind-less config lists without one.
      const bindType = fields['bind.type'];
      const bindName = fields['bind.name'];
      const bind: BotBinding | undefined =
        bindName && (bindType === 'personality' || bindType === 'team')
          ? { type: bindType, name: bindName }
          : undefined;
      result.push({
        botKey,
        defaultMode: whatsAppMode(fields.default_mode),
        allowedNumbers: allowedRaw
          ? allowedRaw
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
        ...(fields.phone_number ? { phoneNumber: fields.phone_number } : {}),
        paired: await this.whatsAppPaired(fields, botKey),
        ...(bind ? { bind } : {}),
      });
    }
    return result;
  }

  async addWhatsApp(input: {
    id?: string;
    defaultMode?: WhatsAppChannelMode;
    allowedNumbers?: string[];
    phoneNumber?: string;
    bind: BotBinding;
  }): Promise<WhatsAppEntry> {
    const passthrough = await this.passthrough();
    const byIndex = this.parseWhatsAppIndices(passthrough);
    const nextIndex = byIndex.size > 0 ? Math.max(...byIndex.keys()) + 1 : 0;
    // `id` is required to disambiguate multi-bot routing (without it the
    // adapter derives the same `wa-<dir tail>` botKey for every entry sharing
    // a session dir). Generate a stable random one when absent.
    const id = input.id ?? `wa-${Math.random().toString(36).slice(2, 10)}`;
    const defaultMode = input.defaultMode ?? 'mention_only';
    const allowedNumbers = (input.allowedNumbers ?? []).map((s) => s.trim()).filter(Boolean);
    const phoneNumber = input.phoneNumber?.trim() || undefined;
    const bind = input.bind;
    const patch: Record<string, string> = {
      [`whatsapp.${nextIndex}.id`]: id,
      [`whatsapp.${nextIndex}.default_mode`]: defaultMode,
      [`whatsapp.${nextIndex}.bind.type`]: bind.type,
      [`whatsapp.${nextIndex}.bind.name`]: bind.name,
    };
    if (allowedNumbers.length > 0) {
      patch[`whatsapp.${nextIndex}.allowed_numbers`] = allowedNumbers.join(',');
    }
    if (phoneNumber) {
      patch[`whatsapp.${nextIndex}.phone_number`] = phoneNumber;
    }
    await this.opts.config.update({ passthrough: patch });
    return {
      botKey: id,
      defaultMode,
      allowedNumbers,
      ...(phoneNumber ? { phoneNumber } : {}),
      paired: await this.whatsAppPaired({ id }, id),
      bind,
    };
  }

  async removeWhatsApp(botKey: string): Promise<void> {
    const passthrough = await this.passthrough();
    const byIndex = this.parseWhatsAppIndices(passthrough);
    let targetIndex: number | undefined;
    for (const [idx, fields] of byIndex.entries()) {
      if (this.whatsAppBotKey(fields) === botKey) {
        targetIndex = idx;
        break;
      }
    }
    if (targetIndex === undefined) return;
    const toDelete = Object.keys(passthrough).filter((k) =>
      k.startsWith(`whatsapp.${targetIndex}.`),
    );
    await this.opts.config.deletePassthroughKeys(toDelete);
    await this.reindexWhatsApp();
  }

  private async reindexWhatsApp(): Promise<void> {
    const passthrough = await this.passthrough();
    const byIndex = this.parseWhatsAppIndices(passthrough);
    const allKeys = Object.keys(passthrough).filter((k) => k.startsWith('whatsapp.'));
    if (allKeys.length > 0) await this.opts.config.deletePassthroughKeys(allKeys);
    const sorted = [...byIndex.entries()].sort(([a], [b]) => a - b);
    const newPassthrough: Record<string, string> = {};
    for (const [newIdx, [, fields]] of sorted.entries()) {
      for (const [sub, value] of Object.entries(fields)) {
        newPassthrough[`whatsapp.${newIdx}.${sub}`] = value;
      }
    }
    if (Object.keys(newPassthrough).length > 0) {
      await this.opts.config.update({ passthrough: newPassthrough });
    }
  }

  async getChannelFilter(platform: string): Promise<ChannelPlatformFilter> {
    const passthrough = await this.passthrough();
    const enabled = passthrough[`channel_filter.${platform}.enable`];
    const ownerUserId = passthrough[`channel_filter.${platform}.ownerUserId`] ?? '';
    const allowlistRaw = passthrough[`channel_filter.${platform}.recipientAllowlist`] ?? '';
    return {
      enabled: enabled !== 'false',
      ownerUserId,
      allowlist: allowlistRaw
        ? allowlistRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    };
  }

  async setChannelFilter(
    platform: string,
    filter: ChannelPlatformFilter,
  ): Promise<ChannelPlatformFilter> {
    const prefix = `channel_filter.${platform}`;
    const patch: Record<string, string> = {};
    const toDelete: string[] = [];

    if (!filter.enabled) {
      patch[`${prefix}.enable`] = 'false';
    } else {
      toDelete.push(`${prefix}.enable`);
    }

    if (filter.ownerUserId.trim()) {
      patch[`${prefix}.ownerUserId`] = filter.ownerUserId.trim();
    } else {
      toDelete.push(`${prefix}.ownerUserId`);
    }

    const cleaned = filter.allowlist.map((s) => s.trim()).filter(Boolean);
    if (cleaned.length > 0) {
      patch[`${prefix}.recipientAllowlist`] = cleaned.join(',');
    } else {
      toDelete.push(`${prefix}.recipientAllowlist`);
    }

    if (Object.keys(patch).length > 0) await this.opts.config.update({ passthrough: patch });
    if (toDelete.length > 0) await this.opts.config.deletePassthroughKeys(toDelete);
    return this.getChannelFilter(platform);
  }

  private statusFor(id: PlatformId, passthrough: Record<string, string>): PlatformStatus {
    const def = PLATFORMS[id];
    const fields: Record<string, boolean> = {};
    for (const fieldName of def.fields) {
      const configKey = def.toConfigKey[fieldName];
      const value = configKey ? passthrough[configKey] : undefined;
      fields[fieldName] = typeof value === 'string' && value.length > 0;
    }
    const configured = def.fields.every((f) => fields[f]);
    return { id, configured, fields };
  }
}
