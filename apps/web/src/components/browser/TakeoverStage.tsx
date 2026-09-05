import type { BrowserTakeoverClientFrame } from '@ethosagent/web-contracts';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

// The screencast takeover — a MODE on the Call Stage template (plan B3).
//
// The agent has stopped and handed its browser to a human. On a desktop that
// browser has a real window; on a headless VPS it does not, and this is the
// window: JPEG frames from CDP on the left where the Call Stage puts its shape,
// and a 320px "This takeover" column on the right holding the URL, the elapsed
// time, and the two ways out.
//
// The two ways out are DIFFERENT and must stay different:
//   Hand back  — resolves the clarify; the agent resumes. One primary, ≥44px.
//   Back to chat — collapses the mode; the takeover is STILL RUNNING and the
//                  card in the transcript still holds the hand-back.
// `Esc` is neither. It is a key the page under takeover may genuinely need (a
// dismissed dropdown, a modal on the login form), so it is FORWARDED like any
// other key and does nothing locally. A mode that ends a fifteen-minute pause
// on a stray keystroke is a mode that loses work.
//
// Like the Call Stage there is no rail and no PersonalityBar: while the stage
// is up it IS the surface, and the browser has the user's attention.
//
// Desktop-only in v1 — see `TAKEOVER_MIN_WIDTH` and `TakeoverUnavailableNote`.

/** Below this the stage is not offered at all. Driving a page by pointer needs a pointer. */
export const TAKEOVER_MIN_WIDTH = 760;

/** What the screencast lane is doing right now. */
export type TakeoverStageStatus = 'connecting' | 'live' | 'unavailable' | 'ended';

export interface TakeoverStageProps {
  /** The page under takeover. Follows the lane's `url` frames once live. */
  url: string;
  /** ms epoch the takeover began — the elapsed clock's origin. */
  startedAt: number;
  status: TakeoverStageStatus;
  /**
   * Why the canvas is not showing a page, when it is not. Rendered verbatim:
   * a session in another process is a permanent condition with a real reason,
   * and a blank rectangle explains none of it.
   */
  notice: string | null;
  /** Newest frame, as an object URL. Null until the first frame lands. */
  frameSrc: string | null;
  handingBack: boolean;
  /** Send one input frame up the lane. */
  onInput: (frame: BrowserTakeoverClientFrame) => void;
  /** Resolve the clarify — the agent resumes. */
  onHandBack: () => void;
  /** Collapse the mode. Does NOT hand back. */
  onBackToChat: () => void;
}

/** `2m 14s` — how long the user has held the browser. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

/** The state word beside the dot. Glyph AND word, never colour alone. */
export function statusLine(status: TakeoverStageStatus): { glyph: string; word: string } {
  switch (status) {
    case 'connecting':
      return { glyph: '·', word: 'connecting' };
    case 'live':
      return { glyph: '●', word: 'you are driving' };
    case 'unavailable':
      return { glyph: '⚠', word: 'no live view' };
    case 'ended':
      return { glyph: '✓', word: 'handed back' };
  }
}

/**
 * CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
 * Exported for the test that would otherwise have to restate it.
 */
