import { VOICE_ORIGIN_TAG } from '@ethosagent/types';
import {
  type ApprovalRequest,
  type BackgroundJobStatusWire,
  type CardEnvelope,
  CardEnvelopeSchema,
  type ClarifyRequestEvent,
  type SessionCard,
  type SseEvent,
  type SseEventType,
  type StoredMessage,
} from '@ethosagent/web-contracts';
import type { MessageAttachment } from './attachments';
import {
  applyClarifyEvent,
  type ClarifyQueueState,
  emptyClarifyQueue,
  noteAnswer,
  seedClarify,
} from './clarify-queue';
import { applyRunEvent, emptyRunsState, type RunsState, seedRun } from './pi-run-reducer';
import {
  applyTrailEvent,
  closeTrail,
  type TrailAction,
  type TrailEntry,
  type TrailState,
  toolLabel,
} from './trail';

// Pure reducer that maps SSE events → ChatState. Extracted from the
// `useChat` hook so we can test the state machine in isolation, without
// React or `EventSource` infrastructure.
//
// W2b extends the W2a shape: an assistant turn is no longer a flat
// string. It's an ordered sequence of "blocks" — text segments and the
// artifacts a tool produced (image, html, pdf, card, run anchor) — that
// render in arrival order.
//
// Tool CALLS are not blocks. The feedback & activity contract
// (plan/phases/feedback-activity-contract.md §1) says the answer is content
// only: the machinery goes to `state.trail`, keyed by turn id, which the
// footer under the bubble and the right drawer both render.

export interface UserMessage {
  id: string;
  role: 'user';
  content: string;
  /** Wall-clock when the user pressed Send. */
  timestamp: number;
  isSteer?: boolean;
  /** Optimistically-rendered attachments shown as chips in the user bubble.
   *  Carries no base64 data — render-only metadata. */
  attachments?: MessageAttachment[];
  /**
   * How the turn ARRIVED. `'voice'` means the user spoke it; absent means they
   * typed it.
   *
   * The transcript never overwrites the audio marker (voice-V2's hard
   * invariant): `content` holds what was said and this holds the fact that it
   * was SAID, so the bubble can show both. Recording it here rather than
   * folding it into `content` is what keeps the two separable.
   *
   * `StoredMessage` carries no origin field, so a turn re-read from history
   * recovers this by detecting the voice-origin annotation the agent loop baked
   * into `content` — see `parseUserContent`.
   */
  origin?: 'voice';
}

export interface TextBlock {
  kind: 'text';
  content: string;
}

export interface ImageBlock {
  kind: 'image';
  toolCallId: string;
  src: string;
  alt?: string;
  title?: string;
}

export interface HtmlBlock {
  kind: 'html';
  toolCallId: string;
  html: string;
  title?: string;
  height?: number;
}

export interface PdfBlock {
  kind: 'pdf';
  toolCallId: string;
  src: string;
  title?: string;
}

/**
 * A typed UI card emitted by a tool (`emit_card` / `render_ui`). The envelope
 * is schema-validated before it lands here — on the live path by
 * `CardEnvelopeSchema` below, on the replay path by the server.
 */
export interface CardBlock {
  kind: 'card';
  toolCallId: string;
  card: CardEnvelope;
}

/**
 * Anchor for a delegated run's card (pi-delegation §4.1). It carries the job
 * id and nothing else on purpose: the run's live state lives in `ChatState.runs`
 * (a `RunsState`, fed by the `run.update` digest), so a digest arriving at 1 Hz
 * does not rewrite the transcript. The block only records WHERE the handoff
 * happened, which is the one thing the transcript owns.
 */
export interface RunBlock {
  kind: 'run';
  jobId: string;
  runner: string;
}

export type AssistantBlock = TextBlock | ImageBlock | HtmlBlock | PdfBlock | CardBlock | RunBlock;

export interface AssistantTurn {
  id: string;
  role: 'assistant';
  blocks: AssistantBlock[];
  timestamp: number;
}

export type ChatMessage = UserMessage | AssistantTurn;

export interface ChatState {
  /** Finalised history. Most recent at the end. */
  messages: ChatMessage[];
  /** In-flight assistant turn — accumulates blocks until `done`. */
  currentTurn: AssistantTurn | null;
  /**
   * Open approval requests waiting on user input. Modal renders the
   * head of this list; multi-tab flows clear via approval.resolved.
   */
  pendingApprovals: ApprovalRequest[];
  /**
   * Open `clarify` requests — the agent asked the user a question mid-turn.
   * The card renders the head of this list; resolution clears via the
   * `clarify.resolved` SSE event (so every tab collapses the card together).
   */
  pendingClarifies: ClarifyRequestEvent[];
  isStreaming: boolean;
  error: string | null;
  /** Wall-clock ms of the most recent streaming event (text_delta, tool_start, tool_end).
   *  Null when not streaming. Used to detect stall in the UI. */
  lastStreamEventAt: number | null;
  /** Current operation label for the turn status bar. */
  currentOp: string | null;
  /** Wall-clock timestamp when the current turn started. Null when idle. */
  turnStartedAt: number | null;
  /**
   * Input-token count from the most recent `usage` event — the size of the
   * context sent to the model on the last turn. Null before the first turn.
   * Resets with the session (via `reset`), not per turn.
   */
  contextTokens: number | null;
  /**
   * Delegated runs seen on this session's stream (pi-delegation D9/D11). The
   * transcript holds a `RunBlock` anchor; the live state is here, so the card
   * stays live off the digest alone without a second SSE connection.
   */
  runs: RunsState;
  /**
   * Questions asked by those runs, queued per lane (D9/G1). Separate from
   * `pendingClarifies`, which stays the foreground `clarify` tool's floating
   * card — a run's question is drawn inside its own card instead (§4.5).
   */
  clarifyQueue: ClarifyQueueState;
  /**
   * Per-turn activity trail, keyed by `AssistantTurn.id` — every tool call and
   * finding this surface saw (feedback-activity-contract §4, "one trail, two
   * renderers"). Built from live `tool_start`/`tool_end`/`tool_progress` AND
   * from persisted tool rows on history load, so yesterday's replies have
   * trails too (durations show `—` when history lacks them).
   */
  trail: TrailState;
  /**
   * Coarse phase of the in-flight turn, for the status line above the composer.
   * Null when idle — the footer under the bubble takes over from there.
   */
  phase: TurnPhase | null;
  /** Turns the user stopped. Their footer reads `✗ stopped · N actions`. */
  stoppedTurnIds: string[];
  /**
   * The user pressed Stop and the events already on the wire have not drained.
   *
   * An abort is a local decision plus an RPC: the server keeps streaming until
   * it hears, so turn-advancing events keep arriving for a turn that is over.
   * While this is set they are dropped (see `TURN_ADVANCING_EVENTS`). Cleared
   * when a new generation starts — a submission, a history load, a reset.
   */
  abortedTurn: boolean;
}

