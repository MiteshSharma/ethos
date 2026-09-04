import { useEffect, useState } from 'react';
import {
  applyEvent,
  applyTurnAborted,
  type DrawerNotification,
  type DrawerStreamState,
  type DrawerTurn,
  emptyDrawerState,
  type UsageState,
} from '../lib/drawer-reducer';
import { getLastSessionId, TURN_ABORTED_EVENT, turnAbortedSessionId } from '../lib/lastSession';
import { subscribeToSession } from '../sse';

// Right-drawer state machine. Subscribes to the user's "active" session
// (the one chat is currently looking at, or the last-touched one if chat
// is not on screen) and bins inbound SSE events into three lanes:
//
//   • turns + trail — tool_start / tool_end grouped into per-turn trails
//                     (run_start opens a turn, done/error closes it)
//   • notifications — push events that aren't tied to the turn (cron.fired,
//                     mesh.changed, evolve.skill_pending). Newest first.
//   • usage       — last-seen UsageEvent (input/output tokens + cost)
//
// Pure reducer logic lives in `lib/drawer-reducer` so it can be exercised
// without React. The hook is the IO layer: SSE subscription + active-
// session tracking + state.

export type { DrawerNotification, DrawerStreamState, DrawerTurn, UsageState };

function readActiveSessionId(): string | null {
  return getLastSessionId() ?? null;
}

export function useDrawerStream(): DrawerStreamState {
  const [state, setState] = useState<DrawerStreamState>(() =>
    emptyDrawerState(readActiveSessionId()),
  );

  // Re-resolve the active session when localStorage changes (handles
  // /new + cross-tab forks). `storage` only fires across tabs; same-tab
  // updates run through a custom event the chat path also dispatches.
  useEffect(() => {
    const refresh = () => {
      const next = readActiveSessionId();
      setState((prev) => (prev.sessionId === next ? prev : emptyDrawerState(next)));
    };
    window.addEventListener('storage', refresh);
    window.addEventListener('ethos:active-session-changed', refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('ethos:active-session-changed', refresh);
    };
  }, []);

  // Stop never reaches the wire, so it never reaches this subscription: the
  // chat hook broadcasts it, and the reducer settles the open turn's rows —
  // but only when the drawer is bound to the session the abort happened on.
  useEffect(() => {
    const onAborted = (event: Event) => {
      const sessionId = turnAbortedSessionId(event);
      if (!sessionId) return;
      setState((prev) => applyTurnAborted(prev, sessionId));
    };
    window.addEventListener(TURN_ABORTED_EVENT, onAborted);
    return () => window.removeEventListener(TURN_ABORTED_EVENT, onAborted);
  }, []);

  useEffect(() => {
    if (!state.sessionId) return;
    const sub = subscribeToSession(state.sessionId, {
      onEvent: (event) => {
        setState((prev) => applyEvent(prev, event));
      },
    });
    return () => sub.close();
  }, [state.sessionId]);

  return state;
}
