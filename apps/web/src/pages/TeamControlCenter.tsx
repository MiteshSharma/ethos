import { useQuery } from '@tanstack/react-query';
import { Button, Spin, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Activity, Board, Roster, TaskDrawer } from '../components/kanban/KanbanBoard';
import { useKanbanBoardSync } from '../hooks/useKanbanBoardSync';
import { rpc } from '../rpc';

// Per-team Control Center.
//
// Three panes (Board · Activity · Roster) with strict overflow containment so
// columns never bleed into neighboring sections. Status is rendered as a
// semantic chip — colored by meaning, not by personality — and changed via a
// dropdown menu next to it. Click a task tile → drawer with full detail.
//
// All chrome rides on DESIGN.md surface tokens (`--ethos-*` CSS vars) and the
// 8px base unit. The task tile is the third Card-primitive exemption per the
// Decisions log; everything else is raw layout. Heavy lifting (overflow,
// scroll containment, hover states, status colors) lives in styles.css under
// the `.cc-*` namespace.

export function TeamControlCenter() {
  const { name = '' } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [showRoster, setShowRoster] = useState(false);

  useKanbanBoardSync(name.length > 0 ? name : null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['kanban', 'board', name],
    queryFn: () => rpc.kanban.getBoard({ team: name }),
    enabled: name.length > 0,
  });

  if (isLoading) {
    return (
      <div className="cc-page">
        <div style={{ display: 'grid', placeItems: 'center', flex: 1 }}>
          <Spin />
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="cc-page">
        <Typography.Text type="danger">
          Failed to load board: {(error as Error).message}
        </Typography.Text>
      </div>
    );
  }
  if (!data) return <div className="cc-page" />;

  const board = data.board;
  const selectedTask = selectedTaskId ? board.tasks.find((t) => t.id === selectedTaskId) : null;

  return (
    <div className="cc-page">
      <header className="cc-header">
        <Button onClick={() => navigate('/teams')} type="text" size="small">
          ← Teams
        </Button>
        <h2 className="cc-title">{board.team.name}</h2>
        <span className="cc-status-chip cc-status-ready">{board.team.dispatchMode}</span>
        <span className="cc-spacer" />
        <Button
          size="small"
          type={showArchived ? 'primary' : 'default'}
          onClick={() => setShowArchived((v) => !v)}
        >
          {showArchived ? 'Hide archived' : 'Show archived'}
        </Button>
        <Button
          size="small"
          type={showActivity ? 'primary' : 'default'}
          onClick={() => setShowActivity((v) => !v)}
        >
          {showActivity ? 'Hide activity' : 'Show activity'}
        </Button>
        <Button
          size="small"
          type={showRoster ? 'primary' : 'default'}
          onClick={() => setShowRoster((v) => !v)}
        >
          {showRoster ? 'Hide roster' : 'Show roster'}
        </Button>
        <Button size="small" onClick={() => void refetch()} loading={isFetching}>
          Refresh
        </Button>
      </header>

      <div
        className={[
          'cc-grid',
          !showActivity && 'cc-grid--no-activity',
          !showRoster && 'cc-grid--no-roster',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <Board
          snapshot={board}
          teamName={name}
          showArchived={showArchived}
          onSelect={setSelectedTaskId}
        />
        {showActivity && (
          <Activity events={board.recentEvents} tasks={board.tasks} onSelect={setSelectedTaskId} />
        )}
        {showRoster && <Roster snapshot={board} />}
      </div>

      <TaskDrawer
        task={selectedTask ?? null}
        board={board}
        teamName={name}
        onClose={() => setSelectedTaskId(null)}
      />
    </div>
  );
}
