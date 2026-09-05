// Pure logic for P1b (plan/phases/personality-first-ui.md) — the AltitudeRail
// + ScopeNav chrome that replaces `Sidebar.tsx`. Altitude detection,
// breadcrumb labels, session-list filtering and fraction formatting are kept
// here, separate from the React components, so route/label decisions are
// unit-testable without a DOM — same split as `workspaceRoutes.ts` (P1a).
//
// T1 of plan/phases/teams-as-a-scope.md adds the third altitude: a team is a
// place at `/t/:teamId/*`, and a member's workspace inside it is
// `/t/:teamId/p/:personalityId/*` (§1 "The scope model").

export type Altitude = 'library' | 'workspace' | 'team';

// `/t/:teamId` with or without a trailing segment. Shared by the two
// extractors below so the team prefix is spelled once.
const TEAM_PREFIX = /^\/t\/([^/]+)(?:\/|$)/;

/**
 * Extracts `:teamId` from a `/t/:teamId/…` pathname (bare `/t/:teamId` too).
 * Returns `null` at the Library altitude and inside an independent workspace.
 */
export function extractTeamId(pathname: string): string | null {
  const match = pathname.match(TEAM_PREFIX);
  return match?.[1] ?? null;
}

/**
 * Extracts `:personalityId` from a `/p/:personalityId/…` pathname, or from
 * the team-prefixed form `/t/:teamId/p/:personalityId/…` (D6/D9 — the accent
 * wrapper, session filter and fraction counts all key off this, so the one
 * extractor learning the prefix is what keeps them working inside a team).
 * Returns `null` at the Library and team altitudes, and for chrome-less flow
 * routes (onboarding, setup, signing-in, oauth callback) that never carry a
 * personality segment.
 */
export function extractWorkspacePersonalityId(pathname: string): string | null {
  const match = pathname.match(/^(?:\/t\/[^/]+)?\/p\/([^/]+)(?:\/|$)/);
  return match?.[1] ?? null;
}

/** The altitude implied by a pathname — `workspace` inside `/p/:id/…` (with
 * or without a `/t/:teamId` prefix), `team` inside `/t/:teamId/…` with no
 * `/p/` segment, else `library`. Drives whether the workspace
 * `<ConfigProvider>` + `--accent` wrapper (App.tsx) renders around ScopeNav +
 * the stage. */
