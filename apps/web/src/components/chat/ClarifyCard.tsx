import type { ClarifyRequestEvent } from '@ethosagent/web-contracts';
import { Button, Input } from 'antd';
import { useEffect, useState } from 'react';
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

function formatCountdown(deadlineAt: string, now: number): string {
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
}

export function ClarifyCard({ request, variant = 'card' }: ClarifyCardProps) {
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
    request.default !== undefined
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
