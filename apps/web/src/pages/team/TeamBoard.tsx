import type { KanbanTask, KanbanTaskStatus } from '@ethosagent/web-contracts';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Spin } from 'antd';
import { useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  ARCHIVED_STATUS,
  BoardColumn,
  BulkActionBar,
  buildChildCounts,
  STATUS_COLUMNS,
  TaskDrawer,
  taskReasons,
} from '../../components/kanban/KanbanBoard';
import { NewTaskModal } from '../../components/kanban/NewTaskModal';
import { TaskActions } from '../../components/team/TaskActions';
import { useKanbanBoard } from '../../features/kanban/api/queries';
import { useTeam } from '../../features/teams/api/queries';
import { boardCounts, humanDuration } from '../../lib/teamPresence';
import { rpc } from '../../rpc';

// The team's board (plan/phases/teams-as-a-scope.md §5): the Control Center's
// working parts — status columns, select mode + bulk bar, the task drawer —
// without its toggled Activity/Roster panes. Columns fill the width; the
// drawer opens as a 320px side column, and the selected task lives in the
// URL (`?task=<id>`) so the ledger, the Needs-you pill and the member sheet
// can deep-link into it. Operator actions by state (D11) come through the
// drawer's `actions` slot — `TaskActions`, fed the manifest members for its
// Reassign picker.

export function TeamBoard() {
  const { teamId = '' } = useParams<{ teamId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedTaskId = searchParams.get('task');

  const teamQuery = useTeam(teamId);
  const boardQuery = useKanbanBoard(teamId);

  const [showArchived, setShowArchived] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const agentsQuery = useQuery({
    queryKey: ['kanban', 'agents', teamId],
    queryFn: () => rpc.kanban.listAgents({ team: teamId }),
    enabled: teamId.length > 0 && selected.size > 0,
  });

  const board = boardQuery.data?.board ?? null;
  const byStatus = useMemo(() => {
    const map = new Map<KanbanTaskStatus, KanbanTask[]>();
    for (const status of [...STATUS_COLUMNS, ARCHIVED_STATUS]) map.set(status, []);
    for (const t of board?.tasks ?? []) {
      map.get(t.status)?.push(t);
    }
    return map;
  }, [board]);
  const childCounts = useMemo(() => (board ? buildChildCounts(board) : new Map()), [board]);
  const reasons = useMemo(() => taskReasons(board?.recentEvents ?? []), [board]);

  const selectTask = (id: string | null) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set('task', id);
        else next.delete('task');
        return next;
      },
      { replace: true },
    );
  const onSelectModeChange = (next: boolean) => {
    setSelectMode(next);
    if (!next) setSelected(new Set());
  };
  const onToggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (boardQuery.isLoading) {
    return (
      <div className="team-body team-body-center">
        <Spin />
      </div>
    );
  }
  if (boardQuery.error) {
    return (
      <div className="team-body">
        <Alert type="error" message={boardQuery.error.message} />
      </div>
    );
  }
  if (!board) return null;

  const counts = boardCounts(board.tasks);
  const staleMs = teamQuery.data?.kanban.staleMs ?? null;
  const columns = showArchived ? [...STATUS_COLUMNS, ARCHIVED_STATUS] : STATUS_COLUMNS;
  const selectedTask = selectedTaskId
    ? (board.tasks.find((t) => t.id === selectedTaskId) ?? null)
    : null;

  return (
    <div className="team-body">
      <div className={`team-split${selectedTask ? ' team-split-open' : ''}`}>
        <div className="team-board">
          <div className="team-sec">
            Board
            <span className="team-sec-cnt">
              {counts.open} open
              {staleMs !== null && ` · stale after ${humanDuration(staleMs)}`}
            </span>
            <span className="team-sec-actions">
              <Button
                size="small"
                type={selectMode ? 'primary' : 'default'}
                onClick={() => onSelectModeChange(!selectMode)}
              >
                {selectMode ? 'Done selecting' : 'Select'}
              </Button>
              <Button
                size="small"
                type={showArchived ? 'primary' : 'default'}
                onClick={() => setShowArchived((v) => !v)}
              >
                {showArchived ? 'Hide archived' : 'Archived'}
              </Button>
              <Button size="small" onClick={() => setShowCreate(true)}>
                + New task
              </Button>
            </span>
          </div>
          <div
            className="team-cols"
            style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
          >
            {columns.map((status) => (
              <BoardColumn
                key={status}
                status={status}
                tasks={byStatus.get(status) ?? []}
                childCounts={childCounts}
                reasons={reasons}
                teamName={teamId}
                onSelect={selectTask}
                selectMode={selectMode}
                selected={selected}
                onToggleSelect={onToggleSelect}
                headerVariant="plain"
              />
            ))}
          </div>
          {selected.size > 0 && (
            <BulkActionBar
              selectedIds={Array.from(selected)}
              teamName={teamId}
              agents={agentsQuery.data?.agents ?? []}
              onDone={() => setSelected(new Set())}
            />
          )}
        </div>
        <TaskDrawer
          presentation="inline"
          task={selectedTask}
          board={board}
          teamName={teamId}
          onClose={() => selectTask(null)}
          actions={
            selectedTask ? (
              <TaskActions
                task={selectedTask}
                team={teamId}
                members={teamQuery.data?.members ?? []}
              />
            ) : undefined
          }
        />
      </div>
      <NewTaskModal open={showCreate} teamName={teamId} onClose={() => setShowCreate(false)} />
    </div>
  );
}
