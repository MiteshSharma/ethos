import { BUILTIN_SKIN_NAMES, BUILTIN_SKINS } from '@ethosagent/design-tokens';
import { ContentRenderer } from '@ethosagent/ui-components';
import type { ApiKeyMetadata, ApiKeyScope, ProviderEntry } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Button,
  Card,
  Checkbox,
  Collapse,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Slider,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { CSSProperties, Dispatch, ReactNode, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { blobToBase64 } from '../components/chat/VoiceButton';
import { AddSecretModal } from '../components/tool-settings/SecretPicker';
import { ToolSettingsForm } from '../components/tool-settings/ToolSettingsForm';
import {
  useNamedSecretDelete,
  useToolSettingsSetDefault,
} from '../features/settings/api/mutations';
import {
  useNamedSecretsList,
  useToolSettingsDefault,
  useToolSettingsSchemas,
} from '../features/settings/api/queries';
import { DEFAULT_VOICE_TUNING } from '../features/voice/batch-voice-call-client';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder';
import { isDesktop } from '../lib/desktop';
import { rpc } from '../rpc';
import { DesktopSettings } from './DesktopSettings';

const WEB_SEARCH_PROVIDERS = ['exa', 'tavily', 'brave'] as const;
type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];
function isWebSearchProvider(v: string | undefined): v is WebSearchProvider {
  return v === 'exa' || v === 'tavily' || v === 'brave';
}

// Settings tab — read/write surface for ~/.ethos/config.yaml.
//
// Two visibility modes:
//   • Default   — provider, personality, memory mode.
//   • Advanced  — adds base URL, modelRouting record.
//
// The raw API key never crosses the wire on read; the server returns
// `apiKeyPreview` (e.g. `sk-…abc1`) so users can confirm "which key" is
// active. On update, the plaintext key is sent only when the user types
// a fresh value into the field.

// ---------------------------------------------------------------------------
// Provider chain row — local state for the editor
// ---------------------------------------------------------------------------

let nextRowId = 1;

interface ProviderRow {
  /** Stable key for React list rendering. */
  _id: number;
  provider: string;
  model: string;
  apiKey: string;
  apiKeyPreview: string;
  baseUrl: string;
  testStatus: 'idle' | 'testing' | 'success' | 'error';
  testError?: string;
}

function emptyRow(): ProviderRow {
  return {
    _id: nextRowId++,
    provider: '',
    model: '',
    apiKey: '',
    apiKeyPreview: '',
    baseUrl: '',
    testStatus: 'idle',
  };
}

function rowsFromConfig(
  providers: ProviderEntry[],
  legacyProvider?: string,
  legacyModel?: string,
  legacyApiKeyPreview?: string,
  legacyBaseUrl?: string | null,
): ProviderRow[] {
  if (providers.length > 0) {
    return providers.map((p) => ({
      _id: nextRowId++,
      provider: p.provider,
      model: p.model ?? '',
      apiKey: '',
      apiKeyPreview: p.apiKeyPreview,
      baseUrl: p.baseUrl ?? '',
      testStatus: 'idle' as const,
    }));
  }
  // Backward compat: populate from single-field config
  if (legacyProvider) {
    return [
      {
        _id: nextRowId++,
        provider: legacyProvider,
        model: legacyModel ?? '',
        apiKey: '',
        apiKeyPreview: legacyApiKeyPreview ?? '',
        baseUrl: legacyBaseUrl ?? '',
        testStatus: 'idle' as const,
      },
    ];
  }
  return [emptyRow()];
}

// ---------------------------------------------------------------------------
// Record editors (quick commands, channel toolsets, retention) — local row
// state hydrated from config.get like the provider chain, sent back as
// FULL-REPLACEMENT records on Save: entries removed here are deleted from
// config.yaml. (Webhooks are edited per personality on the Personality page's
// Triggers section, not here.)
// ---------------------------------------------------------------------------

type ConfigUpdatePatch = Parameters<typeof rpc.config.update>[0];
type ConfigGetData = Awaited<ReturnType<typeof rpc.config.get>>;
type QuickCommandPatch = NonNullable<ConfigUpdatePatch['quickCommands']>[string];
type RetentionSubkey = keyof ConfigGetData['retention'];

/** Mirrors ConfigRecordKeySchema in @ethosagent/web-contracts. */
const RECORD_KEY_RE = /^[A-Za-z0-9_-]+$/;
/** Mirrors RetentionDurationSchema — 'forever' or <n> followed by d|w|m|y. */
const RETENTION_DURATION_RE = /^(forever|\d+[dwmy])$/;

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

interface QuickCommandRow {
  _id: number;
  name: string;
  type: 'exec' | 'reply';
  command: string;
  reply: string;
  gateway: boolean;
  channels: string[];
}

interface ChannelToolsetRow {
  _id: number;
  platform: string;
  toolsets: string[];
}

interface RetentionRow {
  _id: number;
  /** '' = global `retention.<subkey>`; otherwise `personalities.<id>.retention.<subkey>`. */
  personalityId: string;
  subkey: RetentionSubkey;
  duration: string;
}

function quickCommandRowsFromConfig(commands: ConfigGetData['quickCommands']): QuickCommandRow[] {
  return Object.entries(commands)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, qc]) => ({
      _id: nextRowId++,
      name,
      type: qc.type,
      command: qc.type === 'exec' ? qc.command : '',
      reply: qc.type === 'reply' ? qc.reply : '',
      gateway: qc.gateway,
      channels: qc.channels,
    }));
}

function channelToolsetRowsFromConfig(map: ConfigGetData['channelToolsets']): ChannelToolsetRow[] {
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([platform, toolsets]) => ({ _id: nextRowId++, platform, toolsets }));
}

function retentionRowsFromConfig(
  retention: ConfigGetData['retention'],
  personalityRetention: ConfigGetData['personalityRetention'],
): RetentionRow[] {
  const rows: RetentionRow[] = [];
  for (const subkey of RETENTION_SUBKEYS) {
    const duration = retention[subkey];
    if (duration !== undefined)
      rows.push({ _id: nextRowId++, personalityId: '', subkey, duration });
  }
  for (const [pid, map] of Object.entries(personalityRetention).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    for (const subkey of RETENTION_SUBKEYS) {
      const duration = map[subkey];
      if (duration !== undefined) {
        rows.push({ _id: nextRowId++, personalityId: pid, subkey, duration });
      }
    }
  }
  return rows;
}

/** '' / whitespace → null (clear-to-default for nullable config scalars). */
function strOrNull(s: string): string | null {
  const t = s.trim();
  return t ? t : null;
}

interface AuxModelFormShape {
  model: string;
  provider: string;
  /** New key typed by the user; empty keeps the stored one. */
  apiKey: string;
  baseUrl: string;
}

function auxFormFromConfig(aux: ConfigGetData['auxCompression']): AuxModelFormShape {
  return {
    model: aux.model ?? '',
    provider: aux.provider ?? '',
    apiKey: '',
    baseUrl: aux.baseUrl ?? '',
  };
}

function auxPatchFromForm(a: AuxModelFormShape): NonNullable<ConfigUpdatePatch['auxCompression']> {
  return {
    model: strOrNull(a.model),
    provider: strOrNull(a.provider),
    baseUrl: strOrNull(a.baseUrl),
    ...(a.apiKey ? { apiKey: a.apiKey } : {}),
  };
}

/** Same bordered-box style the provider-chain rows use. */
const ROW_BOX_STYLE: CSSProperties = {
  border: '1px solid var(--ethos-border, #d9d9d9)',
  borderRadius: 6,
  padding: 12,
  marginBottom: 12,
};

function RowLabel({ children }: { children: ReactNode }) {
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {children}
    </Typography.Text>
  );
}

