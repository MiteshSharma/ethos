import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { watchReducedMotion } from '../../lib/reduced-motion';
import { createMicMeter } from './mic-meter';
import { createUnwiredVoiceCallClient, type VoiceCallClient } from './voice-call-client';
import {
  initialVoiceCallState,
  isTerminalClientEvent,
  type VoiceCallStatus,
  type VoiceDegradedNotice,
  type VoiceTranscriptLine,
  voiceCallReducer,
} from './voice-call-reducer';
import { classifyVoiceStartError } from './voice-start-error';

// Drives a `VoiceCallClient` through the pure `voiceCallReducer` and owns the
// browser-only concerns the reducer deliberately excludes: the mic level meter
// (same AudioContext/analyser pattern as `useVoiceRecorder`) and mute state.
// The client is injected so the UI works against the fake in tests and against
// `createTalkModeClient` (realtime or pipeline tier) in production.

const METER_BARS = 32;

/** What the hook hands a client factory so the client can report back. */
export interface VoiceCallClientHooks {
  /**
   * Which tier this call settled on. The TRANSPORT decides — realtime only runs
   * when a token was actually minted AND the provider socket actually opened —
   * so the reducer is told rather than asked, and the strip's tier label can
   * never claim a tier that did not run.
   */
  onTier(tier: 'pipeline' | 'realtime'): void;
}

export interface UseVoiceCallOptions {
  /** Factory for the live-call client. Defaults to the unwired placeholder. */
  createClient?: (hooks: VoiceCallClientHooks) => VoiceCallClient;
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
  /**
   * The agent's own smoothed output level (0..1), READ per animation frame by
   * the call overlay's canvas.
   *
   * A getter rather than a value on purpose. `micLevels` is state because the
   * strip's bars are React-rendered; the overlay draws itself, so publishing a
   * number 60 times a second through `useState` would re-render the whole Chat
   * page per frame for a canvas that never reads props. Stable identity, so it
   * can sit in an effect's dependency list without restarting the loop.
   */
  agentLevel: () => number;
  muted: boolean;
  error: string | null;
  /** Voice fell back to text. Null until it does, or once dismissed. */
  degraded: VoiceDegradedNotice | null;
  /** Voice works, but not on the configured tier. Null until it happens. */
  notice: string | null;
  /** The sign-off spoken when the call hit its spending limit. Null otherwise. */
  windDown: string | null;
  /** Which tier is serving this call. Null until the transport decides. */
  tier: 'pipeline' | 'realtime' | null;
  /** The browser refused the mic — render guidance, not a dead icon. */
  micDenied: boolean;
  sttProvider: string | null;
  ttsProvider: string | null;
  latency: VoiceTurnLatency;
  /**
   * Speak a question through the live call and return the answer the user
   * speaks — what makes the `clarify` tool voice-native.
   *
   * Resolves null when there is no call, when the serving tier cannot speak, or
   * when `signal` aborts. All three mean the same thing to the caller: keep the
   * on-screen affordance, because nothing was asked out loud.
   */
  ask: (question: string, signal: AbortSignal) => Promise<string | null>;
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
  const stopMeterRef = useRef<(() => void) | null>(null);
  /**
   * The OS reduced-motion preference, kept in a ref because the meter loop
   * reads it per frame and must not re-subscribe (or re-render) to notice a
   * change. Subscribed once for the life of the hook, not per call.
   */
  const reducedMotionRef = useRef(false);
  useEffect(
    () =>
      watchReducedMotion((reduced) => {
        reducedMotionRef.current = reduced;
      }),
    [],
  );

  const teardownMeter = useCallback(() => {
    stopMeterRef.current?.();
    stopMeterRef.current = null;
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
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

    // The loop lives in `mic-meter.ts` — including the reduced-motion freeze,
    // which CSS structurally cannot deliver for bars that are redrawn from JS
    // every frame.
    stopMeterRef.current = createMicMeter({
      analyser,
      bars: METER_BARS,
      onLevels: setMicLevels,
      reducedMotion: () => reducedMotionRef.current,
      requestFrame: (cb) => requestAnimationFrame(cb),
      cancelFrame: (handle) => cancelAnimationFrame(handle),
    });
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

    const client = createClient({ onTier: (tier) => dispatch({ type: 'tier', tier }) });
    clientRef.current = client;
    setLatency(NO_LATENCY);
    turnMarks.current = null;
    unsubscribeRef.current = client.on((event) => {
      dispatch({ type: 'client-event', event });
      markLatency(event.type);
      // EVERY route to a terminal state releases the mic, not just the
      // transport-level one. A degrade or a refused mic ends the call in the
      // reducer, and a call that has visibly ended must not still be capturing:
      // the dispatch above is already queued, so tearing down here drops the
      // capture path without touching the notice the strip is about to render.
      if (isTerminalClientEvent(event)) teardown();
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

  // Read through the ref for the same reason `agentLevel` does — and because
  // that ref is null unless a call is actually up, which is what makes "no
  // call" resolve null without the caller having to check first.
  const ask = useCallback(
    (question: string, signal: AbortSignal): Promise<string | null> =>
      clientRef.current?.ask?.(question, signal) ?? Promise.resolve(null),
    [],
  );

  // Read through the ref, so a hung-up call reads zero rather than whatever the
  // last graph was holding.
  const agentLevel = useCallback(() => clientRef.current?.outputLevel?.() ?? 0, []);

  return {
    status: state.status,
    transcript: state.transcript,
    micLevels,
    agentLevel,
    muted,
    error: state.error,
    degraded: state.degraded,
    notice: state.notice,
    windDown: state.windDown,
    tier: state.tier,
    micDenied: state.micDenied,
    sttProvider: state.sttProvider,
    ttsProvider: state.ttsProvider,
    latency,
    ask,
    start,
    hangUp,
    toggleMute,
    pressToTalk,
    dismissNotice,
  };
}
