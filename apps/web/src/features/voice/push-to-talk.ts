// Keyboard control for a live call: hold Space to talk, Esc to hang up.
//
// Pure by construction — it takes key-event shapes and returns whether it acted
// — so the whole interaction is testable in node, and the React layer is a
// three-line `addEventListener`. Auto-repeat is filtered here rather than in
// the hook because a held key fires keydown continuously, and re-opening the
// mic on every repeat is how a push-to-talk turns into a stutter.

/** The slice of `KeyboardEvent` this module reads. */
export interface PushToTalkKeyEvent {
  key: string;
  repeat?: boolean;
  target?: unknown;
  preventDefault?: () => void;
}

export interface PushToTalkHandlers {
  /** True when the key was consumed by push-to-talk. */
  keyDown(event: PushToTalkKeyEvent): boolean;
  keyUp(event: PushToTalkKeyEvent): boolean;
}

export interface PushToTalkOptions {
  /** Space pressed — open the mic. */
  onHold(): void;
  /** Space released — close it again. */
  onRelease(): void;
  /** Esc — end the call. */
  onEnd(): void;
}

/**
 * True when the event came from somewhere the user is typing. Space is a
 * character before it is a control, so the composer always wins.
 */
export function isTypingTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  if (el.isContentEditable === true) return true;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function createPushToTalkHandlers(opts: PushToTalkOptions): PushToTalkHandlers {
  let held = false;

  return {
    keyDown(event) {
      if (isTypingTarget(event.target)) return false;
      if (event.key === 'Escape') {
        event.preventDefault?.();
        opts.onEnd();
        return true;
      }
      if (event.key !== ' ' && event.key !== 'Spacebar') return false;
      event.preventDefault?.();
      if (event.repeat || held) return true;
      held = true;
      opts.onHold();
      return true;
    },

    keyUp(event) {
      if (event.key !== ' ' && event.key !== 'Spacebar') return false;
      // A release is honored even if focus moved into the composer mid-hold —
      // otherwise the mic stays open with nothing holding it.
      if (!held) return false;
      event.preventDefault?.();
      held = false;
      opts.onRelease();
      return true;
    },
  };
}
