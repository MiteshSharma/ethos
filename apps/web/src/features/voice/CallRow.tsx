import { Button, Typography } from 'antd';
import { PersonalityMark } from '../../components/ui/PersonalityMark';
import { accentVars, personalityAccent } from '../../lib/theme';
import type { CallRowView, CallSummary } from './call-rows';

// CallRow (voice V4, DR3) — one phone call, and the truth about it.
//
// A ROW, not a Card, for the same reason WakeRouteRow and SatelliteRow are: a
// call history is a list you SCAN, looking for the one call that was refused or
// the one that is still up. A bordered box per call turns scanning into
// reading, and "cards earn existence" reserves that primitive for skill rows,
// cron rows and task tiles.
//
// Everything mono here — the number, the duration, the state word, the tier,
// the cost — is a literal the operator also sees in `config.yaml`, in the
// trunk provider's own console, or on an invoice. Same string, same typeface,
// tabular so a column of durations lines up.

export interface CallRowProps {
  call: CallSummary;
  view: CallRowView;
  /** Opens the full transcript. Only offered when `view.showTranscript`. */
  onOpenTranscript: (id: string) => void;
  /** Avatar override for `view.personalityId`'s mark. Optional — omitted
   *  falls back to the generated mark. */
  avatarUrl?: string;
}

export function CallRow({ call, view, onOpenTranscript, avatarUrl }: CallRowProps) {
  // The live dot is drawn in `var(--accent)`, and outside the chat subtree
  // nothing defines it — every row would otherwise pulse the same generic info
  // blue. Stamped per row from the same resolver the chat tab uses, so a live
  // call wears the colour of the agent that answered it. That is the V3 lesson
  // about the phrase tester: the identity affordance IS the proof.
  return (
    <div
      className={`call-row${view.muted ? ' call-row--muted' : ''}`}
      style={view.personalityId ? accentVars(personalityAccent(view.personalityId)) : undefined}
    >
      <div className="call-row-main">
        <span className={`sb-dot ${view.dotClass}`} aria-hidden="true" />
        <span className="call-mono call-arrow" title={view.directionLabel} aria-hidden="true">
          {view.arrow}
        </span>
        <span className="call-mono call-number">{view.otherParty}</span>
        {view.personalityId ? (
          <span className="call-personality">
            <PersonalityMark personalityId={view.personalityId} size={16} avatarUrl={avatarUrl} />
            <span className="call-mono">{view.personalityId}</span>
          </span>
        ) : (
          // A call nobody answered still has to say so. Blank would read as a
          // rendering bug rather than as "no personality was ever bound".
          <span className="call-mono call-dim">no personality</span>
        )}
        {view.tier ? <span className="call-mono call-tier">{view.tier}</span> : null}
        {/* Omitted, not blanked, when nothing timed the call — the same shape
            `tier` and `cost` already use for a fact the log does not have. An
            empty span would still occupy a flex gap and read as a broken cell. */}
        {view.duration ? <span className="call-mono call-duration">{view.duration}</span> : null}
        {view.cost ? <span className="call-mono call-dim">{view.cost}</span> : null}
        <span className="call-mono call-state">{view.label}</span>
      </div>

      {view.reason ? (
        // Inline on the row that caused it — the same rule WakePanel follows.
        // A grey row plus a toast saying "not allowlisted" is a scavenger hunt.
        <div className="call-row-detail">
          <span className="call-mono call-reason">{view.reason}</span>
        </div>
      ) : null}

      {view.summaryPreview ? (
        <div className="call-row-detail">
          <Typography.Text type="secondary" className="call-summary">
            {view.summaryPreview}
          </Typography.Text>
          {view.showTranscript ? (
            <Button
              size="small"
              type="link"
              className="call-transcript-link"
              onClick={() => onOpenTranscript(call.id)}
            >
              Transcript
            </Button>
          ) : null}
        </div>
      ) : view.showTranscript ? (
        <div className="call-row-detail">
          <Button
            size="small"
            type="link"
            className="call-transcript-link"
            onClick={() => onOpenTranscript(call.id)}
          >
            Transcript
          </Button>
        </div>
      ) : null}
    </div>
  );
}
