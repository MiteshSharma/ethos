import { dirname, join } from 'node:path';
import {
  externalizeSecret,
  type SecretRefContext,
  secretRefForConfigKey,
} from '@ethosagent/config';
import { deriveBotKey } from '@ethosagent/core';
import type {
  SecretsResolver,
  Storage,
  SttProviderEntry,
  TtsProviderEntry,
} from '@ethosagent/types';
import { requireStorage } from './require-storage';

// Read/write `~/.ethos/config.yaml` from the web side. The file is shared
// with the CLI (`apps/ethos/src/config.ts`), so any web-driven update must
// PRESERVE keys this layer doesn't know about (telegramToken, slack*,
// email*, etc.) — otherwise switching personalities or rotating an API key
// from the web would silently delete the user's gateway tokens.
//
// Stays as a web-api-internal repository (vs collapsing into the CLI's
// config.ts) because the passthrough-preserving parser is web-specific —
// the CLI's reader knows every key by name and would drop unknowns.

export interface ConfigRepositoryOptions {
  /** Where `~/.ethos` lives. config.yaml is `<dataDir>/config.yaml`. */
  dataDir: string;
  /** Storage backend. Injected by the composition root; required. */
  storage: Storage;
  /**
   * Credential vault. Required, not optional: every credential-bearing value
   * this repository serializes is externalized through it and the file gets
   * only a `${secrets:<ref>}` reference (G-SEC / §V S9). An optional resolver
   * would be a control a caller could silently omit.
   */
  secrets: SecretsResolver;
}

/** A single entry in the provider chain (providers.N.* lines in config.yaml). */
export interface RawProviderEntry {
  provider: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

/** Parsed shape — only the fields the web surface reads. Unknown keys are
 *  retained internally on the `_raw` map so writes preserve them. */
export interface RawConfig {
  provider?: string;
  model?: string;
  apiKey?: string;
  personality?: string;
  memory?: 'markdown' | 'vector' | 'vault';
  baseUrl?: string;
  /** Active skin name (default | mono | paper, or future custom skins). */
  skin?: string;
  approvalMode?: 'manual' | 'smart' | 'off';
  verbosity?: 'concise' | 'balanced' | 'verbose';
  debugMode?: boolean;
  contextLayering?: boolean;
  debugPanelEnabled?: boolean;
  debugPanelModel?: string | null;
  voiceProvider?: string;
  voiceApiKey?: string;
  voiceBaseUrl?: string;
  voiceModel?: string;
  voiceTtsProvider?: string;
  voiceTtsApiKey?: string;
  voiceTtsVoice?: string;
  voiceTtsBaseUrl?: string;
  voiceTtsModel?: string;
  modelRouting: Record<string, string>;
  /**
   * Global FALLBACK layer for per-personality tool config, keyed by personality
   * ID (or `_default`). The personality's own `tools.yaml` is the source of
   * truth; this fills the gap for read-only built-ins. Only secret NAMES live
   * here — never values (§V S9). `web_search` is the sole consumer in v1;
   * mirrors the flat-key format packages/config writes/parses.
   */
  toolSettings: Record<string, { web_search?: { provider?: string; secret?: string } }>;
  /** Ordered provider chain for ChainedProvider failover. */
  providers: RawProviderEntry[];
  /** Every other top-level key the file contained (telegramToken etc.).
   *  Round-tripped through writes verbatim. */
  passthrough: Record<string, string>;
}

export class ConfigRepository {
  private readonly storage: Storage;
  private readonly secrets: SecretsResolver;
  private readonly path: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: ConfigRepositoryOptions) {
    this.storage = requireStorage(opts.storage, 'ConfigRepository');
    if (!opts.secrets) {
      throw new Error('ConfigRepository requires a SecretsResolver');
    }
    this.secrets = opts.secrets;
    this.path = join(opts.dataDir, 'config.yaml');
  }

  async exists(): Promise<boolean> {
    return this.storage.exists(this.path);
  }

