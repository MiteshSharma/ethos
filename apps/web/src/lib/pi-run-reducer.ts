import type { BackgroundJobStatusWire, SseEvent } from '@ethosagent/web-contracts';

// Delegated-run state, as a pure reducer (pi-delegation D9).
//
// Everything the run card, the drawer Runs pane and the status pill know about
// a run lives here, fed exclusively by the `run.update` digest the executor
// publishes onto the PARENT session's stream (G9/D11/D20). The card is fed by
// that digest and nothing else — no second SSE connection, no poll for
// liveness — which is why every live field below has a digest field behind it.
//
// Tested as functions, not as rendered components: the repo has zero component
// tests and this does not spend an innovation token adding jsdom.

export interface RunState {
  jobId: string;
  /** `JobRunner.name`. Resolved through the `RUNNERS` map at render time. */
  runner: string;
  status: BackgroundJobStatusWire;
  /** One line of fact about what the run is doing. Replaced, never appended. */
  now: string;
  elapsedMs: number;
  spendUsd: number;
  toolCount: number;
  /** Wall clock of the first digest — the transcript anchor's birth order. */
  firstSeenAt: number;
  /** Wall clock of the newest digest. */
  updatedAt: number;
}

export interface RunsState {
  byId: Record<string, RunState>;
  /** Job ids in first-seen order, so surfaces render runs in arrival order. */
  order: string[];
}

export const emptyRunsState: RunsState = { byId: {}, order: [] };

const TERMINAL: ReadonlySet<BackgroundJobStatusWire> = new Set([
  'done',
  'failed',
  'aborted',
] satisfies BackgroundJobStatusWire[]);

export function isTerminalRun(status: BackgroundJobStatusWire): boolean {
  return TERMINAL.has(status);
}

/**
 * Fold one SSE event into run state. Anything that is not a `run.update` is a
 * no-op — this reducer is subscribed to the same stream everything else is.
 */
export function applyRunEvent(prev: RunsState, event: SseEvent, now: number): RunsState {
  if (event.type !== 'run.update') return prev;
  const existing = prev.byId[event.jobId];
  const next: RunState = {
    jobId: event.jobId,
    runner: event.runner,
    status: event.status,
    now: event.now,
    elapsedMs: event.elapsedMs,
    spendUsd: event.spendUsd,
    toolCount: event.toolCount,
    firstSeenAt: existing?.firstSeenAt ?? now,
    updatedAt: now,
  };
  return {
    byId: { ...prev.byId, [event.jobId]: next },
    order: existing ? prev.order : [...prev.order, event.jobId],
  };
}

/** Every run in arrival order. */
export function allRuns(state: RunsState): RunState[] {
  const rows: RunState[] = [];
  for (const id of state.order) {
    const run = state.byId[id];
    if (run) rows.push(run);
  }
  return rows;
}

/** Runs parked on a question. The count behind the nav badge and the pill. */
export function runsNeedingYou(state: RunsState): RunState[] {
  return allRuns(state).filter((r) => r.status === 'blocked');
}

/** Counts the status-bar pill is templated on (§4.4). */
export function runCounts(state: RunsState): { running: number; needsYou: number; done: number } {
  let running = 0;
  let needsYou = 0;
  let done = 0;
  for (const run of allRuns(state)) {
    if (run.status === 'blocked') needsYou += 1;
    else if (run.status === 'running' || run.status === 'queued' || run.status === 'stale')
      running += 1;
    else done += 1;
  }
  return { running, needsYou, done };
}

// ---------------------------------------------------------------------------
// §4.1's state table, as data
// ---------------------------------------------------------------------------

/**
 * Every button §4.1 puts on a run card. A button appears in `buttons` because
 * the STATE calls for it; whether this build can wire it is the component's
 * question, not the table's. Keeping the whole table here means each later
 * phase enables its own button without re-deriving which states offer it.
 */
export type RunButton =
  | 'open'
  | 'interrupt'
  | 'cancel'
  | 'takeover'
  | 'review-diff'
  | 'open-log'
  | 'attach'
  | 'retry'
  | 'resume';

export type ChipTone = 'neutral' | 'info' | 'warning' | 'success' | 'error';
export type CardBorder = 'subtle' | 'warning' | 'success' | 'error';

export interface RunCardView {
  chipTone: ChipTone;
  /** The status dot pulses only while the run is actually moving. */
  pulsing: boolean;
  border: CardBorder;
  /** The warm tint §4.1 gives a card that is waiting on you. */
  warmTint: boolean;
  buttons: RunButton[];
}

/** §4.1's states-and-transitions table, verbatim. */
export function runCardView(status: BackgroundJobStatusWire): RunCardView {
  switch (status) {
    case 'queued':
      return {
        chipTone: 'neutral',
        pulsing: false,
        border: 'subtle',
        warmTint: false,
        buttons: ['open', 'cancel'],
      };
    case 'running':
      return {
        chipTone: 'info',
        pulsing: true,
        border: 'subtle',
        warmTint: false,
        buttons: ['open', 'interrupt', 'cancel', 'takeover'],
      };
    case 'blocked':
      return {
        chipTone: 'warning',
        pulsing: false,
        border: 'warning',
        warmTint: true,
        buttons: ['open', 'cancel', 'takeover'],
      };
    case 'done':
      return {
        chipTone: 'success',
        pulsing: false,
        border: 'success',
        warmTint: false,
        buttons: ['review-diff', 'open-log', 'attach'],
      };
    case 'failed':
      return {
        chipTone: 'error',
        pulsing: false,
        border: 'error',
        warmTint: false,
        buttons: ['open-log', 'retry', 'attach'],
      };
    case 'aborted':
      return {
        chipTone: 'warning',
        pulsing: false,
        border: 'error',
        warmTint: false,
        buttons: ['open-log', 'retry', 'attach'],
      };
    case 'stale':
      return {
        chipTone: 'warning',
        pulsing: false,
        border: 'warning',
        warmTint: false,
        buttons: ['open-log', 'resume', 'cancel'],
      };
    default:
      return {
        chipTone: 'neutral',
        pulsing: false,
        border: 'subtle',
        warmTint: false,
        buttons: ['open'],
      };
  }
}
