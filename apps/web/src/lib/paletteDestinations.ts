// Pure logic for P5 (plan/phases/personality-first-ui.md) item 3 — the ⌘K
// palette's "Agents" and "Pages" groups, plus the create-action registry
// surfaced as "Actions". Kept separate from `CommandPalette.tsx` so the
// destination list is unit-testable without a DOM — same split as
// `scopeNav.ts` / `workspaceRoutes.ts` / `createActions.ts`.

import { CREATE_ACTIONS, createActionHref } from './createActions';

export interface PaletteEntry {
  id: string;
  group: 'Agents' | 'Pages' | 'Actions';
  label: string;
  /** Destination path (may include a query string, e.g. a `?create=1` create
   *  action) — `CommandPalette.tsx` wraps this in `navigate()`. */
  path: string;
  /** Subtle right-aligned hint — the destination path for a library entry,
   *  the target agent's name for a workspace entry. */
  hint?: string;
  keywords: string[];
}

interface AgentSummary {
  id: string;
  name: string;
  description?: string | null;
}

/** "Agents" group — jump straight to an agent's Chat, its workspace home. */
export function agentEntries(agents: readonly AgentSummary[]): PaletteEntry[] {
  return agents.map((p) => ({
    id: `agent:${p.id}`,
    group: 'Agents',
    label: p.name,
    path: `/p/${p.id}/chat`,
    hint: 'Chat',
    keywords: [p.id, ...(p.description ? [p.description] : [])],
  }));
}

/** Library (machine-wide) destinations — context-free, same address
 *  regardless of which agent you're currently with. `adminEnabled` gates
 *  Admin the same way `ScopeNav`'s Advanced disclosure does. Each row's hint
 *  is its own path (there's no agent to name at this altitude). */
export function libraryPageEntries(adminEnabled: boolean): PaletteEntry[] {
  const entries: PaletteEntry[] = [
    {
      id: 'page:/chat',
      group: 'Pages',
      label: 'Chat',
      path: '/chat',
      keywords: ['talk', 'message', 'agent'],
    },
    {
      id: 'page:/library/sessions',
      group: 'Pages',
      label: 'All sessions',
      path: '/library/sessions',
      keywords: ['history', 'past', 'fts', 'sessions'],
    },
    {
      id: 'page:/library/cron',
      group: 'Pages',
      label: 'System cron',
      path: '/library/cron',
      keywords: ['schedule', 'job', 'digest', 'watchers'],
    },
    {
      id: 'page:/skills',
      group: 'Pages',
      label: 'All skills',
      path: '/skills',
      keywords: ['library', 'evolver', 'skills'],
    },
    {
      id: 'page:/mcp',
      group: 'Pages',
      label: 'All servers',
      path: '/mcp',
      keywords: ['mcp', 'servers', 'tools'],
    },
    {
      id: 'page:/plugins',
      group: 'Pages',
      label: 'All plugins',
      path: '/plugins',
      keywords: ['mcp', 'install', 'tools', 'plugins'],
    },
    {
      id: 'page:/library/tasks',
      group: 'Pages',
      label: 'All tasks',
      path: '/library/tasks',
      keywords: ['background', 'jobs', 'unscoped', 'tasks'],
    },
    {
      id: 'page:/mesh',
      group: 'Pages',
      label: 'Mesh',
      path: '/mesh',
      keywords: ['swarm', 'agents', 'route'],
    },
    {
      id: 'page:/settings',
      group: 'Pages',
      label: 'Settings',
      path: '/settings',
      keywords: ['config', 'provider', 'model', 'key'],
    },
    {
      id: 'page:/communications',
      group: 'Pages',
      label: 'Platforms',
      path: '/communications',
      keywords: ['telegram', 'slack', 'discord', 'email', 'comms', 'communications'],
    },
    {
      id: 'page:/personalities',
      group: 'Pages',
      label: 'Personalities',
      path: '/personalities',
      keywords: ['agent', 'identity', 'wizard', 'duplicate', 'roster'],
    },
    {
      id: 'page:/batch',
      group: 'Pages',
      label: 'Batch',
      path: '/batch',
      keywords: ['lab', 'jsonl', 'tasks', 'bulk'],
    },
    {
      id: 'page:/eval',
      group: 'Pages',
      label: 'Eval',
      path: '/eval',
      keywords: ['lab', 'score', 'expected', 'judge'],
    },
    {
      id: 'page:/dashboards',
      group: 'Pages',
      label: 'Dashboards',
      path: '/dashboards',
      keywords: ['charts', 'metrics', 'widgets'],
    },
    {
      id: 'page:/teams',
      group: 'Pages',
      label: 'Teams',
      path: '/teams',
      keywords: ['team', 'members', 'supervisor'],
    },
    {
      id: 'page:/kanban',
      group: 'Pages',
      label: 'Kanban',
      path: '/kanban',
      keywords: ['board', 'tasks', 'team'],
    },
    {
      id: 'page:/activity',
      group: 'Pages',
      label: 'Activity',
      path: '/activity',
      keywords: ['stream', 'events', 'log'],
    },
  ];
  if (adminEnabled) {
    entries.push({
      id: 'page:/admin',
      group: 'Pages',
      label: 'Admin',
      path: '/admin',
      keywords: ['ops', 'system'],
    });
  }
  return entries.map((e) => ({ ...e, hint: e.path }));
}

