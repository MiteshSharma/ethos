// "Show advanced", persisted (plan/phases/settings-navigation.md D6).
//
// It used to be `useState(false)` in the page, which meant every visit reset it
// — an operator who works in the advanced rows turned the toggle on again on
// every navigation, and that is the bug this file closes.
//
// localStorage, NOT the URL. The URL addresses WHAT you are looking at; the
// toggle is HOW you look at it. Two people sharing `/settings/voice/trunk`
// should land on the same section and each keep their own reading of it.
//
// Storage shape, custom event and the two-listener hook follow
// `apps/web/src/lib/favouritePersonality.ts` verbatim: `storage` fires only in
// OTHER tabs and windows, the custom event only in this one, so both are needed
// to make one preference shared across every Settings surface a build has open.

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'ethos:settingsShowAdvanced';

export const ADVANCED_CHANGE_EVENT = 'ethos:settings-advanced-changed';

/**
 * Anything other than the literal `'1'` reads as off. localStorage is user- and
 * extension-writable, so an unrecognised value is somebody else's data, and
 * "advanced off" is the safe reading of data we do not own.
 */
export function parseShowAdvanced(raw: string | null): boolean {
  return raw === '1';
}

export function getShowAdvanced(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return parseShowAdvanced(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage can be disabled outright (Safari private mode, blocked cookies).
    // Advanced-off is a fine answer; a throw on page load is not.
    return false;
  }
}

export function setShowAdvanced(show: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (show) window.localStorage.setItem(STORAGE_KEY, '1');
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Listeners re-read storage, so they keep showing what actually persisted
    // rather than a preference that did not.
  }
  window.dispatchEvent(new CustomEvent(ADVANCED_CHANGE_EVENT));
}

export function useShowAdvanced(): {
  showAdvanced: boolean;
  setShowAdvanced: (v: boolean) => void;
} {
  const [showAdvanced, setState] = useState<boolean>(() => getShowAdvanced());

  useEffect(() => {
    const refresh = () => setState(getShowAdvanced());
    window.addEventListener('storage', refresh);
    window.addEventListener(ADVANCED_CHANGE_EVENT, refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener(ADVANCED_CHANGE_EVENT, refresh);
    };
  }, []);

  const set = useCallback((next: boolean) => {
    setShowAdvanced(next);
  }, []);

  return { showAdvanced, setShowAdvanced: set };
}
