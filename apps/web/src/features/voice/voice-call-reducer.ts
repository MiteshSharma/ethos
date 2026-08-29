import { type ChatMessage, markInterrupted } from '../../lib/chat-reducer';
import type { VoiceCallEvent } from './voice-call-client';

// Pure state machine for a live voice call. Extracted from the `useVoiceCall`
// hook so the transitions — including barge-in / interrupted — test without React
// or transport infrastructure (mirrors how `chat-reducer.ts` splits state from
// the `useChat` hook). The hook is thin glue: it forwards client events and user
// actions here, and owns only browser-side concerns (mic meter, audio playout).

/** Lifecycle of a live conversation. */
export type VoiceCallStatus =
  | 'idle'
  | 'connecting'
  /** Link dropped mid-call; the socket is retrying. Text chat stays usable. */
  | 'reconnecting'
  | 'listening'
  /** Utterance committed, reply not yet flowing — the agent is working. */
  | 'thinking'
  /**
   * The agent is off consulting (an `agent_consult` round trip) and saying so
   * while it waits. DR1's "Thinking / consulting" row: the accent dot STEADY,
   * with the spoken filler captioned — a consult can take seconds, and a
   * pulsing dot would claim it is mid-sentence the whole time.
   */
  | 'consulting'
  | 'agent_speaking'
  | 'interrupted'
  | 'ended';

export interface VoiceTranscriptLine {
  id: string;
  role: 'user' | 'agent';
  text: string;
  /** Agent line was cut off by barge-in. */
  interrupted?: boolean;
  /** Spoken filler ("One moment."), not real reply content. */
  filler?: boolean;
  /** Agent line is still accumulating sentences (not yet finalized). */
  open?: boolean;
}

/**
 * Voice fell back to text: the strip collapses to a dismissible inline notice
 * naming the provider that failed, and chat keeps working.
 */
export interface VoiceDegradedNotice {
  /** The provider that actually failed, when the server named it. */
  provider: string | null;
  message: string;
}

export interface VoiceCallState {
  status: VoiceCallStatus;
  transcript: VoiceTranscriptLine[];
  /** Last recoverable error surfaced by the session. Cleared on a fresh call. */
  error: string | null;
  /** Set when voice is no longer usable this call. Null once dismissed. */
  degraded: VoiceDegradedNotice | null;
  /**
   * Voice IS working, but not the way it was configured to — the realtime tier
   * was unavailable and this call is running on the local pipeline instead.
   *
   * Distinct from `degraded` because the call continues: `degraded` collapses
   * the strip (there is nothing left to control), this sits above a live strip
   * as a dismissible line. A downgrade the user is not told about is the thing
   * this field exists to prevent.
   */
  notice: string | null;
  /**
   * The call reached its spending limit and is signing off — this is the
   * sentence being spoken. Null on every call that does not.
   *
   * A field of its own rather than a `status`, because the status word says
   * what the call is DOING and the call is still speaking while this is set.
   * It is what puts the `budget reached` chip beside the caption, and it
   * survives the transition to `ended` so the last thing on screen explains why
   * the call stopped instead of just reading `call ended`.
   */
  windDown: string | null;
  /** Which tier is actually serving this call, once it is known. */
  tier: 'pipeline' | 'realtime' | null;
  /** The browser refused the mic. Rendered as guidance, never a dead icon. */
  micDenied: boolean;
  /** Providers that actually served this call, for the mono `{provider}` label. */
  sttProvider: string | null;
  ttsProvider: string | null;
}

export const initialVoiceCallState: VoiceCallState = {
  status: 'idle',
  transcript: [],
  error: null,
  degraded: null,
  notice: null,
  windDown: null,
  tier: null,
  micDenied: false,
  sttProvider: null,
  ttsProvider: null,
};

export type VoiceCallAction =
  | { type: 'start' }
  | { type: 'connected' }
  | { type: 'hang-up' }
  | { type: 'reset' }
  /** User dismissed the degraded-to-text / mic-denied / tier notice. */
  | { type: 'dismiss-notice' }
  /** The transport settled on a tier. Reported once per call. */
  | { type: 'tier'; tier: 'pipeline' | 'realtime' }
  | { type: 'client-event'; event: VoiceCallEvent };

/** The browser refused the mic — guidance, not an error banner. */
export const MIC_DENIED_CODE = 'mic_permission_denied';

