import type { PlatformId, PlatformStatus } from '@ethosagent/web-contracts';
import type { PlatformsRepository } from '../repositories/platforms.repository';

// Communications service. Pass-through over PlatformsRepository today
// — the repository owns the field-name → config-key mapping per
// platform, and the service surface is just {list, set, clear}.
//
// Real validation (does the Telegram bot token actually work? Can the
// SMTP host accept connections?) lives in the gateway adapters when
// the gateway boots; this service does not block on those. The setup
// form's success state means "stored to config.yaml," not "validated
// against the upstream platform."

export interface PlatformsServiceOptions {
  repo: PlatformsRepository;
}

export class PlatformsService {
  constructor(private readonly opts: PlatformsServiceOptions) {}

  async list(): Promise<{ platforms: PlatformStatus[] }> {
    return { platforms: await this.opts.repo.listStatus() };
  }

  async set(id: PlatformId, fields: Record<string, string>): Promise<{ platform: PlatformStatus }> {
    return { platform: await this.opts.repo.set(id, fields) };
  }

  async clear(id: PlatformId): Promise<{ platform: PlatformStatus }> {
    return { platform: await this.opts.repo.clear(id) };
  }
}
