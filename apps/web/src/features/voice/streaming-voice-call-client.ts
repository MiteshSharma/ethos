import { pcm16FromBytes, pcm16ToBytes, type VoiceServerFrame } from '@ethosagent/web-contracts';
import type { EndpointerEvent } from './pcm-endpointer';
import type { VoiceCallClient, VoiceCallEvent } from './voice-call-client';
import type { VoiceTransport } from './voice-socket-transport';
import type { WakeLock } from './wake-lock';
import type { PlayoutSink } from './webaudio-playout';

// Talk-mode over the persistent binary lane — the CLIENT half.
//
// V2 (the browser/server split kill, plan §10.1): the agent turn no longer
// runs here. The server's `VoiceSession` owns VAD, endpointing, the turn and
// barge-in; this file's whole job is transport — stream mic PCM up
// continuously from `connect()` to `disconnect()`, and translate the
// `VoiceServerFrame`s that come back into `VoiceCallEvent`s. There is no
// client-decided utterance id any more: the server mints one once it commits
// an utterance, and every frame after that just carries it along for grouping.
//
// `capture` MUST be built `continuous: true` (see `createBrowserVoiceCapture`)
// — no local endpointer, every frame forwarded. A local VAD deciding what is
// speech would be a second opinion the server's `VoiceSession` never asked
// for, the same reason the realtime tier's capture is continuous already.

/** Browser-audio seam: mic in, an earcon on connect. Playout is separate. */
export interface VoiceCaptureIo {
  start(): Promise<void>;
  stop(): Promise<void>;
  micStream(): MediaStream | null;
  setMicEnabled(enabled: boolean): void;
  /** No-op in continuous mode — kept on the interface because
   *  `createBrowserVoiceCapture` implements one shape for both tiers. */
  setCaptureEnabled(enabled: boolean): void;
  /** No-op in continuous mode; see `setCaptureEnabled`. */
  setBargeInEnabled(enabled: boolean): void;
  playEarcon(): void;
  on(listener: (event: EndpointerEvent) => void): () => void;
  readonly sampleRate: number;
}

export interface StreamingVoiceCallDeps {
  transport: VoiceTransport;
  capture: VoiceCaptureIo;
  playout: PlayoutSink;
  /** Chat session this call belongs to — carried to the server for telemetry,
   *  never for driving the turn (the server runs it on its own voice lane). */
  sessionId?: () => string | null;
  /** Active personality; its declared `voice.tts_voice`/`voice.stt_provider`
   *  pick the engines this lane speaks and listens through, server-side. */
  personalityId?: string;
  chime?: boolean;
  /** Keeps the screen awake for the duration of the call. */
  wakeLock?: WakeLock;
}

const DEFAULT_TTS_SAMPLE_RATE = 24_000;