/**
 * Status-line phases (feedback-activity-contract §2). `received` is set on send,
 * BEFORE any event, so every request is visibly acknowledged.
 */
export type TurnPhase = 'received' | 'thinking' | 'tool' | 'writing';

export const initialChatState: ChatState = {
  messages: [],
  currentTurn: null,
  pendingApprovals: [],
  pendingClarifies: [],
  isStreaming: false,
  error: null,
  lastStreamEventAt: null,
  currentOp: null,
  turnStartedAt: null,
  contextTokens: null,
  runs: emptyRunsState,
  clarifyQueue: emptyClarifyQueue,
  trail: {},
  phase: null,
  stoppedTurnIds: [],
  abortedTurn: false,
};

/**
 * State updates that don't come from SSE — UI actions (the user pressing
 * Send) and lifecycle events (history loaded, error cleared).
 */
export type ChatAction =
  | {
      type: 'submit-user-message';
      id: string;
      text: string;
      timestamp: number;
      attachments?: MessageAttachment[];
      /** `'voice'` when the turn was spoken. Typed sends omit it. */
      origin?: 'voice';
    }
  | { type: 'steer-user-message'; id: string; text: string; timestamp: number }
  | { type: 'history-loaded'; messages: StoredMessage[]; cards?: SessionCard[] }
  | { type: 'send-failed'; userMessageId: string; error: string }
  | { type: 'clear-error' }
  /**
   * Wipe state for a session change — starting a new session, or opening a
   * different one. Without this, the new session would briefly render with
   * the old session's messages until the history fetch completes.
   */
  | { type: 'reset' }
  | { type: 'undo-turns'; count: number }
  /**
   * Remember the answer this tab just sent for a run's question. `clarify.resolved`
   * carries only the source, so without this the resolved card could say a
   * question was answered but never what the answer was (§4.5).
   */
  | { type: 'note-clarify-answer'; requestId: string; answer: string; timestamp: number }
  /**
   * Runs this session already had going when the page connected, read from the
   * durable job rows (`tasks.list`) rather than from the stream.
   *
   * The `run.update` digest is live-only — no replay, no catch-up (see
   * `sse.ts`: a subscriber joining an open connection gets events from the
   * current point forward). So a chat page that mounts mid-run — a reload, a
   * trip to another tab, the remount a personality switch forces — has missed
   * every digest published so far, and the transcript anchor that only a FIRST
   * digest plants is never planted. Without this the run card is simply absent
   * for the rest of the run's life while the shell's drawer and status pill,
   * whose subscription outlives the page, stay correct.
   */
  | { type: 'runs-restored'; runs: RestoredRun[]; timestamp: number }
  /**
   * Questions this session's restored runs are parked on, read from the durable
   * clarify rows (`clarify.listPending`) rather than from the stream.
   *
   * The sibling of `runs-restored`, and needed for the same reason: the
   * `clarify.request` push is live-only too, so a page that mounts after a run
   * parked draws a card that says "waiting on you" above an empty space where
   * the question and its Allow/Deny buttons should be — the run is visibly
   * blocked and there is no way to unblock it.
   */
  | { type: 'clarify-restored'; pending: ClarifyRequestEvent[] }
  /**
   * The user pressed Stop. Nothing in the SSE stream says a turn was ABANDONED
   * rather than finished, so the surface records it: the trail closes (anything
   * still running did not finish) and the turn is remembered as stopped, which
   * is what makes its footer read `✗ stopped` instead of `✓ N actions`.
   */
  | { type: 'abort-turn' }
  /**
   * The Stop the user was already told had happened did NOT reach the server.
   *
   * `abort-turn` is optimistic — immediate acknowledgement is the point of the
   * contract — and it sets `abortedTurn`, which suppresses every turn-advancing
   * event until the next submission. If the RPC then fails, that guard blinds
   * the surface while the server keeps running tools: the UI says the turn
   * stopped while side effects continue. So the guard is lifted and the user is
   * told, which is the whole of the recovery.
   */
  | { type: 'abort-failed'; reason: string };

/** One durable job row, mapped onto what a run anchor + card need. */
export interface RestoredRun {
  jobId: string;
  runner: string;
  status: BackgroundJobStatusWire;
  spendUsd: number;
  elapsedMs: number;
}

