import { useEffect, useState } from 'react';
import {
  applyEvent,
  type DrawerNotification,
  type DrawerStreamState,
  emptyDrawerState,
  type ToolStreamEntry,
  type UsageState,
} from '../lib/drawer-reducer';
import { getLastSessionId } from '../lib/lastSession';
import { subscribeToSession } from '../sse';

// Right-drawer state machine. Subscribes to the user's "active" session
// (the one chat is currently looking at, or the last-touched one if chat
// is not on screen) and bins inbound SSE events into three lanes:
//
//   • toolStream  — tool_start / tool_end events for the live observability pane
//   • notifications — push events that aren't tied to the turn (cron.fired,
//                     mesh.changed, evolve.skill_pending). Newest first.
//   • usage       — last-seen UsageEvent (input/output tokens + cost)
//
// Pure reducer logic lives in `lib/drawer-reducer` so it can be exercised
// without React. The hook is the IO layer: SSE subscription + active-
// session tracking + state.

export type { DrawerNotification, DrawerStreamState, ToolStreamEntry, UsageState };

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