export function createStreamingVoiceCallClient(deps: StreamingVoiceCallDeps): VoiceCallClient {
  const listeners = new Set<(event: VoiceCallEvent) => void>();
  const emit = (event: VoiceCallEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };

  let seq = 0;
  let disposed = false;
  let unsubs: Array<() => void> = [];
  /** Encoded audio accumulating per segment until `segment_end` arrives. */
  const pendingEncoded = new Map<string, Uint8Array[]>();
  /** utteranceId of the last barge-in — frames still tagged with it are stale
   *  audio the server had already queued before the interrupt landed. */
  let interruptedUtteranceId: string | null = null;

  const onCaptureEvent = (event: EndpointerEvent): void => {
    if (disposed || event.type !== 'frame') return;
    deps.transport.send({ t: 'audio', seq: seq++ }, pcm16ToBytes(event.data));
  };

  const onServerFrame = (frame: VoiceServerFrame, payload: Uint8Array): void => {
    if (disposed) return;
    switch (frame.t) {
      case 'transcript': {
        const text = frame.text.trim();
        if (deps.chime !== false) {
          try {
            deps.capture.playEarcon();
          } catch {
            // Best-effort acknowledgement; never fails a turn.
          }
        }
        if (!text) {
          emit({ type: 'utterance_dropped' });
          return;
        }
        emit({
          type: 'utterance_committed',
          text,
          ...(frame.provider ? { provider: frame.provider } : {}),
        });
        return;
      }
      case 'reply_text':
        emit(
          frame.kind === 'filler'
            ? { type: 'filler', text: frame.text }
            : { type: 'reply_sentence', text: frame.text },
        );
        return;
      case 'audio': {
        if (frame.utteranceId === interruptedUtteranceId) {
          return;
        }
        if (frame.codec === 'pcm_s16le') {
          deps.playout.playPcm16(
            pcm16FromBytes(payload),
            frame.sampleRate ?? DEFAULT_TTS_SAMPLE_RATE,
          );
          return;
        }
        const parts = pendingEncoded.get(frame.segmentId) ?? [];
        parts.push(payload.slice());
        pendingEncoded.set(frame.segmentId, parts);
        return;
      }
      case 'segment_end': {
        if (frame.utteranceId === interruptedUtteranceId) {
          pendingEncoded.delete(frame.segmentId); // drop any partial accumulation from before the interrupt
          return;
        }
        const parts = pendingEncoded.get(frame.segmentId);
        pendingEncoded.delete(frame.segmentId);
        if (!parts?.length) return; // PCM: every frame was scheduled as it landed.
        void deps.playout.playEncoded(concat(parts)).catch(() => {
          // An undecodable clip loses its audio, not the conversation.
        });
        return;
      }
      case 'turn_end':
        if (frame.interrupted) {
          deps.playout.stop();
          interruptedUtteranceId = frame.utteranceId;
        }
        emit(
          frame.interrupted
            ? { type: 'interrupted', text: frame.text }
            : { type: 'reply_complete', text: frame.text },
        );
        return;
      case 'tick':
        // Non-speech keep-alive during a long tool call — the same local
        // WebAudio blip `transcript`/connect already use, reused rather than
        // shipping synthesized audio over the wire every few seconds.
        if (deps.chime !== false) {
          try {
            deps.capture.playEarcon();
          } catch {
            // Best-effort keep-alive; never fails a turn.
          }
        }
        return;
      case 'error':
        emit({
          type: 'error',
          error: frame.message,
          code: frame.code,
          ...(frame.provider ? { provider: frame.provider } : {}),
        });
        return;
      case 'ready':
        return;
    }
  };

  return {
    async connect(): Promise<void> {
      disposed = false;
      seq = 0;
      pendingEncoded.clear();
      interruptedUtteranceId = null;
      await deps.transport.connect();
      deps.transport.send({
        t: 'hello',
        sampleRate: deps.capture.sampleRate,
        ...(deps.sessionId?.() ? { sessionId: deps.sessionId() as string } : {}),
        ...(deps.personalityId ? { personalityId: deps.personalityId } : {}),
      });
      await deps.capture.start();
      void deps.wakeLock?.acquire();
      unsubs = [
        deps.transport.on(onServerFrame),
        deps.capture.on(onCaptureEvent),
        deps.transport.onStatus((status) => {
          if (status !== 'open') deps.playout.stop();
          if (status !== 'closed') emit({ type: 'link', status });
        }),
      ];
      // The session is live — say so out loud. First-run users get an audible
      // "go ahead" instead of guessing whether the mic is on.
      if (deps.chime !== false) {
        try {
          deps.capture.playEarcon();
        } catch {
          // Best-effort acknowledgement; never fails a connect.
        }
      }
    },

    async disconnect(): Promise<void> {
      if (disposed) return;
      disposed = true;
      deps.playout.stop();
      for (const unsub of unsubs) unsub();
      unsubs = [];
      deps.transport.close();
      void deps.wakeLock?.release();
      await deps.capture.stop();
    },

    setMuted(muted: boolean): void {
      deps.capture.setMicEnabled(!muted);
    },

    micStream(): MediaStream | null {
      return deps.capture.micStream();
    },

    outputLevel(): number {
      return deps.playout.outputLevel();
    },

    // No `ask`: voice-native `clarify` needs the turn parked client-side to
    // answer mid-flight, and the turn no longer runs here — it runs inside
    // `VoiceSession`/`AgentLoop` on the server. A `clarify` on this tier falls
    // back to the on-screen card, same as the realtime tier already does.

    on(listener: (event: VoiceCallEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
