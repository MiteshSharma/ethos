import type { CallTreatment } from '@ethosagent/types';
import { useQuery } from '@tanstack/react-query';
import { Button, Form, Input, Select, Space, Typography } from 'antd';
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { rpc } from '../../rpc';

// How a personality sounds and looks — the identity fields that sit beside its
// name and its mark, not config knobs — plus the one technical override that
// belongs with them: which engine hears it.
//
// Every sub-key of the personality's `voice` block: which TTS provider (a
// `voice.tts.providers.<name>` roster label, or the default entry), which
// voice, how its call is DRAWN (`voice.call_style`), which STT provider, which
// REALTIME provider, which TIER serves it, which fast-lane MODEL it routes to,
// and the per-language voice map. A sub-key reachable only by hand-editing
// config.yaml is a sub-key the web editor erases the next time you save, so the
// set is closed rather than curated.
//
// The call look sits with the voice because it is the same question asked of a
// different sense: a personality is not only what it says and how it sounds,
// but how it presents itself while it holds the floor.
//
// The realtime select is here BECAUSE it routes: `voice.realtime_provider`
// picks the roster entry the ephemeral-token mint resolves and the entry whose
// per-minute rate bills the call. A key that decides both, editable only by
// hand-writing config.yaml, is the yaml-only key the parity rule exists to
// forbid.
//
// The two override selects sit LAST and carry quieter copy: a personality's
// voice is identity, its ear and its hosted engine are overrides. Neither is
// hidden behind a disclosure, though — a control you have to go looking for is
// not symmetric with one you do not, and the point of the set is that they read
// the same way.

/** Fixed phrase Preview synthesizes, so what you hear is the voice, not the text. */
const PREVIEW_PHRASE = 'Hello — this is how I sound.';

/** Value a provider select uses for "the default `auxiliary.*` entry".
 *  Sent to the API as `''`, which clears the key from config.yaml. */
const DEFAULT_ENTRY = '';

export interface PersonalityVoice {
  /** TTS roster entry name; `''` = the default entry. */
  ttsProvider: string;
  /** Voice id; `''` = the provider's own default. */
  ttsVoice: string;
  /** STT roster entry name; `''` = the default entry. */
  sttProvider: string;
  /** Realtime roster entry name; `''` = whatever `voice.realtime.default` names. */
  realtimeProvider: string;
  /** Call Stage treatment; `''` = fall through to `display.call_style`, then
   *  to the treatment derived from this personality's id. */
  callStyle: CallTreatment | '';
  /** Which voice stack serves this personality; `''` = the deployment's own. */
  tier: 'pipeline' | 'realtime' | '';
  /** Fast-lane model for spoken turns; `''` = the personality's normal model. */
  model: string;
  /** `voice.languages.<tag>` as an ordered row list — a Record cannot hold a
   *  half-typed tag while the operator is still typing it. */
  languages: VoiceLanguageRow[];
}

/** One `voice.languages.<tag>: <voice id>` row, mid-edit. */
export interface VoiceLanguageRow {
  /** Stable React key. Not persisted — the tag is what config.yaml carries. */
  rowId: number;
  /** BCP-47 tag (`es`, `pt-BR`). */
  tag: string;
  /** Voice id for that language, in the personality's TTS provider. */
  voice: string;
}

/** BCP-47 tags become `voice.languages.<tag>` keys, so the charset is closed. */
const LANGUAGE_TAG_RE = /^[A-Za-z0-9-]+$/;

let nextLanguageRowId = 1;

/** Hydrate the row editor from a stored map. Exported for the edit form. */
export function voiceLanguageRows(map: Record<string, string> | undefined): VoiceLanguageRow[] {
  return Object.entries(map ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, voice]) => ({ rowId: nextLanguageRowId++, tag, voice }));
}

/**
 * Collapse the row editor back to the map the API takes.
 *
 * Blank and malformed rows are dropped rather than sent: a half-typed tag is a
 * row the operator is still writing, not a key to put in config.yaml. Exported
 * so both the create wizard and the edit form send exactly the same shape.
 */
