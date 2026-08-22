import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

// Trailing-edge debounce window for the board invalidate below. A burst of
// frames — a bounded cold-connect replay, or several live events arriving in
// quick succession — collapses into one refetch instead of one per frame.
const INVALIDATE_DEBOUNCE_MS = 200;

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

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    source.onmessage = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ['kanban', 'board', team] });
      }, INVALIDATE_DEBOUNCE_MS);
    };

    return () => {
      source.close();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [team, queryClient]);
}
