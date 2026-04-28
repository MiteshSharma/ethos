import type { SseEvent } from '@ethosagent/web-contracts';

// Pure event reducer for the right-side activity drawer. Lives outside
// the hook so it's unit-testable without jsdom — same pattern as
// chat-reducer.ts. The hook (`useDrawerStream`) wires this into a real
// SSE subscription and exposes the state to React.

export interface ToolStreamEntry {
  toolCallId: string;
  toolName: string;
  startedAt: number;
  status: 'running' | 'ok' | 'error';
  durationMs?: number;
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
  toolStream: ToolStreamEntry[];
  notifications: DrawerNotification[];
  usage: UsageState | null;
}

export const TOOL_STREAM_CAP = 50;
export const NOTIFICATIONS_CAP = 25;

export function emptyDrawerState(sessionId: string | null = null): DrawerStreamState {
  return { sessionId, toolStream: [], notifications: [], usage: null };
}

export function applyEvent(
  prev: DrawerStreamState,
  event: SseEvent,
  now: number = Date.now(),
): DrawerStreamState {
  switch (event.type) {
    case 'tool_start': {
      const next: ToolStreamEntry = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        startedAt: now,
        status: 'running',
      };
      const stream = [next, ...prev.toolStream].slice(0, TOOL_STREAM_CAP);
      return { ...prev, toolStream: stream };
    }
    case 'tool_end': {
      const stream = prev.toolStream.map((e) =>
        e.toolCallId === event.toolCallId
          ? {
              ...e,
              status: event.ok ? ('ok' as const) : ('error' as const),
              durationMs: event.durationMs,
            }
          : e,
      );
      return { ...prev, toolStream: stream };
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

function pushNotification(prev: DrawerStreamState, n: DrawerNotification): DrawerStreamState {
  // Dedupe by id — the same cron firing replayed via Last-Event-ID
  // shouldn't surface twice.
  if (prev.notifications.some((x) => x.id === n.id)) return prev;
  const next = [n, ...prev.notifications].slice(0, NOTIFICATIONS_CAP);
  return { ...prev, notifications: next };
}
