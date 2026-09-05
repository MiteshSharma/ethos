import type { KanbanEvent, KanbanTask } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { describeLedgerEvent } from '../teams.service';

// Table-driven `task_events` row → ledger line (teams-as-a-scope §7). The
// data shapes mirror what `KanbanStore.emit` writes for each mutation.

const AT = '2026-09-04T10:00:00.000Z';

function event(partial: Partial<KanbanEvent> & Pick<KanbanEvent, 'kind' | 'actor'>): KanbanEvent {
  return { id: 7, taskId: 't_abc', data: {}, createdAt: AT, ...partial };
}

function task(partial: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: 't_abc',
    title: 'Draft launch post',
    body: '',
    status: 'running',
    assignee: 'cmo',
    priority: 0,
    workspaceMode: 'scratch',
    workspacePath: null,
    scheduledFor: null,
    currentRunId: null,
    retryCount: 1,
    maxRetries: 3,
    acceptanceCriteria: null,
    createdAt: AT,
    updatedAt: AT,
    ...partial,
  };
}

describe('describeLedgerEvent', () => {
  const cases: Array<{
    name: string;
    event: KanbanEvent;
    task: KanbanTask | undefined;
    expect: Pick<
      NonNullable<ReturnType<typeof describeLedgerEvent>>,
      'kind' | 'headline' | 'severity' | 'personalityId'
    > & { detail?: string };
  }> = [
    {
      name: 'dispatcher claim',
      event: event({
        kind: 'status_changed',
        actor: 'dispatcher',
        data: { from: 'ready', to: 'running', reason: 'dispatched' },
      }),
      task: task(),
      expect: {
        kind: 'dispatched',
        headline: 'Dispatch tick',
        detail: 'claimed for cmo',
        severity: 'ok',
        personalityId: 'cmo',
      },
    },
    {
      name: 'stale reclaim (orphan_stale)',
      event: event({
        kind: 'status_changed',
        actor: 'dispatcher',
        data: { from: 'running', to: 'ready', reason: 'orphan_stale' },
      }),
      task: task({ assignee: 'x-scout' }),
      expect: {
        kind: 'stale_reclaim',
        headline: 'Stale reclaim',
        detail: 'x-scout heartbeat went stale · back to ready',
        severity: 'err',
        personalityId: 'x-scout',
      },
    },
    {
      name: 'stale reclaim (orphan_no_owner)',
      event: event({
        kind: 'status_changed',
        actor: 'dispatcher',
        data: { from: 'running', to: 'ready', reason: 'orphan_no_owner' },
      }),
      task: task({ assignee: 'x-scout' }),
      expect: {
        kind: 'stale_reclaim',
        headline: 'Stale reclaim',
        detail: 'x-scout owner process is gone · back to ready',
        severity: 'err',
        personalityId: 'x-scout',
      },
    },
    {
      name: 'verifier rejection (actor is the assignee that called kanban_complete)',
      event: event({
        kind: 'status_changed',
        actor: 'reddit-scout',
        data: { from: 'running', to: 'needs_revision', reason: 'no source links' },
      }),
      task: task({ assignee: 'reddit-scout', retryCount: 1, maxRetries: 3 }),
      expect: {
        kind: 'verifier_rejected',
        headline: 'Verifier rejected',
        detail: 'no source links · retry 1 of 3',
        severity: 'warn',
        personalityId: 'reddit-scout',
      },
    },
    {
      name: 'completion without acceptance criteria',
      event: event({
        kind: 'run_completed',
        actor: 'cmo',
        data: { outcome: 'completed', summary: 'posted', completedBy: null },
      }),
      task: task(),
      expect: {
        kind: 'completed',
        headline: 'Completed',
        detail: 'cmo · posted',
        severity: 'ok',
        personalityId: 'cmo',
      },
    },
    {
      name: 'completion with acceptance criteria reads as a verifier pass',
      event: event({
        kind: 'run_completed',
        actor: 'cmo',
        data: { outcome: 'completed', summary: 'posted', completedBy: null },
      }),
      task: task({ acceptanceCriteria: 'has three links' }),
      expect: {
        kind: 'completed',
        headline: 'Verifier passed',
        severity: 'ok',
        personalityId: 'cmo',
      },
    },
    {
      name: 'block',
      event: event({
        kind: 'run_completed',
        actor: 'x-scout',
        data: { outcome: 'blocked', summary: 'waiting on API key', completedBy: null },
      }),
      task: task({ assignee: 'x-scout' }),
      expect: {
        kind: 'blocked',
        headline: 'Blocked',
        detail: 'waiting on API key',
        severity: 'err',
        personalityId: 'x-scout',
      },
    },
    {
      name: 'human assign',
      event: event({
        kind: 'assigned',
        actor: 'human:control-center',
        data: { assignee: 'cmo' },
      }),
      task: task({ status: 'ready' }),
      expect: {
        kind: 'operator_assigned',
        headline: 'Operator assigned',
        detail: 'to cmo · ready',
        severity: 'ok',
        personalityId: 'cmo',
      },
    },
    {
      name: 'human approve (verifier bypassed)',
      event: event({
        kind: 'status_changed',
        actor: 'human:control-center',
        data: { from: 'needs_revision', to: 'done', reason: 'approved — verifier bypassed' },
      }),
      task: task(),
      expect: {
        kind: 'operator_approved',
        headline: 'Operator approved',
        severity: 'ok',
        personalityId: 'cmo',
      },
    },
    {
      name: 'human unblock',
      event: event({
        kind: 'status_changed',
        actor: 'human:control-center',
        data: { from: 'blocked', to: 'ready', reason: 'unblocked by operator' },
      }),
      task: task({ status: 'ready', assignee: 'x-scout' }),
      expect: {
        kind: 'operator_unblocked',
        headline: 'Operator unblocked',
        detail: 'back to ready for x-scout',
        severity: 'ok',
        personalityId: 'x-scout',
      },
    },
    {
      name: 'human archive via status_changed (web path)',
      event: event({
        kind: 'status_changed',
        actor: 'human:control-center',
        data: { from: 'done', to: 'archived', reason: null },
      }),
      task: task(),
      expect: {
        kind: 'operator_archived',
        headline: 'Operator archived',
        severity: 'dim',
        personalityId: 'cmo',
      },
    },
    {
      name: 'created',
      event: event({ kind: 'created', actor: 'human:control-center', data: { status: 'todo' } }),
      task: task(),
      expect: {
        kind: 'created',
        headline: 'Created',
        detail: 'by human:control-center',
        severity: 'info',
        personalityId: null,
      },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const line = describeLedgerEvent(c.event, c.task);
      expect(line).not.toBeNull();
      if (!line) return;
      expect(line.id).toBe(c.event.id);
      expect(line.at).toBe(AT);
      expect(line.taskId).toBe(c.event.taskId);
      expect(line.taskTitle).toBe(c.task?.title ?? null);
      expect(line.kind).toBe(c.expect.kind);
      expect(line.headline).toBe(c.expect.headline);
      expect(line.severity).toBe(c.expect.severity);
      expect(line.personalityId).toBe(c.expect.personalityId);
      if (c.expect.detail !== undefined) expect(line.detail).toBe(c.expect.detail);
    });
  }

  it('works without a task row (title null, no retry suffix)', () => {
    const line = describeLedgerEvent(
      event({
        kind: 'status_changed',
        actor: 'reddit-scout',
        data: { from: 'running', to: 'needs_revision', reason: 'nope' },
      }),
      undefined,
    );
    expect(line?.taskTitle).toBeNull();
    expect(line?.detail).toBe('nope');
    expect(line?.personalityId).toBe('reddit-scout');
  });

  const ignored: Array<[string, KanbanEvent]> = [
    ['heartbeat', event({ kind: 'heartbeat', actor: 'cmo', data: { note: null } })],
    ['run_started', event({ kind: 'run_started', actor: 'dispatcher' })],
    ['linked', event({ kind: 'linked', actor: 'cmo', data: { parentId: 'a', childId: 'b' } })],
    ['unlinked', event({ kind: 'unlinked', actor: 'cmo', data: { parentId: 'a', childId: 'b' } })],
    ['comment', event({ kind: 'commented', actor: 'cmo', data: { commentId: 'c_1' } })],
    [
      'cancelled run_completed',
      event({
        kind: 'run_completed',
        actor: 'dispatcher',
        data: { outcome: 'cancelled', summary: null, completedBy: null },
      }),
    ],
    [
      'agent-driven assign',
      event({ kind: 'assigned', actor: 'cmo', data: { assignee: 'reddit-scout' } }),
    ],
    [
      'plain status change (todo → ready)',
      event({
        kind: 'status_changed',
        actor: 'human:control-center',
        data: { from: 'todo', to: 'ready', reason: null },
      }),
    ],
    [
      'human reassign to ready (the paired assigned row is the one line)',
      event({
        kind: 'status_changed',
        actor: 'human:control-center',
        data: { from: 'needs_revision', to: 'ready', reason: 'reassigned by operator' },
      }),
    ],
    [
      'human → ready with an unknown reason',
      event({
        kind: 'status_changed',
        actor: 'human:control-center',
        data: { from: 'blocked', to: 'ready', reason: 'because' },
      }),
    ],
    [
      'archived kind (paired with its status_changed row, shown once)',
      event({ kind: 'archived', actor: 'human:control-center' }),
    ],
  ];

  for (const [name, e] of ignored) {
    it(`ignores ${name}`, () => {
      expect(describeLedgerEvent(e, task())).toBeNull();
    });
  }
});
