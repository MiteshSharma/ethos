import { VOICE_ORIGIN_TAG } from '@ethosagent/types';
import {
  type ApprovalRequest,
  type BackgroundJobStatusWire,
  type CardEnvelope,
  CardEnvelopeSchema,
  type ClarifyRequestEvent,
  type SessionCard,
  type SseEvent,
  type StoredMessage,
} from '@ethosagent/web-contracts';
import type { MessageAttachment } from './attachments';
import {
  applyClarifyEvent,
  type ClarifyQueueState,
  emptyClarifyQueue,
  noteAnswer,
} from './clarify-queue';
import { applyRunEvent, emptyRunsState, type RunsState, seedRun } from './pi-run-reducer';

// Pure reducer that maps SSE events → ChatState. Extracted from the
// `useChat` hook so we can test the state machine in isolation, without
// React or `EventSource` infrastructure.
//
// W2b extends the W2a shape: an assistant turn is no longer a flat
// string. It's an ordered sequence of "blocks" — text segments and
// tool calls — that render in arrival order. This matches how the
// agent loop actually streams output (tool_use blocks appear between
// chunks of text within a single turn) and what the chip rendering
// needs to interleave correctly.

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

export interface ToolBlock {
  kind: 'tool';
  toolCallId: string;
  toolName: string;
  args: unknown;
  /**
   * Live state.
   *  • `pending-approval` — server is asking the user to approve before
   *    running the call. The chip surfaces a "?" icon; the modal does the
   *    actual asking. Flips to `running` on tool_start once granted.
   *  • `running`          — tool is executing. Spinner.
   *  • `ok` / `failed`    — terminal. Set by tool_end.
   */
  status: 'pending-approval' | 'running' | 'ok' | 'failed';
  /** Wall-clock duration in ms when the tool finished. */
  durationMs?: number;
  /** Tool output body — surfaces in click-to-expand. */
  result?: string;
  /** Reason copy carried from the approval request (e.g. "force-delete"). */
  reason?: string;
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

export type AssistantBlock =
  | TextBlock
  | ToolBlock
  | ImageBlock
  | HtmlBlock
  | PdfBlock
  | CardBlock
  | RunBlock;

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
}

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
  | { type: 'runs-restored'; runs: RestoredRun[]; timestamp: number };

/** One durable job row, mapped onto what a run anchor + card need. */
export interface RestoredRun {
  jobId: string;
  runner: string;
  status: BackgroundJobStatusWire;
  spendUsd: number;
  elapsedMs: number;
}

