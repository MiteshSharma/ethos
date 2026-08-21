import type {
  KanbanBoardSnapshot,
  KanbanEvent,
  KanbanMemberStats,
  KanbanTask,
  KanbanTaskStatus,
} from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Button,
  Checkbox,
  Descriptions,
  Dropdown,
  Input,
  Modal,
  Select,
  Typography,
} from 'antd';
import { useMemo, useState } from 'react';
import { formatMemberSuccess } from '../../lib/member-stats';
import { rpc } from '../../rpc';

export const STATUS_COLUMNS: KanbanTaskStatus[] = [
  'todo',
  'ready',
  'running',
  'blocked',
  'needs_revision',
  'failed',
  'done',
];
export const ARCHIVED_STATUS: KanbanTaskStatus = 'archived';
export const ALL_STATUSES: KanbanTaskStatus[] = [...STATUS_COLUMNS, ARCHIVED_STATUS, 'scheduled'];
export const STATUS_LABEL: Record<KanbanTaskStatus, string> = {
  todo: 'todo',
  ready: 'ready',
  running: 'running',
  blocked: 'blocked',
  done: 'done',
  archived: 'archived',
  scheduled: 'scheduled',
  failed: 'failed',
  needs_revision: 'needs revision',
};

export function Board({
  snapshot,
  teamName,
  showArchived,
  onSelect,
  fill,
  selectMode,
  onSelectModeChange,
  selected,
  onToggleSelect,
}: {
  snapshot: KanbanBoardSnapshot;
  teamName: string;
  showArchived: boolean;
  onSelect: (id: string) => void;
  fill?: boolean;
  selectMode: boolean;
  onSelectModeChange: (next: boolean) => void;
  selected: Set<string>;
  onToggleSelect: (taskId: string) => void;
}) {
  const byStatus = useMemo(() => {
    const map = new Map<KanbanTaskStatus, KanbanTask[]>();
    for (const status of [...STATUS_COLUMNS, ARCHIVED_STATUS]) map.set(status, []);
    for (const t of snapshot.tasks) {
      if (t.status === 'archived' && !showArchived) continue;
      const bucket = map.get(t.status);
      if (bucket) bucket.push(t);
    }
    return map;
  }, [snapshot.tasks, showArchived]);

  const childCounts = useMemo(() => buildChildCounts(snapshot), [snapshot]);

  const columns = showArchived ? [...STATUS_COLUMNS, ARCHIVED_STATUS] : STATUS_COLUMNS;

  return (
    <section className={`cc-panel cc-board${fill ? ' cc-board--fill' : ''}`}>
      <header className="cc-panel-header">
        <h3 className="cc-panel-title">Board</h3>
        <span className="cc-spacer" />
        <Button
          size="small"
          type={selectMode ? 'primary' : 'default'}
          onClick={() => onSelectModeChange(!selectMode)}
        >
          {selectMode ? 'Done selecting' : 'Select'}
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {snapshot.tasks.length} tasks
        </Typography.Text>
      </header>
      <div className="cc-panel-body">
        {columns.map((status) => (
          <BoardColumn
            key={status}
            status={status}
            tasks={byStatus.get(status) ?? []}
            childCounts={childCounts}
            teamName={teamName}
            onSelect={onSelect}
            selectMode={selectMode}
            selected={selected}
            onToggleSelect={onToggleSelect}
          />
        ))}
      </div>
    </section>
  );
}

