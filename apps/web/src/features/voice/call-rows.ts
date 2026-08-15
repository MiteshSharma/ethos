import type { rpc } from '../../rpc';

// CallRow's state decision, separated from its markup (voice V4, DR1/DR3).
//
// A phone call is the one surface a stranger can reach without being invited,
// so every fact this file renders traces to something the CALL LOG recorded —
// which guard turned a caller away, which personality actually answered, how
// long the line was open. Nothing here infers a state from "a row exists".
//
// The dot is the app's EXISTING connection dot (`.sb-dot`, DESIGN.md §
// "Connection status indicator"), which V3 already extended once for a
// microphone. A call in progress adds ONE modifier — `.sb-dot--call-live` —
// and every other status reuses a modifier the vocabulary already has. A third
// dot drawn from scratch would be a third thing to keep in sync, and the
// operator would have to learn green twice.

type CallsListData = Awaited<ReturnType<typeof rpc.voice.calls.list>>;
export type CallSummary = CallsListData['calls'][number];
export type CallStatus = CallSummary['status'];
export type CallDirection = CallSummary['direction'];
export type CallTier = CallSummary['tier'];

/** The chip vocabulary for the direction/status filter bar. */
export type CallDirectionFilter = CallDirection | 'all';
export type CallStatusFilter = CallStatus | 'all';

export interface CallFilter {
  direction: CallDirectionFilter;
  status: CallStatusFilter;
}

export const DEFAULT_CALL_FILTER: CallFilter = { direction: 'all', status: 'all' };

/** Rows the list asks for. Well under the contract's 200 ceiling: this is a
 *  scannable history, not an export. */
export const CALL_LIST_LIMIT = 100;

export const CALL_DIRECTION_FILTERS: ReadonlyArray<{
  value: CallDirectionFilter;
  label: string;
}> = [
  { value: 'all', label: 'All' },
  { value: 'inbound', label: 'Inbound' },
  { value: 'outbound', label: 'Outbound' },
];

export const CALL_STATUS_FILTERS: ReadonlyArray<{ value: CallStatusFilter; label: string }> = [
  { value: 'all', label: 'Any state' },
  { value: 'live', label: 'Live' },
  { value: 'ringing', label: 'Ringing' },
  { value: 'completed', label: 'Completed' },
  { value: 'screened', label: 'Screened' },
  { value: 'refused', label: 'Refused' },
  { value: 'failed', label: 'Failed' },
];

/**
 * The chips, translated into what `voice.calls.list` accepts.
 *
 * Narrowing happens on the SERVER, not by filtering a rendered array: a
 * deployment with months of calls would otherwise pull the whole history down
 * to show six screened rows. `'all'` is expressed by OMITTING the key, because
 * the contract's `direction`/`status` are `.optional()` and absent means
 * "every one" — sending a sentinel string would be refused at the boundary.
 */
export function callsQueryInput(
  filter: CallFilter,
  limit: number = CALL_LIST_LIMIT,
): Parameters<typeof rpc.voice.calls.list>[0] {
  return {
    limit,
    ...(filter.direction === 'all' ? {} : { direction: filter.direction }),
    ...(filter.status === 'all' ? {} : { status: filter.status }),
  };
}

export interface CallRowView {
  status: CallStatus;
  /** Modifier on the shared `.sb-dot` connection dot. */
  dotClass: string;
  /** The mono state word — the call log's vocabulary, not a prettified sentence. */
  label: string;
  /** The call is up right now: the duration ticks and the dot carries its ring. */
  live: boolean;
  /** Whether the row is drawn back (DR1's "grey row"): a call that never
   *  reached the owner is history, not activity. */
  muted: boolean;
  /** `→` outbound, `←` inbound. The arrow, not a word, because the row is
   *  scanned rather than read. */
  arrow: string;
  directionLabel: string;
  /** The number at the OTHER end — the only one that identifies the call. */
  otherParty: string;
  personalityId: string | null;
  tier: CallTier;
  /** Elapsed time, `m:ss` or `h:mm:ss`, always tabular. Null when nothing timed
   *  the call — the cell is then left out, exactly as an unpriced call leaves
   *  out its cost, rather than inventing a `0:00`. */
  duration: string | null;
  /** Why an ENDED call ended up the way it did. Null while it is still up. */
  reason: string | null;
  summaryPreview: string | null;
  /** Gated on `hasTranscript`: a link that opens an empty pane is a lie. */
  showTranscript: boolean;
  /** Rendered cost, or null when the log recorded none. */
  cost: string | null;
}

/**
 * Which `.sb-dot` modifier a status wears, and whether the row is drawn back.
 *
 * The mapping is deliberately a REUSE of the existing vocabulary, with exactly
 * one addition:
 *
 * - `ringing`  → `--connecting` (amber, pulsing). A phone ringing and a socket
 *   connecting are the same fact: something is being established and has not
 *   landed yet.
 * - `live`     → `--call-live` (accent + resting ring, pulsing). THE new
 *   modifier. Accent because a live call belongs to the personality answering
 *   it; the ring is what separates "a call is open on this row" from a
 *   satellite's `--speaking` accent dot, since a list can show both.
 * - `completed`→ `--connected` (green, solid). It happened and it finished.
 * - `screened` → `--muted` (grey, solid), row drawn back. The receptionist took
 *   it; the owner was never reached.
 * - `refused`  → `--wake-off` (hollow), row drawn back. Hollow is already the
 *   system's word for "switched off on purpose" — a guard turning a caller away
 *   is a DECISION, and it must not look like the line broke.
 * - `failed`   → `--degraded` (red). It broke.
 *
 * The refused/failed split is the whole reason the call log stores them apart:
 * "we said no" and "it fell over" get looked at by different people.
 */
