import { describe, expect, it } from 'vitest';
import { buildConfigPatch, type SettingsRows } from '../lib/build-config-patch';
import type { FormShape } from '../lib/form-shape';

// T2 — plan/phases/settings-navigation.md §5 and §10.
//
// The BEHAVIOURAL half of the invariant T1 guards structurally. `onFinish` reads
// `form.getFieldsValue(true)` — the whole store, including fields whose panes
// are unmounted — and the builder maps ~100 of them through `values.x ?? null`.
// `null` is a CLEAR in `config.update`, so a value MISSING from the store is not
// a skipped update: it is a deletion. Saving from Memory would wipe the trunk
// credentials, silently.
//
// Two assertions, and the second is the one that matters:
//
//   1. A store carrying keys from three different categories emits all three —
//      the cross-category save works, which is what the two-pane shape needs.
//   2. A store MISSING a key emits neither the key nor an explicit `null` for
//      it — absence means "that pane never mounted", never "the user cleared
//      it". This fails even if a refactor invents a structure T1 does not
//      recognise, which is the whole reason the guard is doubled.

/** A complete, valid store — every category represented, nothing exotic. */
function store(): FormShape {
  return {
    // General
    personality: 'engineer',
    skin: 'ethos',
    // Memory
    memory: 'markdown',
    memoryNotices: true,
    memoryConsolidationEnabled: false,
    memoryCaptureEnabled: false,
    memoryCaptureModel: '',
    memoryVault: { path: '', agentDir: '', prefetch: [], exclude: [] },
    memoryApproval: { mode: 'off', cap: null, ttlDays: null },
    memoryConsolidation: {
      halfLifeDays: null,
      threshold: null,
      exemptUser: true,
      flushThreshold: null,
      timeboxMs: null,
      maxTokens: null,
      maxDeltaChars: null,
      minMessagesSinceFlush: null,
    },
    memoryCapture: { provider: '', apiKey: '', baseUrl: '', maxPerHour: null, maxPerDay: null },
    memoryCharLimits: { memory: 524_288, user: 524_288 },
    // Security & access
    approvalMode: 'smart',
    adminEnabled: false,
    gatewayMaxInboundMediaBytes: null,
    // Chat & context
    verbosity: 'balanced',
    streamingEdits: 'dms',
    contextLayering: false,
    autoCompact: true,
    compaction: {
      pressure: null,
      target: null,
      gateDelta: null,
      retryOnOverflow: true,
      abortOnSummaryFailure: false,
      smallWindow: 'auto',
    },
    displayVerbosity: 'default',
    displayBusyInputMode: 'interrupt',
    displayToolPreviewLength: null,
    displayResumeHint: true,
    displayResumeRecapTurns: null,
    displayBellOnComplete: false,
    discordMissedMessageBackfill: { enabled: true, windowSeconds: null, limit: 50 },
    // Developer
    debugMode: false,
    debugPanelEnabled: false,
    debugPanelModel: '',
    logsRotation: { enabled: true, maxBytes: null, maxFiles: null },
    logsLevel: 'debug',
    executionDocker: { cpu: 2, diskMb: null },
    toolLoop: { maxToolCallsWarnAt: null, maxIdenticalToolCallsWarnAt: null },
    browser: { navigationTimeoutMs: 30_000, commandTimeoutMs: 10_000 },
    pluginsAutoInstall: 'default',
    webBaseUrl: '',
    apiVersion: '',
    verbose: false,
    // Voice
    voiceEnabled: false,
    voiceChime: true,
    callStyle: 'personality',
    callAccent: 'personality',
    callAccentCustom: '',
    voiceEndpointSilenceMs: 600,
    voiceBargeThreshold: 0.05,
    voiceBargeSustainMs: 200,
    voiceSpeechThreshold: 0.02,
    voiceSpeechMinMs: 200,
    voiceProvider: '',
    voiceApiKey: '',
    voiceBaseUrl: '',
    voiceModel: '',
    voiceTtsProvider: '',
    voiceTtsApiKey: '',
    voiceTtsVoice: '',
    voiceTtsBaseUrl: '',
    voiceTtsModel: '',
    voiceSttCommand: '',
    voiceTtsCommand: '',
    voiceTtsOutputFormat: '',
    voiceTtsTimeoutMs: null,
    voiceTtsMaxTextLength: null,
    voiceSttTimeoutMs: null,
    voiceEgressGate: false,
    voiceTrustedPlugins: [],
    voiceDefaultMode: '',
    voiceChannelTtsOut: { telegram: true, slack: true, discord: true, whatsapp: true, email: true },
    voiceTranscodeFfmpegPath: '',
    voiceTranscodeBitrateKbps: null,
    voiceTranscodeTimeoutSec: null,
    voiceArtifactAbandonAfterDays: null,
    voiceArtifactMaxTotalMb: null,
    voiceTier: '',
    voiceRealtimeDefault: '',
    voiceRealtimeSessionBudgetUsd: null,
    // Voice → telephony
    voiceTrunkProvider: '',
    voiceTrunkId: '',
    voiceTrunkFromNumber: '',
    voiceTrunkUsername: '',
    voiceTrunkPassword: '',
    voiceTrunkWebhookSecret: '',
    voiceTrunkWebhookPath: '',
    voiceTrunkCodec: '',
    voiceLivekitUrl: '',
    voiceLivekitApiKey: '',
    voiceLivekitApiSecret: '',
    voiceInboundAllowlist: [],
    voiceInboundReceptionist: '',
    voiceInboundConcurrencyCap: null,
    voiceInboundPerCallerPerHour: null,
    voiceInboundDailyBudgetUsd: null,
    voiceInboundPrewarm: '',
    voiceInboundOwnerPlatform: '',
    voiceInboundOwnerChatId: '',
    voiceInboundOwnerBotKey: '',
    voiceBargeIn: {
      call: { energyThreshold: null, minSpeechMs: null, silenceMs: null },
      satellite: { energyThreshold: null, minSpeechMs: null, silenceMs: null },
    },
    voiceFiller: { enabled: true, afterMs: null, text: '', tickIntervalMs: null },
    // Background jobs
    background: {
      enabled: false,
      maxConcurrentJobs: null,
      maxJobsPerRoot: null,
      maxJobsPerPersonality: null,
      defaultMaxCostUsd: null,
      maxRootBackgroundUsd: null,
      queuedTtlMs: null,
      staleMs: null,
      heartbeatMs: null,
      retentionDays: null,
    },
    kanban: { maxInProgress: null, maxInProgressPerProfile: null },
    // Data & retention
    retentionVacuumAfterPrune: false,
    retentionMinVacuumIntervalDays: null,
    // Automation
    nightlyPass: { enabled: false, cron: '' },
    weeklyDigest: { enabled: false, cron: '', recipients: [] },
    cronMaxParallelJobs: null,
    teamSupervisorRestartLoopGuard: { maxRestarts: 5, windowSeconds: 60 },
    // Models & providers
    modelCatalog: { enabled: true, url: '', ttlHours: null },
    webSearchBackend: '',
    webExtractBackend: '',
    auxCompression: { model: '', provider: '', apiKey: '', baseUrl: '' },
    auxVision: { model: '', provider: '', apiKey: '', baseUrl: '' },
    auxWeb: { model: '', provider: '', apiKey: '', baseUrl: '' },
  };
}