export function voiceLanguageMap(rows: VoiceLanguageRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const tag = row.tag.trim();
    const voice = row.voice.trim();
    if (!tag || !voice || !LANGUAGE_TAG_RE.test(tag)) continue;
    out[tag] = voice;
  }
  return out;
}

/** The `voice` block as the personality RPCs take it. */
interface VoiceBlockInput {
  tts_provider?: string;
  tts_voice?: string;
  stt_provider?: string;
  realtime_provider?: string;
  call_style?: CallTreatment;
  tier?: 'pipeline' | 'realtime';
  model?: string;
  languages?: Record<string, string>;
}

/**
 * The `voice` block for `personalities.create`.
 *
 * Unset sub-keys are omitted and an all-blank form produces no block at all, so
 * a personality created without touching this section carries no `voice:` lines.
 */
export function voiceCreateInput(voice: PersonalityVoice): { voice?: VoiceBlockInput } {
  const languages = voiceLanguageMap(voice.languages);
  const block: VoiceBlockInput = {
    ...(voice.ttsProvider ? { tts_provider: voice.ttsProvider } : {}),
    ...(voice.ttsVoice ? { tts_voice: voice.ttsVoice } : {}),
    ...(voice.sttProvider ? { stt_provider: voice.sttProvider } : {}),
    ...(voice.realtimeProvider ? { realtime_provider: voice.realtimeProvider } : {}),
    ...(voice.callStyle ? { call_style: voice.callStyle } : {}),
    ...(voice.tier ? { tier: voice.tier } : {}),
    ...(voice.model ? { model: voice.model } : {}),
    ...(Object.keys(languages).length > 0 ? { languages } : {}),
  };
  return Object.keys(block).length > 0 ? { voice: block } : {};
}

/**
 * The `voice` patch for `personalities.update`.
 *
 * EVERY sub-key, always, empty string included: the registry shallow-merges the
 * block, so omitting one would preserve the stored value and make "back to the
 * default" unexpressible. `languages` replaces the stored map wholesale for the
 * same reason — an omitted tag has to be a deleted tag.
 */
export function voiceUpdateInput(voice: PersonalityVoice): {
  tts_provider: string;
  tts_voice: string;
  stt_provider: string;
  realtime_provider: string;
  call_style: CallTreatment | '';
  tier: 'pipeline' | 'realtime' | '';
  model: string;
  languages: Record<string, string>;
} {
  return {
    tts_provider: voice.ttsProvider,
    tts_voice: voice.ttsVoice,
    stt_provider: voice.sttProvider,
    realtime_provider: voice.realtimeProvider,
    call_style: voice.callStyle,
    tier: voice.tier,
    model: voice.model,
    languages: voiceLanguageMap(voice.languages),
  };
}

/** The three treatments, plus the "not declared" row that clears the key. */
const CALL_STYLE_OPTIONS: ReadonlyArray<{ value: CallTreatment | ''; label: string }> = [
  { value: '', label: 'Derived from this personality' },
  { value: 'liquid', label: 'Liquid — the circle fills as it speaks' },
  { value: 'orb', label: 'Orb — a body that deforms with the voice' },
  { value: 'rings', label: 'Rings — concentric rings breathing outward' },
];

/** Tier, plus the "not declared" row that defers to the deployment's `voice.tier`. */
const TIER_OPTIONS: ReadonlyArray<{ value: 'pipeline' | 'realtime' | ''; label: string }> = [
  { value: '', label: 'Deployment default' },
  { value: 'pipeline', label: 'Pipeline — speech to text, agent, text to speech' },
  { value: 'realtime', label: 'Realtime — hosted speech to speech' },
];

/** A dense row, not a Card — DESIGN.md "cards earn existence". */
const LANGUAGE_ROW_STYLE: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'flex-start',
  marginBottom: 8,
};

