import { isLightSurface } from '@ethosagent/design-tokens/antd';
import type { BackgroundJobDetailWire, ClarifyRequestEvent } from '@ethosagent/web-contracts';
import { Button } from 'antd';
import { useState } from 'react';
import { useTaskCancel } from '../../features/tasks/api/mutations';
import { useTaskDetail } from '../../features/tasks/api/queries';
import {
  type ClarifyQueueState,
  questionForRun,
  type ResolvedClarify,
  resolvedForRun,
} from '../../lib/clarify-queue';
import { type RunState, type RunsState, runCardView } from '../../lib/pi-run-reducer';
import { resolveRunner, runnerAccentVars } from '../../lib/runners';
import { useResolvedTokens } from '../../lib/skin-tokens';
import { RUN_COPY } from '../../lib/worker-copy';
import { ClarifyCard } from './ClarifyCard';

// The delegated-run card (pi-delegation §4.1). Rendered inline in the chat
// transcript, where the handoff happened, in place of what would otherwise be
// a tool chip.
//
// Anatomy, top to bottom, and in this order:
//   1. header row      — runner badge · run label · status chip
//   2. task line       — the delegated prompt, two lines max
//   3. `now` line      — one line, replaced never appended
//   4. meta row        — elapsed · spend / cap · tool count, + details toggle
//   5. detail grid     — §4.2, expanded on spawn, collapsible
//   6. question card   — inserted ABOVE the grid when the run is parked
//   7. button row
//
// Built from raw primitives on purpose: DESIGN.md's decisions log rules this is
// NOT a fourth "cards earn existence" exemption, because the rule governs the
// `Card` primitive and this is a singleton with no dense row to lose to.
//
// Live state comes from the `run.update` digest alone. The detail query is
// asked ONCE (`live: false`) for the row's static half.

/**
 * Everything a transcript needs to draw the run cards its anchors point at.
 * Threaded down from Chat as one prop rather than four, and as a prop rather
 * than a context because the transcript already drills `fenceRenderers` and
 * `onSuggestPrompt` the same way.
 */
export interface RunSurface {
  runs: RunsState;
  clarifyQueue: ClarifyQueueState;
  onAnswered: (requestId: string, answer: string) => void;
}

/** Draw the card an anchor points at, or nothing if its run is gone. */
export function RunAnchor({ jobId, surface }: { jobId: string; surface: RunSurface }) {
  const run = surface.runs.byId[jobId];
  if (!run) return null;
  return (
    <RunCard
      run={run}
      question={questionForRun(surface.clarifyQueue, jobId)}
      resolved={resolvedForRun(surface.clarifyQueue, jobId)}
      onAnswered={surface.onAnswered}
    />
  );
}

export interface RunCardProps {
  run: RunState;
  /** The question this run is parked on, drawn inside the card (§4.5). */
  question?: ClarifyRequestEvent | undefined;
  /** The decision already made, kept in view — it does not disappear (§4.5). */
  resolved?: ResolvedClarify | undefined;
  /** Called with the answer this tab sent, so the resolved state can name it. */
  onAnswered?: (requestId: string, answer: string) => void;
}

