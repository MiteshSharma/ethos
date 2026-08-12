import { SessionLane } from '@ethosagent/session-lane';
import type { RealtimeToolCall, RealtimeToolHost } from '@ethosagent/tools-voice';
import { AGENT_CONSULT_TOOL } from '@ethosagent/tools-voice';
import { DEFAULT_VOICE_FILLER_TEXT } from '@ethosagent/voice-session';
import type { VoiceClientFrame, VoiceServerFrame } from '@ethosagent/web-contracts';

// One browser talk session on the hosted realtime tier, server-side.
//
// On this tier the audio never comes here — the browser holds a socket straight
// to the provider, which is the whole latency argument for the tier. What comes
// here is everything that must NOT live in a page: the agent, the lane, the
// session history and the approval surface. The lane IS the socket, so every
// field below is an instance field and two callers are two objects that cannot
// observe each other — the same posture as `VoiceLane`, for the same reason.
//
// Transport-free on purpose: it takes `send` and is fed decoded frames, so the
// consult ordering, the filler cadence and the transcript writes are all
// unit-testable with a fake clock and no socket.

/** What one talk session is bound to, resolved once when the call opens. */
export interface RealtimeSessionBinding {
  /**
   * `voice:<botKey>:browser:<client>` — built by `voiceLaneKey`
   * (`@ethosagent/core`), the encoder the LiveKit/SIP adapters share. It is
   * also the consulted turn's session key: transcripts and consults land in
   * ONE conversation, and it is not the typed chat's conversation.
   */
  laneKey: string;
  /** The `SessionStore` row the lane key resolved to. */
  storeSessionId: string;
  /** Advertised == handled, for this personality. Built by the mint's derivation. */
  host: RealtimeToolHost;
  /** Working directory a dispatched tool runs against. */
  workingDir: string;
  personalityId?: string;
}

/** Everything the lane drives. All injected; none of it is reached for. */
export interface RealtimeControlLaneDeps {
  /**
   * Resolve the talk session: its lane, its store row, its tool host. Async
   * because the store row may need creating, and it runs as the FIRST task on
   * the lane so every consult behind it is guaranteed a resolved binding.
   */
  open(info: { sessionId?: string; personalityId?: string }): Promise<RealtimeSessionBinding>;
  /**
   * Persist one settled transcript line as the talk session's text history.
   * Provider transcripts — user AND assistant — are what keep the "no audio
   * ever reaches the LLM" anti-goal survivable: the conversation stays
   * searchable, resumable and captionable, it just never existed as audio on
   * our side.
   */
  persistTranscript(
    binding: RealtimeSessionBinding,
    role: 'user' | 'assistant',
    text: string,
  ): Promise<void>;
  /** Monotonic-enough clock. Injected so the no-dead-air test can fake it. */
  now?: () => number;
  /** Timer seam. Same reason. Returns a handle `clearTimer` understands. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Structured lane events for logging/telemetry. Never user-facing. */
  onEvent?: (event: RealtimeControlLaneEvent) => void;
}

export type RealtimeControlLaneEvent =
  | { type: 'opened'; laneKey: string; tools: string[] }
  | { type: 'open_failed'; error: string }
  | { type: 'tool_dispatched'; callId: string; name: string; ok: boolean; ms: number };

export interface RealtimeControlLaneOptions {
  deps: RealtimeControlLaneDeps;
  send(frame: VoiceServerFrame): void;
  filler?: Partial<RealtimeFillerConfig>;
}

export interface RealtimeFillerConfig {
  /**
   * Longest gap the lane will leave between two spoken lines during a consult.
   *
   * The acceptance criterion is "no dead air > 2 s"; this sits deliberately
   * under it, because the bound the lane can actually enforce is the interval
   * between DISPATCHES of speech, not between acoustic samples. It cannot know
   * how long a line takes to say — the provider owns the voice — so it keeps
   * the cadence strictly inside the budget and lets the real speech overlap it.
   */
  everyMs: number;
  /** Spoken the instant a consult is dispatched. */
  ackText: string;
  /**
   * Repeated every `everyMs` until the consult returns. It is literally
   * `VoiceSession`'s filler line (`DEFAULT_VOICE_FILLER_TEXT`, spoken by
   * `speakFiller` in `extensions/voice-session/src/voice-session.ts`) — one
   * default, imported, because two surfaces of one assistant saying different
   * things while they think is a seam the listener can hear.
   */
  fillerText: string;
}

