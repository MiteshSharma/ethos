import type { SseEvent, StoredMessage } from '@ethosagent/web-contracts';

// Pure reducer that maps SSE events → ChatState. Extracted from the
// `useChat` hook so we can test the state machine in isolation, without
// React or `EventSource` infrastructure. Every test is a one-line
// `applyEvent(prev, event)` call.
//
// W2a scope:
//   • text_delta accumulates into the live `streamingText` buffer.
//   • done finalises that into a real assistant message.
//   • error sets the surface error.
//   • thinking_delta, tool_*, usage, message_persisted, approval.* —
//     accepted by the discriminated union but ignored for rendering.
//     Tool chips land in W2b; approval modal in W2c.

export interface UserMessage {
  id: string;
  role: 'user';
  content: string;
  /** Wall-clock when the user pressed Send. */
  timestamp: number;
}

export interface AssistantMessage {
  id: string;
  role: 'assistant';
  content: string;
  /** Wall-clock when the `done` event arrived. */
  timestamp: number;
}

export type ChatMessage = UserMessage | AssistantMessage;

export interface ChatState {
  messages: ChatMessage[];
  /** Live assistant text being streamed. Null between turns. */
  streamingText: string | null;
  isStreaming: boolean;
  /** Surface-level error from SSE / RPC. Cleared when the next turn starts. */
  error: string | null;
}

export const initialChatState: ChatState = {
  messages: [],
  streamingText: null,
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
  | { type: 'clear-error' };

export function applyEvent(state: ChatState, event: SseEvent, now: number): ChatState {
  switch (event.type) {
    case 'text_delta': {
      // First chunk of a new turn — start a fresh streaming buffer and
      // flag the surface as actively streaming so the composer can
      // render its "agent typing" affordance.
      return {
        ...state,
        streamingText: (state.streamingText ?? '') + event.text,
        isStreaming: true,
        error: null,
      };
    }

    case 'done': {
      // Server's authoritative final text — trust it over what we
      // accumulated (e.g. if a chunk got lost on reconnect, the `done`
      // event has the canonical body).
      const finalText = event.text;

      // Replay defense: if the most recent message in history is already
      // this same assistant text, the SSE buffer just replayed an old
      // turn after page refresh. Don't double-append.
      const last = state.messages[state.messages.length - 1];
      if (last?.role === 'assistant' && last.content === finalText) {
        return { ...state, streamingText: null, isStreaming: false };
      }

      const assistantMessage: AssistantMessage = {
        id: `asst-${now}`,
        role: 'assistant',
        content: finalText,
        timestamp: now,
      };
      return {
        ...state,
        messages: [...state.messages, assistantMessage],
        streamingText: null,
        isStreaming: false,
      };
    }

    case 'error': {
      // Don't drop the streaming buffer — the user might want to copy
      // what came back before the error. The composer surfaces the
      // error inline; clearing it happens on the next user message.
      return {
        ...state,
        isStreaming: false,
        error: event.error,
      };
    }

    // Discriminated union members handled later in W2b/W2c. Listing them
    // explicitly so a future type-narrowing exhaustive switch surfaces
    // any missing handlers.
    case 'thinking_delta':
    case 'tool_start':
    case 'tool_progress':
    case 'tool_end':
    case 'usage':
    case 'context_meta':
    case 'message_persisted':
    case 'tool.approval_required':
    case 'approval.resolved':
    case 'cron.fired':
    case 'mesh.changed':
    case 'evolve.skill_pending':
    case 'protocol.upgrade_required':
      return state;
  }
}

/**
 * Apply a UI/lifecycle action. Kept separate from `applyEvent` so the
 * SSE pipeline and the user-action pipeline don't collapse into one
 * giant switch with two unrelated discriminator unions.
 */
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
        streamingText: null,
        // Streaming flips on for real when the first text_delta arrives.
        // Until then the composer can show "queued" state — false here
        // means the agent hasn't actually started.
        isStreaming: false,
        error: null,
      };
    }

    case 'history-loaded': {
      // Map StoredMessage[] (server shape) into ChatMessage[] (UI shape).
      // Tool messages skip rendering for W2a — they'll render as chips
      // inline with their parent assistant turn in W2b.
      const ui: ChatMessage[] = [];
      for (const m of action.messages) {
        if (m.role === 'user') {
          ui.push({
            id: m.id,
            role: 'user',
            content: m.content,
            timestamp: new Date(m.timestamp).getTime(),
          });
        } else if (m.role === 'assistant' && m.content.trim() !== '') {
          ui.push({
            id: m.id,
            role: 'assistant',
            content: m.content,
            timestamp: new Date(m.timestamp).getTime(),
          });
        }
        // tool_result / system messages skipped in W2a.
      }
      return { ...state, messages: ui };
    }

    case 'send-failed': {
      return {
        ...state,
        // Drop the optimistic user message so the user can edit + retry
        // without a phantom "their message that never landed" sitting in
        // history.
        messages: state.messages.filter((m) => m.id !== action.userMessageId),
        error: action.error,
        isStreaming: false,
      };
    }

    case 'clear-error': {
      return { ...state, error: null };
    }
  }
}
