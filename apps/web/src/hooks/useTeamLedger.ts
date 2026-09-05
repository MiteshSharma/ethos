import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { rpc } from '../rpc';

/** The supervisor ledger for a team (plan/phases/teams-as-a-scope.md §7),
 *  newest first. The ledger is a labelling of the same `task_events` the
 *  board SSE stream announces, so instead of a second stream or a poll it
 *  re-fetches whenever the board query lands fresh data — pass the board
 *  query's `dataUpdatedAt`. */
export function useTeamLedger(teamId: string, limit: number, boardUpdatedAt: number) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (boardUpdatedAt === 0) return;
    void queryClient.invalidateQueries({ queryKey: ['teams', 'ledger', teamId] });
  }, [boardUpdatedAt, teamId, queryClient]);

  return useQuery({
    queryKey: ['teams', 'ledger', teamId, limit],
    queryFn: () => rpc.teams.ledger({ team: teamId, limit }),
    enabled: teamId.length > 0,
  });
}
