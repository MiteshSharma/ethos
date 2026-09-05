import type { ClarifyRequestEvent } from '@ethosagent/web-contracts';
import { Button, Input } from 'antd';
import { useEffect, useState } from 'react';
import type { ResolvedClarify } from '../../lib/clarify-queue';
import { rpc } from '../../rpc';

// Clarify card — the agent asked the user a structured question mid-turn (the
// `clarify` tool). Mirrors the ApprovalModal lifecycle: render the pending
// request, fire the matching RPC, and let the SSE `clarify.resolved` event
// drop it from `pendingClarifies` so the card collapses naturally. We don't
// manage open/closed state locally.
//
// `variant` is presentation ONLY. During a call the Call Stage renders this same
// component in its reserved transcript slot (`slot`), where it is a filled panel
// rather than a card that appeared: no `alertdialog` role, no `aria-modal`, and
// no header icon competing with the slot's own label. Everything that resolves
// the request — the `clarify.respond` call, the countdown, the cancel — is
// shared, because a second answering path would be a second teardown.

// `deadlineAt` is `null` while a clarify is still queued behind another one
// in the same lane (D2) — no timer has started yet.
function formatCountdown(deadlineAt: string | null, now: number): string | null {
  if (deadlineAt === null) return null;
  const ms = new Date(deadlineAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

export interface ClarifyCardProps {
  request: ClarifyRequestEvent;
  /** `card` (default) floats over Chat; `slot` fills the Call Stage's reserved panel. */
  variant?: 'card' | 'slot';
  /**
   * D3 — the settled row for a `browser_takeover`, once it has one. The
   * takeover panel does NOT unmount when the request resolves: it flips to a
   * one-line resolved state and stays, because the transcript is where a
   * fifteen-minute pause has to remain legible afterwards (the Call Stage
   * lesson — see `plan/phases/feedback-activity-contract.md`). Absent means
   * still waiting. Ignored by the `question` kind, which keeps today's
   * unmount-on-resolve behaviour.
   */
  resolution?: ResolvedClarify | null;
  /**
   * Fired with the answer this tab submitted, before the round trip.
   * `clarify.resolved` carries only a source, so a run card that wants to show
   * WHAT was decided (pi-delegation §4.5) has to be told here or not at all.
   */
  onAnswered?: (answer: string) => void;
}

export function ClarifyCard({
  request,
  variant = 'card',
  onAnswered,
  resolution = null,
}: ClarifyCardProps) {
  // D3 — absent `kind` is a question: every event emitted before the field
  // existed, and every ordinary clarify since.
  if ((request.kind ?? 'question') === 'browser_takeover') {
    return <TakeoverPanel request={request} resolution={resolution} />;
  }
  return <QuestionCard request={request} variant={variant} onAnswered={onAnswered} />;
}

function QuestionCard({ request, variant = 'card', onAnswered }: ClarifyCardProps) {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Live countdown — refresh once a second.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const respond = async (answer: string, source: 'user' | 'cancel') => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (source === 'user') onAnswered?.(answer);
      await rpc.clarify.respond({ requestId: request.requestId, answer, source });
      // The SSE `clarify.resolved` event drops this request from
      // `pendingClarifies`, unmounting the card. No local close state.
    } catch (err) {
      setSubmitting(false);
      setSubmitError(err instanceof Error ? err.message : String(err));
    }
  };

  const hasOptions = request.options !== undefined && request.options.length > 0;
  const countdown = formatCountdown(request.defaultDeadlineAt, now);
  const deadlineHint =
    countdown === null
      ? 'Queued — waiting to be shown'
      : request.default !== undefined
        ? `Default \`${request.default}\` in ${countdown}`
        : `Times out in ${countdown}`;

  const isSlot = variant === 'slot';

  const body = (
    <>
      <header className="clarify-card-header">
        {isSlot ? (
          <span className="talk-mono clarify-card-slot-key">Asked aloud</span>
        ) : (
          <span className="clarify-card-icon" aria-hidden="true">
            ?
          </span>
        )}
        <h2 id="clarify-card-title" className="clarify-card-title">
          {request.question}
        </h2>
      </header>

      {hasOptions ? (
        <div className="clarify-card-options">
          {request.options?.map((opt) => (
            <Button key={opt} disabled={submitting} onClick={() => void respond(opt, 'user')}>
              {opt}
            </Button>
          ))}
        </div>
      ) : (
        <form
          className="clarify-card-freeform"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void respond(text.trim(), 'user');
          }}
        >
          <Input
            value={text}
            disabled={submitting}
            placeholder="Type your answer…"
            onChange={(e) => setText(e.target.value)}
          />
          <Button type="primary" htmlType="submit" loading={submitting} disabled={!text.trim()}>
            Send
          </Button>
        </form>
      )}

      {submitError ? (
        <div className="clarify-card-error" role="alert">
          {submitError}
        </div>
      ) : null}

      <footer className="clarify-card-footer">
        <span className="clarify-card-deadline">{deadlineHint}</span>
        <Button size="small" disabled={submitting} onClick={() => void respond('', 'cancel')}>
          Cancel
        </Button>
      </footer>
    </>
  );

  // In the slot the question is already on screen and always was: a labelled
  // region, not an `alertdialog`, because nothing was interrupted by its
  // arrival — that is the entire point of a reserved slot.
  return isSlot ? (
    <section className="clarify-card clarify-card-slot" aria-labelledby="clarify-card-title">
      {body}
    </section>
  ) : (
    <div
      className="clarify-card"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="clarify-card-title"
    >
      {body}
    </div>
  );
}

