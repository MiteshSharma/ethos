// The page form's value shape, and the auxiliary-model slot it repeats three
// times. Moved verbatim out of `Settings.tsx` (Phase 1).
//
// ONE form instance holds all of this, mounted in `SettingsShell` ABOVE the
// `<Outlet/>` — see plan/phases/settings-navigation.md §5.3. A pane must never
// mint a second instance for these fields.

import { type ConfigGetData, type ConfigUpdatePatch, strOrNull } from './config-types';
import type { VoiceTelephonyFormValues } from './voice-telephony';

export interface AuxModelFormShape {
  model: string;
  provider: string;
  /** New key typed by the user; empty keeps the stored one. */
  apiKey: string;
  baseUrl: string;
}

export function auxFormFromConfig(aux: ConfigGetData['auxCompression']): AuxModelFormShape {
  return {
    model: aux.model ?? '',
    provider: aux.provider ?? '',
    apiKey: '',
    baseUrl: aux.baseUrl ?? '',
  };
}

export function auxPatchFromForm(
  a: AuxModelFormShape,
): NonNullable<ConfigUpdatePatch['auxCompression']> {
  return {
    model: strOrNull(a.model),
    provider: strOrNull(a.provider),
    baseUrl: strOrNull(a.baseUrl),
    ...(a.apiKey ? { apiKey: a.apiKey } : {}),
  };
}

// ---------------------------------------------------------------------------
// Form shape (no longer includes provider/model/apiKey/baseUrl — those live
// in the provider chain state)
// ---------------------------------------------------------------------------

