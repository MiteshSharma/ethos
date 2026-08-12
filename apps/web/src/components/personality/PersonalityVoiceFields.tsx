import { useQuery } from '@tanstack/react-query';
import { Button, Form, Input, Select, Space, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { rpc } from '../../rpc';

// How a personality sounds — the identity fields that sit beside its name and
// its mark, not a config knob.
//
// Two controls only: which TTS provider (a `voice.providers.<name>` roster
// label, or the default entry) and which voice. `voice.tier`, `voice.model` and
// the per-language map are deliberately absent — they persist, but nothing
// routes on them yet, and a form field is a promise that it works.

/** Fixed phrase Preview synthesizes, so what you hear is the voice, not the text. */
const PREVIEW_PHRASE = 'Hello — this is how I sound.';

/** Value the provider select uses for "the default `auxiliary.tts` entry".
 *  Sent to the API as `''`, which clears `voice.provider` from config.yaml. */
const DEFAULT_ENTRY = '';

export interface PersonalityVoice {
  /** Roster entry name; `''` = the default entry. */
  provider: string;
  /** Voice id; `''` = the provider's own default. */
  ttsVoice: string;
}

export function PersonalityVoiceFields({
  value,
  onChange,
}: {
  value: PersonalityVoice;
  onChange: (next: PersonalityVoice) => void;
}) {
  const entriesQuery = useQuery({
    queryKey: ['voice', 'ttsEntries'],
    queryFn: () => rpc.voice.ttsEntries(),
  });

  const data = entriesQuery.data;
  const rosterNames = Object.keys(data?.roster ?? {}).sort((a, b) => a.localeCompare(b));
  const configured = Boolean(data && (data.default.providerId || rosterNames.length > 0));
  // A personality authored elsewhere can name an entry this machine lacks. Keep
  // it selectable and say so, rather than silently rewriting it to Default on
  // the next save.
  const unknownName =
    value.provider !== DEFAULT_ENTRY && !rosterNames.includes(value.provider)
      ? value.provider
      : null;

  const selected = value.provider === DEFAULT_ENTRY ? data?.default : data?.roster[value.provider];
  const voices = selected?.voices ?? null;

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
          loading={entriesQuery.isLoading}
          value={value.provider}
          onChange={(next: string) => onChange({ provider: next, ttsVoice: '' })}
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
      {configured ? (
        <VoicePreview provider={value.provider} ttsVoice={value.ttsVoice} />
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
