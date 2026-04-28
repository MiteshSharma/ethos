import { EthosError } from '@ethosagent/types';
import type { ConfigRepository } from '../repositories/config.repository';

// Read/update the parts of `~/.ethos/config.yaml` the web UI exposes. The
// raw API key NEVER leaves this layer — `get` returns a redacted preview
// (`sk-…abc1`) so the UI can show "which key is active" without leaking
// it. `update` accepts a fresh key but does not echo it back.

export interface ConfigGetResult {
  provider: string;
  model: string;
  apiKeyPreview: string;
  baseUrl: string | null;
  personality: string;
  memory: 'markdown' | 'vector';
  modelRouting: Record<string, string>;
}

export interface ConfigUpdateInput {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  personality?: string;
  memory?: 'markdown' | 'vector';
  modelRouting?: Record<string, string>;
}

export interface ConfigServiceOptions {
  config: ConfigRepository;
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
    return {
      provider: raw.provider ?? '',
      model: raw.model ?? '',
      apiKeyPreview: redactKey(raw.apiKey),
      baseUrl: raw.baseUrl ?? null,
      personality: raw.personality ?? 'researcher',
      memory: raw.memory ?? 'markdown',
      modelRouting: raw.modelRouting,
    };
  }

  async update(patch: ConfigUpdateInput): Promise<void> {
    // Empty-string apiKey would erase the existing key. Treat as no-op.
    const cleaned: typeof patch = { ...patch };
    if (cleaned.apiKey !== undefined && cleaned.apiKey === '') delete cleaned.apiKey;
    await this.opts.config.update(cleaned);
  }
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
