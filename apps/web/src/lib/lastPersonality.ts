// localStorage-backed memory of "the personality workspace the user was last
// inside" — the fallback source `/` and `/chat` consult (after `?session=`,
// before the config default) when there's nothing in the URL to resolve a
// personality from. Written whenever the app is on a `/p/:personalityId/…`
// route (see App.tsx).
//
// Per-origin, mirrors `lastSession.ts`'s storage-key convention. No change
// event — nothing needs to react to this in-tab today, unlike
// `lastSession.ts`'s cross-component listeners.
//
// T1 of plan/phases/teams-as-a-scope.md adds the last TEAM alongside it —
// the scope the user was last standing in, written on every `/t/:teamId/…`
// route and cleared when they return to Independent.

const STORAGE_KEY = 'ethos.lastPersonalityId';
const TEAM_STORAGE_KEY = 'ethos.lastTeamId';

export function getLastPersonalityId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(STORAGE_KEY);
}

export function setLastPersonalityId(personalityId: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, personalityId);
}

// The three team helpers swallow storage errors (Safari private mode,
// blocked cookies) the way `favouritePersonality.ts` does: "no last team" is
// a fine answer on page load; a thrown error is not.

export function getLastTeamId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(TEAM_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setLastTeamId(teamId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TEAM_STORAGE_KEY, teamId);
  } catch {
    // Storage refused the write; the next read simply finds no last team.
  }
}

export function clearLastTeamId(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(TEAM_STORAGE_KEY);
  } catch {
    // Same as above — nothing to do if storage is unavailable.
  }
}
