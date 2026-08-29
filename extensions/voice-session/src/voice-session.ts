// VoiceSession — a streaming orchestrator over the existing AgentLoop.
//
// It owns one live conversation: inbound PCM -> VAD -> endpoint detection ->
// committed utterance -> STT -> runner.run() -> SentenceChunker -> TTS ->
// playout queue, with barge-in that aborts the turn and persists an honest
// (interrupted) reply. Pure orchestration over injected dependencies — no
// SessionStore, SQLite, gateway, or filesystem coupling (that is Phase B).

import type {
  Logger,
  PcmChunk,
  StreamingSttProvider,
  SttProvider,
  TtsProvider,
} from '@ethosagent/types';
import { isStreamingSttProvider, isStreamingTtsProvider } from '@ethosagent/types';
import { isHallucination, SentenceChunker } from '@ethosagent/voice-text';
import { createBufferedSttAdapter } from './buffered-stt';
import { EndpointDetector } from './endpoint-detector';
import { PlayoutQueue } from './playout-queue';
import type { BufferedVoiceSpanWriter, VoiceSpanStage } from './span-writer';
import type {
  AgentTurnRunner,
  AudioFormat,
  Vad,
  VoiceSessionConfig,
  VoiceSessionEvent,
  VoiceSessionState,
} from './types';
import { DEFAULT_VOICE_FILLER_TEXT } from './types';

export interface VoiceSessionDeps {
  runner: AgentTurnRunner;
  stt: SttProvider;
  tts: TtsProvider;
  vad: Vad;
  config?: VoiceSessionConfig;
  /** Clock source; defaults to performance.now. Inject for deterministic tests. */
  now?: () => number;
  logger?: Logger;
  /**
   * Per-turn latency spans. Buffered by contract (see BufferedVoiceSpanWriter):
   * `record()` only appends, so instrumenting the audio path costs an array
   * push. Omit to run uninstrumented.
   */
  spans?: BufferedVoiceSpanWriter;
  /** Lane/session this conversation belongs to; stamped on every span. */
  laneKey?: string;
  /**
   * Timer seam for the tool-call filler debounce and tick interval. Same
   * pattern as `RealtimeControlLane` (`apps/web-api/src/voice/realtime-control-lane.ts`)
   * — a handle `clearTimer` understands, defaulting to real `setTimeout`.
   * Inject a hand-driven fake for deterministic tests.
   */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

type Listener = (event: VoiceSessionEvent) => void;

export class VoiceSession {
  private readonly runner: AgentTurnRunner;
  private readonly stt: StreamingSttProvider;
  private readonly tts: TtsProvider;
  private readonly vad: Vad;
  private readonly config: VoiceSessionConfig;
  private readonly now: () => number;
  private readonly logger?: Logger;
  private readonly endpoint: EndpointDetector;
  private readonly playout: PlayoutQueue;

  private readonly spans: BufferedVoiceSpanWriter | undefined;
  private readonly laneKey: string | undefined;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private listeners: Listener[] = [];
  private state: VoiceSessionState = 'idle';
  private utteranceChunks: PcmChunk[] = [];
  private turnController: AbortController | null = null;
  private currentTurn: Promise<void> | null = null;
  private lastReplyTextValue = '';
  private utteranceSeq = 0;
  private currentTurnId = '';
  private currentTurnStart = 0;
  private firstAudioSpanned = false;
  private segmentSeq = 0;
  /**
   * The id of the segment currently draining through playout — i.e. the one
   * that has actually emitted `reply_audio` chunks, as opposed to one merely
   * queued/prefetching. This is what `bargeIn()` closes: a segment only ever
   * closes on ITS OWN completion (natural or interrupted), never because a
   * later segment's `reply_sentence` happened to arrive first.
   */
  private playingSegmentId: string | null = null;

  /** Previous frame's VAD speech flag. Drives the rising-edge gate on
   *  `bargeIn()` (only silence->speech should interrupt, never a continuing
   *  speech-positive frame). */
  private lastSpeechState = false;

  // Tool-call filler/tick state (see `onToolStart`/`onToolEnd`). Reset at the
  // top of every `runTurn`; a live count because tools can run in parallel
  // (`ToolRegistry.executeParallel`), not a boolean.
  private toolsInFlight = 0;
  private hasSpokenTextThisTurn = false;
  private fillerSpokenThisTurn = false;
  private fillerTimerHandle: unknown = null;
  private tickTimerHandle: unknown = null;

