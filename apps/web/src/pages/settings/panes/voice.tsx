// Voice — how it talks, speech-to-text, text-to-speech, realtime, barge-in,
// trunk, LiveKit, numbers, hardening, wake routes, channels that speak, voice
// notes, call appearance. Moved verbatim from `Settings.tsx` (§4.2 row 9 plus
// `VoiceTelephonySections` and `WakePanel`). Phase 5a converted how it talks /
// speech-to-text / text-to-speech / realtime / barge-in / voice notes / call
// appearance off `Card` onto `SettingRow` / `SectionHeading`; Phase 5b (this
// change) converts trunk, LiveKit, numbers, hardening, wake routes and
// channels that speak the same way, and moves the outbound egress gate
// (`voiceEgressGate` / `voiceTrustedPlugins`) into Hardening — "Inbound
// hardening" was a lie once an outbound control had to live there too.
//
// `voice.artifacts.*` belongs in Data & retention and deliberately stays here
// for this change (D12) — the move is scheduled, not forgotten.

import { useQuery } from '@tanstack/react-query';
import {
  Button,
  Form,
  Input,
  InputNumber,
  Select,
  Slider,
  Space,
  Spin,
  Switch,
  Table,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { blobToBase64 } from '../../../components/chat/VoiceButton';
import { DEFAULT_VOICE_TUNING } from '../../../features/voice/batch-voice-call-client';
import { WakePanel, WakeSettingsReadout } from '../../../features/voice/WakePanel';
import { useVoiceRecorder } from '../../../hooks/useVoiceRecorder';
import {
  COMMAND_STT_EXAMPLE,
  COMMAND_STT_PLACEHOLDERS,
  COMMAND_TTS_EXAMPLE,
  COMMAND_TTS_PLACEHOLDERS,
  validateCommandTemplate,
} from '../../../lib/voice-command-template';
import { rpc } from '../../../rpc';
import { ROW_BOX_STYLE, RowLabel } from '../components/primitives';
import { SectionHeading } from '../components/section-heading';
import { SettingRow } from '../components/setting-row';
import { SettingTable } from '../components/setting-table';
import { StatusCallout } from '../components/status-callout';
import { type ConfigGetData, type PersonalityOption, RECORD_KEY_RE } from '../lib/config-types';
import { deliveryAge } from '../lib/deliveries';
import type { FormShape } from '../lib/form-shape';
import { nextRowId } from '../lib/row-id';
import type { VoiceBotRow } from '../lib/voice-bots';
import { firstCallInvitation } from '../lib/voice-bots';
import {
  AUDIO_FORMATS,
  CALL_ACCENT_CUSTOM,
  CALL_ACCENT_PRESETS,
  CALL_STYLE_OPTIONS,
  VOICE_CHANNEL_LABELS,
  VOICE_CHANNELS,
} from '../lib/voice-options';
import {
  REALTIME_ROSTER_SPEC,
  STT_PROVIDER_OPTIONS,
  STT_ROSTER_SPEC,
  TTS_PROVIDER_OPTIONS,
  TTS_ROSTER_SPEC,
  type VoiceProviderRow,
  type VoiceRosterKindSpec,
} from '../lib/voice-roster';
import {
  BARGE_IN_SURFACE_LABELS,
  BARGE_IN_SURFACES,
  TRUNK_CODECS,
  TRUNK_PROVIDERS,
} from '../lib/voice-telephony';
import { useSettingsPane } from '../pane-context';

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

/** Antd rule wrapper — the field only renders for a `command-*` provider, so an
 *  unconditional rule here IS the "required when that provider is selected" one. */
function commandTemplateValidator(_rule: unknown, value: string): Promise<void> {
  const error = validateCommandTemplate(value);
  return error ? Promise.reject(new Error(error)) : Promise.resolve();
}

// The browser's own local VAD, used ONLY by the batch-fallback client
// (`batch-voice-call-client.ts`) when this browser can't stream audio. Since
// L1, the streaming pipeline lane's barge-in/endpointing is tuned by the
// generic `voice.bargeIn.browser` row above instead (`BARGE_IN_SURFACES`) —
// three of the five `display.voice_*` sliders that used to live here
// (`voiceEndpointSilenceMs`, `voiceBargeThreshold`, `voiceBargeSustainMs`)
// were that row's only tuner and are now redundant with it, so they were
// dropped from this box. `voiceSpeechThreshold`/`voiceSpeechMinMs` stay:
// they tune the fallback client's own speech detector, which the barge-in row
// does not reach. `name` is the FormShape/config field, `defaultKey` maps to
// DEFAULT_VOICE_TUNING for the reset affordance, and the range/step mirror
// the Zod bounds on ConfigUpdateInput. `unit` renders the slider tooltip so
// the raw number reads clearly.
const VOICE_TUNING_CONTROLS: Array<{
  name: 'voiceSpeechThreshold' | 'voiceSpeechMinMs';
  defaultKey: keyof typeof DEFAULT_VOICE_TUNING;
  label: string;
  extra: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}> = [
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
  'voiceSttCommand',
];
const TTS_TEST_DIRTY_FIELDS: (keyof FormShape)[] = [
  'voiceTtsProvider',
  'voiceTtsModel',
  'voiceTtsBaseUrl',
  'voiceTtsVoice',
  'voiceTtsApiKey',
  'voiceTtsCommand',
];

// ---------------------------------------------------------------------------
// Delivery status — the operator's window onto the delivery-obligation ledger.
//
// It lives in the Voice card because the voice split is what makes it
// actionable here: an artifact-backed reply is the one whose loss is invisible
// otherwise. Read-only by construction — there is no RPC that re-sends, and a
// settings page must not be able to re-send someone's message.
// ---------------------------------------------------------------------------

type DeliverySummary = Awaited<ReturnType<typeof rpc.deliveries.summary>>;
type DeliveryObligation = DeliverySummary['recent'][number];

const DELIVERY_STATUSES = ['pending', 'redelivering', 'delivered', 'abandoned'] as const;

/**
 * `redelivering` is the ledger's word for a claimed obligation mid-sweep. The
 * plan's state table calls what the user sees `redelivered`, because by the
 * time it is on screen the sweep is what happened to it.
 */
const DELIVERY_STATUS_LABELS: Record<(typeof DELIVERY_STATUSES)[number], string> = {
  pending: 'pending',
  redelivering: 'redelivered',
  delivered: 'delivered',
  abandoned: 'abandoned',
};

const DELIVERY_COLUMNS: ColumnsType<DeliveryObligation> = [
  {
    title: 'Platform',
    dataIndex: 'platform',
    render: (platform: string) => <span className="voice-delivery-mono">{platform}</span>,
  },
  {
    title: 'Kind',
    key: 'kind',
    render: (_: unknown, row: DeliveryObligation) => (
      <span className="voice-delivery-mono">
        {row.mediaFormat ? `${row.kind} · ${row.mediaFormat}` : row.kind}
      </span>
    ),
  },
  {
    title: 'Status',
    dataIndex: 'status',
    render: (status: DeliveryObligation['status']) => (
      <span className="voice-delivery-mono">{DELIVERY_STATUS_LABELS[status]}</span>
    ),
  },
  {
    title: 'Age',
    dataIndex: 'createdAt',
    render: (createdAt: number) => (
      <span className="voice-delivery-mono">{deliveryAge(createdAt, Date.now())}</span>
    ),
  },
  { title: 'Reply', dataIndex: 'content', ellipsis: true },
];

function VoiceDeliveryStatus() {
  const summaryQuery = useQuery({
    queryKey: ['deliveries', 'summary'],
    queryFn: () => rpc.deliveries.summary({ limit: 20 }),
  });

  if (summaryQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 60 }}>
        <Spin />
      </div>
    );
  }
  const data = summaryQuery.data;
  if (!data) {
    return (
      <Typography.Text type="secondary">
        Delivery ledger unreadable — {(summaryQuery.error as Error | null)?.message ?? 'no data'}.
      </Typography.Text>
    );
  }

  const total = DELIVERY_STATUSES.reduce((sum, s) => sum + data.stats[s], 0);
  if (total === 0 && data.recent.length === 0) {
    return (
      <Typography.Text type="secondary">
        No outbound obligations recorded. The ledger fills as the gateway sends channel replies —
        messages in this web chat are not obligations, so they never appear here.
      </Typography.Text>
    );
  }

  return (
    <>
      <div className="voice-delivery-stats">
        {DELIVERY_STATUSES.map((status) => (
          <div key={status} className="voice-delivery-stat">
            <span className="voice-delivery-mono">{DELIVERY_STATUS_LABELS[status]}</span>
            <span className="voice-delivery-count">{data.stats[status]}</span>
            <span className="voice-delivery-mono voice-delivery-split">
              voice {data.stats.voice[status]}
            </span>
          </div>
        ))}
      </div>
      {data.recent.length > 0 ? (
        <Table<DeliveryObligation>
          size="small"
          rowKey="id"
          pagination={false}
          columns={DELIVERY_COLUMNS}
          dataSource={data.recent}
          style={{ marginTop: 12 }}
        />
      ) : null}
    </>
  );
}

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

