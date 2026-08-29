// P5 (plan/phases/personality-first-ui.md) — "Per-list create actions": one
// registry mapping pane → its create verb, rendered once by
// `StageHeader.tsx`. This module never opens a modal itself — it only
// resolves *which* action applies to the current route and *where* the
// button should navigate. The target page owns its own existing create
// trigger (modal / inline section / route) and opens it itself, either
// because the destination IS the trigger (`kind: 'navigate'`) or because the
// page notices `?create=1` on mount and flips its own `setXOpen(true)` (see
// `useCreateFlag` in `../hooks/useCreateFlag`).
//
// Segment extraction mirrors `resolveBreadcrumb` in `./scopeNav` — workspace:
// `extractWorkspacePersonalityId` then the segment right after it; library:
// the first path segment, or the segment after `/library/`. Reuses
// `extractWorkspacePersonalityId` directly rather than re-deriving it.

import { extractWorkspacePersonalityId } from './scopeNav';

/** Query param name for the "open your create UI" signal a `kind:
 *  'query-flag'` action's href carries. Shared so `useCreateFlag` reads the
 *  exact key this module writes. */
export const CREATE_FLAG_PARAM = 'create';

export interface CreateAction {
  id: string;
  /** Verb shown on the stage-header button, e.g. "+ New Skill". */
  label: string;
  /** 'navigate' — the destination page IS the create flow (e.g. Dashboards'
   *  own `/dashboards/create` route). 'query-flag' — the destination is the
   *  pane's own list page; it opens its existing modal/section itself when
   *  it sees `?create=1`. */
  kind: 'navigate' | 'query-flag';
  /** Destination path. May embed the literal substring '{id}' as a
   *  workspace personalityId placeholder, e.g. '/p/{id}/sessions'. */
  path: string;
  altitude: 'library' | 'workspace';
}

export const CREATE_ACTIONS: CreateAction[] = [
  {
    id: 'personalities',
    label: '+ New Personality',
    kind: 'query-flag',
    path: '/personalities',
    altitude: 'library',
  },
  {
    id: 'skills',
    label: '+ New Skill',
    kind: 'query-flag',
    path: '/skills',
    altitude: 'library',
  },
  {
    id: 'mcp',
    label: '+ New MCP Server',
    kind: 'query-flag',
    path: '/mcp',
    altitude: 'library',
  },
  {
    id: 'plugins',
    label: '+ New Plugin',
    kind: 'query-flag',
    path: '/plugins',
    altitude: 'library',
  },
  {
    id: 'batch',
    label: 'New batch',
    kind: 'query-flag',
    path: '/batch',
    altitude: 'library',
  },
  {
    id: 'eval',
    label: 'New eval',
    kind: 'query-flag',
    path: '/eval',
    altitude: 'library',
  },
  {
    id: 'dashboards',
    label: 'Create Dashboard',
    kind: 'navigate',
    path: '/dashboards/create',
    altitude: 'library',
  },
  {
    id: 'teams',
    label: 'New team',
    kind: 'navigate',
    path: '/teams/create',
    altitude: 'library',
  },
  {
    id: 'sessions-library',
    // "All sessions" — same target as the workspace twin below: Sessions.tsx's
    // own "New Session" button already resolves to `/chat` when there's no
    // active workspace personality. No modal to flag-open; the button IS the
    // navigation.
    label: 'New Session',
    kind: 'navigate',
    path: '/chat',
    altitude: 'library',
  },
  {
    id: 'sessions-workspace',
    label: 'New Session',
    kind: 'navigate',
    path: '/p/{id}/chat',
    altitude: 'workspace',
  },
  {
    id: 'schedule-workspace',
    label: 'New job',
    kind: 'query-flag',
    path: '/p/{id}/schedule',
    altitude: 'workspace',
  },
];

const ACTIONS_BY_ID = new Map(CREATE_ACTIONS.map((action) => [action.id, action]));

// Workspace pane segment (the path element right after `/p/:personalityId/`)
// → CreateAction id. Panes with no entry here (chat, memory, documents,
// skills, mcp, plugins — attach/detach, not create — goals, tasks, identity)
// deliberately have no workspace create action.
const WORKSPACE_CREATE_ACTION_IDS: Record<string, string> = {
  sessions: 'sessions-workspace',
  schedule: 'schedule-workspace',
};

// Library top-level path segment → CreateAction id. Kanban is deliberately
// absent — see the note on `Kanban.tsx`'s create button in the P5 brief:
// its "New task" modal only renders with a team already selected, so a
// stage-header shortcut that force-opens it before a team is picked would
// silently do nothing.
const LIBRARY_CREATE_ACTION_IDS: Record<string, string> = {
  personalities: 'personalities',
  skills: 'skills',
  mcp: 'mcp',
  plugins: 'plugins',
  batch: 'batch',
  eval: 'eval',
  dashboards: 'dashboards',
  teams: 'teams',
};

// `/library/<segment>` → CreateAction id. `/library/cron` (system cron) and
// `/library/tasks` are deliberately absent — no create verb applies.
const LIBRARY_NESTED_CREATE_ACTION_IDS: Record<string, string> = {
  sessions: 'sessions-library',
};

/** The one CreateAction that applies to the CURRENT route, or null if this
 *  pane has none (Chat, Identity, Memory, Documents, Goals, Tasks, and any
 *  workspace attach-only pane — see the comments on the lookup tables
 *  above). */
export function createActionForPathname(pathname: string): CreateAction | null {
  const personalityId = extractWorkspacePersonalityId(pathname);
  if (personalityId) {
    const rest = pathname.slice(`/p/${personalityId}/`.length);
    const segment = rest.split('/')[0] ?? '';
    const id = WORKSPACE_CREATE_ACTION_IDS[segment];
    return id ? (ACTIONS_BY_ID.get(id) ?? null) : null;
  }

  const segment = pathname.split('/')[1] ?? '';
  if (segment === 'library') {
    const nested = pathname.split('/')[2] ?? '';
    const id = LIBRARY_NESTED_CREATE_ACTION_IDS[nested];
    return id ? (ACTIONS_BY_ID.get(id) ?? null) : null;
  }

  const id = LIBRARY_CREATE_ACTION_IDS[segment];
  return id ? (ACTIONS_BY_ID.get(id) ?? null) : null;
}

/** Resolves a CreateAction to a concrete href, substituting '{id}' with the
 *  given workspace personalityId. For a workspace action with no id
 *  available, returns null (caller shouldn't render the button). For
 *  kind: 'query-flag', appends `?create=1` (via CREATE_FLAG_PARAM) to the
 *  resolved path. */
export function createActionHref(
  action: CreateAction,
  personalityId: string | null,
): string | null {
  let path: string;
  if (action.path.includes('{id}')) {
    if (!personalityId) return null;
    path = action.path.replace('{id}', personalityId);
  } else {
    path = action.path;
  }

  if (action.kind === 'query-flag') {
    return `${path}?${CREATE_FLAG_PARAM}=1`;
  }
  return path;
}
