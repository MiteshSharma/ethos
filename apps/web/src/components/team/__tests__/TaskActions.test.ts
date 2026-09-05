// @vitest-environment jsdom
//
// teams-as-a-scope T4 — the drawer's operator actions by state (D11, §5) in
// jsdom against a mocked RPC client: which buttons each status offers, the
// exact reason strings the ledger keys on, Reassign's assign-then-ready
// sequence, Archive behind its Popconfirm, and the queries every action
// invalidates.

import type { KanbanTaskStatus } from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import {
  click,
  flush,
  installDomStubs,
  task,
  teamDetail,
} from '../../../pages/team/__tests__/harness';

installDomStubs();

const updateStatus = vi.fn();
const assign = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: {
    kanban: {
      updateStatus: (...args: unknown[]) => updateStatus(...args),
      assign: (...args: unknown[]) => assign(...args),
    },
  },
}));

const { TaskActions, APPROVE_REASON, REASSIGN_REASON, UNBLOCK_REASON } = await import(
  '../TaskActions'
);

const MEMBERS = teamDetail().members;

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let invalidate: MockInstance<QueryClient['invalidateQueries']>;

async function mount(status: KanbanTaskStatus, assignee: string | null = 'cmo'): Promise<void> {
  const t = task('t-0001', 'Rank the angles', status, assignee);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          AntApp,
          null,
          createElement(TaskActions, { task: t, team: 'marketing', members: MEMBERS }),
        ),
      ),
    );
  });
  await flush();
}

const buttons = () =>
  Array.from(container.querySelectorAll('button.ant-btn')).map((b) => b.textContent?.trim());
const button = (text: string, scope: ParentNode = container) =>
  Array.from(scope.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) ?? null;

const invalidatedKeys = () => invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));

beforeEach(() => {
  updateStatus.mockResolvedValue({ task: {} });
  assign.mockResolvedValue({ task: {} });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  invalidate = vi.spyOn(client, 'invalidateQueries');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('TaskActions — buttons by status', () => {
  it.each<[KanbanTaskStatus, string | null, string[], string | null]>([
    ['needs_revision', 'cmo', ['Approve as done', 'Reassign'], 'Approve as done'],
    ['blocked', 'cmo', ['Unblock', 'Reassign'], 'Unblock'],
    ['todo', null, ['Assign', 'Archive'], 'Assign'],
    ['ready', 'cmo', ['Reassign', 'Archive'], 'Reassign'],
    ['running', 'cmo', ['Reassign'], null],
    ['done', 'cmo', ['Archive'], null],
    ['failed', 'cmo', ['Reassign', 'Archive'], null],
    ['scheduled', 'cmo', [], null],
  ])('%s → %s', async (status, assignee, expected, primary) => {
    await mount(status, assignee);
    expect(buttons()).toEqual(expected);
    expect(container.querySelector('.ant-btn-primary')?.textContent?.trim() ?? null).toBe(primary);
  });
});

describe('TaskActions — actions', () => {
  it('Approve as done writes done with the verifier-bypass reason and invalidates', async () => {
    await mount('needs_revision');
    await click(button('Approve as done'));
    await flush();
    expect(updateStatus).toHaveBeenCalledTimes(1);
    expect(updateStatus).toHaveBeenCalledWith({
      team: 'marketing',
      taskId: 't-0001',
      status: 'done',
      reason: 'approved by operator, verifier bypassed',
    });
    expect(APPROVE_REASON).toContain('verifier bypassed');
    const keys = invalidatedKeys();
    expect(keys).toContain(JSON.stringify(['kanban', 'board', 'marketing']));
    expect(keys).toContain(JSON.stringify(['teams', 'ledger', 'marketing']));
    expect(keys).toContain(JSON.stringify(['kanban', 'task', 'marketing', 't-0001']));
  });

  it('Unblock puts the ticket back to ready', async () => {
    await mount('blocked');
    await click(button('Unblock'));
    await flush();
    expect(updateStatus).toHaveBeenCalledWith({
      team: 'marketing',
      taskId: 't-0001',
      status: 'ready',
      reason: UNBLOCK_REASON,
    });
    expect(UNBLOCK_REASON).toBe('unblocked by operator');
  });

  it('Reassign opens the member picker; a pick assigns, then readies a needs_revision ticket', async () => {
    await mount('needs_revision');
    expect(container.querySelector('[data-testid="assignee-picker"]')).toBeNull();
    await click(button('Reassign'));
    const picker = container.querySelector('[data-testid="assignee-picker"]');
    expect(picker).not.toBeNull();
    const rows = Array.from(picker?.querySelectorAll('.team-picker-row') ?? []);
    expect(rows.map((r) => r.querySelector('.team-picker-name')?.textContent)).toEqual([
      'cmo',
      'reddit-scout',
    ]);
    expect(rows[1]?.querySelector('.team-tier')?.textContent).toBe('—');

    await click(rows[1] ?? null);
    await flush();
    expect(assign).toHaveBeenCalledWith({
      team: 'marketing',
      taskId: 't-0001',
      assignee: 'reddit-scout',
    });
    expect(updateStatus).toHaveBeenCalledWith({
      team: 'marketing',
      taskId: 't-0001',
      status: 'ready',
      reason: REASSIGN_REASON,
    });
    expect(REASSIGN_REASON).toBe('reassigned by operator');
    const assignOrder = assign.mock.invocationCallOrder[0] ?? 0;
    const statusOrder = updateStatus.mock.invocationCallOrder[0] ?? 0;
    expect(assignOrder).toBeLessThan(statusOrder);
    // The picker closes once the pick has landed.
    expect(container.querySelector('[data-testid="assignee-picker"]')).toBeNull();
    expect(invalidatedKeys()).toContain(JSON.stringify(['teams', 'ledger', 'marketing']));
  });

  it('Reassigning a running ticket only assigns — no status change', async () => {
    await mount('running');
    await click(button('Reassign'));
    await click(container.querySelector('.team-picker-row'));
    await flush();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('Archive is behind a Popconfirm', async () => {
    await mount('done');
    await click(button('Archive'));
    await flush();
    expect(updateStatus).not.toHaveBeenCalled();
    const popup = document.body.querySelector('.ant-popconfirm');
    expect(popup, 'Archive opened no Popconfirm').not.toBeNull();
    await click(button('Archive', popup as ParentNode));
    await flush();
    expect(updateStatus).toHaveBeenCalledTimes(1);
    expect(updateStatus).toHaveBeenCalledWith({
      team: 'marketing',
      taskId: 't-0001',
      status: 'archived',
    });
  });

  it('a failed mutation surfaces the error and invalidates nothing', async () => {
    updateStatus.mockRejectedValueOnce(new Error('store is read-only'));
    await mount('blocked');
    await click(button('Unblock'));
    await flush();
    expect(invalidate).not.toHaveBeenCalled();
    expect(document.body.querySelector('.ant-message')?.textContent).toContain(
      'store is read-only',
    );
  });
});
