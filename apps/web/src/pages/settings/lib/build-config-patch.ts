// The `config.update` patch builder — extracted verbatim from `Settings.tsx`'s
// `onFinish` when the page became a routed two-pane surface.
//
// It is a pure function of (form store, row arrays, saved config) on purpose.
// plan/phases/settings-navigation.md §5.1 names the failure this file exists to
// make testable: `getFieldsValue(true)` reads the WHOLE store including fields
// whose `Form.Item` is currently unmounted, and most of the ~100 keys below are
// written through `values.x ?? null` — so a value MISSING from the store does
// not become a skipped update, it becomes an explicit `null`, which
// `config.update` treats as a CLEAR. Saving from Memory would delete the trunk
// credentials, with no error and no visible symptom.
//
// Validation is returned, never notified: the caller owns the notification
// channel, and a builder that reaches for one cannot be unit-tested.

import {
  type ConfigGetData,
  type ConfigUpdatePatch,
  type QuickCommandPatch,
  RECORD_KEY_RE,
  RETENTION_DURATION_RE,
  type RetentionSubkey,
  strOrNull,
  type VoiceRealtimeProviderPatch,
  type VoiceSttProviderPatch,
  type VoiceTtsProviderPatch,
} from './config-types';
import { auxPatchFromForm, type FormShape } from './form-shape';
import type { ChannelToolsetRow, ProviderRow, QuickCommandRow, RetentionRow } from './rows';
import { type VoiceBotRow, voiceBotsPatchFromRows } from './voice-bots';
import {
  audioFormatOrNull,
  CALL_ACCENT_CUSTOM,
  voiceChannelTtsOutPatch,
  voiceModeOrNull,
  voiceTierOrNull,
} from './voice-options';
import {
  REALTIME_ROSTER_SPEC,
  STT_ROSTER_SPEC,
  TTS_ROSTER_SPEC,
  type VoiceProviderRow,
  type VoiceRosterKindSpec,
  voiceRealtimeProviderPatchFromRow,
  voiceSttProviderPatchFromRow,
  voiceTtsProviderPatchFromRow,
} from './voice-roster';
import { voiceTelephonyPatch } from './voice-telephony';

/** The eight row-state arrays `SettingsShell` owns (D4). */
export interface SettingsRows {
  providerRows: ProviderRow[];
  quickCommandRows: QuickCommandRow[];
  channelToolsetRows: ChannelToolsetRow[];
  voiceTtsProviderRows: VoiceProviderRow[];
  voiceSttProviderRows: VoiceProviderRow[];
  voiceRealtimeProviderRows: VoiceProviderRow[];
  retentionRows: RetentionRow[];
  voiceBotRows: VoiceBotRow[];
}

export type BuildConfigPatchResult =
  | { ok: true; patch: ConfigUpdatePatch }
  | { ok: false; error: string };

/**
 * Patch keys that are NOT written from a same-named form field — they come from
 * the row arrays, from the saved config, or from the provider chain. Everything
 * else in the patch is `values.<sameName>`, which is what lets the absent-field
 * guard at the bottom of this function be a set difference rather than a second
 * copy of `FormShape`.
 */
const DERIVED_PATCH_KEYS = new Set<string>([
  'provider',
  'model',
  'apiKey',
  'baseUrl',
  'providers',
  'modelRouting',
  'retention',
  'personalityRetention',
  'quickCommands',
  'channelToolsets',
  'voiceTtsProviders',
  'voiceSttProviders',
  'voiceRealtimeProviders',
  'voiceBots',
]);