export function BoardColumn({
  status,
  tasks,
  childCounts,
  teamName,
  onSelect,
  selectMode,
  selected,
  onToggleSelect,
}: {
  status: KanbanTaskStatus;
  tasks: KanbanTask[];
  childCounts: Map<string, { total: number; done: number }>;
  teamName: string;
  onSelect: (id: string) => void;
  selectMode: boolean;
  selected: Set<string>;
  onToggleSelect: (taskId: string) => void;
}) {
  return (
    <div className="cc-column">
      <header className="cc-column-header">
        <span className={`cc-column-name cc-status-chip cc-status-${status}`}>
          {STATUS_LABEL[status]}
        </span>
        <span className="cc-spacer" />
        <span className="cc-column-count">{tasks.length}</span>
      </header>
      <div className="cc-column-body">
        {tasks.length === 0 ? (
          <div className="cc-column-empty">No tasks here yet</div>
        ) : (
          tasks.map((t) => (
            <TaskTile
              key={t.id}
              task={t}
              childCount={childCounts.get(t.id)}
              teamName={teamName}
              onSelect={onSelect}
              selectMode={selectMode}
              selected={selected}
              onToggleSelect={onToggleSelect}
            />
          ))
        )}
      </div>
    </div>
  );
}

// Task tile — DESIGN.md Card-primitive exemption #3. The accent stripe encodes
// the assignee; the status chip on the bottom encodes work state. Click the
// tile to open the drawer; status changes go through the dropdown on the chip
// so a stray click doesn't reclassify the task.
export function TaskTile({
  task,
  childCount,
  teamName,
  onSelect,
  selectMode,
  selected,
  onToggleSelect,
}: {
  task: KanbanTask;
  childCount?: { total: number; done: number };
  teamName: string;
  onSelect: (id: string) => void;
  selectMode: boolean;
  selected: Set<string>;
  onToggleSelect: (taskId: string) => void;
}) {
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();

  const updateMut = useMutation({
    mutationFn: (nextStatus: KanbanTaskStatus) =>
      rpc.kanban.updateStatus({ team: teamName, taskId: task.id, status: nextStatus }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['kanban', 'board', teamName] }),
    onError: (err) =>
      notification.error({
        message: 'Status change failed',
        description: (err as Error).message,
      }),
  });

  const isGoal = task.assignee === null;
  const accent = accentFor(task.assignee);

  // The tile is keyboard-activatable but intentionally NOT a <button> because
  // it contains a nested status-chip button (Dropdown trigger) and HTML
  // forbids button-in-button. role="button" + tabIndex + Enter/Space keydown
  // give the same a11y semantics without the nesting violation.
  return (
    // biome-ignore lint/a11y/useSemanticElements: tile holds a nested Dropdown trigger button; can't be <button>
    <div
      role="button"
      tabIndex={0}
      className="cc-task"
      style={{ borderLeftColor: accent }}
      onClick={() => onSelect(task.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(task.id);
        }
      }}
      title={task.title}
    >
      <div className="cc-task-top">
        {selectMode && (
          <Checkbox
            checked={selected.has(task.id)}
            onClick={(e) => e.stopPropagation()}
            onChange={() => onToggleSelect(task.id)}
          />
        )}
        <span className="cc-task-id">{task.id.slice(0, 8)}</span>
        {task.priority !== 0 && (
          <span className="cc-task-priority" data-p={task.priority}>
            p{task.priority}
          </span>
        )}
        {isGoal && <span className="cc-task-goal-badge">goal</span>}
        {task.retryCount > 0 &&
          (() => {
            // Over budget: a failed task's retryCount can exceed maxRetries
            // (the re-claim that tripped the budget still counts). Showing
            // "3/2" reads oddly, so drop the fraction and say it plainly.
            const overBudget = task.maxRetries !== null && task.retryCount > task.maxRetries;
            const showFraction = task.maxRetries !== null && !overBudget;
            return (
              <span
                className="cc-task-retry"
                title={
                  task.maxRetries === null
                    ? `Re-claimed ${task.retryCount} time(s)`
                    : overBudget
                      ? `Re-claimed ${task.retryCount} time(s) — exhausted its ${task.maxRetries}-retry budget`
                      : `Re-claimed ${task.retryCount} of ${task.maxRetries} allowed retries`
                }
              >
                ↻ {showFraction ? `${task.retryCount}/${task.maxRetries}` : task.retryCount}
              </span>
            );
          })()}
        <span className="cc-spacer" />
        {childCount && childCount.total > 0 && (
          <span className="cc-task-progress">
            {childCount.done}/{childCount.total}
          </span>
        )}
      </div>
      <div className="cc-task-title">{task.title}</div>
      <div className="cc-task-bottom">
        <span className="cc-task-assignee" style={{ color: accent }}>
          <span className="cc-task-assignee-mark" style={{ background: accent }} />
          {task.assignee ?? <em style={{ fontStyle: 'normal', opacity: 0.6 }}>unassigned</em>}
        </span>
        <span className="cc-spacer" />
        <Dropdown
          trigger={['click']}
          menu={{
            items: ALL_STATUSES.filter((s) => s !== task.status).map((s) => ({
              key: s,
              label: <span className={`cc-status-chip cc-status-${s}`}>{STATUS_LABEL[s]}</span>,
              onClick: ({ domEvent }) => {
                domEvent.stopPropagation();
                updateMut.mutate(s);
              },
            })),
          }}
        >
          <button
            type="button"
            className={`cc-status-chip cc-status-${task.status}`}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
            }}
            style={{ cursor: 'pointer', border: 'none', font: 'inherit' }}
          >
            {STATUS_LABEL[task.status]}
          </button>
        </Dropdown>
      </div>
    </div>
  );
}