function statusPresentation(status: CallStatus): {
  dotClass: string;
  label: string;
  live: boolean;
  muted: boolean;
} {
  switch (status) {
    case 'ringing':
      return { dotClass: 'sb-dot--connecting', label: 'ringing', live: true, muted: false };
    case 'live':
      return { dotClass: 'sb-dot--call-live', label: 'live', live: true, muted: false };
    case 'completed':
      return { dotClass: 'sb-dot--connected', label: 'completed', live: false, muted: false };
    case 'screened':
      return { dotClass: 'sb-dot--muted', label: 'screened', live: false, muted: true };
    case 'refused':
      return { dotClass: 'sb-dot--wake-off', label: 'refused', live: false, muted: true };
    default:
      return { dotClass: 'sb-dot--degraded', label: 'failed', live: false, muted: false };
  }
}

/**
 * How long the line has been open, in milliseconds — or `null` when nothing
 * timed the call.
 *
 * A LIVE call (`ringing`/`live`) has no `endedAt` because it has not ended, so
 * it is measured against `now` — which the caller passes in rather than this
 * module reading a clock, so the row stays pure and the ticking is testable.
 * Clamped at zero: a satellite whose clock runs ahead of the browser's must not
 * render a negative duration.
 *
 * A call that has ENDED with no `endedAt` is a different fact: nobody was on the
 * line to see it finish. An outbound call the agent placed is exactly that — the
 * row closes when the trunk accepts the dial, and nothing stays to hear the far
 * end hang up. Measuring it against `now` would be the worst possible answer: a
 * finished call whose duration GROWS every second the tab is open. Zero would be
 * quieter and still a lie, invented in the same column that shows real inbound
 * call lengths. So it returns `null`, and the row renders no duration at all.
 */
export function callDurationMs(call: CallSummary, now: number): number | null {
  // `statusPresentation` owns which statuses are live; asking it here keeps one
  // definition rather than a second list that can drift from the dots.
  const end = call.endedAt ?? (statusPresentation(call.status).live ? now : null);
  return end === null ? null : Math.max(0, end - call.startedAt);
}

/** `0:07`, `12:05`, `1:02:33`. Tabular by CSS, zero-padded here. */
export function formatCallDuration(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours > 0 ? `${hours}:` : ''}${mm}:${String(seconds).padStart(2, '0')}`;
}

/** Cents matter on a per-minute line, so two decimals, never rounded to whole
 *  dollars. Null stays null — an unpriced call must not render `$0.00`. */
export function formatCallCost(costUsd: number | null): string | null {
  return costUsd === null ? null : `$${costUsd.toFixed(2)}`;
}

export function callRowView(call: CallSummary, now: number): CallRowView {
  const presentation = statusPresentation(call.status);
  const inbound = call.direction === 'inbound';
  const durationMs = callDurationMs(call, now);
  return {
    status: call.status,
    dotClass: presentation.dotClass,
    label: presentation.label,
    live: presentation.live,
    muted: presentation.muted,
    arrow: inbound ? '←' : '→',
    directionLabel: inbound ? 'inbound' : 'outbound',
    // Our own number is on every row and identifies nothing; the far end is the
    // call.
    otherParty: inbound ? call.fromNumber : call.toNumber,
    personalityId: call.personalityId,
    tier: call.tier,
    duration: durationMs === null ? null : formatCallDuration(durationMs),
    // Wherever the log kept one. Screened/refused/failed rows explain a state
    // the operator may have to act on — and a `completed` row can carry a reason
    // too: an outbound call the agent placed is closed the moment the trunk
    // accepts it, because nothing stays on the line to see it end, and its
    // reason is the only thing separating "it finished" from "we stopped
    // watching". Dropping it would leave a bare green `completed` overclaiming.
    // `ringing`/`live` are excluded because they have not ended yet.
    reason: call.status === 'ringing' || call.status === 'live' ? null : call.reason,
    summaryPreview: call.summaryPreview,
    showTranscript: call.hasTranscript,
    cost: formatCallCost(call.costUsd),
  };
}

/**
 * History minus the calls already pinned at the top as in-progress.
 *
 * `voice.calls.list` and `voice.calls.active` are separate reads of the same
 * log, so a ringing call legitimately appears in both. Rendering it twice looks
 * like a bug rather than like emphasis, and the pinned copy is the one that
 * ticks — so the history drops it until it ends.
 */
export function withoutActive(
  calls: readonly CallSummary[],
  active: readonly CallSummary[],
): CallSummary[] {
  const pinned = new Set(active.map((call) => call.id));
  return calls.filter((call) => !pinned.has(call.id));
}

/** Empty-state copy (DR1). Says what to do next and where, because "no calls
 *  yet" on a surface nobody has configured is a dead end, not a state. */
export const CALLS_EMPTY_COPY =
  'No calls yet. Configure a trunk, then try calling your Ethos number.';

/** Empty state for a FILTERED list — a different fact from "no calls at all",
 *  and conflating them invites the operator to go re-check a working trunk. */
export const CALLS_EMPTY_FILTERED_COPY =
  'No calls match these filters. Clear them to see the whole history.';
