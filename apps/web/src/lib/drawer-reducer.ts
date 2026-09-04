import type { SseEvent } from '@ethosagent/web-contracts';
import { applyTrailEvent, closeTrail, type TrailState } from './trail';

// Pure event reducer for the right-side activity drawer. Lives outside
// the hook so it's unit-testable without jsdom — same pattern as
// chat-reducer.ts. The hook (`useDrawerStream`) wires this into a real
// SSE subscription and exposes the state to React.
//
// "One trail, two renderers" (feedback & activity contract §4): the drawer
// holds the SAME `TrailState` the chat footer holds, derived from its OWN SSE
// subscription by the SAME transition (`applyTrailEvent` in `lib/trail.ts`).
// One derivation, two independent consumers — the drawer cannot reach into chat
// state, because it is subscribed on its own and may be looking at a session
// chat is not. Sharing only the types was not enough: each surface used to
// hand-roll its own transition, and they had already drifted.

export interface DrawerTurn {
  /**
   * Local turn id. The SSE stream carries no server turn identity, so the
   * drawer mints `turn-<ordinal>` — unique within a session, and stable for
   * the row ids `trailRowId` derives from it.
   */
  turnId: string;
  startedAt: number;
  /** 1-based, monotonic across the session; unaffected by cap eviction. */
  ordinal: number;
  /** The turn ended (`done`, `error`, or a Stop) — no further tool calls join it. */
  closed: boolean;
  /**
   * How many of this turn's oldest entries the per-turn cap dropped. Rendered,
   * never silent: the drawer is an audit line, and an audit line that quietly
   * loses rows is worse than one that says it lost them (contract §3, §7).
   */
  droppedEntries: number;
}

export interface DrawerNotification {
  id: string;
  kind: 'cron.fired' | 'mesh.changed' | 'evolve.skill_pending';
  receivedAt: number;
  /** Pre-formatted summary line ready for render. */
  summary: string;
  /** Where clicking the notification should land the user. */
  deepLink: string;
}

