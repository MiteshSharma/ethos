import { message } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useVoiceRecorder } from '../../hooks/useVoiceRecorder';
import { rpc } from '../../rpc';

export function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

interface VoiceButtonProps {
  onTranscript: (text: string) => void;
  onRecordingChange?: (recording: boolean) => void;
  disabled?: boolean;
  /**
   * Something else holds the microphone — today, a live talk-mode call. The
   * button stays rendered (the composer row must not jump) but cannot arm, and
   * a capture already in flight is dropped rather than left contending for the
   * device.
   */
  micBusy?: boolean;
  accent?: string;
}

const MIC_BUSY_LABEL = 'Mic in use by the call';

export function AudioBars({ levels }: { levels: number[] }) {
  return (
    <div className="composer-voice-bars" aria-hidden="true">
      {levels.map((level, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-position audio bars never reorder
          key={i}
          className="composer-voice-bar"
          style={{ height: `${Math.max(4, level * 28)}px` }}
        />
      ))}
    </div>
  );
}

export function VoiceButton({
  onTranscript,
  onRecordingChange,
  disabled,
  micBusy,
  accent,
}: VoiceButtonProps) {
  const { isRecording, elapsedMs, audioLevels, startRecording, stopRecording, cancelRecording } =
    useVoiceRecorder();
  const [isTranscribing, setIsTranscribing] = useState(false);
  const longPressRef = useRef(false);

  // Greying the button out does not release a MediaRecorder or a getUserMedia
  // stream — only tearing the capture down does. So the moment the call takes
  // the mic, an in-flight recording is cancelled (not stopped-and-transcribed:
  // the user never released the button, so there is nothing to send).
  useEffect(() => {
    if (!micBusy) return;
    longPressRef.current = false;
    cancelRecording();
    onRecordingChange?.(false);
  }, [micBusy, cancelRecording, onRecordingChange]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled || micBusy || isTranscribing) return;
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      longPressRef.current = true;
      void startRecording();
      onRecordingChange?.(true);
    },
    [disabled, micBusy, isTranscribing, startRecording, onRecordingChange],
  );

  const handlePointerUp = useCallback(async () => {
    if (!longPressRef.current) return;
    longPressRef.current = false;
    onRecordingChange?.(false);
    const blob = await stopRecording();
    if (!blob) return;

    setIsTranscribing(true);
    try {
      const audio = await blobToBase64(blob);
      const result = await rpc.voice.transcribe({ audio, mimeType: blob.type });
      onTranscript(result.transcript);
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Transcription failed';
      const msg = raw.includes('No STT provider')
        ? 'Voice not configured — add auxiliary.asr to ~/.ethos/config.yaml'
        : raw;
      void message.error(msg);
    } finally {
      setIsTranscribing(false);
    }
  }, [stopRecording, onTranscript, onRecordingChange]);

  const handlePointerLeave = useCallback(() => {
    if (longPressRef.current) {
      longPressRef.current = false;
      cancelRecording();
      onRecordingChange?.(false);
    }
  }, [cancelRecording, onRecordingChange]);

  if (isTranscribing) {
    return (
      <button
        type="button"
        className="composer-send-btn composer-voice-btn composer-voice-transcribing"
        disabled
        aria-label="Transcribing…"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle
            cx="8"
            cy="8"
            r="6"
            stroke="white"
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
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        className={`composer-send-btn composer-voice-btn${isRecording ? ' composer-voice-recording' : ''}`}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        disabled={disabled || micBusy}
        title={micBusy ? MIC_BUSY_LABEL : undefined}
        aria-label={
          micBusy
            ? MIC_BUSY_LABEL
            : isRecording
              ? 'Recording… release to send'
              : 'Hold to record voice'
        }
        style={isRecording ? undefined : { background: accent ?? 'var(--accent)' }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="6" y="2" width="4" height="8" rx="2" stroke="white" strokeWidth="1.5" />
          <path d="M4 8a4 4 0 0 0 8 0" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
          <line
            x1="8"
            y1="13"
            x2="8"
            y2="15"
            stroke="white"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
      {isRecording && (
        <div className="composer-voice-overlay">
          <AudioBars levels={audioLevels} />
          <span className="composer-voice-timer">{formatElapsed(elapsedMs)}</span>
        </div>
      )}
    </>
  );
}
