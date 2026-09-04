import type { SseEvent } from '@ethosagent/web-contracts';

// The trail — one derivation of "what the agent did on this turn", rendered by
// two surfaces (the per-turn footer under the bubble, and the right drawer).
// See plan/phases/feedback-activity-contract.md §3–§5 and DESIGN.md
// "Feedback & activity".
//
// Zero React imports, on purpose: this is pure state, unit-testable without
// jsdom, the same rule `chat-reducer.ts` and `drawer-reducer.ts` follow. The
// row-formatting helpers (`previewArgs`, `formatDuration`, `formatJson`,
// `statusGlyph`, `statusWord`) live here rather than in a component because
// BOTH the reducer (which builds the status-line label) and the row components
// need them, and one spelling of "how a tool call reads" is the whole point of
// the contract.
//
// NOTE on history: there is deliberately no `deriveTrailsFromHistory(messages)`
// here. Durations and results live on the persisted `StoredMessage` rows, not
// on the parsed `ChatMessage[]`, so a function taking the parsed messages could
// not recover them. `parseHistory` in `chat-reducer.ts` therefore builds the
// `TrailState` as it walks the stored rows — one walk, no duplication.

/**
 * `unrecorded` is what a tool call reloaded from history reads as: it RAN, and
 * whether it succeeded was not persisted. `StoredMessage` carries no error flag
 * on a `tool_result` row, so a reloaded failure is indistinguishable from a
 * reloaded success — and painting a ✓ on it would fabricate assurance the wire
 * never carried (contract §3, "fail-open must not fabricate assurance").
 *
 * FOLLOW-UP: the real fix is persisting an `is_error` flag on `tool_result`
 * rows so history can say `ok` or `failed` honestly. Until then this state is
 * the truthful placeholder, and a live `tool_end` still flips it either way.
 */
export type TrailEntryStatus = 'pending-approval' | 'running' | 'ok' | 'failed' | 'unrecorded';

export interface TrailAction {
  kind: 'action';
  toolCallId: string;
  toolName: string;
  args: unknown;
  status: TrailEntryStatus;
  /** Absent => renders as "—" (history rows carry no duration). */
  durationMs?: number;
  result?: string;
  /** Reason copy carried from the approval request (e.g. "force-delete"). */
  reason?: string;
}

export interface TrailFinding {
  kind: 'finding';
  id: string;
  /** The claim being flagged, rendered in mono. */
  claim: string;
  /** Supporting evidence line, rendered in --text-secondary. */
  evidence?: string;
  /** toolCallId of the action this finding cites; the row focuses it. */
  citesToolCallId?: string;
}

export type TrailEntry = TrailAction | TrailFinding;

/** turnId -> ordered entries */
export type TrailState = Record<string, TrailEntry[]>;

/**
 * Every state a row can be in, across the trail AND the non-chat feedback rows.
 * `unverified` has no live-tool equivalent — it is what a finding row reads as.
 */
export type RowStatus = TrailEntryStatus | 'unverified';

/** Glyph + word, never colour alone (DESIGN.md "Semantic colors"). */
export function statusGlyph(status: RowStatus): string {
  if (status === 'ok') return '✓';
  if (status === 'failed') return '✗';
  if (status === 'unverified') return '⚠';
  if (status === 'pending-approval') return '?';
  // Neither a tick nor a cross: an unrecorded outcome is not an outcome.
  if (status === 'unrecorded') return '–';
  return '·';
}

export function statusWord(status: RowStatus): string {
  if (status === 'ok') return 'ok';
  if (status === 'failed') return 'failed';
  if (status === 'unverified') return 'unverified';
  if (status === 'pending-approval') return 'waiting';
  if (status === 'unrecorded') return 'unrecorded';
  return 'running';
}

export function appendTrailEntry(trail: TrailState, turnId: string, entry: TrailEntry): TrailState {
  return { ...trail, [turnId]: [...(trail[turnId] ?? []), entry] };
}

