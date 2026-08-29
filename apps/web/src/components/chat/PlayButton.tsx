import { message } from 'antd';
import { useCallback, useRef, useState } from 'react';
import { rpc } from '../../rpc';

type PlayState = 'idle' | 'loading' | 'playing';

interface PlayButtonProps {
  text: string;
  /** Who is speaking. Without it the server cannot honour this personality's
   *  own `voice.tts_voice` and falls back to the deployment default. */
  personalityId?: string;
}

/**
 * The `voice.synthesize` input for one click.
 *
 * A named function rather than an inline literal because the RPC fires from a
 * click handler and the apps/web suite has no DOM to click with — this is the
 * seam where "click-to-hear used the deployment voice, not the personality's"
 * can be asserted. Only the id travels: the voice itself is resolved
 * server-side, through the same precedence and the same local-only egress gate
 * the talk lane uses.
 */
export function playbackRequest(text: string, personalityId?: string) {
  return { text, ...(personalityId ? { personalityId } : {}) };
}

export function PlayButton({ text, personalityId }: PlayButtonProps) {
  const [state, setState] = useState<PlayState>('idle');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  /** What the cached blob was synthesized FOR. The personality is part of it:
   *  the same sentence spoken by two personalities is two recordings. */
  const cachedKeyRef = useRef<string | null>(null);

  const handleClick = useCallback(async () => {
    if (state === 'playing') {
      audioRef.current?.pause();
      setState('idle');
      return;
    }

    if (state === 'loading') return;

    // Reuse cached audio if neither the text nor the speaker has changed
    const cacheKey = `${personalityId ?? ''}\n${text}`;
    if (blobUrlRef.current && cachedKeyRef.current === cacheKey) {
      const audio = new Audio(blobUrlRef.current);
      audioRef.current = audio;
      audio.onended = () => setState('idle');
      audio.onerror = () => setState('idle');
      setState('playing');
      await audio.play().catch(() => setState('idle'));
      return;
    }

    setState('loading');
    try {
      const result = await rpc.voice.synthesize(playbackRequest(text, personalityId));
      const bytes = Uint8Array.from(atob(result.audio), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: result.mimeType });
      const url = URL.createObjectURL(blob);

      // Clean up previous blob URL
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = url;
      cachedKeyRef.current = cacheKey;

      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => setState('idle');
      audio.onerror = () => setState('idle');
      setState('playing');
      await audio.play().catch(() => setState('idle'));
    } catch (err) {
      setState('idle');
      const raw = err instanceof Error ? err.message : 'Text-to-speech failed';
      const msg = raw.includes('No TTS provider')
        ? 'TTS not configured — enable a TTS provider in Settings → Voice'
        : raw;
      void message.error(msg);
    }
  }, [state, text, personalityId]);

  return (
    <button
      type="button"
      className={`play-btn${state === 'playing' ? ' play-btn-active' : ''}`}
      onClick={handleClick}
      aria-label={state === 'playing' ? 'Stop playback' : 'Read aloud'}
      title={state === 'playing' ? 'Stop' : 'Read aloud'}
    >
      {state === 'loading' ? (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle
            cx="8"
            cy="8"
            r="6"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray="28"
            strokeDashoffset="8"
          >
            <animateTransform
              attributeName="transform"
              type="rotate"
              from="0 8 8"
              to="360 8 8"
              dur="0.8s"
              repeatCount="indefinite"
            />
          </circle>
        </svg>
      ) : state === 'playing' ? (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor" />
          <rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M3 5.5h2l3-2.5v10l-3-2.5H3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z"
            fill="currentColor"
          />
          <path
            d="M11 5.5a3.5 3.5 0 0 1 0 5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <path
            d="M12.5 3.5a6 6 0 0 1 0 9"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
}
