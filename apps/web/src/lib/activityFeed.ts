import type { ActivityHistoryItemWire, SseEvent } from '@ethosagent/web-contracts';
import { ACTIVITY_EVENT_TYPES } from '@ethosagent/web-contracts';

// Pure logic behind `pages/Activity.tsx` — the feed has two sources with two
// different shapes (durable rows from `activity.history`, live envelopes from
// `/sse/activity`) and they have to land in ONE list without double-rendering
// the same tool call. Keeping the conversion, the merge and the grouping here
// means all of that is unit-testable without a renderer, the same split
// `scopeNav.ts` / `chat-reducer.ts` already use.

/**
 * The row's visual family. These are exactly the dot modifiers the stylesheet
 * ships (`.activity-event-dot--*`) — a new event type picks one of them rather
 * than inventing a colour, so the feed's vocabulary stays fixed as coverage
 * grows. `notice` is the neutral one: something happened, it carries no
 * success/failure state of its own.
 */
export type ActivityKind =
  | 'tool_start'
  | 'tool_end'
  | 'done'
  | 'error'
  | 'approval'
  | 'cron'
  | 'notice';

/**
 * How a row participates in conversation grouping.
 *   open       — starts a turn for its session (a durable `turn` trace, `run_start`)
 *   close      — finishes one (`done`)
 *   item       — belongs to whichever turn is open for its session
 *   standalone — never belongs to a turn (cron firings, mesh changes, untraced events)
 */
export type ActivityRole = 'open' | 'close' | 'item' | 'standalone';

/** One key/value line in a row's expanded detail block. */
export type ActivityDetail =
  | { key: string; kind: 'text'; value: string }
  | { key: string; kind: 'args'; args: unknown }
  | { key: string; kind: 'pre'; text: string };

export interface ActivityRow {
  /**
   * Dedupe identity. A durable `tool_call` span and the live
   * `tool_start`/`tool_end` events for the SAME call all produce
   * `tool:<sessionId>:<toolCallId>`, so the merge collapses them to one row —
   * that link exists because `tool-processing.ts` writes `tool_call_id` into
   * the span's `attrs`, which `getRecentActivity` surfaces as `details`.
   * Everything else keys on something already unique to the event.
   */
  key: string;
  kind: ActivityKind;
  /** Wire type / span kind, shown verbatim in the row's tag. */
  label: string;
  summary: string;
  sessionId: string | null;
  personalityId: string | null;
  timestamp: number;
  /** Set once the thing the row describes has finished. Drives merge rank. */
  endedAt: number | null;
  role: ActivityRole;
  turnCount: number | null;
  /** True for rows off the live stream — a group is only "live" if it has one. */
  live: boolean;
  details: ActivityDetail[];
}

export interface ActivityGroup {
  id: string;
  sessionId: string | null;
  startedAt: number;
  completedAt: number | null;
  turnCount: number | null;
  rows: ActivityRow[];
  isLive: boolean;
}

export type ActivityTypeFilter = 'all' | 'tools' | 'turns' | 'errors' | 'approvals' | 'cron';

/** Groups kept in the merged list. Comfortably above one `activity.history`
 *  page so "load older" actually grows the timeline. */
export const MAX_GROUPS = 200;

const CALL_LABELS = new Set(['tool_start', 'tool_end', 'tool_progress', 'llm_call']);
const TURN_LABELS = new Set(['done', 'turn', 'run_start']);

// ---------------------------------------------------------------------------
// Live stream → row
// ---------------------------------------------------------------------------

export interface LiveRowContext {
  sessionId: string;
  personalityId: string | null;
  /** Activity-buffer seq — unique per frame, so it stands in as an id for the
   *  events that carry none of their own. */
  seq: number;
  timestamp: number;
}