/** Apply `update` to one action of one turn. No-op when it isn't there. */
export function updateTrailAction(
  trail: TrailState,
  turnId: string,
  toolCallId: string,
  update: Partial<Omit<TrailAction, 'kind' | 'toolCallId'>>,
): TrailState {
  const entries = trail[turnId];
  if (!entries) return trail;
  const idx = entries.findIndex((e) => e.kind === 'action' && e.toolCallId === toolCallId);
  if (idx < 0) return trail;
  const entry = entries[idx];
  if (entry?.kind !== 'action') return trail;
  const next = [...entries];
  next[idx] = { ...entry, ...update };
  return { ...trail, [turnId]: next };
}

/**
 * The same update, but searching every turn newest-first.
 *
 * `tool_end` can arrive after `done` has already moved the turn into history,
 * so the turn id the caller would key on is no longer the current one.
 */
export function updateTrailActionAnywhere(
  trail: TrailState,
  toolCallId: string,
  update: Partial<Omit<TrailAction, 'kind' | 'toolCallId'>>,
): TrailState {
  // Insertion order puts the newest turn last; the newest match is the one.
  const turnIds = Object.keys(trail).reverse();
  for (const turnId of turnIds) {
    const next = updateTrailAction(trail, turnId, toolCallId, update);
    if (next !== trail) return next;
  }
  return trail;
}

/** The pseudo tool name a grounding finding arrives under on `tool_progress`
 *  (producer lands with `plan/phases/ground-truth-verification.md`). */
const GROUNDING_TOOL = '_grounding';

/**
 * The ONE event→trail transition, called by both surfaces (contract §4, "one
 * trail, two renderers"). Sharing the TYPES was not enough: each reducer
 * hand-rolled its own transition, so the drawer never grew `tool_progress` or
 * `tool.approval_required` and the two would have disagreed about the same turn
 * the moment the `_grounding` producer landed.
 *
 * `null` means the audience gate dropped it: the stream is alive, nothing
 * surfaces. An UNCHANGED trail is a different answer — it surfaced but wrote no
 * row (status text, or a `tool_end` for a call this surface never saw start).
 *
 * `turnId` names the turn a NEW row joins; `tool_end` ignores it, resolving its
 * call wherever it lives. Everything that is not the trail stays with the
 * caller — the per-turn entry cap, stall clock, phase, `pendingApprovals`.
 */
export function applyTrailEvent(
  trail: TrailState,
  turnId: string,
  event: SseEvent,
  resultCap?: number,
): TrailState | null {
  switch (event.type) {
    case 'tool_start':
      // Lane E (tools-as-code-api): in-script inner calls never surface.
      if (event.audience === 'internal') return null;
      return upsertAction(trail, turnId, {
        kind: 'action',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        status: 'running',
      });
    case 'tool_end':
      if (event.audience === 'internal') return null;
      return updateTrailActionAnywhere(trail, event.toolCallId, {
        status: event.ok ? 'ok' : 'failed',
        durationMs: event.durationMs,
        ...(event.result !== undefined ? { result: capResult(event.result, resultCap) } : {}),
      });
    case 'tool.approval_required': {
      // Deny arrives as a `tool_end` with no `tool_start`; allow as a
      // `tool_start` that flips this row to running.
      const req = event.request;
      return upsertAction(trail, turnId, {
        kind: 'action',
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        args: req.args,
        status: 'pending-approval',
        ...(req.reason ? { reason: req.reason } : {}),
      });
    }
    case 'tool_progress': {
      // Tool-progress audience boundary (CLAUDE.md): only `'user'` surfaces.
      if (event.audience !== 'user') return null;
      // Findings are trail rows (contract §5); every other user-audience
      // progress line is status text, which is the caller's business.
      if (event.toolName !== GROUNDING_TOOL) return trail;
      const seq = trail[turnId]?.length ?? 0;
      return appendTrailEntry(trail, turnId, {
        kind: 'finding',
        id: `${turnId}-finding-${seq}`,
        claim: event.message,
      });
    }
    default:
      return trail;
  }
}

