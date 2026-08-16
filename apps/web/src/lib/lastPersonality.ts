// localStorage-backed memory of "the personality workspace the user was last
// inside" — the fallback source `/` and `/chat` consult (after `?session=`,
// before the config default) when there's nothing in the URL to resolve a
// personality from. Written whenever the app is on a `/p/:personalityId/…`
// route (see App.tsx).
//
// Per-origin, mirrors `lastSession.ts`'s storage-key convention. No change
// event — nothing needs to react to this in-tab today, unlike
// `lastSession.ts`'s cross-component listeners.

const STORAGE_KEY = 'ethos.lastPersonalityId';

export function getLastPersonalityId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(STORAGE_KEY);
}

export function setLastPersonalityId(personalityId: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, personalityId);
}
