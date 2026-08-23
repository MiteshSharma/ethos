import { useQuery } from '@tanstack/react-query';
import { useKanbanBoardSync } from '../../../hooks/useKanbanBoardSync';
import { rpc } from '../../../rpc';
import { kanbanKeys } from './keys';

export function useKanbanList() {
  return useQuery({
    queryKey: kanbanKeys.list(),
    queryFn: () => rpc.kanban.list(),
    refetchInterval: 5_000,
  });
}

export function useKanbanBoard(team: string) {
  useKanbanBoardSync(team.length > 0 ? team : null);
  return useQuery({
    queryKey: kanbanKeys.board(team),
    queryFn: () => rpc.kanban.getBoard({ team }),
    enabled: team.length > 0,
  });
}
