import type { BackgroundJobStatusWire } from '@ethosagent/web-contracts';
import { type RunnerIdentity, resolveRunner } from './runners';

// Normative copy for delegated runs (pi-delegation §4.10, D8).
//
// The plan's copy table is a review record; THIS module is the contract. A copy
// freeze whose only copy is a gitignored plan file is enforced by memory, and
// the first component edit silently redefines the product's voice. The run
// card, the drawer pane, the status pill and the question card all import from
// here — none of them holds a user-facing string of its own.
//
// Every string is templated on the runner (D19). A harness name appears nowhere
// in this file; it arrives as a `RunnerIdentity` resolved through the `RUNNERS`
// map, which is also what supplies the badge text and the accent. A grep gate
// (`worker-copy.test.ts`) fails the build if a literal harness name lands here.
//
// `{runner}` renders as the lowercase id (`asked by <id>`), `{Runner}` as the
// label (`Handing it to <Label>`). That asymmetry is in the plan's table and is
// deliberate: the attribution line is machine-voiced, the ack is Ethos talking.

export interface AttributionInput {
  runner: RunnerIdentity | string;
  /** Run label, or the short run id when the row has none yet. */
  label: string;
  /** Open-registry interaction kind (D16) — rendered verbatim. */
  kind: string;
  /** Number of offered options. Omitted or 0 renders no options clause. */
  optionCount?: number;
  /** False when the elicitation carries no default and the run parks (§4.5). */
  hasDefault: boolean;
}

function identity(runner: RunnerIdentity | string): RunnerIdentity {
  return typeof runner === 'string' ? resolveRunner(runner) : runner;
}

export const RUN_COPY = {
  /** Ethos's own sentence when it hands the work over. */
  delegationAck(runner: RunnerIdentity | string): string {
    return `Handing it to ${identity(runner).label} with the acceptance criteria from the ticket. I'm still here — ask me anything while it runs.`;
  },

  /**
   * The `now` line for a run parked on a question. The executor sends an empty
   * `now` for a parked run precisely so this phrasing lives here and not in it.
   */
  pausedNowLine: 'paused — waiting on you',

  /** The `now` line for a run whose host was lost. */
  staleNowLine: 'stale — host lost',

  /** Attribution under a question asked by a run, not by Ethos (§4.5). */
  attribution(input: AttributionInput): string {
    const parts = [
      `asked by ${identity(input.runner).id}`,
      `run ${input.label}`,
      `kind: ${input.kind}`,
    ];
    if (input.optionCount && input.optionCount > 0) parts.push(`${input.optionCount} options`);
    if (!input.hasDefault) parts.push('no default · run parks if unanswered');
    return parts.join(' · ');
  },

  /** Honest timeout statement when nothing will answer on your behalf. */
  noDefaultFooter: 'No default — the run parks if unanswered',

  /** Honest timeout statement when something will. `mmss` is a live countdown. */
  defaultFooter(value: string, mmss: string): string {
    return `Default "${value}" in ${mmss}`;
  },

  /** Offer to answer from the run's origin lane instead. */
  crossSurfaceLink(platform: string): string {
    return `Answer from ${titleCase(platform)} instead ↗`;
  },

  /** Resolved question, left half — the decision stays in the transcript. */
  resolvedAnswer(answer: string): string {
    return `✓ answered: ${answer}`;
  },

  /** Resolved question, right half — which request it settled. */
  resolvedRoute(requestId: string): string {
    return `input.provide → ${requestId}`;
  },

  /** The invisible tier, made visible for one line (§4.5). */
  autoResolveLine(kind: string, via: string): string {
    return `⚿ ${kind} · ${via} — auto-resolved`;
  },

  /** Rung 3 of the escalation ladder — pushed to the run's origin lane. */
  escalationNotice(platform: string): string {
    return `PUSHED TO ${platform.toUpperCase()} · ORIGIN LANE`;
  },

  escalationObligation(obligationId: string): string {
    return `delivery ledger obligation ${obligationId} · claimed once`;
  },

  /** Detail-grid toggle. The glyph is part of the string, per the table. */
  detailsToggle(open: boolean): string {
    return open ? 'hide session details ▴' : 'show session details ▾';
  },

  /** Drawer Runs pane with nothing in it. Practical, not cheerful. */
  drawerEmpty: 'No delegated runs.',

  /**
   * The card's status chip (§4.1's state table). `done` carries the elapsed
   * reading because how long it took is the first thing you want on completion.
   */
  statusChip(status: BackgroundJobStatusWire, elapsedMs: number): string {
    switch (status) {
      case 'queued':
        return 'queued';
      case 'running':
        return 'running';
      case 'blocked':
        return 'needs you';
      case 'done':
        return `done · ${formatElapsed(elapsedMs)}`;
      case 'failed':
        return 'failed';
      case 'aborted':
        return 'cancelled';
      case 'stale':
        return RUN_COPY.staleNowLine;
      default:
        return status;
    }
  },

  /**
   * Status-bar pill (§4.4). Persistent state, never a toast — a notice that
   * vanishes while you are in another tab is the same as no notice at all.
   * Returns null when no run exists, which is when the pill is hidden.
   */
  statusPill(
    runner: RunnerIdentity | string,
    counts: { running: number; needsYou: number; done: number },
  ): string | null {
    const name = identity(runner).id;
    if (counts.needsYou > 0) return `${name} · ${counts.needsYou} needs you`;
    if (counts.running > 0) return `${name} · ${counts.running} running`;
    if (counts.done > 0) return `${name} · done`;
    return null;
  },

  /** Drawer pane header suffix when runs are parked on a question (§4.3). */
  needsYouSummary(count: number): string {
    return `${count} needs you`;
  },

  /** Meta row (§4.1) — `elapsed · $spend / $cap · N tools`. */
  metaRow(elapsedMs: number, spendUsd: number, capUsd: number | null, toolCount: number): string {
    const spend =
      capUsd === null ? formatUsd(spendUsd) : `${formatUsd(spendUsd)} / ${formatUsd(capUsd)}`;
    return `${formatElapsed(elapsedMs)} · ${spend} · ${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}`;
  },

  /** A detail-grid value nothing in this build can report honestly (§4.2). */
  notReported: 'not reported',
} as const;

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
  const hours = Math.floor(min / 60);
  return `${hours}h ${min % 60}m`;
}

export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  return `$${usd.toFixed(2)}`;
}

function titleCase(word: string): string {
  const trimmed = word.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}