  async read(): Promise<RawConfig | null> {
    const src = await this.storage.read(this.path);
    if (src === null) return null;

    const known = new Set([
      'provider',
      'model',
      'apiKey',
      'personality',
      'memory',
      'baseUrl',
      'skin',
      'approvalMode',
      'verbosity',
      'debugMode',
      'contextLayering',
      'display.debug_panel',
      'display.debug_panel_model',
      'auxiliary.asr.provider',
      'auxiliary.asr.apiKey',
      'auxiliary.asr.baseUrl',
      'auxiliary.asr.model',
      'auxiliary.tts.provider',
      'auxiliary.tts.apiKey',
      'auxiliary.tts.voice',
      'auxiliary.tts.baseUrl',
      'auxiliary.tts.model',
    ]);
    const config: RawConfig = {
      modelRouting: {},
      toolSettings: {},
      providers: [],
      passthrough: {},
    };
    const providerMap = new Map<number, RawProviderEntry>();

    for (const line of src.split('\n')) {
      // `providers.<n>.<field>: <value>` — provider chain entries
      const pm = line.match(/^providers\.(\d+)\.(\S+):\s*(.+)$/);
      if (pm) {
        const idx = Number(pm[1]);
        const field = pm[2]?.trim();
        const value = pm[3] !== undefined ? stripQuotes(pm[3].trim()) : '';
        if (field && !Number.isNaN(idx)) {
          let entry = providerMap.get(idx);
          if (!entry) {
            entry = { provider: '' };
            providerMap.set(idx, entry);
          }
          switch (field) {
            case 'provider':
              entry.provider = value;
              break;
            case 'apiKey':
              entry.apiKey = value;
              break;
            case 'model':
              entry.model = value;
              break;
            case 'baseUrl':
              entry.baseUrl = value;
              break;
          }
        }
        continue;
      }

      // `modelRouting.<id>: <model>` — per-personality overrides
      const mr = line.match(/^modelRouting\.(\S+):\s*(.+)$/);
      if (mr) {
        const id = mr[1]?.trim();
        const value = mr[2]?.trim();
        if (id && value) config.modelRouting[id] = stripQuotes(value);
        continue;
      }

      // `toolSettings.<personality|_default>.web_search.<provider|secret>: <value>`
      // — global FALLBACK layer. Parsed explicitly (not via passthrough) so the
      // service reads/writes it typed; the on-disk format matches packages/config.
      const ts = line.match(/^toolSettings\.([^.]+)\.web_search\.(provider|secret):\s*(.+)$/);
      if (ts) {
        const pid = ts[1]?.trim();
        const field = ts[2];
        const value = ts[3] !== undefined ? stripQuotes(ts[3].trim()) : '';
        if (pid && value) {
          const slot = config.toolSettings[pid] ?? {};
          config.toolSettings[pid] = slot;
          const ws = slot.web_search ?? {};
          slot.web_search = ws;
          if (field === 'provider') ws.provider = value;
          else ws.secret = value;
        }
        continue;
      }
      const kv = line.match(/^([\w.-]+):\s*(.+)$/);
      if (!kv) continue;
      const key = kv[1]?.trim();
      const value = kv[2] !== undefined ? stripQuotes(kv[2].trim()) : '';
      if (!key) continue;

      if (known.has(key)) {
        switch (key) {
          case 'provider':
            config.provider = value;
            break;
          case 'model':
            config.model = value;
            break;
          case 'apiKey':
            config.apiKey = value;
            break;
          case 'personality':
            config.personality = value;
            break;
          case 'memory':
            config.memory = value === 'vector' || value === 'vault' ? value : 'markdown';
            break;
          case 'baseUrl':
            config.baseUrl = value;
            break;
          case 'skin':
            config.skin = value;
            break;
          case 'approvalMode':
            if (value === 'manual' || value === 'smart' || value === 'off') {
              config.approvalMode = value;
            }
            break;
          case 'verbosity':
            if (value === 'concise' || value === 'balanced' || value === 'verbose') {
              config.verbosity = value;
            }
            break;
          case 'debugMode':
            config.debugMode = value === 'true';
            break;
          case 'contextLayering':
            config.contextLayering = value === 'true';
            break;
          case 'display.debug_panel':
            config.debugPanelEnabled = value === 'true';
            break;
          case 'display.debug_panel_model':
            config.debugPanelModel = value || null;
            break;
          case 'auxiliary.asr.provider':
            config.voiceProvider = value;
            break;
          case 'auxiliary.asr.apiKey':
            config.voiceApiKey = value;
            break;
          case 'auxiliary.asr.baseUrl':
            config.voiceBaseUrl = value;
            break;
          case 'auxiliary.asr.model':
            config.voiceModel = value;
            break;
          case 'auxiliary.tts.provider':
            config.voiceTtsProvider = value;
            break;
          case 'auxiliary.tts.apiKey':
            config.voiceTtsApiKey = value;
            break;
          case 'auxiliary.tts.voice':
            config.voiceTtsVoice = value;
            break;
          case 'auxiliary.tts.baseUrl':
            config.voiceTtsBaseUrl = value;
            break;
          case 'auxiliary.tts.model':
            config.voiceTtsModel = value;
            break;
        }
      } else {
        config.passthrough[key] = value;
      }
    }

    // Assemble providers array from indexed map, sorted by index
    const sortedIndices = [...providerMap.keys()].sort((a, b) => a - b);
    for (const idx of sortedIndices) {
      const entry = providerMap.get(idx);
      if (entry) config.providers.push(entry);
    }

    return config;
  }

