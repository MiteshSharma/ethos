import {
  EthosError,
  isValidSecretName,
  type ToolRegistry,
  type ToolSettingsSchema,
} from '@ethosagent/types';
import type { ConfigRepository } from '../repositories/config.repository';
import type { PersonalitiesService } from './personalities.service';

// Generic per-tool settings surface (Phase 2, web-search-provider-selection).
//
// A tool that declares a `settingsSchema` becomes configurable per personality.
// The web UI renders a form FROM the schema and writes back a binding here. The
// storage target differs by personality type:
//   • custom personality  → its own `tools.yaml` (travels on export)
//   • read-only built-in   → the global `toolSettings[<id>]` config slot
//   • global default       → the `toolSettings._default` config slot
// Only a secret NAME is ever persisted — never a value (§V S9). `web_search` is
// the sole consumer in v1.

/** Wire shape: toolName → fieldKey → string value. Schema-driven and generic;
 *  only fields a tool's `settingsSchema` declares are meaningful. */
export type ToolSettingsValues = Record<string, Record<string, string>>;

const WEB_SEARCH_PROVIDERS = ['exa', 'tavily', 'brave'] as const;
type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

export interface ToolSettingsServiceOptions {
  config: ConfigRepository;
  personalities: PersonalitiesService;
  /** Live registry — the source of each tool's `settingsSchema`. */
  toolRegistry?: ToolRegistry;
}

export class ToolSettingsService {
  constructor(private readonly opts: ToolSettingsServiceOptions) {}

  /** Every configurable tool's schema, so the UI can render forms without any
   *  tool-specific knowledge. */
  schemas(): { tools: Array<{ name: string; settingsSchema: ToolSettingsSchema }> } {
    const tools = this.opts.toolRegistry?.getAvailable() ?? [];
    const out: Array<{ name: string; settingsSchema: ToolSettingsSchema }> = [];
    for (const t of tools) {
      if (t.settingsSchema) out.push({ name: t.name, settingsSchema: t.settingsSchema });
    }
    return { tools: out };
  }

  /** Read the global default binding (`toolSettings._default`). */
  async getDefault(): Promise<{ values: ToolSettingsValues }> {
    const raw = await this.opts.config.read();
    return { values: fromSlot(raw?.toolSettings._default) };
  }

  /** Write the global default binding. */
  async setDefault(values: ToolSettingsValues): Promise<{ ok: true }> {
    await this.writeGlobalSlot('_default', values);
    return { ok: true };
  }

  /**
   * Read a personality's effective binding + which store owns it. Custom
   * personalities read their own `tools.yaml`; built-ins read the global
   * `toolSettings[<id>]` slot (the only writable place for them).
   */
  async getForPersonality(
    personalityId: string,
  ): Promise<{ values: ToolSettingsValues; storage: 'personality' | 'global' }> {
    if (this.opts.personalities.isBuiltin(personalityId)) {
      const raw = await this.opts.config.read();
      return { values: fromSlot(raw?.toolSettings[personalityId]), storage: 'global' };
    }
    return {
      values: fromSlot(this.opts.personalities.getToolsConfig(personalityId)),
      storage: 'personality',
    };
  }

  /** Write a personality's binding to the correct store for its type. */
  async setForPersonality(
    personalityId: string,
    values: ToolSettingsValues,
  ): Promise<{ ok: true; storage: 'personality' | 'global' }> {
    if (this.opts.personalities.isBuiltin(personalityId)) {
      await this.writeGlobalSlot(personalityId, values);
      return { ok: true, storage: 'global' };
    }
    // requirePersonality + built-in guard live in the service method.
    await this.opts.personalities.writeToolsConfig(personalityId, {
      web_search: toWebSearch(values),
      x_search: toXSearch(values),
    });
    return { ok: true, storage: 'personality' };
  }

  private async writeGlobalSlot(pid: string, values: ToolSettingsValues): Promise<void> {
    assertSafeSlotKey(pid);
    await this.opts.config.update({
      toolSettings: { [pid]: { web_search: toWebSearch(values), x_search: toXSearch(values) } },
    });
  }
}

/** Object keys reserved by the JS object model — never let one become a
 *  computed own-key, or it seeds a prototype-pollution reservoir on the
 *  serialized config. */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Guard the personality/slot id used as a computed object key on `toolSettings`.
 *  Rejects anything outside the alnum/hyphen/underscore shape and the reserved
 *  object-model names. `_default` (the global fallback slot) passes. */
function assertSafeSlotKey(pid: string): void {
  if (!isValidSecretName(pid) || RESERVED_KEYS.has(pid)) {
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: `Invalid personality id "${pid}".`,
      action: 'Use letters, digits, hyphens, and underscores only.',
    });
  }
}

/** Map the on-disk / stored bindings to the generic wire shape, omitting empty
 *  fields so the UI shows "unset" rather than blank strings. */
function fromSlot(
  slot:
    | { web_search?: { provider?: string; secret?: string }; x_search?: { secret?: string } }
    | undefined,
): ToolSettingsValues {
  const out: ToolSettingsValues = {};
  const ws = slot?.web_search;
  if (ws) {
    const fields: Record<string, string> = {};
    if (ws.provider) fields.provider = ws.provider;
    if (ws.secret) fields.secret = ws.secret;
    if (Object.keys(fields).length > 0) out.web_search = fields;
  }
  if (slot?.x_search?.secret) out.x_search = { secret: slot.x_search.secret };
  return out;
}

/** Narrow the generic wire values into the typed x_search binding — a secret
 *  NAME only, validated with the same rule the vault enforces. */
function toXSearch(values: ToolSettingsValues): { secret?: string } {
  const secret = values.x_search?.secret?.trim();
  return secret && isValidSecretName(secret) ? { secret } : {};
}

/** Narrow the generic wire values into the typed web_search binding. Unknown
 *  providers and empty strings are dropped (treated as unset). */
function toWebSearch(values: ToolSettingsValues): {
  provider?: WebSearchProvider;
  secret?: string;
} {
  const fields = values.web_search ?? {};
  const out: { provider?: WebSearchProvider; secret?: string } = {};
  const provider = fields.provider?.trim();
  if (provider && (WEB_SEARCH_PROVIDERS as readonly string[]).includes(provider)) {
    out.provider = provider as WebSearchProvider;
  }
  // The secret is a NAME reference persisted into a `providers/<p>/<name>` ref;
  // validate it with the same shared rule the vault enforces so a malformed
  // name can never reach the personality's tools.yaml or the config slot.
  const secret = fields.secret?.trim();
  if (secret && isValidSecretName(secret)) out.secret = secret;
  return out;
}
