import type { KanbanTask, KanbanTaskStatus, TeamMemberSummary } from '@ethosagent/web-contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Popconfirm } from 'antd';
import { type ReactNode, useState } from 'react';
import { rpc } from '../../rpc';
import { AssigneePicker } from './AssigneePicker';

// Operator actions on a ticket, by state (plan/phases/teams-as-a-scope.md
// D11, §5) — rendered through `TaskDrawer`'s `actions` slot on the team
// Board. Every action is one of the two existing RPCs; the reason strings
// are load-bearing: `describeLedgerEvent` (apps/web-api/src/services/
// teams.service.ts) turns a human `done` whose reason contains
// `verifier bypassed` into the ledger's "Operator approved" line.

export const APPROVE_REASON = 'approved by operator, verifier bypassed';
export const UNBLOCK_REASON = 'unblocked by operator';
export const REASSIGN_REASON = 'reassigned by operator';

/** States a reassignment also puts back to `ready` — the new assignee has
 *  to be able to pick the ticket up on the next dispatch tick. */
const REASSIGN_TO_READY = new Set<KanbanTaskStatus>([
  'todo',
  'needs_revision',
  'blocked',
  'failed',
]);

export function TaskActions({
  task,
  team,
  members,
}: {
  task: KanbanTask;
  team: string;
  members: TeamMemberSummary[];
}) {
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const [pickerOpen, setPickerOpen] = useState(false);

  // The board, the drawer's own task query and the ledger (any limit) all
  // show the result; the ledger key is a prefix so every `limit` variant goes.
  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['kanban', 'board', team] }),
      queryClient.invalidateQueries({ queryKey: ['kanban', 'task', team, task.id] }),
      queryClient.invalidateQueries({ queryKey: ['teams', 'ledger', team] }),
    ]);
  const onError = (err: Error) => {
    message.error(err.message);
  };

  const statusMut = useMutation({
    mutationFn: ({ status, reason }: { status: KanbanTaskStatus; reason?: string }) =>
      rpc.kanban.updateStatus({
        team,
        taskId: task.id,
        status,
        ...(reason !== undefined ? { reason } : {}),
      }),
    onSuccess: invalidate,
    onError,
  });

  const assignMut = useMutation({
    mutationFn: async (assignee: string) => {
      await rpc.kanban.assign({ team, taskId: task.id, assignee });
      if (REASSIGN_TO_READY.has(task.status)) {
        await rpc.kanban.updateStatus({
          team,
          taskId: task.id,
          status: 'ready',
          reason: REASSIGN_REASON,
        });
      }
    },
    onSuccess: () => {
      setPickerOpen(false);
      return invalidate();
    },
    onError,
  });

  const busy = statusMut.isPending || assignMut.isPending;

  const reassign = (primary: boolean) => (
    <Button
      key="reassign"
      type={primary ? 'primary' : 'default'}
      disabled={busy}
      aria-expanded={pickerOpen}
      onClick={() => setPickerOpen((v) => !v)}
    >
      {task.assignee ? 'Reassign' : 'Assign'}
    </Button>
  );
  const archive = (
    <Popconfirm
      key="archive"
      title="Archive this task?"
      okText="Archive"
      onConfirm={() => statusMut.mutate({ status: 'archived' })}
    >
      <Button disabled={busy}>Archive</Button>
    </Popconfirm>
  );

  let buttons: ReactNode[];
  switch (task.status) {
    case 'needs_revision':
      buttons = [
        <Button
          key="approve"
          type="primary"
          disabled={busy}
          onClick={() => statusMut.mutate({ status: 'done', reason: APPROVE_REASON })}
        >
          Approve as done
        </Button>,
        reassign(false),
      ];
      break;
    case 'blocked':
      buttons = [
        <Button
          key="unblock"
          type="primary"
          disabled={busy}
          onClick={() => statusMut.mutate({ status: 'ready', reason: UNBLOCK_REASON })}
        >
          Unblock
        </Button>,
        reassign(false),
      ];
      break;
    case 'todo':
    case 'ready':
      buttons = [reassign(true), archive];
      break;
    case 'running':
      buttons = [reassign(false)];
      break;
    case 'done':
      buttons = [archive];
      break;
    case 'failed':
      buttons = [reassign(false), archive];
      break;
    default:
      return null;
  }

  return (
    <>
      {buttons}
      {pickerOpen && (
        <AssigneePicker
          members={members}
          busy={assignMut.isPending}
          onPick={(id) => assignMut.mutate(id)}
        />
      )}
    </>
  );
}