  constructor(deps: VoiceSessionDeps) {
    this.runner = deps.runner;
    this.tts = deps.tts;
    this.vad = deps.vad;
    this.config = deps.config ?? {};
    this.now = deps.now ?? (() => performance.now());
    this.logger = deps.logger;
    this.spans = deps.spans;
    this.laneKey = deps.laneKey;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as never));
    this.stt = this.resolveStt(deps.stt);
    this.endpoint = new EndpointDetector({
      silenceMs: this.config.endpointSilenceMs ?? 400,
      now: this.now,
    });
    this.playout = new PlayoutQueue({
      onAudio: (audio, format, id) => {
        if (!this.firstAudioSpanned) {
          this.firstAudioSpanned = true;
          this.span('tts_first_audio', this.currentTurnStart, 'ok');
        }
        this.playingSegmentId = id;
        this.emit({ type: 'reply_audio', audio, format, segmentId: id });
      },
      onSentencePlayed: (id) => {
        if (this.playingSegmentId === id) this.playingSegmentId = null;
        this.emit({ type: 'reply_segment_end', segmentId: id });
      },
      onError: (err) => {
        this.logger?.warn('voice-session: synthesis error', { err });
        this.emit({ type: 'error', error: errorMessage(err), code: 'synthesis' });
      },
    });
  }

  /** Subscribe to session events. Returns an unsubscribe function. */
  on(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Current lifecycle state. */
  getState(): VoiceSessionState {
    return this.state;
  }

  /**
   * Honest text of the last reply — the sentences actually played, plus a
   * ` [interrupted]` marker when barge-in cut it short.
   */
  lastReplyText(): string {
    return this.lastReplyTextValue;
  }

  /** Feed one inbound audio frame. Drives VAD, barge-in, and endpointing. */
  pushAudio(chunk: PcmChunk): void {
    const { speech } = this.vad.process(chunk);
    const risingEdge = speech && !this.lastSpeechState;
    this.lastSpeechState = speech;

    // Barge-in: only on the RISING EDGE of speech (silence -> speech), while
    // we are replying (or audio is still queued). Gating on `speech` alone
    // re-fired bargeIn() on every subsequent frame of the user's continued
    // talking — once per ~20ms frame, with nothing left to interrupt — which
    // cancelled the agent's NEXT turn before it could say a word.
    if (
      risingEdge &&
      (this.state === 'thinking' || this.state === 'speaking' || this.playout.active)
    ) {
      this.bargeIn();
    }

    if (speech) {
      if (this.state === 'idle') this.setState('listening');
      this.utteranceChunks.push(chunk);
    } else if (this.utteranceChunks.length > 0) {
      this.utteranceChunks.push(chunk);
    }

    const { committed } = this.endpoint.process(speech);
    if (
      committed &&
      this.utteranceChunks.length > 0 &&
      (this.state === 'listening' || this.state === 'idle')
    ) {
      const chunks = this.utteranceChunks;
      this.utteranceChunks = [];
      this.currentTurn = this.handleUtterance(chunks);
    }
  }

  /** Resolves when the in-flight turn (if any) and its playout have finished. */
  async idle(): Promise<void> {
    if (this.currentTurn) await this.currentTurn;
    await this.playout.idle();
  }

  /**
   * Prefer live partials when the provider advertises them; otherwise wrap the
   * batch provider in the utterance-buffered adapter. Total by construction —
   * every configured provider yields a working session, because the buffered
   * fallback needs nothing injected.
   */
  private resolveStt(stt: SttProvider): StreamingSttProvider {
    return isStreamingSttProvider(stt) ? stt : createBufferedSttAdapter(stt);
  }

  private async handleUtterance(chunks: PcmChunk[]): Promise<void> {
    const controller = new AbortController();
    this.turnController = controller;
    this.setState('thinking');
    this.utteranceSeq += 1;
    this.currentTurnId = `u${this.utteranceSeq}`;
    this.currentTurnStart = this.now();
    this.firstAudioSpanned = false;
    const turnStart = this.currentTurnStart;

    let transcript: string;
    const sttStart = this.now();
    try {
      transcript = await this.transcribe(chunks, controller.signal);
    } catch (err) {
      this.span('stt', sttStart, 'error', errorMessage(err));
      this.span('turn', turnStart, 'error', errorMessage(err));
      this.emit({ type: 'error', error: errorMessage(err), code: 'stt' });
      this.setState('listening');
      return;
    }
    this.span('stt', sttStart, 'ok');

    if (controller.signal.aborted) {
      this.span('turn', turnStart, 'interrupted');
      return;
    }

    if (isHallucination(transcript)) {
      // Empty or boilerplate — drop it, keep listening.
      this.span('turn', turnStart, 'ok');
      this.setState('listening');
      return;
    }

    this.emit({ type: 'utterance_committed', text: transcript });
    await this.runTurn(transcript, controller, turnStart);
  }

  private async transcribe(chunks: PcmChunk[], signal: AbortSignal): Promise<string> {
    let text = '';
    for await (const partial of this.stt.transcribeStream(asyncIterable(chunks), { signal })) {
      text = partial.text;
    }
    return text;
  }

  private async runTurn(
    text: string,
    controller: AbortController,
    turnStart: number,
  ): Promise<void> {
    const chunker = new SentenceChunker();
    this.playout.reset();
    this.playingSegmentId = null;
    this.toolsInFlight = 0;
    this.hasSpokenTextThisTurn = false;
    this.fillerSpokenThisTurn = false;
    let firstSentenceSpanned = false;

    try {
      for await (const event of this.runner.run(text, { abortSignal: controller.signal })) {
        if (controller.signal.aborted) break;
        if (event.type === 'text_delta') {
          if (this.state === 'thinking') this.setState('speaking');
          this.hasSpokenTextThisTurn = true;
          // Text resumed — cancel a pending filler and stop ticking.
          this.stopToolFillerAndTick();
          for (const sentence of chunker.push(event.text)) {
            if (!firstSentenceSpanned) {
              firstSentenceSpanned = true;
              this.span('llm_first_sentence', turnStart, 'ok');
            }
            this.speakSentence(sentence);
          }
          continue;
        }
        if (event.type === 'tool_start') {
          this.onToolStart();
          continue;
        }
        if (event.type === 'tool_end') {
          this.onToolEnd();
        }
        // thinking_delta and other events are never spoken.
      }
      if (!controller.signal.aborted) {
        const remainder = chunker.flush();
        if (remainder) this.speakSentence(remainder);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        this.emit({ type: 'error', error: errorMessage(err), code: 'runner' });
      }
    } finally {
      this.stopToolFillerAndTick();
    }

    await this.playout.idle();

    if (controller.signal.aborted) {
      // Barge-in already emitted `interrupted` and reset state.
      this.span('turn', turnStart, 'interrupted');
      return;
    }
    const played = this.playout.playedText().join(' ');
    this.lastReplyTextValue = played;
    this.emit({ type: 'reply_complete', text: played });
    this.span('turn', turnStart, 'ok');
    this.setState('listening');
  }

  /**
   * A tool call just started. On the FIRST call of a turn that starts before
   * any reply text has appeared, arm the filler debounce; every tool-call gap
   * (re)starts the tick interval, independent of whether the filler fires.
   */
  private onToolStart(): void {
    this.toolsInFlight += 1;
    const fillerAfterMs = this.config.fillerAfterMs ?? 0;
    if (
      this.toolsInFlight === 1 &&
      !this.hasSpokenTextThisTurn &&
      !this.fillerSpokenThisTurn &&
      fillerAfterMs > 0 &&
      this.fillerTimerHandle === null
    ) {
      this.fillerTimerHandle = this.setTimer(() => {
        this.fillerTimerHandle = null;
        this.fillerSpokenThisTurn = true;
        this.speakFiller();
        // Don't double up: push the next tick a full interval out from the
        // filler that was just spoken, rather than let it land right after.
        this.restartTick();
      }, fillerAfterMs);
    }
    this.scheduleTick();
  }

  /** A tool call finished. Once none remain, stop the filler and the tick. */
  private onToolEnd(): void {
    this.toolsInFlight = Math.max(0, this.toolsInFlight - 1);
    if (this.toolsInFlight === 0) this.stopToolFillerAndTick();
  }

  private scheduleTick(): void {
    const tickIntervalMs = this.config.tickIntervalMs ?? 0;
    if (tickIntervalMs <= 0 || this.tickTimerHandle !== null) return;
    this.tickTimerHandle = this.setTimer(() => this.fireTick(), tickIntervalMs);
  }

  private restartTick(): void {
    this.clearTickTimer();
    this.scheduleTick();
  }

  private fireTick(): void {
    this.tickTimerHandle = null;
    if (this.toolsInFlight <= 0) return;
    this.emit({ type: 'tick' });
    this.scheduleTick();
  }

  private clearFillerTimer(): void {
    if (this.fillerTimerHandle === null) return;
    this.clearTimer(this.fillerTimerHandle);
    this.fillerTimerHandle = null;
  }

  private clearTickTimer(): void {
    if (this.tickTimerHandle === null) return;
    this.clearTimer(this.tickTimerHandle);
    this.tickTimerHandle = null;
  }

  private stopToolFillerAndTick(): void {
    this.clearFillerTimer();
    this.clearTickTimer();
  }

  /**
   * Append one span. The provider ids come off the resolved provider objects,
   * so the span records what ACTUALLY ran — not what config asked for. Writing
   * is buffered by contract; this call never performs I/O.
   */
  private span(
    stage: VoiceSpanStage,
    startTs: number,
    status: 'ok' | 'error' | 'interrupted',
    error?: string,
  ): void {
    this.spans?.record({
      turnId: this.currentTurnId,
      stage,
      startTs,
      endTs: this.now(),
      status,
      sttProvider: this.stt.name,
      ttsProvider: this.tts.name,
      ...(this.laneKey !== undefined ? { laneKey: this.laneKey } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  }

  /** Mints the id that ties one `reply_sentence`/`filler` event to every
   *  `reply_audio` chunk (and the eventual `reply_segment_end`) that belongs
   *  to it — see `PlayoutItem.id`. */
  private nextSegmentId(): string {
    this.segmentSeq += 1;
    return `seg${this.segmentSeq}`;
  }

  private speakSentence(text: string): void {
    const segmentId = this.nextSegmentId();
    this.emit({ type: 'reply_sentence', text, segmentId });
    this.playout.enqueue({
      id: segmentId,
      text,
      synthesize: (signal) => this.synthesize(text, signal),
    });
  }

  private speakFiller(): void {
    const text = this.config.fillerText ?? DEFAULT_VOICE_FILLER_TEXT;
    const segmentId = this.nextSegmentId();
    this.emit({ type: 'filler', text, segmentId });
    this.playout.enqueue({
      id: segmentId,
      text,
      synthesize: (signal) => this.synthesize(text, signal),
    });
  }

  private async *synthesize(
    text: string,
    signal: AbortSignal,
  ): AsyncIterable<{ audio: Uint8Array; format: AudioFormat }> {
    const opts = { voice: this.config.ttsVoice, speed: this.config.ttsSpeed, signal };
    if (isStreamingTtsProvider(this.tts)) {
      yield* this.tts.synthesizeStream(asyncIterable([text]), opts);
      return;
    }
    const result = await this.tts.synthesize(text, opts);
    yield { audio: result.audio, format: result.format };
  }

  /**
   * Hard stop: the caller (browser tab closed, socket torn down) is no longer
   * listening. Aborts the in-flight turn and cancels playout — the same
   * mechanics `bargeIn()` uses — but emits NOTHING: nobody is there to
   * receive `interrupted`/`reply_complete`, and firing them would touch
   * listeners the caller may already be tearing down. Idempotent; safe to
   * call on a session that never had a turn in flight.
   */
  stop(): void {
    this.stopToolFillerAndTick();
    this.playout.cancel();
    this.turnController?.abort();
    this.turnController = null;
    this.setState('idle');
  }

  private bargeIn(): void {
    // (1) flush queue + abort in-flight synthesis; (2) close whatever segment
    // was ACTUALLY playing (never a different, later one — see
    // `playingSegmentId`'s doc); (3) abort the agent turn; (4) record the
    // honestly-played reply plus an [interrupted] marker.
    this.stopToolFillerAndTick();
    this.playout.cancel();
    if (this.playingSegmentId) {
      this.emit({ type: 'reply_segment_end', segmentId: this.playingSegmentId });
      this.playingSegmentId = null;
    }
    this.turnController?.abort();
    const played = this.playout.playedText();
    const honest = played.length > 0 ? `${played.join(' ')} [interrupted]` : '[interrupted]';
    this.lastReplyTextValue = honest;
    this.emit({ type: 'interrupted', text: honest });
    this.setState('listening');
  }

  private setState(state: VoiceSessionState): void {
    this.state = state;
  }

  private emit(event: VoiceSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function* asyncIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}