// Batch action bar — shown by the page component whenever the lifted
// selection set is non-empty. Status and reassign each fire their own narrow
// bulk RPC (mirrors the backend's two-narrow-methods-not-one-polymorphic-method
// choice); "Archive" reuses the same bulk status-update RPC with
// status: 'archived' — there is no separate archive RPC on the web layer.
export function BulkActionBar({
  selectedIds,
  teamName,
  agents,
  onDone,
}: {
  selectedIds: string[];
  teamName: string;
  agents: Array<{ personalityId: string; displayName: string; online: boolean }>;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();

  const bulkStatusMut = useMutation({
    mutationFn: (status: KanbanTaskStatus) =>
      rpc.kanban.bulkUpdateStatus({ team: teamName, taskIds: selectedIds, status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kanban', 'board', teamName] });
      onDone();
    },
    onError: (err) =>
      notification.error({
        message: 'Bulk status change failed',
        description: (err as Error).message,
      }),
  });

  const bulkAssignMut = useMutation({
    mutationFn: (assignee: string) =>
      rpc.kanban.bulkAssign({ team: teamName, taskIds: selectedIds, assignee }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kanban', 'board', teamName] });
      onDone();
    },
    onError: (err) =>
      notification.error({
        message: 'Bulk reassign failed',
        description: (err as Error).message,
      }),
  });

  return (
    <div className="cc-panel" style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 8 }}>
      <Typography.Text strong style={{ fontSize: 12 }}>
        {selectedIds.length} selected
      </Typography.Text>
      <Select
        size="small"
        placeholder="Set status…"
        style={{ minWidth: 160 }}
        loading={bulkStatusMut.isPending}
        value={undefined}
        onChange={(status: KanbanTaskStatus) => bulkStatusMut.mutate(status)}
        options={ALL_STATUSES.map((s) => ({ label: STATUS_LABEL[s], value: s }))}
      />
      <Button
        size="small"
        loading={bulkStatusMut.isPending}
        onClick={() => bulkStatusMut.mutate('archived')}
      >
        Archive
      </Button>
      <Select
        size="small"
        placeholder="Reassign to…"
        style={{ minWidth: 160 }}
        loading={bulkAssignMut.isPending}
        value={undefined}
        onChange={(assignee: string) => bulkAssignMut.mutate(assignee)}
        options={agents
          .filter((a) => a.online)
          .map((a) => ({ label: a.displayName, value: a.personalityId }))}
      />
      <span className="cc-spacer" />
      <Button size="small" onClick={onDone}>
        Cancel
      </Button>
    </div>
  );
}

