import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  applyAction,
  applyEvent,
  type ChatAction,
  type ChatState,
  initialChatState,
} from '../lib/chat-reducer';
import { getClientId } from '../lib/clientId';
import { rpc } from '../rpc';
import { subscribeToSession } from '../sse';

// Top-level chat hook. Glues four moving pieces:
//   1. The chat reducer (lib/chat-reducer.ts) — pure state machine.
//   2. The SSE subscription (lib/sse.ts) — drives reducer with live events.
//   3. The oRPC mutations (chat.send) — kicks off new turns.
//   4. The history fetch (sessions.get) — populates state on mount when an
//      existing session is opened.
//
// `sessionId` is both an input AND output: callers can pass `undefined`
// to start a fresh session, and the hook surfaces the server-assigned id
// as `currentSessionId` once the first `chat.send` completes. Page-level
// routing then mirrors that to the URL.

export interface UseChatOptions {
  /** Existing session id to load. Pass undefined to start fresh. */
  initialSessionId?: string;
  /** Active personality id. Threaded into chat.send for tool/skill routing. */
  personalityId: string;
  /**
   * Called once when the server creates a session for a fresh chat.
   * Page-level code uses this to update the URL with the new id so a
   * refresh stays on the same conversation.
   */
  onSessionCreated?: (sessionId: string) => void;
}

export interface UseChatResult {
  state: ChatState;
  /** Server-assigned session id once a turn has run. Null on a fresh chat
   *  before the user types anything. */
  currentSessionId: string | null;
  sendMessage: (text: string) => Promise<void>;
}

type Reducer = (state: ChatState, op: ReducerOp) => ChatState;
type ReducerOp =
  | { kind: 'event'; event: Parameters<typeof applyEvent>[1] }
  | { kind: 'action'; action: ChatAction };

const reducer: Reducer = (state, op) => {
  if (op.kind === 'event') return applyEvent(state, op.event, Date.now());
  return applyAction(state, op.action);
};

export function useChat(opts: UseChatOptions): UseChatResult {
  const [state, dispatch] = useReducer(reducer, initialChatState);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(
    opts.initialSessionId ?? null,
  );

  // Track whether we've fetched history for this session so we don't
  // refetch on every render. A `useQuery` would also work but the data
  // is single-shot per session and feeds the reducer, which already owns
  // the canonical message list — useState is the right tool here.
  const historyLoadedFor = useRef<string | null>(null);

  // 1. Load history when a session is in scope and we haven't fetched yet.
  useEffect(() => {
    if (!currentSessionId) return;
    if (historyLoadedFor.current === currentSessionId) return;

    let cancelled = false;
    historyLoadedFor.current = currentSessionId;
    rpc.sessions
      .get({ id: currentSessionId })
      .then((res) => {
        if (cancelled) return;
        dispatch({ kind: 'action', action: { type: 'history-loaded', messages: res.messages } });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        dispatch({
          kind: 'action',
          action: { type: 'send-failed', userMessageId: '', error: message },
        });
      });

    return () => {
      cancelled = true;
    };
  }, [currentSessionId]);

  // 2. Subscribe to SSE for the current session. The wrapper handles
  //    reconnect via Last-Event-ID; we just dispatch every event into
  //    the reducer.
  useEffect(() => {
    if (!currentSessionId) return;
    const sub = subscribeToSession(currentSessionId, {
      onEvent: (event) => {
        dispatch({ kind: 'event', event });
      },
      onError: () => {
        // Surface stays open — EventSource auto-reconnects. We don't set
        // an error here because connection blips during a long chat
        // shouldn't pollute the UI; only RPC failures and explicit
        // server `error` events do.
      },
    });
    return () => sub.close();
  }, [currentSessionId]);

  // 3. Send a user message. Optimistically appends the user bubble,
  //    fires chat.send, and lets SSE drive the assistant response.
  const onSessionCreated = opts.onSessionCreated;
  const personalityId = opts.personalityId;
  const sendMessage = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (!trimmed) return;

      const userMessageId = `user-${Date.now()}`;
      dispatch({
        kind: 'action',
        action: {
          type: 'submit-user-message',
          id: userMessageId,
          text: trimmed,
          timestamp: Date.now(),
        },
      });

      try {
        const response = await rpc.chat.send({
          ...(currentSessionId ? { sessionId: currentSessionId } : {}),
          clientId: getClientId(),
          text: trimmed,
          ...(personalityId ? { personalityId } : {}),
        });
        if (!currentSessionId && response.sessionId !== currentSessionId) {
          setCurrentSessionId(response.sessionId);
          onSessionCreated?.(response.sessionId);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        dispatch({
          kind: 'action',
          action: { type: 'send-failed', userMessageId, error: message },
        });
      }
    },
    [currentSessionId, personalityId, onSessionCreated],
  );

  return { state, currentSessionId, sendMessage };
}
