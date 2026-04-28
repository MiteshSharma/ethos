import type { ApprovalRequest, SseEvent, StoredMessage } from '@ethosagent/web-contracts';

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

export type AssistantBlock = TextBlock | ToolBlock;

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
  isStreaming: boolean;
  error: string | null;
}

export const initialChatState: ChatState = {
  messages: [],
  currentTurn: null,
  pendingApprovals: [],
  isStreaming: false,
  error: null,
};

/**
 * State updates that don't come from SSE — UI actions (the user pressing
 * Send) and lifecycle events (history loaded, error cleared).
 */
export type ChatAction =
  | { type: 'submit-user-message'; id: string; text: string; timestamp: number }
  | { type: 'history-loaded'; messages: StoredMessage[] }
  | { type: 'send-failed'; userMessageId: string; error: string }
  | { type: 'clear-error' }
  /**
   * Wipe state for a session change — used by the personality switcher
   * after fork. Without this, the new session would briefly render with
   * the old session's messages until the history fetch completes.
   */
  | { type: 'reset' };

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
      };
    }

    case 'tool_start': {
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
      };
    }

    case 'tool_end': {
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
      return updated ?? state;
    }

    case 'done': {
      // Finalise the in-flight turn. If we somehow got `done` without
      // any blocks (e.g. SSE replayed the event for an old turn that's
      // already in history), don't append anything — the dedupe defense
      // below guards against double-rendering on page refresh.
      if (!state.currentTurn || state.currentTurn.blocks.length === 0) {
        return { ...state, currentTurn: null, isStreaming: false };
      }

      // Replay defense: if the most recent message in history matches
      // this turn's text content + tool ids, drop the live copy.
      const last = state.messages[state.messages.length - 1];
      if (last?.role === 'assistant' && turnsMatch(last, state.currentTurn)) {
        return { ...state, currentTurn: null, isStreaming: false };
      }

      return {
        ...state,
        messages: [...state.messages, state.currentTurn],
        currentTurn: null,
        isStreaming: false,
      };
    }

    case 'error': {
      // Don't drop the streaming buffer — the user might want to copy
      // what came back before the error.
      return {
        ...state,
        isStreaming: false,
        error: event.error,
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

    case 'thinking_delta':
    case 'tool_progress':
    case 'usage':
    case 'context_meta':
    case 'message_persisted':
    case 'cron.fired':
    case 'mesh.changed':
    case 'evolve.skill_pending':
    case 'protocol.upgrade_required':
      return state;
  }
}

export function applyAction(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'submit-user-message': {
      const message: UserMessage = {
        id: action.id,
        role: 'user',
        content: action.text,
        timestamp: action.timestamp,
      };
      return {
        ...state,
        messages: [...state.messages, message],
        currentTurn: null,
        isStreaming: false,
        error: null,
      };
    }

    case 'history-loaded': {
      return { ...state, messages: parseHistory(action.messages) };
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
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureTurn(turn: AssistantTurn | null, now: number): AssistantTurn {
  return turn ?? { id: `asst-${now}`, role: 'assistant', blocks: [], timestamp: now };
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
  }
  return true;
}

/**
 * Reconstruct an interleaved history from the server's flat StoredMessage
 * stream. The agent loop persists each LLM iteration as a separate
 * assistant row (with its tool_use blocks attached) followed by the
 * tool_result rows it produced. We collapse those into a single
 * AssistantTurn per logical user→done cycle so the UI matches what the
 * user actually saw stream.
 */
function parseHistory(stored: StoredMessage[]): ChatMessage[] {
  const ui: ChatMessage[] = [];
  let current: AssistantTurn | null = null;

  const flush = () => {
    if (current && current.blocks.length > 0) ui.push(current);
    current = null;
  };

  for (const m of stored) {
    if (m.role === 'user') {
      flush();
      ui.push({
        id: m.id,
        role: 'user',
        content: m.content,
        timestamp: new Date(m.timestamp).getTime(),
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
  return ui;
}
