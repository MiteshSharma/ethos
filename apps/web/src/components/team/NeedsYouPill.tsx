import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { kanbanKeys } from '../../features/kanban/api/keys';
import { needsYou } from '../../lib/teamPresence';
import { buildTeamPath } from '../../lib/workspaceRoutes';
import { rpc } from '../../rpc';

// The breadcrumb's "Needs you" pill (plan/phases/teams-as-a-scope.md D11,
// T4): counts the team's `needs_revision` + `blocked` tickets and opens the
// Board on the first one. Shares the board query key with the panes, so a
// pane's SSE-driven invalidation refreshes the count too; the 5s interval
// covers the panes that don't read the board (Memory, Settings, …). A plain
// `useQuery` rather than `useKanbanBoard` so the chrome never opens a second
// SSE stream beside the pane's. Hidden at zero.

export function NeedsYouPill({ teamId }: { teamId: string }) {
  const boardQuery = useQuery({
    queryKey: kanbanKeys.board(teamId),
    queryFn: () => rpc.kanban.getBoard({ team: teamId }),
    refetchInterval: 5_000,
    enabled: teamId.length > 0,
  });
  const pending = needsYou(boardQuery.data?.board.tasks ?? []);
  const first = pending[0];
  if (!first) return null;
  const n = pending.length;
  return (
    <Link
      to={`${buildTeamPath(teamId, 'board')}?task=${encodeURIComponent(first.id)}`}
      className="team-needs-pill"
      title="Tickets waiting on you — open the first"
    >
      {n} {n === 1 ? 'needs' : 'need'} you
    </Link>
  );
}
