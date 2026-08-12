import { checkCostBudget } from '@ethosagent/core';
import { SessionLane } from '@ethosagent/session-lane';
import type { RealtimeToolCall, RealtimeToolHost } from '@ethosagent/tools-voice';
import { AGENT_CONSULT_TOOL } from '@ethosagent/tools-voice';
import type { AgentEvent } from '@ethosagent/types';
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
  /**
   * USD per minute of audio for the roster entry serving this call
   * (`RealtimeProviderEntry.costPerMinuteUsd`).
   *
   * ABSENT MEANS UNPRICED, NOT FREE. Nothing accrues, no usage event is
   * emitted, and no cap can bite — because a $0.00 usage event for a session
   * the provider is billing by the minute is a claim, and the flattering one.
   * The lane reports the state once through `onEvent` instead, so an operator
   * can see that this call's cost is unknown rather than zero.
   */
  costPerMinuteUsd?: number;
  /**
   * Cap on this session's accrued spend, in USD. Absent → uncapped.
   *
   * Resolved by the deps as the LOWER of `voice.realtime.sessionBudgetUsd` and
   * the speaking personality's `budgetCapUsd` — see `createRealtimeControlDeps`
   * for why two caps cannot be allowed to ignore each other.
   */
  sessionBudgetUsd?: number;
}

/** The `usage` / `halt` AgentEvent variants, reported verbatim by this lane. */
export type RealtimeUsageEvent = Extract<AgentEvent, { type: 'usage' }>;
export type RealtimeHaltEvent = Extract<AgentEvent, { type: 'halt' }>;

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
  /**
   * One slice of accrued audio cost, shaped as the `usage` AgentEvent so it
   * lands wherever token cost lands (`/usage`, the session row, the session
   * budget). Zero tokens, because none were spent: this is wall-clock time.
   */
  onUsage?(binding: RealtimeSessionBinding, usage: RealtimeUsageEvent): void;
  /**
   * The session cap was reached. The same `halt` AgentEvent a turn emits, with
   * the same `cost-cap` rule — a realtime session that stops for money must be
   * indistinguishable, downstream, from a turn that stops for money.
   */
  onHalt?(binding: RealtimeSessionBinding, halt: RealtimeHaltEvent): void;
  /**
   * Everything this talk session has spent so far, in USD — audio AND every
   * turn `agent_consult` ran on the same lane key. Read live (never cached) and
   * read AFTER `onUsage` has folded the newest slice in, so the cap governs the
   * call's whole bill rather than only its audio.
   *
   * Absent → the lane falls back to its own accrued audio total, which is the
   * honest answer when nothing is tracking consults.
   */
  sessionSpendUsd?(binding: RealtimeSessionBinding): number;
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
  | { type: 'tool_dispatched'; callId: string; name: string; ok: boolean; ms: number }
  /** No `costPerMinuteUsd` for the entry serving this call — cost is UNKNOWN. */
  | { type: 'unpriced'; laneKey: string }
  /** The cap was reached; the sign-off has been dispatched and the lane is closing. */
  | { type: 'wind_down'; laneKey: string; spentUsd: number; capUsd: number };

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

/**
 * How often accrued audio time is priced and reported.
 *
 * Fifteen seconds is a compromise between two errors that both matter. Too
 * coarse and the cap bites late: at a 60 s tick a session can run most of a
 * minute past its budget before anything notices, and the wind-down the user
 * hears arrives that much after the money ran out. Too fine and a lane that is
 * otherwise idle wakes up constantly to emit usage events nobody reads. Fifteen
 * bounds the overshoot at a quarter-minute of the rate — under a cent at every
 * published realtime price — and costs four wakeups a minute beside a socket
 * carrying 50 audio frames a second.
 */
export const REALTIME_ACCRUAL_INTERVAL_MS = 15_000;