  /**
   * Apply a partial update. Reads the existing file, merges the patch in
   * place, writes back preserving order-of-keys for known fields and the
   * raw passthrough block beneath. New file (no prior config) is created
   * with just the provided keys.
   *
   * NOTE: `passthrough` merges on top of current — this method can only
   * ADD or OVERWRITE keys, never delete. Use `deletePassthroughKeys` for
   * deletion (e.g. clearing a platform's tokens).
   */
  async update(patch: Partial<RawConfig>): Promise<RawConfig> {
    let next!: RawConfig;
    const op = this.writeChain
      .catch(() => {})
      .then(async () => {
        const current: RawConfig = (await this.read()) ?? {
          modelRouting: {},
          toolSettings: {},
          providers: [],
          passthrough: {},
        };
        next = {
          ...current,
          ...patch,
          modelRouting: { ...current.modelRouting, ...(patch.modelRouting ?? {}) },
          // Merge per-personality slots so writing one binding never drops
          // another personality's slot. Slot-level replace (patch wins).
          toolSettings: { ...current.toolSettings, ...(patch.toolSettings ?? {}) },
          // When providers is explicitly provided in the patch, replace entirely;
          // otherwise keep the current array.
          providers: patch.providers !== undefined ? patch.providers : current.providers,
          passthrough: { ...current.passthrough, ...(patch.passthrough ?? {}) },
        };
        await this.write(next);
      });
    this.writeChain = op.catch(() => {});
    await op;
    return next;
  }

  /**
   * Drop the named keys from the passthrough block and write the file
   * back. Used by the Communications tab's "Clear" action when a user
   * wants to disconnect a platform — the merge in `update` can't
   * delete keys, so this is the dedicated path.
   */
  async deletePassthroughKeys(keys: string[]): Promise<RawConfig> {
    let current!: RawConfig;
    const op = this.writeChain
      .catch(() => {})
      .then(async () => {
        current = (await this.read()) ?? {
          modelRouting: {},
          toolSettings: {},
          providers: [],
          passthrough: {},
        };
        for (const key of keys) delete current.passthrough[key];
        await this.write(current);
      });
    this.writeChain = op.catch(() => {});
    await op;
    return current;
  }

