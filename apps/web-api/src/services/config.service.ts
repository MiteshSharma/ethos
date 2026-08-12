import { randomBytes } from 'node:crypto';
import { EthosError, type SecretsResolver } from '@ethosagent/types';
import type { ConfigRepository, RawProviderEntry } from '../repositories/config.repository';

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

function parseChannelToolsets(p: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(p)) {
    const m = key.match(/^channel_toolsets\.([^.]+)$/);
    if (m?.[1]) out[m[1]] = splitList(value);
  }
  return out;
}

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

function parseAuxModel(p: Record<string, string>, prefix: string): AuxModelGetResult {
  const rawKey = p[`${prefix}.apiKey`];
  return {
    model: passStr(p, `${prefix}.model`),
    provider: passStr(p, `${prefix}.provider`),
    apiKeyPreview: rawKey ? redactKey(rawKey) : null,
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
  voiceTtsOutputFormat: 'opus' | 'mp3' | 'wav' | 'pcm' | null;
  voiceTtsTimeoutMs: number | null;
  voiceTtsMaxTextLength: number | null;
  voiceSttTimeoutMs: number | null;
  /** `null` = the key is absent = the local-only egress gate is OFF. */
  voiceTrustedPlugins: string[] | null;
  voiceDefaultMode: 'off' | 'mirror_inbound' | 'all' | null;
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
  voiceTtsOutputFormat?: 'opus' | 'mp3' | 'wav' | 'pcm' | null;
  voiceTtsTimeoutMs?: number | null;
  voiceTtsMaxTextLength?: number | null;
  voiceSttTimeoutMs?: number | null;
  voiceTrustedPlugins?: string[] | null;
  voiceDefaultMode?: 'off' | 'mirror_inbound' | 'all' | null;
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
      apiKeyPreview: redactKey(raw.apiKey),
      baseUrl: raw.baseUrl ?? null,
      personality: raw.personality ?? 'researcher',
      memory: raw.memory ?? 'markdown',
      modelRouting: raw.modelRouting,
      skin: raw.skin ?? 'default',
      providers: raw.providers.map((p) => ({
        provider: p.provider,
        model: p.model ?? null,
        apiKeyPreview: redactKey(p.apiKey),
        baseUrl: p.baseUrl ?? null,
      })),
      approvalMode: raw.approvalMode ?? 'manual',
      verbosity: raw.verbosity ?? 'balanced',
      debugMode: raw.debugMode ?? false,
      contextLayering: raw.contextLayering ?? false,
      debugPanelEnabled: raw.debugPanelEnabled ?? false,
      debugPanelModel: raw.debugPanelModel ?? null,
      adminEnabled: raw.passthrough['admin.enabled'] === 'true',
      streamingEdits: parseStreamingEdits(raw.passthrough['display.streaming_edits']),
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
      voiceApiKeyPreview: raw.voiceApiKey ? redactKey(raw.voiceApiKey) : null,
      voiceBaseUrl: raw.voiceBaseUrl ?? null,
      voiceModel: raw.voiceModel ?? null,
      voiceTtsProvider: raw.voiceTtsProvider ?? null,
      voiceTtsApiKeyPreview: raw.voiceTtsApiKey ? redactKey(raw.voiceTtsApiKey) : null,
      voiceTtsVoice: raw.voiceTtsVoice ?? null,
      voiceTtsBaseUrl: raw.voiceTtsBaseUrl ?? null,
      voiceTtsModel: raw.voiceTtsModel ?? null,
      voiceTtsOutputFormat: pickEnumOrNull(p['auxiliary.tts.outputFormat'], [
        'opus',
        'mp3',
        'wav',
        'pcm',
      ]),
      voiceTtsTimeoutMs: passNumOrNull(p, 'auxiliary.tts.timeout'),
      voiceTtsMaxTextLength: passNumOrNull(p, 'auxiliary.tts.maxTextLength'),
      voiceSttTimeoutMs: passNumOrNull(p, 'auxiliary.asr.timeout'),
      // An absent key = the gate is off, which is NOT the same as an allowlist
      // that happens to be empty.
      voiceTrustedPlugins:
        p['voice.trustedPlugins'] === undefined ? null : splitList(p['voice.trustedPlugins']),
      voiceDefaultMode: pickEnumOrNull(p['voice.defaultMode'], ['off', 'mirror_inbound', 'all']),
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
        apiKeyPreview: p['memoryCapture.apiKey'] ? redactKey(p['memoryCapture.apiKey']) : null,
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
      auxCompression: parseAuxModel(p, 'auxiliary.compression'),
      auxVision: parseAuxModel(p, 'auxiliary.vision'),
      auxWeb: parseAuxModel(p, 'auxiliary.web'),
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
    set('auxiliary.tts.outputFormat', patch.voiceTtsOutputFormat);
    set('auxiliary.tts.timeout', patch.voiceTtsTimeoutMs);
    set('auxiliary.tts.maxTextLength', patch.voiceTtsMaxTextLength);
    set('auxiliary.asr.timeout', patch.voiceSttTimeoutMs);
    set('voice.defaultMode', patch.voiceDefaultMode);
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
      patch.channelToolsets !== undefined;
    const currentPassthrough = replacesRecords
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
    for (const key of SETTINGS_PATCH_KEYS) delete cleaned[key];

    // A key both deleted (prefix replacement) and re-set in the same patch
    // must survive — the delete pass runs first, so drop it from the list.
    const finalDeletes = [...new Set(deleteKeys)].filter((k) => !(k in passthroughPatch));
    if (finalDeletes.length > 0) {
      await this.opts.config.deletePassthroughKeys(finalDeletes);
    }

    const passthrough = Object.keys(passthroughPatch).length > 0 ? passthroughPatch : undefined;
    delete cleaned.adminEnabled;
    delete cleaned.streamingEdits;
    delete cleaned.autoCompact;
    delete cleaned.memoryConsolidationEnabled;
    delete cleaned.memoryCaptureEnabled;
    delete cleaned.memoryCaptureModel;
    delete cleaned.memoryNotices;
    delete cleaned.voiceChime;
    // Written above as flat config keys; never repository fields.
    delete cleaned.voiceTtsOutputFormat;
    delete cleaned.voiceTtsTimeoutMs;
    delete cleaned.voiceTtsMaxTextLength;
    delete cleaned.voiceSttTimeoutMs;
    delete cleaned.voiceTrustedPlugins;
    delete cleaned.voiceDefaultMode;

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
