// The per-control index — ONE table behind the rail's counts, the search filter,
// the `N advanced` figure, the per-control key line and the callouts
// (plan/phases/settings-navigation.md D8).
//
// Pure data, so the whole rail is testable without a DOM. Its one failure mode
// is DRIFT — a control that moves, appears or disappears without the table
// following — and `__tests__/settings-index-coverage.test.ts` (T6) checks both
// directions against the pane sources.
//
// Two conventions worth knowing before you edit a row:
//
//   `stateBacked: true` — the control is NOT a named `Form.Item`. Rosters, row
//   editors, tables and action buttons live in React state or save themselves.
//   They are in the table anyway, because five real sections would otherwise
//   render a count of 0 for controls that visibly exist; T6 exempts them from
//   the "has a form name" direction, since by definition they have none.
//
//   `key: null` — the control writes no `~/.ethos/config.yaml` key at all
//   (electron-store, the keychain, a secret store, or a navigation button).
//   `keyUnresolved` says which. The row renders no key line; it is not a TODO.
//
// Five source `Form.Item`s each render N controls with N distinct keys (the aux
// slots, the background numbers, the browser tuning sliders, the channel
// switches, the barge-in surfaces). They are expanded one entry per key so each
// is individually searchable — and so `voice.bargeIn.satellite.silenceMs` can
// carry `status: 'unread'` while its `call` sibling does not.

/** Which Save writes this control: the page's Save bar, or the control itself. */
export type SettingSaves = 'page' | 'self';

/**
 * `'unread'` = the key is written and stored but nothing reads it (§7).
 * `'broken'` = the control does not work at all. Neither is a bug this table
 * fixes — it is the honesty marker `StatusCallout` renders (plan §6.2, Phase 7).
 */
export type SettingStatus = 'unread' | 'broken' | null;

export interface SettingEntry {
  /** The `config.yaml` key this control writes, or `null` — see `keyUnresolved`. */
  key: string | null;
  /** Antd `Form.Item` name as a dotted path. `null` for state-backed controls. */
  formName: string | null;
  label: string;
  /** A `SettingsCategory.slug` from `taxonomy.ts`. */
  category: string;
  /** A `SettingsSection.slug` from `taxonomy.ts`. */
  section: string;
  /** Behind the advanced toggle — which DIMS it, never unmounts it (D10). */
  advanced: boolean;
  saves: SettingSaves;
  status: SettingStatus;
  /** Not a named `Form.Item`: a roster, table, row editor or action button. */
  stateBacked?: true;
  /** Why `key` is null. Present exactly when it is. */
  keyUnresolved?: string;
  /** Rendered by a `name={<expression>}` site that declares this group id. */
  dynamicGroup?: string;
  /**
   * The control writes no key OF ITS OWN — it derives from another field
   * (§7: `Voice enabled`, `Restrict voice egress`). `SettingRow` renders the
   * literal word `derived` where the key line normally goes instead of a
   * plausible-looking key that does not exist.
   */
  derived?: true;
}

interface Row {
  key: string | null;
  formName?: string;
  label: string;
  advanced?: boolean;
  saves?: SettingSaves;
  status?: SettingStatus;
  stateBacked?: true;
  keyUnresolved?: string;
  dynamicGroup?: string;
  derived?: true;
}

/** Hoists the category/section out of every row, and applies the defaults. */
function group(category: string, section: string, rows: Row[]): SettingEntry[] {
  return rows.map((r) => ({
    ...r,
    formName: r.formName ?? null,
    category,
    section,
    advanced: r.advanced ?? false,
    saves: r.saves ?? 'page',
    status: r.status ?? null,
  }));
}

