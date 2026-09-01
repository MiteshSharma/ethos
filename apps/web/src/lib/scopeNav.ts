// Pure logic for P1b (plan/phases/personality-first-ui.md) — the AltitudeRail
// + ScopeNav chrome that replaces `Sidebar.tsx`. Altitude detection,
// breadcrumb labels, session-list filtering and fraction formatting are kept
// here, separate from the React components, so route/label decisions are
// unit-testable without a DOM — same split as `workspaceRoutes.ts` (P1a).

export type Altitude = 'library' | 'workspace';

/**
 * Extracts `:personalityId` from a `/p/:personalityId/…` pathname. Returns
 * `null` at the Library altitude, and for chrome-less flow routes
 * (onboarding, setup, signing-in, oauth callback) that never carry a
 * personality segment.
 */
export function extractWorkspacePersonalityId(pathname: string): string | null {
  const match = pathname.match(/^\/p\/([^/]+)\//);
  return match?.[1] ?? null;
}

/** The altitude implied by a pathname — `workspace` inside `/p/:id/…`, else
 * `library`. Drives whether the workspace `<ConfigProvider>` + `--accent`
 * wrapper (App.tsx) renders around ScopeNav + the stage. */
export function currentAltitude(pathname: string): Altitude {
  return extractWorkspacePersonalityId(pathname) ? 'workspace' : 'library';
}

// Workspace pane label, keyed by the path segment right after
// `/p/:personalityId/` — the eleven P1a routes plus chat, plus `activity`
// (plan/phases/activity-feed-fix.md Phase 4: the workspace twin of the bare
// `/activity` Library route, which stays exactly where it is).
const WORKSPACE_PANE_LABELS: Record<string, string> = {
  chat: 'Chat',
  sessions: 'Sessions',
  memory: 'Memory',
  documents: 'Documents',
  schedule: 'Schedule',
  skills: 'Skills',
  mcp: 'MCP Servers',
  plugins: 'Plugins',
  goals: 'Goals',
  tasks: 'Tasks',
  activity: 'Activity',
  identity: 'Identity',
};

// Library pane label, keyed by the pathname's first segment. "All …" prefixes
// distinguish the machine-wide list from its workspace-scoped namesake per
// the plan's "three signals" — see "The shape" in the plan doc.
const LIBRARY_PANE_LABELS: Record<string, string> = {
  personalities: 'Personalities',
  skills: 'All skills',
  plugins: 'All plugins',
  mcp: 'All servers',
  communications: 'Platforms',
  teams: 'Teams',
  kanban: 'Kanban',
  mesh: 'Mesh',
  activity: 'Activity',
  dashboards: 'Dashboards',
  batch: 'Batch',
  eval: 'Eval',
  admin: 'Admin',
  settings: 'Settings',
  personality: 'Create agent',
};

// `/library/<segment>` — nested Library-altitude destinations, keyed by the
// segment AFTER `library/`: `/library/cron` (P2's system-cron split) plus
// `/library/sessions` and `/library/tasks` (P3's twins — Skills/MCP/Plugins
// keep their pre-P3 bare-route Library addresses, see `LIBRARY_PANE_LABELS`
// above, so they don't need an entry here). The bare top-level `cron` key
// doesn't belong in `LIBRARY_PANE_LABELS` above — `/cron` itself never
// renders this breadcrumb, it's a permanent redirect into a workspace (P1a),
// so by the time `pathname` reaches this function it's already
// `/p/:id/schedule`.
const LIBRARY_NESTED_PANE_LABELS: Record<string, string> = {
  cron: 'System cron',
  sessions: 'All sessions',
  tasks: 'All tasks',
};

// Flow routes — "unchanged, flows not destinations" per the plan's route
// map. No breadcrumb renders over onboarding, setup steps, the signing-in
// placeholder, or the OAuth callback.
const CHROMELESS_PREFIXES = ['/onboarding', '/setup', '/signing-in', '/oauth'];

function isChromeless(pathname: string): boolean {
  return CHROMELESS_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export interface Breadcrumb {
  altitude: Altitude;
  /** "Engineer" or "Library" — the ring glyph is rendered by the component,
   *  not baked into this string, so screen readers and any future styling
   *  don't see it twice. */
  scopeLabel: string;
  paneLabel: string;
}

/**
 * Resolves the stage-header breadcrumb for the current route: `{scope} /
 * {pane}`. `workspacePersonalityName` is the already-resolved display name
 * (falls back to the capitalized id when the roster hasn't loaded yet) —
 * this function does no lookups of its own.
 */
export function resolveBreadcrumb(
  pathname: string,
  workspacePersonalityName: string | null,
): Breadcrumb | null {
  if (isChromeless(pathname)) return null;

  const personalityId = extractWorkspacePersonalityId(pathname);
  if (personalityId) {
    const rest = pathname.slice(`/p/${personalityId}/`.length);
    const segment = rest.split('/')[0] ?? '';
    return {
      altitude: 'workspace',
      scopeLabel: workspacePersonalityName ?? capitalize(personalityId),
      paneLabel: WORKSPACE_PANE_LABELS[segment] ?? capitalize(segment || 'chat'),
    };
  }

  const segment = pathname.split('/')[1] ?? '';
  if (segment === 'library') {
    const nested = pathname.split('/')[2] ?? '';
    return {
      altitude: 'library',
      scopeLabel: 'Library',
      paneLabel: LIBRARY_NESTED_PANE_LABELS[nested] ?? 'Library',
    };
  }
  return {
    altitude: 'library',
    scopeLabel: 'Library',
    paneLabel: LIBRARY_PANE_LABELS[segment] ?? 'Library',
  };
}

/** Capitalizes the first character. Used as the display-name fallback while
 * the personality roster is still loading, or for an id with no name. */
export function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** "3 / 8", or `null` when either side isn't loaded yet — the row hint is
 * simply omitted rather than showing a misleading "0 / 0". */
export function formatFraction(
  attached: number | null | undefined,
  total: number | null | undefined,
): string | null {
  if (attached == null || total == null) return null;
  return `${attached} / ${total}`;
}

// --- Session block (lifted from Sidebar.tsx) --------------------------------

export interface RecentSessionRow {
  id: string;
  title: string | null;
  key: string;
  personalityId: string | null;
  updatedAt: string;
  pinned: boolean;
}

export interface FilteredSessions {
  pinned: RecentSessionRow[];
  unpinned: RecentSessionRow[];
}

/**
 * Filters the recent-sessions list by a free-text substring match on
 * title-or-key, split into pinned / unpinned — additionally scoped to
 * `activePersonalityId` when given.
 *
 * `activePersonalityId` is the current WORKSPACE's personality (`null` at
 * the Library altitude — see `extractWorkspacePersonalityId`), not a filter
 * toggle: inside a workspace, both PINNED and SESSIONS show only that
 * agent's sessions; at the Library altitude the full, unscoped, cross-agent
 * list still appears.
 *
 * This reverses P1b's original decision (plan/phases/personality-first-ui.md
 * — "All sessions, not filtered by the active workspace personality — same
 * as today"), per explicit user direction after seeing the unscoped version
 * work in practice: a workspace's session column is expected to answer
 * "this agent's conversations", matching the pane's own Sessions page, not
 * "where was I across every agent" — that view still exists, just one
 * altitude up.
 */
export function filterRecentSessions(
  sessions: RecentSessionRow[],
  query: string,
  activePersonalityId: string | null,
): FilteredSessions {
  const q = query.trim().toLowerCase();
  const matchesQuery = (s: RecentSessionRow) => !q || (s.title ?? s.key).toLowerCase().includes(q);
  const matchesScope = (s: RecentSessionRow) =>
    activePersonalityId === null || s.personalityId === activePersonalityId;
  const filtered = sessions.filter((s) => matchesScope(s) && matchesQuery(s));
  return {
    pinned: filtered.filter((s) => s.pinned),
    unpinned: filtered.filter((s) => !s.pinned),
  };
}
