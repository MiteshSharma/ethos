import { useState } from 'react';
import {
  formatDuration,
  formatJson,
  previewArgs,
  type RowStatus,
  statusGlyph,
  statusWord,
  summariseTrail,
  type TrailEntry,
  trailRowId,
} from '../../lib/trail';

// The trail — feedback & activity contract §3/§5, DESIGN.md "Feedback &
// activity". One collapsed footer line under the bubble, expanding into the
// same dense rows the drawer draws. Rows, not boxes: no card chrome, no
// left-border stripe, no shadow ("cards earn existence").
//
// `TrailRow` is exported because it is the row vocabulary for the whole
// system — the drawer's per-turn grouping and `ui/FeedbackRow` render the same
// shape, so there is exactly one answer to "what does an action look like".

export interface TrailProps {
  entries: TrailEntry[];
  /** The turn this trail belongs to. Row ids derive from it. */
  turnId: string;
  /** The user stopped this turn: the footer reads `✗ stopped · N actions`. */
  stopped?: boolean;
}

export function Trail({ entries, turnId, stopped }: TrailProps) {
  const [expanded, setExpanded] = useState(false);
  const summary = summariseTrail(entries);

  // Nothing to account for → no footer at all. A reply the agent simply wrote
  // has no work behind it, and an empty accounting line is noise.
  if (summary.actions === 0 && summary.findings === 0) return null;

  // A turn with findings but NO actions is the `no_tools_at_all` case, which
  // has zero actions by definition — the whole point of the finding is that
  // the agent claimed work it never did. `0 actions · —` would be two pieces
  // of noise around the one thing worth reading, so the findings ARE the
  // footer: `⚠ 1 unverified ▸`.
  const actionless = summary.actions === 0;

  const duration = summary.totalDurationMs === null ? '—' : formatDuration(summary.totalDurationMs);
  const actionsWord = summary.actions === 1 ? 'action' : 'actions';
  // Never a fabricated "✓ verified": zero findings means nothing was checked,
  // which is not the same as nothing being wrong (fail-open, contract §3).
  //
  // The same rule governs the leading glyph. A ✓ is a claim that the work came
  // back ok, so it needs at least one action that genuinely DID, none whose
  // outcome was never recorded, and none still WAITING for one; a reloaded turn
  // therefore reads `4 actions · —`, with no assurance glyph at all. A ✗ still
  // wins whenever anything failed.
  //
  // `unsettled` is the dropped-`tool_end` case. Neither reducer settles a row
  // on `done` — a `tool_end` legitimately arrives after it — so a call whose
  // end never came stays `running` for ever, and a footer that ticked over it
  // would be the exact fabricated assurance `unrecorded` exists to prevent.
  const assured = summary.ok > 0 && summary.unrecorded === 0 && summary.unsettled === 0;
  const count = `${summary.actions} ${actionsWord}`;
  const lead = stopped
    ? `✗ stopped · ${count}`
    : summary.failed > 0
      ? `✗ ${count}`
      : assured
        ? `✓ ${count}`
        : count;

  return (
    <div className="trail">
      <button
        type="button"
        className="trail-footer activity-slot"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        {actionless ? null : <span className="trail-footer-lead">{lead}</span>}
        {summary.findings > 0 ? (
          <span className="trail-footer-findings">
            {actionless ? '' : ' · '}⚠ {summary.findings} unverified
          </span>
        ) : null}
        {actionless ? null : <span className="trail-footer-duration">{` · ${duration}`}</span>}
        <span className="trail-footer-chevron" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded ? (
        <div className="trail-rows">
          {entries.map((entry) => (
            <TrailRow
              key={entry.kind === 'action' ? `a-${entry.toolCallId}` : `f-${entry.id}`}
              entry={entry}
              rowId={trailRowId(turnId, entry.kind === 'action' ? entry.toolCallId : entry.id)}
              {...(entry.kind === 'finding' && entry.citesToolCallId
                ? { citedRowId: trailRowId(turnId, entry.citesToolCallId) }
                : {})}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface TrailRowProps {
  entry: TrailEntry;
  /** Deterministic DOM id — a finding row moves focus to the row it cites. */
  rowId: string;
  /** DOM id of the action row this finding cites, when it cites one. */
  citedRowId?: string;
}

export function TrailRow({ entry, rowId, citedRowId }: TrailRowProps) {
  const [expanded, setExpanded] = useState(false);

  if (entry.kind === 'finding') {
    // The row is a button whose whole job is to take you to the evidence.
    return (
      <button
        type="button"
        id={rowId}
        className="activity-row activity-row-unverified trail-row"
        onClick={() => {
          if (!citedRowId) return;
          document.getElementById(citedRowId)?.focus();
        }}
      >
        <RowState status="unverified" />
        {/* The claim is the model's own words, so it is quoted — the quotes the
            wire format carried are stripped on the way in and drawn here. */}
        <span className="activity-row-subject">{`"${entry.claim}"`}</span>
        {entry.evidence ? (
          <span className="activity-row-result">{`— ${entry.evidence}`}</span>
        ) : null}
      </button>
    );
  }

  const preview = previewArgs(entry.args);
  return (
    <div className="trail-row-wrapper">
      <button
        type="button"
        id={rowId}
        className={`activity-row activity-row-${entry.status} trail-row`}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <RowState status={entry.status} />
        <span className="activity-row-subject">{entry.toolName}</span>
        <span className="activity-row-result">{preview}</span>
        <span className="activity-row-meta">
          {entry.durationMs === undefined ? '—' : formatDuration(entry.durationMs)}
        </span>
      </button>
      {expanded ? <TrailRowDetail entry={entry} /> : null}
    </div>
  );
}

/** Glyph AND word — colour is never the only carrier (DESIGN.md). */
export function RowState({ status }: { status: RowStatus }) {
  return (
    <span className="activity-row-state">
      <span aria-hidden="true">{statusGlyph(status)}</span> {statusWord(status)}
    </span>
  );
}

function TrailRowDetail({ entry }: { entry: Extract<TrailEntry, { kind: 'action' }> }) {
  return (
    <div className="trail-row-detail">
      {entry.reason ? (
        <TrailRowSection label="reason">
          <pre>{entry.reason}</pre>
        </TrailRowSection>
      ) : null}
      <TrailRowSection label="args">
        <pre>{formatJson(entry.args)}</pre>
      </TrailRowSection>
      {entry.result !== undefined ? (
        <TrailRowSection label={entry.status === 'failed' ? 'error' : 'result'}>
          <pre>{entry.result}</pre>
        </TrailRowSection>
      ) : entry.status === 'running' ? (
        <TrailRowSection label="result">
          <span className="trail-row-pending">running…</span>
        </TrailRowSection>
      ) : null}
    </div>
  );
}

function TrailRowSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="trail-row-section">
      <span className="trail-row-section-label">{label}</span>
      {children}
    </div>
  );
}