export const SETTINGS_INDEX: readonly SettingEntry[] = [
  ...group('general', 'basics', [
    { key: 'personality', formName: 'personality', label: 'Personality' },
    { key: 'skin', formName: 'skin', label: 'Skin' },
  ]),
  ...group('general', 'onboarding', [
    {
      key: null,
      label: 'Run setup wizard',
      saves: 'self',
      stateBacked: true,
      keyUnresolved: "Navigation button (navigate('/onboarding')); writes no config key itself.",
    },
  ]),
  ...group('models', 'provider-chain', [
    {
      key: 'providers.<n>.provider | .model | .apiKey',
      label: 'Provider chain rows',
      stateBacked: true,
    },
    {
      key: 'providers.<n>.baseUrl',
      label: 'Provider chain — Base URL',
      advanced: true,
      stateBacked: true,
    },
  ]),
  ...group('models', 'catalog-and-backends', [
    {
      key: 'modelCatalog.enabled',
      formName: 'modelCatalog.enabled',
      label: 'Remote model catalog',
      advanced: true,
    },
    { key: 'modelCatalog.url', formName: 'modelCatalog.url', label: 'Catalog URL', advanced: true },
    {
      key: 'modelCatalog.ttlHours',
      formName: 'modelCatalog.ttlHours',
      label: 'Catalog TTL (hours)',
      advanced: true,
    },
    {
      key: 'web.search_backend',
      formName: 'webSearchBackend',
      label: 'Web search backend',
      advanced: true,
    },
    {
      key: 'web.extract_backend',
      formName: 'webExtractBackend',
      label: 'Web extract backend',
      advanced: true,
    },
  ]),
  ...group('models', 'auxiliary-models', [
    {
      key: 'auxiliary.compression.model',
      formName: 'auxCompression.model',
      label: 'Compression model — Model',
      advanced: true,
    },
    {
      key: 'auxiliary.compression.provider',
      formName: 'auxCompression.provider',
      label: 'Compression model — Provider',
      advanced: true,
    },
    {
      key: 'auxiliary.compression.apiKey',
      formName: 'auxCompression.apiKey',
      label: 'Compression model — API key',
      advanced: true,
    },
    {
      key: 'auxiliary.compression.baseUrl',
      formName: 'auxCompression.baseUrl',
      label: 'Compression model — Base URL',
      advanced: true,
    },
    {
      key: 'auxiliary.vision.model',
      formName: 'auxVision.model',
      label: 'Vision model — Model',
      advanced: true,
    },
    {
      key: 'auxiliary.vision.provider',
      formName: 'auxVision.provider',
      label: 'Vision model — Provider',
      advanced: true,
    },
    {
      key: 'auxiliary.vision.apiKey',
      formName: 'auxVision.apiKey',
      label: 'Vision model — API key',
      advanced: true,
    },
    {
      key: 'auxiliary.vision.baseUrl',
      formName: 'auxVision.baseUrl',
      label: 'Vision model — Base URL',
      advanced: true,
    },
    {
      key: 'auxiliary.web.model',
      formName: 'auxWeb.model',
      label: 'Web summarizer — Model',
      advanced: true,
    },
    {
      key: 'auxiliary.web.provider',
      formName: 'auxWeb.provider',
      label: 'Web summarizer — Provider',
      advanced: true,
    },
    {
      key: 'auxiliary.web.apiKey',
      formName: 'auxWeb.apiKey',
      label: 'Web summarizer — API key',
      advanced: true,
    },
    {
      key: 'auxiliary.web.baseUrl',
      formName: 'auxWeb.baseUrl',
      label: 'Web summarizer — Base URL',
      advanced: true,
    },
  ]),
  ...group('memory', 'store', [
    { key: 'memory', formName: 'memory', label: 'Memory mode' },
    { key: 'memoryVault.path', formName: 'memoryVault.path', label: 'Vault path' },
    { key: 'memoryVault.agentDir', formName: 'memoryVault.agentDir', label: 'Agent directory' },
    { key: 'memoryVault.prefetch', formName: 'memoryVault.prefetch', label: 'Prefetch notes' },
    { key: 'memoryVault.exclude', formName: 'memoryVault.exclude', label: 'Excluded notes' },
  ]),
  ...group('memory', 'approval', [
    { key: 'memoryApproval.mode', formName: 'memoryApproval.mode', label: 'Memory approval' },
    {
      key: 'memoryApproval.cap',
      formName: 'memoryApproval.cap',
      label: 'Pending queue cap',
      advanced: true,
    },
    {
      key: 'memoryApproval.ttlDays',
      formName: 'memoryApproval.ttlDays',
      label: 'Pending TTL (days)',
      advanced: true,
    },
  ]),
  ...group('memory', 'consolidation', [
    {
      key: 'memoryConsolidation.enabled',
      formName: 'memoryConsolidationEnabled',
      label: 'Consolidate memory between turns',
    },
    {
      key: 'memoryConsolidation.flushThreshold',
      formName: 'memoryConsolidation.flushThreshold',
      label: 'Flush threshold',
      advanced: true,
    },
    {
      key: 'memoryConsolidation.timeboxMs',
      formName: 'memoryConsolidation.timeboxMs',
      label: 'Flush timebox (ms)',
      advanced: true,
    },
    {
      key: 'memoryConsolidation.maxTokens',
      formName: 'memoryConsolidation.maxTokens',
      label: 'Flush token cap',
      advanced: true,
    },
    {
      key: 'memoryConsolidation.maxDeltaChars',
      formName: 'memoryConsolidation.maxDeltaChars',
      label: 'Max characters per flush',
      advanced: true,
    },
    {
      key: 'memoryConsolidation.minMessagesSinceFlush',
      formName: 'memoryConsolidation.minMessagesSinceFlush',
      label: 'Messages between flushes',
      advanced: true,
    },
    {
      key: 'memoryConsolidation.halfLifeDays',
      formName: 'memoryConsolidation.halfLifeDays',
      label: 'Decay half-life (days)',
      advanced: true,
    },
    {
      key: 'memoryConsolidation.threshold',
      formName: 'memoryConsolidation.threshold',
      label: 'Decay archive threshold',
      advanced: true,
    },
    {
      key: 'memoryConsolidation.exemptUser',
      formName: 'memoryConsolidation.exemptUser',
      label: 'Exempt USER.md from decay',
      advanced: true,
    },
  ]),
  ...group('memory', 'capture', [
    {
      key: 'memoryCapture.enabled',
      formName: 'memoryCaptureEnabled',
      label: 'Capture facts proactively',
    },
    { key: 'memoryCapture.model', formName: 'memoryCaptureModel', label: 'Capture model' },
    {
      key: 'memoryCapture.maxPerHour',
      formName: 'memoryCapture.maxPerHour',
      label: 'Captures per hour',
    },
    {
      key: 'memoryCapture.maxPerDay',
      formName: 'memoryCapture.maxPerDay',
      label: 'Captures per day',
    },
    {
      key: 'memoryCapture.provider',
      formName: 'memoryCapture.provider',
      label: 'Capture provider',
      advanced: true,
    },
    {
      key: 'memoryCapture.apiKey',
      formName: 'memoryCapture.apiKey',
      label: 'Capture API key',
      advanced: true,
    },
    {
      key: 'memoryCapture.baseUrl',
      formName: 'memoryCapture.baseUrl',
      label: 'Capture base URL',
      advanced: true,
    },
    {
      key: 'display.memory_notices',
      formName: 'memoryNotices',
      label: "Show 'remembered' notices",
    },
  ]),
  ...group('chat', 'display', [
    { key: 'verbosity', formName: 'verbosity', label: 'Verbosity' },
    { key: 'display.streaming_edits', formName: 'streamingEdits', label: 'Stream draft edits' },
    { key: 'display.verbosity', formName: 'displayVerbosity', label: 'Surface verbosity' },
    { key: 'display.busy_input_mode', formName: 'displayBusyInputMode', label: 'Enter while busy' },
    {
      key: 'display.tool_preview_length',
      formName: 'displayToolPreviewLength',
      label: 'Tool preview length',
      advanced: true,
    },
    {
      key: 'display.resume_hint',
      formName: 'displayResumeHint',
      label: 'Resume hint',
      advanced: true,
    },
    {
      key: 'display.resume_recap_turns',
      formName: 'displayResumeRecapTurns',
      label: 'Resume recap turns',
      advanced: true,
    },
    {
      key: 'display.bell_on_complete',
      formName: 'displayBellOnComplete',
      label: 'Bell on completion',
      advanced: true,
    },
  ]),
  ...group('chat', 'context', [
    { key: 'contextLayering', formName: 'contextLayering', label: 'Enable context layering' },
    { key: 'compaction.autoCompact', formName: 'autoCompact', label: 'Auto-compaction' },
    {
      key: 'compaction.pressure',
      formName: 'compaction.pressure',
      label: 'Compaction pressure',
      advanced: true,
    },
    {
      key: 'compaction.target',
      formName: 'compaction.target',
      label: 'Compaction target',
      advanced: true,
    },
    {
      key: 'compaction.gateDelta',
      formName: 'compaction.gateDelta',
      label: 'Gate delta (tokens)',
      advanced: true,
    },
    {
      key: 'compaction.retryOnOverflow',
      formName: 'compaction.retryOnOverflow',
      label: 'Retry on overflow',
      advanced: true,
    },
    {
      key: 'compaction.smallWindow',
      formName: 'compaction.smallWindow',
      label: 'Small-window mode',
      advanced: true,
    },
  ]),
  ...group('voice', 'how-it-talks', [
    { key: 'voice.tier', formName: 'voiceTier', label: 'How the agent talks' },
  ]),
  ...group('voice', 'speech-to-text', [
    { key: 'auxiliary.asr.provider', formName: 'voiceProvider', label: 'Default provider (STT)' },
    { key: 'auxiliary.asr.baseUrl', formName: 'voiceBaseUrl', label: 'STT Base URL' },
    { key: 'auxiliary.asr.command', formName: 'voiceSttCommand', label: 'STT command' },
    { key: 'auxiliary.asr.model', formName: 'voiceModel', label: 'STT Model' },
    { key: 'auxiliary.asr.apiKey', formName: 'voiceApiKey', label: 'STT API key (optional)' },
    { key: 'auxiliary.asr.timeout', formName: 'voiceSttTimeoutMs', label: 'STT timeout (ms)' },
    { key: 'voice.stt.providers.<name>.*', label: 'STT provider roster', stateBacked: true },
  ]),
  ...group('voice', 'text-to-speech', [
    {
      key: 'auxiliary.tts.provider',
      formName: 'voiceTtsProvider',
      label: 'Default provider (TTS)',
    },
    { key: 'auxiliary.tts.baseUrl', formName: 'voiceTtsBaseUrl', label: 'TTS Base URL' },
    { key: 'auxiliary.tts.command', formName: 'voiceTtsCommand', label: 'TTS command' },
    { key: 'auxiliary.tts.model', formName: 'voiceTtsModel', label: 'TTS Model' },
    { key: 'auxiliary.tts.apiKey', formName: 'voiceTtsApiKey', label: 'TTS API key (optional)' },
    { key: 'auxiliary.tts.voice', formName: 'voiceTtsVoice', label: 'Voice ID' },
    {
      key: 'auxiliary.tts.outputFormat',
      formName: 'voiceTtsOutputFormat',
      label: 'TTS audio format',
    },
    { key: 'auxiliary.tts.timeout', formName: 'voiceTtsTimeoutMs', label: 'TTS timeout (ms)' },
    {
      key: 'auxiliary.tts.maxTextLength',
      formName: 'voiceTtsMaxTextLength',
      label: 'TTS max text length',
    },
    { key: 'voice.tts.providers.<name>.*', label: 'TTS provider roster', stateBacked: true },
  ]),
  ...group('voice', 'realtime', [
    {
      key: 'voice.realtime.default',
      formName: 'voiceRealtimeDefault',
      label: 'Default provider (realtime)',
    },
    {
      key: 'voice.realtime.providers.<name>.*',
      label: 'Realtime provider roster',
      stateBacked: true,
    },
    {
      key: 'voice.realtime.sessionBudgetUsd',
      formName: 'voiceRealtimeSessionBudgetUsd',
      label: 'Stop a call at (USD)',
    },
  ]),
  ...group('voice', 'barge-in', [
    {
      key: 'voice.bargeIn.call.energyThreshold',
      formName: 'voiceBargeIn.call.energyThreshold',
      label: 'Phone call — Energy threshold',
    },
    {
      key: 'voice.bargeIn.call.minSpeechMs',
      formName: 'voiceBargeIn.call.minSpeechMs',
      label: 'Phone call — Min speech (ms)',
    },
    {
      key: 'voice.bargeIn.call.silenceMs',
      formName: 'voiceBargeIn.call.silenceMs',
      label: 'Phone call — Silence (ms)',
    },
    {
      key: 'voice.bargeIn.satellite.energyThreshold',
      formName: 'voiceBargeIn.satellite.energyThreshold',
      label: 'Satellite — Energy threshold',
    },
    {
      key: 'voice.bargeIn.satellite.minSpeechMs',
      formName: 'voiceBargeIn.satellite.minSpeechMs',
      label: 'Satellite — Min speech (ms)',
    },
    {
      key: 'voice.bargeIn.satellite.silenceMs',
      formName: 'voiceBargeIn.satellite.silenceMs',
      label: 'Satellite — Silence (ms)',
      status: 'unread',
    },
    {
      key: 'voice.bargeIn.browser.energyThreshold',
      formName: 'voiceBargeIn.browser.energyThreshold',
      label: 'Browser — Energy threshold',
    },
    {
      key: 'voice.bargeIn.browser.minSpeechMs',
      formName: 'voiceBargeIn.browser.minSpeechMs',
      label: 'Browser — Min speech (ms)',
    },
    {
      key: 'voice.bargeIn.browser.silenceMs',
      formName: 'voiceBargeIn.browser.silenceMs',
      label: 'Browser — Silence (ms)',
    },
    {
      key: 'display.voice_speech_threshold',
      formName: 'voiceSpeechThreshold',
      label: 'Browser fallback — Mic sensitivity',
      dynamicGroup: 'voice-tuning',
    },
    {
      key: 'display.voice_speech_min_ms',
      formName: 'voiceSpeechMinMs',
      label: 'Browser fallback — Min speech',
      dynamicGroup: 'voice-tuning',
    },
  ]),
  ...group('voice', 'tool-call-filler', [
    {
      key: 'voice.filler.enabled',
      formName: 'voiceFiller.enabled',
      label: 'Filler & tick enabled',
    },
    {
      key: 'voice.filler.afterMs',
      formName: 'voiceFiller.afterMs',
      label: 'Filler debounce (ms)',
      advanced: true,
    },
    {
      key: 'voice.filler.text',
      formName: 'voiceFiller.text',
      label: 'Filler line',
      advanced: true,
    },
    {
      key: 'voice.filler.tickIntervalMs',
      formName: 'voiceFiller.tickIntervalMs',
      label: 'Tick interval (ms)',
      advanced: true,
    },
  ]),
  ...group('voice', 'trunk', [
    { key: 'voice.trunk.provider', formName: 'voiceTrunkProvider', label: 'Trunk provider' },
    { key: 'voice.trunk.trunkId', formName: 'voiceTrunkId', label: 'Trunk id' },
    {
      key: 'voice.trunk.fromNumber',
      formName: 'voiceTrunkFromNumber',
      label: 'Caller ID (outbound)',
    },
    {
      key: 'voice.trunk.username',
      formName: 'voiceTrunkUsername',
      label: 'SIP username',
      status: 'unread',
    },
    {
      key: 'voice.trunk.password',
      formName: 'voiceTrunkPassword',
      label: 'SIP password',
      status: 'unread',
    },
    {
      key: 'voice.trunk.webhookSecret',
      formName: 'voiceTrunkWebhookSecret',
      label: 'Webhook secret',
    },
    { key: 'voice.trunk.webhookPath', formName: 'voiceTrunkWebhookPath', label: 'Webhook path' },
    { key: 'voice.trunk.codec', formName: 'voiceTrunkCodec', label: 'Codec', status: 'unread' },
  ]),
  ...group('voice', 'livekit', [
    { key: 'voice.livekit.url', formName: 'voiceLivekitUrl', label: 'Server URL' },
    { key: 'voice.livekit.apiKey', formName: 'voiceLivekitApiKey', label: 'API key' },
    { key: 'voice.livekit.apiSecret', formName: 'voiceLivekitApiSecret', label: 'API secret' },
  ]),
  ...group('voice', 'numbers', [
    {
      key: 'voice.bots.<n>.id | .match | .bind.type | .bind.name | .bind.allowSlashSwitch',
      label: 'Voice bot roster (numbers)',
      stateBacked: true,
    },
  ]),
  ...group('voice', 'hardening', [
    {
      key: 'voice.trustedPlugins',
      formName: 'voiceTrustedPlugins',
      label: 'Trusted voice providers',
    },
    {
      key: 'voice.inbound.allowlist',
      formName: 'voiceInboundAllowlist',
      label: 'Caller allowlist',
    },
    {
      key: 'voice.inbound.receptionist',
      formName: 'voiceInboundReceptionist',
      label: 'Receptionist',
    },
    {
      key: 'voice.inbound.concurrencyCap',
      formName: 'voiceInboundConcurrencyCap',
      label: 'Concurrent calls',
    },
    {
      key: 'voice.inbound.perCallerPerHour',
      formName: 'voiceInboundPerCallerPerHour',
      label: 'Calls per caller per hour',
    },
    {
      key: 'voice.inbound.dailyBudgetUsd',
      formName: 'voiceInboundDailyBudgetUsd',
      label: 'Daily inbound budget (USD)',
    },
    {
      key: 'voice.inbound.prewarm',
      formName: 'voiceInboundPrewarm',
      label: 'Pre-warm on ring',
      status: 'unread',
    },
    {
      key: 'voice.inbound.owner.platform',
      formName: 'voiceInboundOwnerPlatform',
      label: 'Notify on',
    },
    { key: 'voice.inbound.owner.chatId', formName: 'voiceInboundOwnerChatId', label: 'Chat id' },
    { key: 'voice.inbound.owner.botKey', formName: 'voiceInboundOwnerBotKey', label: 'Bot key' },
    {
      key: null,
      formName: 'voiceEgressGate',
      label: 'Restrict voice egress',
      keyUnresolved: 'Derived from `voice.trustedPlugins !== null`; writes that key or null.',
      derived: true,
    },
  ]),
  ...group('voice', 'wake-routes', [
    {
      key: 'voice.wake.routes.<id>.phrase | .personality | .privileged | .enabled',
      label: 'Wake routes table',
      saves: 'self',
      stateBacked: true,
    },
  ]),
  ...group('voice', 'channels-that-speak', [
    { key: 'voice.defaultMode', formName: 'voiceDefaultMode', label: 'Voice replies on channels' },
    {
      key: 'voice.channels.telegram.ttsOut',
      formName: 'voiceChannelTtsOut.telegram',
      label: 'Telegram',
    },
    { key: 'voice.channels.slack.ttsOut', formName: 'voiceChannelTtsOut.slack', label: 'Slack' },
    {
      key: 'voice.channels.discord.ttsOut',
      formName: 'voiceChannelTtsOut.discord',
      label: 'Discord',
    },
    {
      key: 'voice.channels.whatsapp.ttsOut',
      formName: 'voiceChannelTtsOut.whatsapp',
      label: 'WhatsApp',
    },
    { key: 'voice.channels.email.ttsOut', formName: 'voiceChannelTtsOut.email', label: 'Email' },
  ]),
  ...group('voice', 'voice-notes', [
    {
      key: 'voice.transcode.ffmpegPath',
      formName: 'voiceTranscodeFfmpegPath',
      label: 'ffmpeg path',
    },
    {
      key: 'voice.transcode.bitrateKbps',
      formName: 'voiceTranscodeBitrateKbps',
      label: 'Bitrate (kbps)',
    },
    {
      key: 'voice.transcode.timeout',
      formName: 'voiceTranscodeTimeoutSec',
      label: 'Transcode timeout (seconds)',
    },
    {
      key: 'voice.artifacts.abandonAfterDays',
      formName: 'voiceArtifactAbandonAfterDays',
      label: 'Abandon after (days)',
    },
    {
      key: 'voice.artifacts.maxTotalMb',
      formName: 'voiceArtifactMaxTotalMb',
      label: 'Artifact directory cap (MiB)',
    },
  ]),
  ...group('voice', 'call-appearance', [
    { key: 'display.voice_chime', formName: 'voiceChime', label: 'Processing chime' },
    { key: 'display.call_style', formName: 'callStyle', label: 'Treatment' },
    { key: 'display.call_accent', formName: 'callAccent', label: 'Color' },
    { key: 'display.call_accent', formName: 'callAccentCustom', label: 'Custom color' },
    {
      key: null,
      formName: 'voiceEnabled',
      label: 'Voice enabled',
      keyUnresolved:
        "Derived from `voiceProvider`; clearing it writes voiceProvider:'' and voiceTtsProvider:''.",
      derived: true,
    },
  ]),
  ...group('automation', 'quick-commands', [
    {
      key: 'quick_commands.<name>.type | .command | .reply | .gateway | .channels',
      label: 'Quick commands editor',
      stateBacked: true,
    },
  ]),
  ...group('automation', 'channel-toolsets', [
    { key: 'channel_toolsets.<platform>', label: 'Channel toolsets editor', stateBacked: true },
  ]),
  ...group('automation', 'scheduled-passes', [
    { key: 'nightlyPass.enabled', formName: 'nightlyPass.enabled', label: 'Nightly learning pass' },
    { key: 'nightlyPass.cron', formName: 'nightlyPass.cron', label: 'Nightly pass schedule' },
    { key: 'weeklyDigest.enabled', formName: 'weeklyDigest.enabled', label: 'Weekly digest' },
    { key: 'weeklyDigest.cron', formName: 'weeklyDigest.cron', label: 'Digest schedule' },
    {
      key: 'weeklyDigest.recipients',
      formName: 'weeklyDigest.recipients',
      label: 'Digest recipients',
    },
  ]),
  ...group('jobs', 'limits', [
    {
      key: 'background.enabled',
      formName: 'background.enabled',
      label: 'Enable background sub-agents',
      advanced: true,
    },
    {
      key: 'background.max_concurrent_jobs',
      formName: 'background.maxConcurrentJobs',
      label: 'Max concurrent jobs',
      advanced: true,
    },
    {
      key: 'background.max_jobs_per_root',
      formName: 'background.maxJobsPerRoot',
      label: 'Max jobs per root session',
      advanced: true,
    },
    {
      key: 'background.max_jobs_per_personality',
      formName: 'background.maxJobsPerPersonality',
      label: 'Max jobs per personality',
      advanced: true,
    },
  ]),
  ...group('jobs', 'budgets', [
    {
      key: 'background.default_max_cost_usd',
      formName: 'background.defaultMaxCostUsd',
      label: 'Default job budget (USD)',
      advanced: true,
    },
    {
      key: 'background.max_root_background_usd',
      formName: 'background.maxRootBackgroundUsd',
      label: 'Root budget (USD)',
      advanced: true,
    },
  ]),
  ...group('jobs', 'lifecycle', [
    {
      key: 'background.queued_ttl_ms',
      formName: 'background.queuedTtlMs',
      label: 'Queued TTL (ms)',
      advanced: true,
    },
    {
      key: 'background.stale_ms',
      formName: 'background.staleMs',
      label: 'Stale after (ms)',
      advanced: true,
    },
    {
      key: 'background.heartbeat_ms',
      formName: 'background.heartbeatMs',
      label: 'Heartbeat interval (ms)',
      advanced: true,
    },
    {
      key: 'background.retention_days',
      formName: 'background.retentionDays',
      label: 'Job retention (days)',
      advanced: true,
    },
  ]),
  ...group('data', 'rules', [
    {
      key: 'retention.<subkey> | personalities.<id>.retention.<subkey>',
      label: 'Retention rules editor',
      advanced: true,
      stateBacked: true,
    },
  ]),
  ...group('security', 'approval-mode', [
    { key: 'approvalMode', formName: 'approvalMode', label: 'Approval mode' },
    { key: 'admin.enabled', formName: 'adminEnabled', label: 'Enable admin panel', advanced: true },
  ]),
  ...group('security', 'named-secrets', [
    {
      key: null,
      label: 'Named secrets table',
      saves: 'self',
      stateBacked: true,
      keyUnresolved: 'Vault-backed store (rpc.namedSecrets.*), not a ~/.ethos/config.yaml key.',
    },
  ]),
  ...group('security', 'web-search-defaults', [
    {
      key: 'toolSettings._default.web_search.provider | .secret',
      label: 'Web-search defaults',
      saves: 'self',
      stateBacked: true,
    },
  ]),
  ...group('security', 'api-keys', [
    {
      key: null,
      label: 'API keys table',
      saves: 'self',
      stateBacked: true,
      keyUnresolved: 'API-key store (rpc.apiKeys.list/create/revoke), not a config.yaml key.',
    },
    {
      key: null,
      formName: 'name',
      label: 'New API key — Name',
      saves: 'self',
      keyUnresolved:
        'Field of the create-key modal form; writes to the API-key store, not config.yaml.',
    },
    {
      key: null,
      formName: 'scopes',
      label: 'New API key — Scopes',
      saves: 'self',
      keyUnresolved:
        'Field of the create-key modal form; writes to the API-key store, not config.yaml.',
    },
    {
      key: null,
      formName: 'origins',
      label: 'New API key — Allowed Origins',
      saves: 'self',
      keyUnresolved:
        'Form.List field of the create-key modal form; writes to the API-key store, not config.yaml.',
    },
  ]),
  ...group('security', 'a2a', [
    { key: 'a2a.enabled', label: 'A2A enabled', saves: 'self', stateBacked: true },
  ]),
  ...group('developer', 'debug', [
    { key: 'debugMode', formName: 'debugMode', label: 'Enable debug mode' },
    { key: 'display.debug_panel', formName: 'debugPanelEnabled', label: 'Show debug panel' },
    { key: 'display.debug_panel_model', formName: 'debugPanelModel', label: 'Debug panel model' },
  ]),
  ...group('developer', 'logs', [
    {
      key: 'logs.rotation.enabled',
      formName: 'logsRotation.enabled',
      label: 'Log rotation',
      advanced: true,
    },
    {
      key: 'logs.rotation.maxBytes',
      formName: 'logsRotation.maxBytes',
      label: 'Max log size (bytes)',
      advanced: true,
    },
    {
      key: 'logs.rotation.maxFiles',
      formName: 'logsRotation.maxFiles',
      label: 'Rotated files kept',
      advanced: true,
    },
  ]),
  ...group('developer', 'escape-hatches', [
    {
      key: 'plugins.auto_install',
      formName: 'pluginsAutoInstall',
      label: 'Auto-install plugins',
      advanced: true,
    },
    { key: 'webBaseUrl', formName: 'webBaseUrl', label: 'Web base URL', advanced: true },
    { key: 'apiVersion', formName: 'apiVersion', label: 'Azure API version', advanced: true },
    { key: 'verbose', formName: 'verbose', label: 'Per-turn timing summary', advanced: true },
  ]),
  ...group('desktop', 'connection', [
    {
      key: null,
      label: 'Connection mode (local / remote)',
      saves: 'self',
      stateBacked: true,
      keyUnresolved:
        'Electron store key `connectionMode` via connection:set IPC; not a config.yaml key.',
    },
    {
      key: null,
      label: 'Remote URL',
      saves: 'self',
      stateBacked: true,
      keyUnresolved:
        'Electron store key `remoteUrl` via connection:set IPC; not a config.yaml key.',
    },
    {
      key: null,
      label: 'Remote token',
      saves: 'self',
      stateBacked: true,
      keyUnresolved:
        'macOS keychain entry `remote-token` via connection:set IPC; not a config.yaml key.',
    },
    {
      key: null,
      label: 'Test connection',
      saves: 'self',
      stateBacked: true,
      keyUnresolved: 'Action button (connection:test IPC); writes nothing.',
    },
    {
      key: null,
      label: 'Save connection',
      saves: 'self',
      stateBacked: true,
      keyUnresolved: 'Action button (connection:set IPC); writes the two keys above.',
    },
    {
      key: null,
      label: 'Launch at login',
      saves: 'self',
      stateBacked: true,
      keyUnresolved: 'OS login-item registration via loginItem:set IPC; not a config.yaml key.',
    },
  ]),
  ...group('desktop', 'storage', [
    {
      key: null,
      label: 'Change data directory',
      saves: 'self',
      stateBacked: true,
      keyUnresolved:
        'Electron store key `dataDir` via settings:setDataDir IPC; not a config.yaml key.',
    },
    {
      key: null,
      label: 'Open Config Folder',
      saves: 'self',
      stateBacked: true,
      keyUnresolved: 'Action button (settings:openConfigFolder IPC); writes nothing.',
    },
    {
      key: null,
      label: 'Export Data',
      saves: 'self',
      stateBacked: true,
      keyUnresolved:
        'Action button (settings:exportData IPC); writes nothing. Plan §8 0d records it as dead.',
    },
  ]),
  ...group('desktop', 'retention', [
    {
      key: null,
      label: 'Retention days',
      saves: 'self',
      stateBacked: true,
      keyUnresolved:
        'Electron store key `retentionDays` via settings:updateConfig IPC; not a config.yaml key. Collides by NAME with background.retention_days (plan §8 0f).',
    },
    {
      key: null,
      label: 'Trace log days',
      saves: 'self',
      stateBacked: true,
      keyUnresolved:
        'Electron store key `traceLogDays` via settings:updateConfig IPC; not a config.yaml key.',
    },
    {
      key: null,
      label: 'Observability days',
      saves: 'self',
      stateBacked: true,
      keyUnresolved:
        'Electron store key `observabilityDays` via settings:updateConfig IPC; not a config.yaml key.',
    },
    {
      key: null,
      label: 'Save retention',
      saves: 'self',
      stateBacked: true,
      keyUnresolved:
        'Action button (settings:updateConfig IPC). Plan §8 0b records this path as not persisting today.',
    },
    {
      key: null,
      label: 'Prune now',
      saves: 'self',
      stateBacked: true,
      keyUnresolved:
        'Action button (settings:pruneRetention IPC). Plan §8 0e records it as a stub.',
    },
  ]),
  ...group('desktop', 'keychain-and-auth', [
    {
      key: null,
      label: 'Keychain API key',
      saves: 'self',
      stateBacked: true,
      keyUnresolved: 'macOS keychain entry `api-key` via keychain:set IPC; not a config.yaml key.',
    },
    {
      key: null,
      label: 'Update keychain key',
      saves: 'self',
      stateBacked: true,
      keyUnresolved: 'Action button (keychain:set IPC).',
    },
    {
      key: null,
      label: 'Start Codex auth',
      saves: 'self',
      stateBacked: true,
      keyUnresolved:
        'Action button (codex:startAuth IPC); credentials land in the Codex auth store.',
    },
  ]),
];