/**
 * Error codes that end voice for this call rather than annoying the user with a
 * retry. STT failing means we cannot hear at all; TTS failing means the reply is
 * already text-only. Either way the honest thing to say is "continuing in text".
 */
const DEGRADING_CODES = new Set(['transcribe_failed', 'synthesize_failed', 'voice_unavailable']);

/**
 * The realtime tier was unavailable and the call fell back to the local
 * pipeline. NOT a degrading code: voice works, so the call goes on and the
 * reason renders as a dismissible line above a live strip.
 *
 * Kept as a literal rather than imported from `talk-mode-client` so the pure
 * reducer stays free of transport imports; the two are pinned together by
 * `voice-call-reducer.test.ts`.
 */
export const TIER_DEGRADED_CODE = 'realtime_unavailable';

/**
 * This tab no longer has the voice lane for this conversation — another tab
 * took it over (D8 takeover, `voice-socket.ts`). Terminal like
 * `DEGRADING_CODES`, but NOT one of them: nothing failed here — a different
 * tab is simply the live one now — so the "voice unavailable ... continuing
 * in text" framing `DEGRADING_CODES` implies (see `TalkMode.tsx`) would be
 * actively misleading. The generic `error` fallback below is what actually
 * renders: a toast with the server's own message, no `degraded` banner.
 */
export const LANE_TAKEN_OVER_CODES = new Set(['taken_over']);

export function voiceCallReducer(state: VoiceCallState, action: VoiceCallAction): VoiceCallState {
  switch (action.type) {
    case 'start':
      // Fresh call — clear any prior transcript/error/notice.
      return { ...initialVoiceCallState, status: 'connecting' };

    case 'connected':
      return { ...state, status: 'listening' };

    case 'hang-up':
      return { ...state, status: 'ended' };

    case 'reset':
      return initialVoiceCallState;

    case 'dismiss-notice':
      return {
        ...state,
        degraded: null,
        micDenied: false,
        notice: null,
        error: null,
        // The sign-off outlives the call on purpose (see `windDown`), so it is
        // only dismissible once there is nothing left for it to explain.
        // Dismissing the tier notice mid-call must not take the `budget
        // reached` chip with it.
        ...(state.status === 'ended' ? { windDown: null } : {}),
      };

    case 'tier':
      return { ...state, tier: action.tier };

    case 'client-event':
      return applyClientEvent(state, action.event);
  }
}