export const DEFAULT_REALTIME_FILLER: RealtimeFillerConfig = {
  everyMs: 1_800,
  ackText: 'Let me check.',
  fillerText: DEFAULT_VOICE_FILLER_TEXT,
};

/** The dead-air budget the acceptance criterion names. Exported for the test. */
export const REALTIME_MAX_DEAD_AIR_MS = 2_000;

export class RealtimeControlLane {
  private readonly opts: RealtimeControlLaneOptions;
  private readonly deps: RealtimeControlLaneDeps;
  private readonly filler: RealtimeFillerConfig;
  /**
   * The talk session's OWN FIFO — one lane per talk session (eng-review D6).
   * Two overlapping consults on one session serialize here rather than
   * interleaving, on the same strict one-at-a-time queue the gateway runs every
   * channel lane on. The bootstrap is the lane's first task, so no consult can
   * run before the binding exists.
   */
  private readonly lane = new SessionLane();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  /** Resolved by the bootstrap task. Null until the call is open. */
  private binding: RealtimeSessionBinding | null = null;
  /** Serializes transcript writes without parking them behind a slow consult. */
  private writeChain: Promise<void> = Promise.resolve();
  /** Whether the provider socket can speak a line verbatim. */
  private canSay = false;
  private started = false;
  private closed = false;
  private fillerHandle: unknown = null;

  constructor(opts: RealtimeControlLaneOptions) {
    this.opts = opts;
    this.deps = opts.deps;
    this.filler = { ...DEFAULT_REALTIME_FILLER, ...opts.filler };
    this.now = opts.deps.now ?? Date.now;
    this.setTimer = opts.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.deps.clearTimer ?? ((handle) => clearTimeout(handle as never));
  }

  /** The talk session's lane key, once the call has opened. */
  get laneKey(): string | null {
    return this.binding?.laneKey ?? null;
  }

  /** True once the browser has declared the call realtime. */
  get isOpen(): boolean {
    return this.started && !this.closed;
  }

  /** Route one control frame. Non-realtime frames are not this lane's business. */
  handle(frame: VoiceClientFrame): void {
    if (this.closed) return;
    switch (frame.t) {
      case 'realtime_start':
        this.start(frame);
        return;
      case 'realtime_tool_call':
        this.enqueueToolCall({ callId: frame.callId, name: frame.name, args: frame.args });
        return;
      case 'realtime_transcript':
        this.persist(frame.role, frame.text);
        return;
      case 'realtime_end':
        this.close();
        return;
      default:
        return;
    }
  }

