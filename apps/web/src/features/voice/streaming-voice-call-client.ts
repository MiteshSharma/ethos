import { splitSentences } from '@ethosagent/voice-text';
import { pcm16FromBytes, pcm16ToBytes, type VoiceServerFrame } from '@ethosagent/web-contracts';
import type { EndpointerEvent } from './pcm-endpointer';
import type { VoiceCallClient, VoiceCallEvent } from './voice-call-client';
import type { VoiceTransport } from './voice-socket-transport';
import type { WakeLock } from './wake-lock';
import type { PlayoutSink } from './webaudio-playout';

// Talk-mode over the persistent binary lane.
//
// Same conversation as `createBatchVoiceCallClient` — listen, transcribe, run
// the turn, speak, interruptible — but the audio never becomes base64 in a JSON
// body and never waits for a whole clip: mic PCM streams up as it is captured,
// reply audio streams down and is scheduled on the audio clock as it lands.
//
// The discipline that makes it safe is the utterance id. Every transcript and
// every audio frame carries the id of the utterance it answers, and anything
// whose utterance has been superseded — by barge-in, or simply by the user
// speaking again — is DROPPED rather than played. Without it, a reply the user
// already abandoned arrives late and speaks over the conversation that replaced
// it.

/** Browser-audio seam: mic in, endpointing, earcon. Playout is separate. */
export interface VoiceCaptureIo {
  start(): Promise<void>;
  stop(): Promise<void>;
  micStream(): MediaStream | null;
  setMicEnabled(enabled: boolean): void;
  /** Gate utterance capture (off while the agent speaks). */
  setCaptureEnabled(enabled: boolean): void;
  /** Watch for the user talking over the agent. */
  setBargeInEnabled(enabled: boolean): void;
  playEarcon(): void;
  on(listener: (event: EndpointerEvent) => void): () => void;
  readonly sampleRate: number;
}

export interface StreamingVoiceCallDeps {
  transport: VoiceTransport;
  capture: VoiceCaptureIo;
  playout: PlayoutSink;
  /** Runs the agent turn on the existing chat session (same runner as batch). */
  runAgentTurn(text: string, signal: AbortSignal): AsyncIterable<string>;
  /** Chat session this call belongs to — carried to the server for telemetry. */
  sessionId?: () => string | null;
  /** Global default voice from Settings — LOWEST precedence server-side. */
  voice?: string;
  /** Active personality; its declared `voice.tts_voice` beats `voice` above,
   *  and its `voice.stt_provider` picks which engine transcribes it. */
  personalityId?: string;
  chime?: boolean;
  /** Keeps the screen awake for the duration of the call. */
  wakeLock?: WakeLock;
  newUtteranceId?: () => string;
}

/** A reply sentence and when its audio is scheduled to finish. */
interface Segment {
  id: string;
  text: string;
  endsAt: number | null;
}

const DEFAULT_TTS_SAMPLE_RATE = 24_000;

/** `reply_audio` here is a provider announcement, not a carrier of samples. */
const EMPTY_AUDIO = new Uint8Array(0);

