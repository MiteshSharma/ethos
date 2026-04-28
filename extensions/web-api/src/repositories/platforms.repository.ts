import type { PlatformId, PlatformStatus } from '@ethosagent/web-contracts';
import type { ConfigRepository } from './config.repository';

// Per-platform connection inventory + setup over the same
// ~/.ethos/config.yaml the gateway reads. Keys are flat
// (telegramToken, slackBotToken, …); the repository owns the per-
// platform field-name mapping so the service never knows about it.
//
// Sensitive values never leave this layer — the repository only emits
// PlatformStatus { configured, fields: { name → bool } }. Plain
// secrets enter via `set` for writes and immediately land in the
// passthrough block of the YAML.

interface PlatformDefinition {
  /** Form field names the UI uses. */
  fields: readonly string[];
  /** Field name → flat key in config.yaml. */
  toConfigKey: Record<string, string>;
}

const PLATFORMS: Record<PlatformId, PlatformDefinition> = {
  telegram: {
    fields: ['token'],
    toConfigKey: { token: 'telegramToken' },
  },
  discord: {
    fields: ['token'],
    toConfigKey: { token: 'discordToken' },
  },
  slack: {
    fields: ['botToken', 'appToken', 'signingSecret'],
    toConfigKey: {
      botToken: 'slackBotToken',
      appToken: 'slackAppToken',
      signingSecret: 'slackSigningSecret',
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
  },
};

const ALL_PLATFORM_IDS: readonly PlatformId[] = ['telegram', 'slack', 'discord', 'email'] as const;

export interface PlatformsRepositoryOptions {
  config: ConfigRepository;
}

export class PlatformsRepository {
  constructor(private readonly opts: PlatformsRepositoryOptions) {}

  async listStatus(): Promise<PlatformStatus[]> {
    const passthrough = await this.passthrough();
    return ALL_PLATFORM_IDS.map((id) => this.statusFor(id, passthrough));
  }

  async getStatus(id: PlatformId): Promise<PlatformStatus> {
    return this.statusFor(id, await this.passthrough());
  }

  /**
   * Apply per-field updates. Empty-string / missing fields preserve
   * the existing value (so users can rotate one secret without
   * re-entering all the others). Returns the post-write status.
   */
  async set(id: PlatformId, fields: Record<string, string>): Promise<PlatformStatus> {
    const def = PLATFORMS[id];
    const passthroughPatch: Record<string, string> = {};

    for (const fieldName of def.fields) {
      const incoming = fields[fieldName];
      if (incoming === undefined || incoming === '') continue;
      const configKey = def.toConfigKey[fieldName];
      if (configKey) passthroughPatch[configKey] = incoming;
    }

    if (Object.keys(passthroughPatch).length > 0) {
      await this.opts.config.update({ passthrough: passthroughPatch });
    }
    return this.getStatus(id);
  }

  async clear(id: PlatformId): Promise<PlatformStatus> {
    const def = PLATFORMS[id];
    const keys = def.fields
      .map((f) => def.toConfigKey[f])
      .filter((k): k is string => typeof k === 'string');
    if (keys.length > 0) await this.opts.config.deletePassthroughKeys(keys);
    return this.getStatus(id);
  }

  private async passthrough(): Promise<Record<string, string>> {
    const raw = await this.opts.config.read();
    return raw?.passthrough ?? {};
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
