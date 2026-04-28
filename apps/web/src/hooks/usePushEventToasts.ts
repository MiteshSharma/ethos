import { App as AntApp } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getLastSessionId } from '../lib/lastSession';
import { subscribeToSession } from '../sse';

// Push-event toast layer. Subscribes to the active session's SSE feed
// and fires an Antd notification for every push event the right
// drawer's notifications panel also tracks (cron.fired, mesh.changed,
// evolve.skill_pending).
//
// Lives in App.tsx so toasts fire even when the drawer is closed —
// the plan v0.5 gate criterion is "click toast → land in run history",
// which means a transient surface, not just a list panel.
//
// Two consumers + one SSE connection per session: this hook subscribes
// independently of useDrawerStream. ChatService's EventEmitter fans
// the same event to both subscribers, so the duplicate-connection cost
// is one extra HTTP keepalive per active session — acceptable for a
// single-user local app.
//
// Dedupe by event id (matches the drawer reducer's logic) so the
// browser's own Last-Event-ID replay on reconnect doesn't fire a toast
// twice for the same firing.

const SEEN_CAP = 100; // Bound the seen set so a long-running tab doesn't grow unbounded.

export function usePushEventToasts(): void {
  const { notification } = AntApp.useApp();
  const navigate = useNavigate();
  const [sessionId, setSessionId] = useState<string | null>(() => getLastSessionId());
  const seenIdsRef = useRef<string[]>([]);

  // Track the active session id, refreshed when localStorage changes
  // (cross-tab) or the chat surface dispatches the in-tab change event.
  useEffect(() => {
    const refresh = () => {
      const next = getLastSessionId();
      setSessionId((prev) => {
        if (prev === next) return prev;
        // New session → forget what we've toasted for the old one.
        seenIdsRef.current = [];
        return next;
      });
    };
    window.addEventListener('storage', refresh);
    window.addEventListener('ethos:active-session-changed', refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('ethos:active-session-changed', refresh);
    };
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    const sub = subscribeToSession(sessionId, {
      onEvent: (event) => {
        const id = pushEventId(event);
        if (!id) return;
        if (seenIdsRef.current.includes(id)) return;
        seenIdsRef.current.push(id);
        if (seenIdsRef.current.length > SEEN_CAP) {
          seenIdsRef.current = seenIdsRef.current.slice(-SEEN_CAP);
        }

        const summary = pushEventSummary(event);
        if (!summary) return;

        notification.info({
          message: summary.title,
          description: summary.description,
          placement: 'topRight',
          onClick: () => navigate(summary.deepLink),
          duration: 6,
        });
      },
    });
    return () => sub.close();
  }, [sessionId, notification, navigate]);
}

interface PushSummary {
  title: string;
  description: string;
  deepLink: string;
}

function pushEventSummary(event: import('@ethosagent/web-contracts').SseEvent): PushSummary | null {
  switch (event.type) {
    case 'cron.fired':
      return {
        title: 'Cron job fired',
        description: `${event.jobId} ran at ${formatTime(event.ranAt)}`,
        deepLink: '/cron',
      };
    case 'mesh.changed':
      return {
        title: 'Mesh updated',
        description: `${event.agents.length} agent${event.agents.length === 1 ? '' : 's'} now live`,
        deepLink: '/mesh',
      };
    case 'evolve.skill_pending':
      return {
        title: 'Evolved skill pending review',
        description: event.skillId,
        deepLink: '/skills',
      };
    default:
      return null;
  }
}

function pushEventId(event: import('@ethosagent/web-contracts').SseEvent): string | null {
  switch (event.type) {
    case 'cron.fired':
      return `cron:${event.jobId}:${event.ranAt}`;
    case 'mesh.changed':
      // Coarse bucket — multiple changes within a second collapse to one toast.
      return `mesh:${Math.floor(Date.now() / 1000)}`;
    case 'evolve.skill_pending':
      return `skill:${event.skillId}:${event.proposedAt}`;
    default:
      return null;
  }
}

function formatTime(iso: string): string {
  const ts = new Date(iso);
  if (Number.isNaN(ts.getTime())) return iso;
  return ts.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
