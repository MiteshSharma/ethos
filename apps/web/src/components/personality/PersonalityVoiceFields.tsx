import { useQuery } from '@tanstack/react-query';
import { Button, Form, Input, Select, Space, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { rpc } from '../../rpc';

// How a personality sounds — the identity fields that sit beside its name and
// its mark, not a config knob — plus the one technical override that belongs
// with them: which engine hears it.
//
// Four controls: which TTS provider (a `voice.tts.providers.<name>` roster
// label, or the default entry), which voice, which STT provider (a
// `voice.stt.providers.<name>` label, or the default), and which REALTIME
// provider (a `voice.realtime.providers.<name>` label, or none). `voice.tier`,
// `voice.model` and the per-language map are deliberately absent — they
// persist, but nothing routes on them yet, and a form field is a promise that
// it works.
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
}

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