  /** Socket closed. Abort the running consult and drop everything queued. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopFiller();
    this.lane.abort();
  }

  private start(frame: Extract<VoiceClientFrame, { t: 'realtime_start' }>): void {
    if (this.started) return;
    this.started = true;
    this.canSay = frame.canSay;
    void this.lane
      .enqueue(async () => {
        const binding = await this.deps.open({
          ...(frame.sessionId ? { sessionId: frame.sessionId } : {}),
          ...(frame.personalityId ? { personalityId: frame.personalityId } : {}),
        });
        if (this.closed) return;
        this.binding = binding;
        this.opts.send({
          t: 'realtime_ready',
          laneKey: binding.laneKey,
          // The names this lane will service — the runtime half of
          // advertised == handled, so the browser can see the invariant hold
          // instead of trusting that the mint and the lane agree.
          tools: binding.host.handled,
        });
        this.deps.onEvent?.({
          type: 'opened',
          laneKey: binding.laneKey,
          tools: binding.host.handled,
        });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.onEvent?.({ type: 'open_failed', error: message });
        if (this.closed) return;
        this.opts.send({
          t: 'error',
          code: 'realtime_control_unavailable',
          message: 'This call could not reach the assistant; it can still hear you.',
        });
      });
  }

  private persist(role: 'user' | 'assistant', text: string): void {
    this.writeChain = this.writeChain.then(async () => {
      const binding = this.binding;
      // A transcript arriving before the bootstrap settled has nowhere to go.
      // Dropping it is better than inventing a session for it — the call is
      // one or two frames old and the caption path is unaffected.
      if (!binding || this.closed) return;
      await this.deps.persistTranscript(binding, role, text).catch(() => {
        // A failed write must not end a live call. The captions the user reads
        // come off the provider stream, not off this write.
      });
    });
  }

  private enqueueToolCall(call: RealtimeToolCall): void {
    const isConsult = call.name === AGENT_CONSULT_TOOL;
    void this.lane
      .enqueue(async (signal) => {
        const binding = this.binding;
        if (this.closed) return;
        if (!binding) {
          // The browser called a tool before the call opened, or after the
          // bootstrap failed. Answering keeps the provider's turn accounting
          // intact — an unanswered tool call leaves a realtime session waiting
          // forever, which sounds exactly like the agent ignoring the person.
          this.opts.send({
            t: 'realtime_tool_result',
            callId: call.callId,
            ok: false,
            output: 'This call has not finished connecting to the assistant.',
          });
          return;
        }
        const startedAt = this.now();
        if (isConsult) {
          // Spoken BEFORE the agent turn starts, not after it turns out to be
          // slow: the first second is the one the listener notices.
          this.speak(this.filler.ackText, 'ack');
          // Only a provider that can pin an utterance gets repeating filler. On
          // one that cannot, repeats would be captions with no audio behind
          // them — visual noise standing in for a silence they do not fix.
          if (this.canSay) this.startFiller();
        }
        let result: { ok: boolean; output: string };
        try {
          result = await binding.host.dispatch(call, {
            sessionId: binding.storeSessionId,
            sessionKey: binding.laneKey,
            ...(binding.personalityId ? { personalityId: binding.personalityId } : {}),
            platform: 'web',
            workingDir: binding.workingDir,
            abortSignal: signal,
            // Browser talk-mode is the operator's own authenticated session —
            // the same stamp `chat.send({origin:'voice'})` uses. A far-end
            // caller cannot reach this socket; V4's call path is what
            // introduces `far_end`, and it must say so itself.
            voiceOrigin: { transport: 'browser-talk-mode', speaker: 'owner' },
          });
        } finally {
          this.stopFiller();
        }
        if (this.closed) return;
        this.opts.send({
          t: 'realtime_tool_result',
          callId: call.callId,
          ok: result.ok,
          output: result.output,
        });
        this.deps.onEvent?.({
          type: 'tool_dispatched',
          callId: call.callId,
          name: call.name,
          ok: result.ok,
          ms: this.now() - startedAt,
        });
      })
      .catch(() => {
        // `SessionLane` rejects queued tasks when the lane is aborted (hangup).
        // There is nobody left to answer, so there is nothing to report.
      });
  }

  /**
   * Speak one line through the provider.
   *
   * `canSay: false` (Gemini Live, whose wire has no verbatim-speech frame) is
   * NOT silently dropped: the frame still goes to the browser, which captions
   * it. The listener SEES "Let me check." even where the provider cannot say
   * it, and the boundary policy covers the audible half — it instructs the
   * model to announce the check out loud before calling the tool, which is a
   * normal model turn and therefore works on every provider.
   */
  private speak(text: string, kind: 'ack' | 'filler'): void {
    if (this.closed) return;
    this.opts.send({ t: 'realtime_speak', text, kind });
  }

  private startFiller(): void {
    this.stopFiller();
    const tick = (): void => {
      this.fillerHandle = null;
      if (this.closed) return;
      this.speak(this.filler.fillerText, 'filler');
      this.fillerHandle = this.setTimer(tick, this.filler.everyMs);
    };
    this.fillerHandle = this.setTimer(tick, this.filler.everyMs);
  }

  private stopFiller(): void {
    if (this.fillerHandle === null) return;
    this.clearTimer(this.fillerHandle);
    this.fillerHandle = null;
  }
}