export function VoicePane() {
  const {
    form,
    config: configData,
    personalities,
    voiceSttProviderRows,
    setVoiceSttProviderRows,
    voiceTtsProviderRows,
    setVoiceTtsProviderRows,
    voiceRealtimeProviderRows,
    setVoiceRealtimeProviderRows,
    voiceBotRows,
    setVoiceBotRows,
  } = useSettingsPane();

  return (
    <>
      <SectionHeading id="call-appearance">call appearance</SectionHeading>
      <SettingRow
        label="Voice enabled"
        formName="voiceEnabled"
        help="Enable the voice recording button in the chat bar."
      >
        <Form.Item name="voiceEnabled" valuePropName="checked" style={{ marginBottom: 0 }}>
          <Switch checkedChildren="On" unCheckedChildren="Off" />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="Processing chime"
        formName="voiceChime"
        help="Play a short sound while the agent is thinking (after you stop speaking)."
      >
        <Form.Item name="voiceChime" valuePropName="checked" style={{ marginBottom: 0 }}>
          <Switch />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="Treatment"
        formName="callStyle"
        help="How the Call Stage draws the agent. All three follow the same voice level; only the shape differs. Personality lets each agent use the shape it declares, or one derived from its name — picking a treatment here pins it for every agent that has not chosen one."
      >
        <Form.Item name="callStyle" style={{ marginBottom: 0 }}>
          <Select options={CALL_STYLE_OPTIONS} />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="Color"
        formName="callAccent"
        help="What the overlay is drawn in while the agent speaks. Listening is always the red mic color."
      >
        <Form.Item name="callAccent" style={{ marginBottom: 0 }}>
          <Select
            options={[...CALL_ACCENT_PRESETS, { value: CALL_ACCENT_CUSTOM, label: 'Custom hex…' }]}
          />
        </Form.Item>
      </SettingRow>
      <Form.Item noStyle shouldUpdate={(prev, cur) => prev.callAccent !== cur.callAccent}>
        {({ getFieldValue }) =>
          getFieldValue('callAccent') === CALL_ACCENT_CUSTOM ? (
            <SettingRow
              label="Custom color"
              formName="callAccentCustom"
              help="Six-digit hex. Anything else falls back to the personality accent."
            >
              <Form.Item
                name="callAccentCustom"
                rules={[
                  {
                    pattern: /^#[0-9a-fA-F]{6}$/,
                    message: 'Six-digit hex, e.g. #4ADE80.',
                  },
                ]}
                style={{ marginBottom: 0 }}
              >
                <Input placeholder="#4ADE80" />
              </Form.Item>
            </SettingRow>
          ) : null
        }
      </Form.Item>
      <div style={{ marginBottom: 16 }}>
        <Typography.Text strong style={{ fontSize: 13 }}>
          Advanced wake tuning
        </Typography.Text>
        <WakeSettingsReadout />
      </div>
      <Form.Item noStyle shouldUpdate={(prev, cur) => prev.voiceEnabled !== cur.voiceEnabled}>
        {({ getFieldValue }) =>
          getFieldValue('voiceEnabled') ? (
            <>
              <SectionHeading id="how-it-talks">how it talks</SectionHeading>
              <SettingRow
                label="How the agent talks"
                formName="voiceTier"
                help="Pipeline transcribes you, thinks, then speaks — it can run entirely on this machine with local speech-to-text and text-to-speech, so no audio has to leave it. Realtime hands the whole conversation to one hosted session, which answers faster and can be interrupted mid-sentence, but needs an OpenAI Realtime or Gemini Live key below."
              >
                <Form.Item name="voiceTier" style={{ marginBottom: 0 }}>
                  <Select
                    allowClear
                    placeholder="Automatic — realtime when one is configured"
                    options={[
                      { label: 'Pipeline — private, works offline', value: 'pipeline' },
                      { label: 'Realtime — fastest, hosted', value: 'realtime' },
                    ]}
                  />
                </Form.Item>
              </SettingRow>
              <SectionHeading id="speech-to-text">speech-to-text</SectionHeading>
              <SettingRow
                label="Default provider (STT)"
                formName="voiceProvider"
                help="Speech-to-text engine for transcribing what you say. This is the default entry — a personality that names no engine of its own is transcribed through it."
              >
                <Form.Item
                  name="voiceProvider"
                  rules={[{ required: true, message: 'Select a provider to enable voice' }]}
                  style={{ marginBottom: 0 }}
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
                    options={STT_PROVIDER_OPTIONS}
                  />
                </Form.Item>
              </SettingRow>
              <Form.Item
                noStyle
                shouldUpdate={(prev, cur) => prev.voiceProvider !== cur.voiceProvider}
              >
                {({ getFieldValue: getStt }) => (
                  <>
                    {getStt('voiceProvider') === 'local-stt' ? (
                      <SettingRow
                        label="STT Base URL"
                        formName="voiceBaseUrl"
                        help="Endpoint for your local (OpenAI-compatible) server. Leave blank for the default."
                      >
                        <Form.Item name="voiceBaseUrl" style={{ marginBottom: 0 }}>
                          <Input placeholder="http://localhost:8000/v1" />
                        </Form.Item>
                      </SettingRow>
                    ) : null}
                    {getStt('voiceProvider') === 'command-stt' ? (
                      <SettingRow
                        label="STT command"
                        formName="voiceSttCommand"
                        help={`Shell template run once per utterance. Placeholders: ${COMMAND_STT_PLACEHOLDERS}. {input_path} and {output_path} are required.`}
                      >
                        <Form.Item
                          name="voiceSttCommand"
                          rules={[{ validator: commandTemplateValidator }]}
                          style={{ marginBottom: 0 }}
                        >
                          <Input placeholder={COMMAND_STT_EXAMPLE} />
                        </Form.Item>
                      </SettingRow>
                    ) : null}
                  </>
                )}
              </Form.Item>
              <SettingRow
                label="STT Model"
                formName="voiceModel"
                help="Free-form — server-specific (e.g. Systran/faster-whisper-large-v3)."
              >
                <Form.Item name="voiceModel" style={{ marginBottom: 0 }}>
                  <Input placeholder="whisper-large-v3" />
                </Form.Item>
              </SettingRow>
              <SettingRow
                label="STT API key (optional)"
                formName="voiceApiKey"
                help={
                  configData?.voiceApiKeyPreview
                    ? `Current: ${configData.voiceApiKeyPreview}`
                    : 'Optional — leave blank for local servers that need no key.'
                }
              >
                <Form.Item name="voiceApiKey" style={{ marginBottom: 0 }}>
                  <Input.Password placeholder="Enter API key..." />
                </Form.Item>
              </SettingRow>
              <SettingRow
                label="STT timeout (seconds)"
                formName="voiceSttTimeoutMs"
                help="How long one transcription may take. Blank = provider default."
              >
                <Form.Item name="voiceSttTimeoutMs" style={{ marginBottom: 0 }}>
                  <InputNumber min={1} max={3600} step={1} placeholder="120" />
                </Form.Item>
              </SettingRow>
              <Form.Item
                noStyle
                shouldUpdate={(prev, cur) => STT_TEST_DIRTY_FIELDS.some((k) => prev[k] !== cur[k])}
              >
                {({ getFieldValue: getStt }) => {
                  const saved = configData;
                  const dirty =
                    (getStt('voiceProvider') ?? '') !== (saved?.voiceProvider ?? '') ||
                    (getStt('voiceModel') ?? '') !== (saved?.voiceModel ?? '') ||
                    (getStt('voiceBaseUrl') ?? '') !== (saved?.voiceBaseUrl ?? '') ||
                    (getStt('voiceSttCommand') ?? '') !== (saved?.voiceSttCommand ?? '') ||
                    Boolean(getStt('voiceApiKey'));
                  return <SttTest disabled={!saved?.voiceProvider} dirty={dirty} />;
                }}
              </Form.Item>
              <VoiceProviderRoster
                spec={STT_ROSTER_SPEC}
                rows={voiceSttProviderRows}
                setRows={setVoiceSttProviderRows}
              />
              <SectionHeading id="text-to-speech">text-to-speech</SectionHeading>
              <SettingRow
                label="Default provider (TTS)"
                formName="voiceTtsProvider"
                help="Text-to-speech provider for reading agent responses aloud. This is the default entry — a personality that names no provider of its own speaks through it."
              >
                <Form.Item name="voiceTtsProvider" style={{ marginBottom: 0 }}>
                  <Select
                    allowClear
                    placeholder="Select a TTS provider..."
                    onChange={(value: string | undefined) => {
                      if (!value) return;
                      const d = TTS_PROVIDER_DEFAULTS[value];
                      if (!d) return;
                      const patch: Partial<FormShape> = {};
                      if (!form.getFieldValue('voiceTtsBaseUrl')) patch.voiceTtsBaseUrl = d.baseUrl;
                      if (!form.getFieldValue('voiceTtsModel')) patch.voiceTtsModel = d.model;
                      if (Object.keys(patch).length > 0) form.setFieldsValue(patch);
                    }}
                    options={TTS_PROVIDER_OPTIONS}
                  />
                </Form.Item>
              </SettingRow>
              <Form.Item
                noStyle
                shouldUpdate={(prev, cur) => prev.voiceTtsProvider !== cur.voiceTtsProvider}
              >
                {({ getFieldValue: getTts }) =>
                  getTts('voiceTtsProvider') ? (
                    <>
                      {getTts('voiceTtsProvider') === 'local-tts' ? (
                        <SettingRow
                          label="TTS Base URL"
                          formName="voiceTtsBaseUrl"
                          help="Endpoint for your local (OpenAI-compatible) server. Leave blank for the default."
                        >
                          <Form.Item name="voiceTtsBaseUrl" style={{ marginBottom: 0 }}>
                            <Input placeholder="http://localhost:8880/v1" />
                          </Form.Item>
                        </SettingRow>
                      ) : null}
                      {getTts('voiceTtsProvider') === 'command-tts' ? (
                        <SettingRow
                          label="TTS command"
                          formName="voiceTtsCommand"
                          help={`Shell template run once per synthesis. Placeholders: ${COMMAND_TTS_PLACEHOLDERS}. {input_path} and {output_path} are required; set the audio format below to match what the command writes.`}
                        >
                          <Form.Item
                            name="voiceTtsCommand"
                            rules={[{ validator: commandTemplateValidator }]}
                            style={{ marginBottom: 0 }}
                          >
                            <Input placeholder={COMMAND_TTS_EXAMPLE} />
                          </Form.Item>
                        </SettingRow>
                      ) : null}
                      <SettingRow
                        label="TTS Model"
                        formName="voiceTtsModel"
                        help="Free-form — server-specific (e.g. kokoro, tts-1)."
                      >
                        <Form.Item name="voiceTtsModel" style={{ marginBottom: 0 }}>
                          <Input placeholder="kokoro" />
                        </Form.Item>
                      </SettingRow>
                      <SettingRow
                        label="TTS API key (optional)"
                        formName="voiceTtsApiKey"
                        help={
                          configData?.voiceTtsApiKeyPreview
                            ? `Current: ${configData.voiceTtsApiKeyPreview}`
                            : 'Optional — leave blank for local servers that need no key.'
                        }
                      >
                        <Form.Item name="voiceTtsApiKey" style={{ marginBottom: 0 }}>
                          <Input.Password placeholder="Enter API key..." />
                        </Form.Item>
                      </SettingRow>
                      <SettingRow
                        label="Voice ID"
                        formName="voiceTtsVoice"
                        help="Free-form — every server names voices differently (e.g. Kokoro af_bella, OpenAI nova)."
                      >
                        <Form.Item name="voiceTtsVoice" style={{ marginBottom: 0 }}>
                          <Input placeholder="e.g. af_bella" />
                        </Form.Item>
                      </SettingRow>
                      <SettingRow
                        label="TTS audio format"
                        formName="voiceTtsOutputFormat"
                        help="Container the provider is asked for. Blank = the provider's own default."
                      >
                        <Form.Item name="voiceTtsOutputFormat" style={{ marginBottom: 0 }}>
                          <Select
                            allowClear
                            placeholder="Provider default"
                            options={AUDIO_FORMATS.map((f) => ({ label: f, value: f }))}
                          />
                        </Form.Item>
                      </SettingRow>
                      <SettingRow
                        label="TTS timeout (seconds)"
                        formName="voiceTtsTimeoutMs"
                        help="How long one synthesis request may take. Blank = provider default."
                      >
                        <Form.Item name="voiceTtsTimeoutMs" style={{ marginBottom: 0 }}>
                          <InputNumber min={1} max={3600} step={1} placeholder="120" />
                        </Form.Item>
                      </SettingRow>
                      <SettingRow
                        label="TTS max text length"
                        formName="voiceTtsMaxTextLength"
                        help="Characters per synthesis request; longer replies are split or refused by the provider."
                      >
                        <Form.Item name="voiceTtsMaxTextLength" style={{ marginBottom: 0 }}>
                          <InputNumber min={100} max={100000} step={100} placeholder="4096" />
                        </Form.Item>
                      </SettingRow>
                      <Form.Item
                        noStyle
                        shouldUpdate={(prev, cur) =>
                          TTS_TEST_DIRTY_FIELDS.some((k) => prev[k] !== cur[k])
                        }
                      >
                        {({ getFieldValue: getTtsField }) => {
                          const saved = configData;
                          const dirty =
                            (getTtsField('voiceTtsProvider') ?? '') !==
                              (saved?.voiceTtsProvider ?? '') ||
                            (getTtsField('voiceTtsModel') ?? '') !== (saved?.voiceTtsModel ?? '') ||
                            (getTtsField('voiceTtsBaseUrl') ?? '') !==
                              (saved?.voiceTtsBaseUrl ?? '') ||
                            (getTtsField('voiceTtsVoice') ?? '') !== (saved?.voiceTtsVoice ?? '') ||
                            (getTtsField('voiceTtsCommand') ?? '') !==
                              (saved?.voiceTtsCommand ?? '') ||
                            Boolean(getTtsField('voiceTtsApiKey'));
                          return <TtsTest disabled={!saved?.voiceTtsProvider} dirty={dirty} />;
                        }}
                      </Form.Item>
                    </>
                  ) : null
                }
              </Form.Item>
              <VoiceProviderRoster
                spec={TTS_ROSTER_SPEC}
                rows={voiceTtsProviderRows}
                setRows={setVoiceTtsProviderRows}
              />
              <SectionHeading id="realtime">realtime</SectionHeading>
              <SettingRow
                label="Default provider (realtime)"
                formName="voiceRealtimeDefault"
                help={
                  voiceRealtimeProviderRows.length === 0
                    ? 'Add a realtime provider below, then choose which one everything uses by default.'
                    : 'Which of the providers below a personality gets when it names none of its own.'
                }
              >
                <Form.Item name="voiceRealtimeDefault" style={{ marginBottom: 0 }}>
                  <Select
                    allowClear
                    disabled={voiceRealtimeProviderRows.length === 0}
                    placeholder={
                      voiceRealtimeProviderRows.length === 0
                        ? 'No realtime providers yet'
                        : 'Select a provider...'
                    }
                    options={voiceRealtimeProviderRows
                      .filter((r) => r.name.trim())
                      .map((r) => ({ label: r.name.trim(), value: r.name.trim() }))}
                  />
                </Form.Item>
              </SettingRow>
              <VoiceProviderRoster
                spec={REALTIME_ROSTER_SPEC}
                rows={voiceRealtimeProviderRows}
                setRows={setVoiceRealtimeProviderRows}
              />
              <SettingRow
                label="Stop a call at (USD)"
                formName="voiceRealtimeSessionBudgetUsd"
                help="One realtime conversation ends once it has cost this much, using the per-minute rate on the provider above. Blank = no limit."
              >
                <Form.Item name="voiceRealtimeSessionBudgetUsd" style={{ marginBottom: 0 }}>
                  <InputNumber min={0.01} max={10000} step={0.5} placeholder="No limit" />
                </Form.Item>
              </SettingRow>
            </>
          ) : null
        }
      </Form.Item>
      <SectionHeading id="barge-in">barge-in</SectionHeading>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 13 }}>
        When interrupting the agent counts as interrupting it. A phone line, a satellite across a
        room, and this browser hear very different noise floors, so each is tuned on its own — and a
        surface left blank is untuned, which is not the same as tuned to the defaults. A satellite
        ends an utterance on a count of silent frames, not a duration, so its Silence (ms) is not
        read.
      </Typography.Paragraph>
      {/* voiceBargeIn[surface] — a per-connection tuner. `browser` reaches this
          deployment's normal talk mode (`VoiceSession`, the same orchestrator
          `call`/`satellite` use). The separate box further down tunes only the
          record-and-send fallback for browsers that can't stream audio. */}
      {BARGE_IN_SURFACES.map((surface) => (
        <div key={surface} style={ROW_BOX_STYLE}>
          <Typography.Text strong style={{ fontSize: 13 }}>
            {BARGE_IN_SURFACE_LABELS[surface]}
          </Typography.Text>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <div style={{ flex: 1 }}>
              <RowLabel>Energy threshold</RowLabel>
              <Form.Item name={['voiceBargeIn', surface, 'energyThreshold']} noStyle>
                <InputNumber
                  size="small"
                  style={{ width: '100%' }}
                  min={0.001}
                  max={1}
                  step={0.01}
                  placeholder="Untuned"
                />
              </Form.Item>
            </div>
            <div style={{ flex: 1 }}>
              <RowLabel>Min speech (ms)</RowLabel>
              <Form.Item name={['voiceBargeIn', surface, 'minSpeechMs']} noStyle>
                <InputNumber
                  size="small"
                  style={{ width: '100%' }}
                  min={1}
                  max={10000}
                  step={10}
                  placeholder="Untuned"
                />
              </Form.Item>
            </div>
            <div style={{ flex: 1 }}>
              <RowLabel>Silence (ms)</RowLabel>
              <Form.Item name={['voiceBargeIn', surface, 'silenceMs']} noStyle>
                <InputNumber
                  size="small"
                  style={{ width: '100%' }}
                  min={1}
                  max={10000}
                  step={10}
                  placeholder="Untuned"
                />
              </Form.Item>
              {/* A satellite ends an utterance on a count of silent frames, not
                  a duration (see the paragraph above) — this is that fact's
                  per-field marker, matching the other four `unread` keys'
                  callout (§7). The `call` surface's Silence IS read. */}
              {surface === 'satellite' ? <StatusCallout kind="unread" /> : null}
            </div>
          </div>
        </div>
      ))}
      <div style={ROW_BOX_STYLE}>
        <Typography.Text strong style={{ fontSize: 13 }}>
          Browser microphone (no-stream fallback)
        </Typography.Text>
        <Typography.Paragraph
          type="secondary"
          style={{ marginTop: 4, marginBottom: 8, fontSize: 13 }}
        >
          Only used when this browser can't stream audio and falls back to record-and-send — the
          Browser row above tunes the normal case.
        </Typography.Paragraph>
        {/* settings-index-group: voice-tuning — `name={c.name}` is
            opaque to the source scan, so the group id says which
            `SETTINGS_INDEX` entries this site renders (T6). */}
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
                VOICE_TUNING_CONTROLS.map((c) => [c.name, DEFAULT_VOICE_TUNING[c.defaultKey]]),
              ),
            )
          }
        >
          Reset to defaults
        </Button>
      </div>
      <SectionHeading id="channels-that-speak">channels that speak</SectionHeading>
      <SettingRow
        label="Voice replies on channels"
        formName="voiceDefaultMode"
        help="Where a new conversation starts. Off never speaks; Mirror inbound speaks when it was spoken to; All speaks every reply. `/voice <mode>` still overrides it per conversation."
      >
        <Form.Item name="voiceDefaultMode" style={{ marginBottom: 0 }}>
          <Select
            allowClear
            placeholder="Mirror inbound (default)"
            options={[
              { label: 'Off — never speak', value: 'off' },
              { label: 'Mirror inbound — speak when spoken to', value: 'mirror_inbound' },
              { label: 'All — speak every reply', value: 'all' },
            ]}
          />
        </Form.Item>
      </SettingRow>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 13 }}>
        A channel switched off never speaks, whatever mode the conversation is in — turning a
        channel off is a deployment decision and outranks <code>/voice all</code> in one of its
        lanes. A channel left on inherits the default above.
      </Typography.Paragraph>
      {VOICE_CHANNELS.map((channel) => (
        <SettingRow
          key={channel}
          label={VOICE_CHANNEL_LABELS[channel]}
          formName={`voiceChannelTtsOut.${channel}`}
        >
          <Form.Item
            name={['voiceChannelTtsOut', channel]}
            valuePropName="checked"
            style={{ marginBottom: 0 }}
          >
            <Switch />
          </Form.Item>
        </SettingRow>
      ))}
      <SectionHeading id="voice-notes">voice notes</SectionHeading>
      <SettingRow
        label="ffmpeg path"
        formName="voiceTranscodeFfmpegPath"
        help="ffmpeg is what re-containers a synthesized reply into the format each platform renders as a voice bubble instead of a file attachment. Without it Ethos can only send the formats the TTS provider already produces. Blank = whatever `ffmpeg` resolves to on PATH."
      >
        <Form.Item name="voiceTranscodeFfmpegPath" style={{ marginBottom: 0 }}>
          <Input placeholder="ffmpeg" />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="Bitrate (kbps)"
        formName="voiceTranscodeBitrateKbps"
        help="Target bitrate for the transcoded voice note. Blank = 32, which is speech-grade."
      >
        <Form.Item name="voiceTranscodeBitrateKbps" style={{ marginBottom: 0 }}>
          <InputNumber min={8} max={320} step={8} placeholder="32" />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="Transcode timeout (seconds)"
        formName="voiceTranscodeTimeoutSec"
        help="Budget for one ffmpeg run. Blank = 30."
      >
        <Form.Item name="voiceTranscodeTimeoutSec" style={{ marginBottom: 0 }}>
          <InputNumber min={1} max={600} placeholder="30" />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="Abandon after (days)"
        formName="voiceArtifactAbandonAfterDays"
        help="An artifact is deleted the moment its delivery is confirmed. This bounds the ones that never are: give up on an undelivered voice note after this long and delete it. Blank = 7."
      >
        <Form.Item name="voiceArtifactAbandonAfterDays" style={{ marginBottom: 0 }}>
          <InputNumber min={1} max={365} placeholder="7" />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="Artifact directory cap (MiB)"
        formName="voiceArtifactMaxTotalMb"
        help="Oldest-first eviction once the stored artifacts exceed this — the backstop for when neither delivery nor abandonment has fired. Blank = 512."
      >
        <Form.Item name="voiceArtifactMaxTotalMb" style={{ marginBottom: 0 }}>
          <InputNumber min={1} max={102400} placeholder="512" />
        </Form.Item>
      </SettingRow>
      {/* OQ7 (plan §12): folded into voice notes, per the plan's own tentative
          resolution — still an open owner question, not a settled decision. */}
      <VoiceDeliveryStatus />
      {configData ? (
        <VoiceTelephonySections
          config={configData}
          personalities={personalities}
          botRows={voiceBotRows}
          setBotRows={setVoiceBotRows}
        />
      ) : null}
      <SectionHeading id="wake-routes">wake routes</SectionHeading>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 13 }}>
        Which phrase wakes which personality, on every connected satellite. Saving pushes the table
        to them without a restart. Below the routes: the microphones themselves, and whether each is
        actually listening.
      </Typography.Paragraph>
      <WakePanel />
    </>
  );
}