function applyClientEvent(state: VoiceCallState, event: VoiceCallEvent): VoiceCallState {
  switch (event.type) {
    case 'speech_end':
      // Endpointing heard the user stop. `thinking` starts HERE, not when the
      // transcript comes back: on a hosted STT the round trip is a second or
      // two, and until this existed the strip read `listening` for all of it —
      // telling the user to keep talking when the system was already working.
      //
      // Only three states outrank it. `idle`/`ended` have no turn to think
      // about, and `reconnecting` is the truer thing to be showing: the
      // utterance is discarded when the link drops, so nothing is coming.
      if (state.status === 'idle' || state.status === 'ended' || state.status === 'reconnecting') {
        return state;
      }
      return { ...state, status: 'thinking' };

    case 'utterance_dropped':
      // Nothing came back for the utterance this call went `thinking` about —
      // an empty transcript, or the server dropped it. The floor goes back to
      // the user rather than leaving the strip thinking about a turn that will
      // never arrive. Narrow on purpose: a call that has since moved on (the
      // reply is flowing, the link dropped, the call ended) keeps where it got
      // to. `interrupted` is included alongside `thinking` for the same reason:
      // a dropped barge-in utterance must not leave the UI stuck showing
      // `interrupted` forever with nothing coming to resolve it.
      return state.status === 'thinking' || state.status === 'interrupted'
        ? { ...state, status: 'listening' }
        : state;

    case 'utterance_committed': {
      // The user finished speaking; the agent is now working on the reply —
      // that gap is `thinking`, the steady-accent-dot state (already entered at
      // `speech_end` on the tiers that endpoint locally; re-entered here for the
      // realtime tier, where the provider owns VAD and this is the first the
      // browser hears of it). Close any open agent line and append the user's
      // committed utterance.
      const transcript = [
        ...closeOpenAgentLine(state.transcript),
        line(state.transcript, 'user', event.text),
      ];
      return {
        ...state,
        status: 'thinking',
        transcript,
        ...(event.provider ? { sttProvider: event.provider } : {}),
      };
    }

    case 'reply_sentence': {
      // Accumulate sentences into a single open agent line for this turn.
      const last = state.transcript[state.transcript.length - 1];
      let transcript: VoiceTranscriptLine[];
      if (last && last.role === 'agent' && last.open && !last.filler) {
        transcript = [
          ...state.transcript.slice(0, -1),
          { ...last, text: joinSentence(last.text, event.text) },
        ];
      } else {
        transcript = [
          ...state.transcript,
          { ...line(state.transcript, 'agent', event.text), open: true },
        ];
      }
      return { ...state, status: 'agent_speaking', transcript };
    }

    case 'budget_wind_down': {
      // The sign-off is a spoken agent line like any other, so it lands in the
      // transcript that persists into chat — the reason the call ended is part
      // of the conversation, not a UI-only annotation that disappears with the
      // strip. The status stays `agent_speaking` because it is being said right
      // now; `disconnected` moves it to `ended` once it has been.
      const transcript = [
        ...closeOpenAgentLine(state.transcript),
        line(state.transcript, 'agent', event.text),
      ];
      return { ...state, status: 'agent_speaking', transcript, windDown: event.text };
    }

    case 'filler': {
      // Standalone spoken filler — its own closed line, not part of the reply.
      // `consulting`, not `agent_speaking`: the filler is what a WAIT sounds
      // like, and the strip says so with the steady dot while captioning the
      // line (DR1 "Thinking / consulting").
      const transcript = [
        ...state.transcript,
        { ...line(state.transcript, 'agent', event.text), filler: true },
      ];
      return { ...state, status: 'consulting', transcript };
    }

    case 'reply_audio':
      // Audio playout is the hook's concern; the reducer only tracks that the
      // agent is speaking, plus which provider actually produced the audio.
      return {
        ...state,
        status: 'agent_speaking',
        ...(event.provider ? { ttsProvider: event.provider } : {}),
      };

    case 'link':
      // A dropped link never ends the conversation on its own — the socket
      // retries, and the composer stays usable for text meanwhile.
      if (state.status === 'idle' || state.status === 'ended') return state;
      if (event.status === 'reconnecting') return { ...state, status: 'reconnecting' };
      if (state.status === 'reconnecting') return { ...state, status: 'listening' };
      return state;

    case 'reply_complete':
      return {
        ...state,
        status: 'listening',
        transcript: finalizeAgentLine(state.transcript, event.text, false),
      };

    case 'interrupted':
      // `event.text` is the honest reply (sentences actually played). Mark the
      // line interrupted; the marker is enforced at render time.
      return {
        ...state,
        status: 'interrupted',
        transcript: finalizeAgentLine(state.transcript, event.text, true),
      };

    case 'error':
      if (event.code === TIER_DEGRADED_CODE) {
        // Voice keeps working on the pipeline tier — the status is untouched
        // and `error` stays clear, so the strip does not put a failure where
        // the state word goes.
        return { ...state, notice: event.error };
      }
      if (event.code === MIC_DENIED_CODE) {
        return { ...state, status: 'ended', error: event.error, micDenied: true };
      }
      if (event.code && LANE_TAKEN_OVER_CODES.has(event.code)) {
        // End the call here, without the `degraded` banner: nothing failed,
        // so there is no provider to blame. `error` alone still surfaces the
        // server's own message as a toast (Chat.tsx's notification effect).
        return { ...state, status: 'ended', error: event.error };
      }
      if (event.code && DEGRADING_CODES.has(event.code)) {
        return {
          ...state,
          status: 'ended',
          error: event.error,
          degraded: { provider: event.provider ?? null, message: event.error },
        };
      }
      // Recoverable — keep the current status, surface the message.
      return { ...state, error: event.error };

    case 'disconnected':
      return { ...state, status: 'ended' };
  }
}

/**
 * Does this client event END the call?
 *
 * The transitions above are state and nothing else — no branch here releases the
 * microphone. `useVoiceCall` owns teardown, and it needs to know which events
 * oblige it to run one. Reading the same two constants the `error` branch reads
 * is what stops the two from drifting: a new degrading code is added in one
 * place and both the transition to `ended` and the teardown follow it.
 *
 * Before this existed, only `disconnected` tore down. A mid-call degrade left
 * the strip saying the call had ended while capture kept running — the mic stayed
 * live and the endpointer kept firing its earcon on every utterance.
 *
 * `LANE_TAKEN_OVER_CODES` reads the same way for the same reason: without it,
 * a tab that just lost its lane to a takeover would keep its mic hot and —
 * worse — the transport would reconnect and reopen the very lane it was just
 * evicted from (`createVoiceSocketTransport`'s own reconnect policy fires on
 * any unexpected close). Tearing down here calls `client.disconnect()`,
 * which closes the transport FOR GOOD before that reconnect can fire.
 */