/** Add the row, or flip the one this call already has (an approved call has one). */
function upsertAction(trail: TrailState, turnId: string, action: TrailAction): TrailState {
  const flipped = updateTrailAction(trail, turnId, action.toolCallId, {
    args: action.args,
    status: action.status,
    ...(action.reason ? { reason: action.reason } : {}),
  });
  return flipped !== trail ? flipped : appendTrailEntry(trail, turnId, action);
}

/** Keep a readable head of the result and SAY the rest was cut, never drop it silently. */
function capResult(result: string, cap?: number): string {
  if (cap === undefined || result.length <= cap) return result;
  return `${result.slice(0, cap)}\n[truncated — ${result.length} chars total]`;
}

/**
 * Close a turn's trail because the turn ended without finishing: anything still
 * running did not finish, and anything still parked on `pending-approval` will
 * never be answered — the turn that asked is over and nothing is left alive to
 * resolve it — so both settle as `failed`, and saying so is the honest end.
 *
 * Callers own the other half of an unanswered approval: the request in their
 * own modal queue has to go with it, or the modal stays on screen (chat's
 * `stopTurn` / `error`).
 *
 * `reason` is the caller's account of WHY, and the two endings render
 * differently: `'stopped'` earns the `✗ stopped · N actions` lead (the turn is
 * also recorded in `stoppedTurnIds`), while `'errored'` leaves the footer to
 * lead with ✗ off the failed rows alone — the user did not stop that one.
 * Neither changes what happens to the rows, which is why it is unused here.
 */
export function closeTrail(
  trail: TrailState,
  turnId: string,
  _reason: 'stopped' | 'errored',
): TrailState {
  const entries = trail[turnId];
  if (!entries) return trail;
  let changed = false;
  const next = entries.map((e) => {
    if (e.kind !== 'action') return e;
    if (e.status !== 'running' && e.status !== 'pending-approval') return e;
    changed = true;
    return { ...e, status: 'failed' as const };
  });
  return changed ? { ...trail, [turnId]: next } : trail;
}

export interface TrailSummary {
  actions: number;
  findings: number;
  /** Actions that genuinely came back ok — never inferred from "not failed". */
  ok: number;
  failed: number;
  /** Actions whose outcome was never persisted; neither a success nor a failure. */
  unrecorded: number;
  /** Null when NO action carries a duration — history without durations. */
  totalDurationMs: number | null;
}

export function summariseTrail(entries: TrailEntry[]): TrailSummary {
  let actions = 0;
  let findings = 0;
  let ok = 0;
  let failed = 0;
  let unrecorded = 0;
  let total: number | null = null;
  for (const entry of entries) {
    if (entry.kind === 'finding') {
      findings++;
      continue;
    }
    actions++;
    if (entry.status === 'ok') ok++;
    if (entry.status === 'failed') failed++;
    if (entry.status === 'unrecorded') unrecorded++;
    if (entry.durationMs !== undefined) total = (total ?? 0) + entry.durationMs;
  }
  return { actions, findings, ok, failed, unrecorded, totalDurationMs: total };
}

/** Deterministic DOM id, so a finding row can move focus to the row it cites. */
export function trailRowId(turnId: string, key: string): string {
  return `trail-row-${turnId}-${key}`;
}

/**
 * Single-line preview of args — what the call is doing, not the full payload.
 * Salvaged verbatim from `ToolChip.previewArgs` (the chip this replaced).
 */
export function previewArgs(args: unknown): string {
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') return truncate(args, 60);
  if (typeof args !== 'object') return String(args);

  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return '';

  // Single-key objects are the common case (path: 'x', url: 'x', command: 'x') —
  // show the value, since the key is implicit in the tool name. Multi-key: the
  // first key's value is usually the most informative one.
  const entry = entries[0];
  if (!entry) return '';
  const [, value] = entry;
  return typeof value === 'string' ? truncate(value, 60) : truncate(JSON.stringify(value), 60);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** The status line's label for a running tool: `{tool} · {argsPreview}`. */
export function toolLabel(toolName: string, args: unknown): string {
  const preview = previewArgs(args);
  return preview ? `${toolName} · ${preview}` : toolName;
}