export function createStreamingVoiceCallClient(deps: StreamingVoiceCallDeps): VoiceCallClient {
  const listeners = new Set<(event: VoiceCallEvent) => void>();
  const emit = (event: VoiceCallEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };
  const nextId = deps.newUtteranceId ?? defaultUtteranceId();

  let activeUtteranceId: string | null = null;
  let seq = 0;
  let turnController: AbortController | null = null;
  let segments: Segment[] = [];
  /** Encoded audio accumulating per segment until `segment_end` arrives. */
  const pendingEncoded = new Map<string, Uint8Array[]>();
  let disposed = false;
  let unsubs: Array<() => void> = [];
  /** Last TTS provider announced to the UI; re-announced only when it changes. */
  let announcedTtsProvider: string | null = null;

  /** Everything tied to the current utterance goes away together. */
  const discardUtterance = (): void => {
    turnController?.abort();
    turnController = null;
    activeUtteranceId = null;
    segments = [];
    pendingEncoded.clear();
    deps.playout.stop();
  };

  const isStale = (utteranceId: string): boolean => disposed || utteranceId !== activeUtteranceId;

  const startUtterance = (): void => {
    const previous = activeUtteranceId;
    if (previous) {
      // The user started over. Tell the server to stop working on the old one
      // so its results are never sent, and drop whatever is already queued.
      deps.transport.send({ t: 'cancel', utteranceId: previous, reason: 'superseded' });
      discardUtterance();
    }
    const id = nextId();
    activeUtteranceId = id;
    seq = 0;
    deps.transport.send({
      t: 'utterance_start',
      utteranceId: id,
      sampleRate: deps.capture.sampleRate,
      // The same personality that picks the voice picks the ear: the server
      // resolves this utterance's STT entry from its `voice.stt_provider`.
      ...(deps.personalityId ? { personalityId: deps.personalityId } : {}),
    });
  };

  const onCaptureEvent = (event: EndpointerEvent): void => {
    if (disposed) return;
    switch (event.type) {
      case 'speech_start':
        startUtterance();
        return;
      case 'frame': {
        const id = activeUtteranceId;
        if (!id) return;
        deps.transport.send({ t: 'audio', utteranceId: id, seq: seq++ }, pcm16ToBytes(event.data));
        return;
      }
      case 'speech_end': {
        const id = activeUtteranceId;
        if (!id) return;
        deps.transport.send({ t: 'utterance_end', utteranceId: id });
        // Say so BEFORE the earcon and long before the transcript: the user has
        // stopped and the system is working, and the UI should not still be
        // claiming it is listening for the whole STT round trip.
        emit({ type: 'speech_end' });
        if (deps.chime !== false) {
          try {
            deps.capture.playEarcon();
          } catch {
            // Best-effort acknowledgement; never fails a turn.
          }
        }
        return;
      }
      case 'barge_in':
        onBargeIn();
        return;
    }
  };

  const onBargeIn = (): void => {
    const id = activeUtteranceId;
    const controller = turnController;
    if (!id || !controller) return;
    const played = segments
      .filter((segment) => segment.endsAt !== null && segment.endsAt <= deps.playout.now())
      .map((segment) => segment.text);
    deps.transport.send({ t: 'cancel', utteranceId: id, reason: 'barge_in' });
    discardUtterance();
    deps.capture.setBargeInEnabled(false);
    deps.capture.setCaptureEnabled(true);
    emit({ type: 'interrupted', text: played.join(' ') });
  };

  const onServerFrame = (frame: VoiceServerFrame, payload: Uint8Array): void => {
    if (disposed) return;
    switch (frame.t) {
      case 'transcript': {
        if (isStale(frame.utteranceId) || !frame.final) return;
        const text = frame.text.trim();
        if (!text) {
          // Heard something, understood nothing. The call keeps listening, so
          // the UI has to stop thinking about it.
          emit({ type: 'utterance_dropped' });
          return;
        }
        emit({
          type: 'utterance_committed',
          text,
          ...(frame.provider ? { provider: frame.provider } : {}),
        });
        void runTurn(frame.utteranceId, text);
        return;
      }
      case 'audio': {
        if (isStale(frame.utteranceId)) return;
        // Announce WHICH provider is speaking — once, not per frame. Audio
        // frames arrive faster than any UI needs to re-render, so this fires
        // only when the answer changes.
        if (frame.provider && frame.provider !== announcedTtsProvider) {
          announcedTtsProvider = frame.provider;
          emit({
            type: 'reply_audio',
            audio: EMPTY_AUDIO,
            format: frame.codec === 'pcm_s16le' ? 'pcm' : 'opus',
            provider: frame.provider,
          });
        }
        if (frame.codec === 'pcm_s16le') {
          const endsAt = deps.playout.playPcm16(
            pcm16FromBytes(payload),
            frame.sampleRate ?? DEFAULT_TTS_SAMPLE_RATE,
          );
          markSegmentEnd(frame.segmentId, endsAt);
          return;
        }
        const parts = pendingEncoded.get(frame.segmentId) ?? [];
        parts.push(payload.slice());
        pendingEncoded.set(frame.segmentId, parts);
        return;
      }
      case 'segment_end': {
        const parts = pendingEncoded.get(frame.segmentId);
        pendingEncoded.delete(frame.segmentId);
        if (isStale(frame.utteranceId) || !parts?.length) return;
        const utteranceId = frame.utteranceId;
        const segmentId = frame.segmentId;
        void deps.playout
          .playEncoded(concat(parts))
          .then((endsAt) => {
            if (!isStale(utteranceId)) markSegmentEnd(segmentId, endsAt);
          })
          .catch(() => {
            // An undecodable clip loses its audio, not the conversation: the
            // segment is marked done so the turn can still complete.
            if (!isStale(utteranceId)) markSegmentEnd(segmentId, deps.playout.now());
          });
        return;
      }
      case 'dropped':
        // The server confirming what this client already decided. Only act when
        // it drops the utterance we are still on (capture overrun), by handing
        // the call back to a fresh listen.
        if (frame.utteranceId === activeUtteranceId && frame.reason === 'too_large') {
          discardUtterance();
          deps.capture.setCaptureEnabled(true);
          emit({ type: 'utterance_dropped' });
        }
        return;
      case 'error': {
        if (frame.utteranceId && isStale(frame.utteranceId)) return;
        emit({
          type: 'error',
          error: frame.message,
          code: frame.code,
          ...(frame.provider ? { provider: frame.provider } : {}),
        });
        if (frame.utteranceId === activeUtteranceId) {
          discardUtterance();
          deps.capture.setBargeInEnabled(false);
          deps.capture.setCaptureEnabled(true);
          // Back to listening. A degrading code has already ended the call by
          // now, and the reducer only reverses a `thinking` — so this reaches
          // exactly the recoverable errors that leave the call running.
          emit({ type: 'utterance_dropped' });
        }
        return;
      }
      case 'ready':
        return;
    }
  };

  /** Resolved once every enqueued segment has been handed to the playout clock. */
  let scheduledWaiter: (() => void) | null = null;

  const markSegmentEnd = (segmentId: string, endsAt: number): void => {
    const segment = segments.find((s) => s.id === segmentId);
    if (segment) segment.endsAt = endsAt;
    if (segments.every((s) => s.endsAt !== null)) {
      const wake = scheduledWaiter;
      scheduledWaiter = null;
      wake?.();
    }
  };

  async function runTurn(utteranceId: string, text: string): Promise<void> {
    const controller = new AbortController();
    turnController = controller;
    segments = [];
    // The mic stops opening new utterances while the agent speaks; barge-in is
    // the only way in, which is what keeps the agent's own audio from being
    // captured as the user's next turn.
    deps.capture.setCaptureEnabled(false);
    deps.capture.setBargeInEnabled(true);

    let full = '';
    let buffer = '';
    let segmentIndex = 0;
    const enqueue = (sentence: string): void => {
      const id = `s${segmentIndex++}`;
      segments.push({ id, text: sentence, endsAt: null });
      emit({ type: 'reply_sentence', text: sentence });
      deps.transport.send({
        t: 'synthesize',
        utteranceId,
        segmentId: id,
        text: sentence,
        ...(deps.voice ? { voice: deps.voice } : {}),
        ...(deps.personalityId ? { personalityId: deps.personalityId } : {}),
      });
    };

    try {
      for await (const chunk of deps.runAgentTurn(text, controller.signal)) {
        if (controller.signal.aborted || isStale(utteranceId)) return;
        full += chunk;
        buffer += chunk;
        const { sentences, rest } = splitSentences(buffer);
        buffer = rest;
        for (const sentence of sentences) enqueue(sentence);
      }
      const tail = buffer.trim();
      if (tail && !controller.signal.aborted && !isStale(utteranceId)) enqueue(tail);
    } catch (err) {
      if (!controller.signal.aborted && !isStale(utteranceId)) {
        emit({ type: 'error', error: errorText(err, 'Agent turn failed') });
      }
      return;
    }

    await waitForPlayout(utteranceId, controller.signal);
    if (controller.signal.aborted || isStale(utteranceId)) return;

    turnController = null;
    activeUtteranceId = null;
    segments = [];
    deps.capture.setBargeInEnabled(false);
    deps.capture.setCaptureEnabled(true);
    emit({ type: 'reply_complete', text: full.trim() });
  }

  /**
   * Wait for the reply's audio to actually finish: first until every sentence
   * has been placed on the playout timeline, then until that timeline runs out.
   * Both waits are event-driven — the last synthesis frame wakes the first, the
   * audio clock wakes the second. Nothing here polls.
   */
  async function waitForPlayout(utteranceId: string, signal: AbortSignal): Promise<void> {
    if (segments.some((segment) => segment.endsAt === null)) {
      await new Promise<void>((resolve) => {
        scheduledWaiter = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      scheduledWaiter = null;
    }
    if (signal.aborted || isStale(utteranceId)) return;
    await deps.playout.whenIdle();
  }

  return {
    async connect(): Promise<void> {
      disposed = false;
      await deps.transport.connect();
      deps.transport.send({
        t: 'hello',
        ...(deps.sessionId?.() ? { sessionId: deps.sessionId() as string } : {}),
      });
      await deps.capture.start();
      void deps.wakeLock?.acquire();
      unsubs = [
        deps.transport.on(onServerFrame),
        deps.capture.on(onCaptureEvent),
        deps.transport.onStatus((status) => {
          // A dropped link discards the in-flight utterance outright: half a
          // captured utterance cannot be resumed honestly, so the call returns
          // to a fresh listening state when the socket comes back.
          if (status !== 'open' && activeUtteranceId) {
            discardUtterance();
            deps.capture.setBargeInEnabled(false);
            deps.capture.setCaptureEnabled(true);
          }
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
      const id = activeUtteranceId;
      if (id) deps.transport.send({ t: 'cancel', utteranceId: id, reason: 'hangup' });
      discardUtterance();
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

    on(listener: (event: VoiceCallEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function defaultUtteranceId(): () => string {
  let n = 0;
  const prefix = Math.random().toString(36).slice(2, 8);
  return () => `${prefix}-${++n}`;
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

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