export function currentAltitude(pathname: string): Altitude {
  if (extractWorkspacePersonalityId(pathname)) return 'workspace';
  if (extractTeamId(pathname)) return 'team';
  return 'library';
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

export type TeamPaneKey =
  | 'chat'
  | 'overview'
  | 'board'
  | 'structure'
  | 'memory'
  | 'activity'
  | 'channels'
  | 'settings';

/**
 * The team's contextual column, in row order (plan §3). `key` is the path
 * segment right after `/t/:teamId/`; `label` is both the row text and the
 * breadcrumb's pane crumb.
 */
export const TEAM_PANES: ReadonlyArray<{ key: TeamPaneKey; label: string }> = [
  { key: 'chat', label: 'Chat' },
  { key: 'overview', label: 'Overview' },
  { key: 'board', label: 'Board' },
  { key: 'structure', label: 'Structure' },
  { key: 'memory', label: 'Memory' },
  { key: 'activity', label: 'Activity' },
  { key: 'channels', label: 'Channels' },
  { key: 'settings', label: 'Settings' },
];

// Team pane label, keyed by the segment after `/t/:teamId/`. Derived from
// `TEAM_PANES` so the column and the breadcrumb can never disagree.
const TEAM_PANE_LABELS: Record<string, string> = Object.fromEntries(
  TEAM_PANES.map((p) => [p.key, p.label]),
);

// Library pane label, keyed by the pathname's first segment. "All …" prefixes
// distinguish the machine-wide list from its workspace-scoped namesake per
// the plan's "three signals" — see "The shape" in the plan doc.
const LIBRARY_PANE_LABELS: Record<string, string> = {
  personalities: 'Personalities',
  recipes: 'Recipes',
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
  /**
   * The ROOT crumb — the scope you are standing in. "Library" at the Library
   * altitude (the component renders it as "Independent", D2), the team name
   * at the team altitude AND inside a member's workspace within a team (the
   * team stays the root, D6), or the agent name in an independent workspace.
   * The ring / annulus / mark glyph is rendered by the component, not baked
   * into this string, so screen readers and any future styling don't see it
   * twice. There is deliberately no separate `teamLabel`: whenever a team is
   * in scope it IS the root crumb, so a second field would either duplicate
   * `scopeLabel` or be undefined.
   */
  scopeLabel: string;
  /**
   * The MIDDLE crumb, present only for a workspace inside a team — the
   * member's display name, so the header renders `team ▾ / agent / Pane`.
   * Absent everywhere else (an independent workspace's agent is already the
   * root crumb).
   */
  personalityLabel?: string;
  paneLabel: string;
}

/**
 * Resolves the stage-header breadcrumb for the current route: `{scope} /
 * {pane}`, or `{team} / {agent} / {pane}` for a workspace inside a team.
 * `workspacePersonalityName` and `teamName` are the already-resolved display
 * names (each falls back to the capitalized id when its roster hasn't loaded
 * yet) — this function does no lookups of its own.
 */
export function resolveBreadcrumb(
  pathname: string,
  workspacePersonalityName: string | null,
  teamName?: string | null,
): Breadcrumb | null {
  if (isChromeless(pathname)) return null;

  const teamId = extractTeamId(pathname);
  const personalityId = extractWorkspacePersonalityId(pathname);
  if (personalityId) {
    const prefix = teamId ? `/t/${teamId}/p/${personalityId}` : `/p/${personalityId}`;
    const segment = pathname.slice(prefix.length).split('/')[1] ?? '';
    const paneLabel = WORKSPACE_PANE_LABELS[segment] ?? capitalize(segment || 'chat');
    const personalityLabel = workspacePersonalityName ?? capitalize(personalityId);
    if (teamId) {
      return {
        altitude: 'workspace',
        scopeLabel: teamName ?? capitalize(teamId),
        personalityLabel,
        paneLabel,
      };
    }
    return { altitude: 'workspace', scopeLabel: personalityLabel, paneLabel };
  }

  if (teamId) {
    const segment = pathname.slice(`/t/${teamId}`.length).split('/')[1] ?? '';
    return {
      altitude: 'team',
      scopeLabel: teamName ?? capitalize(teamId),
      paneLabel: TEAM_PANE_LABELS[segment] ?? capitalize(segment || 'overview'),
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
 * `activePersonalityId` when given, else to `memberIds` when given.
 *
 * `activePersonalityId` is the current WORKSPACE's personality (`null` at
 * the Library and team altitudes — see `extractWorkspacePersonalityId`), not
 * a filter toggle: inside a workspace, both PINNED and SESSIONS show only
 * that agent's sessions; at the Library altitude the full, unscoped,
 * cross-agent list still appears.
 *
 * `memberIds` is the team's roster at the team altitude (`RECENT IN <TEAM>`,
 * plan §3): with no active workspace, only sessions owned by a member are
 * kept — a session with no personality is never a team session. It is
 * ignored while `activePersonalityId` is set, because a member's workspace
 * inside a team still answers "this agent's conversations".
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
  memberIds?: ReadonlySet<string>,
): FilteredSessions {
  const q = query.trim().toLowerCase();
  const matchesQuery = (s: RecentSessionRow) => !q || (s.title ?? s.key).toLowerCase().includes(q);
  const matchesScope = (s: RecentSessionRow) => {
    if (activePersonalityId !== null) return s.personalityId === activePersonalityId;
    if (memberIds) return s.personalityId !== null && memberIds.has(s.personalityId);
    return true;
  };
  const filtered = sessions.filter((s) => matchesScope(s) && matchesQuery(s));
  return {
    pinned: filtered.filter((s) => s.pinned),
    unpinned: filtered.filter((s) => !s.pinned),
  };
}
