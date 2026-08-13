import { splitSentences } from '@ethosagent/voice-text';
import { playThinkingEarcon } from './earcon';
import type { VoiceCallClient, VoiceCallEvent } from './voice-call-client';

// Turn-based, LiveKit-free browser talk-mode. A `VoiceCallClient` that runs the
// whole conversation loop in the browser using existing pieces only:
//   mic (getUserMedia) → energy-VAD endpoint → transcribe RPC → agent turn
//   (the existing chat stream) → sentence-split → synthesize RPC → playout.
//
// Everything the browser owns (getUserMedia, AudioContext VAD, MediaRecorder
// capture, <audio> playout) is behind the injectable `VoiceIoDriver` seam so the
// core loop — capture → transcribe → turn → sentence playout → barge-in — is
// unit-testable in the node vitest env with a fake driver and fake RPC deps. The
// default driver (`createBrowserVoiceIoDriver`) is the browser-only half and is
// verified manually, not in CI.

/** A single endpointed utterance captured from the mic, ready to transcribe. */
export interface UtteranceCapture {
  audioBase64: string;
  mimeType: string;
}

/**
 * Live-tunable VAD / barge-in parameters for the default browser driver. Every
 * field is a raw driver constant surfaced to the user (Settings → Voice →
 * Advanced voice tuning) so endpointing and interrupt behavior can be adjusted
 * without editing code.
 */
export interface VoiceTuning {
  /** Trailing silence (ms) that ends an utterance. */
  endpointSilenceMs: number;
  /** RMS bar during agent playout before a barge-in can fire (echo tolerance). */
  bargeThreshold: number;
  /** Sustained speech (ms) over playout before barge-in fires. */
  bargeSustainMs: number;
  /** RMS to count as speech while listening. */
  speechThreshold: number;
  /** Minimum speech (ms) before an utterance counts. */
  speechMinMs: number;
}

/**
 * The single source of truth for the driver's VAD / barge-in defaults. The
 * browser driver falls back to these per-field, and Settings/Chat import them so
 * the UI defaults never drift from the driver. The web-api ConfigService keeps a
 * byte-equal copy (it cannot import this browser module) — see
 * `VOICE_TUNING_DEFAULTS` there.
 */
export const DEFAULT_VOICE_TUNING: VoiceTuning = {
  endpointSilenceMs: 700,
  bargeThreshold: 0.06,
  bargeSustainMs: 250,
  speechThreshold: 0.02,
  speechMinMs: 150,
};

/**
 * The browser-audio boundary. The client core drives these primitives; the real
 * implementation wraps getUserMedia / AudioContext / MediaRecorder / `<audio>`.
 * Tests inject a fake so no real media APIs are touched.
 */
export interface VoiceIoDriver {
  /** Acquire the mic and start the VAD. Resolves once listening is possible. */
  start(): Promise<void>;
  /** The live mic stream for a level meter, or null before/after the call. */
  micStream(): MediaStream | null;
  /** Pause (false) / resume (true) mic capture for mute. */
  setMicEnabled(enabled: boolean): void;
  /**
   * Capture one endpointed utterance: wait for speech, then for trailing
   * silence, and resolve with its audio. Resolves `null` when `signal` aborts
   * (disconnect) before an utterance completes.
   */
  captureUtterance(signal: AbortSignal): Promise<UtteranceCapture | null>;
  /**
   * Play one synthesized clip to completion. Rejects with an AbortError if
   * `signal` aborts (barge-in / hang-up) mid-playout.
   */
  play(audioBase64: string, mimeType: string, signal: AbortSignal): Promise<void>;
  /**
   * Play a brief synthetic "processing" earcon (fire-and-forget). Acknowledges a
   * captured utterance while transcription + the agent turn run. Must be quiet
   * enough not to trip barge-in against itself.
   */
  playEarcon(): void;
  /** Fire the listener once when sustained user speech is detected over playout. */
  onBargeIn(listener: () => void): () => void;
  /** Enable barge-in monitoring (only during agent playout). */
  setBargeInEnabled(enabled: boolean): void;
  /** Stop any current playout immediately and flush the queue. */
  stopPlayback(): void;
  /** Release mic, recorder, audio context, and playout. Idempotent. */
  stop(): Promise<void>;
}

export interface SynthesizedClip {
  audioBase64: string;
  mimeType: string;
}

