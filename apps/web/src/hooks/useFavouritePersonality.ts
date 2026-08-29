import { useCallback, useEffect, useState } from 'react';
import {
  FAVOURITE_CHANGE_EVENT,
  getFavouritePersonalityId,
  nextFavouriteId,
  setFavouritePersonalityId,
} from '../lib/favouritePersonality';

// React binding for the favourite personality. Both the Documents and the
// Memory picker mount this, so favouriting on one page and navigating to the
// other shows the same star without a reload.
//
// Two listeners, because they cover different cases: `storage` fires only in
// OTHER tabs (and other desktop windows), the custom event only in THIS one.

export function useFavouritePersonality(): {
  favouriteId: string | null;
  toggleFavourite: (id: string) => void;
} {
  const [favouriteId, setFavouriteId] = useState<string | null>(() => getFavouritePersonalityId());

  useEffect(() => {
    const refresh = () => setFavouriteId(getFavouritePersonalityId());
    window.addEventListener('storage', refresh);
    window.addEventListener(FAVOURITE_CHANGE_EVENT, refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener(FAVOURITE_CHANGE_EVENT, refresh);
    };
  }, []);

  // Re-reads storage rather than closing over `favouriteId` so a click always
  // toggles against what is actually stored, even if another tab just changed it.
  const toggleFavourite = useCallback((id: string) => {
    setFavouritePersonalityId(nextFavouriteId(getFavouritePersonalityId(), id));
  }, []);

  return { favouriteId, toggleFavourite };
}