/**
 * Sections that hold zero controls BY DESIGN, so a rail count of `0` there is
 * the truth rather than drift: `per-personality-routing` is a read-only routing
 * readout ("edit config.yaml directly to add entries") and `built-in-defaults`
 * is explanatory prose. T5 and T6 read this list rather than tolerating any
 * empty section, which is what keeps a genuinely-emptied section a failure.
 */
export const EXPECTED_EMPTY_SECTIONS: readonly { category: string; section: string }[] = [
  { category: 'models', section: 'per-personality-routing' },
  { category: 'data', section: 'built-in-defaults' },
];

export function isExpectedEmptySection(category: string, section: string): boolean {
  return EXPECTED_EMPTY_SECTIONS.some((s) => s.category === category && s.section === section);
}

/** How many controls each category holds. Derived — never a literal in the rail. */
export function countByCategory(
  index: readonly SettingEntry[] = SETTINGS_INDEX,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of index) counts[entry.category] = (counts[entry.category] ?? 0) + 1;
  return counts;
}

/**
 * Search: label OR config key, case-insensitively, on the whole table.
 *
 * Advanced entries match whatever the toggle says (D10) — the toggle decides how
 * a control is DRAWN, and a control you cannot find because of how it is drawn
 * is a control you cannot fix. An operator who read `voice.trunk.webhookSecret`
 * out of `config.yaml` is the reason `key` is searched at all.
 */