export function isTerminalClientEvent(event: VoiceCallEvent): boolean {
  if (event.type === 'disconnected') return true;
  if (event.type !== 'error' || !event.code) return false;
  return (
    event.code === MIC_DENIED_CODE ||
    LANE_TAKEN_OVER_CODES.has(event.code) ||
    DEGRADING_CODES.has(event.code)
  );
}

// --- transcript helpers ----------------------------------------------------

function line(
  transcript: VoiceTranscriptLine[],
  role: 'user' | 'agent',
  text: string,
): VoiceTranscriptLine {
  // Deterministic id from position keeps the reducer pure (no Date.now()).
  return { id: `voice-${transcript.length}`, role, text };
}

function joinSentence(existing: string, next: string): string {
  return existing ? `${existing} ${next}` : next;
}

function closeOpenAgentLine(transcript: VoiceTranscriptLine[]): VoiceTranscriptLine[] {
  const last = transcript[transcript.length - 1];
  if (last?.role !== 'agent' || !last.open) return transcript;
  return [...transcript.slice(0, -1), { ...last, open: false }];
}

/**
 * Finalize the current open agent line with the authoritative reply text. When
 * no line is open (audio-only reply), append a closed one.
 */
function finalizeAgentLine(
  transcript: VoiceTranscriptLine[],
  text: string,
  interrupted: boolean,
): VoiceTranscriptLine[] {
  const last = transcript[transcript.length - 1];
  const finalized = (base: Partial<VoiceTranscriptLine>): VoiceTranscriptLine => ({
    id: base.id ?? `voice-${transcript.length}`,
    role: 'agent',
    text,
    open: false,
    ...(interrupted ? { interrupted: true } : {}),
    ...(base.filler ? { filler: true } : {}),
  });
  if (last && last.role === 'agent' && last.open && !last.filler) {
    return [...transcript.slice(0, -1), finalized(last)];
  }
  return [...transcript, finalized({})];
}

/**
 * Does Chat still render the CallStrip?
 *
 * A live call, obviously. The reason this is a function rather than
 * `status !== 'idle' && status !== 'ended'` is the OTHER half: a call that has
 * stopped is not always finished TALKING to the user, and unmounting the strip
 * the instant the status turns `ended` throws away the only thing on screen
 * that explains what just happened.
 *
 * Two states this actually loses, both reachable today:
 *
 * - The budget wind-down. The sign-off is spoken, `disconnected` lands, and the
 *   `budget reached` chip plus its caption would vanish at the exact moment
 *   they matter. `windDown` is documented to survive `ended` for this reason;
 *   this is what makes that true on screen.
 * - A call that never started. The realtime tier is refused (a dismissible
 *   `notice` above the strip) and then the pipeline fallback ALSO fails to
 *   start — the failure lands in `error` and the call goes straight to `ended`.
 *   Unmounting there leaves the user with no explanation at all, neither the
 *   refusal nor the failure.
 *
 * `error` rather than `notice` is the second condition on purpose: a call that
 * merely ran on the fallback tier and then ended normally leaves `error` null
 * (see the `TIER_DEGRADED_CODE` branch above), so the strip still goes away
 * when the downgrade was the whole story. `degraded` and `micDenied` imply an
 * `error` today, but they are listed because they are what the strip COLLAPSES
 * for, and that must not depend on a coupling somewhere else.
 *
 * Everything here is cleared by `dismiss-notice`, so the post-call strip always
 * has a way off the screen.
 */
export function callStripVisible(
  state: Pick<VoiceCallState, 'status' | 'degraded' | 'micDenied' | 'windDown' | 'error'>,
): boolean {
  if (state.status !== 'idle' && state.status !== 'ended') return true;
  return Boolean(state.degraded || state.micDenied || state.windDown || state.error);
}

/**
 * The live caption line for the call strip: what the agent is saying right now.
 *
 * Captions ARE the accessibility story for talk-mode, so this is derived from
 * the same transcript that persists into chat history — there is no second,
 * caption-only source that could disagree with what was actually said. Returns
 * null when the agent is not the one talking.
 */