/**
 * The SSE events that advance or resurrect an assistant turn — the ones an
 * aborted turn must not see.
 *
 * The judgement, spelled out because it is the whole of FIX B: suppress only
 * TURN state. `tool.approval_required` is in the set because it calls
 * `ensureTurn` and so mints a turn on its own; `approval.resolved` deliberately
 * is NOT, because it only REMOVES a request from the modal queue — dropping it
 * would strand an approval modal on screen with nothing left to close it.
 * Everything else the stream carries is session-scoped bookkeeping (`usage`,
 * `context_meta`, `message_persisted`, `cron.fired`, `mesh.changed`,
 * `evolve.*`, `run.update`, `clarify.*`, `stream_meta`) and keeps flowing: a
 * delegated run outlives the chat turn that launched it, and silencing those
 * would break surfaces the abort never touched.
 */
const TURN_ADVANCING_EVENTS = new Set<SseEventType>([
  'run_start',
  'text_delta',
  'thinking_delta',
  'tool_start',
  'tool_end',
  'tool_progress',
  'tool.approval_required',
  'done',
]);

export function applyEvent(state: ChatState, event: SseEvent, now: number): ChatState {
  // One guard, one place: a turn the user stopped stays stopped.
  if (state.abortedTurn && TURN_ADVANCING_EVENTS.has(event.type)) return state;

  switch (event.type) {
    case 'text_delta': {
      // Either extend the trailing text block of the current turn, or
      // start a fresh turn if this is the first event after a user
      // message. Tool blocks act as boundaries — a delta arriving after
      // a tool block opens a new text block on the same turn.
      const turn = ensureTurn(state.currentTurn, now);
      const lastBlock = turn.blocks[turn.blocks.length - 1];
      const newBlocks: AssistantBlock[] =
        lastBlock?.kind === 'text'
          ? [...turn.blocks.slice(0, -1), { kind: 'text', content: lastBlock.content + event.text }]
          : [...turn.blocks, { kind: 'text', content: event.text }];
      return {
        ...state,
        currentTurn: { ...turn, blocks: newBlocks },
        isStreaming: true,
        error: null,
        lastStreamEventAt: now,
        currentOp: null,
        phase: 'writing',
      };
    }

    case 'tool_start': {
      const turn = ensureTurn(state.currentTurn, now);
      const trail = applyTrailEvent(state.trail, turn.id, event);
      // Audience-filtered (Lane E): no row, no currentOp churn — but the
      // stream is alive, so refresh the stall clock.
      if (trail === null) return { ...state, lastStreamEventAt: now };
      return {
        ...state,
        currentTurn: turn,
        trail,
        isStreaming: true,
        error: null,
        lastStreamEventAt: now,
        currentOp: toolLabel(event.toolName, event.args),
        phase: 'tool',
      };
    }

    case 'tool_end': {
      const trail = applyTrailEvent(state.trail, state.currentTurn?.id ?? '', event);
      if (trail === null) return { ...state, lastStreamEventAt: now };
      // No matching action means no call this surface saw start; a stray end
      // must not invent a turn.
      if (trail === state.trail) return state;

      // `applyTrailEvent` resolves the call WHEREVER it lives, including a turn
      // `done` already moved into `messages` (the "tool_end races done" case).
      // Live-turn status may only move when the resolved row belongs to the
      // live turn — otherwise a late end paints a `thinking` status line on a
      // turn that already ended, which after the stall window reads
      // `⚠ still working` for ever. The changed key names the turn.
      const liveId = state.currentTurn?.id;
      const resolvedLiveTurn = liveId !== undefined && trail[liveId] !== state.trail[liveId];
      const base: ChatState = resolvedLiveTurn
        ? { ...state, trail, lastStreamEventAt: now, currentOp: null, phase: 'thinking' }
        : { ...state, trail, lastStreamEventAt: now };
      const uiType = event.structured?._uiType;

      if (uiType === 'image') {
        const content = event.structured?.content as string | undefined;
        const meta = event.structured?.metadata as Record<string, unknown> | undefined;
        if (!content) return base;
        const sibling: ImageBlock = {
          kind: 'image',
          toolCallId: event.toolCallId,
          src: content,
          alt: meta?.alt as string | undefined,
          title: meta?.title as string | undefined,
        };
        return appendSiblingBlock(base, sibling);
      }

      if (uiType === 'html') {
        const content = event.structured?.content as string | undefined;
        const meta = event.structured?.metadata as Record<string, unknown> | undefined;
        if (!content) return base;
        const sibling: HtmlBlock = {
          kind: 'html',
          toolCallId: event.toolCallId,
          html: content,
          title: meta?.title as string | undefined,
          height: meta?.height as number | undefined,
        };
        return appendSiblingBlock(base, sibling);
      }

      if (uiType === 'pdf') {
        const content = event.structured?.content as string | undefined;
        const meta = event.structured?.metadata as Record<string, unknown> | undefined;
        if (!content) return base;
        const sibling: PdfBlock = {
          kind: 'pdf',
          toolCallId: event.toolCallId,
          src: content,
          title: meta?.title as string | undefined,
        };
        return appendSiblingBlock(base, sibling);
      }

      // Typed UI cards (ui-cards-canvas). The server already gates the wire on
      // this same schema; re-parsing here is belt-and-braces — a malformed
      // envelope drops the card and leaves the trail row alone.
      if (event.structured?.card !== undefined) {
        const parsed = CardEnvelopeSchema.safeParse(event.structured.card);
        if (!parsed.success) return base;
        const sibling: CardBlock = {
          kind: 'card',
          toolCallId: event.toolCallId,
          card: parsed.data,
        };
        return appendSiblingBlock(base, sibling);
      }

      return base;
    }

    case 'done':
      return finaliseTurn(state);

    case 'error': {
      // A stream that errored is a turn that ENDED, so it takes the same
      // terminal transition `done` and `abort-turn` take. Clearing the phase
      // alone left every still-`running` action running for ever, on the one
      // path where honest accounting matters most.
      //
      // The streaming buffer is still not dropped — `finaliseTurn` moves it
      // into `messages`, so the user can read and copy what came back before
      // the error, which is what it was always for.
      //
      // The turn is NOT recorded in `stoppedTurnIds`: the user did not stop it.
      // Its actions are `failed`, so the footer leads with ✗ on its own, and a
      // turn that errored before running anything has no footer at all. Any
      // approval it was parked on goes with it — see `closeTurn`.
      const turn = state.currentTurn;
      const closed = turn ? { ...state, ...closeTurn(state, turn.id, 'errored') } : state;
      return { ...finaliseTurn(closed), error: event.error };
    }

    case 'tool.approval_required': {
      // The agent is paused on a tool call waiting for a human decision: queue
      // the request so the modal renders it, while the trail acknowledges that
      // the call exists (the row's own transitions are `applyTrailEvent`'s).
      const req = event.request;
      const turn = ensureTurn(state.currentTurn, now);
      return {
        ...state,
        currentTurn: turn,
        trail: applyTrailEvent(state.trail, turn.id, event) ?? state.trail,
        pendingApprovals: dedupeApproval(state.pendingApprovals, req),
        isStreaming: true,
      };
    }

    case 'approval.resolved': {
      // Pop the request from the modal queue. The follow-up `tool_start`
      // (allow) or `tool_end` (deny) transitions the trail row. Multi-tab:
      // when another tab decides, this fires here too and the modal closes.
      return {
        ...state,
        pendingApprovals: state.pendingApprovals.filter((p) => p.approvalId !== event.approvalId),
      };
    }

    case 'clarify.request': {
      // The agent called `clarify` — surface the question as a card. Dedupe
      // by requestId so an SSE reconnect re-delivering the event is a no-op.
      //
      // A question carrying a `jobId` was asked by a delegated run (D22): it
      // goes to the run queue only, because §4.5 draws it inside that run's
      // card. Floating it as well would ask the same question twice.
      const queue = applyClarifyEvent(state.clarifyQueue, event, now);
      if (event.jobId !== undefined) return { ...state, clarifyQueue: queue };
      if (state.pendingClarifies.some((c) => c.requestId === event.requestId)) return state;
      return {
        ...state,
        clarifyQueue: queue,
        pendingClarifies: [...state.pendingClarifies, event],
      };
    }

    case 'clarify.resolved': {
      // The clarify was answered / timed out / cancelled on some tab — drop
      // the card here too so every tab collapses it together.
      return {
        ...state,
        clarifyQueue: applyClarifyEvent(state.clarifyQueue, event, now),
        pendingClarifies: state.pendingClarifies.filter((c) => c.requestId !== event.requestId),
      };
    }

    case 'run.update': {
      // G9 — a delegated run's own events fire on its child session key, which
      // nobody watching this chat is subscribed to. This coalesced digest is
      // the card's ONLY feed, which is why the first one also plants the
      // transcript anchor: the run card renders where the handoff happened.
      const runs = applyRunEvent(state.runs, event, now);
      if (state.runs.byId[event.jobId] !== undefined) return { ...state, runs };
      const turn = ensureTurn(state.currentTurn, now);
      const anchor: RunBlock = { kind: 'run', jobId: event.jobId, runner: event.runner };
      return {
        ...state,
        runs,
        currentTurn: { ...turn, blocks: [...turn.blocks, anchor] },
      };
    }

    case 'run_start':
      // The clock starts when the user pressed Send, not when the server got
      // round to us — `submit-user-message` already set it.
      return {
        ...state,
        turnStartedAt: state.turnStartedAt ?? now,
        currentOp: null,
        phase: 'thinking',
      };

    case 'usage':
      // Track the most recent input-token count as the current context size.
      return { ...state, contextTokens: event.inputTokens };

    case 'tool_progress': {
      const turn = ensureTurn(state.currentTurn, now);
      const trail = applyTrailEvent(state.trail, turn.id, event);
      if (trail === null) return { ...state, lastStreamEventAt: now };
      // A new row means it was a finding (contract §5); anything else is status
      // text, which is this surface's own business.
      if (trail !== state.trail) {
        return { ...state, currentTurn: turn, trail, lastStreamEventAt: now };
      }
      return { ...state, currentOp: event.message, phase: 'tool', lastStreamEventAt: now };
    }

    case 'thinking_delta':
    case 'context_meta':
    case 'message_persisted':
    case 'cron.fired':
    case 'mesh.changed':
    case 'evolve.skill_pending':
    case 'dry_run_summary':
    case 'protocol.upgrade_required':
      return state;
  }
  return state;
}