// ---------------------------------------------------------------------------
// Automation — quick commands + channel toolsets (full-replacement records)
// plus the nightly-pass / weekly-digest schedule fields.
// ---------------------------------------------------------------------------

/**
 * A named voice roster (`voice.<tts|stt|realtime>.providers.<name>.*`) — extra
 * providers a personality can pick between by name, alongside the default above.
 *
 * For STT and TTS the rows carry the same fields as the default entry of that
 * kind, because a roster entry IS one; the realtime roster has no `auxiliary.*`
 * default, so its "default" is a select naming one of these rows. Saving
 * replaces the whole roster, so removing a row deletes the entry (and its stored
 * key); an untouched API-key field keeps the stored key, because the browser is
 * never handed it to type back.
 *
 * ONE component for all three kinds, parameterised by {@link VoiceRosterKindSpec}.
 * Forking it per kind would let the ear, the voice and the live session drift
 * apart in the exact surface whose job is to show they are the same shape.
 */
function VoiceProviderRoster({
  spec,
  rows,
  setRows,
}: {
  spec: VoiceRosterKindSpec;
  rows: VoiceProviderRow[];
  setRows: Dispatch<SetStateAction<VoiceProviderRow[]>>;
}) {
  const update = (index: number, patch: Partial<VoiceProviderRow>) =>
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const remove = (index: number) => setRows((prev) => prev.filter((_, i) => i !== index));
  const add = () =>
    setRows((prev) => [
      ...prev,
      {
        _id: nextRowId(),
        name: '',
        provider: spec.defaultProvider,
        model: '',
        apiKey: '',
        apiKeyPreview: null,
        voice: '',
        baseUrl: '',
        command: '',
        outputFormat: '',
        timeout: null,
        maxTextLength: null,
        costPerMinuteUsd: null,
      },
    ]);

  return (
    <div style={{ marginBottom: 16 }}>
      <Typography.Text strong style={{ fontSize: 13 }}>
        {spec.rosterHeading}
      </Typography.Text>
      <Typography.Paragraph type="secondary" style={{ marginTop: 4 }}>
        {spec.blurb} Each name becomes a {spec.configKey}.&lt;name&gt; key. Saving replaces the
        whole list.
      </Typography.Paragraph>
      <SettingTable<VoiceProviderRow>
        rowKey={(row) => row._id}
        rows={rows}
        addLabel={spec.addLabel}
        onAdd={add}
        columns={[
          {
            key: 'name',
            header: 'Name',
            render: (row, idx) => {
              const nameValid = row.name === '' || RECORD_KEY_RE.test(row.name);
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <Input
                    size="small"
                    status={nameValid ? undefined : 'error'}
                    placeholder="studio"
                    value={row.name}
                    onChange={(e) => update(idx, { name: e.target.value })}
                  />
                  {nameValid ? null : (
                    <Typography.Text type="danger" style={{ fontSize: 11 }}>
                      This name becomes a {spec.configKey}.&lt;name&gt; key in config.yaml —
                      letters, digits, hyphens and underscores only, or the loader will not see it.
                    </Typography.Text>
                  )}
                </div>
              );
            },
          },
          {
            key: 'provider',
            header: 'Provider',
            render: (row, idx) => (
              <Select
                size="small"
                style={{ width: '100%' }}
                value={row.provider}
                onChange={(v: string) => update(idx, { provider: v })}
                options={spec.providerOptions}
              />
            ),
          },
          {
            key: 'model',
            header: 'Model',
            render: (row, idx) => (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <Input
                  size="small"
                  placeholder={spec.modelPlaceholder}
                  value={row.model}
                  onChange={(e) => update(idx, { model: e.target.value })}
                />
                {spec.audioOutputFields || spec.realtimeFields ? (
                  <Input
                    size="small"
                    placeholder={
                      spec.realtimeFields ? 'cedar (default voice)' : 'af_bella (default voice)'
                    }
                    value={row.voice}
                    onChange={(e) => update(idx, { voice: e.target.value })}
                  />
                ) : null}
              </div>
            ),
          },
          {
            key: 'base-url',
            header: 'Base URL',
            render: (row, idx) =>
              row.provider === spec.commandProvider ? (
                <Input
                  size="small"
                  style={{ fontFamily: 'Geist Mono, monospace' }}
                  placeholder={spec.commandExample}
                  value={row.command}
                  onChange={(e) => update(idx, { command: e.target.value })}
                />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <Input
                    size="small"
                    placeholder={spec.baseUrlPlaceholder}
                    value={row.baseUrl}
                    onChange={(e) => update(idx, { baseUrl: e.target.value })}
                  />
                  <Input.Password
                    size="small"
                    placeholder={
                      row.apiKeyPreview ? `Current: ${row.apiKeyPreview}` : 'API key (optional)'
                    }
                    value={row.apiKey}
                    onChange={(e) => update(idx, { apiKey: e.target.value })}
                  />
                </div>
              ),
          },
          {
            key: 'timeout',
            header: 'Timeout (seconds)',
            render: (row, idx) =>
              spec.timeoutField ? (
                <InputNumber
                  size="small"
                  style={{ width: '100%' }}
                  min={1}
                  max={3600}
                  placeholder="120"
                  value={row.timeout}
                  onChange={(v) => update(idx, { timeout: v })}
                />
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  —
                </Typography.Text>
              ),
          },
          {
            key: 'format-rate',
            header: 'Format / rate',
            render: (row, idx) => {
              if (spec.audioOutputFields) {
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <Select
                      size="small"
                      allowClear
                      style={{ width: '100%' }}
                      placeholder="provider default"
                      value={row.outputFormat || undefined}
                      onChange={(v: string | undefined) => update(idx, { outputFormat: v ?? '' })}
                      options={AUDIO_FORMATS.map((f) => ({ label: f, value: f }))}
                    />
                    <InputNumber
                      size="small"
                      style={{ width: '100%' }}
                      min={100}
                      max={100000}
                      step={100}
                      placeholder="4096 max chars"
                      value={row.maxTextLength}
                      onChange={(v) => update(idx, { maxTextLength: v })}
                    />
                  </div>
                );
              }
              if (spec.realtimeFields) {
                return (
                  <Tooltip title="What this provider bills you per minute of audio. Ethos uses it to add up what a call has cost.">
                    <InputNumber
                      size="small"
                      style={{ width: '100%' }}
                      min={0.001}
                      max={100}
                      step={0.01}
                      placeholder="0.06 USD/min"
                      value={row.costPerMinuteUsd}
                      onChange={(v) => update(idx, { costPerMinuteUsd: v })}
                    />
                  </Tooltip>
                );
              }
              return (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  —
                </Typography.Text>
              );
            },
          },
          {
            key: 'actions',
            header: 'Actions',
            render: (_row, idx) => (
              <Button size="small" danger onClick={() => remove(idx)}>
                Remove
              </Button>
            ),
          },
        ]}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Telephony panels (voice V4) — inside the existing Voice card, split by