/** Injected dependencies — kept decoupled so the loop unit-tests with fakes. */
export interface BatchVoiceCallDeps {
  /** STT: transcribe a captured utterance. Required — no STT, no call. */
  transcribe(audioBase64: string, mimeType: string): Promise<string>;
  /**
   * TTS: synthesize a reply sentence. Optional — when absent, synthesis is
   * skipped and the reply is surfaced as text only (still a valid call).
   */
  synthesize?(text: string, voice?: string): Promise<SynthesizedClip>;
  /**
   * Run the agent turn, yielding reply text incrementally. Bound to the existing
   * chat stream so the spoken turn shares the active chat session. `signal`
   * aborts the turn on barge-in / hang-up.
   */
  runAgentTurn(text: string, signal: AbortSignal): AsyncIterable<string>;
  /** Optional TTS voice id passed through to `synthesize`. Global default —
   *  the server prefers the personality's own voice over it. */
  voice?: string;
  /**
   * Active personality. The batch path does not send it itself (its
   * `synthesize` closure owns the RPC call and already carries it); it is
   * declared here so `createTalkModeClient` can forward one set of deps to
   * either transport.
   */
  personalityId?: string;
  /**
   * Play the brief "processing" earcon after each captured utterance. Defaults
   * to true; set false (from the `display.voice_chime` config toggle) to keep
   * the thinking gap silent.
   */
  chime?: boolean;
  /**
   * Override the default driver's VAD / barge-in tuning (from the
   * `display.voice_*` config keys). Each field falls back to
   * {@link DEFAULT_VOICE_TUNING}. Ignored when `createDriver` is supplied.
   */
  tuning?: Partial<VoiceTuning>;
  /** Monotonic clock for the default driver's VAD timing. Defaults to perf clock. */
  now?: () => number;
  /** Override the browser-audio driver (tests inject a fake). */
  createDriver?: () => VoiceIoDriver;
}

/** One queued reply sentence: its text plus its in-flight synthesis. */
interface PlayItem {
  text: string;
  audio: Promise<SynthesizedClip | null>;
}