  /**
   * Move every credential-bearing value into the vault, leaving the config
   * with `${secrets:<ref>}` references only (G-SEC / §V S9). Ref naming and
   * the already-a-reference passthrough come from `@ethosagent/config`, so
   * this serializer and the CLI's `writeConfig` mint the same refs for the
   * same fields instead of each inventing a scheme.
   *
   * Passthrough keys are covered too: the settings form writes credentials
   * (`auxiliary.*.apiKey`, `webhooks.<id>.secret`, platform tokens) through
   * that block, and it round-trips keys this layer never models.
   */
  private async externalizeSecrets(config: RawConfig): Promise<RawConfig> {
    const ctx: SecretRefContext = {
      ...(config.provider ? { provider: config.provider } : {}),
      providerChain: config.providers.map((p) => p.provider),
      telegramBotKeys: botKeys(config.passthrough, 'telegram.bots', 'token'),
      slackAppKeys: botKeys(config.passthrough, 'slack.apps', 'botToken'),
    };
    const ref = (key: string): string => {
      const r = secretRefForConfigKey(key, ctx);
      if (r === null) throw new Error(`No secret ref is defined for config key '${key}'`);
      return r;
    };
    const next: RawConfig = { ...config };
    next.apiKey = await externalizeSecret(next.apiKey, ref('apiKey'), this.secrets);
    next.voiceApiKey = await externalizeSecret(
      next.voiceApiKey,
      ref('auxiliary.asr.apiKey'),
      this.secrets,
    );
    next.voiceTtsApiKey = await externalizeSecret(
      next.voiceTtsApiKey,
      ref('auxiliary.tts.apiKey'),
      this.secrets,
    );
    const providers: RawProviderEntry[] = [];
    for (const [i, p] of config.providers.entries()) {
      providers.push({
        ...p,
        apiKey: await externalizeSecret(p.apiKey, ref(`providers.${i}.apiKey`), this.secrets),
      });
    }
    next.providers = providers;
    const passthrough: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.passthrough)) {
      const keyRef = secretRefForConfigKey(key, ctx);
      passthrough[key] =
        keyRef === null ? value : ((await externalizeSecret(value, keyRef, this.secrets)) ?? value);
    }
    next.passthrough = passthrough;
    return next;
  }

  private async write(input: RawConfig): Promise<void> {
    await this.storage.mkdir(dirname(this.path));

    const config = await this.externalizeSecrets(input);
    const lines: string[] = [];
    if (config.provider) lines.push(`provider: ${yamlScalar(config.provider)}`);
    if (config.model) lines.push(`model: ${yamlScalar(config.model)}`);
    if (config.apiKey) lines.push(`apiKey: ${yamlScalar(config.apiKey)}`);
    if (config.personality) lines.push(`personality: ${yamlScalar(config.personality)}`);
    if (config.memory) lines.push(`memory: ${yamlScalar(config.memory)}`);
    if (config.baseUrl) lines.push(`baseUrl: ${yamlScalar(config.baseUrl)}`);
    if (config.skin) lines.push(`skin: ${yamlScalar(config.skin)}`);
    if (config.approvalMode) lines.push(`approvalMode: ${yamlScalar(config.approvalMode)}`);
    if (config.verbosity) lines.push(`verbosity: ${yamlScalar(config.verbosity)}`);
    if (config.debugMode !== undefined) lines.push(`debugMode: ${config.debugMode}`);
    if (config.contextLayering !== undefined)
      lines.push(`contextLayering: ${config.contextLayering}`);
    if (config.debugPanelEnabled !== undefined)
      lines.push(`display.debug_panel: ${config.debugPanelEnabled}`);
    if (config.debugPanelModel) lines.push(`display.debug_panel_model: ${config.debugPanelModel}`);
    if (config.voiceProvider)
      lines.push(`auxiliary.asr.provider: ${yamlScalar(config.voiceProvider)}`);
    if (config.voiceApiKey) lines.push(`auxiliary.asr.apiKey: ${yamlScalar(config.voiceApiKey)}`);
    if (config.voiceBaseUrl)
      lines.push(`auxiliary.asr.baseUrl: ${yamlScalar(config.voiceBaseUrl)}`);
    if (config.voiceModel) lines.push(`auxiliary.asr.model: ${yamlScalar(config.voiceModel)}`);
    if (config.voiceTtsProvider)
      lines.push(`auxiliary.tts.provider: ${yamlScalar(config.voiceTtsProvider)}`);
    if (config.voiceTtsApiKey)
      lines.push(`auxiliary.tts.apiKey: ${yamlScalar(config.voiceTtsApiKey)}`);
    if (config.voiceTtsVoice)
      lines.push(`auxiliary.tts.voice: ${yamlScalar(config.voiceTtsVoice)}`);
    if (config.voiceTtsBaseUrl)
      lines.push(`auxiliary.tts.baseUrl: ${yamlScalar(config.voiceTtsBaseUrl)}`);
    if (config.voiceTtsModel)
      lines.push(`auxiliary.tts.model: ${yamlScalar(config.voiceTtsModel)}`);
    for (const [id, model] of Object.entries(config.modelRouting)) {
      lines.push(`modelRouting.${yamlScalar(id)}: ${yamlScalar(model)}`);
    }
    for (const [pid, settings] of Object.entries(config.toolSettings)) {
      const ws = settings.web_search;
      if (ws?.provider) {
        lines.push(
          `toolSettings.${yamlScalar(pid)}.web_search.provider: ${yamlScalar(ws.provider)}`,
        );
      }
      if (ws?.secret) {
        lines.push(`toolSettings.${yamlScalar(pid)}.web_search.secret: ${yamlScalar(ws.secret)}`);
      }
    }
    for (let i = 0; i < config.providers.length; i++) {
      const p = config.providers[i];
      if (!p) continue;
      lines.push(`providers.${i}.provider: ${yamlScalar(p.provider)}`);
      if (p.apiKey) lines.push(`providers.${i}.apiKey: ${yamlScalar(p.apiKey)}`);
      if (p.model) lines.push(`providers.${i}.model: ${yamlScalar(p.model)}`);
      if (p.baseUrl) lines.push(`providers.${i}.baseUrl: ${yamlScalar(p.baseUrl)}`);
    }
    // Stable-order passthrough — keep keys the CLI cares about across
    // round-trips even if it adds new ones in the future.
    for (const key of Object.keys(config.passthrough).sort()) {
      lines.push(`${yamlScalar(key)}: ${yamlScalar(config.passthrough[key] ?? '')}`);
    }
    // Credential values live in the vault, not here — but write 0o600 anyway
    // so a web-driven update never regresses the file to a world-readable
    // mode (matches apps/ethos/src/config.ts and web-token.repository.ts).
    await this.storage.writeAtomic(this.path, `${lines.join('\n')}\n`, { mode: 0o600 });
  }
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