// section labels. No new Card: "cards earn existence", and a phone number is
// part of the same subject as the microphone and the voice that answers it.
// ---------------------------------------------------------------------------

/**
 * The guided first-call moment (DR2) — the last step of the first-run journey.
 *
 * An invitation, not a status line. Everything above it is configuration; this
 * is the sentence that says the configuration is finished and what to do with
 * it. It appears only once a trunk is actually saved, so it never invites
 * anyone to dial a draft.
 */
function FirstCallInvitation({ config }: { config: ConfigGetData }) {
  const invitation = firstCallInvitation(config);
  if (!config.voiceTrunkProvider || !config.voiceTrunkId) return null;
  if (!invitation) {
    // A trunk with no dialable number is the one honest gap in the journey:
    // say what is missing rather than inviting a call to nowhere.
    return (
      <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 13 }}>
        Your trunk is connected. Add the number it answers under <strong>Numbers</strong> below, and
        this turns into an invitation to call it.
      </Typography.Paragraph>
    );
  }
  return (
    <div className="call-invite">
      <Typography.Text strong>Call your number to try it</Typography.Text>
      <span className="call-mono call-invite-number">{invitation.number}</span>
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
        {invitation.answeredBy
          ? `Ring it from any phone and ${invitation.answeredBy} picks up. The call lands in Communications → Calls while it is still going.`
          : 'Ring it from any phone. The call lands in Communications → Calls while it is still going.'}
      </Typography.Text>
    </div>
  );
}

