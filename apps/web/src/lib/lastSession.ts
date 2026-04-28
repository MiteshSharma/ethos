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

export function clearLastSessionId(): void {
  if (typeof window === 'undefined') return;
  if (window.localStorage.getItem(STORAGE_KEY) === null) return;
  window.localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}
