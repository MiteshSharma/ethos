import type {
  KanbanBoardSnapshot,
  KanbanTask,
  LedgerEvent,
  Personality,
  TeamDetail,
} from '@ethosagent/web-contracts';

// Shared fixtures for the team-pane tests (teams-as-a-scope T2): the
// prototype's `marketing` team — a coordinator and three scouts, one
// running, one blocked, one offline — with a board and a personality list.

export function installDomShims(): void {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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
}

export const NOW = new Date('2026-09-04T13:42:00Z');

export const TEAM: TeamDetail = {
  name: 'marketing',
  description: 'Finds where to talk about Ethos this week. Drafts, never posts.',
  dispatchMode: 'coordinator',
  health: 'running',
  memberCount: 4,
  runningCount: 3,
  boardModifiedAt: NOW.toISOString(),
  coordinator: 'cmo',
  members: [
    {
      personalityId: 'cmo',
      role: 'coordinator',
      tier: 'trusted',
      status: 'running',
      capabilities: ['ranking', 'approval'],
    },
    {
      personalityId: 'reddit-scout',
      role: 'member',
      tier: 'standard',
      status: 'running',
      capabilities: [],
    },
    {
      personalityId: 'linkedin-scout',
      role: 'member',
      tier: 'standard',
      status: 'running',
      capabilities: [],
    },
    {
      personalityId: 'x-scout',
      role: 'member',
      tier: 'probationary',
      status: 'offline',
      capabilities: [],
    },
  ],
  channels: [{ platform: 'slack', botKey: 'slack:marketing' }],
  startedAt: new Date(NOW.getTime() - 6 * 3_600_000).toISOString(),
  manifestYaml: 'name: marketing\ndispatch_mode: coordinator\ncoordinator: cmo\n',
  manifestPath: '~/.ethos/teams/marketing.yaml',
  trustPolicy: { mode: 'flat' },
  kanban: { staleMs: 1_800_000, pollMs: 1_000, stalenessThresholdMs: 1_800_000 },
  memoryTopics: ['onboarding', 'decisions'],
  runtime: {
    supervisorPid: 48211,
    startedAt: new Date(NOW.getTime() - 6 * 3_600_000).toISOString(),
    members: [],
  },
};

function task(over: Partial<KanbanTask> & Pick<KanbanTask, 'id' | 'title' | 'status'>): KanbanTask {
  return {
    body: '',
    assignee: null,
    priority: 0,
    workspaceMode: 'scratch',
    workspacePath: null,
    scheduledFor: null,
    currentRunId: null,
    retryCount: 0,
    maxRetries: 3,
    acceptanceCriteria: null,
    createdAt: NOW.toISOString(),
    updatedAt: new Date(NOW.getTime() - 12 * 60_000).toISOString(),
    ...over,
  };
}

export const TASKS: KanbanTask[] = [
  task({
    id: '41aaaaaa-0000',
    title: 'Scan r/LocalLLaMA for launch threads',
    status: 'running',
    assignee: 'reddit-scout',
  }),
  task({
    id: '38bbbbbb-0000',
    title: 'X launch-thread search',
    status: 'blocked',
    assignee: 'x-scout',
  }),
  task({
    id: '37cccccc-0000',
    title: 'Founder list refresh',
    status: 'done',
    assignee: 'linkedin-scout',
  }),
];

export const BOARD: KanbanBoardSnapshot = {
  team: {
    name: 'marketing',
    description: TEAM.description,
    dispatchMode: 'coordinator',
    health: 'running',
    memberCount: 4,
    runningCount: 3,
    boardModifiedAt: NOW.toISOString(),
  },
  tasks: TASKS,
  links: [],
  recentEvents: [],
  memberStats: [
    {
      teamId: 'marketing',
      memberId: 'reddit-scout',
      ticketsCompleted: 12,
      ticketsFailed: 1,
      ticketsOrphaned: 1,
      lastUpdatedAt: NOW.toISOString(),
    },
  ],
};

function personality(id: string, over: Partial<Personality> = {}): Personality {
  return {
    id,
    name: id,
    description: `${id} description`,
    model: 'claude-sonnet-4-6',
    provider: null,
    toolset: [
      'web_search',
      'read_file',
      'write_file',
      'kanban_list',
      'kanban_claim',
      'team_memory_read',
    ],
    capabilities: ['signals'],
    streamingTimeoutMs: null,
    mcp_servers: null,
    plugins: null,
    fs_reach: null,
    system: false,
    builtin: false,
    version: 1,
    ...over,
  };
}

/** `x-scout` is deliberately absent — its directory is "missing". */
export const PERSONALITIES = {
  items: [
    personality('cmo', {
      description: 'Ranks and approves.',
      fs_reach: { read: null, write: null, workdir: ['teams/marketing/**'] },
    }),
    personality('reddit-scout'),
    personality('linkedin-scout'),
  ],
  nextCursor: null,
  defaultId: 'cmo',
};

export const LEDGER: LedgerEvent[] = [
  {
    id: 1,
    at: NOW.toISOString(),
    kind: 'status_changed',
    taskId: '41aaaaaa-0000',
    taskTitle: 'Scan r/LocalLLaMA for launch threads',
    personalityId: 'reddit-scout',
    headline: 'Dispatch tick',
    detail: '#41aaaaaa claimed for reddit-scout',
    severity: 'ok',
  },
];