export function PersonalityVoiceFields({
  value,
  onChange,
}: {
  value: PersonalityVoice;
  onChange: (next: PersonalityVoice) => void;
}) {
  const ttsQuery = useQuery({
    queryKey: ['voice', 'ttsEntries'],
    queryFn: () => rpc.voice.ttsEntries(),
  });
  const sttQuery = useQuery({
    queryKey: ['voice', 'sttEntries'],
    queryFn: () => rpc.voice.sttEntries(),
  });
  const realtimeQuery = useQuery({
    queryKey: ['voice', 'realtimeEntries'],
    queryFn: () => rpc.voice.realtimeEntries(),
  });

  const data = ttsQuery.data;
  const rosterNames = Object.keys(data?.roster ?? {}).sort((a, b) => a.localeCompare(b));
  const configured = Boolean(data && (data.default.providerId || rosterNames.length > 0));
  // A personality authored elsewhere can name an entry this machine lacks. Keep
  // it selectable and say so, rather than silently rewriting it to Default on
  // the next save.
  const unknownName =
    value.ttsProvider !== DEFAULT_ENTRY && !rosterNames.includes(value.ttsProvider)
      ? value.ttsProvider
      : null;

  const selected =
    value.ttsProvider === DEFAULT_ENTRY ? data?.default : data?.roster[value.ttsProvider];
  const voices = selected?.voices ?? null;

  const sttData = sttQuery.data;
  const sttRosterNames = Object.keys(sttData?.roster ?? {}).sort((a, b) => a.localeCompare(b));
  const unknownSttName =
    value.sttProvider !== DEFAULT_ENTRY && !sttRosterNames.includes(value.sttProvider)
      ? value.sttProvider
      : null;

  const realtimeData = realtimeQuery.data;
  const realtimeRosterNames = Object.keys(realtimeData?.roster ?? {}).sort((a, b) =>
    a.localeCompare(b),
  );
  const unknownRealtimeName =
    value.realtimeProvider !== DEFAULT_ENTRY &&
    !realtimeRosterNames.includes(value.realtimeProvider)
      ? value.realtimeProvider
      : null;
  // `voice.realtime.default` NAMES a roster label; there is no `auxiliary.*`
  // entry beneath this tier. So the "unset" row says which label it defers to,
  // or admits there is none — a Default that resolves to nothing would be a
  // control that reads as configured while doing nothing.
  const realtimeDefaultLabel = realtimeData?.defaultEntryName
    ? `Deployment default (${realtimeData.defaultEntryName})`
    : 'Deployment default (none configured)';

  return (
    <>
      <Form.Item
        label="Voice provider"
        help={
          unknownName
            ? `"${unknownName}" is not configured on this machine — this personality will fall back to the default until it is.`
            : 'Which text-to-speech provider this personality speaks through. Providers are configured in Settings → Voice.'
        }
        validateStatus={unknownName ? 'warning' : undefined}
      >
        <Select
          loading={ttsQuery.isLoading}
          value={value.ttsProvider}
          onChange={(next: string) => onChange({ ...value, ttsProvider: next, ttsVoice: '' })}
          options={[
            {
              label: `Default (${data?.default.providerId ?? 'not configured'})`,
              value: DEFAULT_ENTRY,
            },
            ...rosterNames.map((name) => ({
              label: `${name} — ${data?.roster[name]?.providerId ?? ''}`,
              value: name,
            })),
            ...(unknownName
              ? [{ label: `${unknownName} — not configured here`, value: unknownName }]
              : []),
          ]}
        />
      </Form.Item>
      <Form.Item
        label="Voice"
        help={
          voices
            ? 'Voice ids this provider advertises.'
            : 'Free-form — this provider takes server-specific voice ids (e.g. Kokoro af_bella). Blank uses the provider default.'
        }
      >
        {voices ? (
          <Select
            allowClear
            placeholder="provider default"
            value={value.ttsVoice || undefined}
            onChange={(next: string | undefined) => onChange({ ...value, ttsVoice: next ?? '' })}
            options={voices.map((v) => ({ label: v, value: v }))}
          />
        ) : (
          <Input
            placeholder="af_bella"
            value={value.ttsVoice}
            onChange={(e) => onChange({ ...value, ttsVoice: e.target.value })}
          />
        )}
      </Form.Item>
      <VoiceLanguageRows
        rows={value.languages}
        onChange={(languages) => onChange({ ...value, languages })}
      />
      <Form.Item
        label="Call look"
        help="The shape the Call Stage draws while this personality holds the floor. Left as derived, it gets a stable shape from its own name — no two personalities have to look alike. A treatment pinned in Settings → Voice applies only to personalities that have not chosen one here."
      >
        <Select
          value={value.callStyle}
          onChange={(next: CallTreatment | '') => onChange({ ...value, callStyle: next })}
          options={[...CALL_STYLE_OPTIONS]}
        />
      </Form.Item>
      <Form.Item
        label="Speech-to-text provider"
        help={
          unknownSttName
            ? `"${unknownSttName}" is not configured on this machine — this personality will fall back to the default until it is.`
            : 'Only if this personality needs a different engine to hear it — a language-tuned or local-only transcriber. Otherwise it uses the default from Settings → Voice.'
        }
        validateStatus={unknownSttName ? 'warning' : undefined}
      >
        <Select
          loading={sttQuery.isLoading}
          value={value.sttProvider}
          onChange={(next: string) => onChange({ ...value, sttProvider: next })}
          options={[
            {
              label: `Default (${sttData?.default.providerId ?? 'not configured'})`,
              value: DEFAULT_ENTRY,
            },
            ...sttRosterNames.map((name) => ({
              label: `${name} — ${sttData?.roster[name]?.providerId ?? ''}`,
              value: name,
            })),
            ...(unknownSttName
              ? [{ label: `${unknownSttName} — not configured here`, value: unknownSttName }]
              : []),
          ]}
        />
      </Form.Item>
      <Form.Item
        label="Realtime provider"
        help={
          unknownRealtimeName
            ? `"${unknownRealtimeName}" is not configured on this machine — calls will fall back to the deployment default until it is.`
            : 'Which hosted speech-to-speech provider serves this personality in talk mode. Picks the entry the call is minted against and billed at. Providers are configured in Settings → Voice.'
        }
        validateStatus={unknownRealtimeName ? 'warning' : undefined}
      >
        <Select
          loading={realtimeQuery.isLoading}
          value={value.realtimeProvider}
          onChange={(next: string) => onChange({ ...value, realtimeProvider: next })}
          options={[
            { label: realtimeDefaultLabel, value: DEFAULT_ENTRY },
            ...realtimeRosterNames.map((name) => ({
              label: `${name} — ${realtimeData?.roster[name]?.providerId ?? ''}`,
              value: name,
            })),
            ...(unknownRealtimeName
              ? [
                  {
                    label: `${unknownRealtimeName} — not configured here`,
                    value: unknownRealtimeName,
                  },
                ]
              : []),
          ]}
        />
      </Form.Item>
      <Form.Item
        label="Voice tier"
        help="Which stack serves this personality when it talks. Pipeline transcribes, runs the agent, then speaks; realtime hands the whole turn to a hosted speech-to-speech provider. Left as the deployment default, it follows Settings → Voice — and a deployment with no realtime provider serves pipeline either way."
      >
        <Select
          value={value.tier}
          onChange={(next: 'pipeline' | 'realtime' | '') => onChange({ ...value, tier: next })}
          options={[...TIER_OPTIONS]}
        />
      </Form.Item>
      <Form.Item
        label="Fast-lane model"
        help="The model the voice lane routes to. Conversational latency and agentic depth want different models; this is how a personality says which one talks. Blank uses its normal model. It is stored and resolved today, but fast-lane routing for spoken pipeline turns has not landed — setting it does not yet change which model answers."
      >
        <Input
          placeholder="claude-haiku-4-5"
          value={value.model}
          onChange={(e) => onChange({ ...value, model: e.target.value })}
        />
      </Form.Item>
      {configured ? (
        <VoicePreview provider={value.ttsProvider} ttsVoice={value.ttsVoice} />
      ) : (
        <Typography.Paragraph type="secondary">
          No text-to-speech provider is configured, so there is nothing to preview yet. Set one up
          in <Link to="/settings">Settings → Voice</Link> — you can pick a voice here now and it
          will be used once a provider exists.
        </Typography.Paragraph>
      )}
    </>
  );
}