interface PersonalityOption {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Inline test button for a single provider row
// ---------------------------------------------------------------------------

function RowTestButton({
  row,
  onStatusChange,
}: {
  row: ProviderRow;
  onStatusChange: (status: ProviderRow['testStatus'], error?: string) => void;
}) {
  const handleTest = async () => {
    if (!row.provider || !row.apiKey) return;
    onStatusChange('testing');
    try {
      const result = await rpc.onboarding.validateProvider({
        provider: row.provider as
          | 'anthropic'
          | 'openai'
          | 'openrouter'
          | 'openai-compat'
          | 'ollama'
          | 'azure',
        apiKey: row.apiKey,
        ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
      });
      if (result.ok) {
        onStatusChange('success');
      } else {
        onStatusChange('error', result.error ?? 'Validation failed');
      }
    } catch (err) {
      onStatusChange('error', (err as Error).message);
    }
  };

  const hasKey = row.apiKey.length > 0;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Tooltip
        title={hasKey ? 'Test connection with the new API key' : 'Enter a new API key to test'}
      >
        <Button
          size="small"
          onClick={handleTest}
          loading={row.testStatus === 'testing'}
          disabled={!hasKey}
        >
          Test
        </Button>
      </Tooltip>
      {row.testStatus === 'success' && <Tag color="success">Connected</Tag>}
      {row.testStatus === 'error' && <Tag color="error">{row.testError ?? 'Failed'}</Tag>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form shape (no longer includes provider/model/apiKey/baseUrl — those live
// in the provider chain state)
// ---------------------------------------------------------------------------

interface FormShape {
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
    smallWindow: 'auto' | 'on' | 'off';
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
  nightlyPass: { enabled: boolean; cron: string };
  weeklyDigest: { enabled: boolean; cron: string; recipients: string[] };
  modelCatalog: { enabled: boolean; url: string; ttlHours: number | null };
  logsRotation: { enabled: boolean; maxBytes: number | null; maxFiles: number | null };
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

// Sensible defaults prefilled when a local (OpenAI-compatible) voice provider
// is selected. Kokoro TTS listens on :8880, Whisper STT on :8000 by convention.
// Only prefilled into empty fields — never clobbers a user's edits.
const STT_PROVIDER_DEFAULTS: Record<string, { baseUrl: string; model: string }> = {
  'local-stt': { baseUrl: 'http://localhost:8000/v1', model: 'whisper-large-v3' },
};
const TTS_PROVIDER_DEFAULTS: Record<string, { baseUrl: string; model: string }> = {
  'local-tts': { baseUrl: 'http://localhost:8880/v1', model: 'kokoro' },
};

// Fixed phrase the "Test TTS" button synthesizes so the check is deterministic.
const VOICE_TEST_PHRASE = 'Hello — this is an Ethos voice test.';

// Advanced VAD / barge-in tuning sliders. `name` is the FormShape/config field,
// `defaultKey` maps to DEFAULT_VOICE_TUNING for the reset affordance, and the
// range/step mirror the Zod bounds on ConfigUpdateInput. `unit` renders the
// slider tooltip so the raw number reads clearly.
const VOICE_TUNING_CONTROLS: Array<{
  name:
    | 'voiceEndpointSilenceMs'
    | 'voiceBargeThreshold'
    | 'voiceBargeSustainMs'
    | 'voiceSpeechThreshold'
    | 'voiceSpeechMinMs';
  defaultKey: keyof typeof DEFAULT_VOICE_TUNING;
  label: string;
  extra: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}> = [
  {
    name: 'voiceEndpointSilenceMs',
    defaultKey: 'endpointSilenceMs',
    label: 'Response delay',
    extra: 'How long you pause before the agent replies.',
    min: 300,
    max: 1500,
    step: 50,
    unit: 'ms',
  },
  {
    name: 'voiceBargeThreshold',
    defaultKey: 'bargeThreshold',
    label: 'Interrupt sensitivity',
    extra: 'Lower = easier to interrupt the agent while it speaks.',
    min: 0.02,
    max: 0.2,
    step: 0.005,
    unit: '',
  },
  {
    name: 'voiceBargeSustainMs',
    defaultKey: 'bargeSustainMs',
    label: 'Interrupt hold',
    extra: 'How long you must keep talking to cut in.',
    min: 100,
    max: 800,
    step: 40,
    unit: 'ms',
  },
  {
    name: 'voiceSpeechThreshold',
    defaultKey: 'speechThreshold',
    label: 'Mic sensitivity',
    extra: 'Lower = picks up quieter speech.',
    min: 0.005,
    max: 0.1,
    step: 0.005,
    unit: '',
  },
  {
    name: 'voiceSpeechMinMs',
    defaultKey: 'speechMinMs',
    label: 'Min speech',
    extra: 'Ignore blips shorter than this.',
    min: 100,
    max: 500,
    step: 20,
    unit: 'ms',
  },
];

// Fields whose edits mean the saved config a test would exercise is stale.
const STT_TEST_DIRTY_FIELDS: (keyof FormShape)[] = [
  'voiceProvider',
  'voiceModel',
  'voiceBaseUrl',
  'voiceApiKey',
];
const TTS_TEST_DIRTY_FIELDS: (keyof FormShape)[] = [
  'voiceTtsProvider',
  'voiceTtsModel',
  'voiceTtsBaseUrl',
  'voiceTtsVoice',
  'voiceTtsApiKey',
];

// Synthesizes a fixed phrase via the saved TTS provider and plays it back.
function TtsTest({ disabled, dirty }: { disabled: boolean; dirty: boolean }) {
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle');
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const handleClick = useCallback(async () => {
    if (state === 'playing') {
      audioRef.current?.pause();
      setState('idle');
      return;
    }
    setError(null);
    setState('loading');
    try {
      const result = await rpc.voice.synthesize({ text: VOICE_TEST_PHRASE });
      const bytes = Uint8Array.from(atob(result.audio), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: result.mimeType });
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => setState('idle');
      audio.onerror = () => setState('idle');
      setState('playing');
      await audio.play().catch(() => setState('idle'));
    } catch (err) {
      setState('idle');
      setError(err instanceof Error ? err.message : 'Text-to-speech failed');
    }
  }, [state]);

  return (
    <Space direction="vertical" size="small" style={{ marginTop: 8 }}>
      <Button size="small" onClick={handleClick} loading={state === 'loading'} disabled={disabled}>
        {state === 'playing' ? 'Stop' : 'Test TTS'}
      </Button>
      {dirty ? (
        <Typography.Text type="secondary">Save to test the latest settings.</Typography.Text>
      ) : error ? (
        <Typography.Text type="danger">{error}</Typography.Text>
      ) : null}
    </Space>
  );
}

// Records a short mic clip and transcribes it via the saved STT provider.
function SttTest({ disabled, dirty }: { disabled: boolean; dirty: boolean }) {
  const { isRecording, error: recorderError, startRecording, stopRecording } = useVoiceRecorder();
  const [state, setState] = useState<'idle' | 'transcribing'>('idle');
  const [transcript, setTranscript] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const capRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCap = useCallback(() => {
    if (capRef.current) {
      clearTimeout(capRef.current);
      capRef.current = null;
    }
  }, []);

  useEffect(() => clearCap, [clearCap]);

  const finish = useCallback(async () => {
    clearCap();
    const blob = await stopRecording();
    if (!blob) return;
    setState('transcribing');
    setError(null);
    try {
      const audio = await blobToBase64(blob);
      const result = await rpc.voice.transcribe({ audio, mimeType: blob.type });
      setTranscript(result.transcript);
    } catch (err) {
      setTranscript(null);
      setError(err instanceof Error ? err.message : 'Transcription failed');
    } finally {
      setState('idle');
    }
  }, [clearCap, stopRecording]);

  const handleClick = useCallback(() => {
    if (state === 'transcribing') return;
    if (isRecording) {
      void finish();
      return;
    }
    setTranscript(null);
    setError(null);
    void startRecording();
    capRef.current = setTimeout(() => void finish(), 4000);
  }, [state, isRecording, finish, startRecording]);

  const label = isRecording
    ? 'Stop & transcribe'
    : state === 'transcribing'
      ? 'Transcribing…'
      : 'Test STT';
  const shownError = error ?? recorderError;

  return (
    <Space direction="vertical" size="small" style={{ marginTop: 8 }}>
      <Button
        size="small"
        onClick={handleClick}
        loading={state === 'transcribing'}
        disabled={disabled}
        danger={isRecording}
      >
        {label}
      </Button>
      {dirty ? (
        <Typography.Text type="secondary">Save to test the latest settings.</Typography.Text>
      ) : shownError ? (
        <Typography.Text type="danger">{shownError}</Typography.Text>
      ) : transcript ? (
        <Typography.Text type="secondary">Heard: “{transcript}”</Typography.Text>
      ) : isRecording ? (
        <Typography.Text type="secondary">Recording… tap to stop (4s max).</Typography.Text>
      ) : null}
    </Space>
  );
}

export function Settings() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const navigate = useNavigate();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [form] = Form.useForm<FormShape>();
  const [providerRows, setProviderRows] = useState<ProviderRow[]>([emptyRow()]);
  const [quickCommandRows, setQuickCommandRows] = useState<QuickCommandRow[]>([]);
  const [channelToolsetRows, setChannelToolsetRows] = useState<ChannelToolsetRow[]>([]);
  const [retentionRows, setRetentionRows] = useState<RetentionRow[]>([]);
  const hydratedRef = useRef(false);

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => rpc.config.get(),
  });

  const personalitiesQuery = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
  });

  // Hydrate form + provider rows whenever config data arrives or refreshes.
  useEffect(() => {
    if (configQuery.data) {
      form.setFieldsValue({
        personality: configQuery.data.personality,
        memory: configQuery.data.memory,
        skin: configQuery.data.skin,
        approvalMode: configQuery.data.approvalMode,
        verbosity: configQuery.data.verbosity,
        debugMode: configQuery.data.debugMode,
        contextLayering: configQuery.data.contextLayering,
        debugPanelEnabled: configQuery.data.debugPanelEnabled,
        debugPanelModel: configQuery.data.debugPanelModel ?? '',
        adminEnabled: configQuery.data.adminEnabled,
        streamingEdits: configQuery.data.streamingEdits,
        autoCompact: configQuery.data.autoCompact,
        memoryConsolidationEnabled: configQuery.data.memoryConsolidationEnabled,
        memoryCaptureEnabled: configQuery.data.memoryCaptureEnabled,
        memoryCaptureModel: configQuery.data.memoryCaptureModel ?? '',
        memoryNotices: configQuery.data.memoryNotices,
        voiceEnabled: Boolean(configQuery.data.voiceProvider),
        voiceChime: configQuery.data.voiceChime,
        voiceEndpointSilenceMs: configQuery.data.voiceEndpointSilenceMs,
        voiceBargeThreshold: configQuery.data.voiceBargeThreshold,
        voiceBargeSustainMs: configQuery.data.voiceBargeSustainMs,
        voiceSpeechThreshold: configQuery.data.voiceSpeechThreshold,
        voiceSpeechMinMs: configQuery.data.voiceSpeechMinMs,
        voiceProvider: configQuery.data.voiceProvider ?? '',
        voiceApiKey: '',
        voiceBaseUrl: configQuery.data.voiceBaseUrl ?? '',
        voiceModel: configQuery.data.voiceModel ?? '',
        voiceTtsProvider: configQuery.data.voiceTtsProvider ?? '',
        voiceTtsApiKey: '',
        voiceTtsVoice: configQuery.data.voiceTtsVoice ?? '',
        voiceTtsBaseUrl: configQuery.data.voiceTtsBaseUrl ?? '',
        voiceTtsModel: configQuery.data.voiceTtsModel ?? '',
        displayVerbosity: configQuery.data.displayVerbosity,
        displayBusyInputMode: configQuery.data.displayBusyInputMode,
        displayToolPreviewLength: configQuery.data.displayToolPreviewLength,
        displayResumeHint: configQuery.data.displayResumeHint,
        displayResumeRecapTurns: configQuery.data.displayResumeRecapTurns,
        displayBellOnComplete: configQuery.data.displayBellOnComplete,
        compaction: { ...configQuery.data.compaction },
        memoryVault: {
          path: configQuery.data.memoryVault.path ?? '',
          agentDir: configQuery.data.memoryVault.agentDir ?? '',
          prefetch: configQuery.data.memoryVault.prefetch,
          exclude: configQuery.data.memoryVault.exclude,
        },
        memoryApproval: { ...configQuery.data.memoryApproval },
        memoryConsolidation: { ...configQuery.data.memoryConsolidation },
        memoryCapture: {
          provider: configQuery.data.memoryCapture.provider ?? '',
          apiKey: '',
          baseUrl: configQuery.data.memoryCapture.baseUrl ?? '',
          maxPerHour: configQuery.data.memoryCapture.maxPerHour,
          maxPerDay: configQuery.data.memoryCapture.maxPerDay,
        },
        background: { ...configQuery.data.background },
        nightlyPass: { ...configQuery.data.nightlyPass },
        weeklyDigest: { ...configQuery.data.weeklyDigest },
        modelCatalog: {
          enabled: configQuery.data.modelCatalog.enabled,
          url: configQuery.data.modelCatalog.url ?? '',
          ttlHours: configQuery.data.modelCatalog.ttlHours,
        },
        logsRotation: { ...configQuery.data.logsRotation },
        webSearchBackend: configQuery.data.webSearchBackend ?? '',
        webExtractBackend: configQuery.data.webExtractBackend ?? '',
        auxCompression: auxFormFromConfig(configQuery.data.auxCompression),
        auxVision: auxFormFromConfig(configQuery.data.auxVision),
        auxWeb: auxFormFromConfig(configQuery.data.auxWeb),
        apiVersion: configQuery.data.apiVersion ?? '',
        verbose: configQuery.data.verbose,
        pluginsAutoInstall:
          configQuery.data.pluginsAutoInstall === null
            ? 'default'
            : configQuery.data.pluginsAutoInstall
              ? 'on'
              : 'off',
        webBaseUrl: configQuery.data.webBaseUrl ?? '',
      });
      // Only hydrate provider rows on first load or when data changes identity
      if (!hydratedRef.current) {
        setProviderRows(
          rowsFromConfig(
            configQuery.data.providers,
            configQuery.data.provider,
            configQuery.data.model,
            configQuery.data.apiKeyPreview,
            configQuery.data.baseUrl,
          ),
        );
        setQuickCommandRows(quickCommandRowsFromConfig(configQuery.data.quickCommands));
        setChannelToolsetRows(channelToolsetRowsFromConfig(configQuery.data.channelToolsets));
        setRetentionRows(
          retentionRowsFromConfig(
            configQuery.data.retention,
            configQuery.data.personalityRetention,
          ),
        );
        hydratedRef.current = true;
      }
    }
  }, [configQuery.data, form]);

  const updateRow = useCallback((index: number, patch: Partial<ProviderRow>) => {
    setProviderRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }, []);

  const moveRow = useCallback((index: number, direction: -1 | 1) => {
    setProviderRows((prev) => {
      const next = [...prev];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;
      const a = next[index];
      const b = next[target];
      if (!a || !b) return prev;
      next[index] = b;
      next[target] = a;
      return next;
    });
  }, []);

  const removeRow = useCallback((index: number) => {
    setProviderRows((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const addRow = useCallback(() => {
    setProviderRows((prev) => [...prev, emptyRow()]);
  }, []);

  const updateMut = useMutation({
    mutationFn: (patch: Parameters<typeof rpc.config.update>[0]) => rpc.config.update(patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['config'] });
      qc.invalidateQueries({ queryKey: ['meta', 'capabilities'] });
      hydratedRef.current = false;
      notification.success({ message: 'Settings saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  if (configQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }
  if (configQuery.error) {
    return (
      <Typography.Text type="danger">
        Failed to load config: {(configQuery.error as Error).message}
      </Typography.Text>
    );
  }

  const personalities = personalitiesQuery.data?.items ?? [];

  const onFinish = () => {
    // Advanced-gated fields unmount while "Show advanced" is off; the store
    // still holds their hydrated values, so read the whole store rather than
    // the registered-fields subset onFinish would hand us.
    const values: FormShape = form.getFieldsValue(true);
    const primary = providerRows[0];
    if (!primary?.provider || !primary.model) {
      notification.error({ message: 'Primary provider and model are required.' });
      return;
    }

    // -- Record-editor validation (mirrors the contract's Zod bounds) --------
    const fail = (message: string) => notification.error({ message });

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
      if (channelToolsets[platform])
        return fail(`Duplicate channel-toolset platform "${platform}".`);
      if (row.toolsets.length === 0) {
        return fail(
          `Channel toolsets: "${platform}" needs at least one toolset (or remove the row).`,
        );
      }
      channelToolsets[platform] = row.toolsets;
    }

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
        if (retention[row.subkey])
          return fail(`Duplicate global retention rule for ${row.subkey}.`);
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

    const patch: Parameters<typeof rpc.config.update>[0] = {
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
      voiceEndpointSilenceMs: values.voiceEndpointSilenceMs,
      voiceBargeThreshold: values.voiceBargeThreshold,
      voiceBargeSustainMs: values.voiceBargeSustainMs,
      voiceSpeechThreshold: values.voiceSpeechThreshold,
      voiceSpeechMinMs: values.voiceSpeechMinMs,
      ...(!values.voiceEnabled
        ? configQuery.data?.voiceProvider || configQuery.data?.voiceTtsProvider
          ? { voiceProvider: '', voiceTtsProvider: '' }
          : {}
        : {
            ...((values.voiceProvider ?? '') !== (configQuery.data?.voiceProvider ?? '')
              ? { voiceProvider: values.voiceProvider }
              : {}),
            ...(values.voiceApiKey ? { voiceApiKey: values.voiceApiKey } : {}),
            ...((values.voiceBaseUrl ?? '') !== (configQuery.data?.voiceBaseUrl ?? '')
              ? { voiceBaseUrl: values.voiceBaseUrl }
              : {}),
            ...((values.voiceModel ?? '') !== (configQuery.data?.voiceModel ?? '')
              ? { voiceModel: values.voiceModel }
              : {}),
            ...((values.voiceTtsProvider ?? '') !== (configQuery.data?.voiceTtsProvider ?? '')
              ? { voiceTtsProvider: values.voiceTtsProvider }
              : {}),
            ...(values.voiceTtsApiKey ? { voiceTtsApiKey: values.voiceTtsApiKey } : {}),
            ...((values.voiceTtsVoice ?? '') !== (configQuery.data?.voiceTtsVoice ?? '')
              ? { voiceTtsVoice: values.voiceTtsVoice }
              : {}),
            ...((values.voiceTtsBaseUrl ?? '') !== (configQuery.data?.voiceTtsBaseUrl ?? '')
              ? { voiceTtsBaseUrl: values.voiceTtsBaseUrl }
              : {}),
            ...((values.voiceTtsModel ?? '') !== (configQuery.data?.voiceTtsModel ?? '')
              ? { voiceTtsModel: values.voiceTtsModel }
              : {}),
          }),
      modelRouting: Object.fromEntries(
        Object.entries(configQuery.data?.modelRouting ?? {}).filter(
          ([k]) => k !== '__fallbackChain',
        ),
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
    };
    if (primary.apiKey) patch.apiKey = primary.apiKey;
    if (primary.baseUrl !== undefined) patch.baseUrl = primary.baseUrl;

    updateMut.mutate(patch);
  };

  return (
    <div className="settings-tab">
      <header className="settings-toolbar">
        <Typography.Title level={4} style={{ margin: 0 }}>
          Settings
        </Typography.Title>
        <span className="settings-advanced-toggle">
          <span className="settings-advanced-label">Show advanced</span>
          <Switch checked={showAdvanced} onChange={setShowAdvanced} />
        </span>
      </header>

      <Form<FormShape> form={form} layout="vertical" onFinish={onFinish} style={{ maxWidth: 640 }}>
        <Card title="Provider chain" size="small" style={{ marginBottom: 16 }}>
          {providerRows.map((row, idx) => {
            const label = idx === 0 ? 'Primary' : `Fallback ${idx}`;
            return (
              <div
                key={row._id}
                style={{
                  border: '1px solid var(--ethos-border, #d9d9d9)',
                  borderRadius: 6,
                  padding: 12,
                  marginBottom: 12,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 8,
                  }}
                >
                  <Typography.Text strong style={{ fontSize: 13 }}>
                    {label}
                  </Typography.Text>
                  <Space size={4}>
                    {idx > 0 && (
                      <Tooltip title="Move up">
                        <Button size="small" onClick={() => moveRow(idx, -1)}>
                          Up
                        </Button>
                      </Tooltip>
                    )}
                    {idx < providerRows.length - 1 && (
                      <Tooltip title="Move down">
                        <Button size="small" onClick={() => moveRow(idx, 1)}>
                          Down
                        </Button>
                      </Tooltip>
                    )}
                    {idx > 0 && (
                      <Tooltip title="Remove this fallback">
                        <Button size="small" danger onClick={() => removeRow(idx)}>
                          Remove
                        </Button>
                      </Tooltip>
                    )}
                  </Space>
                </div>

                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <div style={{ flex: 1 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      Provider
                    </Typography.Text>
                    <Input
                      size="small"
                      placeholder="anthropic | openrouter | openai-compat | ollama"
                      value={row.provider}
                      onChange={(e) => updateRow(idx, { provider: e.target.value })}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      Model
                    </Typography.Text>
                    <Input
                      size="small"
                      placeholder="e.g. claude-opus-4-7"
                      value={row.model}
                      onChange={(e) => updateRow(idx, { model: e.target.value })}
                    />
                  </div>
                </div>

                <div style={{ marginBottom: 8 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    API key
                  </Typography.Text>
                  <Input.Password
                    size="small"
                    autoComplete="off"
                    placeholder={row.apiKeyPreview || 'paste new key'}
                    value={row.apiKey}
                    onChange={(e) => updateRow(idx, { apiKey: e.target.value, testStatus: 'idle' })}
                  />
                  {row.apiKeyPreview && !row.apiKey && (
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      Active: {row.apiKeyPreview}
                    </Typography.Text>
                  )}
                </div>

                {showAdvanced && (
                  <div style={{ marginBottom: 8 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      Base URL
                    </Typography.Text>
                    <Input
                      size="small"
                      placeholder="https://openrouter.ai/api/v1"
                      value={row.baseUrl}
                      onChange={(e) => updateRow(idx, { baseUrl: e.target.value })}
                    />
                  </div>
                )}

                <RowTestButton
                  row={row}
                  onStatusChange={(status, error) =>
                    updateRow(idx, { testStatus: status, testError: error })
                  }
                />
              </div>
            );
          })}
          <Button type="dashed" size="small" onClick={addRow} style={{ width: '100%' }}>
            Add fallback
          </Button>
        </Card>

        <Card title="Default personality" size="small" style={{ marginBottom: 16 }}>
          <Form.Item
            label="Personality"
            name="personality"
            rules={[{ required: true, message: 'Required' }]}
            extra="Used when chat doesn't override per-session."
          >
            <Select
              loading={personalitiesQuery.isLoading}
              options={personalities.map((p) => ({
                label: `${p.name}${p.builtin ? ' (built-in)' : ''}`,
                value: p.id,
              }))}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
        </Card>

        <Card title="Appearance" size="small" style={{ marginBottom: 16 }}>
          <Form.Item
            label="Skin"
            name="skin"
            extra="DESIGN.md baseline plus named overrides. Applies across all surfaces (Web, TUI)."
          >
            <Select
              options={BUILTIN_SKIN_NAMES.map((name) => ({
                value: name,
                label: `${name} — ${BUILTIN_SKINS[name].description}`,
              }))}
            />
          </Form.Item>
        </Card>

        <Card title="Memory" size="small" style={{ marginBottom: 16 }}>
          <Form.Item
            label="Memory mode"
            name="memory"
            extra="Markdown is human-editable in ~/.ethos/MEMORY.md. Vector uses local embeddings. Vault targets an external directory (memoryVault.path)."
          >
            <Radio.Group>
              <Radio.Button value="markdown">Markdown</Radio.Button>
              <Radio.Button value="vector">Vector</Radio.Button>
              <Radio.Button value="vault">Vault</Radio.Button>
            </Radio.Group>
          </Form.Item>

          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.memory !== cur.memory}>
            {({ getFieldValue }) =>
              getFieldValue('memory') === 'vault' ? (
                <>
                  <Form.Item
                    label="Vault path"
                    name={['memoryVault', 'path']}
                    rules={[{ required: true, message: 'Vault path is required for vault memory' }]}
                    extra="Absolute path of the vault directory the agent reads and writes (memoryVault.path)."
                  >
                    <Input placeholder="/Users/you/Documents/MyVault" />
                  </Form.Item>
                  <Form.Item
                    label="Agent directory"
                    name={['memoryVault', 'agentDir']}
                    extra="Subtree inside the vault the agent owns (memoryVault.agentDir). Blank = Ethos."
                  >
                    <Input placeholder="Ethos" />
                  </Form.Item>
                  <Form.Item
                    label="Prefetch notes"
                    name={['memoryVault', 'prefetch']}
                    extra="Note names loaded into every prompt (memoryVault.prefetch). Press Enter after each name."
                  >
                    <Select
                      mode="tags"
                      open={false}
                      suffixIcon={null}
                      tokenSeparators={[',']}
                      placeholder="MEMORY, USER"
                    />
                  </Form.Item>
                  <Form.Item
                    label="Excluded notes"
                    name={['memoryVault', 'exclude']}
                    extra="Note names hidden from list and search (memoryVault.exclude)."
                  >
                    <Select
                      mode="tags"
                      open={false}
                      suffixIcon={null}
                      tokenSeparators={[',']}
                      placeholder="Private, Journal"
                    />
                  </Form.Item>
                </>
              ) : null
            }
          </Form.Item>

          <Form.Item
            label="Memory approval"
            name={['memoryApproval', 'mode']}
            extra="Approve-before-store gate for new memories (memoryApproval.mode)."
          >
            <Radio.Group>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Radio value="off">
                  <span style={{ fontWeight: 500 }}>Off</span>
                  <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--ethos-text-dim)' }}>
                    Memories are stored immediately.
                  </span>
                </Radio>
                <Radio value="automated">
                  <span style={{ fontWeight: 500 }}>Automated</span>
                  <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--ethos-text-dim)' }}>
                    Agent-initiated writes wait for your review; explicit asks store directly.
                  </span>
                </Radio>
                <Radio value="all">
                  <span style={{ fontWeight: 500 }}>All</span>
                  <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--ethos-text-dim)' }}>
                    Every memory write waits for your review.
                  </span>
                </Radio>
              </div>
            </Radio.Group>
          </Form.Item>

          {showAdvanced && (
            <>
              <Form.Item
                label="Pending queue cap"
                name={['memoryApproval', 'cap']}
                extra="Max pending candidates per scope (memoryApproval.cap, default 200)."
              >
                <InputNumber min={1} precision={0} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                label="Pending TTL (days)"
                name={['memoryApproval', 'ttlDays']}
                extra="Days before an unreviewed candidate expires (memoryApproval.ttlDays, default 30)."
              >
                <InputNumber min={1} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </>
          )}

          <Form.Item
            label="Consolidate memory between turns"
            name="memoryConsolidationEnabled"
            valuePropName="checked"
            extra="Silently distill durable facts into memory before long sessions compact (default off)."
          >
            <Switch />
          </Form.Item>

          {showAdvanced && (
            <>
              <Form.Item
                label="Flush threshold"
                name={['memoryConsolidation', 'flushThreshold']}
                extra="Context-window fraction that triggers the silent flush (memoryConsolidation.flushThreshold, default 0.7)."
              >
                <InputNumber min={0.01} max={1} step={0.05} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                label="Flush timebox (ms)"
                name={['memoryConsolidation', 'timeboxMs']}
                extra="Max time the flush turn may run (memoryConsolidation.timeboxMs, default 30000)."
              >
                <InputNumber min={0} precision={0} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                label="Flush token cap"
                name={['memoryConsolidation', 'maxTokens']}
                extra="Token budget for the flush turn (memoryConsolidation.maxTokens, default 1024)."
              >
                <InputNumber min={0} precision={0} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                label="Max characters per flush"
                name={['memoryConsolidation', 'maxDeltaChars']}
                extra="Most characters one flush may write (memoryConsolidation.maxDeltaChars, default 4000)."
              >
                <InputNumber min={0} precision={0} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                label="Messages between flushes"
                name={['memoryConsolidation', 'minMessagesSinceFlush']}
                extra="Minimum messages before another flush may run (memoryConsolidation.minMessagesSinceFlush, default 8)."
              >
                <InputNumber min={0} precision={0} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                label="Decay half-life (days)"
                name={['memoryConsolidation', 'halfLifeDays']}
                extra="Recency half-life for memory decay (memoryConsolidation.halfLifeDays, default 30)."
              >
                <InputNumber min={0.1} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                label="Decay archive threshold"
                name={['memoryConsolidation', 'threshold']}
                extra="Entries weighted below this get archived (memoryConsolidation.threshold, default 0.05)."
              >
                <InputNumber min={0} max={1} step={0.01} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                label="Exempt USER.md from decay"
                name={['memoryConsolidation', 'exemptUser']}
                valuePropName="checked"
                extra="Keep the persistent user profile out of decay (memoryConsolidation.exemptUser, default on)."
              >
                <Switch />
              </Form.Item>
            </>
          )}

          <Form.Item
            label="Capture facts proactively"
            name="memoryCaptureEnabled"
            valuePropName="checked"
            extra="Notice durable facts mid-conversation and record them without being asked (default off)."
          >
            <Switch />
          </Form.Item>

          <Form.Item
            noStyle
            shouldUpdate={(prev, cur) => prev.memoryCaptureEnabled !== cur.memoryCaptureEnabled}
          >
            {({ getFieldValue }) =>
              getFieldValue('memoryCaptureEnabled') ? (
                <>
                  <Form.Item
                    label="Capture model"
                    name="memoryCaptureModel"
                    extra="Cheap model that extracts the fact. Leave blank to reuse the cheapest configured model."
                  >
                    <Input placeholder="claude-haiku-4-5-20251001" />
                  </Form.Item>
                  <Form.Item
                    label="Captures per hour"
                    name={['memoryCapture', 'maxPerHour']}
                    extra="Hourly capture cap per memory scope (memoryCapture.maxPerHour, default 6)."
                  >
                    <InputNumber min={1} precision={0} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item
                    label="Captures per day"
                    name={['memoryCapture', 'maxPerDay']}
                    extra="Daily capture cap per memory scope (memoryCapture.maxPerDay, default 30)."
                  >
                    <InputNumber min={1} precision={0} style={{ width: '100%' }} />
                  </Form.Item>
                  {showAdvanced && (
                    <>
                      <Form.Item
                        label="Capture provider"
                        name={['memoryCapture', 'provider']}
                        extra="Auxiliary provider for capture extraction (memoryCapture.provider). Blank = primary provider."
                      >
                        <Input placeholder="openrouter" />
                      </Form.Item>
                      <Form.Item
                        label="Capture API key"
                        name={['memoryCapture', 'apiKey']}
                        extra={
                          configQuery.data?.memoryCapture.apiKeyPreview
                            ? `Current: ${configQuery.data.memoryCapture.apiKeyPreview} — sent only when you type a new key (memoryCapture.apiKey).`
                            : 'Sent only when you type a key (memoryCapture.apiKey). Blank = primary key.'
                        }
                      >
                        <Input.Password
                          autoComplete="off"
                          placeholder={
                            configQuery.data?.memoryCapture.apiKeyPreview ?? 'paste new key'
                          }
                        />
                      </Form.Item>
                      <Form.Item
                        label="Capture base URL"
                        name={['memoryCapture', 'baseUrl']}
                        extra="Endpoint for the capture model (memoryCapture.baseUrl). Blank = primary base URL."
                      >
                        <Input placeholder="https://openrouter.ai/api/v1" />
                      </Form.Item>
                    </>
                  )}
                </>
              ) : null
            }
          </Form.Item>

          <Form.Item
            label="Show 'remembered' notices"
            name="memoryNotices"
            valuePropName="checked"
            extra="Show the dim '· remembered: …' notice after a capture — in the CLI, and as a quiet toast in the web app."
          >
            <Switch />
          </Form.Item>
        </Card>

        <Card title="Approval Mode" size="small" style={{ marginBottom: 16 }}>
          <Form.Item name="approvalMode">
            <Radio.Group>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Radio value="manual">
                  <span style={{ fontWeight: 500 }}>Manual</span>
                  <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--ethos-text-dim)' }}>
                    Ask before every sensitive tool call.
                  </span>
                </Radio>
                <Radio value="smart">
                  <span style={{ fontWeight: 500 }}>Smart</span>
                  <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--ethos-text-dim)' }}>
                    Ask only for high-risk operations. Routine tools run automatically.
                  </span>
                </Radio>
                <Radio value="off">
                  <span style={{ fontWeight: 500 }}>Off</span>
                  <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--ethos-text-dim)' }}>
                    Run all tools without asking. Use only on trusted machines.
                  </span>
                </Radio>
              </div>
            </Radio.Group>
          </Form.Item>
        </Card>

        <Card title="Chat display" size="small" style={{ marginBottom: 16 }}>
          <Form.Item
            label="Verbosity"
            name="verbosity"
            extra="How detailed the agent's responses should be."
          >
            <Select
              options={[
                { value: 'concise', label: 'Concise' },
                { value: 'balanced', label: 'Balanced' },
                { value: 'verbose', label: 'Verbose' },
              ]}
            />
          </Form.Item>

          <Form.Item
            label="Stream draft edits"
            name="streamingEdits"
            extra="Whether channel replies (Telegram, Slack) grow in place as they're written. DMs only, everywhere, or off."
          >
            <Select
              options={[
                { value: 'dms', label: 'Direct messages only' },
                { value: 'all', label: 'DMs and group chats' },
                { value: 'off', label: 'Off' },
              ]}
            />
          </Form.Item>

          <Form.Item
            label="Surface verbosity"
            name="displayVerbosity"
            extra="How much tool and status detail chat surfaces render (display.verbosity)."
          >
            <Select
              options={[
                { value: 'quiet', label: 'Quiet' },
                { value: 'default', label: 'Default' },
                { value: 'verbose', label: 'Verbose' },
                { value: 'debug', label: 'Debug' },
              ]}
            />
          </Form.Item>

          <Form.Item
            label="Enter while busy"
            name="displayBusyInputMode"
            extra="What pressing Enter mid-turn does (display.busy_input_mode)."
          >
            <Select
              options={[
                { value: 'interrupt', label: 'Interrupt the turn' },
                { value: 'queue', label: 'Queue for the next turn' },
                { value: 'steer', label: 'Steer the current turn' },
              ]}
            />
          </Form.Item>

          {showAdvanced && (
            <>
              <Form.Item
                label="Tool preview length"
                name="displayToolPreviewLength"
                extra="Truncate tool arguments in the feed to this many characters; 0 = no truncation (display.tool_preview_length)."
              >
                <InputNumber min={0} precision={0} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                label="Resume hint"
                name="displayResumeHint"
                valuePropName="checked"
                extra="Show the resume hint when leaving CLI chat (display.resume_hint, default on)."
              >
                <Switch />
              </Form.Item>
              <Form.Item
                label="Resume recap turns"
                name="displayResumeRecapTurns"
                extra="Turn pairs recapped when resuming a session; 0 disables (display.resume_recap_turns, default 3)."
              >
                <InputNumber min={0} max={10} precision={0} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                label="Bell on completion"
                name="displayBellOnComplete"
                valuePropName="checked"
                extra="Ring the terminal bell when a background task finishes (display.bell_on_complete, default off)."
              >
                <Switch />
              </Form.Item>
            </>
          )}
        </Card>

        <Card title="Context" size="small" style={{ marginBottom: 16 }}>
          <Form.Item
            name="contextLayering"
            valuePropName="checked"
            extra="Include previous session summaries for deeper context across conversations."
          >
            <Checkbox>Enable context layering</Checkbox>
          </Form.Item>

          <Form.Item
            label="Auto-compaction"
            name="autoCompact"
            valuePropName="checked"
            extra="Compact long sessions automatically near ~80% of the model's context window (default on)."
          >
            <Switch />
          </Form.Item>

          {showAdvanced && (
            <>
              <Form.Item
                label="Compaction pressure"
                name={['compaction', 'pressure']}
                extra="Context-window fraction that triggers compaction (compaction.pressure, default 0.8). Blank = default."
              >
                <InputNumber
                  min={0.01}
                  max={1}
                  step={0.05}
                  style={{ width: '100%' }}
                  placeholder="0.8"
                />
              </Form.Item>
              <Form.Item
                label="Compaction target"
                name={['compaction', 'target']}
                extra="Fraction the session is shrunk down to (compaction.target, default 0.7). Blank = default."
              >
                <InputNumber
                  min={0.01}
                  max={1}
                  step={0.05}
                  style={{ width: '100%' }}
                  placeholder="0.7"
                />
              </Form.Item>
              <Form.Item
                label="Gate delta (tokens)"
                name={['compaction', 'gateDelta']}
                extra="Extra token headroom before the compaction gate fires (compaction.gateDelta). Blank = unset."
              >
                <InputNumber min={0} precision={0} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                label="Retry on overflow"
                name={['compaction', 'retryOnOverflow']}
                valuePropName="checked"
                extra="Compact and retry once when a request overflows the window (compaction.retryOnOverflow, default on)."
              >
                <Switch />
              </Form.Item>
              <Form.Item
                label="Small-window mode"
                name={['compaction', 'smallWindow']}
                extra="Force small-window handling for local models (compaction.smallWindow, default auto)."
              >
                <Select
                  options={[
                    { value: 'auto', label: 'Auto' },
                    { value: 'on', label: 'On' },
                    { value: 'off', label: 'Off' },
                  ]}
                />
              </Form.Item>
            </>
          )}
        </Card>

        <Card title="Developer" size="small" style={{ marginBottom: 16 }}>
          <Form.Item
            name="debugMode"
            valuePropName="checked"
            extra="Show expanded tool arguments and internal events in chat."
          >
            <Checkbox>Enable debug mode</Checkbox>
          </Form.Item>

          <Form.Item
            name="debugPanelEnabled"
            valuePropName="checked"
            extra="Adds a debug assistant to the right sidebar that can inspect session events, observability spans, and error logs."
          >
            <Checkbox>Show debug panel</Checkbox>
          </Form.Item>

          <Form.Item
            name="debugPanelModel"
            extra="Model for the debug assistant. Leave empty to use the default (claude-sonnet-4-5)."
          >
            <Input placeholder="claude-sonnet-4-5" />
          </Form.Item>
        </Card>

        <Card title="Voice" size="small" style={{ marginBottom: 16 }}>
          <Form.Item
            name="voiceEnabled"
            valuePropName="checked"
            extra="Enable the voice recording button in the chat bar."
          >
            <Switch checkedChildren="On" unCheckedChildren="Off" />
          </Form.Item>
          <Form.Item
            label="Processing chime"
            name="voiceChime"
            valuePropName="checked"
            extra="Play a short sound while the agent is thinking (after you stop speaking)."
          >
            <Switch />
          </Form.Item>
          <Collapse
            ghost
            size="small"
            style={{ marginBottom: 16 }}
            items={[
              {
                key: 'voice-tuning',
                label: 'Advanced voice tuning',
                children: (
                  <>
                    {VOICE_TUNING_CONTROLS.map((c) => (
                      <Form.Item key={c.name} name={c.name} label={c.label} extra={c.extra}>
                        <Slider
                          min={c.min}
                          max={c.max}
                          step={c.step}
                          tooltip={{ formatter: (v) => `${v ?? ''}${c.unit}` }}
                        />
                      </Form.Item>
                    ))}
                    <Button
                      size="small"
                      onClick={() =>
                        form.setFieldsValue(
                          Object.fromEntries(
                            VOICE_TUNING_CONTROLS.map((c) => [
                              c.name,
                              DEFAULT_VOICE_TUNING[c.defaultKey],
                            ]),
                          ),
                        )
                      }
                    >
                      Reset to defaults
                    </Button>
                  </>
                ),
              },
            ]}
          />
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.voiceEnabled !== cur.voiceEnabled}>
            {({ getFieldValue }) =>
              getFieldValue('voiceEnabled') ? (
                <>
                  <Form.Item
                    name="voiceProvider"
                    label="STT Provider"
                    rules={[{ required: true, message: 'Select a provider to enable voice' }]}
                  >
                    <Select
                      placeholder="Select a provider..."
                      onChange={(value: string) => {
                        const d = STT_PROVIDER_DEFAULTS[value];
                        if (!d) return;
                        const patch: Partial<FormShape> = {};
                        if (!form.getFieldValue('voiceBaseUrl')) patch.voiceBaseUrl = d.baseUrl;
                        if (!form.getFieldValue('voiceModel')) patch.voiceModel = d.model;
                        if (Object.keys(patch).length > 0) form.setFieldsValue(patch);
                      }}
                      options={[
                        { label: 'OpenAI Whisper', value: 'openai-stt' },
                        { label: 'Groq Whisper (free tier)', value: 'groq-stt' },
                        { label: 'Local (Whisper / OpenAI-compatible)', value: 'local-stt' },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item
                    noStyle
                    shouldUpdate={(prev, cur) => prev.voiceProvider !== cur.voiceProvider}
                  >
                    {({ getFieldValue: getStt }) =>
                      getStt('voiceProvider') === 'local-stt' ? (
                        <Form.Item
                          name="voiceBaseUrl"
                          label="STT Base URL"
                          extra="Endpoint for your local (OpenAI-compatible) server. Leave blank for the default."
                        >
                          <Input placeholder="http://localhost:8000/v1" />
                        </Form.Item>
                      ) : null
                    }
                  </Form.Item>
                  <Form.Item
                    name="voiceModel"
                    label="STT Model"
                    extra="Free-form — server-specific (e.g. Systran/faster-whisper-large-v3)."
                  >
                    <Input placeholder="whisper-large-v3" />
                  </Form.Item>
                  <Form.Item
                    name="voiceApiKey"
                    label="STT API key (optional)"
                    extra={
                      configQuery.data?.voiceApiKeyPreview
                        ? `Current: ${configQuery.data.voiceApiKeyPreview}`
                        : 'Optional — leave blank for local servers that need no key.'
                    }
                  >
                    <Input.Password placeholder="Enter API key..." />
                  </Form.Item>
                  <Form.Item
                    noStyle
                    shouldUpdate={(prev, cur) =>
                      STT_TEST_DIRTY_FIELDS.some((k) => prev[k] !== cur[k])
                    }
                  >
                    {({ getFieldValue: getStt }) => {
                      const saved = configQuery.data;
                      const dirty =
                        (getStt('voiceProvider') ?? '') !== (saved?.voiceProvider ?? '') ||
                        (getStt('voiceModel') ?? '') !== (saved?.voiceModel ?? '') ||
                        (getStt('voiceBaseUrl') ?? '') !== (saved?.voiceBaseUrl ?? '') ||
                        Boolean(getStt('voiceApiKey'));
                      return <SttTest disabled={!saved?.voiceProvider} dirty={dirty} />;
                    }}
                  </Form.Item>
                  <Form.Item
                    name="voiceTtsProvider"
                    label="TTS Provider"
                    extra="Text-to-speech provider for reading agent responses aloud."
                  >
                    <Select
                      allowClear
                      placeholder="Select a TTS provider..."
                      onChange={(value: string | undefined) => {
                        if (!value) return;
                        const d = TTS_PROVIDER_DEFAULTS[value];
                        if (!d) return;
                        const patch: Partial<FormShape> = {};
                        if (!form.getFieldValue('voiceTtsBaseUrl'))
                          patch.voiceTtsBaseUrl = d.baseUrl;
                        if (!form.getFieldValue('voiceTtsModel')) patch.voiceTtsModel = d.model;
                        if (Object.keys(patch).length > 0) form.setFieldsValue(patch);
                      }}
                      options={[
                        { label: 'OpenAI TTS', value: 'openai-tts' },
                        { label: 'Local (Kokoro / OpenAI-compatible)', value: 'local-tts' },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item
                    noStyle
                    shouldUpdate={(prev, cur) => prev.voiceTtsProvider !== cur.voiceTtsProvider}
                  >
                    {({ getFieldValue: getTts }) =>
                      getTts('voiceTtsProvider') ? (
                        <>
                          {getTts('voiceTtsProvider') === 'local-tts' ? (
                            <Form.Item
                              name="voiceTtsBaseUrl"
                              label="TTS Base URL"
                              extra="Endpoint for your local (OpenAI-compatible) server. Leave blank for the default."
                            >
                              <Input placeholder="http://localhost:8880/v1" />
                            </Form.Item>
                          ) : null}
                          <Form.Item
                            name="voiceTtsModel"
                            label="TTS Model"
                            extra="Free-form — server-specific (e.g. kokoro, tts-1)."
                          >
                            <Input placeholder="kokoro" />
                          </Form.Item>
                          <Form.Item
                            name="voiceTtsApiKey"
                            label="TTS API key (optional)"
                            extra={
                              configQuery.data?.voiceTtsApiKeyPreview
                                ? `Current: ${configQuery.data.voiceTtsApiKeyPreview}`
                                : 'Optional — leave blank for local servers that need no key.'
                            }
                          >
                            <Input.Password placeholder="Enter API key..." />
                          </Form.Item>
                          <Form.Item
                            name="voiceTtsVoice"
                            label="Voice ID"
                            extra="Free-form — every server names voices differently (e.g. Kokoro af_bella, OpenAI nova)."
                          >
                            <Input placeholder="e.g. af_bella" />
                          </Form.Item>
                          <Form.Item
                            noStyle
                            shouldUpdate={(prev, cur) =>
                              TTS_TEST_DIRTY_FIELDS.some((k) => prev[k] !== cur[k])
                            }
                          >
                            {({ getFieldValue: getTtsField }) => {
                              const saved = configQuery.data;
                              const dirty =
                                (getTtsField('voiceTtsProvider') ?? '') !==
                                  (saved?.voiceTtsProvider ?? '') ||
                                (getTtsField('voiceTtsModel') ?? '') !==
                                  (saved?.voiceTtsModel ?? '') ||
                                (getTtsField('voiceTtsBaseUrl') ?? '') !==
                                  (saved?.voiceTtsBaseUrl ?? '') ||
                                (getTtsField('voiceTtsVoice') ?? '') !==
                                  (saved?.voiceTtsVoice ?? '') ||
                                Boolean(getTtsField('voiceTtsApiKey'));
                              return <TtsTest disabled={!saved?.voiceTtsProvider} dirty={dirty} />;
                            }}
                          </Form.Item>
                        </>
                      ) : null
                    }
                  </Form.Item>
                </>
              ) : null
            }
          </Form.Item>
        </Card>

        <AutomationCard
          qcRows={quickCommandRows}
          setQcRows={setQuickCommandRows}
          ctRows={channelToolsetRows}
          setCtRows={setChannelToolsetRows}
        />

        {showAdvanced ? (
          <Card title="Model routing" size="small" style={{ marginBottom: 16 }}>
            <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
              Per-personality model overrides. Edit ~/.ethos/config.yaml directly to add entries —
              this surface lists the current overrides; full editing lands later.
            </Typography.Paragraph>
            <ModelRoutingView routing={configQuery.data?.modelRouting ?? {}} />
          </Card>
        ) : null}

        {showAdvanced && <BackgroundJobsCard />}

        {showAdvanced && (
          <RetentionCard
            rows={retentionRows}
            setRows={setRetentionRows}
            personalities={personalities}
          />
        )}

        {showAdvanced && (
          <ModelsBackendsCard
            auxPreviews={{
              compression: configQuery.data?.auxCompression.apiKeyPreview ?? null,
              vision: configQuery.data?.auxVision.apiKeyPreview ?? null,
              web: configQuery.data?.auxWeb.apiKeyPreview ?? null,
            }}
          />
        )}

        {showAdvanced && <AdvancedMiscCard />}

        {showAdvanced && (
          <Card title="Admin" size="small" style={{ marginBottom: 16 }}>
            <Form.Item
              name="adminEnabled"
              valuePropName="checked"
              extra="Enable the admin console for system-level operations. Takes effect on save."
              style={{ marginBottom: configQuery.data?.adminEnabled ? 12 : 0 }}
            >
              <Checkbox>Enable admin panel</Checkbox>
            </Form.Item>
            {configQuery.data?.adminEnabled && (
              <Button onClick={() => navigate('/admin')}>Open admin panel</Button>
            )}
          </Card>
        )}

        <Form.Item>
          <Button type="primary" htmlType="submit" loading={updateMut.isPending}>
            Save
          </Button>
        </Form.Item>
      </Form>

      <Card title="Setup wizard" size="small" style={{ maxWidth: 640, marginTop: 8 }}>
        <Typography.Paragraph type="secondary" style={{ marginTop: 0, marginBottom: 12 }}>
          Re-run the guided setup to change your provider, model, personality, or messaging
          credentials.
        </Typography.Paragraph>
        <Button onClick={() => navigate('/onboarding')}>Run setup wizard</Button>
      </Card>

      <WebSearchDefaultsSection />

      <NamedSecretsSection />

      <LatestDigestSection />

      <A2aSection />

      <ApiKeysSection />

      {isDesktop ? <DesktopSettings /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Automation — quick commands + channel toolsets (full-replacement records)
// plus the nightly-pass / weekly-digest schedule fields.
// ---------------------------------------------------------------------------

function AutomationCard({
  qcRows,
  setQcRows,
  ctRows,
  setCtRows,
}: {
  qcRows: QuickCommandRow[];
  setQcRows: Dispatch<SetStateAction<QuickCommandRow[]>>;
  ctRows: ChannelToolsetRow[];
  setCtRows: Dispatch<SetStateAction<ChannelToolsetRow[]>>;
}) {
  const updateQc = (index: number, patch: Partial<QuickCommandRow>) =>
    setQcRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const removeQc = (index: number) => setQcRows((prev) => prev.filter((_, i) => i !== index));
  const addQc = () =>
    setQcRows((prev) => [
      ...prev,
      {
        _id: nextRowId++,
        name: '',
        type: 'reply',
        command: '',
        reply: '',
        gateway: false,
        channels: [],
      },
    ]);

  const updateCt = (index: number, patch: Partial<ChannelToolsetRow>) =>
    setCtRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const removeCt = (index: number) => setCtRows((prev) => prev.filter((_, i) => i !== index));
  const addCt = () =>
    setCtRows((prev) => [...prev, { _id: nextRowId++, platform: '', toolsets: [] }]);

  return (
    <Card title="Automation" size="small" style={{ marginBottom: 16 }}>
      <Typography.Text strong style={{ fontSize: 13 }}>
        Quick commands
      </Typography.Text>
      <Typography.Paragraph type="secondary" style={{ marginTop: 4 }}>
        Deterministic /name shortcuts (quick_commands.&lt;name&gt;) answered without the LLM — a
        canned reply or an operator-authored shell command. Saving replaces the whole set.
      </Typography.Paragraph>
      {qcRows.map((row, idx) => (
        <div key={row._id} style={ROW_BOX_STYLE}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 8,
            }}
          >
            <Typography.Text style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}>
              /{row.name || '<name>'}
            </Typography.Text>
            <Button size="small" danger onClick={() => removeQc(idx)}>
              Remove
            </Button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <div style={{ flex: 1 }}>
              <RowLabel>Name</RowLabel>
              <Input
                size="small"
                prefix="/"
                placeholder="status"
                value={row.name}
                onChange={(e) => updateQc(idx, { name: e.target.value })}
              />
            </div>
            <div style={{ width: 180 }}>
              <RowLabel>Type</RowLabel>
              <Select
                size="small"
                style={{ width: '100%' }}
                value={row.type}
                onChange={(v: 'exec' | 'reply') => updateQc(idx, { type: v })}
                options={[
                  { value: 'reply', label: 'reply — canned text' },
                  { value: 'exec', label: 'exec — shell command' },
                ]}
              />
            </div>
          </div>
          <div style={{ marginBottom: 8 }}>
            {row.type === 'exec' ? (
              <>
                <RowLabel>
                  Shell command (runs verbatim — channel text is never interpolated)
                </RowLabel>
                <Input
                  size="small"
                  style={{ fontFamily: 'Geist Mono, monospace' }}
                  placeholder="uptime"
                  value={row.command}
                  onChange={(e) => updateQc(idx, { command: e.target.value })}
                />
              </>
            ) : (
              <>
                <RowLabel>Reply text</RowLabel>
                <Input
                  size="small"
                  placeholder="All systems nominal."
                  value={row.reply}
                  onChange={(e) => updateQc(idx, { reply: e.target.value })}
                />
              </>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div>
              <Checkbox
                checked={row.gateway}
                onChange={(e) => updateQc(idx, { gateway: e.target.checked })}
              >
                <span style={{ fontSize: 12 }}>Expose on channels</span>
              </Checkbox>
            </div>
            <div style={{ flex: 1 }}>
              <RowLabel>Limit to platforms (blank = all)</RowLabel>
              <Select
                size="small"
                mode="tags"
                open={false}
                suffixIcon={null}
                tokenSeparators={[',']}
                style={{ width: '100%' }}
                placeholder="telegram, slack"
                value={row.channels}
                onChange={(v: string[]) => updateQc(idx, { channels: v })}
                disabled={!row.gateway}
              />
            </div>
          </div>
        </div>
      ))}
      <Button
        type="dashed"
        size="small"
        onClick={addQc}
        style={{ width: '100%', marginBottom: 16 }}
      >
        Add quick command
      </Button>

      <Typography.Text strong style={{ fontSize: 13 }}>
        Channel toolsets
      </Typography.Text>
      <Typography.Paragraph type="secondary" style={{ marginTop: 4 }}>
        Per-platform toolset narrowing (channel_toolsets.&lt;platform&gt;). Messages from that
        platform see only the listed toolsets. Saving replaces the whole set.
      </Typography.Paragraph>
      {ctRows.map((row, idx) => (
        <div
          key={row._id}
          style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'flex-end' }}
        >
          <div style={{ width: 160 }}>
            <RowLabel>Platform</RowLabel>
            <Input
              size="small"
              placeholder="telegram"
              value={row.platform}
              onChange={(e) => updateCt(idx, { platform: e.target.value })}
            />
          </div>
          <div style={{ flex: 1 }}>
            <RowLabel>Toolsets</RowLabel>
            <Select
              size="small"
              mode="tags"
              open={false}
              suffixIcon={null}
              tokenSeparators={[',']}
              style={{ width: '100%' }}
              placeholder="memory, web"
              value={row.toolsets}
              onChange={(v: string[]) => updateCt(idx, { toolsets: v })}
            />
          </div>
          <Button size="small" danger onClick={() => removeCt(idx)}>
            Remove
          </Button>
        </div>
      ))}
      <Button
        type="dashed"
        size="small"
        onClick={addCt}
        style={{ width: '100%', marginBottom: 16 }}
      >
        Add platform
      </Button>

      <Form.Item
        label="Nightly learning pass"
        name={['nightlyPass', 'enabled']}
        valuePropName="checked"
        extra="Governed-learning pass that runs overnight (nightlyPass.enabled, default off)."
      >
        <Switch />
      </Form.Item>
      <Form.Item
        noStyle
        shouldUpdate={(prev, cur) => prev.nightlyPass?.enabled !== cur.nightlyPass?.enabled}
      >
        {({ getFieldValue }) =>
          getFieldValue(['nightlyPass', 'enabled']) ? (
            <Form.Item
              label="Nightly pass schedule"
              name={['nightlyPass', 'cron']}
              extra="5-field cron (nightlyPass.cron). Blank = 0 3 * * *."
            >
              <Input style={{ fontFamily: 'Geist Mono, monospace' }} placeholder="0 3 * * *" />
            </Form.Item>
          ) : null
        }
      </Form.Item>

      <Form.Item
        label="Weekly digest"
        name={['weeklyDigest', 'enabled']}
        valuePropName="checked"
        extra="Weekly governed-learning digest (weeklyDigest.enabled, default off)."
      >
        <Switch />
      </Form.Item>
      <Form.Item
        noStyle
        shouldUpdate={(prev, cur) => prev.weeklyDigest?.enabled !== cur.weeklyDigest?.enabled}
      >
        {({ getFieldValue }) =>
          getFieldValue(['weeklyDigest', 'enabled']) ? (
            <>
              <Form.Item
                label="Digest schedule"
                name={['weeklyDigest', 'cron']}
                extra="5-field cron (weeklyDigest.cron). Blank = 0 9 * * 1."
              >
                <Input style={{ fontFamily: 'Geist Mono, monospace' }} placeholder="0 9 * * 1" />
              </Form.Item>
              <Form.Item
                label="Digest recipients"
                name={['weeklyDigest', 'recipients']}
                extra="Email allowlist for --email delivery (weeklyDigest.recipients). Press Enter after each address."
              >
                <Select
                  mode="tags"
                  open={false}
                  suffixIcon={null}
                  tokenSeparators={[',']}
                  placeholder="you@example.com"
                />
              </Form.Item>
            </>
          ) : null
        }
      </Form.Item>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Background jobs (advanced) — the `background.*` sub-agent pool caps.
// ---------------------------------------------------------------------------

function BackgroundJobsCard() {
  const numberField = (
    name: keyof FormShape['background'],
    label: string,
    extra: string,
    opts: { min: number; integer?: boolean } = { min: 0, integer: true },
  ) => (
    <Form.Item label={label} name={['background', name]} extra={extra}>
      <InputNumber
        min={opts.min}
        {...(opts.integer === false ? {} : { precision: 0 })}
        style={{ width: '100%' }}
      />
    </Form.Item>
  );

  return (
    <Card title="Background jobs" size="small" style={{ marginBottom: 16 }}>
      <Form.Item
        label="Enable background sub-agents"
        name={['background', 'enabled']}
        valuePropName="checked"
        extra="Allow spawning background jobs (background.enabled, default off)."
      >
        <Switch />
      </Form.Item>
      {numberField(
        'maxConcurrentJobs',
        'Max concurrent jobs',
        'Jobs running at once (background.max_concurrent_jobs, default 2).',
        { min: 1 },
      )}
      {numberField(
        'maxJobsPerRoot',
        'Max jobs per root session',
        'Cap per root session (background.max_jobs_per_root, default 3).',
        { min: 1 },
      )}
      {numberField(
        'maxJobsPerPersonality',
        'Max jobs per personality',
        'Cap per personality (background.max_jobs_per_personality, default 5).',
        { min: 1 },
      )}
      {numberField(
        'defaultMaxCostUsd',
        'Default job budget (USD)',
        'Per-job spend cap (background.default_max_cost_usd, default 1).',
        { min: 0, integer: false },
      )}
      {numberField(
        'maxRootBackgroundUsd',
        'Root budget (USD)',
        'Total background spend per root session (background.max_root_background_usd, default 5).',
        { min: 0, integer: false },
      )}
      {numberField(
        'queuedTtlMs',
        'Queued TTL (ms)',
        'How long a queued job may wait before expiring (background.queued_ttl_ms, default 900000).',
        { min: 0 },
      )}
      {numberField(
        'staleMs',
        'Stale after (ms)',
        'A job with no heartbeat for this long counts as stale (background.stale_ms, default 90000).',
        { min: 0 },
      )}
      {numberField(
        'heartbeatMs',
        'Heartbeat interval (ms)',
        'How often running jobs report liveness (background.heartbeat_ms, default 30000).',
        { min: 0 },
      )}
      {numberField(
        'retentionDays',
        'Job retention (days)',
        'Days finished job records are kept (background.retention_days, default 30).',
        { min: 1 },
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Data retention (advanced) — full-replacement editor for `retention.<subkey>`
// and `personalities.<id>.retention.<subkey>` TTLs.
// ---------------------------------------------------------------------------

function RetentionCard({
  rows,
  setRows,
  personalities,
}: {
  rows: RetentionRow[];
  setRows: Dispatch<SetStateAction<RetentionRow[]>>;
  personalities: PersonalityOption[];
}) {
  const update = (index: number, patch: Partial<RetentionRow>) =>
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const remove = (index: number) => setRows((prev) => prev.filter((_, i) => i !== index));
  const add = () =>
    setRows((prev) => [
      ...prev,
      { _id: nextRowId++, personalityId: '', subkey: 'messages', duration: '' },
    ]);

  return (
    <Card title="Data retention" size="small" style={{ marginBottom: 16 }}>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        TTLs for stored data (retention.&lt;subkey&gt;, or
        personalities.&lt;id&gt;.retention.&lt;subkey&gt; to override for one personality). Duration
        is &quot;forever&quot; or a number plus d/w/m/y, e.g. 90d. Unlisted subkeys keep the
        built-in default; saving replaces the whole set.
      </Typography.Paragraph>
      {rows.map((row, idx) => (
        <div
          key={row._id}
          style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'flex-end' }}
        >
          <div style={{ flex: 1 }}>
            <RowLabel>Scope</RowLabel>
            <Select
              size="small"
              style={{ width: '100%' }}
              value={row.personalityId}
              onChange={(v: string) => update(idx, { personalityId: v })}
              options={[
                { value: '', label: 'Global' },
                ...personalities.map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
          </div>
          <div style={{ flex: 1 }}>
            <RowLabel>Data</RowLabel>
            <Select
              size="small"
              style={{ width: '100%' }}
              value={row.subkey}
              onChange={(v: RetentionSubkey) => update(idx, { subkey: v })}
              options={RETENTION_SUBKEYS.map((s) => ({ value: s, label: s }))}
            />
          </div>
          <div style={{ width: 110 }}>
            <RowLabel>Duration</RowLabel>
            <Input
              size="small"
              placeholder="90d"
              value={row.duration}
              onChange={(e) => update(idx, { duration: e.target.value })}
            />
          </div>
          <Button size="small" danger onClick={() => remove(idx)}>
            Remove
          </Button>
        </div>
      ))}
      <Button type="dashed" size="small" onClick={add} style={{ width: '100%' }}>
        Add retention rule
      </Button>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Models & backends (advanced) — model catalog, web tool backends, and the
// three auxiliary model slots. Aux API keys are write-only (preview shown).
// ---------------------------------------------------------------------------

function AuxModelFields({
  slot,
  label,
  help,
  preview,
}: {
  slot: 'auxCompression' | 'auxVision' | 'auxWeb';
  label: string;
  help: string;
  preview: string | null;
}) {
  return (
    <div style={ROW_BOX_STYLE}>
      <Typography.Text strong style={{ fontSize: 13 }}>
        {label}
      </Typography.Text>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4 }}>
        {help} Blank fields fall back to the primary provider.
      </Typography.Paragraph>
      <Form.Item label="Model" name={[slot, 'model']} style={{ marginBottom: 8 }}>
        <Input size="small" placeholder="claude-haiku-4-5-20251001" />
      </Form.Item>
      <Form.Item label="Provider" name={[slot, 'provider']} style={{ marginBottom: 8 }}>
        <Input size="small" placeholder="anthropic | openrouter | ollama" />
      </Form.Item>
      <Form.Item
        label="API key"
        name={[slot, 'apiKey']}
        style={{ marginBottom: 8 }}
        extra={preview ? `Current: ${preview} — sent only when you type a new key.` : undefined}
      >
        <Input.Password size="small" autoComplete="off" placeholder={preview ?? 'paste new key'} />
      </Form.Item>
      <Form.Item label="Base URL" name={[slot, 'baseUrl']} style={{ marginBottom: 0 }}>
        <Input size="small" placeholder="https://openrouter.ai/api/v1" />
      </Form.Item>
    </div>
  );
}

function ModelsBackendsCard({
  auxPreviews,
}: {
  auxPreviews: { compression: string | null; vision: string | null; web: string | null };
}) {
  return (
    <Card title="Models & backends" size="small" style={{ marginBottom: 16 }}>
      <Form.Item
        label="Remote model catalog"
        name={['modelCatalog', 'enabled']}
        valuePropName="checked"
        extra="Fetch the remote model catalog for model pickers (modelCatalog.enabled, default on)."
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label="Catalog URL"
        name={['modelCatalog', 'url']}
        extra="Override the catalog endpoint (modelCatalog.url). Blank = built-in endpoint."
      >
        <Input placeholder="https://…" />
      </Form.Item>
      <Form.Item
        label="Catalog TTL (hours)"
        name={['modelCatalog', 'ttlHours']}
        extra="Cache lifetime for the fetched catalog (modelCatalog.ttlHours, default 24)."
      >
        <InputNumber min={0.1} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item
        label="Web search backend"
        name="webSearchBackend"
        extra="Force the web_search tool's backend (web.search_backend). Auto picks from available keys — key bindings live under Web-search defaults."
      >
        <Select
          options={[
            { value: '', label: 'Auto' },
            { value: 'exa', label: 'Exa' },
            { value: 'tavily', label: 'Tavily' },
            { value: 'brave', label: 'Brave' },
          ]}
        />
      </Form.Item>
      <Form.Item
        label="Web extract backend"
        name="webExtractBackend"
        extra="Force the web_extract tool's backend (web.extract_backend)."
      >
        <Select
          options={[
            { value: '', label: 'Auto' },
            { value: 'htmltext', label: 'htmltext' },
          ]}
        />
      </Form.Item>
      <AuxModelFields
        slot="auxCompression"
        label="Compression model"
        help="Summarizer used for context compaction (auxiliary.compression.*)."
        preview={auxPreviews.compression}
      />
      <AuxModelFields
        slot="auxVision"
        label="Vision model"
        help="Fallback for image inputs when the primary model lacks vision (auxiliary.vision.*)."
        preview={auxPreviews.vision}
      />
      <AuxModelFields
        slot="auxWeb"
        label="Web summarizer"
        help="Summarizer for web_extract output (auxiliary.web.*)."
        preview={auxPreviews.web}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Advanced misc (advanced) — log rotation, plugin auto-install, base URLs.
// `a2a.enabled` is deliberately NOT here: the live A2A card below the form
// already toggles the same key through the running gate.
// ---------------------------------------------------------------------------

function AdvancedMiscCard() {
  return (
    <Card title="Advanced" size="small" style={{ marginBottom: 16 }}>
      <Form.Item
        label="Log rotation"
        name={['logsRotation', 'enabled']}
        valuePropName="checked"
        extra="Rotate the ~/.ethos error logs (logs.rotation.enabled, default on)."
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label="Max log size (bytes)"
        name={['logsRotation', 'maxBytes']}
        extra="Rotate when a log exceeds this size (logs.rotation.maxBytes). Blank = built-in default."
      >
        <InputNumber min={1} precision={0} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item
        label="Rotated files kept"
        name={['logsRotation', 'maxFiles']}
        extra="Rotated log files to keep (logs.rotation.maxFiles). Blank = built-in default."
      >
        <InputNumber min={1} precision={0} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item
        label="Auto-install plugins"
        name="pluginsAutoInstall"
        extra="Install plugins from plugins.lock on startup (plugins.auto_install). Default leaves the key unset."
      >
        <Select
          options={[
            { value: 'default', label: 'Default (unset)' },
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' },
          ]}
        />
      </Form.Item>
      <Form.Item
        label="Web base URL"
        name="webBaseUrl"
        extra="Public URL of this web UI, used as the OAuth redirect base (webBaseUrl). Blank = localhost."
      >
        <Input placeholder="https://ethos.example.com" />
      </Form.Item>
      <Form.Item
        label="Azure API version"
        name="apiVersion"
        extra="REST API version for the azure provider (apiVersion). Blank = provider default."
      >
        <Input placeholder="2024-06-01" />
      </Form.Item>
      <Form.Item
        label="Per-turn timing summary"
        name="verbose"
        valuePropName="checked"
        extra="Print a timing and cost line after every CLI response (verbose, default off)."
      >
        <Switch />
      </Form.Item>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Latest digest — read-only view of the most recent weekly governed-learning
// report. Generation runs out-of-band (weekly cron / `ethos digest run`); a
// "generate now" action is deferred.
// ---------------------------------------------------------------------------

function formatDigestDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function LatestDigestSection() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const digestQuery = useQuery({
    queryKey: ['digest', 'latest'],
    queryFn: () => rpc.digest.latest(),
  });

  const generateMut = useMutation({
    mutationFn: () => rpc.digest.generate(),
    onSuccess: (data) => {
      if (data === null) {
        notification.info({
          message: 'No user personalities to build a digest for.',
          placement: 'topRight',
        });
        return;
      }
      qc.setQueryData(['digest', 'latest'], data);
      qc.invalidateQueries({ queryKey: ['digest', 'latest'] });
    },
    onError: (err) =>
      notification.error({
        message: 'Failed to generate digest',
        description: (err as Error).message,
      }),
  });

  return (
    <Card
      title="Latest digest"
      size="small"
      style={{ maxWidth: 640, marginTop: 32 }}
      extra={
        <Button size="small" loading={generateMut.isPending} onClick={() => generateMut.mutate()}>
          Generate now
        </Button>
      }
    >
      {digestQuery.isLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', height: 80 }}>
          <Spin />
        </div>
      ) : !digestQuery.data ? (
        <Typography.Text type="secondary">
          No digest generated yet — runs weekly, or via{' '}
          <Typography.Text code>ethos digest run</Typography.Text>.
        </Typography.Text>
      ) : (
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
            <Typography.Text strong style={{ fontFamily: 'Geist Mono, monospace', fontSize: 13 }}>
              {digestQuery.data.label}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatDigestDate(digestQuery.data.generatedAt)}
            </Typography.Text>
          </div>
          <ContentRenderer content={digestQuery.data.markdown} format="markdown" />
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Agent-to-Agent (A2A) — serve-wide enable/disable toggle. Live gate: the
// switch calls `a2a.settings.set` on flip (not the page Save button). Enabling
// exposes the discovery + peering surface; peers stay default-deny regardless.
// When A2A is not wired on this server the `get` returns NOT_AVAILABLE (503) —
// render the switch disabled with a subtle note rather than erroring loudly.
// ---------------------------------------------------------------------------

/** True when an oRPC client error carries the `NOT_AVAILABLE` code. */
function isNotAvailable(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: unknown }).code === 'NOT_AVAILABLE'
  );
}

function A2aSection() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  const settingsQuery = useQuery({
    queryKey: ['a2a', 'settings'],
    queryFn: () => rpc.a2a.settings.get(),
    retry: false,
  });

  const setMut = useMutation({
    mutationFn: (enabled: boolean) => rpc.a2a.settings.set({ enabled }),
    onSuccess: (data) => {
      qc.setQueryData(['a2a', 'settings'], data);
      notification.success({
        message: data.enabled ? 'A2A enabled' : 'A2A disabled',
        placement: 'topRight',
      });
    },
    onError: (err) =>
      notification.error({ message: 'Failed to update A2A', description: (err as Error).message }),
  });

  const unavailable = isNotAvailable(settingsQuery.error);
  const loadError = settingsQuery.error && !unavailable ? settingsQuery.error : null;
  const enabled = settingsQuery.data?.enabled ?? false;

  return (
    <Card title="Agent-to-Agent (A2A)" size="small" style={{ maxWidth: 640, marginTop: 32 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <Switch
          checked={enabled}
          disabled={unavailable || Boolean(loadError) || settingsQuery.isLoading}
          loading={settingsQuery.isLoading || setMut.isPending}
          onChange={(next) => setMut.mutate(next)}
        />
        <Typography.Text>{enabled ? 'Enabled' : 'Disabled'}</Typography.Text>
      </div>
      {loadError ? (
        <Typography.Text type="danger" style={{ fontSize: 12 }}>
          Failed to load A2A status: {(loadError as Error).message}
        </Typography.Text>
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {unavailable
            ? 'Unavailable on this server.'
            : 'Enabling exposes the A2A discovery and peering surface. Peers are still default-deny.'}
        </Typography.Text>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// API Keys management section
// ---------------------------------------------------------------------------

const ALL_SCOPES: ApiKeyScope[] = [
  'sessions:read',
  'sessions:write',
  'chat',
  'chat:send',
  'personalities:read',
  'memory:read',
  'memory:write',
  'tools:approve',
  'events:subscribe',
];

/**
 * Hints for the scopes whose names don't explain themselves. `chat` and
 * `chat:send` are one letter apart in the checkbox list and gate completely
 * different surfaces, so both are annotated. Unlisted scopes render bare.
 */
const SCOPE_HINTS: Partial<Record<ApiKeyScope, string>> = {
  chat: 'OpenAI-compatible API (/v1/models, /v1/chat/completions) — for Cursor, Aider, the OpenAI SDKs',
  'chat:send': 'chat.send and chat.abort RPC — for a Mission Control built on @ethosagent/sdk',
};

interface CreateKeyForm {
  name: string;
  scopes: ApiKeyScope[];
  origins: string[];
}

// ---------------------------------------------------------------------------
// Web-search defaults — the global default provider + bound secret
// (`toolSettings._default.web_search`), rendered from the tool's settingsSchema.
// Mirrors the "Model routing" / "Voice" cards. Optional test-key probe reuses
// the provider test-connection pattern.
// ---------------------------------------------------------------------------

function WebSearchDefaultsSection() {
  const schemasQuery = useToolSettingsSchemas();
  const defaultQuery = useToolSettingsDefault();
  const setDefault = useToolSettingsSetDefault();
  const [values, setValues] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [testError, setTestError] = useState<string | undefined>();

  const schema = schemasQuery.data?.tools.find((t) => t.name === 'web_search')?.settingsSchema;

  useEffect(() => {
    if (!dirty && defaultQuery.data) {
      setValues(defaultQuery.data.values.web_search ?? {});
    }
  }, [defaultQuery.data, dirty]);

  // No web_search tool wired (no schema) → nothing to configure.
  if (!schema) return null;

  const handleTest = async () => {
    const provider = values.provider;
    const name = values.secret;
    if (!isWebSearchProvider(provider) || !name) return;
    setTestStatus('testing');
    setTestError(undefined);
    try {
      const res = await rpc.namedSecrets.testKey({ provider, name });
      if (res.ok) setTestStatus('ok');
      else {
        setTestStatus('error');
        setTestError(res.error);
      }
    } catch (err) {
      setTestStatus('error');
      setTestError((err as Error).message);
    }
  };

  const canTest = isWebSearchProvider(values.provider) && !!values.secret;

  return (
    <Card title="Web-search defaults" size="small" style={{ maxWidth: 640, marginTop: 32 }}>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        The provider and key <Typography.Text code>web_search</Typography.Text> uses when a
        personality doesn&apos;t bind its own. A personality&apos;s own setting always wins.
      </Typography.Paragraph>
      <ToolSettingsForm
        schema={schema}
        value={values}
        onChange={(next) => {
          setValues(next);
          setDirty(true);
          setTestStatus('idle');
        }}
      />
      <Space style={{ marginTop: 16 }}>
        <Button
          type="primary"
          loading={setDefault.isPending}
          onClick={() =>
            setDefault.mutate({ web_search: values }, { onSuccess: () => setDirty(false) })
          }
        >
          Save
        </Button>
        <Tooltip
          title={
            canTest ? 'Test the bound key against the provider' : 'Pick a provider and key to test'
          }
        >
          <Button onClick={handleTest} loading={testStatus === 'testing'} disabled={!canTest}>
            Test key
          </Button>
        </Tooltip>
        {testStatus === 'ok' && <Tag color="success">Key accepted</Tag>}
        {testStatus === 'error' && <Tag color="error">{testError ?? 'Failed'}</Tag>}
      </Space>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Named secrets — the vault manager. Add / delete provider keys; values are
// masked on read and never round-tripped back to the browser.
// ---------------------------------------------------------------------------

type NamedSecretRow = Awaited<ReturnType<typeof rpc.namedSecrets.list>>['secrets'][number];

function NamedSecretsSection() {
  const listQuery = useNamedSecretsList();
  const deleteMut = useNamedSecretDelete();
  const { modal } = AntApp.useApp();
  const [addOpen, setAddOpen] = useState(false);

  const handleDelete = (row: NamedSecretRow) => {
    modal.confirm({
      title: 'Delete secret',
      content: `Delete "${row.provider}/${row.name}"? Any personality bound to it falls back to the default provider.`,
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: () => deleteMut.mutate({ provider: row.provider, name: row.name }),
    });
  };

  const columns: ColumnsType<NamedSecretRow> = [
    {
      title: 'Provider',
      dataIndex: 'provider',
      key: 'provider',
      render: (provider: string) => <Tag style={{ margin: 0 }}>{provider}</Tag>,
    },
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => (
        <Typography.Text style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}>
          {name}
        </Typography.Text>
      ),
    },
    {
      title: 'Value',
      dataIndex: 'preview',
      key: 'preview',
      render: (preview: string) => (
        <Typography.Text
          type="secondary"
          style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}
        >
          {preview}
        </Typography.Text>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: unknown, row: NamedSecretRow) => (
        <Button size="small" danger onClick={() => handleDelete(row)} loading={deleteMut.isPending}>
          Delete
        </Button>
      ),
    },
  ];

  return (
    <Card
      title="Named secrets"
      size="small"
      style={{ maxWidth: 640, marginTop: 32 }}
      extra={
        <Button size="small" onClick={() => setAddOpen(true)}>
          Add secret
        </Button>
      }
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        Provider keys reusable across personalities. A personality references a secret by name; the
        value stays here and is never shown again.
      </Typography.Paragraph>
      <Table
        size="small"
        rowKey={(r) => `${r.provider}/${r.name}`}
        columns={columns}
        dataSource={listQuery.data?.secrets ?? []}
        loading={listQuery.isLoading}
        pagination={false}
        locale={{ emptyText: 'No secrets yet. Add one to bind it from a personality.' }}
      />
      {addOpen ? (
        <AddSecretModal
          lockProvider={false}
          onClose={() => setAddOpen(false)}
          onCreated={() => setAddOpen(false)}
        />
      ) : null}
    </Card>
  );
}

function ApiKeysSection() {
  const qc = useQueryClient();
  const { notification, modal } = AntApp.useApp();
  const [createOpen, setCreateOpen] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [form] = Form.useForm<CreateKeyForm>();

  const keysQuery = useQuery({
    queryKey: ['apiKeys'],
    queryFn: () => rpc.apiKeys.list({}),
  });

  const createMut = useMutation({
    mutationFn: (input: { name: string; scopes: ApiKeyScope[]; allowedOrigins: string[] }) =>
      rpc.apiKeys.create(input),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['apiKeys'] });
      setCreateOpen(false);
      form.resetFields();
      setRevealedSecret(data.secret);
    },
    onError: (err) =>
      notification.error({
        message: 'Failed to create API key',
        description: (err as Error).message,
      }),
  });

  const revokeMut = useMutation({
    mutationFn: (id: string) => rpc.apiKeys.revoke({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['apiKeys'] });
      notification.success({ message: 'API key revoked', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({
        message: 'Failed to revoke API key',
        description: (err as Error).message,
      }),
  });

  const handleRevoke = (id: string, name: string) => {
    modal.confirm({
      title: 'Revoke API key',
      content: `Revoke "${name}"? External Mission Controls using this key will lose access immediately.`,
      okText: 'Revoke',
      okButtonProps: { danger: true },
      onOk: () => revokeMut.mutate(id),
    });
  };

  const handleCreate = (values: CreateKeyForm) => {
    createMut.mutate({
      name: values.name,
      scopes: values.scopes,
      allowedOrigins: values.origins.filter((o) => o.trim().length > 0),
    });
  };

  const copySecret = async () => {
    if (!revealedSecret) return;
    try {
      await navigator.clipboard.writeText(revealedSecret);
      notification.success({ message: 'Copied to clipboard', placement: 'topRight' });
    } catch {
      notification.error({ message: 'Copy failed — select and copy manually' });
    }
  };

  const columns: ColumnsType<ApiKeyMetadata> = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
    },
    {
      title: 'Prefix',
      dataIndex: 'prefix',
      key: 'prefix',
      render: (prefix: string) => (
        <Typography.Text code style={{ fontSize: 12 }}>
          {prefix}
        </Typography.Text>
      ),
    },
    {
      title: 'Scopes',
      dataIndex: 'scopes',
      key: 'scopes',
      render: (scopes: ApiKeyScope[]) => (
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {scopes.map((s) => (
            <Tag key={s} style={{ margin: 0, fontSize: 11 }}>
              {s}
            </Tag>
          ))}
        </span>
      ),
    },
    {
      title: 'Allowed Origins',
      dataIndex: 'allowedOrigins',
      key: 'allowedOrigins',
      render: (origins: string[]) =>
        origins.length > 0 ? (
          <Tooltip title={origins.join(', ')}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {origins.length} origin{origins.length !== 1 ? 's' : ''}
            </Typography.Text>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            none
          </Typography.Text>
        ),
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (v: string) => (
        <Typography.Text style={{ fontSize: 12 }}>
          {new Date(v).toLocaleDateString()}
        </Typography.Text>
      ),
    },
    {
      title: 'Last Used',
      dataIndex: 'lastUsed',
      key: 'lastUsed',
      render: (v: string | null) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {v ? new Date(v).toLocaleDateString() : 'never'}
        </Typography.Text>
      ),
    },
    {
      title: 'Status',
      key: 'status',
      render: (_: unknown, record: ApiKeyMetadata) =>
        record.revokedAt ? <Tag color="default">Revoked</Tag> : <Tag color="green">Active</Tag>,
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: unknown, record: ApiKeyMetadata) =>
        record.revokedAt ? null : (
          <Button
            size="small"
            danger
            onClick={() => handleRevoke(record.id, record.name)}
            loading={revokeMut.isPending}
          >
            Revoke
          </Button>
        ),
    },
  ];

  const keys = keysQuery.data?.items ?? [];

  return (
    <div style={{ marginTop: 32 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          API Keys
        </Typography.Title>
        <Button type="primary" size="small" onClick={() => setCreateOpen(true)}>
          Create API Key
        </Button>
      </div>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0, marginBottom: 16 }}>
        Bearer tokens for external Mission Controls. Each key is scoped to specific operations and
        origins.
      </Typography.Paragraph>

      <Table<ApiKeyMetadata>
        columns={columns}
        dataSource={keys}
        rowKey="id"
        size="small"
        loading={keysQuery.isLoading}
        pagination={false}
        locale={{ emptyText: 'No API keys created yet.' }}
        rowClassName={(record) => (record.revokedAt ? 'api-key-revoked' : '')}
        scroll={{ x: true }}
      />

      {/* Create modal */}
      <Modal
        title="Create API Key"
        open={createOpen}
        onCancel={() => {
          setCreateOpen(false);
          form.resetFields();
        }}
        onOk={() => form.submit()}
        confirmLoading={createMut.isPending}
        okText="Create"
        destroyOnClose
      >
        <Form<CreateKeyForm>
          form={form}
          layout="vertical"
          onFinish={handleCreate}
          initialValues={{ origins: [''] }}
        >
          <Form.Item
            label="Name"
            name="name"
            rules={[
              { required: true, message: 'Name is required' },
              { max: 100, message: 'Max 100 characters' },
            ]}
          >
            <Input placeholder="e.g. Production frontend" />
          </Form.Item>

          <Form.Item
            label="Scopes"
            name="scopes"
            rules={[{ required: true, message: 'Select at least one scope' }]}
          >
            <Checkbox.Group
              options={ALL_SCOPES.map((s) => ({
                value: s,
                label: SCOPE_HINTS[s] ? (
                  <>
                    {s}{' '}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      — {SCOPE_HINTS[s]}
                    </Typography.Text>
                  </>
                ) : (
                  s
                ),
              }))}
              style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
            />
          </Form.Item>

          <Form.Item label="Allowed Origins">
            <Form.List
              name="origins"
              rules={[
                {
                  validator: async (_, origins: string[]) => {
                    const filled = (origins ?? []).filter((o) => o.trim().length > 0);
                    if (filled.length === 0) {
                      throw new Error('At least one origin is required');
                    }
                  },
                },
              ]}
            >
              {(fields, { add, remove }, { errors }) => (
                <>
                  {fields.map((field) => (
                    <Space
                      key={field.key}
                      align="start"
                      style={{ display: 'flex', marginBottom: 8 }}
                    >
                      <Form.Item
                        {...field}
                        validateTrigger={['onChange', 'onBlur']}
                        rules={[
                          {
                            validator: async (_, value: string) => {
                              if (!value || value.trim().length === 0) return;
                              try {
                                const u = new URL(value);
                                if (u.origin !== value) {
                                  throw new Error(
                                    'Must be a valid origin (scheme + host, no path)',
                                  );
                                }
                              } catch {
                                throw new Error(
                                  'Must be a valid origin (e.g. https://example.com)',
                                );
                              }
                            },
                          },
                        ]}
                        noStyle
                      >
                        <Input placeholder="https://example.com" style={{ width: 300 }} />
                      </Form.Item>
                      {fields.length > 1 ? (
                        <Button size="small" onClick={() => remove(field.name)}>
                          Remove
                        </Button>
                      ) : null}
                    </Space>
                  ))}
                  <Form.Item>
                    <Button type="dashed" onClick={() => add('')} style={{ width: 300 }}>
                      Add origin
                    </Button>
                    <Form.ErrorList errors={errors} />
                  </Form.Item>
                </>
              )}
            </Form.List>
          </Form.Item>
        </Form>
      </Modal>

      {/* Secret reveal modal */}
      <Modal
        title="Copy your API key"
        open={revealedSecret !== null}
        onCancel={() => setRevealedSecret(null)}
        footer={[
          <Button key="copy" type="primary" onClick={copySecret}>
            Copy to clipboard
          </Button>,
          <Button key="close" onClick={() => setRevealedSecret(null)}>
            Done
          </Button>,
        ]}
        closable
      >
        <Typography.Paragraph type="warning" style={{ marginBottom: 12 }}>
          This secret will not be shown again. Copy it now and store it securely.
        </Typography.Paragraph>
        <Input.TextArea
          value={revealedSecret ?? ''}
          readOnly
          autoSize
          style={{ fontFamily: 'Geist Mono, monospace', fontSize: 13 }}
        />
      </Modal>

      <style>{`
        .api-key-revoked {
          opacity: 0.5;
        }
      `}</style>
    </div>
  );
}

function ModelRoutingView({ routing }: { routing: Record<string, string> }) {
  const entries = Object.entries(routing);
  if (entries.length === 0) {
    return <Typography.Text type="secondary">No per-personality overrides set.</Typography.Text>;
  }
  return (
    <ul style={{ margin: 0, paddingLeft: 16 }}>
      {entries.map(([personality, model]) => (
        <li key={personality} style={{ fontSize: 13, color: 'var(--ethos-text)' }}>
          <Typography.Text code>{personality}</Typography.Text>
          {' → '}
          <Typography.Text code>{model}</Typography.Text>
        </li>
      ))}
    </ul>
  );
}
