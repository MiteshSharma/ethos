import { useEffect, useRef, useState } from 'react';
import type { TurnPhase } from '../../lib/chat-reducer';
import { formatDuration } from '../../lib/trail';

// The status line — feedback & activity contract §2, DESIGN.md "Feedback &
// activity". It sits directly above the composer, inside the 800px column, in
// a slot that is reserved from the moment a message is sent, so the phases
// change without anything moving.
//
// It replaces `TurnStatusBar` from `@ethosagent/ui-components`, which was 12px
// `system-ui` with a 2 s ease-out — three DESIGN.md violations. Here: Geist
// Mono 13px `--text-secondary`, elapsed in `--text-tertiary` tabular, and the
// only transition is opacity at `--motion-default`.
//
// It also absorbs the old separate "Still working…" notice: two stall
// indicators on one screen is one too many.

/** One announcement per 2 s, however fast the tools churn (contract §2). */
export const ANNOUNCE_THROTTLE_MS = 2_000;

export interface StatusLineProps {
  /** Null when no turn is in flight — the line (and its slot) is not drawn. */
  phase: TurnPhase | null;
  /** The tool line (`{tool} · {argsPreview}`) or a user-audience progress
   *  message. Null falls back to the phase's own word. */
  label: string | null;
  elapsedMs: number;
  /** No event for 20 s. Appends `⚠ still working` — glyph AND word. */
  stalled: boolean;
}

/** The words are the feedback — no spinner vocabulary, no percentages. */
function phaseWord(phase: TurnPhase): string {
  if (phase === 'received') return 'received';
  if (phase === 'thinking') return 'thinking';
  if (phase === 'writing') return 'writing';
  return 'working';
}

export function StatusLine({ phase, label, elapsedMs, stalled }: StatusLineProps) {
  // A running tool is the only pulsing state; `received` and `thinking` are
  // steady.
  const text =
    phase === null ? '' : phase === 'tool' ? (label ?? phaseWord(phase)) : phaseWord(phase);
  // A new turn is never made to wait behind the previous turn's throttle
  // window: `received` IS the acknowledgement the contract promises within the
  // first second. `phase === null` is the turn ending, which re-arms the
  // throttle (and announces nothing — the region is not rendered).
  const announced = useThrottledAnnouncement(text, phase === null || phase === 'received');

  if (phase === null) return null;

  return (
    <div className="status-line activity-slot">
      <span
        className={`sb-dot status-line-dot${phase === 'tool' ? ' sb-dot--pulse' : ''}`}
        aria-hidden="true"
      />
      <span className="status-line-label" aria-hidden="true">
        {text}
      </span>
      {stalled ? (
        <span className="status-line-stall" aria-hidden="true">
          ⚠ still working
        </span>
      ) : null}
      <span className="status-line-elapsed" aria-hidden="true">
        {elapsedMs > 0 ? formatDuration(elapsedMs) : ''}
      </span>
      {/* The live region itself. Kept separate from the visible text so the
          throttle governs ANNOUNCEMENTS only — the eye still sees each phase
          the moment it changes. */}
      <span className="activity-sr" role="status" aria-live="polite">
        {announced}
      </span>
    </div>
  );
}

/**
 * Emit `text` at most once per `ANNOUNCE_THROTTLE_MS`. A change inside the
 * window is not dropped — it lands when the window closes, so the last state
 * is always the announced one.
 *
 * `immediate` bypasses the window for the first announcement of a turn, and
 * re-arms it when the turn ends, so the throttle is per-turn rather than
 * per-session.
 */
function useThrottledAnnouncement(text: string, immediate: boolean): string {
  const [announced, setAnnounced] = useState(text);
  const lastAtRef = useRef(0);

  useEffect(() => {
    if (immediate) {
      // An empty text is the turn ending — nothing to announce, and the next
      // turn's first phase must not be charged for this one.
      lastAtRef.current = text === '' ? 0 : Date.now();
      setAnnounced(text);
      return;
    }
    const since = Date.now() - lastAtRef.current;
    if (since >= ANNOUNCE_THROTTLE_MS) {
      lastAtRef.current = Date.now();
      setAnnounced(text);
      return;
    }
    const id = setTimeout(() => {
      lastAtRef.current = Date.now();
      setAnnounced(text);
    }, ANNOUNCE_THROTTLE_MS - since);
    return () => clearTimeout(id);
  }, [text, immediate]);

  return announced;
}