export function modifierMask(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

/**
 * Pointer position as a FRACTION of the rendered image, which is what the wire
 * carries. The server scales it against the page dimensions CDP reported, so
 * the viewer never has to know — or guess — the real page size.
 */
export function fractionOf(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const x = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
  const y = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
  return { x: clamp01(x), y: clamp01(y) };
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function TakeoverStage({
  url,
  startedAt,
  status,
  notice,
  frameSrc,
  handingBack,
  onInput,
  onHandBack,
  onBackToChat,
}: TakeoverStageProps) {
  const viewRef = useRef<HTMLImageElement | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const live = status === 'live';
  const state = statusLine(status);

  const mouse = (
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved',
    event: ReactMouseEvent<HTMLImageElement>,
  ): void => {
    const node = viewRef.current;
    if (!node || !live) return;
    const { x, y } = fractionOf(node.getBoundingClientRect(), event.clientX, event.clientY);
    onInput({
      t: 'mouse',
      type,
      x,
      y,
      button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
      modifiers: modifierMask(event),
    });
  };

  const key = (type: 'keyDown' | 'keyUp', event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!live) return;
    // Every key goes to the page — INCLUDING Escape. Nothing here ends the
    // takeover; only the Hand back button does.
    event.preventDefault();
    onInput({
      t: 'key',
      type,
      key: event.key.slice(0, 32),
      code: event.code.slice(0, 32),
      modifiers: modifierMask(event),
      ...(type === 'keyDown' && event.key.length === 1 ? { text: event.key } : {}),
    });
  };

  return (
    <section className="takeover-stage" aria-label="Browser takeover">
      <div
        className="takeover-stage-main"
        // `application` tells assistive tech to stop intercepting keys, which
        // is exactly right here: they belong to the page under takeover. That
        // role is only useful on something focusable, so the tabIndex is the
        // point rather than an oversight — without it a keyboard user cannot
        // reach the surface at all, which for a login form is the feature.
        role="application"
        aria-label="The agent's browser — your clicks and keystrokes go to this page"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: see the note above
        tabIndex={0}
        onKeyDown={(event) => key('keyDown', event)}
        onKeyUp={(event) => key('keyUp', event)}
      >
        {frameSrc ? (
          // The keyboard path is the CONTAINER's, which is focusable;
          // duplicating it here would dispatch every key twice.
          <img
            ref={viewRef}
            className="takeover-stage-view"
            src={frameSrc}
            alt="Live view of the agent's browser"
            draggable={false}
            onMouseDown={(event) => mouse('mousePressed', event)}
            onMouseUp={(event) => mouse('mouseReleased', event)}
            onMouseMove={(event) => mouse('mouseMoved', event)}
          />
        ) : (
          <p className="takeover-stage-blank">
            <span className="takeover-stage-glyph" aria-hidden="true">
              {state.glyph}
            </span>{' '}
            {notice ?? 'Waiting for the first frame from the agent’s browser…'}
          </p>
        )}
      </div>

      <div className="takeover-stage-side">
        <div className="takeover-stage-head">
          <span className="talk-mono">This takeover</span>
          {/* The way out of the MODE that is not a hand-back. The takeover keeps
              running and the card in the transcript still holds the button. */}
          <button
            type="button"
            className="takeover-stage-back"
            onClick={onBackToChat}
            aria-label="Back to chat — the takeover keeps running"
          >
            Back to chat
          </button>
        </div>
        <div className="takeover-stage-detail">
          <span className="talk-mono takeover-stage-url">{url}</span>
          <span className="talk-mono takeover-stage-state" role="status">
            <span
              className={`takeover-stage-dot${live ? ' takeover-stage-dot-live' : ''}`}
              aria-hidden="true"
            />
            {state.glyph} {state.word}
          </span>
          <span className="talk-mono takeover-stage-elapsed">{formatElapsed(now - startedAt)}</span>
          {notice && frameSrc ? <span className="takeover-stage-notice">{notice}</span> : null}
        </div>
        <button
          type="button"
          className="takeover-stage-handback"
          onClick={onHandBack}
          disabled={handingBack || status === 'ended'}
        >
          {handingBack ? 'Handing back…' : 'Hand back'}
        </button>
      </div>
    </section>
  );
}

/**
 * The row that stands in for the stage when it cannot be offered.
 *
 * It sits beside the takeover card rather than replacing it: the card is what
 * holds the hand-back, and on a phone the hand-back is the whole of what a user
 * can usefully do. Driving a page needs a pointer and a viewport, so below
 * `TAKEOVER_MIN_WIDTH` the honest thing is to say where the driving happens.
 */
export function TakeoverUnavailableNote({ reason }: { reason: 'narrow' | 'refused' }) {
  return (
    <p className="takeover-note" role="note">
      <span className="takeover-note-glyph" aria-hidden="true">
        ⚠
      </span>{' '}
      {reason === 'narrow'
        ? 'Open on a desktop browser to take over'
        : 'No live view of this browser from here — hand back above'}
    </p>
  );
}