export function Activity({
  events,
  tasks,
  onSelect,
}: {
  events: KanbanEvent[];
  tasks: KanbanTask[];
  onSelect: (id: string) => void;
}) {
  const taskTitle = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tasks) m.set(t.id, t.title);
    return m;
  }, [tasks]);

  // Most recent first.
  const ordered = useMemo(() => [...events].reverse(), [events]);

  return (
    <section className="cc-panel cc-activity">
      <header className="cc-panel-header">
        <h3 className="cc-panel-title">Activity</h3>
      </header>
      <div className="cc-panel-body">
        {ordered.length === 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            No activity yet.
          </Typography.Text>
        ) : (
          <div className="cc-activity-list">
            {ordered.map((e) => {
              const accent = accentFor(e.actor);
              const title = taskTitle.get(e.taskId) ?? e.taskId.slice(0, 8);
              return (
                <button
                  type="button"
                  key={`${e.taskId}:${e.id}`}
                  className="cc-activity-row"
                  onClick={() => onSelect(e.taskId)}
                >
                  <span className="cc-activity-actor" style={{ color: accent }}>
                    {e.actor}
                  </span>
                  <span className="cc-activity-text" title={`${describeEvent(e)} ${title}`}>
                    {describeEvent(e)} {title}
                  </span>
                  <span className="cc-activity-time">{formatRelative(e.createdAt)}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

export function Roster({ snapshot }: { snapshot: KanbanBoardSnapshot }) {
  const workingByAssignee = useMemo(() => {
    const m = new Map<string, KanbanTask>();
    for (const t of snapshot.tasks) {
      if (t.status === 'running' && t.assignee !== null) m.set(t.assignee, t);
    }
    return m;
  }, [snapshot.tasks]);

  const statsByMember = useMemo(() => {
    const m = new Map<string, KanbanMemberStats>();
    for (const s of snapshot.memberStats) m.set(s.memberId, s);
    return m;
  }, [snapshot.memberStats]);

  // Roster covers anyone who has been assigned a task OR has a recorded stat row
  // — a member whose tasks all completed still belongs on the roster.
  const members = useMemo(() => {
    const s = new Set<string>();
    for (const t of snapshot.tasks) {
      if (t.assignee) s.add(t.assignee);
    }
    for (const stat of snapshot.memberStats) s.add(stat.memberId);
    return Array.from(s).sort();
  }, [snapshot.tasks, snapshot.memberStats]);

  return (
    <section className="cc-panel cc-roster">
      <header className="cc-panel-header">
        <h3 className="cc-panel-title">Roster</h3>
      </header>
      <div className="cc-panel-body">
        {members.length === 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            No assigned tasks yet.
          </Typography.Text>
        ) : (
          <div className="cc-roster-list">
            {members.map((person) => {
              const accent = accentFor(person);
              const running = workingByAssignee.get(person);
              const stats = statsByMember.get(person);
              return (
                <div key={person} className="cc-roster-row">
                  <span className="cc-roster-mark" style={{ background: accent }} />
                  <div className="cc-roster-detail">
                    <span className="cc-roster-name" style={{ color: accent }}>
                      {person}
                    </span>
                    <MemberStatsLine stats={stats} />
                  </div>
                  <span className="cc-spacer" />
                  <span
                    className={`cc-roster-status-dot ${running ? 'cc-roster-status-running' : ''}`}
                    title={running ? `working on ${running.title}` : 'idle'}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

// Read-only, informational success-rate line under a roster name. Success rate
// is `completed / (completed + failed + orphaned)`. A member with no recorded
// terminal outcomes shows a muted "no record yet" rather than a fake 0% or 100%.
export function MemberStatsLine({ stats }: { stats?: KanbanMemberStats }) {
  const success = formatMemberSuccess(stats);
  if (success.kind === 'no-record') {
    return <span className="cc-roster-stats cc-roster-stats--empty">no record yet</span>;
  }
  return (
    <span
      className="cc-roster-stats"
      title={
        stats
          ? `${stats.ticketsCompleted} completed · ${stats.ticketsFailed} failed · ${stats.ticketsOrphaned} orphaned`
          : undefined
      }
    >
      {success.ratePercent}% success
      <span className="cc-roster-stats-breakdown">
        {' '}
        ({success.completed}/{success.total})
      </span>
    </span>
  );
}

export function TaskDrawer({
  task,
  board,
  teamName,
  onClose,
}: {
  task: KanbanTask | null;
  board: KanbanBoardSnapshot;
  teamName: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();

  const updateMut = useMutation({
    mutationFn: (nextStatus: KanbanTaskStatus) =>
      rpc.kanban.updateStatus({
        team: teamName,
        taskId: task?.id ?? '',
        status: nextStatus,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['kanban', 'board', teamName] }),
    onError: (err) =>
      notification.error({
        message: 'Status change failed',
        description: (err as Error).message,
      }),
  });

  const [commentBody, setCommentBody] = useState('');
  const [showEvents, setShowEvents] = useState(false);
  const taskQuery = useQuery({
    queryKey: ['kanban', 'task', teamName, task?.id],
    queryFn: () => rpc.kanban.getTask({ team: teamName, taskId: task?.id ?? '' }),
    enabled: task !== null,
  });
  const agentsQuery = useQuery({
    queryKey: ['kanban', 'agents', teamName],
    queryFn: () => rpc.kanban.listAgents({ team: teamName }),
    enabled: task !== null,
  });
  const commentMut = useMutation({
    mutationFn: (body: string) =>
      rpc.kanban.addComment({ team: teamName, taskId: task?.id ?? '', body }),
    onSuccess: () => {
      setCommentBody('');
      queryClient.invalidateQueries({ queryKey: ['kanban', 'task', teamName, task?.id] });
    },
    onError: (err) =>
      notification.error({
        message: 'Comment failed',
        description: (err as Error).message,
      }),
  });
  const assignMut = useMutation({
    mutationFn: (assignee: string) =>
      rpc.kanban.assign({ team: teamName, taskId: task?.id ?? '', assignee }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kanban', 'task', teamName, task?.id] });
      queryClient.invalidateQueries({ queryKey: ['kanban', 'board', teamName] });
      notification.success({ message: 'Assignee updated' });
    },
    onError: (err) =>
      notification.error({
        message: 'Failed to reassign',
        description: (err as Error).message,
      }),
  });

  const events = useMemo(() => {
    if (!task) return [];
    return board.recentEvents.filter((e) => e.taskId === task.id).reverse();
  }, [task, board.recentEvents]);

  const comments = [...(taskQuery.data?.comments ?? [])].reverse();

  const parents = useMemo(() => {
    if (!task) return [];
    return board.links
      .filter((l) => l.childId === task.id)
      .map((l) => board.tasks.find((t) => t.id === l.parentId))
      .filter((t): t is KanbanTask => t !== undefined);
  }, [task, board]);

  const children = useMemo(() => {
    if (!task) return [];
    return board.links
      .filter((l) => l.parentId === task.id)
      .map((l) => board.tasks.find((t) => t.id === l.childId))
      .filter((t): t is KanbanTask => t !== undefined);
  }, [task, board]);

  return (
    <Modal
      open={task !== null}
      onCancel={onClose}
      title={task ? `${task.id} · ${task.title}` : ''}
      footer={null}
      destroyOnClose
      width="min(1100px, 92vw)"
      className="cc-task-modal"
    >
      {task && (
        <div className="cc-task-modal-layout">
          <div className="cc-task-modal-main">
            <div className="cc-task-modal-scroll">
              <div className="cc-task-modal-toolbar">
                <Dropdown
                  trigger={['click']}
                  menu={{
                    items: ALL_STATUSES.filter((s) => s !== task.status).map((s) => ({
                      key: s,
                      label: (
                        <span className={`cc-status-chip cc-status-${s}`}>{STATUS_LABEL[s]}</span>
                      ),
                      onClick: () => updateMut.mutate(s),
                    })),
                  }}
                >
                  <Button size="small">
                    <span className={`cc-status-chip cc-status-${task.status}`}>
                      {STATUS_LABEL[task.status]}
                    </span>
                    <span style={{ marginLeft: 6 }}>▾</span>
                  </Button>
                </Dropdown>
                <Button size="small" onClick={() => setShowEvents((v) => !v)}>
                  {showEvents ? 'Hide events' : 'Events'}
                </Button>
              </div>

              {task.body && (
                <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>
                  {task.body}
                </Typography.Paragraph>
              )}

              <Descriptions size="small" column={1} bordered style={{ marginBottom: 16 }}>
                <Descriptions.Item label="Assignee">
                  <Select
                    size="small"
                    value={task.assignee ?? undefined}
                    onChange={(value) => assignMut.mutate(value)}
                    placeholder="Assign to…"
                    style={{ minWidth: 180 }}
                    loading={assignMut.isPending}
                    options={(agentsQuery.data?.agents ?? []).map((a) => ({
                      label: `${a.displayName}${a.online ? '' : ' (offline)'}`,
                      value: a.personalityId,
                      disabled: !a.online,
                    }))}
                  />
                </Descriptions.Item>
                <Descriptions.Item label="Priority">{task.priority}</Descriptions.Item>
                <Descriptions.Item label="Workspace">{task.workspaceMode}</Descriptions.Item>
                <Descriptions.Item label="Created">
                  {new Date(task.createdAt).toLocaleString()}
                </Descriptions.Item>
                <Descriptions.Item label="Updated">
                  {new Date(task.updatedAt).toLocaleString()}
                </Descriptions.Item>
              </Descriptions>

              {parents.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <Typography.Text strong style={{ fontSize: 12 }}>
                    Parents
                  </Typography.Text>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                    {parents.map((p) => (
                      <span key={p.id} className={`cc-status-chip cc-status-${p.status}`}>
                        {p.title.slice(0, 30)}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {children.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <Typography.Text strong style={{ fontSize: 12 }}>
                    Children
                  </Typography.Text>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                    {children.map((c) => (
                      <span key={c.id} className={`cc-status-chip cc-status-${c.status}`}>
                        {c.title.slice(0, 30)}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ marginBottom: 16 }}>
                <Typography.Text strong style={{ fontSize: 12 }}>
                  Runs
                </Typography.Text>
                <div className="cc-activity-list" style={{ marginTop: 6 }}>
                  {(taskQuery.data?.runs ?? []).length === 0 ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      No runs yet.
                    </Typography.Text>
                  ) : (
                    (taskQuery.data?.runs ?? []).map((run) => (
                      <div key={run.id} className="cc-activity-row">
                        <span className="cc-activity-actor">
                          {run.endedAt === null ? 'running' : (run.outcome ?? 'ended')}
                        </span>
                        <div>
                          <Typography.Paragraph
                            ellipsis={{
                              rows: 2,
                              expandable: true,
                              symbol: 'show more',
                            }}
                            style={{ whiteSpace: 'pre-wrap', margin: 0 }}
                          >
                            {run.summary ?? ''}
                          </Typography.Paragraph>
                        </div>
                        <span className="cc-activity-time">{formatRelative(run.startedAt)}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div>
                <Typography.Text strong style={{ fontSize: 12 }}>
                  Comments
                </Typography.Text>
                <div className="cc-task-modal-composer">
                  <Input.TextArea
                    rows={2}
                    placeholder="Add a comment…"
                    value={commentBody}
                    onChange={(e) => setCommentBody(e.target.value)}
                  />
                  <Button
                    type="primary"
                    size="small"
                    loading={commentMut.isPending}
                    disabled={commentBody.trim().length === 0 || commentMut.isPending}
                    onClick={() => commentMut.mutate(commentBody.trim())}
                    style={{ alignSelf: 'flex-start' }}
                  >
                    Comment
                  </Button>
                </div>
                <div className="cc-activity-list" style={{ marginTop: 6 }}>
                  {comments.length === 0 ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      No comments yet.
                    </Typography.Text>
                  ) : (
                    comments.map((c) => (
                      <div key={c.id} className="cc-activity-row">
                        <span className="cc-activity-actor" style={{ color: accentFor(c.author) }}>
                          {c.author}
                        </span>
                        <div>
                          <Typography.Paragraph
                            ellipsis={{
                              rows: 2,
                              expandable: true,
                              symbol: 'show more',
                            }}
                            style={{ whiteSpace: 'pre-wrap', margin: 0 }}
                          >
                            {c.body}
                          </Typography.Paragraph>
                        </div>
                        <span className="cc-activity-time">{formatRelative(c.createdAt)}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>

          {showEvents && (
            <div className="cc-task-modal-events">
              <Typography.Text strong style={{ fontSize: 12 }}>
                Recent events
              </Typography.Text>
              <div className="cc-activity-list" style={{ marginTop: 6 }}>
                {events.length === 0 ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    No events for this task in the recent window.
                  </Typography.Text>
                ) : (
                  events.map((e) => (
                    <div key={e.id} className="cc-activity-row">
                      <span className="cc-activity-actor" style={{ color: accentFor(e.actor) }}>
                        {e.actor}
                      </span>
                      <span className="cc-activity-text">
                        {describeEvent(e).replace(/ on$/, '')}
                      </span>
                      <span className="cc-activity-time">{formatRelative(e.createdAt)}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function buildChildCounts(
  snapshot: KanbanBoardSnapshot,
): Map<string, { total: number; done: number }> {
  const byId = new Map<string, KanbanTask>();
  for (const t of snapshot.tasks) byId.set(t.id, t);
  const counts = new Map<string, { total: number; done: number }>();
  for (const link of snapshot.links) {
    const child = byId.get(link.childId);
    if (!child) continue;
    const cur = counts.get(link.parentId) ?? { total: 0, done: 0 };
    cur.total += 1;
    if (child.status === 'done') cur.done += 1;
    counts.set(link.parentId, cur);
  }
  return counts;
}

// Per-personality accent — matches DESIGN.md's recommended hexes for the
// known built-in personalities and falls back to a deterministic hash for
// anything custom. Used for the assignee mark, name color, and tile stripe.
export const KNOWN_ACCENTS: Record<string, string> = {
  researcher: '#4A9EFF',
  engineer: '#4ADE80',
  reviewer: '#F59E0B',
  coach: '#E879F9',
  operator: '#94A3B8',
  coordinator: '#67E8F9',
  dispatcher: '#94A3B8',
};
export const FALLBACK_ACCENTS = ['#1677ff', '#13c2c2', '#722ed1', '#fa8c16', '#52c41a', '#eb2f96'];
export const ACCENT_FALLBACK = '#9A9A98';

export function accentFor(key: string | null): string {
  if (key === null) return ACCENT_FALLBACK;
  const stripped = key.replace(/^human:/, '');
  if (KNOWN_ACCENTS[stripped]) return KNOWN_ACCENTS[stripped];
  let hash = 0;
  for (let i = 0; i < stripped.length; i++) hash = (hash * 31 + stripped.charCodeAt(i)) >>> 0;
  return FALLBACK_ACCENTS[hash % FALLBACK_ACCENTS.length] ?? ACCENT_FALLBACK;
}

export function describeEvent(e: KanbanEvent): string {
  switch (e.kind) {
    case 'created':
      return 'created';
    case 'status_changed': {
      const data = e.data as { from?: string; to?: string };
      return `${data.from ?? '?'} → ${data.to ?? '?'}`;
    }
    case 'commented':
      return 'commented on';
    case 'assigned':
      return 'assigned';
    case 'linked':
      return 'linked';
    case 'unlinked':
      return 'unlinked';
    case 'run_started':
      return 'started run on';
    case 'run_completed': {
      const data = e.data as { outcome?: string; completedBy?: { name?: string } | null };
      const by = data.completedBy?.name ? ` · by ${data.completedBy.name}` : '';
      return `ended run (${data.outcome ?? 'completed'})${by} on`;
    }
    case 'heartbeat':
      return '♥ on';
    case 'archived':
      return 'archived';
    default:
      return e.kind;
  }
}

export function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return iso;
  const diff = Date.now() - ts;
  if (diff < 1_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return new Date(iso).toLocaleString();
}
