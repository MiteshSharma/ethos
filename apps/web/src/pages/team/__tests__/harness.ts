// Shared scaffolding for the team-pane page tests (teams-as-a-scope T2):
// DOM stubs jsdom lacks, fixtures for the three RPCs the panes read, and a
// mount helper that wraps a page in react-query + Antd App + a MemoryRouter.
// Each test file still declares its own `vi.mock('../../../rpc')` — mocks
// are hoisted per file and cannot live here.

import type {
  KanbanBoardSnapshot,
  KanbanEvent,
  KanbanTask,
  KanbanTaskStatus,
  LedgerEvent,
  TeamDetail,
} from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import type React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

export function installDomStubs(): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // `useKanbanBoardSync` opens an SSE stream; jsdom has no EventSource.
  class FakeEventSource {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    close(): void {}
  }
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
}

/** Fixture clock — real time at load, so `formatRelative` ages stay stable. */
export const NOW = Date.now();

export function task(
  id: string,
  title: string,
  status: KanbanTaskStatus,
  assignee: string | null,
  over: Partial<KanbanTask> = {},
): KanbanTask {
  return {
    id,
    title,
    body: '',
    status,
    assignee,
    priority: 0,
    workspaceMode: 'scratch',
    workspacePath: null,
    scheduledFor: null,
    currentRunId: null,
    retryCount: 0,
    maxRetries: null,
    acceptanceCriteria: null,
    createdAt: new Date(NOW - 3_600_000).toISOString(),
    updatedAt: new Date(NOW - 720_000).toISOString(),
    ...over,
  };
}

export function event(
  id: number,
  taskId: string,
  kind: KanbanEvent['kind'],
  actor: string,
  data: Record<string, unknown> = {},
): KanbanEvent {
  return { id, taskId, kind, actor, data, createdAt: new Date(NOW - id * 60_000).toISOString() };
}

export const TASKS: KanbanTask[] = [
  task('t-rev-001', 'Rank the angles', 'needs_revision', 'reddit-scout', {
    retryCount: 1,
    maxRetries: 3,
  }),
  task('t-blk-001', 'Draft the launch post', 'blocked', 'cmo'),
  task('t-run-001', 'Sweep r/marketing', 'running', 'reddit-scout'),
  task('t-rdy-001', 'Summarise the week', 'ready', null),
  task('t-todo-01', 'Later', 'todo', null),
  task('t-done-01', 'Shipped one', 'done', 'cmo'),
  task('t-done-02', 'Shipped two', 'done', 'reddit-scout'),
];

export const EVENTS: KanbanEvent[] = [
  event(3, 't-run-001', 'created', 'dispatcher', { status: 'ready' }),
  event(2, 't-blk-001', 'run_completed', 'cmo', {
    outcome: 'blocked',
    summary: 'waiting on legal',
  }),
  event(1, 't-rev-001', 'status_changed', 'reddit-scout', {
    from: 'running',
    to: 'needs_revision',
    reason: 'no citations for the top three',
  }),
];

export function teamDetail(over: Partial<TeamDetail> = {}): TeamDetail {
  return {
    name: 'marketing',
    description: '',
    dispatchMode: 'coordinator',
    health: 'running',
    memberCount: 2,
    runningCount: 2,
    boardModifiedAt: new Date(NOW).toISOString(),
    coordinator: 'cmo',
    members: [
      {
        personalityId: 'cmo',
        role: 'coordinator',
        tier: 'trusted',
        status: 'running',
        capabilities: [],
      },
      {
        personalityId: 'reddit-scout',
        role: 'member',
        tier: null,
        status: 'running',
        capabilities: [],
      },
    ],
    channels: [{ platform: 'slack', botKey: '#marketing' }],
    startedAt: new Date(NOW - (6 * 3600 + 12 * 60) * 1000).toISOString(),
    manifestYaml: '',
    manifestPath: '~/.ethos/teams/marketing.yaml',
    trustPolicy: { mode: 'flat' },
    kanban: { staleMs: 1_800_000, pollMs: 1_000, stalenessThresholdMs: 1_800_000 },
    memoryTopics: ['onboarding', 'decisions'],
    runtime: null,
    ...over,
  };
}

export function boardSnapshot(over: Partial<KanbanBoardSnapshot> = {}): KanbanBoardSnapshot {
  const team = teamDetail();
  return {
    team: {
      name: team.name,
      description: team.description,
      dispatchMode: team.dispatchMode,
      health: team.health,
      memberCount: team.memberCount,
      runningCount: team.runningCount,
      boardModifiedAt: team.boardModifiedAt,
    },
    tasks: TASKS,
    links: [],
    recentEvents: EVENTS,
    memberStats: [],
    ...over,
  };
}

export const LEDGER: LedgerEvent[] = [
  {
    id: 1,
    at: new Date(NOW).toISOString(),
    kind: 'verifier_rejected',
    taskId: 't-rev-001',
    taskTitle: 'Rank the angles',
    personalityId: 'reddit-scout',
    headline: 'Verifier rejected',
    detail: 'no citations for the top three · retry 1 of 3',
    severity: 'warn',
  },
  {
    id: 2,
    at: new Date(NOW - 60_000).toISOString(),
    kind: 'dispatched',
    taskId: 't-run-001',
    taskTitle: 'Sweep r/marketing',
    personalityId: 'reddit-scout',
    headline: 'Dispatch tick',
    detail: 'claimed for reddit-scout',
    severity: 'ok',
  },
];

/** Writes the current URL into the DOM so a test can read it back. */
export function LocationProbe() {
  const location = useLocation();
  return createElement('div', {
    'data-testid': 'location',
    'data-pathname': location.pathname,
    'data-search': location.search,
  });
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

export interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => Promise<void>;
}

/** Mounts `page` at `path` under `routePattern`, with a `LocationProbe` beside it. */
export async function mountPage(
  page: React.ComponentType,
  routePattern: string,
  path: string,
): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Number.POSITIVE_INFINITY } },
  });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          AntApp,
          null,
          createElement(
            MemoryRouter,
            { initialEntries: [path] },
            createElement(
              Routes,
              null,
              createElement(Route, {
                path: routePattern,
                element: createElement(
                  'div',
                  null,
                  createElement(page),
                  createElement(LocationProbe),
                ),
              }),
            ),
          ),
        ),
      ),
    );
  });
  await flush();
  return {
    container,
    root,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

export function click(el: Element | null): Promise<void> {
  if (!el) throw new Error('click target missing');
  return act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}