/**
 * The named voice rosters (`voice.<tts|stt>.providers.<name>.<field>`) out of
 * the passthrough block, which is where these lines land — this parser models no
 * key, it just round-trips them.
 *
 * Deliberately a mirror of `buildVoiceProviderEntry` in `@ethosagent/config`:
 * same charset for the name, same field sets, and the same rule that an entry
 * without `provider` names nothing resolvable and is dropped rather than
 * half-built. Two readers of one file format is already one too many; they must
 * at least agree on what a valid entry is. Both kinds run through ONE walker
 * here for the same reason they do there.
 *
 * `voice.providers.<name>.<field>` — the older TTS-only spelling — is accepted
 * on read and merged UNDER the new keys, so a hand-written config from before
 * the rename still loads. Nothing writes it back.
 *
 * `apiKey` comes back exactly as stored — usually a `${secrets:…}` reference.
 * Callers that hand entries to a provider factory must resolve it first;
 * callers that show it to a browser must redact it.
 */
const TTS_ROSTER_FIELDS = {
  strings: ['model', 'apiKey', 'voice', 'baseUrl', 'command'],
  numbers: ['timeout', 'maxTextLength'],
  audioFormat: true,
} as const;

const STT_ROSTER_FIELDS = {
  strings: ['model', 'apiKey', 'baseUrl', 'command'],
  numbers: ['timeout'],
  audioFormat: false,
} as const;

interface RosterFieldSet {
  readonly strings: readonly string[];
  readonly numbers: readonly string[];
  readonly audioFormat: boolean;
}