// ---------------------------------------------------------------------------
// D3 — the `browser_takeover` panel.
//
// Not a question: the agent has stopped and the user is driving the agent's own
// browser. So there is no answer box, one primary action ("Hand back"), and the
// panel STAYS after it settles — it flips its body to a one-line resolved row
// rather than unmounting. A pause this long that vanishes on resolution leaves
// the transcript unable to explain the gap (the Call Stage lesson,
// plan/phases/feedback-activity-contract.md).
//
// Every state is a glyph AND a word, never a colour alone.
// ---------------------------------------------------------------------------

/** The host of the page under takeover, for the resolved row. */
function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).host;
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

/** `2m 14s` — how long the user held the browser. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

/** `15m` — the window nobody took over in. */
function formatWindow(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

export function TakeoverPanel({
  request,
  resolution,
}: {
  request: ClarifyRequestEvent;
  resolution: ResolvedClarify | null;
}) {
  const [handingBack, setHandingBack] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // The wire event carries the deadline but not the start: this panel mounts on
  // the `clarify.request` push, which IS the moment the takeover began, so its
  // own mount time is the honest origin for both the elapsed and the window.
  const [startedAt] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const url = request.meta?.url;
  const host = hostOf(url);

  const handBack = async () => {
    setHandingBack(true);
    setSubmitError(null);
    try {
      await rpc.clarify.respond({
        requestId: request.requestId,
        answer: 'handed back',
        source: 'user',
      });
    } catch (err) {
      setHandingBack(false);
      setSubmitError(err instanceof Error ? err.message : String(err));
    }
  };

  const body = resolution ? (
    <p className="clarify-takeover-resolved talk-mono">
      <span className="clarify-takeover-glyph" aria-hidden="true">
        {resolution.source === 'user' ? '✓' : '✗'}
      </span>{' '}
      {resolvedLine(resolution, host, startedAt, request.defaultDeadlineAt)}
    </p>
  ) : (
    <>
      <p className="clarify-takeover-headline">Agent paused — you're in control of the browser</p>
      <p className="clarify-takeover-url talk-mono">{url ?? "the agent's browser"}</p>
      <p className="clarify-takeover-sub">Nothing happens until you hand back</p>
      <p className="clarify-takeover-countdown talk-mono">
        {formatCountdown(request.defaultDeadlineAt, now) ?? '—'}
      </p>
      <Button
        type="primary"
        className="clarify-takeover-handback"
        loading={handingBack}
        onClick={() => void handBack()}
      >
        Hand back
      </Button>
      {submitError ? (
        <div className="clarify-card-error" role="alert">
          {submitError}
        </div>
      ) : null}
    </>
  );

  // The region names itself: the heading is replaced by the resolved row, so
  // `aria-labelledby` would point at an element that stops existing.
  return (
    <section
      className="clarify-card clarify-card-takeover"
      aria-label="Browser takeover"
      aria-live="polite"
    >
      {body}
    </section>
  );
}

/** The resolved row's words. The glyph is decorative; this carries the meaning. */
function resolvedLine(
  resolution: ResolvedClarify,
  host: string | null,
  startedAt: number,
  deadlineAt: string | null,
): string {
  const where = host ?? 'the browser';
  switch (resolution.source) {
    case 'user':
      return `handed back · ${where} · ${formatElapsed(resolution.resolvedAt - startedAt)}`;
    case 'timeout-default':
    case 'timeout-no-default': {
      const window =
        deadlineAt === null
          ? formatElapsed(resolution.resolvedAt - startedAt)
          : formatWindow(new Date(deadlineAt).getTime() - startedAt);
      return `no one took over in ${window} — the agent reported the blockage`;
    }
    case 'cancel':
      return `takeover cancelled · ${where}`;
  }
}