export function voiceCaption(
  state: Pick<VoiceCallState, 'status' | 'transcript' | 'windDown'>,
): string | null {
  // The wind-down sentence outlives the speaking state: it is the explanation
  // for a call that is about to end, and a caption that vanished at `ended`
  // would leave the strip reading `call ended` with no reason attached.
  if (state.windDown) return state.windDown;
  // `consulting` is captioned for the same reason it exists: the spoken filler
  // is the only thing standing between the listener and dead air.
  if (
    state.status !== 'agent_speaking' &&
    state.status !== 'interrupted' &&
    state.status !== 'consulting'
  ) {
    return null;
  }
  for (let i = state.transcript.length - 1; i >= 0; i--) {
    const line = state.transcript[i];
    if (line?.role !== 'agent') continue;
    return line.text.trim() || null;
  }
  return null;
}

/**
 * Mark an agent line that barge-in — or a dropped link — cut off mid-sentence.
 *
 * Re-exported from `lib/chat-reducer.ts`, which is where the marker convention
 * now lives: the chat transcript needs the same annotation (a second question
 * asked mid-answer keeps the partial answer, marked), and only one module can
 * own it. The chat projection below and the realtime tier's transcript write
 * (`realtime-voice-call-client.ts`) still reach it through here, so the line the
 * server persists and the line the user reads carry the same annotation. The A0
 * regression pin fixes the shape for the pipeline tier.
 */
export { markInterrupted };

/**
 * Project the live transcript into `ChatMessage`s for the existing `MessageList`.
 * User lines become user bubbles; agent lines become single-text-block assistant
 * turns. An interrupted agent line gets the `[interrupted]` marker appended when
 * the honest text does not already carry it.
 */
export function voiceTranscriptToMessages(transcript: VoiceTranscriptLine[]): ChatMessage[] {
  return transcript.map((l) => {
    if (l.role === 'user') {
      // Every line here was SPOKEN — that is the only way into a realtime
      // transcript — so the bubble carries the same voice marker the pipeline
      // tier's turns get through `sendMessage`.
      return { id: l.id, role: 'user', content: l.text, timestamp: 0, origin: 'voice' };
    }
    const content = l.interrupted ? markInterrupted(l.text) : l.text;
    return {
      id: l.id,
      role: 'assistant',
      blocks: [{ kind: 'text', content }],
      timestamp: 0,
    };
  });
}

/**
 * The message list Chat renders while talk-mode is (or was) running — DR5's
 * "persistent transcript", not just live captions.
 *
 * The two tiers reach the list by different routes, which is why this is a
 * decision rather than a concatenation:
 *
 * - PIPELINE (streaming, and — since Bug 4 — the batch RPC fallback too):
 *   every spoken turn runs on the browser's own VOICE LANE
 *   (`voice:<botKey>:browser:<id>`, never the chat session — Conflict 1,
 *   plan §7), so `messages` knows nothing about it either. Not projected
 *   here regardless: this call's persistent record lives on the voice lane's
 *   own session row, a deliberately separate conversation ("chat view is a
 *   spectator") rather than the current chat's history. Only the LIVE
 *   captions during the call come from `call.transcript`
 *   (`voiceCaption`/the call strip) — they do not outlive it in `messages`.
 *   (Pre-Bug-4, only the batch tier's turns used to land in `messages` too,
 *   via `chat-voice-runner.ts`'s `sendMessage` — that was the anti-pattern
 *   the fix removed; this comment used to describe THAT as the reason not to
 *   project, which stopped being true the moment it was fixed.)
 * - REALTIME: the provider owns the conversation and the browser never runs a
 *   chat turn, so `messages` knows nothing about the call. The transcript is
 *   the page's only record of it — without this, a realtime conversation
 *   appears NOWHERE in Chat and the captions vanish with the strip.
 *
 * Appended, not interleaved: a realtime call happens after whatever was typed
 * before it, and the lines carry no wall clock to sort by (`timestamp: 0`).
 */
export function chatMessagesWithVoice(
  messages: ChatMessage[],
  call: Pick<VoiceCallState, 'tier' | 'transcript'>,
): ChatMessage[] {
  if (call.tier !== 'realtime' || call.transcript.length === 0) return messages;
  return [...messages, ...voiceTranscriptToMessages(call.transcript)];
}