export interface UsageState {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface DrawerStreamState {
  /** Session the drawer is bound to. Null when no session is active yet. */
  sessionId: string | null;
  /** Turn boundaries, newest first. Entries live in `trail`, keyed by turnId. */
  turns: DrawerTurn[];
  /** turnId -> entries. The same structure the chat footer renders. */
  trail: TrailState;
  notifications: DrawerNotification[];
  usage: UsageState | null;
}

export const TURNS_CAP = 20;
export const NOTIFICATIONS_CAP = 25;
/**
 * Per-turn entry cap. `TURNS_CAP` alone bounds nothing: one long agentic turn
 * can make hundreds of tool calls, and each entry now retains its result.
 */
export const ENTRIES_PER_TURN_CAP = 50;
/** Longest retained `result` per entry — the drawer shows a preview, not a file. */
export const RESULT_CHARS_CAP = 2_000;

export function emptyDrawerState(sessionId: string | null = null): DrawerStreamState {
  return { sessionId, turns: [], trail: {}, notifications: [], usage: null };
}

export function applyEvent(
  prev: DrawerStreamState,
  event: SseEvent,
  now: number = Date.now(),
): DrawerStreamState {
  switch (event.type) {
    case 'run_start': {
      return openTurn(prev, now).state;
    }
    case 'done':
    case 'error': {
      const open = openTurnOf(prev);
      if (!open) return prev;
      const turns = [{ ...open, closed: true }, ...prev.turns.slice(1)];
      // `error` ends a turn WITHOUT finishing it, so its unfinished rows settle
      // as failed — the same `closeTrail` the chat reducer's `error` path takes
      // (`closeTurn` → `closeTrail(…, 'errored')`). Marking the turn closed and
      // leaving the rows alone left the drawer showing `running` for a call the
      // footer already called `failed`: two renderers of one trail disagreeing
      // about the same tool call, which is exactly what contract §4 forbids.
      //
      // `done` deliberately does NOT settle rows, for two reasons. The chat
      // reducer's `done` (`finaliseTurn`) does not either, and inventing a
      // divergence here to close an honesty gap would trade this bug for its
      // mirror image. And on this stream a `tool_end` legitimately arrives
      // AFTER `done` — `updateTrailActionAnywhere` exists for that case — so a
      // row still `running` at `done` is not yet evidence the call never
      // reported back. If that gap is worth closing, both reducers have to
      // close it in the same commit.
      const trail =
        event.type === 'error' ? closeTrail(prev.trail, open.turnId, 'errored') : prev.trail;
      return { ...prev, turns, trail };
    }
    case 'tool_start':
    case 'tool_end':
    case 'tool_progress':
    case 'tool.approval_required': {
      // `tool_end` resolves its call wherever it lives — including in a turn
      // that has already closed — so it never opens one. The other three join
      // the open turn, minting one when a reconnect delivered them before any
      // `run_start` rather than dropping the call on the floor.
      const open = openTurnOf(prev);
      const opened = open || event.type === 'tool_end' ? null : openTurn(prev, now);
      const state = opened?.state ?? prev;
      const turnId = opened?.turn.turnId ?? open?.turnId ?? '';
      const trail = applyTrailEvent(state.trail, turnId, event, RESULT_CHARS_CAP);
      // Nothing written means the audience gate dropped it, it was status text
      // rather than a row, or no such call ever started here — so no turn is
      // minted for it either.
      if (trail === null || trail === state.trail) return prev;
      const entries = trail[turnId] ?? [];
      const over = entries.length - ENTRIES_PER_TURN_CAP;
      if (over <= 0) return { ...state, trail };
      // Oldest entries first out, and the turn counts what it lost.
      return {
        ...state,
        trail: { ...trail, [turnId]: entries.slice(over) },
        turns: state.turns.map((t) =>
          t.turnId === turnId ? { ...t, droppedEntries: t.droppedEntries + over } : t,
        ),
      };
    }
    case 'usage': {
      return {
        ...prev,
        usage: {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          estimatedCostUsd: event.estimatedCostUsd,
        },
      };
    }
    case 'cron.fired': {
      return pushNotification(prev, {
        id: `cron:${event.jobId}:${event.ranAt}`,
        kind: 'cron.fired',
        receivedAt: now,
        summary: `Cron job ${event.jobId} fired`,
        deepLink: '/cron',
      });
    }
    case 'mesh.changed': {
      return pushNotification(prev, {
        // mesh.changed has no natural id — use a coarse timestamp bucket
        // so two events in the same second collapse instead of stacking.
        id: `mesh:${Math.floor(now / 1000)}`,
        kind: 'mesh.changed',
        receivedAt: now,
        summary: `Mesh agents updated (${event.agents.length} active)`,
        deepLink: '/mesh',
      });
    }
    case 'evolve.skill_pending': {
      return pushNotification(prev, {
        id: `skill:${event.skillId}:${event.proposedAt}`,
        kind: 'evolve.skill_pending',
        receivedAt: now,
        summary: `Evolved skill pending review: ${event.skillId}`,
        deepLink: '/skills',
      });
    }
    default:
      return prev;
  }
}

/**
 * The user pressed Stop. Not an SSE event: an abort is a local decision in the
 * chat hook, so the drawer's own subscription never hears it — it would keep
 * drawing `running` rows under a footer already reading `✗ stopped · N actions`
 * (contract §4). `useChat` broadcasts `ethos:turn-aborted` and `useDrawerStream`
 * lands it here, taking the chat reducer's `stopTurn` transition on the trail.
 *
 * `sessionId` is the guard, not a formality: the drawer follows the ACTIVE
 * session, which may not be the one the abort happened on, and settling a
 * bystander session's live rows would be a fresh lie of the same kind.
 */
export function applyTurnAborted(prev: DrawerStreamState, sessionId: string): DrawerStreamState {
  if (prev.sessionId !== sessionId) return prev;
  const open = openTurnOf(prev);
  if (!open) return prev;
  return {
    ...prev,
    turns: [{ ...open, closed: true }, ...prev.turns.slice(1)],
    trail: closeTrail(prev.trail, open.turnId, 'stopped'),
  };
}

/** The turn tool calls currently join, if one is open. */
function openTurnOf(state: DrawerStreamState): DrawerTurn | undefined {
  const newest = state.turns[0];
  return newest && !newest.closed ? newest : undefined;
}

function openTurn(
  prev: DrawerStreamState,
  now: number,
): { state: DrawerStreamState; turn: DrawerTurn } {
  // `turns[0]` is the newest, so it carries the highest ordinal — the counter
  // survives eviction without a separate field.
  const ordinal = (prev.turns[0]?.ordinal ?? 0) + 1;
  const turn: DrawerTurn = {
    turnId: `turn-${ordinal}`,
    startedAt: now,
    ordinal,
    closed: false,
    droppedEntries: 0,
  };
  const turns = [turn, ...prev.turns].slice(0, TURNS_CAP);
  const trail = turns.length === prev.turns.length + 1 ? prev.trail : pruneTrail(prev.trail, turns);
  return { state: { ...prev, turns, trail }, turn };
}

/**
 * Drop the entries of evicted turns. Rebuilt oldest-first because
 * `updateTrailActionAnywhere` reads insertion order as chronological.
 */
function pruneTrail(trail: TrailState, turns: DrawerTurn[]): TrailState {
  const next: TrailState = {};
  for (let i = turns.length - 1; i >= 0; i--) {
    const turnId = turns[i]?.turnId;
    if (turnId === undefined) continue;
    const entries = trail[turnId];
    if (entries) next[turnId] = entries;
  }
  return next;
}

function pushNotification(prev: DrawerStreamState, n: DrawerNotification): DrawerStreamState {
  // Dedupe by id — the same cron firing replayed via Last-Event-ID
  // shouldn't surface twice.
  if (prev.notifications.some((x) => x.id === n.id)) return prev;
  const next = [n, ...prev.notifications].slice(0, NOTIFICATIONS_CAP);
  return { ...prev, notifications: next };
}