/**
 * What the session says on its way out when the budget cap is reached.
 *
 * It is the last thing the person hears, so it is written as speech: no rule
 * name, no number, no "budget exceeded". It says what happened, that it is
 * ending, and where the conversation continues — in that order, because the
 * listener may only catch the first clause.
 */
export const REALTIME_BUDGET_SIGN_OFF =
  "That's the spending limit for this call, so I'll stop here — we can keep going in chat.";

/** Answer for a consult that the wind-down cut short. Spoken, so it is prose. */
const REALTIME_WIND_DOWN_TOOL_RESULT = 'This call reached its spending limit before that finished.';

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
  /** Tool calls this lane has accepted and not yet answered. Keyed by call id. */
  private readonly unanswered = new Set<string>();
  private accrualHandle: unknown = null;
  /** Clock reading at which this session's audio time started. */
  private audioStartedAt = 0;
  /** Audio seconds already priced. The difference from elapsed is what is owed. */
  private billedSeconds = 0;
  /** This session's audio cost so far. Not the whole bill — consults add to it. */
  private accruedAudioUsd = 0;
  /** True from the moment the sign-off is dispatched. */
  private windingDown = false;

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

  /** This session's accrued AUDIO cost in USD. Zero while the entry is unpriced. */
  get audioCostUsd(): number {
    return this.accruedAudioUsd;
  }

  /** Route one control frame. Non-realtime frames are not this lane's business. */
  handle(frame: VoiceClientFrame): void {
    if (this.closed) return;
    switch (frame.t) {
      case 'realtime_start':
        this.start(frame);
        return;
      case 'realtime_tool_call':
        this.unanswered.add(frame.callId);
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
    // Price the part-interval since the last tick BEFORE closing. Dropping it
    // would make every session cheaper in our own reporting than it was on the
    // provider's invoice, by up to one tick — which is the flattering error.
    // The cap is NOT checked here: a call that is already ending has nothing to
    // wind down from, and speaking a sign-off into a closing socket would be a
    // line nobody hears.
    this.accrue(false);
    this.closed = true;
    this.stopAccrual();
    this.stopFiller();
    this.lane.abort();
  }

  private start(frame: Extract<VoiceClientFrame, { t: 'realtime_start' }>): void {
    if (this.started) return;
    this.started = true;
    this.canSay = frame.canSay;
    // Billing starts HERE, not when the binding resolves: the provider socket is
    // already open by the time the browser sends this frame, and the seconds a
    // session store lookup takes are seconds the provider is charging for.
    this.audioStartedAt = this.now();
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
        this.startAccrual(binding);
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
          this.answer(
            call.callId,
            false,
            'This call has not finished connecting to the assistant.',
          );
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
        this.answer(call.callId, result.ok, result.output);
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

  /** Answer one tool call and stop tracking it as outstanding. */
  private answer(callId: string, ok: boolean, output: string): void {
    this.unanswered.delete(callId);
    this.opts.send({ t: 'realtime_tool_result', callId, ok, output });
  }

  // --- per-audio-minute accrual --------------------------------------------
  //
  // The first cost in this system that accrues while nothing is being
  // generated. A realtime session is billed for the wall-clock time its socket
  // is open, whether the model is talking, the user is talking, or the line is
  // silent — so the meter is elapsed time, not turns, and it keeps running
  // through a mute.

  private startAccrual(binding: RealtimeSessionBinding): void {
    const rate = binding.costPerMinuteUsd;
    if (rate === undefined || !(rate > 0)) {
      // Unpriced, and said out loud rather than reported as free.
      this.deps.onEvent?.({ type: 'unpriced', laneKey: binding.laneKey });
      return;
    }
    const tick = (): void => {
      this.accrualHandle = null;
      if (this.closed) return;
      this.accrue();
      if (this.closed) return;
      this.accrualHandle = this.setTimer(tick, REALTIME_ACCRUAL_INTERVAL_MS);
    };
    this.accrualHandle = this.setTimer(tick, REALTIME_ACCRUAL_INTERVAL_MS);
  }

  private stopAccrual(): void {
    if (this.accrualHandle === null) return;
    this.clearTimer(this.accrualHandle);
    this.accrualHandle = null;
  }

  /**
   * Price every audio second that has elapsed since the last time we did, fold
   * it into the session's spend, and check the cap.
   *
   * Pro-rata by the second, not rounded up to a whole minute: we do not know
   * how the provider rounds, and `estimatedCostUsd` says what this is — an
   * estimate. Rounding up would over-report and trip the cap early; dropping
   * the remainder would under-report and never trip it at all.
   */
  private accrue(checkCap = true): void {
    const binding = this.binding;
    const rate = binding?.costPerMinuteUsd;
    if (!binding || rate === undefined || !(rate > 0)) return;
    const elapsedSeconds = Math.max(0, (this.now() - this.audioStartedAt) / 1_000);
    const owedSeconds = elapsedSeconds - this.billedSeconds;
    if (owedSeconds <= 0) return;
    this.billedSeconds = elapsedSeconds;
    const cost = (owedSeconds / 60) * rate;
    this.accruedAudioUsd += cost;
    this.deps.onUsage?.(binding, {
      type: 'usage',
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: cost,
    });
    if (checkCap) this.checkBudget(binding);
  }

  /**
   * Has this call spent its cap?
   *
   * The spend read back is the SESSION's, not just the audio's: the deps hand
   * back what `agent_consult`'s turns have added on the same lane key plus the
   * slice just folded in, because an operator's cap means "what this call
   * costs", and half a bill is not a budget.
   */
  private checkBudget(binding: RealtimeSessionBinding): void {
    if (binding.sessionBudgetUsd === undefined) return;
    const spentUsd = this.deps.sessionSpendUsd?.(binding) ?? this.accruedAudioUsd;
    const verdict = checkCostBudget({ spentUsd, capUsd: binding.sessionBudgetUsd });
    if (!verdict.exceeded) return;
    this.windDown(binding, verdict.rule, verdict.message, spentUsd);
  }

  /**
   * Graceful spoken wind-down (plan eng-review D10): the session says one short
   * sentence and closes cleanly. Never a dropped stream.
   *
   * The ORDER below is the whole behaviour, and it is what the test asserts:
   *
   *   1. the halt is reported, with the same `cost-cap` rule a turn halts on;
   *   2. the sign-off is DISPATCHED — before anything closes, so the browser
   *      has the line in hand while its media socket is still up;
   *   3. every tool call this lane accepted and has not answered gets an
   *      answer, because a realtime session waits forever on an unanswered
   *      call and "forever" here would be the last thing the user experiences;
   *   4. only then does the lane close.
   *
   * The browser owns the media socket on this tier, so step 4 closes the
   * CONTROL lane; the sign-off's own audio finishes on the far side, and the
   * client ends the call when the utterance completes.
   */
  private windDown(
    binding: RealtimeSessionBinding,
    rule: string,
    message: string,
    spentUsd: number,
  ): void {
    if (this.closed || this.windingDown) return;
    this.windingDown = true;
    this.stopAccrual();
    this.stopFiller();

    this.deps.onHalt?.(binding, {
      type: 'halt',
      kind: 'budget',
      rule,
      toolName: '_budget',
      message,
    });
    this.opts.send({ t: 'realtime_wind_down', text: REALTIME_BUDGET_SIGN_OFF, reason: 'budget' });
    for (const callId of [...this.unanswered]) {
      this.answer(callId, false, REALTIME_WIND_DOWN_TOOL_RESULT);
    }
    this.deps.onEvent?.({
      type: 'wind_down',
      laneKey: binding.laneKey,
      spentUsd,
      capUsd: binding.sessionBudgetUsd ?? 0,
    });
    this.close();
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
