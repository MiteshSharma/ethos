import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { createUnwiredVoiceCallClient, type VoiceCallClient } from './voice-call-client';
import {
  initialVoiceCallState,
  type VoiceCallStatus,
  type VoiceDegradedNotice,
  type VoiceTranscriptLine,
  voiceCallReducer,
} from './voice-call-reducer';
import { classifyVoiceStartError } from './voice-start-error';

// Drives a `VoiceCallClient` through the pure `voiceCallReducer` and owns the
// browser-only concerns the reducer deliberately excludes: the mic level meter
// (same AudioContext/analyser pattern as `useVoiceRecorder`) and mute state.
// The client is injected so the UI works against the fake in tests and the real
// `livekit-client` binding in production.

const METER_BARS = 32;

export interface UseVoiceCallOptions {
  /** Factory for the live-call client. Defaults to the unwired placeholder. */
  createClient?: () => VoiceCallClient;
}

/**
 * Wall-clock latency of the last spoken turn, in ms. Measured client-side from
 * the events the user actually experienced — mouth to ear — so the number in
 * the strip is the one the user felt, not a server-side estimate of it.
 */
export interface VoiceTurnLatency {
  /** Utterance committed → first reply sentence. The model's thinking time. */
  llmMs: number | null;
  /** First sentence → first audio out of the speaker. */
  ttsMs: number | null;
  /** Utterance committed → first audio. The number that matters. */
  totalMs: number | null;
}

export interface UseVoiceCall {
  status: VoiceCallStatus;
  transcript: VoiceTranscriptLine[];
  /** Rolling mic-level history (0..1) for the speaking indicator. */
  micLevels: number[];
  muted: boolean;
  error: string | null;
  /** Voice fell back to text. Null until it does, or once dismissed. */
  degraded: VoiceDegradedNotice | null;
  /** The browser refused the mic — render guidance, not a dead icon. */
  micDenied: boolean;
  sttProvider: string | null;
  ttsProvider: string | null;
  latency: VoiceTurnLatency;
  start: () => void;
  hangUp: () => void;
  toggleMute: () => void;
  /** Push-to-talk: mic open while held, closed on release. */
  pressToTalk: (down: boolean) => void;
  /** Clear the degraded / mic-denied notice. */
  dismissNotice: () => void;
}

const NO_LATENCY: VoiceTurnLatency = { llmMs: null, ttsMs: null, totalMs: null };

const flatLevels = () => Array.from({ length: METER_BARS }, () => 0);

export function useVoiceCall(options: UseVoiceCallOptions = {}): UseVoiceCall {
  const createClient = options.createClient ?? createUnwiredVoiceCallClient;
  const [state, dispatch] = useReducer(voiceCallReducer, initialVoiceCallState);
  const [micLevels, setMicLevels] = useState<number[]>(flatLevels);
  const [muted, setMuted] = useState(false);
  const [latency, setLatency] = useState<VoiceTurnLatency>(NO_LATENCY);
  /** Marks for the in-flight turn: when it committed, when it first spoke. */
  const turnMarks = useRef<{ committedAt: number; sentenceAt: number | null } | null>(null);

  const clientRef = useRef<VoiceCallClient | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);

  const teardownMeter = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    setMicLevels(flatLevels());
  }, []);

  const teardown = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    const client = clientRef.current;
    clientRef.current = null;
    if (client) void client.disconnect().catch(() => {});
    teardownMeter();
    setMuted(false);
  }, [teardownMeter]);

  useEffect(() => teardown, [teardown]);

  const startMeter = useCallback((stream: MediaStream) => {
    const audioCtx = new AudioContext();
    audioCtxRef.current = audioCtx;
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 64;
    source.connect(analyser);
    analyserRef.current = analyser;

    const tick = () => {
      const a = analyserRef.current;
      if (a) {
        const data = new Uint8Array(a.frequencyBinCount);
        a.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] ?? 0;
        const avg = Math.min(1, sum / data.length / 160);
        setMicLevels((prev) => {
          const next = prev.slice(1);
          next.push(avg);
          return next;
        });
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  /**
   * Stopwatch for the mouth-to-ear stages. Kept in a ref and written to state
   * only at the two points the numbers change, so the audio path never drives a
   * render per event.
   */
  const markLatency = useCallback((type: string) => {
    const at = performance.now();
    if (type === 'utterance_committed') {
      turnMarks.current = { committedAt: at, sentenceAt: null };
      setLatency(NO_LATENCY);
      return;
    }
    const marks = turnMarks.current;
    if (!marks) return;
    if (type === 'reply_sentence' && marks.sentenceAt === null) {
      marks.sentenceAt = at;
      setLatency((prev) => ({ ...prev, llmMs: Math.round(at - marks.committedAt) }));
      return;
    }
    if (type === 'reply_audio') {
      setLatency((prev) =>
        prev.totalMs !== null
          ? prev
          : {
              llmMs: prev.llmMs,
              ttsMs: marks.sentenceAt === null ? null : Math.round(at - marks.sentenceAt),
              totalMs: Math.round(at - marks.committedAt),
            },
      );
    }
  }, []);

  const start = useCallback(() => {
    if (state.status !== 'idle' && state.status !== 'ended') return;
    dispatch({ type: 'start' });

    const client = createClient();
    clientRef.current = client;
    setLatency(NO_LATENCY);
    turnMarks.current = null;
    unsubscribeRef.current = client.on((event) => {
      dispatch({ type: 'client-event', event });
      markLatency(event.type);
      if (event.type === 'disconnected') teardown();
    });

    client
      .connect()
      .then(() => {
        // A late resolve after the user already hung up must not revive the call.
        if (clientRef.current !== client) return;
        dispatch({ type: 'connected' });
        const stream = client.micStream();
        if (stream) startMeter(stream);
      })
      .catch((err: unknown) => {
        // A refused mic is guidance, not a retry — the classifier decides which.
        dispatch({ type: 'client-event', event: classifyVoiceStartError(err) });
        teardown();
        dispatch({ type: 'hang-up' });
      });
  }, [state.status, createClient, startMeter, teardown, markLatency]);

  const hangUp = useCallback(() => {
    teardown();
    dispatch({ type: 'hang-up' });
  }, [teardown]);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      clientRef.current?.setMuted(next);
      return next;
    });
  }, []);

  // Push-to-talk is mute, driven by a key instead of a button: held = open,
  // released = closed. Once the user has used it, the call stays closed between
  // presses, which is the whole point of holding a key to speak.
  const pressToTalk = useCallback((down: boolean) => {
    clientRef.current?.setMuted(!down);
    setMuted(!down);
  }, []);

  const dismissNotice = useCallback(() => dispatch({ type: 'dismiss-notice' }), []);

  return {
    status: state.status,
    transcript: state.transcript,
    micLevels,
    muted,
    error: state.error,
    degraded: state.degraded,
    micDenied: state.micDenied,
    sttProvider: state.sttProvider,
    ttsProvider: state.ttsProvider,
    latency,
    start,
    hangUp,
    toggleMute,
    pressToTalk,
    dismissNotice,
  };
}