export function RunCard({ run, question, resolved, onAnswered }: RunCardProps) {
  const runner = resolveRunner(run.runner);
  const tokens = useResolvedTokens();
  const light = isLightSurface(tokens);
  const view = runCardView(run.status);
  // Expanded on spawn (§4.1 item 5); the choice then persists for the card's
  // life, which is the run's life.
  const [detailsOpen, setDetailsOpen] = useState(true);
  const detail = useTaskDetail(run.jobId, { live: false });
  const cancel = useTaskCancel();

  const row = detail.data ?? undefined;
  const label = row?.label ?? shortId(run.jobId);
  const nowLine = resolveNowLine(run.status, run.now);

  const className = ['run-card', `run-card--${view.border}`, view.warmTint ? 'run-card--warm' : '']
    .filter(Boolean)
    .join(' ');

  // `tabIndex={-1}` makes the card a focus target for the drawer's Answer
  // button without joining the tab order.
  return (
    <section
      id={`run-card-${run.jobId}`}
      className={className}
      style={runnerAccentVars(runner, light)}
      aria-label={`${runner.label} run ${label}`}
      tabIndex={-1}
    >
      <header className="run-card-header">
        <span className="run-card-badge talk-mono">{runner.badgeText}</span>
        <span className="run-card-label talk-mono">{label}</span>
        <span className={`run-card-chip run-card-chip--${view.chipTone}`}>
          <span
            className={`run-card-dot${view.pulsing ? ' run-card-dot--pulsing' : ''}`}
            aria-hidden="true"
          />
          {RUN_COPY.statusChip(run.status, run.elapsedMs)}
        </span>
      </header>

      {row?.prompt ? <p className="run-card-task">{row.prompt}</p> : null}

      <p className="run-card-now talk-mono">
        <span className="run-card-now-key">now</span>
        <span className="run-card-now-value">{nowLine}</span>
      </p>

      <div className="run-card-meta talk-mono">
        <span>
          {RUN_COPY.metaRow(run.elapsedMs, run.spendUsd, row?.maxCostUsd ?? null, run.toolCount)}
        </span>
        <button
          type="button"
          className="run-card-details-toggle"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((v) => !v)}
        >
          {RUN_COPY.detailsToggle(detailsOpen)}
        </button>
      </div>

      {question ? (
        <div className="run-card-question">
          <p className="run-card-attribution talk-mono">
            {RUN_COPY.attribution({
              runner,
              label,
              kind: question.options && question.options.length > 0 ? 'pick' : 'input',
              ...(question.options ? { optionCount: question.options.length } : {}),
              hasDefault: question.default !== undefined,
            })}
          </p>
          <ClarifyCard
            request={question}
            variant="slot"
            {...(onAnswered
              ? { onAnswered: (answer: string) => onAnswered(question.requestId, answer) }
              : {})}
          />
          <p className="run-card-question-footer talk-mono">
            {question.default === undefined ? RUN_COPY.noDefaultFooter : null}
          </p>
        </div>
      ) : resolved ? (
        <div className="run-card-question run-card-question--resolved talk-mono">
          <span>{RUN_COPY.resolvedAnswer(resolved.answer ?? resolved.question)}</span>
          <span className="run-card-question-route">
            {RUN_COPY.resolvedRoute(resolved.requestId)}
          </span>
        </div>
      ) : null}

      {detailsOpen ? <DetailGrid run={run} detail={row} /> : null}

      <div className="run-card-buttons">
        {view.buttons.includes('cancel') ? (
          <Button
            size="small"
            danger
            loading={cancel.isPending}
            onClick={() => cancel.mutate(run.jobId)}
          >
            Cancel
          </Button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * §4.2 — the shared rows this build can state honestly, then whatever the
 * runner's own `describe(job)` contributed (D18).
 *
 * A value this build cannot report is rendered `not reported` in a warning
 * tone, never guessed and never green: "no row may state a guarantee the kernel
 * does not enforce". `fs reach`, `model`, `workspace`, `branch` and the two
 * kind rows have no wire field yet — they arrive as runner-contributed rows or
 * as later phases fill them, and until then they say so.
 */
function DetailGrid({ run, detail }: { run: RunState; detail?: BackgroundJobDetailWire }) {
  const unreported = { value: RUN_COPY.notReported, tone: 'warn' as const };
  const rows: Array<{ label: string; value: string; tone?: 'accent' | 'safe' | 'warn' }> = [
    { label: 'run id', value: run.jobId },
    { label: 'label', value: detail?.label ?? RUN_COPY.notReported },
    { label: 'parent session', value: detail?.parentSessionKey ?? RUN_COPY.notReported },
    { label: 'child session', value: detail?.childSessionKey ?? RUN_COPY.notReported },
    {
      label: 'origin lane',
      value:
        detail?.originPlatform && detail.originChatId
          ? `${detail.originPlatform}:${detail.originChatId}`
          : RUN_COPY.notReported,
    },
    { label: 'personality', value: detail?.personalityId ?? RUN_COPY.notReported },
    { label: 'model', ...unreported },
    { label: 'workspace', ...unreported },
    { label: 'branch', ...unreported },
    { label: 'fs reach', ...unreported },
    {
      label: 'budget',
      value:
        detail?.maxCostUsd != null
          ? `$${detail.maxCostUsd.toFixed(2)} · abort on breach`
          : RUN_COPY.notReported,
      ...(detail?.maxCostUsd != null ? { tone: 'safe' as const } : { tone: 'warn' as const }),
    },
    { label: 'depth', value: detail ? String(detail.depth) : RUN_COPY.notReported },
    { label: 'heartbeat', ...unreported },
    { label: 'auto-resolved kinds', ...unreported },
    { label: 'routed to you', ...unreported },
    ...(detail?.detailRows ?? []),
  ];

  return (
    <dl className="run-card-grid talk-mono">
      {rows.map((r) => (
        <div className="run-card-grid-row" key={`${r.label}-${r.value}`}>
          <dt>{r.label}</dt>
          <dd className={r.tone ? `run-card-grid-value--${r.tone}` : undefined}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The `now` line. The executor sends an empty string for a parked or lost run
 * precisely so the phrasing lives in the copy module rather than in it.
 */
function resolveNowLine(status: RunState['status'], now: string): string {
  if (now) return now;
  if (status === 'blocked') return RUN_COPY.pausedNowLine;
  if (status === 'stale') return RUN_COPY.staleNowLine;
  return '—';
}

function shortId(jobId: string): string {
  return jobId.length > 12 ? jobId.slice(0, 12) : jobId;
}