export function applyEvent(state: ChatState, event: SseEvent, now: number): ChatState {
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
      };
    }

    case 'tool_start': {
      // Lane E (tools-as-code-api) — in-script inner calls are tagged
      // `audience: 'internal'`: no chip, no currentOp churn. The stream is
      // still alive, so refresh the stall clock.
      if (event.audience === 'internal') {
        return { ...state, lastStreamEventAt: now };
      }
      // Two paths converge here:
      //   1. Auto-allowed call — no approval was needed, this is the
      //      first event. Append a fresh running block.
      //   2. Approved call — `tool.approval_required` already created a
      //      pending-approval block. Flip it to running.
      const turn = ensureTurn(state.currentTurn, now);
      const existingIdx = turn.blocks.findIndex(
        (b) => b.kind === 'tool' && b.toolCallId === event.toolCallId,
      );
      let blocks: AssistantBlock[];
      if (existingIdx >= 0) {
        const block = turn.blocks[existingIdx];
        if (block?.kind === 'tool') {
          blocks = [...turn.blocks];
          blocks[existingIdx] = { ...block, status: 'running', args: event.args };
        } else {
          blocks = turn.blocks;
        }
      } else {
        const tool: ToolBlock = {
          kind: 'tool',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          status: 'running',
        };
        blocks = [...turn.blocks, tool];
      }
      return {
        ...state,
        currentTurn: { ...turn, blocks },
        isStreaming: true,
        error: null,
        lastStreamEventAt: now,
        currentOp: `⚙ ${event.toolName}`,
      };
    }

    case 'tool_end': {
      // Lane E — internal inner-call ends have no chip to flip; skip.
      if (event.audience === 'internal') {
        return { ...state, lastStreamEventAt: now };
      }
      // Find the matching running block by toolCallId and flip it.
      // The block could live in `currentTurn` (live) or in the last
      // assistant message of `messages` (when tool_end races the `done`
      // event after a refresh). Try current first.
      const updated = updateToolBlock(state, event.toolCallId, (block) => ({
        ...block,
        status: event.ok ? 'ok' : 'failed',
        durationMs: event.durationMs,
        ...(event.result !== undefined ? { result: event.result } : {}),
      }));
      if (!updated) return state;

      const base = { ...updated, lastStreamEventAt: now, currentOp: '\u{1F4AD} Thinking…' };
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
      // envelope drops the card and keeps the plain tool chip.
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

    case 'done': {
      // Finalise the in-flight turn. If we somehow got `done` without
      // any blocks (e.g. SSE replayed the event for an old turn that's
      // already in history), don't append anything — the dedupe defense
      // below guards against double-rendering on page refresh.
      if (!state.currentTurn || state.currentTurn.blocks.length === 0) {
        return {
          ...state,
          currentTurn: null,
          isStreaming: false,
          lastStreamEventAt: null,
          currentOp: null,
          turnStartedAt: null,
        };
      }

      // Replay defense: if the most recent message in history matches
      // this turn's text content + tool ids, drop the live copy.
      const last = state.messages[state.messages.length - 1];
      if (last?.role === 'assistant' && turnsMatch(last, state.currentTurn)) {
        return {
          ...state,
          currentTurn: null,
          isStreaming: false,
          lastStreamEventAt: null,
          currentOp: null,
          turnStartedAt: null,
        };
      }

      return {
        ...state,
        messages: [...state.messages, state.currentTurn],
        currentTurn: null,
        isStreaming: false,
        lastStreamEventAt: null,
        currentOp: null,
        turnStartedAt: null,
      };
    }

    case 'error': {
      // Don't drop the streaming buffer — the user might want to copy
      // what came back before the error.
      return {
        ...state,
        isStreaming: false,
        error: event.error,
        lastStreamEventAt: null,
        currentOp: null,
        turnStartedAt: null,
      };
    }

    case 'tool.approval_required': {
      // The agent is paused on a tool call waiting for a human decision.
      // Two state updates fire together:
      //   • Add the request to `pendingApprovals` so the modal renders it.
      //   • Pre-create the tool block with status 'pending-approval' so
      //     the chip surface acknowledges the call exists. If user denies,
      //     `tool_end` (with no preceding `tool_start`) flips it to failed.
      //     If user allows, `tool_start` flips it to running.
      const req = event.request;
      const turn = ensureTurn(state.currentTurn, now);
      const existingIdx = turn.blocks.findIndex(
        (b) => b.kind === 'tool' && b.toolCallId === req.toolCallId,
      );
      let blocks: AssistantBlock[];
      if (existingIdx >= 0) {
        const block = turn.blocks[existingIdx];
        if (block?.kind === 'tool') {
          blocks = [...turn.blocks];
          blocks[existingIdx] = {
            ...block,
            status: 'pending-approval',
            ...(req.reason ? { reason: req.reason } : {}),
          };
        } else {
          blocks = turn.blocks;
        }
      } else {
        const tool: ToolBlock = {
          kind: 'tool',
          toolCallId: req.toolCallId,
          toolName: req.toolName,
          args: req.args,
          status: 'pending-approval',
          ...(req.reason ? { reason: req.reason } : {}),
        };
        blocks = [...turn.blocks, tool];
      }
      return {
        ...state,
        currentTurn: { ...turn, blocks },
        pendingApprovals: dedupeApproval(state.pendingApprovals, req),
        isStreaming: true,
      };
    }

    case 'approval.resolved': {
      // Pop the request from the modal queue. The follow-up `tool_start`
      // (allow) or `tool_end` (deny) transitions the chip block. Multi-tab:
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
      // transcript anchor: the run card renders where the handoff happened,
      // in place of what would otherwise be a tool chip.
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
      return { ...state, turnStartedAt: now, currentOp: '\u{1F4AD} Thinking…' };

    case 'usage':
      // Track the most recent input-token count as the current context size.
      return { ...state, contextTokens: event.inputTokens };

    case 'thinking_delta':
    case 'tool_progress':
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
      return {
        ...state,
        messages: [...keepInterruptedTurn(state.messages, state.currentTurn), message],
        currentTurn: null,
        isStreaming: false,
        error: null,
        lastStreamEventAt: null,
        currentOp: null,
        turnStartedAt: null,
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
      return { ...state, messages: parseHistory(action.messages, action.cards ?? []) };
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
 * A turn with no blocks yet has nothing to keep and is dropped as before — the
 * same guard `done` uses, and what keeps a late `done` from appending a second
 * copy of a turn already committed here.
 */
function keepInterruptedTurn(messages: ChatMessage[], turn: AssistantTurn | null): ChatMessage[] {
  if (!turn || turn.blocks.length === 0) return messages;
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
 * Apply `update` to a tool block matching `toolCallId`, searching the
 * current turn first and the last assistant message second. Returns the
 * new state, or null if no match exists (caller falls back to no-op).
 */
function updateToolBlock(
  state: ChatState,
  toolCallId: string,
  update: (block: ToolBlock) => ToolBlock,
): ChatState | null {
  if (state.currentTurn) {
    const idx = state.currentTurn.blocks.findIndex(
      (b) => b.kind === 'tool' && b.toolCallId === toolCallId,
    );
    if (idx >= 0) {
      const block = state.currentTurn.blocks[idx];
      if (block?.kind === 'tool') {
        const newBlocks = [...state.currentTurn.blocks];
        newBlocks[idx] = update(block);
        return { ...state, currentTurn: { ...state.currentTurn, blocks: newBlocks } };
      }
    }
  }
  // Try the last assistant message — covers the case where `done`
  // fired before `tool_end` (rare but possible if the SSE buffer
  // delivered events out of order across a reconnect).
  const lastIdx = state.messages.length - 1;
  const last = state.messages[lastIdx];
  if (last?.role === 'assistant') {
    const blockIdx = last.blocks.findIndex((b) => b.kind === 'tool' && b.toolCallId === toolCallId);
    if (blockIdx >= 0) {
      const block = last.blocks[blockIdx];
      if (block?.kind === 'tool') {
        const newBlocks = [...last.blocks];
        newBlocks[blockIdx] = update(block);
        const newMessages = [...state.messages];
        newMessages[lastIdx] = { ...last, blocks: newBlocks };
        return { ...state, messages: newMessages };
      }
    }
  }
  return null;
}

/**
 * Append a sibling block to the last turn (currentTurn first, else last
 * assistant message). Mirrors the location updateToolBlock wrote to.
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

/** Two turns match when they have the same text content + tool ids in
 *  order. Used by the `done` replay defense. */
function turnsMatch(a: AssistantTurn, b: AssistantTurn): boolean {
  if (a.blocks.length !== b.blocks.length) return false;
  for (let i = 0; i < a.blocks.length; i++) {
    const x = a.blocks[i];
    const y = b.blocks[i];
    if (!x || !y) return false;
    if (x.kind !== y.kind) return false;
    if (x.kind === 'text' && y.kind === 'text' && x.content !== y.content) return false;
    if (x.kind === 'tool' && y.kind === 'tool' && x.toolCallId !== y.toolCallId) return false;
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
 * `cards` are the envelopes the session replayed alongside the messages; each
 * one is placed next to the tool call that emitted it.
 */
function parseHistory(stored: StoredMessage[], cards: SessionCard[] = []): ChatMessage[] {
  const ui: ChatMessage[] = [];
  let current: AssistantTurn | null = null;

  const flush = () => {
    if (current && current.blocks.length > 0) ui.push(current);
    current = null;
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
      const text = m.content.trim();
      if (text !== '') {
        current.blocks.push({ kind: 'text', content: m.content });
      }
      if (m.toolCalls && m.toolCalls.length > 0) {
        for (const tc of m.toolCalls) {
          current.blocks.push({
            kind: 'tool',
            toolCallId: tc.id,
            toolName: tc.name,
            args: tc.input,
            // History doesn't preserve ok/failed for tool_result rows
            // (server stores both kinds in `content` without a flag).
            // Default to ok; tool_end via SSE updates the live state.
            status: 'ok',
          });
        }
      }
      continue;
    }

    if (m.role === 'tool_result') {
      // Match the corresponding tool block in the current turn and
      // hydrate its result field. Skip if we somehow have a tool_result
      // before any assistant message — shouldn't happen but be defensive.
      if (!current || !m.toolCallId) continue;
      const block = current.blocks.find((b) => b.kind === 'tool' && b.toolCallId === m.toolCallId);
      if (block?.kind === 'tool') {
        block.result = m.content;
      }
    }

    // role === 'system' — skip in the chat surface.
  }
  flush();
  insertReplayedCards(ui, cards);
  return ui;
}

/**
 * Place each replayed card directly after the tool block that emitted it, so
 * a reloaded turn reads in the same order it streamed. Cards are applied in
 * `seq` order and mutate the freshly-built turns from `parseHistory` in place.
 *
 * No matching tool block is a defect upstream, not a reason to lose the card:
 * it lands at the end of the last assistant turn instead.
 */
function insertReplayedCards(ui: ChatMessage[], cards: SessionCard[]): void {
  for (const entry of [...cards].sort((a, b) => a.seq - b.seq)) {
    const block: CardBlock = {
      kind: 'card',
      toolCallId: entry.toolCallId,
      card: entry.envelope,
    };
    const turn = ui.find(
      (m): m is AssistantTurn =>
        m.role === 'assistant' &&
        m.blocks.some((b) => b.kind === 'tool' && b.toolCallId === entry.toolCallId),
    );
    if (turn) {
      const toolIdx = turn.blocks.findIndex(
        (b) => b.kind === 'tool' && b.toolCallId === entry.toolCallId,
      );
      // Step past cards already placed for this call so `seq` order survives.
      let at = toolIdx + 1;
      while (turn.blocks[at]?.kind === 'card') at++;
      turn.blocks.splice(at, 0, block);
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
