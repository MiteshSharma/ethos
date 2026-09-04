// localStorage-backed memory of "the last session the user was looking at".
// Survives refresh, tab close, browser restart — survives until cleared.
//
// Used by Chat.tsx:
//   • On mount with no `?session=<id>` in the URL, read from here. If
//     present, redirect to `?session=<id>` so deep-link state is restored.
//   • On every session-id change (fresh session created, fork, switch),
//     write here so the next refresh comes back to the same place.
//   • `New session` button clears this + the URL + reducer state.
//
// Per-origin (browser scopes localStorage by origin) — different ports /
// hosts get separate ids, which matches how the auth cookie is scoped.
//
// Mutations dispatch `ethos:active-session-changed` so in-tab consumers
// (right drawer, command palette) can react without polling. The
// browser's native `storage` event fires only cross-tab, so the custom
// event covers the same-tab case.

const STORAGE_KEY = 'ethos.lastSessionId';
const CHANGE_EVENT = 'ethos:active-session-changed';

/**
 * "The user stopped the turn on this session." Lives next to `CHANGE_EVENT`
 * because it is the same mechanism for the same reason: a decision taken in the
 * chat hook that a separately-subscribed in-tab consumer (the right drawer) has
 * to see. An abort is local — it is a `ChatAction`, never an SSE event — so
 * without this the drawer keeps drawing `running` rows for calls the chat
 * footer has already settled (feedback-activity-contract §4).
 */
export const TURN_ABORTED_EVENT = 'ethos:turn-aborted';

export function getLastSessionId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(STORAGE_KEY);
}

export function setLastSessionId(sessionId: string): void {
  if (typeof window === 'undefined') return;
  const prev = window.localStorage.getItem(STORAGE_KEY);
  if (prev === sessionId) return;
  window.localStorage.setItem(STORAGE_KEY, sessionId);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Tell in-tab consumers the turn on `sessionId` was stopped by the user. */
export function broadcastTurnAborted(sessionId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(TURN_ABORTED_EVENT, { detail: { sessionId } }));
}

/** The session a `TURN_ABORTED_EVENT` names, or null if it carries no id. */
export function turnAbortedSessionId(event: Event): string | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail: unknown = event.detail;
  if (typeof detail !== 'object' || detail === null || !('sessionId' in detail)) return null;
  const { sessionId } = detail;
  return typeof sessionId === 'string' ? sessionId : null;
}

export function clearLastSessionId(): void {
  if (typeof window === 'undefined') return;
  if (window.localStorage.getItem(STORAGE_KEY) === null) return;
  window.localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}
