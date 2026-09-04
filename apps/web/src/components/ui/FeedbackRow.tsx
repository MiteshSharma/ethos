import type { RowStatus } from '../../lib/trail';
import { RowState } from '../chat/Trail';

// Feedback rows outside chat — feedback & activity contract §6, DESIGN.md
// "Feedback & activity". Any action a page takes (a backup, a probe, an
// install stage, an observe heartbeat) is a row: glyph + word, mono subject,
// mono timestamp or duration, result text.
//
// It is deliberately the SAME row as the trail's — same `.activity-row` class
// base, same `RowState` glyph/word mapping — so a user who has read one has
// read them all. Forking a second visual language for "settings feedback"
// would be the slop this contract exists to prevent.
//
// Persistent, never a toast: an outcome resolves the row IN PLACE (the caller
// re-renders it with a terminal `status` and a `result`), it does not remove
// it. Nothing vanishes (§7).

export interface FeedbackRowProps {
  status: RowStatus;
  /** What the action is about — a host, a file, a stage name. Mono. */
  subject: string;
  /** Timestamp or duration, right-aligned tabular. Mono. */
  meta?: string;
  /** The outcome sentence, once there is one. */
  result?: string;
}

export function FeedbackRow({ status, subject, meta, result }: FeedbackRowProps) {
  return (
    <div className={`activity-row activity-row-${status}`}>
      <RowState status={status} />
      <span className="activity-row-subject">{subject}</span>
      {result ? <span className="activity-row-result">{result}</span> : null}
      {meta ? <span className="activity-row-meta">{meta}</span> : null}
    </div>
  );
}
