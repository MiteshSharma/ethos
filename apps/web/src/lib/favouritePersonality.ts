// localStorage-backed memory of "the one personality I want pre-selected".
//
// Used by the Documents and Memory pages, which each own their personality
// selection as component-local `useState`. Without this, both pages always
// open on the server's default; with it, they open on the user's pick.
//
// ONE favourite, shared by both pages — not one per page. A favourite that
// means a different personality on two tabs is a worse model than a single
// preference the user sets once.
//
// Per-origin (the browser scopes localStorage by origin), which also covers
// desktop: it loads this same SPA.
//
// Mutations dispatch `ethos:favourite-personality-changed` so the other page
// picks the change up on navigation without a reload. The browser's native
// `storage` event only fires in OTHER tabs, so the custom event covers the
// same-tab case — same split as `lastSession.ts`.

import { z } from 'zod';

const STORAGE_KEY = 'ethos:favouritePersonalityId';

export const FAVOURITE_CHANGE_EVENT = 'ethos:favourite-personality-changed';

// Personality ids are `[A-Za-z0-9_-]+` everywhere else in the system (see
// `PersonalityIdRegex` in the web-contracts router). localStorage is user- and
// extension-writable, so anything else stored under our key is somebody else's
// data or a corrupted write — it degrades to "no favourite" rather than being
// trusted into an RPC argument or a download URL.
const FavouriteIdSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/);

/** Validate a raw stored value. Anything unparseable → no favourite. */
export function parseFavouritePersonalityId(raw: string | null): string | null {
  const parsed = FavouriteIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function getFavouritePersonalityId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return parseFavouritePersonalityId(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage can be disabled outright (Safari private mode, blocked cookies).
    // No favourite is a fine answer; a thrown error on page load is not.
    return null;
  }
}

/** Write (or, for `null`, clear) the favourite and notify in-tab listeners. */
export function setFavouritePersonalityId(id: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (id === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Storage refused the write. Listeners re-read from storage, so they keep
    // showing what actually persisted rather than a preference that didn't.
  }
  window.dispatchEvent(new CustomEvent(FAVOURITE_CHANGE_EVENT));
}

/**
 * Toggle semantics for clicking the star on `clicked`. The favourite is a
 * single value, not a set: a new pick replaces the old one, and clicking the
 * one that is already favourited clears it.
 */
export function nextFavouriteId(current: string | null, clicked: string): string | null {
  return current === clicked ? null : clicked;
}

/**
 * Which personality a picker should show: explicit session choice → favourite
 * → server default → nothing.
 *
 * `available` is the loaded personality list. A favourite that isn't in it is
 * ignored for this render — the personality may have been deleted, or the list
 * may simply not have arrived yet. It is never cleared here: silently dropping
 * the user's preference because one render happened to race the list query
 * would be worse than falling back for that render.
 */
export function resolvePersonalityId(input: {
  selectedId: string | null;
  favouriteId: string | null;
  defaultId: string | null;
  available: readonly string[];
}): string | null {
  const { selectedId, favouriteId, defaultId, available } = input;
  if (selectedId) return selectedId;
  if (favouriteId && available.includes(favouriteId)) return favouriteId;
  return defaultId;
}
