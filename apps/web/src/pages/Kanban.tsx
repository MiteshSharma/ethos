import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Input, Modal, Select, Typography } from 'antd';
import { useState } from 'react';
import { Board, TaskDrawer } from '../components/kanban/KanbanBoard';
import { useKanbanBoardSync } from '../hooks/useKanbanBoardSync';
import { rpc } from '../rpc';

export function Kanban() {
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const teamsQuery = useQuery({
    queryKey: ['kanban', 'list'],
    queryFn: () => rpc.kanban.list(),
  });

  const teams = teamsQuery.data?.teams ?? [];
  const activeTeam = selectedTeam ?? (teams.length === 1 ? (teams[0]?.name ?? null) : null);

  useKanbanBoardSync(activeTeam);

  const boardQuery = useQuery({
    queryKey: ['kanban', 'board', activeTeam],
    queryFn: () => rpc.kanban.getBoard({ team: activeTeam ?? '' }),
    enabled: activeTeam !== null,
  });

  const board = boardQuery.data?.board ?? null;
  const selectedTask =
    board && selectedTaskId ? (board.tasks.find((t) => t.id === selectedTaskId) ?? null) : null;

  return (
    <div className="cc-page cc-page--kanban">
      <header className="cc-header">
        <h2 className="cc-title">Kanban</h2>
        <span className="cc-spacer" />
        {teams.length > 1 && (
          <Select
            value={activeTeam}
            onChange={setSelectedTeam}
            style={{ minWidth: 160 }}
            placeholder="Select board"
            options={teams.map((t) => ({ label: t.name, value: t.name }))}
          />
        )}
        {activeTeam && (
          <>
            <Button size="small" onClick={() => setShowCreateTask(true)}>
              New task
            </Button>
            <Button
              size="small"
              type={showHelp ? 'primary' : 'default'}
              onClick={() => setShowHelp((v) => !v)}
            >
              Connect agents
            </Button>
            <Button
              size="small"
              type={showArchived ? 'primary' : 'default'}
              onClick={() => setShowArchived((v) => !v)}
            >
              {showArchived ? 'Hide archived' : 'Archived'}
            </Button>
          </>
        )}
      </header>

      {teams.length === 0 && (
        <Typography.Text type="secondary">
          No boards found. Start an agent with ethos serve to create the global board.
        </Typography.Text>
      )}

      {board && activeTeam && (
        <div
          className={
            showHelp ? 'cc-grid cc-grid--help' : 'cc-grid cc-grid--no-activity cc-grid--no-roster'
          }
        >
          <Board
            snapshot={board}
            teamName={activeTeam}
            showArchived={showArchived}
            onSelect={setSelectedTaskId}
            fill
          />
          {showHelp && <ConnectAgentsPanel teamName={activeTeam} />}
        </div>
      )}

      {board && activeTeam && (
        <TaskDrawer
          task={selectedTask}
          board={board}
          teamName={activeTeam}
          onClose={() => setSelectedTaskId(null)}
        />
      )}

      {activeTeam && (
        <Modal
          open={showCreateTask}
          onCancel={() => setShowCreateTask(false)}
          title="New task"
          footer={null}
          destroyOnClose
        >
          <CreateTaskForm teamName={activeTeam} onDone={() => setShowCreateTask(false)} />
        </Modal>
      )}
    </div>
  );
}

function CreateTaskForm({ teamName, onDone }: { teamName: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assignee, setAssignee] = useState<string | undefined>();

  const agentsQuery = useQuery({
    queryKey: ['kanban', 'agents', teamName],
    queryFn: () => rpc.kanban.listAgents({ team: teamName }),
  });

  const createMut = useMutation({
    mutationFn: () =>
      rpc.kanban.createTask({ team: teamName, title, body: body || undefined, assignee }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kanban', 'board', teamName] });
      notification.success({ message: 'Task created' });
      onDone();
    },
    onError: (err) =>
      notification.error({
        message: 'Failed to create task',
        description: (err as Error).message,
      }),
  });

  const agents = agentsQuery.data?.agents ?? [];

  return (
    <>
      <Input
        placeholder="Task title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        style={{ marginBottom: 8 }}
      />
      <Input.TextArea
        placeholder="Description (optional)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={2}
        style={{ marginBottom: 8 }}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Select
          value={assignee}
          onChange={setAssignee}
          placeholder="Assign to..."
          allowClear
          style={{ minWidth: 160 }}
          options={agents.map((a) => ({
            label: `${a.displayName}${a.online ? '' : ' (offline)'}`,
            value: a.personalityId,
            disabled: !a.online,
          }))}
        />
        <span style={{ flex: 1 }} />
        <Button onClick={onDone}>Cancel</Button>
        <Button
          type="primary"
          onClick={() => createMut.mutate()}
          loading={createMut.isPending}
          disabled={!title.trim()}
        >
          Create
        </Button>
      </div>
    </>
  );
}

function ConnectAgentsPanel({ teamName }: { teamName: string }) {
  const agentsQuery = useQuery({
    queryKey: ['kanban', 'agents', teamName],
    queryFn: () => rpc.kanban.listAgents({ team: teamName }),
  });

  const agents = agentsQuery.data?.agents ?? [];

  return (
    <section className="cc-panel">
      <header className="cc-panel-header">
        <h3 className="cc-panel-title">Connect agents</h3>
      </header>
      <div className="cc-panel-body" style={{ padding: 16 }}>
        <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
          The board coordinates multiple agents. Each agent is a separate, always-live{' '}
          <Typography.Text code>ethos serve</Typography.Text> process. This web UI runs only one
          personality at a time — the active one. Any other personality you assign a task to must be
          started separately and kept running, or it will not pick up its work.
        </Typography.Paragraph>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
          {agents.map((a) => (
            <div key={a.personalityId} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: a.online ? '#4ADE80' : '#F87171',
                    flex: '0 0 auto',
                  }}
                />
                <Typography.Text strong>{a.displayName}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {a.online ? 'online' : 'offline'}
                </Typography.Text>
              </div>
              <Typography.Text type="secondary" code style={{ fontSize: 11 }}>
                {a.personalityId}
              </Typography.Text>
              <Typography.Text code copyable style={{ fontSize: 12 }}>
                ethos serve --personality {a.personalityId}
              </Typography.Text>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
