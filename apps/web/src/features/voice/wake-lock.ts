// Screen wake lock for the duration of a call.
//
// A hands-free conversation has no touch input, so a phone locks the screen
// mid-sentence and the browser suspends the AudioContext and the mic with it —
// the call appears to die on its own. `navigator.wakeLock` prevents that, and
// because the OS releases the lock whenever the page is hidden, it has to be
// re-acquired when the page becomes visible again.
//
// Both `navigator` and `document` are injected so this is testable in node, and
// every step degrades quietly: a browser without the API simply runs without a
// wake lock rather than failing the call.

export interface WakeLockSentinelLike {
  release(): Promise<void>;
}

export interface WakeLockNavigatorLike {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
}

export interface WakeLockDocumentLike {
  visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface WakeLock {
  acquire(): Promise<void>;
  release(): Promise<void>;
  readonly held: boolean;
}

export function createWakeLock(
  navigatorLike?: WakeLockNavigatorLike,
  documentLike?: WakeLockDocumentLike,
): WakeLock {
  const nav =
    navigatorLike ??
    (typeof navigator !== 'undefined' ? (navigator as WakeLockNavigatorLike) : undefined);
  const doc =
    documentLike ??
    (typeof document !== 'undefined' ? (document as unknown as WakeLockDocumentLike) : undefined);

  let sentinel: WakeLockSentinelLike | null = null;
  let wanted = false;
  let onVisibility: (() => void) | null = null;

  const request = async (): Promise<void> => {
    if (!wanted || sentinel || !nav?.wakeLock) return;
    try {
      sentinel = await nav.wakeLock.request('screen');
    } catch {
      // Denied (no user gesture, unsupported, battery saver). The call goes on.
      sentinel = null;
    }
  };

  return {
    async acquire(): Promise<void> {
      wanted = true;
      await request();
      if (doc && !onVisibility) {
        onVisibility = () => {
          if (doc.visibilityState === 'visible') {
            // The OS dropped the lock while we were hidden; take it back.
            sentinel = null;
            void request();
          }
        };
        doc.addEventListener('visibilitychange', onVisibility);
      }
    },

    async release(): Promise<void> {
      wanted = false;
      if (doc && onVisibility) {
        doc.removeEventListener('visibilitychange', onVisibility);
        onVisibility = null;
      }
      const held = sentinel;
      sentinel = null;
      await held?.release().catch(() => {});
    },

    get held(): boolean {
      return sentinel !== null;
    },
  };
}