/**
 * `voice.languages.<tag>` — which voice speaks this personality in which
 * language.
 *
 * Rows, not a Card: DESIGN.md reserves the Card primitive for skill rows, cron
 * rows and task tiles, and a two-field pair does not earn one. The shape is the
 * dense-row idiom Settings → Voice already uses for its provider rosters — a
 * label above each field, small controls, one Remove per row, one Add beneath.
 *
 * A tag with no voice (or a voice with no tag) is a row mid-typing and is
 * simply not sent; a malformed tag says so rather than being dropped in
 * silence, because a tag that vanishes on save looks like a bug in the editor.
 */
function VoiceLanguageRows({
  rows,
  onChange,
}: {
  rows: VoiceLanguageRow[];
  onChange: (next: VoiceLanguageRow[]) => void;
}) {
  const update = (rowId: number, patch: Partial<VoiceLanguageRow>) =>
    onChange(rows.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)));

  return (
    <Form.Item
      label="Voices by language"
      help="A voice per language this personality speaks. When a turn's language is known, the entry for it wins over the voice above — a personality that declares a Spanish voice means it in Spanish. Channel voice notes detect the language against exactly these tags."
    >
      {rows.map((row) => {
        const tagValid = row.tag === '' || LANGUAGE_TAG_RE.test(row.tag);
        return (
          <div key={row.rowId} style={LANGUAGE_ROW_STYLE}>
            <div style={{ width: 140 }}>
              <Input
                size="small"
                status={tagValid ? undefined : 'error'}
                placeholder="es"
                aria-label="Language tag"
                value={row.tag}
                onChange={(e) => update(row.rowId, { tag: e.target.value })}
              />
              {tagValid ? null : (
                <Typography.Text type="danger" style={{ fontSize: 11 }}>
                  Letters, digits and hyphens only — a BCP-47 tag like es or pt-BR.
                </Typography.Text>
              )}
            </div>
            <Input
              size="small"
              placeholder="ef_dora"
              aria-label="Voice for this language"
              value={row.voice}
              onChange={(e) => update(row.rowId, { voice: e.target.value })}
            />
            <Button
              size="small"
              danger
              onClick={() => onChange(rows.filter((r) => r.rowId !== row.rowId))}
            >
              Remove
            </Button>
          </div>
        );
      })}
      <Button
        size="small"
        onClick={() => onChange([...rows, { rowId: nextLanguageRowId++, tag: '', voice: '' }])}
      >
        Add language
      </Button>
    </Form.Item>
  );
}

