import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { type AttachmentPreview, toMessageAttachment } from '../lib/attachments';
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
  /**
   * Called when history load fails with a "not found" error — the session id
   * in the URL or localStorage no longer exists on the server. Callers should
   * clear their stored id and reset routing so the user gets a fresh chat.
   */
  onSessionNotFound?: (sessionId: string) => void;
  /**
   * The current session's string key. When a `cron.fired` SSE event arrives
   * with a matching sessionKey, history is reloaded so the cron turn appears
   * in chat.
   */
  sessionKey?: string;
}

export interface UseChatResult {
  state: ChatState;
  /** Server-assigned session id once a turn has run. Null on a fresh chat
   *  before the user types anything. */
  currentSessionId: string | null;
  sendMessage: (
    text: string,
    attachments?: AttachmentPreview[],
    opts?: { origin?: 'text' | 'voice' },
  ) => Promise<void>;
  /** Steer the running turn. Returns true if accepted, false if the turn
   *  already ended or the RPC failed. */
  steerMessage: (text: string) => Promise<boolean>;
  /** Abort the running turn. Fire-and-forget — best effort. */
  abortTurn: () => Promise<void>;
  /**
   * Switch the in-flight session to a new id (e.g. after a fork). Wipes
   * local state synchronously so old messages don't linger while the
   * new session's history fetches.
   */
  switchSession: (sessionId: string) => void;
  /**
   * Drop the current session entirely — wipes reducer state and clears
   * `currentSessionId`. The next `sendMessage` will create a fresh
   * session on the server. Used by the "New session" affordance.
   */
  resetSession: () => void;
  /** Soft-delete the last N user+assistant turn pairs. Returns the
   *  number of pairs actually removed. */
  undoTurns: (n?: number) => Promise<number>;
  /** Force a server-side compaction (`/compact`). Returns pre/post token
   *  counts, or null when there's no session or the RPC failed. */
  compact: (instructions?: string) => Promise<{
    ok: boolean;
    engineName: string;
    droppedCount: number;
    preTotalTokens: number;
    postTotalTokens: number;
    summariesEnabled: boolean;
  } | null>;
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
    rpc.sessions
      .get({ id: currentSessionId })
      .then((res) => {
        if (cancelled) return;
        // Mark as loaded only after success so a Strict Mode
        // cancel+remount cycle retries rather than skipping.
        historyLoadedFor.current = currentSessionId;
        dispatch({
          kind: 'action',
          action: { type: 'history-loaded', messages: res.messages, cards: res.cards },
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        if (message.toLowerCase().includes('not found')) {
          // Stale session ID — reset silently so the user gets a fresh chat
          opts.onSessionNotFound?.(currentSessionId ?? '');
          historyLoadedFor.current = null;
          dispatch({ kind: 'action', action: { type: 'reset' } });
          setCurrentSessionId(null);
          return;
        }
        dispatch({
          kind: 'action',
          action: { type: 'send-failed', userMessageId: '', error: message },
        });
      });

    return () => {
      cancelled = true;
    };
  }, [currentSessionId, opts.onSessionNotFound]);

  // 2. Subscribe to SSE for the current session. The wrapper handles
  //    reconnect via Last-Event-ID; we just dispatch every event into
  //    the reducer.
  useEffect(() => {
    if (!currentSessionId) return;
    const sub = subscribeToSession(currentSessionId, {
      onEvent: (event) => {
        dispatch({ kind: 'event', event });
        // When a cron job that ran in this session fires, reload history so
        // the cron turn appears inline in the chat.
        if (
          event.type === 'cron.fired' &&
          (event as { sessionKey?: string }).sessionKey &&
          (event as { sessionKey?: string }).sessionKey === opts.sessionKey
        ) {
          historyLoadedFor.current = null;
        }
      },
      onError: () => {
        // Surface stays open — EventSource auto-reconnects. We don't set
        // an error here because connection blips during a long chat
        // shouldn't pollute the UI; only RPC failures and explicit
        // server `error` events do.
        return undefined;
      },
    });
    return () => sub.close();
  }, [currentSessionId, opts.sessionKey]);

