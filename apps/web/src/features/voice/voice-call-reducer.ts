import type { ChatMessage } from '../../lib/chat-reducer';
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
  micDenied: false,
  sttProvider: null,
  ttsProvider: null,
};

export type VoiceCallAction =
  | { type: 'start' }
  | { type: 'connected' }
  | { type: 'hang-up' }
  | { type: 'reset' }
  /** User dismissed the degraded-to-text / mic-denied notice. */
  | { type: 'dismiss-notice' }
  | { type: 'client-event'; event: VoiceCallEvent };

const INTERRUPTED_MARKER = '[interrupted]';

/** The browser refused the mic — guidance, not an error banner. */
export const MIC_DENIED_CODE = 'mic_permission_denied';

/**
 * Error codes that end voice for this call rather than annoying the user with a
 * retry. STT failing means we cannot hear at all; TTS failing means the reply is
 * already text-only. Either way the honest thing to say is "continuing in text".
 */
const DEGRADING_CODES = new Set(['transcribe_failed', 'synthesize_failed', 'voice_unavailable']);

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
      return { ...state, degraded: null, micDenied: false, error: null };

    case 'client-event':
      return applyClientEvent(state, action.event);
  }
}

function applyClientEvent(state: VoiceCallState, event: VoiceCallEvent): VoiceCallState {
  switch (event.type) {
    case 'utterance_committed': {
      // The user finished speaking; the agent is now working on the reply —
      // that gap is `thinking`, the steady-accent-dot state. Close any open
      // agent line and append the user's committed utterance.
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

    case 'filler': {
      // Standalone spoken filler — its own closed line, not part of the reply.
      const transcript = [
        ...state.transcript,
        { ...line(state.transcript, 'agent', event.text), filler: true },
      ];
      return { ...state, status: 'agent_speaking', transcript };
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
      if (event.code === MIC_DENIED_CODE) {
        return { ...state, status: 'ended', error: event.error, micDenied: true };
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
 * The live caption line for the call strip: what the agent is saying right now.
 *
 * Captions ARE the accessibility story for talk-mode, so this is derived from
 * the same transcript that persists into chat history — there is no second,
 * caption-only source that could disagree with what was actually said. Returns
 * null when the agent is not the one talking.
 */
export function voiceCaption(state: Pick<VoiceCallState, 'status' | 'transcript'>): string | null {
  if (state.status !== 'agent_speaking' && state.status !== 'interrupted') return null;
  for (let i = state.transcript.length - 1; i >= 0; i--) {
    const line = state.transcript[i];
    if (line?.role !== 'agent') continue;
    return line.text.trim() || null;
  }
  return null;
}

/**
 * Project the live transcript into `ChatMessage`s for the existing `MessageList`.
 * User lines become user bubbles; agent lines become single-text-block assistant
 * turns. An interrupted agent line gets the `[interrupted]` marker appended when
 * the honest text does not already carry it.
 */
export function voiceTranscriptToMessages(transcript: VoiceTranscriptLine[]): ChatMessage[] {
  return transcript.map((l) => {
    if (l.role === 'user') {
      return { id: l.id, role: 'user', content: l.text, timestamp: 0 };
    }
    const content =
      l.interrupted && !l.text.includes(INTERRUPTED_MARKER)
        ? `${l.text} ${INTERRUPTED_MARKER}`.trim()
        : l.text;
    return {
      id: l.id,
      role: 'assistant',
      blocks: [{ kind: 'text', content }],
      timestamp: 0,
    };
  });
}