/**
 * Speak a fixed phrase through the selection as it stands in the form — not as
 * it stands on disk. The override rides the same `voice.synthesize` path a real
 * reply takes, so what you hear is what the personality will sound like,
 * including the fallback when the named provider cannot serve.
 */
function VoicePreview({ provider, ttsVoice }: { provider: string; ttsVoice: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [playedThrough, setPlayedThrough] = useState<string | null>(null);
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
      const result = await rpc.voice.synthesize({
        text: PREVIEW_PHRASE,
        override: {
          ...(provider ? { provider } : {}),
          ...(ttsVoice ? { voice: ttsVoice } : {}),
        },
      });
      const bytes = Uint8Array.from(atob(result.audio), (c) => c.charCodeAt(0));
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => setState('idle');
      audio.onerror = () => setState('idle');
      // Which provider ACTUALLY spoke — the answer differs from the selection
      // whenever the named entry fell back, and that is worth seeing.
      setPlayedThrough(result.provider ?? null);
      setState('playing');
      await audio.play().catch(() => setState('idle'));
    } catch (err) {
      setState('idle');
      setPlayedThrough(null);
      setError(err instanceof Error ? err.message : 'Preview failed');
    }
  }, [state, provider, ttsVoice]);

  return (
    <Space direction="vertical" size="small" style={{ marginBottom: 16 }}>
      <Button size="small" onClick={handleClick} loading={state === 'loading'}>
        {state === 'playing' ? 'Stop' : 'Preview'}
      </Button>
      {error ? (
        <Typography.Text type="danger">{error}</Typography.Text>
      ) : playedThrough ? (
        <Typography.Text type="secondary">Played through {playedThrough}.</Typography.Text>
      ) : null}
    </Space>
  );
}
