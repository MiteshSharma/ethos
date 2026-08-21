import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

/** Subscribes to `/sse/kanban/:team` and invalidates the board query on every
 *  live update, replacing `refetchInterval` polling at the call sites that
 *  render a board. `task_events` is durably persisted, so `EventSource`'s
 *  built-in reconnect (with `Last-Event-ID`) replays exactly what a dropped
 *  connection missed — no fallback poll needed. Pass `null` to stay
 *  disconnected (e.g. no team selected yet). */
export function useKanbanBoardSync(team: string | null): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!team) return;
    const base = import.meta.env.VITE_API_URL ?? '';
    const source = new EventSource(`${base}/sse/kanban/${team}`, { withCredentials: true });

    source.onmessage = () => {
      void queryClient.invalidateQueries({ queryKey: ['kanban', 'board', team] });
    };

    return () => source.close();
  }, [team, queryClient]);
}
