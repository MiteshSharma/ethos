import { useEffect, useState } from 'react';
import { applyClarifyEvent, type ClarifyQueueState, emptyClarifyQueue } from '../lib/clarify-queue';
import { getLastSessionId } from '../lib/lastSession';
import { applyRunEvent, emptyRunsState, type RunsState } from '../lib/pi-run-reducer';
import { subscribeToSession } from '../sse';

// Delegated-run state for the SHELL — the drawer Runs pane, the status-bar pill
// and the Tasks nav badge (pi-delegation §4.3/§4.4/D25).
//
// The chat page keeps its own copy inside `ChatState`, because it is already
// subscribed to the session for the turn itself and a second subscription there
// would be waste. The shell is not: it outlives any one page, and the pill is
// machine-wide by design ("a toast that vanishes while you are in another tab
// is the same as no notification at all"). So it subscribes once, in App, and
// the three consumers read from that.
//
// The reducers are the same pure functions the chat page uses. This hook is
// only the IO half: SSE subscription + active-session tracking.

export interface RunStreamState {
  sessionId: string | null;
  runs: RunsState;
  clarifyQueue: ClarifyQueueState;
}

function emptyState(sessionId: string | null): RunStreamState {
  return { sessionId, runs: emptyRunsState, clarifyQueue: emptyClarifyQueue };
}

export function useRunStream(): RunStreamState {
  const [state, setState] = useState<RunStreamState>(() => emptyState(getLastSessionId() ?? null));

  // §4.3 — "runs stay listed until terminal, then drop on the next session
  // change". The session change is this: a fresh session starts from nothing.
  useEffect(() => {
    const refresh = () => {
      const next = getLastSessionId() ?? null;
      setState((prev) => (prev.sessionId === next ? prev : emptyState(next)));
    };
    window.addEventListener('storage', refresh);
    window.addEventListener('ethos:active-session-changed', refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('ethos:active-session-changed', refresh);
    };
  }, []);

  useEffect(() => {
    const sessionId = state.sessionId;
    if (!sessionId) return;
    const sub = subscribeToSession(sessionId, {
      onEvent: (event) => {
        setState((prev) => {
          const now = Date.now();
          const runs = applyRunEvent(prev.runs, event, now);
          const clarifyQueue = applyClarifyEvent(prev.clarifyQueue, event, now);
          if (runs === prev.runs && clarifyQueue === prev.clarifyQueue) return prev;
          return { ...prev, runs, clarifyQueue };
        });
      },
    });
    return () => sub.close();
  }, [state.sessionId]);

  return state;
}