function collectRoster(
  passthrough: Record<string, string>,
  prefixes: readonly string[],
): Record<string, Record<string, string>> {
  const bag: Record<string, Record<string, string>> = {};
  // Prefixes are applied in order and later ones overwrite earlier ones, so the
  // canonical spelling wins over the legacy alias regardless of key order.
  for (const prefix of prefixes) {
    const re = new RegExp(`^${prefix.replace(/\./g, '\\.')}\\.([A-Za-z0-9_-]+)\\.(\\w+)$`);
    for (const [key, value] of Object.entries(passthrough)) {
      const m = key.match(re);
      const name = m?.[1];
      const field = m?.[2];
      if (!name || !field) continue;
      const slot = bag[name] ?? {};
      bag[name] = slot;
      slot[field] = value;
    }
  }
  return bag;
}

function buildRoster<E extends { provider: string }>(
  bag: Record<string, Record<string, string>>,
  fields: RosterFieldSet,
): Record<string, E> {
  const out: Record<string, E> = {};
  for (const [name, kv] of Object.entries(bag)) {
    if (!kv.provider) continue;
    const entry: Record<string, string | number> = { provider: kv.provider };
    for (const field of fields.strings) {
      const value = kv[field];
      if (value) entry[field] = value;
    }
    for (const field of fields.numbers) {
      const n = Number(kv[field]);
      if (kv[field] && Number.isFinite(n) && n > 0) entry[field] = n;
    }
    if (fields.audioFormat && isAudioFormat(kv.outputFormat)) {
      entry.outputFormat = kv.outputFormat;
    }
    out[name] = entry as E;
  }
  return out;
}

export function parseTtsRoster(
  passthrough: Record<string, string>,
): Record<string, TtsProviderEntry> {
  return buildRoster<TtsProviderEntry>(
    collectRoster(passthrough, ['voice.providers', 'voice.tts.providers']),
    TTS_ROSTER_FIELDS,
  );
}

export function parseSttRoster(
  passthrough: Record<string, string>,
): Record<string, SttProviderEntry> {
  return buildRoster<SttProviderEntry>(
    collectRoster(passthrough, ['voice.stt.providers']),
    STT_ROSTER_FIELDS,
  );
}

function isAudioFormat(v: string | undefined): v is 'opus' | 'mp3' | 'wav' | 'pcm' {
  return v === 'opus' || v === 'mp3' || v === 'wav' || v === 'pcm';
}

/**
 * Stable botKey per indexed passthrough entry (`telegram.bots.<n>`,
 * `slack.apps.<n>`), so a token's ref is keyed by bot identity rather than
 * array position. Explicit `.id` wins — that is what PlatformsRepository
 * writes; otherwise derive from the token, which lands on the same key
 * PlatformsRepository would have derived from the same token.
 */
function botKeys(
  passthrough: Record<string, string>,
  prefix: string,
  tokenField: string,
): (string | undefined)[] {
  const keys: (string | undefined)[] = [];
  const re = new RegExp(`^${prefix.replace(/\./g, '\\.')}\\.(\\d+)\\.(id|${tokenField})$`);
  for (const [key, value] of Object.entries(passthrough)) {
    const m = key.match(re);
    const idx = m?.[1];
    if (idx === undefined) continue;
    const i = Number(idx);
    if (m?.[2] === 'id') keys[i] = value;
    else if (keys[i] === undefined) keys[i] = deriveBotKey(value);
  }
  return keys;
}

/** Escape a value for safe YAML scalar emission. If the value contains
 *  characters that could alter YAML structure (colons, newlines, special
 *  chars, leading/trailing whitespace), wrap it in JSON-style double
 *  quotes. This prevents newline injection that could create new
 *  top-level keys (e.g. injecting `fs_reach` for privilege escalation). */
function yamlScalar(value: string): string {
  if (/[:\n\r#[\]{}&*!|>'"%@`]/.test(value) || value.trim() !== value) {
    return JSON.stringify(value);
  }
  return value;
}