export function filterSettings(
  query: string,
  index: readonly SettingEntry[] = SETTINGS_INDEX,
): SettingEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return index.filter(
    (e) =>
      e.label.toLowerCase().includes(needle) || (e.key?.toLowerCase().includes(needle) ?? false),
  );
}

/** Which category owns a form field — the lookup `computeDirty` colours by. */
export function categoryForFormName(
  formName: string,
  index: readonly SettingEntry[] = SETTINGS_INDEX,
): string | null {
  return index.find((e) => e.formName === formName)?.category ?? null;
}

/**
 * The `config.yaml` key a form field writes — what `SettingRow` renders as its
 * Geist Mono key line. A pane resolves this instead of hand-typing the key
 * string, so the row and the search index cannot drift apart (D8).
 */
export function keyForFormName(
  formName: string,
  index: readonly SettingEntry[] = SETTINGS_INDEX,
): string | null {
  return index.find((e) => e.formName === formName)?.key ?? null;
}

/**
 * Whether a form field's key is derived rather than written directly.
 * `SettingRow` renders the literal word `derived` in the key line's position
 * for these instead of resolving `keyForFormName` (§7, Phase 7).
 */
export function isDerivedFormName(
  formName: string,
  index: readonly SettingEntry[] = SETTINGS_INDEX,
): boolean {
  return index.find((e) => e.formName === formName)?.derived === true;
}

/**
 * The `SETTINGS_INDEX.status` for a form field — what `SettingRow` resolves to
 * decide whether to render a `StatusCallout` (§7, Phase 7).
 */
export function statusForFormName(
  formName: string,
  index: readonly SettingEntry[] = SETTINGS_INDEX,
): SettingStatus {
  return index.find((e) => e.formName === formName)?.status ?? null;
}