/** The `voice.bots[]` editor: which number reaches which agent. Add/remove
 *  dense rows, full replacement on save — the same contract the provider
 *  rosters have, for the same reason (a removed row IS a deletion). */
function VoiceBotRoster({
  rows,
  setRows,
  personalities,
}: {
  rows: VoiceBotRow[];
  setRows: Dispatch<SetStateAction<VoiceBotRow[]>>;
  personalities: PersonalityOption[];
}) {
  const update = (index: number, patch: Partial<VoiceBotRow>) =>
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const remove = (index: number) => setRows((prev) => prev.filter((_, i) => i !== index));
  const add = () =>
    setRows((prev) => [
      ...prev,
      {
        _id: nextRowId(),
        id: '',
        match: '',
        bindType: 'personality',
        bindName: '',
        allowSlashSwitch: false,
      },
    ]);

  return (
    <div style={{ marginBottom: 16 }}>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 13 }}>
        Which number or LiveKit room each agent answers. <code>*</code> wildcards are allowed, so{' '}
        <code>+1555*</code> catches a whole range. Saving replaces the whole list, and the rows are
        renumbered — a removed row is a deleted bot.
      </Typography.Paragraph>
      <SettingTable<VoiceBotRow>
        rowKey={(row) => row._id}
        rows={rows}
        addLabel="Add number"
        onAdd={add}
        columns={[
          {
            key: 'match',
            header: 'Number or room',
            render: (row, idx) => (
              <Input
                size="small"
                style={{ fontFamily: 'Geist Mono, monospace' }}
                placeholder="+15551234567"
                value={row.match}
                onChange={(e) => update(idx, { match: e.target.value })}
              />
            ),
          },
          {
            key: 'bind-type',
            header: 'Answers as',
            render: (row, idx) => (
              <Select
                size="small"
                style={{ width: '100%' }}
                value={row.bindType}
                onChange={(v: 'personality' | 'team') => update(idx, { bindType: v, bindName: '' })}
                options={[
                  { value: 'personality', label: 'Personality' },
                  { value: 'team', label: 'Team' },
                ]}
              />
            ),
          },
          {
            key: 'bind-name',
            header: 'Personality',
            render: (row, idx) =>
              row.bindType === 'team' ? (
                <Input
                  size="small"
                  placeholder="support"
                  value={row.bindName}
                  onChange={(e) => update(idx, { bindName: e.target.value })}
                />
              ) : (
                <Select
                  size="small"
                  showSearch
                  style={{ width: '100%' }}
                  placeholder="Who picks up"
                  value={row.bindName || undefined}
                  onChange={(v: string) => update(idx, { bindName: v })}
                  options={personalities.map((p) => ({ value: p.id, label: p.name }))}
                />
              ),
          },
          {
            key: 'id',
            header: 'Bot id',
            render: (row, idx) => (
              <Input
                size="small"
                style={{ fontFamily: 'Geist Mono, monospace' }}
                placeholder="derived from the number"
                value={row.id}
                onChange={(e) => update(idx, { id: e.target.value })}
              />
            ),
          },
          {
            key: 'slash-switch',
            header: 'Switch mid-call',
            render: (row, idx) => (
              <Tooltip title="Let a caller say /personality mid-call to reach a different agent on this number.">
                <Switch
                  size="small"
                  checked={row.allowSlashSwitch}
                  onChange={(v) => update(idx, { allowSlashSwitch: v })}
                />
              </Tooltip>
            ),
          },
          {
            key: 'actions',
            header: 'Actions',
            render: (_row, idx) => (
              <Button size="small" danger onClick={() => remove(idx)}>
                Remove
              </Button>
            ),
          },
        ]}
      />
    </div>
  );
}