/**
 * Map one live `SseEvent` onto a feed row, or `null` for the types that are
 * plumbing rather than a discrete action.
 *
 * WHICH types those are is not decided here — it is `ACTIVITY_EVENT_TYPES` in
 * `@ethosagent/web-contracts`, the same allowlist `ChatService.append` filters
 * the server-side fan-out with. Both ends read the one set so they cannot
 * drift; this function only decides what an admitted event LOOKS like.
 */
export function convertSseEvent(event: SseEvent, ctx: LiveRowContext): ActivityRow | null {
  if (!ACTIVITY_EVENT_TYPES.has(event.type)) return null;

  const base = {
    sessionId: ctx.sessionId,
    personalityId: ctx.personalityId,
    timestamp: ctx.timestamp,
    endedAt: null as number | null,
    role: 'item' as ActivityRole,
    turnCount: null as number | null,
    live: true,
  };

  switch (event.type) {
    case 'tool_start':
      return {
        ...base,
        key: toolKey(ctx.sessionId, event.toolCallId),
        kind: 'tool_start',
        label: 'tool_start',
        summary: `Tool started: ${event.toolName}`,
        details: [
          { key: 'tool', kind: 'text', value: event.toolName },
          ...(event.args === undefined
            ? []
            : ([{ key: 'args', kind: 'args', args: event.args }] as ActivityDetail[])),
        ],
      };

    case 'tool_end':
      return {
        ...base,
        key: toolKey(ctx.sessionId, event.toolCallId),
        kind: event.ok ? 'tool_end' : 'error',
        label: 'tool_end',
        endedAt: ctx.timestamp,
        summary: `Tool ${event.ok ? 'completed' : 'failed'}: ${event.toolName} (${event.durationMs}ms)`,
        details: [
          { key: 'tool', kind: 'text', value: event.toolName },
          { key: 'status', kind: 'text', value: event.ok ? '✓ ok' : '✗ failed' },
          { key: 'duration', kind: 'text', value: `${event.durationMs}ms` },
          ...(event.result === undefined
            ? []
            : ([{ key: 'result', kind: 'pre', text: event.result }] as ActivityDetail[])),
        ],
      };

    case 'tool_progress':
      return {
        ...base,
        key: `progress:${ctx.sessionId}:${ctx.seq}`,
        kind: 'tool_start',
        label: 'tool_progress',
        summary: `${event.toolName}: ${event.message}`,
        details: [
          { key: 'tool', kind: 'text', value: event.toolName },
          { key: 'message', kind: 'text', value: event.message },
          ...(event.percent === undefined
            ? []
            : ([{ key: 'percent', kind: 'text', value: `${event.percent}%` }] as ActivityDetail[])),
        ],
      };

    case 'done':
      return {
        ...base,
        key: `done:${ctx.sessionId}:${ctx.seq}`,
        kind: 'done',
        label: 'done',
        role: 'close',
        endedAt: ctx.timestamp,
        turnCount: event.turnCount,
        summary: `Turn ${event.turnCount} completed`,
        details: [
          { key: 'turns', kind: 'text', value: String(event.turnCount) },
          ...(event.traceId === undefined
            ? []
            : ([{ key: 'trace', kind: 'text', value: event.traceId }] as ActivityDetail[])),
        ],
      };

    case 'error':
      return {
        ...base,
        key: `error:${ctx.sessionId}:${ctx.seq}`,
        kind: 'error',
        label: 'error',
        summary: `Error: ${event.error}`,
        details: [
          { key: 'error', kind: 'text', value: event.error },
          { key: 'code', kind: 'text', value: event.code },
        ],
      };

    case 'run_start':
      return {
        ...base,
        key: `run_start:${ctx.sessionId}:${event.traceId ?? ctx.seq}`,
        kind: 'notice',
        label: 'run_start',
        role: 'open',
        summary: `Turn started · ${event.provider}/${event.model}`,
        details: [
          { key: 'provider', kind: 'text', value: event.provider },
          { key: 'model', kind: 'text', value: event.model },
          { key: 'source', kind: 'text', value: event.source },
          ...(event.traceId === undefined
            ? []
            : ([{ key: 'trace', kind: 'text', value: event.traceId }] as ActivityDetail[])),
        ],
      };

    case 'run.update':
      // The digest is REPLACED, never appended (RunUpdateEventSchema) — so
      // every update for a job collapses onto one row rather than stacking.
      return {
        ...base,
        key: `run:${event.jobId}`,
        kind: runKind(event.status),
        label: 'run.update',
        endedAt: isTerminalRunStatus(event.status) ? ctx.timestamp : null,
        summary: `Run ${event.jobId} · ${event.status} — ${event.now}`,
        details: [
          { key: 'runner', kind: 'text', value: event.runner },
          { key: 'status', kind: 'text', value: event.status },
          { key: 'now', kind: 'text', value: event.now },
          { key: 'elapsed', kind: 'text', value: `${event.elapsedMs}ms` },
          { key: 'spend', kind: 'text', value: `$${event.spendUsd.toFixed(4)}` },
          { key: 'tools', kind: 'text', value: String(event.toolCount) },
        ],
      };

    case 'tool.approval_required':
      return {
        ...base,
        key: `approval:${event.request.approvalId}`,
        kind: 'approval',
        label: 'tool.approval_required',
        summary: `Approval needed: ${event.request.toolName}`,
        details: [
          { key: 'tool', kind: 'text', value: event.request.toolName },
          ...(event.request.reason === null
            ? []
            : ([{ key: 'reason', kind: 'text', value: event.request.reason }] as ActivityDetail[])),
          ...(event.request.args === undefined
            ? []
            : ([{ key: 'args', kind: 'args', args: event.request.args }] as ActivityDetail[])),
        ],
      };

    case 'approval.resolved':
      return {
        ...base,
        key: `approval-resolved:${event.approvalId}`,
        kind: 'approval',
        label: 'approval.resolved',
        endedAt: ctx.timestamp,
        summary: `Approval ${event.decision === 'allow' ? 'allowed' : 'denied'}`,
        details: [
          { key: 'approval', kind: 'text', value: event.approvalId },
          { key: 'decision', kind: 'text', value: event.decision },
          { key: 'decided by', kind: 'text', value: event.decidedBy },
        ],
      };

    case 'cron.fired':
      return {
        ...base,
        key: `cron:${event.jobId}:${event.ranAt}`,
        kind: 'cron',
        label: 'cron.fired',
        role: 'standalone',
        summary: `Cron job fired: ${event.jobId}`,
        details: [
          { key: 'job', kind: 'text', value: event.jobId },
          { key: 'ran at', kind: 'text', value: event.ranAt },
          ...(event.outputPath === null
            ? []
            : ([{ key: 'output', kind: 'text', value: event.outputPath }] as ActivityDetail[])),
        ],
      };

    case 'clarify.request':
      return {
        ...base,
        key: `clarify:${event.requestId}`,
        kind: 'approval',
        label: 'clarify.request',
        summary: `Question asked: ${event.question}`,
        details: [
          { key: 'question', kind: 'text', value: event.question },
          ...(event.options === undefined
            ? []
            : ([
                { key: 'options', kind: 'text', value: event.options.join(', ') },
              ] as ActivityDetail[])),
          ...(event.default === undefined
            ? []
            : ([{ key: 'default', kind: 'text', value: event.default }] as ActivityDetail[])),
          ...(event.jobId === undefined
            ? []
            : ([{ key: 'run', kind: 'text', value: event.jobId }] as ActivityDetail[])),
        ],
      };

    case 'clarify.resolved':
      return {
        ...base,
        key: `clarify-resolved:${event.requestId}`,
        kind: 'approval',
        label: 'clarify.resolved',
        endedAt: ctx.timestamp,
        summary: `Question resolved (${event.source})`,
        details: [
          { key: 'question', kind: 'text', value: event.requestId },
          { key: 'source', kind: 'text', value: event.source },
        ],
      };

    case 'mesh.changed':
      return {
        ...base,
        key: `mesh:${ctx.seq}`,
        kind: 'notice',
        label: 'mesh.changed',
        role: 'standalone',
        summary: `Mesh changed: ${event.agents.length} agent${event.agents.length === 1 ? '' : 's'}`,
        details: [{ key: 'agents', kind: 'args', args: event.agents }],
      };

    case 'evolve.skill_pending':
      return {
        ...base,
        key: `evolve-pending:${event.skillId}:${event.proposedAt}`,
        kind: 'approval',
        label: 'evolve.skill_pending',
        role: 'standalone',
        summary: `Skill awaiting review: ${event.skillId}`,
        details: [
          { key: 'skill', kind: 'text', value: event.skillId },
          { key: 'personality', kind: 'text', value: event.personalityId ?? '—' },
          { key: 'proposed at', kind: 'text', value: event.proposedAt },
        ],
      };

    case 'evolve.skill_applied':
      return {
        ...base,
        key: `evolve-applied:${event.skillId}:${event.appliedAt}`,
        kind: 'done',
        label: 'evolve.skill_applied',
        role: 'standalone',
        summary: `Skill applied: ${event.skillId}`,
        details: [
          { key: 'skill', kind: 'text', value: event.skillId },
          { key: 'personality', kind: 'text', value: event.personalityId ?? '—' },
          { key: 'applied at', kind: 'text', value: event.appliedAt },
        ],
      };

    case 'notification':
      return {
        ...base,
        key: `notification:${ctx.sessionId}:${ctx.seq}`,
        kind: 'notice',
        label: 'notification',
        summary: event.message,
        details: [
          { key: 'message', kind: 'text', value: event.message },
          ...(event.source === undefined
            ? []
            : ([{ key: 'source', kind: 'text', value: event.source }] as ActivityDetail[])),
        ],
      };

    case 'memory.captured':
      return {
        ...base,
        key: `memory:${ctx.sessionId}:${ctx.seq}`,
        kind: 'notice',
        label: 'memory.captured',
        summary: `Remembered: ${event.summary}`,
        details: [{ key: 'summary', kind: 'text', value: event.summary }],
      };

    case 'dry_run_summary':
      return {
        ...base,
        key: `dry_run:${ctx.sessionId}:${ctx.seq}`,
        kind: 'notice',
        label: 'dry_run_summary',
        summary: `Dry run: ${event.plan.length} tool call${event.plan.length === 1 ? '' : 's'} planned`,
        details: [
          { key: 'planned', kind: 'text', value: String(event.plan.length) },
          { key: 'capped', kind: 'text', value: String(event.capped) },
          { key: 'plan', kind: 'args', args: event.plan },
        ],
      };

    case 'message_persisted':
      return {
        ...base,
        key: `message:${event.messageId}`,
        kind: 'notice',
        label: 'message_persisted',
        summary: `Message saved (${event.role})`,
        details: [
          { key: 'message', kind: 'text', value: event.messageId },
          { key: 'role', kind: 'text', value: event.role },
        ],
      };

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Durable history → row
// ---------------------------------------------------------------------------

/** Map one `activity.history` row onto the same feed row the live stream produces. */
export function convertHistoryItem(item: ActivityHistoryItemWire): ActivityRow {
  const base = {
    sessionId: item.sessionId,
    personalityId: item.personalityId,
    timestamp: item.startedAt,
    endedAt: item.endedAt,
    turnCount: null as number | null,
    live: false,
  };
  const closed = item.endedAt !== null;
  const failed = item.status === 'error' || item.status === 'blocked';
  const durationMs = readNumber(item.details, 'durationMs') ?? spanDuration(item);

  if (item.kind === 'tool_call' || item.kind === 'llm_call') {
    const isTool = item.kind === 'tool_call';
    const toolCallId = readString(item.details, 'tool_call_id');
    const noun = isTool ? 'Tool' : 'Model call';
    return {
      ...base,
      key: isTool && toolCallId ? toolKey(item.sessionId, toolCallId) : `span:${item.id}`,
      kind: closed ? (failed ? 'error' : 'tool_end') : 'tool_start',
      label: isTool ? (closed ? 'tool_end' : 'tool_start') : 'llm_call',
      role: 'item',
      summary: closed
        ? `${noun} ${failed ? 'failed' : 'completed'}: ${item.name}${durationMs === null ? '' : ` (${durationMs}ms)`}`
        : `${noun} started: ${item.name}`,
      details: [
        { key: isTool ? 'tool' : 'model', kind: 'text', value: item.name },
        ...(item.status === null
          ? []
          : ([{ key: 'status', kind: 'text', value: item.status }] as ActivityDetail[])),
        ...(durationMs === null
          ? []
          : ([{ key: 'duration', kind: 'text', value: `${durationMs}ms` }] as ActivityDetail[])),
        ...detailsBlock(item.details),
      ],
    };
  }

  if (item.kind === 'turn') {
    return {
      ...base,
      key: `turn:${item.id}`,
      kind: failed ? 'error' : 'done',
      label: 'turn',
      role: 'open',
      summary: closed ? `Turn ${failed ? 'errored' : 'completed'}` : 'Turn started',
      details: [
        ...(item.status === null
          ? []
          : ([{ key: 'status', kind: 'text', value: item.status }] as ActivityDetail[])),
        ...(durationMs === null
          ? []
          : ([{ key: 'duration', kind: 'text', value: `${durationMs}ms` }] as ActivityDetail[])),
        ...detailsBlock(item.details),
      ],
    };
  }

  // `event` — `name` is the category, `status` the severity. An event with no
  // trace has no session to belong to, so it stands alone in the global view.
  const code = readString(item.details, 'code');
  return {
    ...base,
    key: `event:${item.id}`,
    kind: eventKind(item.status),
    label: item.name,
    role: item.sessionId === null ? 'standalone' : 'item',
    summary: code ? `${item.name}: ${code}` : item.name,
    details: [
      { key: 'category', kind: 'text', value: item.name },
      ...(item.status === null
        ? []
        : ([{ key: 'severity', kind: 'text', value: item.status }] as ActivityDetail[])),
      ...detailsBlock(item.details),
    ],
  };
}

// ---------------------------------------------------------------------------
// Merge + grouping
// ---------------------------------------------------------------------------

/**
 * Fold rows into the keyed store, newest information winning.
 *
 * Rank is "has it finished": a `tool_end` (or a closed durable span) beats a
 * `tool_start` for the same key, and never the other way round, so a history
 * page that lands after the live `tool_end` cannot regress the row to
 * "started". Equal rank means the later arrival replaces (that is what makes a
 * `run.update` digest a replacement rather than a pile). The earliest known
 * timestamp is kept either way so a row never jumps position when it closes.
 */
export function mergeRows(
  existing: ReadonlyMap<string, ActivityRow>,
  incoming: readonly ActivityRow[],
): Map<string, ActivityRow> {
  const next = new Map(existing);
  for (const row of incoming) {
    const prev = next.get(row.key);
    if (prev && rank(prev) > rank(row)) continue;
    next.set(row.key, prev ? { ...row, timestamp: Math.min(prev.timestamp, row.timestamp) } : row);
  }
  return next;
}

/**
 * Fold rows into conversation groups, newest group first.
 *
 * A group is one session's turn: opened by a `turn` trace or a `run_start`,
 * joined by everything that session emits until the next opener, closed by a
 * `done`. Rows that belong to no turn (cron firings, mesh changes, untraced
 * events) each stand alone. A group counts as live only when it holds at least
 * one row that arrived on the live stream and has not been closed — a page of
 * history whose oldest turn happens to be cut off is finished, not running.
 */
export function buildGroups(
  rows: Iterable<ActivityRow>,
  maxGroups: number = MAX_GROUPS,
): ActivityGroup[] {
  const ordered = [...rows].sort((a, b) => a.timestamp - b.timestamp || compare(a.key, b.key));
  const all: ActivityGroup[] = [];
  const open = new Map<string, ActivityGroup>();

  for (const row of ordered) {
    if (row.role === 'standalone' || row.sessionId === null) {
      all.push({
        id: row.key,
        sessionId: row.sessionId,
        startedAt: row.timestamp,
        completedAt: row.endedAt ?? row.timestamp,
        turnCount: null,
        rows: [row],
        isLive: false,
      });
      continue;
    }

    const sessionId = row.sessionId;
    let group = open.get(sessionId);
    if (!group || row.role === 'open') {
      group = {
        id: `${sessionId}|${row.key}`,
        sessionId,
        startedAt: row.timestamp,
        completedAt: null,
        turnCount: null,
        rows: [],
        isLive: false,
      };
      open.set(sessionId, group);
      all.push(group);
    }
    group.rows.push(row);

    if (row.role === 'close' || (row.role === 'open' && row.endedAt !== null)) {
      group.completedAt = Math.max(group.completedAt ?? 0, row.endedAt ?? row.timestamp);
      group.turnCount = row.turnCount ?? group.turnCount;
    }
  }

  for (const group of all) {
    group.isLive = group.completedAt === null && group.rows.some((r) => r.live);
  }
  return all.sort((a, b) => b.startedAt - a.startedAt).slice(0, maxGroups);
}

/** Client-side predicate for the type-filter chips. */
export function groupMatchesFilter(group: ActivityGroup, filter: ActivityTypeFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'tools':
      return group.rows.some((r) => CALL_LABELS.has(r.label));
    case 'turns':
      return group.rows.some((r) => TURN_LABELS.has(r.label));
    case 'errors':
      return group.rows.some((r) => r.kind === 'error');
    case 'approvals':
      return group.rows.some((r) => r.kind === 'approval');
    case 'cron':
      return group.rows.some((r) => r.label === 'cron.fired');
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolKey(sessionId: string | null, toolCallId: string): string {
  return `tool:${sessionId ?? '?'}:${toolCallId}`;
}

function rank(row: ActivityRow): number {
  return row.endedAt === null ? 0 : 1;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isTerminalRunStatus(status: string): boolean {
  return status === 'done' || status === 'failed' || status === 'aborted' || status === 'expired';
}

function runKind(status: string): ActivityKind {
  if (status === 'failed' || status === 'aborted' || status === 'expired') return 'error';
  if (status === 'done') return 'done';
  if (status === 'blocked') return 'approval';
  return 'notice';
}

function eventKind(severity: string | null): ActivityKind {
  if (severity === 'error' || severity === 'critical' || severity === 'fatal') return 'error';
  if (severity === 'warn' || severity === 'warning') return 'approval';
  return 'notice';
}

function readString(details: Record<string, unknown> | null, key: string): string | null {
  const value = details?.[key];
  return typeof value === 'string' ? value : null;
}

function readNumber(details: Record<string, unknown> | null, key: string): number | null {
  const value = details?.[key];
  return typeof value === 'number' ? value : null;
}

function spanDuration(item: ActivityHistoryItemWire): number | null {
  return item.endedAt === null ? null : item.endedAt - item.startedAt;
}

/** The raw attrs bag, minus the fields already promoted to their own line. */
function detailsBlock(details: Record<string, unknown> | null): ActivityDetail[] {
  if (!details) return [];
  const rest = { ...details };
  delete rest.durationMs;
  delete rest.tool_call_id;
  delete rest.code;
  if (Object.keys(rest).length === 0) return [];
  return [{ key: 'details', kind: 'args', args: rest }];
}