// Minimal single-consumer async queue. The producer (`runAgentTurn` loop) pushes
// sentences as they endpoint; the pump plays them in order — so sentence N plays
// while sentence N+1 is still synthesizing.
class PlayQueue {
  private items: PlayItem[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;

  push(item: PlayItem): void {
    this.items.push(item);
    const wake = this.waiters.shift();
    if (wake) wake();
  }

  close(): void {
    this.closed = true;
    for (const wake of this.waiters.splice(0)) wake();
  }

  async *stream(): AsyncGenerator<PlayItem> {
    while (true) {
      const item = this.items.shift();
      if (item) {
        yield item;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * A real, LiveKit-free {@link VoiceCallClient}. Owns one hands-free conversation:
 * listen → transcribe → agent turn → speak, looping until `disconnect()`.
 */
export function createBatchVoiceCallClient(deps: BatchVoiceCallDeps): VoiceCallClient {
  const listeners = new Set<(event: VoiceCallEvent) => void>();
  const emit = (event: VoiceCallEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };

  const driver = deps.createDriver
    ? deps.createDriver()
    : createBrowserVoiceIoDriver({ now: deps.now, tuning: deps.tuning });

  const chimeEnabled = deps.chime ?? true;
  const disconnectController = new AbortController();

  /**
   * One clip at a time. This tier has no playout scheduler — it hands a data URL
   * to an `Audio` element — so two overlapping `play()` calls are two voices
   * talking over each other. The reply pump and a spoken clarify question both
   * go through here, which is what keeps a question asked mid-turn off the top
   * of the sentence the agent said just before it. (The streaming tier gets this
   * for free: its lane serializes synthesis and its playout is absolute-time.)
   */
  let playChain: Promise<unknown> = Promise.resolve();
  const playInOrder = (clip: SynthesizedClip, signal: AbortSignal): Promise<void> => {
    const next = playChain
      .catch(() => {})
      .then(() => driver.play(clip.audioBase64, clip.mimeType, signal));
    playChain = next.catch(() => {});
    return next;
  };

  let running = false;
  let disposed = false;
  let turnController: AbortController | null = null;

  async function runTurn(text: string): Promise<void> {
    const ctrl = new AbortController();
    turnController = ctrl;
    const played: string[] = [];
    let full = '';
    let interrupted = false;

    const onBarge = (): void => {
      if (interrupted || ctrl.signal.aborted) return;
      interrupted = true;
      ctrl.abort();
      driver.stopPlayback();
    };
    driver.setBargeInEnabled(true);
    const unsubBarge = driver.onBargeIn(onBarge);

    const queue = new PlayQueue();
    const pump = (async (): Promise<void> => {
      for await (const item of queue.stream()) {
        if (ctrl.signal.aborted) break;
        let clip: SynthesizedClip | null = null;
        try {
          clip = await item.audio;
        } catch {
          clip = null;
        }
        if (clip && !ctrl.signal.aborted) {
          try {
            await playInOrder(clip, ctrl.signal);
          } catch {
            break; // aborted mid-playout (barge-in / hang-up)
          }
        }
        if (!ctrl.signal.aborted) played.push(item.text);
      }
    })();

    const enqueue = (sentence: string): void => {
      emit({ type: 'reply_sentence', text: sentence });
      const audio = deps.synthesize ? deps.synthesize(sentence, deps.voice) : Promise.resolve(null);
      queue.push({ text: sentence, audio });
    };

    try {
      let buffer = '';
      for await (const chunk of deps.runAgentTurn(text, ctrl.signal)) {
        if (ctrl.signal.aborted) break;
        full += chunk;
        buffer += chunk;
        const { sentences, rest } = splitSentences(buffer);
        buffer = rest;
        for (const sentence of sentences) enqueue(sentence);
      }
      const tail = buffer.trim();
      if (tail && !ctrl.signal.aborted) enqueue(tail);
    } catch (err) {
      if (!interrupted && !ctrl.signal.aborted && !disposed) {
        emit({ type: 'error', error: errorText(err, 'Agent turn failed') });
      }
    } finally {
      queue.close();
      await pump;
      unsubBarge();
      driver.setBargeInEnabled(false);
      turnController = null;
      if (!disposed) {
        if (interrupted) emit({ type: 'interrupted', text: played.join(' ') });
        else emit({ type: 'reply_complete', text: full.trim() });
      }
    }
  }

  /**
   * Speak a clarify question and hear the answer, without ending the turn that
   * asked it — the batch tier's half of the `VoiceCallClient.ask` contract.
   *
   * The turn is parked inside the `clarify` tool, which parks `runTurn`, which
   * parks `loop()`: nothing else is capturing or playing, so the question uses
   * the same synthesize → play → capture → transcribe primitives a turn does.
   * Barge-in is the one thing that has to move: it is armed for the whole turn,
   * and here there is no reply to interrupt — a barge would abort the very turn
   * the card is waiting on.
   *
   * Null for every "this cannot happen": no TTS configured, synthesis or
   * playout or transcription failed, the call hung up, or the caller aborted
   * because the card was answered on screen first.
   */
  async function askClarify(question: string, signal: AbortSignal): Promise<string | null> {
    const synthesize = deps.synthesize;
    // No TTS on this call means the question has no voice at all — which is
    // exactly what a null tells the caller.
    if (disposed || signal.aborted || !synthesize) return null;

    // One signal for "the ask is over", so a hang-up releases the capture the
    // same way the caller's abort does.
    const linked = new AbortController();
    const abortLinked = (): void => linked.abort();
    signal.addEventListener('abort', abortLinked, { once: true });
    disconnectController.signal.addEventListener('abort', abortLinked, { once: true });

    driver.setBargeInEnabled(false);
    // Captioned like any other spoken line — the strip and the transcript are
    // how a listener who missed the audio still sees what was asked.
    emit({ type: 'reply_sentence', text: question });
    try {
      const clip = await synthesize(question, deps.voice);
      if (linked.signal.aborted || disposed) return null;
      // Behind whatever the agent was already saying when it asked.
      await playInOrder(clip, linked.signal);
      if (linked.signal.aborted || disposed) return null;
      // The question has been said; the floor goes back to the user.
      emit({ type: 'reply_complete', text: question });
      const capture = await driver.captureUtterance(linked.signal);
      if (!capture || disposed) return null;
      emit({ type: 'speech_end' });
      const text = (await deps.transcribe(capture.audioBase64, capture.mimeType)).trim();
      if (!text || disposed) {
        emit({ type: 'utterance_dropped' });
        return null;
      }
      emit({ type: 'utterance_committed', text });
      return text;
    } catch {
      // Nothing was heard or nothing was understood. The turn is untouched and
      // the card is still the way to answer it.
      return null;
    } finally {
      signal.removeEventListener('abort', abortLinked);
      disconnectController.signal.removeEventListener('abort', abortLinked);
      // Hand barge-in back to the turn, unless the call is already over.
      if (!disposed && turnController) driver.setBargeInEnabled(true);
    }
  }

  async function loop(): Promise<void> {
    while (running && !disposed) {
      let capture: UtteranceCapture | null;
      try {
        capture = await driver.captureUtterance(disconnectController.signal);
      } catch {
        break;
      }
      if (!capture || disposed) break;

      // The utterance endpointed: the user is done and the system is working.
      // The audible half of that is the earcon below; this is the visible half,
      // and it fires now rather than after the transcribe round trip.
      emit({ type: 'speech_end' });

      // Acknowledge the captured utterance the instant it endpoints, covering
      // the transcribe → LLM → first-audio gap. Fire-and-forget: never blocks or
      // fails the turn. Gated by the `chime` dep (display.voice_chime toggle).
      if (chimeEnabled) {
        try {
          driver.playEarcon();
        } catch {
          // best-effort acknowledgement
        }
      }

      let transcript: string;
      try {
        transcript = (await deps.transcribe(capture.audioBase64, capture.mimeType)).trim();
      } catch (err) {
        emit({ type: 'error', error: errorText(err, 'Transcription failed') });
        emit({ type: 'utterance_dropped' });
        continue;
      }
      if (disposed) break;
      if (!transcript) {
        // Heard something, understood nothing. The loop goes straight back to
        // listening, so the UI must too.
        emit({ type: 'utterance_dropped' });
        continue;
      }

      emit({ type: 'utterance_committed', text: transcript });
      await runTurn(transcript);
    }
  }

  return {
    async connect(): Promise<void> {
      await driver.start();
      running = true;
      void loop();
    },
    async disconnect(): Promise<void> {
      if (disposed) return;
      disposed = true;
      running = false;
      disconnectController.abort();
      turnController?.abort();
      driver.stopPlayback();
      await driver.stop();
    },
    setMuted(muted: boolean): void {
      driver.setMicEnabled(!muted);
    },
    micStream(): MediaStream | null {
      return driver.micStream();
    },
    ask: askClarify,
    on(listener: (event: VoiceCallEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Default browser driver — the browser-only half. Verified manually (no
// getUserMedia / AudioContext / MediaRecorder in the node vitest env), so tests
// inject a fake driver and never construct this.
// ---------------------------------------------------------------------------

function blobToBase64(blob: Blob): Promise<string> {
  // Local copy (not the antd/rpc-coupled one in VoiceButton) so this module's
  // testable core keeps a clean, dependency-light import graph.
  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  });
}

function pickRecorderMime(): string {
  const prefs = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  return prefs.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

/**
 * The production {@link VoiceIoDriver}: energy-VAD endpointing over an
 * AudioContext analyser, MediaRecorder capture, and `<audio>` playout.
 * echoCancellation on the mic keeps the agent's own audio from re-triggering the
 * VAD, and barge-in uses a higher threshold during playout as a second guard.
 */
export function createBrowserVoiceIoDriver(
  opts: { now?: () => number; tuning?: Partial<VoiceTuning> } = {},
): VoiceIoDriver {
  const now =
    opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));

  const tuning = opts.tuning ?? {};
  // RMS to count as speech while listening.
  const SPEECH_THRESHOLD = tuning.speechThreshold ?? DEFAULT_VOICE_TUNING.speechThreshold;
  // Higher bar during playout (echo tolerance).
  const BARGE_THRESHOLD = tuning.bargeThreshold ?? DEFAULT_VOICE_TUNING.bargeThreshold;
  // Trailing silence that ends an utterance.
  const SILENCE_MS = tuning.endpointSilenceMs ?? DEFAULT_VOICE_TUNING.endpointSilenceMs;
  // Minimum speech before an utterance counts.
  const SPEECH_MIN_MS = tuning.speechMinMs ?? DEFAULT_VOICE_TUNING.speechMinMs;
  // Sustained speech before barge-in fires.
  const BARGE_SUSTAIN_MS = tuning.bargeSustainMs ?? DEFAULT_VOICE_TUNING.bargeSustainMs;

  let stream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let micEnabled = true;
  let bargeEnabled = false;
  let bargeTimer: ReturnType<typeof setInterval> | null = null;
  let currentAudio: HTMLAudioElement | null = null;
  const bargeListeners = new Set<() => void>();

  const rms = (): number => {
    const node = analyser;
    if (!node) return 0;
    const data = new Uint8Array(node.fftSize);
    node.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const centered = (data[i] ?? 128) / 128 - 1;
      sum += centered * centered;
    }
    return Math.sqrt(sum / data.length);
  };

  return {
    async start(): Promise<void> {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
    },

    micStream(): MediaStream | null {
      return stream;
    },

    setMicEnabled(enabled: boolean): void {
      micEnabled = enabled;
      if (stream) for (const track of stream.getAudioTracks()) track.enabled = enabled;
    },

    captureUtterance(signal: AbortSignal): Promise<UtteranceCapture | null> {
      return new Promise<UtteranceCapture | null>((resolve) => {
        const active = stream;
        if (signal.aborted || !active) {
          resolve(null);
          return;
        }
        const mimeType = pickRecorderMime();
        const recorder = new MediaRecorder(active, mimeType ? { mimeType } : undefined);
        const chunks: Blob[] = [];
        let speaking = false;
        let speechStartedAt = 0;
        let lastVoiceAt = 0;
        let settled = false;

        const finish = (deliver: boolean): void => {
          if (settled) return;
          settled = true;
          clearInterval(monitor);
          signal.removeEventListener('abort', onAbort);
          if (!deliver) {
            if (recorder.state !== 'inactive') recorder.stop();
            resolve(null);
            return;
          }
          recorder.onstop = () => {
            const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
            void blobToBase64(blob).then((audioBase64) =>
              resolve({ audioBase64, mimeType: blob.type }),
            );
          };
          if (recorder.state !== 'inactive') recorder.stop();
        };

        const onAbort = (): void => finish(false);
        signal.addEventListener('abort', onAbort, { once: true });

        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };
        recorder.start(100);

        const monitor = setInterval(() => {
          if (!micEnabled) return;
          const level = rms();
          const t = now();
          if (level > SPEECH_THRESHOLD) {
            if (!speaking) {
              speaking = true;
              speechStartedAt = t;
            }
            lastVoiceAt = t;
          } else if (
            speaking &&
            t - lastVoiceAt > SILENCE_MS &&
            t - speechStartedAt > SPEECH_MIN_MS
          ) {
            finish(true);
          }
        }, 50);
      });
    },

    play(audioBase64: string, mimeType: string, signal: AbortSignal): Promise<void> {
      if (signal.aborted) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const audio = new Audio(`data:${mimeType};base64,${audioBase64}`);
        currentAudio = audio;
        const cleanup = (): void => {
          signal.removeEventListener('abort', onAbort);
          if (currentAudio === audio) currentAudio = null;
        };
        const onAbort = (): void => {
          audio.pause();
          cleanup();
          reject(new DOMException('playout aborted', 'AbortError'));
        };
        audio.onended = () => {
          cleanup();
          resolve();
        };
        audio.onerror = () => {
          cleanup();
          resolve();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        void audio.play().catch(() => {
          cleanup();
          resolve();
        });
      });
    },

    playEarcon(): void {
      if (!audioCtx) audioCtx = new AudioContext();
      playThinkingEarcon(audioCtx);
    },

    onBargeIn(listener: () => void): () => void {
      bargeListeners.add(listener);
      return () => {
        bargeListeners.delete(listener);
      };
    },

    setBargeInEnabled(enabled: boolean): void {
      bargeEnabled = enabled;
      if (enabled && !bargeTimer) {
        let sustained = 0;
        bargeTimer = setInterval(() => {
          if (!bargeEnabled || !micEnabled) {
            sustained = 0;
            return;
          }
          if (rms() > BARGE_THRESHOLD) {
            sustained += 80;
            if (sustained >= BARGE_SUSTAIN_MS) {
              sustained = 0;
              for (const listener of [...bargeListeners]) listener();
            }
          } else {
            sustained = 0;
          }
        }, 80);
      } else if (!enabled && bargeTimer) {
        clearInterval(bargeTimer);
        bargeTimer = null;
      }
    },

    stopPlayback(): void {
      if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
      }
    },

    async stop(): Promise<void> {
      if (bargeTimer) {
        clearInterval(bargeTimer);
        bargeTimer = null;
      }
      if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
      }
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
        stream = null;
      }
      if (audioCtx) {
        await audioCtx.close().catch(() => {});
        audioCtx = null;
      }
      analyser = null;
    },
  };
}