export function applyAction(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'submit-user-message': {
      const message: UserMessage = {
        id: action.id,
        role: 'user',
        content: action.text,
        timestamp: action.timestamp,
        ...(action.attachments?.length ? { attachments: action.attachments } : {}),
        ...(action.origin === 'voice' ? { origin: 'voice' as const } : {}),
      };
      const hasTrail = (state.trail[state.currentTurn?.id ?? '']?.length ?? 0) > 0;
      const interrupted = state.currentTurn;
      return {
        ...state,
        messages: [...keepInterruptedTurn(state.messages, interrupted, hasTrail), message],
        // A turn cut off by the next question ENDED, exactly as Stop ends one.
        // Without this its actions stay `running` for ever and its footer leads
        // with a ✓ it never earned.
        ...(interrupted ? stopTurn(state, interrupted.id) : {}),
        currentTurn: null,
        isStreaming: false,
        error: null,
        lastStreamEventAt: null,
        currentOp: null,
        // Acknowledged before a single byte comes back (contract §2). The clock
        // starts here too, so elapsed measures what the user actually waited.
        phase: 'received',
        turnStartedAt: action.timestamp,
        // A new generation re-arms the stream the abort silenced.
        abortedTurn: false,
      };
    }

    case 'steer-user-message': {
      const message: UserMessage = {
        id: action.id,
        role: 'user',
        content: action.text,
        timestamp: action.timestamp,
        isSteer: true,
      };
      return {
        ...state,
        messages: [...state.messages, message],
      };
    }

    case 'history-loaded': {
      // One walk builds both — durations and results live on the stored rows,
      // which the parsed `ChatMessage[]` no longer carries (see trail.ts).
      const parsed = parseHistory(action.messages, action.cards ?? []);
      return {
        ...state,
        messages: parsed.messages,
        trail: parsed.trail,
        abortedTurn: false,
      };
    }

    case 'send-failed': {
      return {
        ...state,
        messages: state.messages.filter((m) => m.id !== action.userMessageId),
        error: action.error,
        isStreaming: false,
      };
    }

    case 'clear-error': {
      return { ...state, error: null };
    }

    case 'reset': {
      return initialChatState;
    }

    case 'note-clarify-answer': {
      return {
        ...state,
        clarifyQueue: noteAnswer(
          state.clarifyQueue,
          action.requestId,
          action.answer,
          action.timestamp,
        ),
      };
    }

    case 'runs-restored': {
      // Only runs this surface has never seen are restored: a run already in
      // `runs.byId` has a live digest behind it and an anchor already placed,
      // and re-anchoring it would draw the same card twice.
      let runs = state.runs;
      const anchors: RunBlock[] = [];
      for (const row of action.runs) {
        const next = seedRun(runs, row, action.timestamp);
        if (next === runs) continue;
        runs = next;
        anchors.push({ kind: 'run', jobId: row.jobId, runner: row.runner });
      }
      if (anchors.length === 0) return state;
      // A restored anchor lands at the TAIL, not at the handoff. §4.1 puts the
      // card "where the handoff happened", and on a live turn it still does —
      // but nothing in the persisted transcript records where that was, so the
      // honest placement for a rediscovered run is the end of what is on
      // screen, next to the hand-back its completion will write there anyway.
      return { ...state, runs, ...placeRestoredAnchors(state, anchors, action.timestamp) };
    }

    case 'clarify-restored': {
      // No transcript work to do — a question is drawn INSIDE its run's card
      // (§4.5), and `runs-restored` has already placed that card. Seeding is
      // non-destructive: a question the live stream already delivered, or one
      // this tab has answered, is left exactly as it is.
      const queue = seedClarify(state.clarifyQueue, action.pending);
      if (queue === state.clarifyQueue) return state;
      return { ...state, clarifyQueue: queue };
    }

    case 'abort-turn': {
      // Stop is terminal, not a pause: the footer REPLACES the status line
      // (contract §2/§3). Keeping `currentTurn` and `phase: 'stopped'` drew
      // both at once — the `✗ stopped` footer under a status line that never
      // went away, with the elapsed clock still ticking.
      //
      // `currentTurn` is only minted by the first SSE event, so a Stop pressed
      // during `received` — the slow start this contract exists to cover — has
      // no turn and therefore zero actions. §3: "zero actions → no footer",
      // so there is nothing to show and clearing the phase is the whole of it.
      const turn = state.currentTurn;
      const stopped = turn ? { ...state, ...stopTurn(state, turn.id) } : state;
      return { ...finaliseTurn(stopped), abortedTurn: true };
    }

    case 'abort-failed': {
      // The turn stays finalised — its partial answer and trail are what the
      // user has already read, and re-opening it would be a second lie. What is
      // undone is the SUPPRESSION: real events land again, so whatever the
      // server is still doing becomes visible instead of silently dropped.
      return {
        ...state,
        abortedTurn: false,
        error: `Stop did not reach the server — the turn may still be running. ${action.reason}`,
      };
    }

    case 'undo-turns': {
      const msgs = state.messages;
      let remaining = action.count;
      let end = msgs.length;
      while (end > 0 && remaining > 0) {
        const last = msgs[end - 1];
        if (end >= 2 && last?.role === 'assistant' && msgs[end - 2]?.role === 'user') {
          end -= 2;
          remaining--;
        } else {
          end--;
        }
      }
      return { ...state, messages: msgs.slice(0, end) };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureTurn(turn: AssistantTurn | null, now: number): AssistantTurn {
  return turn ?? { id: `asst-${now}`, role: 'assistant', blocks: [], timestamp: now };
}

/**
 * The one terminal transition for an in-flight turn. `done`, `abort-turn` and
 * `error` all end here, so the three endings cannot disagree about what "the
 * turn is over" means: the finished turn moves into `messages`, and every field
 * that describes a turn in flight is cleared — including `phase` and
 * `turnStartedAt`, which is what hands the status line's slot over to the
 * turn's own footer (contract §2/§3).
 *
 * A turn with neither content nor activity is nothing to keep (e.g. SSE
 * replayed a `done` for a turn already in history) — but a TOOL-ONLY turn has
 * zero blocks and a non-empty trail, and dropping that would lose its footer.
 *
 * Callers apply their own account of WHY first (`stopTurn`, `closeTrail`) and
 * pass the resulting state in, so the trail this reads is already closed.
 */
function finaliseTurn(state: ChatState): ChatState {
  const turn = state.currentTurn;
  const cleared = {
    currentTurn: null,
    isStreaming: false,
    lastStreamEventAt: null,
    currentOp: null,
    phase: null,
    turnStartedAt: null,
  } as const;
  if (!turn || (turn.blocks.length === 0 && (state.trail[turn.id]?.length ?? 0) === 0)) {
    return { ...state, ...cleared };
  }

  // Replay defense: if the most recent message in history matches this turn's
  // content, drop the live copy — but move its trail onto the history turn's id
  // first. The live copy is the one with real durations; the persisted rows
  // have none.
  const last = state.messages[state.messages.length - 1];
  if (last?.role === 'assistant' && turnsMatch(last, turn)) {
    return { ...state, ...rekeyTrail(state, turn.id, last.id), ...cleared };
  }

  return { ...state, messages: [...state.messages, turn], ...cleared };
}

/**
 * The trail half of a turn the USER ended: anything still running is marked
 * failed, and the turn is remembered as stopped so its footer reads
 * `✗ stopped · N actions`.
 *
 * Both of those endings share it — the user pressing Stop, and the user simply
 * asking the next question over the top of a live turn. A turn the SERVER ended
 * badly does not: `error` closes the trail without the stopped marker, because
 * nobody stopped it.
 *
 * Returns only the keys it changes, so the caller can spread it.
 */
function stopTurn(
  state: ChatState,
  turnId: string,
): Pick<ChatState, 'trail' | 'pendingApprovals' | 'stoppedTurnIds'> {
  return {
    ...closeTurn(state, turnId, 'stopped'),
    stoppedTurnIds: state.stoppedTurnIds.includes(turnId)
      ? state.stoppedTurnIds
      : [...state.stoppedTurnIds, turnId],
  };
}

/**
 * A turn that ended without finishing, in both places that outlive it: its
 * unfinished rows settle as failed (`closeTrail`), and the approval requests
 * that belong to it leave the modal queue.
 *
 * The second half is not optional. A call parked on `pending-approval` has an
 * open request in `pendingApprovals`, and once the turn is over nothing is left
 * alive to resolve it — leaving it queued strands the approval modal on screen
 * above a finalised `✗ stopped` turn, with Allow and Deny that answer nobody.
 *
 * `ApprovalRequest` carries no turn id, so the turn's own trail rows are the
 * attribution: a request whose `toolCallId` is a row of THIS turn dies with it,
 * and one that is not is left alone.
 *
 * Returns only the keys it changes, so the caller can spread it.
 */
function closeTurn(
  state: ChatState,
  turnId: string,
  reason: 'stopped' | 'errored',
): Pick<ChatState, 'trail' | 'pendingApprovals'> {
  const owned = new Set(
    (state.trail[turnId] ?? []).flatMap((e) => (e.kind === 'action' ? [e.toolCallId] : [])),
  );
  return {
    trail: closeTrail(state.trail, turnId, reason),
    pendingApprovals: state.pendingApprovals.filter((p) => !owned.has(p.toolCallId)),
  };
}

/**
 * Move a live turn's trail onto the history turn the replay defense kept, and
 * carry the stopped marker with it. Returns only the keys it changes.
 */
function rekeyTrail(
  state: ChatState,
  fromTurnId: string,
  toTurnId: string,
): Pick<ChatState, 'trail' | 'stoppedTurnIds'> {
  const { [fromTurnId]: live, ...rest } = state.trail;
  if (!live || live.length === 0)
    return { trail: state.trail, stoppedTurnIds: state.stoppedTurnIds };
  const stoppedTurnIds = state.stoppedTurnIds.includes(fromTurnId)
    ? [...state.stoppedTurnIds.filter((id) => id !== fromTurnId), toTurnId]
    : state.stoppedTurnIds;
  return { trail: { ...rest, [toTurnId]: live }, stoppedTurnIds };
}

/**
 * Put restored run anchors at the tail of the transcript: onto the in-flight
 * turn if one is running, else onto the last assistant message, else as a turn
 * of their own so a session whose whole history is a single user message still
 * shows its run.
 *
 * Returns only the keys it changes, so the caller can spread it.
 */
function placeRestoredAnchors(
  state: ChatState,
  anchors: RunBlock[],
  now: number,
): Pick<ChatState, 'messages'> | Pick<ChatState, 'currentTurn'> {
  if (state.currentTurn) {
    return {
      currentTurn: { ...state.currentTurn, blocks: [...state.currentTurn.blocks, ...anchors] },
    };
  }
  const lastIdx = state.messages.length - 1;
  const last = state.messages[lastIdx];
  if (last?.role === 'assistant') {
    const messages = [...state.messages];
    messages[lastIdx] = { ...last, blocks: [...last.blocks, ...anchors] };
    return { messages };
  }
  return {
    messages: [
      ...state.messages,
      { id: `asst-restored-${now}`, role: 'assistant', blocks: anchors, timestamp: now },
    ],
  };
}

const INTERRUPTED_MARKER = '[interrupted]';

/**
 * Mark reply text that was cut off before it finished.
 *
 * ONE marker convention for the whole app. It lives here rather than beside the
 * voice call state machine because BOTH transcripts need it and only one of them
 * can own it: the spoken transcript (`features/voice/voice-call-reducer.ts`,
 * which re-exports this) and the chat transcript below. Two spellings of the
 * same fact would be worse than the coupling.
 */
export function markInterrupted(text: string): string {
  return text.includes(INTERRUPTED_MARKER) ? text : `${text} ${INTERRUPTED_MARKER}`.trim();
}

/**
 * A new user message arriving while an assistant turn is still in flight.
 *
 * The partial answer is KEPT, marked `[interrupted]` — the same convention
 * barge-in already uses for the spoken transcript (DESIGN.md: "the line stays in
 * the transcript marked `[interrupted]`"). Discarding it, which is what this
 * used to do, throws away text the user has already READ: talk-mode's second
 * question arrives here as an ordinary `sendMessage`, so the answer being
 * watched simply vanished and the two questions closed up next to each other.
 *
 * A turn with neither blocks nor a trail has nothing to keep and is dropped —
 * the same guard `done` uses, and what keeps a late `done` from appending a
 * second copy of a turn already committed here. A turn cut off mid-tool-call
 * HAS a trail, so it is kept: its footer is the record that something started
 * and did not finish.
 */
function keepInterruptedTurn(
  messages: ChatMessage[],
  turn: AssistantTurn | null,
  hasTrail: boolean,
): ChatMessage[] {
  if (!turn || (turn.blocks.length === 0 && !hasTrail)) return messages;
  const last = turn.blocks[turn.blocks.length - 1];
  // The marker rides the trailing sentence when there is one. A turn cut off
  // mid-tool-call has no sentence to mark, and a bare marker block is still the
  // honest thing to show: something was started and did not finish.
  const blocks: AssistantBlock[] =
    last?.kind === 'text'
      ? [...turn.blocks.slice(0, -1), { kind: 'text', content: markInterrupted(last.content) }]
      : [...turn.blocks, { kind: 'text', content: INTERRUPTED_MARKER }];
  return [...messages, { ...turn, blocks }];
}

function dedupeApproval(current: ApprovalRequest[], next: ApprovalRequest): ApprovalRequest[] {
  if (current.some((p) => p.approvalId === next.approvalId)) return current;
  return [...current, next];
}

/**
 * Append a sibling block to the last turn (currentTurn first, else last
 * assistant message) — where the tool that produced it was running.
 */
function appendSiblingBlock(
  state: ChatState,
  sibling: ImageBlock | HtmlBlock | PdfBlock | CardBlock,
): ChatState {
  if (state.currentTurn) {
    return {
      ...state,
      currentTurn: {
        ...state.currentTurn,
        blocks: [...state.currentTurn.blocks, sibling],
      },
    };
  }
  const lastIdx = state.messages.length - 1;
  const last = state.messages[lastIdx];
  if (last?.role === 'assistant') {
    const newMessages = [...state.messages];
    newMessages[lastIdx] = { ...last, blocks: [...last.blocks, sibling] };
    return { ...state, messages: newMessages };
  }
  return state;
}

/** Two turns match when they hold the same blocks — same kinds in order, same
 *  text, same artifact ids. Used by the `done` replay defense. Tool calls are
 *  deliberately absent: they are not blocks any more, and the live turn and its
 *  persisted twin must still match. */
function turnsMatch(a: AssistantTurn, b: AssistantTurn): boolean {
  if (a.blocks.length !== b.blocks.length) return false;
  for (let i = 0; i < a.blocks.length; i++) {
    const x = a.blocks[i];
    const y = b.blocks[i];
    if (!x || !y) return false;
    if (x.kind !== y.kind) return false;
    if (x.kind === 'text' && y.kind === 'text' && x.content !== y.content) return false;
    if (x.kind === 'image' && y.kind === 'image' && x.toolCallId !== y.toolCallId) return false;
    if (x.kind === 'html' && y.kind === 'html' && x.toolCallId !== y.toolCallId) return false;
    if (x.kind === 'pdf' && y.kind === 'pdf' && x.toolCallId !== y.toolCallId) return false;
    if (x.kind === 'card' && y.kind === 'card' && x.toolCallId !== y.toolCallId) return false;
  }
  return true;
}

/**
 * The voice-origin annotation as the agent loop persists it, matched as a whole
 * block: the self-closing tag on its own line, the single instruction line that
 * follows it, and the blank line separating it from whatever comes next.
 *
 * Producer: `buildVoiceOriginAnnotation` in `packages/core/src/voice-origin.ts`
 * (baked into `content` by `stages/context-assembly.ts`). The instruction is
 * one line with no internal newline, which is what lets `[^\n]*` bound it;
 * `packages/core/src/__tests__/voice-origin-annotation.test.ts` pins that shape
 * so the producer cannot drift away from this matcher.
 *
 * Anchored to a block boundary (start of string, or a blank line) so prose that
 * merely mentions the tag is left alone.
 */
const VOICE_ORIGIN_BLOCK = new RegExp(
  `(^|\\n\\n)<${VOICE_ORIGIN_TAG}(?:\\s[^\\n>]*)?/>\\n[^\\n]*(\\n\\n|$)`,
);

/**
 * Split a stored user message into its displayable text and whether it was
 * spoken.
 *
 * History replays `content` exactly as the agent loop persisted it, annotations
 * and all. The voice-origin block is plumbing for the model, not something the
 * user typed, so it comes out of the bubble — but the FACT it carried does not
 * get thrown away with it: it comes back as `origin`, which is what the mono
 * `voice` marker renders from. That is the invariant the whole feature rests
 * on — the transcript never erases the audio marker.
 *
 * The `<attachments>` annotation leaks the same way and is deliberately left
 * alone: it is W3.2's contract, not this change's, and stripping it here would
 * be a silent second decision.
 */
export function parseUserContent(content: string): { text: string; origin?: 'voice' } {
  const match = VOICE_ORIGIN_BLOCK.exec(content);
  if (!match) return { text: content };
  // Removing a middle block would fuse its neighbours; keep one separator.
  // At either end there is no neighbour, so the separator goes too.
  const joiner = match[1] && match[2] ? '\n\n' : '';
  return { text: content.replace(VOICE_ORIGIN_BLOCK, joiner), origin: 'voice' };
}

/**
 * Reconstruct an interleaved history from the server's flat StoredMessage
 * stream. The agent loop persists each LLM iteration as a separate
 * assistant row (with its tool_use blocks attached) followed by the
 * tool_result rows it produced. We collapse those into a single
 * AssistantTurn per logical user→done cycle so the UI matches what the
 * user actually saw stream.
 *
 * ONE walk produces two things, because only this walk has both: the visible
 * `messages`, and the `trail` those turns' footers render. Tool calls are not
 * blocks any more (contract §1), and the durations/results a trail row wants
 * live on the stored rows rather than on the parsed messages — so a separate
 * `deriveTrailsFromHistory(messages)` could not recover them.
 *
 * `cards` are the envelopes the session replayed alongside the messages; each
 * one is placed where the tool call that emitted it sat.
 */
function parseHistory(
  stored: StoredMessage[],
  cards: SessionCard[] = [],
): { messages: ChatMessage[]; trail: TrailState } {
  const ui: ChatMessage[] = [];
  const trail: TrailState = {};
  // Where each replayed tool call sat in its turn. With tool blocks gone there
  // is no anchor block to search for, so the position is recorded as the walk
  // passes it and kept correct as cards are spliced in.
  const anchors = new Map<string, CardAnchor>();
  const actionsById = new Map<string, TrailAction>();
  let current: AssistantTurn | null = null;
  let entries: TrailEntry[] = [];

  const flush = () => {
    // A tool-only turn has no blocks and is still a turn — its trail is the
    // whole record of it.
    if (current && (current.blocks.length > 0 || entries.length > 0)) {
      ui.push(current);
      if (entries.length > 0) trail[current.id] = entries;
    }
    current = null;
    entries = [];
  };

  for (const m of stored) {
    if (m.role === 'user') {
      flush();
      const { text, origin } = parseUserContent(m.content);
      ui.push({
        id: m.id,
        role: 'user',
        content: text,
        timestamp: new Date(m.timestamp).getTime(),
        ...(origin ? { origin } : {}),
      });
      continue;
    }

    if (m.role === 'user_steer') {
      flush();
      // No parseUserContent here: a steer is persisted as the raw steer text
      // (`stages/tool-processing.ts`) and never carries an annotation.
      ui.push({
        id: m.id,
        role: 'user',
        content: m.content,
        timestamp: new Date(m.timestamp).getTime(),
        isSteer: true,
      });
      continue;
    }

    if (m.role === 'assistant') {
      if (!current) {
        current = {
          id: m.id,
          role: 'assistant',
          blocks: [],
          timestamp: new Date(m.timestamp).getTime(),
        };
      }
      const turn = current;
      const text = m.content.trim();
      if (text !== '') {
        turn.blocks.push({ kind: 'text', content: m.content });
      }
      if (m.toolCalls && m.toolCalls.length > 0) {
        for (const tc of m.toolCalls) {
          const action: TrailAction = {
            kind: 'action',
            toolCallId: tc.id,
            toolName: tc.name,
            args: tc.input,
            // History doesn't preserve ok/failed for tool_result rows (the
            // server stores both kinds in `content` without a flag), so the
            // row says exactly that: it ran, the outcome was not recorded.
            // Defaulting to `ok` painted a ✓ on calls that may well have
            // failed. A live `tool_end` still flips it either way. No duration
            // is persisted either, which is why the row renders `—`.
            //
            // FOLLOW-UP: persist an `is_error` flag on `tool_result` rows and
            // this becomes a real `ok`/`failed` again.
            status: 'unrecorded',
          };
          entries.push(action);
          actionsById.set(tc.id, action);
          anchors.set(tc.id, { turn, index: turn.blocks.length });
        }
      }
      continue;
    }

    if (m.role === 'tool_result') {
      // Hydrate the matching trail action's result. Skip if we somehow have a
      // tool_result before any assistant message — shouldn't happen but be
      // defensive.
      if (!current || !m.toolCallId) continue;
      const action = actionsById.get(m.toolCallId);
      if (action) action.result = m.content;
    }

    // role === 'system' — skip in the chat surface.
  }
  flush();
  insertReplayedCards(ui, cards, anchors);
  return { messages: ui, trail };
}

/** Where a replayed card goes, and which turn it goes into. */
interface CardAnchor {
  turn: AssistantTurn;
  index: number;
}

/**
 * Place each replayed card where the tool call that emitted it ran, so a
 * reloaded turn reads in the same order it streamed. Cards are applied in `seq`
 * order and mutate the freshly-built turns from `parseHistory` in place.
 *
 * No matching tool call is a defect upstream, not a reason to lose the card:
 * it lands at the end of the last assistant turn instead.
 */
function insertReplayedCards(
  ui: ChatMessage[],
  cards: SessionCard[],
  anchors: Map<string, CardAnchor>,
): void {
  for (const entry of [...cards].sort((a, b) => a.seq - b.seq)) {
    const block: CardBlock = {
      kind: 'card',
      toolCallId: entry.toolCallId,
      card: entry.envelope,
    };
    const anchor = anchors.get(entry.toolCallId);
    if (anchor) {
      // Step past cards already placed for this call so `seq` order survives.
      let at = anchor.index;
      while (anchor.turn.blocks[at]?.kind === 'card') at++;
      anchor.turn.blocks.splice(at, 0, block);
      // Every later anchor in the same turn just shifted right by one.
      for (const other of anchors.values()) {
        if (other.turn === anchor.turn && other.index > at) other.index++;
      }
      continue;
    }
    for (let i = ui.length - 1; i >= 0; i--) {
      const message = ui[i];
      if (message?.role === 'assistant') {
        message.blocks.push(block);
        break;
      }
    }
  }
}