// Exported for `__tests__/settings-callouts.test.ts` (T11a), the same reason
// `AdminPanelGate` is exported from `security.tsx` for T16: the trunk and
// hardening sections it renders need a full `ConfigGetData` fixture to reach,
// which is disproportionate to build for the whole `VoicePane` (its other
// sections — call appearance, barge-in — render without one).
export function VoiceTelephonySections({
  config,
  personalities,
  botRows,
  setBotRows,
}: {
  config: ConfigGetData;
  personalities: PersonalityOption[];
  botRows: VoiceBotRow[];
  setBotRows: Dispatch<SetStateAction<VoiceBotRow[]>>;
}) {
  return (
    <>
      <SectionHeading id="trunk">trunk</SectionHeading>
      <FirstCallInvitation config={config} />
      <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 13 }}>
        The SIP trunk your number is attached to. Clearing the provider removes the whole trunk
        block — a trunk with a provider but no trunk id will not load, so the two are saved together
        or not at all.
      </Typography.Paragraph>
      <SettingRow
        label="Trunk provider"
        formName="voiceTrunkProvider"
        help="Selects the inbound webhook signature scheme. Clear it to turn telephony off."
      >
        <Form.Item name="voiceTrunkProvider" style={{ marginBottom: 0 }}>
          <Select
            allowClear
            placeholder="No trunk — telephony off"
            options={TRUNK_PROVIDERS.map((p) => ({ value: p, label: p }))}
          />
        </Form.Item>
      </SettingRow>
      <Form.Item
        noStyle
        shouldUpdate={(prev, cur) => prev.voiceTrunkProvider !== cur.voiceTrunkProvider}
      >
        {({ getFieldValue }) =>
          getFieldValue('voiceTrunkProvider') ? (
            <>
              <SettingRow
                label="Trunk id"
                formName="voiceTrunkId"
                help="The SIP trunk the number is attached to. Required whenever a provider is set."
              >
                <Form.Item name="voiceTrunkId" style={{ marginBottom: 0 }}>
                  <Input placeholder="ST_abc123" />
                </Form.Item>
              </SettingRow>
              <SettingRow
                label="Caller ID (outbound)"
                formName="voiceTrunkFromNumber"
                help="E.164 number presented when the agent places a call."
              >
                <Form.Item name="voiceTrunkFromNumber" style={{ marginBottom: 0 }}>
                  <Input placeholder="+15551234567" />
                </Form.Item>
              </SettingRow>
              <SettingRow
                label="SIP username"
                formName="voiceTrunkUsername"
                help="Registrar / auth username, if your trunk uses one."
              >
                <Form.Item name="voiceTrunkUsername" style={{ marginBottom: 0 }}>
                  <Input placeholder="Optional" />
                </Form.Item>
              </SettingRow>
              <SettingRow
                label="SIP password"
                formName="voiceTrunkPassword"
                help={
                  config.voiceTrunkPasswordPreview
                    ? `Current: ${config.voiceTrunkPasswordPreview}. Leave blank to keep it.`
                    : 'Stored write-only — it is never sent back to this page.'
                }
              >
                <Form.Item name="voiceTrunkPassword" style={{ marginBottom: 0 }}>
                  <Input.Password
                    placeholder={
                      config.voiceTrunkPasswordPreview ? 'Leave blank to keep' : 'Enter password...'
                    }
                  />
                </Form.Item>
              </SettingRow>
              <SettingRow
                label="Webhook secret"
                formName="voiceTrunkWebhookSecret"
                help={
                  config.voiceTrunkWebhookSecretPreview
                    ? `Current: ${config.voiceTrunkWebhookSecretPreview}. Leave blank to keep it. This one authenticates the TRUNK to us on an inbound call, so it rotates on its own schedule.`
                    : 'Authenticates the trunk to us on an inbound call — it rotates independently of the SIP password.'
                }
              >
                <Form.Item name="voiceTrunkWebhookSecret" style={{ marginBottom: 0 }}>
                  <Input.Password
                    placeholder={
                      config.voiceTrunkWebhookSecretPreview
                        ? 'Leave blank to keep'
                        : 'Enter secret...'
                    }
                  />
                </Form.Item>
              </SettingRow>
              <SettingRow
                label="Webhook path"
                formName="voiceTrunkWebhookPath"
                help="Where the inbound listener mounts. Must start with “/”. Blank = the listener's own default."
              >
                <Form.Item
                  name="voiceTrunkWebhookPath"
                  rules={[{ pattern: /^\//, message: 'Must start with /.' }]}
                  style={{ marginBottom: 0 }}
                >
                  <Input placeholder="/voice/inbound" />
                </Form.Item>
              </SettingRow>
              <SettingRow
                label="Codec"
                formName="voiceTrunkCodec"
                help="Blank leaves the choice to the bridge's negotiation. G.711 is the phone network's own; Opus is better where the trunk offers it."
              >
                <Form.Item name="voiceTrunkCodec" style={{ marginBottom: 0 }}>
                  <Select
                    allowClear
                    placeholder="Negotiate"
                    options={TRUNK_CODECS.map((c) => ({ value: c, label: c }))}
                  />
                </Form.Item>
              </SettingRow>
            </>
          ) : null
        }
      </Form.Item>

      <SectionHeading id="livekit">LiveKit</SectionHeading>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 13 }}>
        The media server the SIP leg bridges into. All three fields belong together — clearing the
        URL removes the whole block, including the stored key and secret.
      </Typography.Paragraph>
      <SettingRow label="Server URL" formName="voiceLivekitUrl">
        <Form.Item name="voiceLivekitUrl" style={{ marginBottom: 0 }}>
          <Input placeholder="wss://your-project.livekit.cloud" />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="API key"
        formName="voiceLivekitApiKey"
        help={
          config.voiceLivekitApiKeyPreview
            ? `Current: ${config.voiceLivekitApiKeyPreview}. Leave blank to keep it.`
            : 'Required whenever a server URL is set.'
        }
      >
        <Form.Item name="voiceLivekitApiKey" style={{ marginBottom: 0 }}>
          <Input.Password
            placeholder={
              config.voiceLivekitApiKeyPreview ? 'Leave blank to keep' : 'Enter API key...'
            }
          />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="API secret"
        formName="voiceLivekitApiSecret"
        help={
          config.voiceLivekitApiSecretPreview
            ? `Current: ${config.voiceLivekitApiSecretPreview}. Leave blank to keep it.`
            : 'Required whenever a server URL is set.'
        }
      >
        <Form.Item name="voiceLivekitApiSecret" style={{ marginBottom: 0 }}>
          <Input.Password
            placeholder={
              config.voiceLivekitApiSecretPreview ? 'Leave blank to keep' : 'Enter API secret...'
            }
          />
        </Form.Item>
      </SettingRow>

      <SectionHeading id="numbers">numbers</SectionHeading>
      <VoiceBotRoster rows={botRows} setRows={setBotRows} personalities={personalities} />

      <SectionHeading id="hardening">hardening</SectionHeading>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 13 }}>
        A phone number is the one surface a stranger can reach without being invited. These are the
        guards on it, and every refusal they cause is written to Communications → Calls with its
        reason.
      </Typography.Paragraph>
      <SettingRow
        label="Caller allowlist"
        formName="voiceInboundAllowlist"
        help="Numbers that reach your own personality directly. An EMPTY list clears the key — “trust nobody” is not a list, it is a receptionist, so set one below instead."
      >
        <Form.Item name="voiceInboundAllowlist" style={{ marginBottom: 0 }}>
          <Select mode="tags" tokenSeparators={[',']} placeholder="+15551234567" />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="Receptionist"
        formName="voiceInboundReceptionist"
        help="Who answers everyone not on the allowlist, in a restricted scope. Blank = nobody does, and unlisted callers are turned away."
      >
        <Form.Item name="voiceInboundReceptionist" style={{ marginBottom: 0 }}>
          <Select
            allowClear
            showSearch
            placeholder="No receptionist"
            options={personalities.map((p) => ({ value: p.id, label: p.name }))}
          />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="Concurrent calls"
        formName="voiceInboundConcurrencyCap"
        help="Ceiling on calls in progress at once. Blank = the built-in default."
      >
        <Form.Item name="voiceInboundConcurrencyCap" style={{ marginBottom: 0 }}>
          <InputNumber min={1} max={1000} placeholder="Default" />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="Calls per caller per hour"
        formName="voiceInboundPerCallerPerHour"
        help="Rolling-hour ceiling for one number. Blank = the built-in default."
      >
        <Form.Item name="voiceInboundPerCallerPerHour" style={{ marginBottom: 0 }}>
          <InputNumber min={1} max={1000} placeholder="Default" />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="Daily inbound budget (USD)"
        formName="voiceInboundDailyBudgetUsd"
        help="Spend ceiling across every inbound call in a day. Blank = no ceiling."
      >
        <Form.Item name="voiceInboundDailyBudgetUsd" style={{ marginBottom: 0 }}>
          <InputNumber min={0.01} max={100000} step={1} placeholder="No limit" />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="Pre-warm on ring"
        formName="voiceInboundPrewarm"
        help="Which callers get the realtime socket opened while the phone is still ringing. Faster first word, at the cost of a session opened for a call that may not connect."
      >
        <Form.Item name="voiceInboundPrewarm" style={{ marginBottom: 0 }}>
          <Select
            allowClear
            placeholder="Default"
            options={[
              { value: 'allowlisted', label: 'Allowlisted callers only' },
              { value: 'none', label: 'Nobody — open on answer' },
              { value: 'all', label: 'Everyone who rings' },
            ]}
          />
        </Form.Item>
      </SettingRow>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 13 }}>
        Where call summaries and refusal notices are delivered. The platform and the chat id are
        saved together — half a destination will not load, so clearing the platform removes the
        whole notice route.
      </Typography.Paragraph>
      <SettingRow label="Notify on" formName="voiceInboundOwnerPlatform">
        <Form.Item name="voiceInboundOwnerPlatform" style={{ marginBottom: 0 }}>
          <Input placeholder="telegram" />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="Chat id"
        formName="voiceInboundOwnerChatId"
        help="Required whenever a platform is set."
      >
        <Form.Item name="voiceInboundOwnerChatId" style={{ marginBottom: 0 }}>
          <Input placeholder="123456789" />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="Bot key"
        formName="voiceInboundOwnerBotKey"
        help="Which bot delivers the notice in a multi-bot deployment. Blank = the default bot."
      >
        <Form.Item name="voiceInboundOwnerBotKey" style={{ marginBottom: 0 }}>
          <Input placeholder="Default bot" />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="Restrict voice egress"
        formName="voiceEgressGate"
        help="Only providers that run on this machine, plus the ones you list below, may receive audio. Off = any configured provider may."
      >
        <Form.Item name="voiceEgressGate" valuePropName="checked" style={{ marginBottom: 0 }}>
          <Switch />
        </Form.Item>
      </SettingRow>
      <Form.Item noStyle shouldUpdate={(prev, cur) => prev.voiceEgressGate !== cur.voiceEgressGate}>
        {({ getFieldValue }) =>
          getFieldValue('voiceEgressGate') ? (
            <SettingRow
              label="Trusted voice providers"
              formName="voiceTrustedPlugins"
              help="Provider ids allowed to send audio off this machine (e.g. openai-tts, elevenlabs). Local providers always pass. Clearing the list turns the restriction off."
            >
              <Form.Item name="voiceTrustedPlugins" style={{ marginBottom: 0 }}>
                <Select
                  mode="tags"
                  tokenSeparators={[',']}
                  placeholder="openai-tts"
                  options={[
                    { label: 'openai-tts', value: 'openai-tts' },
                    { label: 'openai-stt', value: 'openai-stt' },
                    { label: 'groq-stt', value: 'groq-stt' },
                  ]}
                />
              </Form.Item>
            </SettingRow>
          ) : null
        }
      </Form.Item>
    </>
  );
}