export function buildConfigPatch(
  values: FormShape,
  rows: SettingsRows,
  saved: ConfigGetData | undefined,
): BuildConfigPatchResult {
  const {
    providerRows,
    quickCommandRows,
    channelToolsetRows,
    voiceTtsProviderRows,
    voiceSttProviderRows,
    voiceRealtimeProviderRows,
    retentionRows,
    voiceBotRows,
  } = rows;
  const primary = providerRows[0];
  if (!primary?.provider || !primary.model) {
    return { ok: false, error: 'Primary provider and model are required.' };
  }

  // -- Record-editor validation (mirrors the contract's Zod bounds) --------
  const fail = (message: string): { ok: false; error: string } => ({ ok: false, error: message });

  const quickCommands: Record<string, QuickCommandPatch> = {};
  for (const row of quickCommandRows) {
    const name = row.name.trim();
    if (!RECORD_KEY_RE.test(name)) {
      return fail(
        `Quick command "${name}" must use only letters, digits, hyphens, or underscores.`,
      );
    }
    if (quickCommands[name]) return fail(`Duplicate quick command "/${name}".`);
    if (row.type === 'exec' && !row.command.trim()) {
      return fail(`Quick command /${name} needs a shell command.`);
    }
    if (row.type === 'reply' && !row.reply.trim()) {
      return fail(`Quick command /${name} needs a reply text.`);
    }
    quickCommands[name] =
      row.type === 'exec'
        ? {
            type: 'exec',
            command: row.command.trim(),
            gateway: row.gateway,
            channels: row.channels,
          }
        : {
            type: 'reply',
            reply: row.reply.trim(),
            gateway: row.gateway,
            channels: row.channels,
          };
  }

  const channelToolsets: Record<string, string[]> = {};
  for (const row of channelToolsetRows) {
    const platform = row.platform.trim();
    if (!RECORD_KEY_RE.test(platform)) {
      return fail(
        `Channel toolsets: platform "${platform}" must use only letters, digits, hyphens, or underscores.`,
      );
    }
    if (channelToolsets[platform]) return fail(`Duplicate channel-toolset platform "${platform}".`);
    if (row.toolsets.length === 0) {
      return fail(
        `Channel toolsets: "${platform}" needs at least one toolset (or remove the row).`,
      );
    }
    channelToolsets[platform] = row.toolsets;
  }

  // Each roster replaces itself wholesale on save, so an omitted row IS a
  // deletion — and an entry with no `provider` names nothing resolvable, the
  // same rule the CLI's parser applies. One validator for all three kinds:
  // the rosters must reject the same names for the same reasons.
  const validateRoster = (
    rosterRows: VoiceProviderRow[],
    spec: VoiceRosterKindSpec,
  ): { ok: true; map: Record<string, VoiceProviderRow> } | { ok: false; error: string } => {
    const out: Record<string, VoiceProviderRow> = {};
    for (const row of rosterRows) {
      const name = row.name.trim();
      if (!RECORD_KEY_RE.test(name)) {
        return fail(
          `${spec.label} provider "${name}": the name becomes a ${spec.configKey}.<name> config key, so it may only use letters, digits, hyphens, or underscores.`,
        );
      }
      if (out[name]) return fail(`Duplicate ${spec.label} provider "${name}".`);
      if (!row.provider) return fail(`${spec.label} provider "${name}" needs a provider.`);
      if (row.provider === spec.commandProvider && !row.command.trim()) {
        return fail(`${spec.label} provider "${name}" needs a command template.`);
      }
      out[name] = row;
    }
    return { ok: true, map: out };
  };

  const ttsRoster = validateRoster(voiceTtsProviderRows, TTS_ROSTER_SPEC);
  if (!ttsRoster.ok) return ttsRoster;
  const ttsRosterRows = ttsRoster.map;
  const sttRoster = validateRoster(voiceSttProviderRows, STT_ROSTER_SPEC);
  if (!sttRoster.ok) return sttRoster;
  const sttRosterRows = sttRoster.map;
  const realtimeRoster = validateRoster(voiceRealtimeProviderRows, REALTIME_ROSTER_SPEC);
  if (!realtimeRoster.ok) return realtimeRoster;
  const realtimeRosterRows = realtimeRoster.map;
  // The default NAMES a row, so a name that no longer exists would write a
  // dangling key — caught here rather than discovered on the first spoken turn.
  const realtimeDefault = values.voiceRealtimeDefault.trim();
  if (realtimeDefault && !realtimeRosterRows[realtimeDefault]) {
    return fail(
      `Default realtime provider "${realtimeDefault}" is not one of the realtime providers below.`,
    );
  }

  const voiceTtsProviders: Record<string, VoiceTtsProviderPatch> = {};
  for (const [name, row] of Object.entries(ttsRosterRows)) {
    voiceTtsProviders[name] = voiceTtsProviderPatchFromRow(row);
  }
  const voiceSttProviders: Record<string, VoiceSttProviderPatch> = {};
  for (const [name, row] of Object.entries(sttRosterRows)) {
    voiceSttProviders[name] = voiceSttProviderPatchFromRow(row);
  }
  const voiceRealtimeProviders: Record<string, VoiceRealtimeProviderPatch> = {};
  for (const [name, row] of Object.entries(realtimeRosterRows)) {
    voiceRealtimeProviders[name] = voiceRealtimeProviderPatchFromRow(row);
  }

  // Telephony blocks are all-or-nothing on disk, so a half-filled block is
  // refused here with the sentence that says which half is missing — before
  // anything is written, and never as a half-block the CLI cannot load.
  const telephony = voiceTelephonyPatch(values, {
    voiceTrunkPasswordPreview: saved?.voiceTrunkPasswordPreview ?? null,
    voiceTrunkWebhookSecretPreview: saved?.voiceTrunkWebhookSecretPreview ?? null,
    voiceLivekitApiKeyPreview: saved?.voiceLivekitApiKeyPreview ?? null,
    voiceLivekitApiSecretPreview: saved?.voiceLivekitApiSecretPreview ?? null,
  });
  if (!telephony.ok) return fail(telephony.error);
  const voiceBots = voiceBotsPatchFromRows(voiceBotRows);
  if (!voiceBots.ok) return fail(voiceBots.error);

  const retention: Partial<Record<RetentionSubkey, string>> = {};
  const personalityRetention: Record<string, Partial<Record<RetentionSubkey, string>>> = {};
  for (const row of retentionRows) {
    const duration = row.duration.trim();
    if (!RETENTION_DURATION_RE.test(duration)) {
      return fail(
        `Retention for "${row.subkey}": use "forever" or a number plus d/w/m/y (e.g. 90d).`,
      );
    }
    if (row.personalityId) {
      if (!RECORD_KEY_RE.test(row.personalityId)) {
        return fail(
          `Retention: personality id "${row.personalityId}" must use only letters, digits, hyphens, or underscores.`,
        );
      }
      const map = personalityRetention[row.personalityId] ?? {};
      if (map[row.subkey]) {
        return fail(`Duplicate retention rule for ${row.personalityId} / ${row.subkey}.`);
      }
      map[row.subkey] = duration;
      personalityRetention[row.personalityId] = map;
    } else {
      if (retention[row.subkey]) return fail(`Duplicate global retention rule for ${row.subkey}.`);
      retention[row.subkey] = duration;
    }
  }

  // Build the providers array for the update
  const providers = providerRows.map((row) => {
    const entry: { provider: string; model?: string; apiKey?: string; baseUrl?: string } = {
      provider: row.provider,
    };
    if (row.model) entry.model = row.model;
    if (row.apiKey) entry.apiKey = row.apiKey;
    if (row.baseUrl) entry.baseUrl = row.baseUrl;
    return entry;
  });

  const patch: ConfigUpdatePatch = {
    // Backward compat: also write the legacy single-provider fields from primary
    provider: primary.provider,
    model: primary.model,
    personality: values.personality,
    memory: values.memory,
    skin: values.skin,
    approvalMode: values.approvalMode,
    verbosity: values.verbosity,
    debugMode: values.debugMode,
    contextLayering: values.contextLayering,
    debugPanelEnabled: values.debugPanelEnabled,
    debugPanelModel: values.debugPanelModel || null,
    adminEnabled: values.adminEnabled,
    streamingEdits: values.streamingEdits,
    autoCompact: values.autoCompact,
    memoryConsolidationEnabled: values.memoryConsolidationEnabled,
    memoryCaptureEnabled: values.memoryCaptureEnabled,
    memoryCaptureModel: values.memoryCaptureModel,
    memoryNotices: values.memoryNotices,
    voiceChime: values.voiceChime,
    callStyle: values.callStyle,
    callAccent:
      values.callAccent === CALL_ACCENT_CUSTOM ? values.callAccentCustom : values.callAccent,
    voiceEndpointSilenceMs: values.voiceEndpointSilenceMs,
    voiceBargeThreshold: values.voiceBargeThreshold,
    voiceBargeSustainMs: values.voiceBargeSustainMs,
    voiceSpeechThreshold: values.voiceSpeechThreshold,
    voiceSpeechMinMs: values.voiceSpeechMinMs,
    // Empty string = null = the key is dropped from config.yaml.
    voiceSttCommand: values.voiceSttCommand || null,
    voiceTtsCommand: values.voiceTtsCommand || null,
    voiceTtsOutputFormat: audioFormatOrNull(values.voiceTtsOutputFormat),
    voiceTtsTimeoutMs: values.voiceTtsTimeoutMs ?? null,
    voiceTtsMaxTextLength: values.voiceTtsMaxTextLength ?? null,
    voiceSttTimeoutMs: values.voiceSttTimeoutMs ?? null,
    // Off = drop the key entirely, which is what turns the gate off.
    voiceTrustedPlugins: values.voiceEgressGate ? values.voiceTrustedPlugins : null,
    voiceDefaultMode: voiceModeOrNull(values.voiceDefaultMode),
    voiceChannelTtsOut: voiceChannelTtsOutPatch(values.voiceChannelTtsOut),
    voiceTranscodeFfmpegPath: values.voiceTranscodeFfmpegPath || null,
    voiceTranscodeBitrateKbps: values.voiceTranscodeBitrateKbps ?? null,
    voiceTranscodeTimeoutSec: values.voiceTranscodeTimeoutSec ?? null,
    voiceArtifactAbandonAfterDays: values.voiceArtifactAbandonAfterDays ?? null,
    voiceArtifactMaxTotalMb: values.voiceArtifactMaxTotalMb ?? null,
    voiceTier: voiceTierOrNull(values.voiceTier),
    voiceRealtimeDefault: realtimeDefault || null,
    voiceRealtimeSessionBudgetUsd: values.voiceRealtimeSessionBudgetUsd ?? null,
    ...telephony.patch,
    voiceBots: voiceBots.bots,
    ...(!values.voiceEnabled
      ? saved?.voiceProvider || saved?.voiceTtsProvider
        ? { voiceProvider: '', voiceTtsProvider: '' }
        : {}
      : {
          ...((values.voiceProvider ?? '') !== (saved?.voiceProvider ?? '')
            ? { voiceProvider: values.voiceProvider }
            : {}),
          ...(values.voiceApiKey ? { voiceApiKey: values.voiceApiKey } : {}),
          ...((values.voiceBaseUrl ?? '') !== (saved?.voiceBaseUrl ?? '')
            ? { voiceBaseUrl: values.voiceBaseUrl }
            : {}),
          ...((values.voiceModel ?? '') !== (saved?.voiceModel ?? '')
            ? { voiceModel: values.voiceModel }
            : {}),
          ...((values.voiceTtsProvider ?? '') !== (saved?.voiceTtsProvider ?? '')
            ? { voiceTtsProvider: values.voiceTtsProvider }
            : {}),
          ...(values.voiceTtsApiKey ? { voiceTtsApiKey: values.voiceTtsApiKey } : {}),
          ...((values.voiceTtsVoice ?? '') !== (saved?.voiceTtsVoice ?? '')
            ? { voiceTtsVoice: values.voiceTtsVoice }
            : {}),
          ...((values.voiceTtsBaseUrl ?? '') !== (saved?.voiceTtsBaseUrl ?? '')
            ? { voiceTtsBaseUrl: values.voiceTtsBaseUrl }
            : {}),
          ...((values.voiceTtsModel ?? '') !== (saved?.voiceTtsModel ?? '')
            ? { voiceTtsModel: values.voiceTtsModel }
            : {}),
        }),
    modelRouting: Object.fromEntries(
      Object.entries(saved?.modelRouting ?? {}).filter(([k]) => k !== '__fallbackChain'),
    ),
    providers,
    // -- Settings-page additions ------------------------------------------
    // Scalars: null clears the config.yaml key back to its built-in default.
    // Records (quickCommands, channelToolsets, retention,
    // personalityRetention) are full replacements; `webhooks` is omitted —
    // hooks are edited on each Personality page's Triggers section. Secrets
    // are write-only — included only when the user typed a fresh value.
    displayVerbosity: values.displayVerbosity,
    displayBusyInputMode: values.displayBusyInputMode,
    displayToolPreviewLength: values.displayToolPreviewLength ?? null,
    displayResumeHint: values.displayResumeHint,
    displayResumeRecapTurns: values.displayResumeRecapTurns ?? null,
    displayBellOnComplete: values.displayBellOnComplete,
    compaction: {
      pressure: values.compaction.pressure ?? null,
      target: values.compaction.target ?? null,
      gateDelta: values.compaction.gateDelta ?? null,
      retryOnOverflow: values.compaction.retryOnOverflow,
      smallWindow: values.compaction.smallWindow,
    },
    ...(values.memory === 'vault'
      ? {
          memoryVault: {
            path: strOrNull(values.memoryVault.path),
            agentDir: strOrNull(values.memoryVault.agentDir),
            prefetch: values.memoryVault.prefetch,
            exclude: values.memoryVault.exclude,
          },
        }
      : {}),
    memoryApproval: {
      mode: values.memoryApproval.mode,
      cap: values.memoryApproval.cap ?? null,
      ttlDays: values.memoryApproval.ttlDays ?? null,
    },
    memoryConsolidation: {
      halfLifeDays: values.memoryConsolidation.halfLifeDays ?? null,
      threshold: values.memoryConsolidation.threshold ?? null,
      exemptUser: values.memoryConsolidation.exemptUser,
      flushThreshold: values.memoryConsolidation.flushThreshold ?? null,
      timeboxMs: values.memoryConsolidation.timeboxMs ?? null,
      maxTokens: values.memoryConsolidation.maxTokens ?? null,
      maxDeltaChars: values.memoryConsolidation.maxDeltaChars ?? null,
      minMessagesSinceFlush: values.memoryConsolidation.minMessagesSinceFlush ?? null,
    },
    memoryCapture: {
      provider: strOrNull(values.memoryCapture.provider),
      baseUrl: strOrNull(values.memoryCapture.baseUrl),
      maxPerHour: values.memoryCapture.maxPerHour ?? null,
      maxPerDay: values.memoryCapture.maxPerDay ?? null,
      ...(values.memoryCapture.apiKey ? { apiKey: values.memoryCapture.apiKey } : {}),
    },
    background: {
      enabled: values.background.enabled,
      maxConcurrentJobs: values.background.maxConcurrentJobs ?? null,
      maxJobsPerRoot: values.background.maxJobsPerRoot ?? null,
      maxJobsPerPersonality: values.background.maxJobsPerPersonality ?? null,
      defaultMaxCostUsd: values.background.defaultMaxCostUsd ?? null,
      maxRootBackgroundUsd: values.background.maxRootBackgroundUsd ?? null,
      queuedTtlMs: values.background.queuedTtlMs ?? null,
      staleMs: values.background.staleMs ?? null,
      heartbeatMs: values.background.heartbeatMs ?? null,
      retentionDays: values.background.retentionDays ?? null,
    },
    nightlyPass: {
      enabled: values.nightlyPass.enabled,
      cron: strOrNull(values.nightlyPass.cron),
    },
    weeklyDigest: {
      enabled: values.weeklyDigest.enabled,
      cron: strOrNull(values.weeklyDigest.cron),
      recipients: values.weeklyDigest.recipients,
    },
    modelCatalog: {
      enabled: values.modelCatalog.enabled,
      url: strOrNull(values.modelCatalog.url),
      ttlHours: values.modelCatalog.ttlHours ?? null,
    },
    logsRotation: {
      enabled: values.logsRotation.enabled,
      maxBytes: values.logsRotation.maxBytes ?? null,
      maxFiles: values.logsRotation.maxFiles ?? null,
    },
    webSearchBackend: values.webSearchBackend === '' ? null : values.webSearchBackend,
    webExtractBackend: values.webExtractBackend === '' ? null : values.webExtractBackend,
    auxCompression: auxPatchFromForm(values.auxCompression),
    auxVision: auxPatchFromForm(values.auxVision),
    auxWeb: auxPatchFromForm(values.auxWeb),
    apiVersion: strOrNull(values.apiVersion),
    verbose: values.verbose,
    pluginsAutoInstall:
      values.pluginsAutoInstall === 'default' ? null : values.pluginsAutoInstall === 'on',
    webBaseUrl: strOrNull(values.webBaseUrl),
    retention,
    personalityRetention,
    quickCommands,
    channelToolsets,
    voiceTtsProviders,
    voiceSttProviders,
    voiceRealtimeProviders,
  };
  if (primary.apiKey) patch.apiKey = primary.apiKey;
  if (primary.baseUrl !== undefined) patch.baseUrl = primary.baseUrl;

  // The absent-field guard — the behavioural half of the invariant in §5.1.
  //
  // Every key left in the patch that is not derived above is written from the
  // same-named field of `values`, most of them through `?? null`. `null` is a
  // CLEAR in `config.update`, so a field the store does not carry would be saved
  // as a DELETION rather than skipped. That cannot happen while the single
  // `<Form>` encloses the `<Outlet/>` and `preserve` stays at its default — this
  // is the second lock on the same door, so the deletion stays impossible even
  // if the structure is refactored into a shape the source-text test no longer
  // recognises. An absent field means "this pane never mounted", never "the user
  // cleared it".
  for (const key of Object.keys(patch)) {
    if (DERIVED_PATCH_KEYS.has(key)) continue;
    if (key in values) continue;
    delete (patch as Record<string, unknown>)[key];
  }

  return { ok: true, patch };
}