const WORKSPACE_PANES: { label: string; pane: string; keywords: string[] }[] = [
  { label: 'Sessions', pane: 'sessions', keywords: ['history', 'past'] },
  { label: 'Memory', pane: 'memory', keywords: ['notes', 'context', 'user', 'remember'] },
  {
    label: 'Documents',
    pane: 'documents',
    keywords: ['files', 'workdir', 'download', 'artifacts'],
  },
  { label: 'Schedule', pane: 'schedule', keywords: ['cron', 'job'] },
  { label: 'Skills', pane: 'skills', keywords: ['attached'] },
  { label: 'MCP Servers', pane: 'mcp', keywords: ['attached', 'servers'] },
  { label: 'Plugins', pane: 'plugins', keywords: ['attached'] },
  { label: 'Goals', pane: 'goals', keywords: ['objective', 'target'] },
  { label: 'Tasks', pane: 'tasks', keywords: ['background', 'jobs'] },
  { label: 'Identity', pane: 'identity', keywords: ['soul', 'character', 'sheet'] },
];

/**
 * Workspace destinations with no Library twin (Schedule, Memory, Documents,
 * Goals, Tasks, Identity, workspace Skills/MCP/Plugins) — resolved through
 * the SAME fallback chain `/` and `/chat` use (last-visited agent, else the
 * config default), so they're always present and findable regardless of
 * which altitude the palette opened from. `fallbackPersonalityName` becomes
 * the row's hint, naming which agent it lands you in.
 */
export function workspacePageEntries(
  fallbackPersonalityId: string,
  fallbackPersonalityName: string,
): PaletteEntry[] {
  return WORKSPACE_PANES.map((p) => ({
    id: `page:workspace:${p.pane}`,
    group: 'Pages',
    label: p.label,
    path: `/p/${fallbackPersonalityId}/${p.pane}`,
    hint: fallbackPersonalityName,
    keywords: p.keywords,
  }));
}

/**
 * The per-pane create actions from `createActions.ts` (StageHeader's
 * registry, P5 item 2), surfaced as palette Actions. Sessions' two registry
 * entries ('sessions-library' / 'sessions-workspace') are deliberately
 * excluded — the palette's own "New chat session" action already covers
 * that intent through the picker modal, and both would otherwise resolve to
 * the same fallback agent's Chat as a second, redundant "New Session".
 */
export function createActionEntries(
  fallbackPersonalityId: string,
  fallbackPersonalityName: string,
): PaletteEntry[] {
  return CREATE_ACTIONS.filter((a) => a.id !== 'sessions-library' && a.id !== 'sessions-workspace')
    .map((a): PaletteEntry | null => {
      const href = createActionHref(a, fallbackPersonalityId);
      if (!href) return null;
      return {
        id: `create:${a.id}`,
        group: 'Actions',
        label: a.label,
        path: href,
        hint: a.altitude === 'workspace' ? fallbackPersonalityName : undefined,
        keywords: ['new', 'create'],
      };
    })
    .filter((e): e is PaletteEntry => e !== null);
}