function rows(): SettingsRows {
  return {
    providerRows: [
      {
        _id: 1,
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        apiKey: '',
        apiKeyPreview: 'sk-…abc1',
        baseUrl: '',
        testStatus: 'idle',
      },
    ],
    quickCommandRows: [],
    channelToolsetRows: [],
    voiceTtsProviderRows: [],
    voiceSttProviderRows: [],
    voiceRealtimeProviderRows: [],
    retentionRows: [],
    voiceBotRows: [],
  };
}

function build(values: FormShape) {
  const result = buildConfigPatch(values, rows(), undefined);
  if (!result.ok) throw new Error(`expected a patch, got: ${result.error}`);
  return result.patch as Record<string, unknown>;
}

describe('buildConfigPatch', () => {
  it('emits keys from every category, not just the one on screen', () => {
    const patch = build(store());
    // General · Memory · Voice — three panes, only one of which can be mounted.
    expect(patch.skin).toBe('ethos');
    expect(patch.memoryNotices).toBe(true);
    expect(patch.voiceChime).toBe(true);
  });

  it('skips a key the store does not carry — it does NOT clear it', () => {
    const partial = store();
    // What an unmounted General pane looks like if `preserve` ever stops holding.
    delete (partial as Partial<FormShape>).skin;

    const patch = build(partial);
    expect('skin' in patch).toBe(false);
    expect(patch.skin).not.toBeNull();
    // The categories still in the store are untouched by the omission.
    expect(patch.memoryNotices).toBe(true);
    expect(patch.voiceChime).toBe(true);
  });

  it('keeps the rows-derived keys, which have no same-named form field', () => {
    const patch = build(store());
    expect(patch.provider).toBe('anthropic');
    expect(patch.model).toBe('claude-opus-4-7');
    expect(patch.providers).toEqual([{ provider: 'anthropic', model: 'claude-opus-4-7' }]);
  });

  it('refuses a chain with no primary provider rather than saving a blank one', () => {
    const result = buildConfigPatch(store(), { ...rows(), providerRows: [] }, undefined);
    expect(result).toEqual({ ok: false, error: 'Primary provider and model are required.' });
  });
});