// Extends rather than restates the telephony fields: the patch builder and the
// form must agree on them exactly, and a duplicated list is a list that drifts.
export interface FormShape extends VoiceTelephonyFormValues {
  personality: string;
  memory: 'markdown' | 'vector' | 'vault';
  skin: string;
  approvalMode: 'manual' | 'smart' | 'off';
  verbosity: 'concise' | 'balanced' | 'verbose';
  debugMode: boolean;
  contextLayering: boolean;
  debugPanelEnabled: boolean;
  debugPanelModel: string;
  adminEnabled: boolean;
  streamingEdits: 'off' | 'dms' | 'all';
  autoCompact: boolean;
  memoryConsolidationEnabled: boolean;
  memoryCaptureEnabled: boolean;
  memoryCaptureModel: string;
  memoryNotices: boolean;
  voiceEnabled: boolean;
  voiceChime: boolean;
  /** Call Stage treatment (display.call_style). `personality` = per-agent. */
  callStyle: 'liquid' | 'orb' | 'rings' | 'personality';
  /** `personality`, one of the preset hexes, or `custom`. */
  callAccent: string;
  /** The hex behind `callAccent: 'custom'`. Ignored otherwise. */
  callAccentCustom: string;
  voiceEndpointSilenceMs: number;
  voiceBargeThreshold: number;
  voiceBargeSustainMs: number;
  voiceSpeechThreshold: number;
  voiceSpeechMinMs: number;
  voiceProvider: string;
  voiceApiKey: string;
  voiceBaseUrl: string;
  voiceModel: string;
  voiceTtsProvider: string;
  voiceTtsApiKey: string;
  voiceTtsVoice: string;
  voiceTtsBaseUrl: string;
  voiceTtsModel: string;
  /** Shell templates for `command-stt` / `command-tts`. */
  voiceSttCommand: string;
  voiceTtsCommand: string;
  voiceTtsOutputFormat: string;
  voiceTtsTimeoutMs: number | null;
  voiceTtsMaxTextLength: number | null;
  voiceSttTimeoutMs: number | null;
  /** Arms the local-only egress gate (`voice.trustedPlugins` is declared). */
  voiceEgressGate: boolean;
  voiceTrustedPlugins: string[];
  voiceDefaultMode: string;
  /** `voice.channels.<platform>.ttsOut`, one entry per known channel. On = the
   *  channel follows the conversation's mode; off = it never speaks. */
  voiceChannelTtsOut: Record<string, boolean>;
  /** `voice.transcode.*` — '' / null mean "use the built-in default". */
  voiceTranscodeFfmpegPath: string;
  voiceTranscodeBitrateKbps: number | null;
  voiceTranscodeTimeoutSec: number | null;
  /** `voice.artifacts.*` — the bound on artifacts whose delivery never confirmed. */
  voiceArtifactAbandonAfterDays: number | null;
  voiceArtifactMaxTotalMb: number | null;
  /** `voice.tier` — '' = unset, so the surface picks. */
  voiceTier: string;
  /** `voice.realtime.default` — a realtime roster label, '' = unset. */
  voiceRealtimeDefault: string;
  voiceRealtimeSessionBudgetUsd: number | null;
  // -- Settings-page additions (config.get/config.update passthrough keys) ----
  displayVerbosity: 'quiet' | 'default' | 'verbose' | 'debug';
  displayBusyInputMode: 'interrupt' | 'queue' | 'steer';
  displayToolPreviewLength: number | null;
  displayResumeHint: boolean;
  displayResumeRecapTurns: number | null;
  displayBellOnComplete: boolean;
  compaction: {
    pressure: number | null;
    target: number | null;
    gateDelta: number | null;
    retryOnOverflow: boolean;
    /** `compaction.abortOnSummaryFailure` — default false. */
    abortOnSummaryFailure: boolean;
    smallWindow: 'auto' | 'on' | 'off';
  };
  /** `voice.filler.*` — the tool-call filler/tick keep-alive. Global, not per-surface. */
  voiceFiller: {
    enabled: boolean;
    afterMs: number | null;
    /** '' = unset = the built-in default applies, same as `memoryVault.path`. */
    text: string;
    tickIntervalMs: number | null;
  };
  memoryVault: { path: string; agentDir: string; prefetch: string[]; exclude: string[] };
  memoryApproval: { mode: 'off' | 'automated' | 'all'; cap: number | null; ttlDays: number | null };
  memoryConsolidation: {
    halfLifeDays: number | null;
    threshold: number | null;
    exemptUser: boolean;
    flushThreshold: number | null;
    timeboxMs: number | null;
    maxTokens: number | null;
    maxDeltaChars: number | null;
    minMessagesSinceFlush: number | null;
  };
  memoryCapture: {
    provider: string;
    apiKey: string;
    baseUrl: string;
    maxPerHour: number | null;
    maxPerDay: number | null;
  };
  background: {
    enabled: boolean;
    maxConcurrentJobs: number | null;
    maxJobsPerRoot: number | null;
    maxJobsPerPersonality: number | null;
    defaultMaxCostUsd: number | null;
    maxRootBackgroundUsd: number | null;
    queuedTtlMs: number | null;
    staleMs: number | null;
    heartbeatMs: number | null;
    retentionDays: number | null;
  };
  /** `backup.*` — scheduled local snapshots. Blank / empty = the built-in
   *  default applies; `dir` blank = `<ethosDir>/backups`, computed in code. */
  backup: { enabled: boolean; cron: string; scope: string[]; keep: number | null; dir: string };
  nightlyPass: { enabled: boolean; cron: string };
  weeklyDigest: { enabled: boolean; cron: string; recipients: string[] };
  modelCatalog: { enabled: boolean; url: string; ttlHours: number | null };
  logsRotation: { enabled: boolean; maxBytes: number | null; maxFiles: number | null };
  /** `logs.level` — lowest severity `ConsoleLogger` prints. */
  logsLevel: 'debug' | 'info' | 'warn' | 'error';
  /** `retention.vacuumAfterPrune` — VACUUM the session DB after a prune sweep. */
  retentionVacuumAfterPrune: boolean;
  /** `retention.minVacuumIntervalDays` — null = no minimum interval. */
  retentionMinVacuumIntervalDays: number | null;
  /** `memory.charLimits.*` — per-key ceilings for the markdown memory backend. */
  memoryCharLimits: { memory: number | null; user: number | null };
  /** `execution.docker.*` — container caps; `diskMb` null = no quota. */
  executionDocker: { cpu: number | null; diskMb: number | null };
  /** `execution.ssh.*` — the single remote target. Blank `host` = no remote
   *  execution on this deployment; blank elsewhere = ssh's own default. */
  executionSsh: {
    host: string;
    user: string;
    port: number | null;
    identityFile: string;
    knownHostsFile: string;
    strictHostKeys: string;
    remoteWorkdir: string;
  };
  /** `toolLoop.*` — soft-warn tiers; null = no warn tier. */
  toolLoop: { maxToolCallsWarnAt: number | null; maxIdenticalToolCallsWarnAt: number | null };
  /** `browser.*` — Playwright budgets, milliseconds. */
  browser: { navigationTimeoutMs: number | null; commandTimeoutMs: number | null };
  /** `kanban.*` — board WIP caps; null = uncapped. */
  kanban: { maxInProgress: number | null; maxInProgressPerProfile: number | null };
  /** `cron.maxParallelJobs` — concurrent cron firings; null = uncapped. */
  cronMaxParallelJobs: number | null;
  /** `gateway.maxInboundMediaBytes` — override on every adapter's inbound cap;
   *  null = each adapter keeps its own. */
  gatewayMaxInboundMediaBytes: number | null;
  /** `teamSupervisor.restartLoopGuard.*` — the member auto-restart brake. */
  teamSupervisorRestartLoopGuard: { maxRestarts: number | null; windowSeconds: number | null };
  /** `discord.missedMessageBackfill.*` — bounds on the first-sight history read. */
  discordMissedMessageBackfill: {
    enabled: boolean;
    windowSeconds: number | null;
    limit: number | null;
  };
  webSearchBackend: '' | 'exa' | 'tavily' | 'brave';
  webExtractBackend: '' | 'htmltext';
  auxCompression: AuxModelFormShape;
  auxVision: AuxModelFormShape;
  auxWeb: AuxModelFormShape;
  apiVersion: string;
  verbose: boolean;
  pluginsAutoInstall: 'default' | 'on' | 'off';
  webBaseUrl: string;
}
