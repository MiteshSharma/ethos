import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Input, Modal, Select } from 'antd';
import { useState } from 'react';
import { rpc } from '../../rpc';

// The create-task modal, shared by the Kanban page and the team Board pane
// (plan/phases/teams-as-a-scope.md §5). Title, optional body, optional
// assignee from the board's agent roster.

export function NewTaskModal({
  open,
  teamName,
  onClose,
}: {
  open: boolean;
  teamName: string;
  onClose: () => void;
}) {
  return (
    <Modal open={open} onCancel={onClose} title="New task" footer={null} destroyOnClose>
      <CreateTaskForm teamName={teamName} onDone={onClose} />
    </Modal>
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