  // 3. Send a user message. Optimistically appends the user bubble,
  //    fires chat.send, and lets SSE drive the assistant response.
  const onSessionCreated = opts.onSessionCreated;
  const personalityId = opts.personalityId;
  const sendMessage = useCallback(
    async (
      text: string,
      attachments?: AttachmentPreview[],
      opts?: { origin?: 'text' | 'voice' },
    ): Promise<void> => {
      const trimmed = text.trim();
      if (!trimmed && !attachments?.length) return;

      const userMessageId = `user-${Date.now()}`;
      dispatch({
        kind: 'action',
        action: {
          type: 'submit-user-message',
          id: userMessageId,
          text: trimmed,
          timestamp: Date.now(),
          ...(attachments?.length ? { attachments: attachments.map(toMessageAttachment) } : {}),
          // The bubble carries the same "this arrived as speech" fact the
          // server is told below — the transcript is shown BESIDE the marker,
          // never instead of it.
          ...(opts?.origin === 'voice' ? { origin: 'voice' as const } : {}),
        },
      });

      try {
        const response = await rpc.chat.send({
          ...(currentSessionId ? { sessionId: currentSessionId } : {}),
          clientId: getClientId(),
          text: trimmed,
          ...(personalityId ? { personalityId } : {}),
          // Talk-mode marks its turns so the server can annotate them as
          // spoken. Typed sends omit it entirely.
          ...(opts?.origin === 'voice' ? { origin: 'voice' as const } : {}),
          ...(attachments?.length
            ? {
                attachments: attachments.map((a) => ({
                  type: a.type,
                  data: a.data ?? '',
                  mimeType: a.mimeType,
                  name: a.name,
                })),
              }
            : {}),
        });
        if (!currentSessionId && response.sessionId !== currentSessionId) {
          // We just created this session locally — the user message lives in
          // optimistic state and the assistant response will arrive via SSE.
          // Mark history as "loaded" BEFORE setCurrentSessionId so the
          // load effect skips its fetch. Otherwise it would race the agent
          // loop (which persists the user message asynchronously after
          // chat.send returns) and overwrite state.messages with an empty
          // array — wiping the optimistic user bubble and leaving only the
          // assistant response.
          historyLoadedFor.current = response.sessionId;
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

  const steerMessage = useCallback(
    async (text: string): Promise<boolean> => {
      if (!currentSessionId) return false;
      try {
        const res = await rpc.chat.steer({ sessionId: currentSessionId, text });
        if (res.ok) {
          dispatch({
            kind: 'action',
            action: {
              type: 'steer-user-message',
              id: `steer-${Date.now()}`,
              text,
              timestamp: Date.now(),
            },
          });
        }
        return res.ok;
      } catch {
        return false;
      }
    },
    [currentSessionId],
  );

  const abortTurn = useCallback(async (): Promise<void> => {
    if (!currentSessionId) return;
    try {
      await rpc.chat.abort({ sessionId: currentSessionId });
    } catch {
      // best-effort
    }
  }, [currentSessionId]);

  const switchSession = useCallback((sessionId: string) => {
    dispatch({ kind: 'action', action: { type: 'reset' } });
    setCurrentSessionId(sessionId);
  }, []);

  const resetSession = useCallback(() => {
    dispatch({ kind: 'action', action: { type: 'reset' } });
    setCurrentSessionId(null);
    historyLoadedFor.current = null;
  }, []);

  const undoTurns = useCallback(
    async (n = 1): Promise<number> => {
      if (!currentSessionId) return 0;
      try {
        const res = await rpc.sessions.undoTurns({ id: currentSessionId, n });
        if (res.removed > 0) {
          dispatch({ kind: 'action', action: { type: 'undo-turns', count: res.removed } });
        }
        return res.removed;
      } catch {
        return 0;
      }
    },
    [currentSessionId],
  );

  // Phase 2 — manual `/compact`. Forces a server-side compaction (which persists
  // a watermark) and returns pre/post token counts so the caller can toast a
  // confirmation. No-op when there's no session yet.
  const compact = useCallback(
    async (
      instructions?: string,
    ): Promise<{
      ok: boolean;
      engineName: string;
      droppedCount: number;
      preTotalTokens: number;
      postTotalTokens: number;
      summariesEnabled: boolean;
    } | null> => {
      if (!currentSessionId) return null;
      try {
        return await rpc.sessions.compact({
          id: currentSessionId,
          ...(instructions ? { instructions } : {}),
        });
      } catch {
        return null;
      }
    },
    [currentSessionId],
  );

  return {
    state,
    currentSessionId,
    sendMessage,
    steerMessage,
    abortTurn,
    switchSession,
    resetSession,
    undoTurns,
    compact,
  };
}
