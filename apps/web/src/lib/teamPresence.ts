import type { KanbanTask, TeamMemberSummary } from '@ethosagent/web-contracts';
import { formatRelative } from '../components/kanban/KanbanBoard';

// Pure derivations behind the team Overview (plan/phases/teams-as-a-scope.md
// §4): a member's live state from the runtime status plus the board, the
// attention set, the status-strip counts, and the small formatters the panes
// share. No React, no fetching — `teamPresence.test.ts` drives every branch.

export type PresenceState = 'ok' | 'err' | 'dim';

export interface MemberPresence {
  state: PresenceState;
  /** Pulse the dot — the member is doing something right now. */
  live: boolean;
  /** The second line, e.g. `#41 <title> · 12m ago`; starts with `#<id>` when `ticketId` is set. */
  text: string;
  ticketId: string | null;
}

/** The first eight characters — what every tile, ledger row and member row calls a ticket. */
export function shortTaskId(id: string): string {
  return id.slice(0, 8);
}

/**
 * State per member = runtime member status + the board (§4). Precedence:
 * not running on the supervisor → offline (dim); a `running` ticket assigned
 * → that ticket (ok, live); a `blocked` one → blocked (err); the coordinator
 * with nothing of its own → dispatching (ok, live); else idle (ok).
 * `reasons` is `taskReasons(recentEvents)` — the block reason, when known.
 */
export function memberPresence(
  member: TeamMemberSummary,
  tasks: KanbanTask[],
  coordinator: string | null,
  reasons?: Map<string, string>,
): MemberPresence {
  if (member.status !== 'running') {
    const text =
      member.status === 'offline' || member.status === 'stopped'
        ? 'offline · supervisor stopped'
        : member.status;
    return { state: 'dim', live: false, text, ticketId: null };
  }
  const mine = tasks.filter((t) => t.assignee === member.personalityId);
  const running = mine.find((t) => t.status === 'running');
  if (running) {
    return {
      state: 'ok',
      live: true,
      text: `#${shortTaskId(running.id)} ${running.title} · ${formatRelative(running.updatedAt)}`,
      ticketId: running.id,
    };
  }
  const blocked = mine.find((t) => t.status === 'blocked');
  if (blocked) {
    const reason = reasons?.get(blocked.id);
    return {
      state: 'err',
      live: false,
      text: `#${shortTaskId(blocked.id)} blocked${reason ? ` · ${reason}` : ''}`,
      ticketId: blocked.id,
    };
  }
  if (coordinator !== null && member.personalityId === coordinator) {
    return { state: 'ok', live: true, text: 'dispatching', ticketId: null };
  }
  return { state: 'ok', live: false, text: 'idle · waiting for a ticket', ticketId: null };
}

/** The tickets that need an operator (D11): `needs_revision` and `blocked`. */
export function needsYou(tasks: KanbanTask[]): KanbanTask[] {
  return tasks.filter((t) => t.status === 'needs_revision' || t.status === 'blocked');
}

export interface BoardCounts {
  running: number;
  blocked: number;
  needsRevision: number;
  done: number;
  /** Everything not `done` or `archived`. */
  open: number;
}

export function boardCounts(tasks: KanbanTask[]): BoardCounts {
  const counts: BoardCounts = { running: 0, blocked: 0, needsRevision: 0, done: 0, open: 0 };
  for (const t of tasks) {
    if (t.status === 'running') counts.running += 1;
    else if (t.status === 'blocked') counts.blocked += 1;
    else if (t.status === 'needs_revision') counts.needsRevision += 1;
    else if (t.status === 'done') counts.done += 1;
    if (t.status !== 'done' && t.status !== 'archived') counts.open += 1;
  }
  return counts;
}

/** `6h 12m`, `45m`, `30s`, `3d 4h` — uptime and the stale threshold. */
export function humanDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** Local `HH:MM:SS` for feed rows (§7). Falls back to the input when unparsable. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}
