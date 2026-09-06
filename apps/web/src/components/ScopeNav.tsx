import { useQuery } from '@tanstack/react-query';
import { Input, Modal } from 'antd';
import { type ReactNode, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useConfig } from '../features/config/api/queries';
import { useDocumentsList } from '../features/documents/api/queries';
import { kanbanKeys } from '../features/kanban/api/keys';
import {
  usePersonalityList,
  usePersonalitySkillsList,
} from '../features/personalities/api/queries';
import { useSessionRename } from '../features/sessions/api/mutations';
import { useRecentSessions } from '../features/sessions/api/queries';
import { useTeam, useTeamsList } from '../features/teams/api/queries';
import { teamAccents } from '../features/teams/lib/membership';
import { useNewSessionModal } from '../hooks/useNewSessionModal';
import { buildNewSessionPath } from '../lib/newSessionPicker';
import {
  capitalize,
  extractTeamId,
  extractWorkspacePersonalityId,
  filterRecentSessions,
  formatFraction,
  type RecentSessionRow,
  TEAM_PANES,
  type TeamPaneKey,
} from '../lib/scopeNav';
import { buildTeamPath, sessionOpenPath } from '../lib/workspaceRoutes';
import { rpc } from '../rpc';
import { SessionContextMenu } from './SessionContextMenu';
import { NavIcon, type NavIconKey } from './ui/NavIcon';
import { PersonalityMark } from './ui/PersonalityMark';
import { PersonalityRingAvatar } from './ui/PersonalityRingAvatar';
import { TeamRing } from './ui/TeamRing';

// P1b — plan/phases/personality-first-ui.md. The 216px contextual column,
// replacing `Sidebar.tsx`'s rendered role (that file stays on disk,
// unrendered, until P6 deletes it alongside its now-unused CSS). Present at
// every altitude:
//
//   • Library  (no personality, no team) — identity line "Library", grouped
//     rows to the machine-wide destinations P1a already serves, an
//     `Advanced` disclosure (dashboards / batch / eval / admin / settings /
//     system cron).
//   • Workspace (personalityId set)     — identity line = agent name,
//     the eleven P1a workspace routes, `n / N` fractions on
//     Skills/MCP/Plugins only. Inside a team (teams-as-a-scope T1, D6) the
//     same column with a `← <team>` row above the identity line, and every
//     row under the `/t/:teamId/p/:id/` prefix.
//   • Team (teamId set, no personality) — plan §3: identity line = ring +
//     team name + `<dispatch> · N members`, Chat `via <coordinator>`, a
//     divider, then Overview … Settings with counts, then
//     `RECENT IN <TEAM>` — the sessions block filtered to the members.
//
// The session block below is a lift, not a rebuild: same `useRecentSessions`
// hook, same context menu, same rename modal — but SCOPED to the active
// workspace's personality (P2, reversing P1b's original "unscoped at both
// altitudes" decision per explicit user direction — see `filterRecentSessions`
// in `lib/scopeNav.ts`), or to the team's members at the team altitude. Only
// at the Library altitude does the full, cross-agent list still appear.

const SIDEBAR_SESSION_LIMIT = 20;

/**
 * D25 — the numeric "needs you" badge lives on the Tasks ROW, at both
 * altitudes (workspace and Library "All tasks"), never on a global sidebar.
 * `ScopeNav` replaced `Sidebar.tsx`; baking a Sidebar selector here would tie
 * the badge to chrome that no longer exists.
 */
export function ScopeNav({ needsYouCount = 0 }: { needsYouCount?: number }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const personalityId = extractWorkspacePersonalityId(pathname);
  const teamId = extractTeamId(pathname);
  const teamAltitude = teamId !== null && personalityId === null;
  const [searchParams] = useSearchParams();
  const activeSessionId = searchParams.get('session');
  const { openNewSessionModal } = useNewSessionModal();
  const [sessionSearch, setSessionSearch] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [menu, setMenu] = useState<{
    session: RecentSessionRow;
    position: { x: number; y: number };
  } | null>(null);
  const [renaming, setRenaming] = useState<RecentSessionRow | null>(null);

  const openContextMenu = (e: React.MouseEvent, session: RecentSessionRow) => {
    setMenu({ session, position: { x: e.clientX, y: e.clientY } });
  };

  const { data: sessionsData } = useRecentSessions(SIDEBAR_SESSION_LIMIT);
  const { data: config } = useConfig();
  const { data: personalitiesData } = usePersonalityList();
  const activePersonality = personalitiesData?.items.find((p) => p.id === personalityId) ?? null;

  // The team in scope — at the team altitude AND inside a member's
  // workspace (the back row needs its name). `teams.list` is already
  // polled by the rail and the breadcrumb; this is the same cache entry.
  const { data: teamsData } = useTeamsList({ enabled: teamId !== null });
  const team = teamId ? (teamsData?.items.find((t) => t.name === teamId) ?? null) : null;
  // Team-altitude counts: topic count from `teams.get`, the needs-you count
  // from the board (`needs_revision` + `blocked`, D11). Both off outside
  // the team column so a member's workspace doesn't poll them.
  const teamDetail = useTeam(teamId ?? '', { enabled: teamAltitude });
  const boardQuery = useQuery({
    queryKey: kanbanKeys.board(teamId ?? ''),
    queryFn: () => rpc.kanban.getBoard({ team: teamId ?? '' }),
    enabled: teamAltitude,
    refetchInterval: 5_000,
    retry: false,
  });
  const boardNeedsYou =
    boardQuery.data?.board.tasks.filter(
      (t) => t.status === 'needs_revision' || t.status === 'blocked',
    ).length ?? 0;
  // The Documents row's count: top-level entries of the team's work directory.
  // A team's one root is always id `0`, so this is a single listing call, and
  // a team with no directory yet answers WORKDIR_NOT_CONFIGURED — no retry,
  // the row just carries no count.
  const teamDocsQuery = useDocumentsList({ team: teamId ?? '' }, '0', '', {
    enabled: teamAltitude,
    retry: false,
  });
  const memberIds = useMemo(
    () => (team ? new Set(team.members.map((m) => m.personalityId)) : undefined),
    [team],
  );

  // Fraction counts (Skills / MCP / Plugins, workspace altitude only) —
  // best-effort per the plan: `n` from the personality's own attached lists,
  // `N` from the corresponding global list RPC. Disabled entirely at the
  // Library altitude so these three extra requests aren't fired there.
  const skillsQuery = usePersonalitySkillsList(personalityId ?? '', { enabled: !!personalityId });
  const globalSkillsQuery = useQuery({
    queryKey: ['skills', 'list'],
    queryFn: () => rpc.skills.list({ includeUnavailable: true }),
    enabled: !!personalityId,
  });
  const globalPluginsQuery = useQuery({
    queryKey: ['plugins', 'list'],
    queryFn: () => rpc.plugins.list(),
    enabled: !!personalityId,
  });
  const skillsFraction = formatFraction(
    skillsQuery.data?.skills.length,
    globalSkillsQuery.data?.skills.length,
  );
  const mcpFraction = formatFraction(
    activePersonality?.mcp_servers?.length ?? 0,
    globalPluginsQuery.data?.mcpServers.length,
  );
  const pluginsFraction = formatFraction(
    activePersonality?.plugins?.length ?? 0,
    globalPluginsQuery.data?.plugins.length,
  );

  const sessions = useMemo<RecentSessionRow[]>(() => sessionsData?.items ?? [], [sessionsData]);
  const { pinned: filteredPinned, unpinned: filteredUnpinned } = useMemo(
    () => filterRecentSessions(sessions, sessionSearch, personalityId, memberIds),
    [sessions, sessionSearch, personalityId, memberIds],
  );

  const identityLabel = personalityId
    ? (activePersonality?.name ?? capitalize(personalityId))
    : 'Library';

  // `/p/:id` or `/t/:teamId/p/:id` — the one place the workspace rows'
  // prefix is spelled here (the builders in workspaceRoutes.ts do the same).
  const wsPrefix = teamId ? `/t/${teamId}/p/${personalityId}` : `/p/${personalityId}`;
  const teamName = team?.name ?? (teamId ? capitalize(teamId) : '');
  const teamCoordinator = team?.coordinator ?? null;
  const teamMember =
    personalityId && team
      ? (team.members.find((m) => m.personalityId === personalityId) ?? null)
      : null;

  return (
    <nav className="scope-nav" aria-label="Contextual navigation">
      {personalityId && teamId ? (
        <Link to={buildTeamPath(teamId)} className="scope-nav-back">
          ← {teamName}
        </Link>
      ) : null}

      {teamAltitude ? (
        <div className="scope-nav-identity scope-nav-identity-team">
          <TeamRing accents={team ? teamAccents(team) : []} size={24} title={teamName} />
          <span className="scope-nav-identity-text">
            <span className="scope-nav-identity-label">{teamName}</span>
            {team ? (
              <span className="scope-nav-identity-sub">
                {team.dispatchMode} · {team.members.length}{' '}
                {team.members.length === 1 ? 'member' : 'members'}
              </span>
            ) : null}
          </span>
        </div>
      ) : teamMember ? (
        // A member's workspace inside its team (§3): the role · tier line
        // under the name, the way the prototype's `.nav .id .sub` reads.
        <div className="scope-nav-identity scope-nav-identity-team">
          <PersonalityRingAvatar
            personalityId={teamMember.personalityId}
            size={22}
            avatarUrl={activePersonality?.display?.avatar_url}
          />
          <span className="scope-nav-identity-text">
            <span className="scope-nav-identity-label">{identityLabel}</span>
            <span className="scope-nav-identity-sub">
              {teamMember.role} · {teamMember.tier ?? 'no tier'}
            </span>
          </span>
        </div>
      ) : (
        <div className="scope-nav-identity">
          {personalityId ? (
            <PersonalityRingAvatar
              personalityId={personalityId}
              size={22}
              avatarUrl={activePersonality?.display?.avatar_url}
            />
          ) : null}
          <span className="scope-nav-identity-label">{identityLabel}</span>
        </div>
      )}

      {/* At the team altitude there is nothing to pick — the team's chat IS
          the coordinator's — so `+ New session` opens it directly, and is
          absent when there is no coordinator (no chat to open). A member's
          workspace inside the team keeps the picker. */}
      {teamAltitude && teamId ? (
        teamCoordinator ? (
          <button
            type="button"
            className="sidebar-new-btn"
            onClick={() =>
              navigate(buildNewSessionPath(teamCoordinator, buildTeamPath(teamId, 'chat')))
            }
          >
            + New session
          </button>
        ) : null
      ) : (
        <button type="button" className="sidebar-new-btn" onClick={openNewSessionModal}>
          + New session
        </button>
      )}

      {teamAltitude && teamId ? (
        <div className="sidebar-nav">
          {TEAM_PANES.map((pane) => {
            if (pane.key === 'chat' && !team?.coordinator) return null;
            const row = (
              <NavRow
                key={pane.key}
                path={buildTeamPath(teamId, pane.key)}
                glyph={pane.key}
                label={pane.label}
                pathname={pathname}
                hint={teamPaneHint(
                  pane.key,
                  team,
                  teamDetail.data?.memoryTopics.length,
                  teamDocsQuery.data?.entries.length,
                )}
                badge={pane.key === 'board' ? boardNeedsYou : undefined}
                trailing={
                  pane.key === 'chat' && team?.coordinator ? (
                    <span className="sidebar-nav-via">
                      via <PersonalityMark personalityId={team.coordinator} size={12} />
                      {team.coordinator}
                    </span>
                  ) : undefined
                }
              />
            );
            return pane.key === 'chat' ? (
              <div key="chat" className="scope-nav-team-chat">
                {row}
                <div className="sidebar-divider" />
              </div>
            ) : (
              row
            );
          })}
        </div>
      ) : personalityId ? (
        <div className="sidebar-nav">
          <NavRow path={`${wsPrefix}/chat`} icon="💬" label="Chat" pathname={pathname} />
          <NavRow path={`${wsPrefix}/sessions`} icon="📋" label="Sessions" pathname={pathname} />
          <NavRow path={`${wsPrefix}/memory`} icon="🧠" label="Memory" pathname={pathname} />
          <NavRow path={`${wsPrefix}/documents`} icon="📄" label="Documents" pathname={pathname} />
          <NavRow path={`${wsPrefix}/schedule`} icon="⏰" label="Schedule" pathname={pathname} />
          <NavRow
            path={`${wsPrefix}/skills`}
            icon="⚡"
            label="Skills"
            hint={skillsFraction}
            pathname={pathname}
          />
          <NavRow
            path={`${wsPrefix}/mcp`}
            icon="🔌"
            label="MCP Servers"
            hint={mcpFraction}
            pathname={pathname}
          />
          <NavRow
            path={`${wsPrefix}/plugins`}
            icon="🧩"
            label="Plugins"
            hint={pluginsFraction}
            pathname={pathname}
          />
          <NavRow path={`${wsPrefix}/goals`} icon="🎯" label="Goals" pathname={pathname} />
          <NavRow
            path={`${wsPrefix}/tasks`}
            icon="🧵"
            label="Tasks"
            pathname={pathname}
            badge={needsYouCount}
          />
          <NavRow path={`${wsPrefix}/activity`} icon="📊" label="Activity" pathname={pathname} />
          <NavRow path={`${wsPrefix}/identity`} icon="🪪" label="Identity" pathname={pathname} />
        </div>
      ) : (
        <>
          <div className="sidebar-nav">
            <NavRow path="/personalities" icon="🎭" label="Personalities" pathname={pathname} />
            {/* No fraction hint: unlike Skills/MCP/Plugins, "3 of 3" means
                nothing for a catalog you install FROM. */}
            <NavRow path="/recipes" icon="📖" label="Recipes" pathname={pathname} />
            <NavRow path="/skills" icon="⚡" label="All skills" pathname={pathname} exact />
            <NavRow path="/plugins" icon="🧩" label="All plugins" pathname={pathname} />
            <NavRow path="/mcp" icon="🔌" label="All servers" pathname={pathname} exact />
            <NavRow
              path="/library/tasks"
              icon="🧵"
              label="All tasks"
              pathname={pathname}
              exact
              badge={needsYouCount}
            />
            <NavRow path="/communications" icon="📡" label="Platforms" pathname={pathname} exact />
          </div>
          <div className="sidebar-divider" />
          <div className="sidebar-nav">
            <NavRow path="/teams" icon="👥" label="Teams" pathname={pathname} />
            <NavRow path="/kanban" icon="📋" label="Kanban" pathname={pathname} exact />
          </div>
          <div className="sidebar-divider" />
          <div className="sidebar-nav">
            <NavRow path="/activity" icon="📊" label="Activity" pathname={pathname} exact />
            <NavRow path="/mesh" icon="🕸️" label="Mesh" pathname={pathname} exact />
          </div>
          <button
            type="button"
            className="sidebar-section-label scope-nav-advanced-toggle"
            onClick={() => setAdvancedOpen((v) => !v)}
            aria-expanded={advancedOpen}
          >
            Advanced {advancedOpen ? '▾' : '▸'}
          </button>
          {advancedOpen && (
            <div className="sidebar-nav">
              <NavRow path="/dashboards" icon="📊" label="Dashboards" pathname={pathname} />
              <NavRow path="/batch" icon="📦" label="Batch" pathname={pathname} exact />
              <NavRow path="/eval" icon="🧪" label="Eval" pathname={pathname} exact />
              {config?.adminEnabled && (
                <NavRow path="/admin" icon="🛡️" label="Admin" pathname={pathname} exact />
              )}
              <NavRow path="/settings" icon="⚙️" label="Settings" pathname={pathname} />
              {/* P2: system jobs only, machine-wide — not the personal
                  /schedule pane. `/library/cron` is a distinct address from
                  the legacy `/cron` bookmark redirect above (that one always
                  bounces into a workspace, so it can't double as this). */}
              <NavRow path="/library/cron" icon="🗓️" label="System cron" pathname={pathname} exact />
            </div>
          )}
        </>
      )}

      <div className="sidebar-divider" />

      <input
        type="text"
        className="sidebar-search-input"
        placeholder="Filter recent..."
        value={sessionSearch}
        onChange={(e) => setSessionSearch(e.target.value)}
      />

      <div className="sidebar-session-list">
        {filteredPinned.length > 0 && (
          <>
            <div className="sidebar-section-label">PINNED</div>
            {filteredPinned.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                teamId={teamId}
                active={activeSessionId === s.id}
                onContextMenu={openContextMenu}
              />
            ))}
          </>
        )}

        <div
          className={`sidebar-section-label${teamAltitude ? ' sidebar-section-label-mono' : ''}`}
        >
          {teamAltitude ? `RECENT IN ${teamName.toUpperCase()}` : 'SESSIONS'}{' '}
          <span className="sidebar-session-count">{filteredUnpinned.length}</span>
        </div>
        {filteredUnpinned.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            teamId={teamId}
            active={activeSessionId === s.id}
            onContextMenu={openContextMenu}
          />
        ))}

        {/* P3's Library twin — the full, unscoped, cross-agent list. */}
        <Link to="/library/sessions" className="sidebar-view-all">
          View all sessions →
        </Link>
      </div>

      {menu && (
        <SessionContextMenu
          sessionId={menu.session.id}
          position={menu.position}
          pinned={menu.session.pinned}
          onClose={() => setMenu(null)}
          onRename={() => {
            setRenaming(menu.session);
            setMenu(null);
          }}
        />
      )}

      {renaming && (
        <RenameSessionModal
          key={renaming.id}
          session={renaming}
          onClose={() => setRenaming(null)}
        />
      )}
    </nav>
  );
}

/** The right-aligned count on a team row (§3): Structure = members,
 *  Memory = topics, Documents = top-level entries, Channels = bound
 *  channels. Others carry none. */
function teamPaneHint(
  key: TeamPaneKey,
  team: { members: unknown[]; channels: unknown[] } | null,
  topicCount: number | undefined,
  documentCount: number | undefined,
): string | null {
  if (!team) return null;
  if (key === 'structure') return String(team.members.length);
  if (key === 'channels') return String(team.channels.length);
  if (key === 'memory') return topicCount === undefined ? null : String(topicCount);
  if (key === 'documents') return documentCount === undefined ? null : String(documentCount);
  return null;
}

function RenameSessionModal({
  session,
  onClose,
}: {
  session: RecentSessionRow;
  onClose: () => void;
}) {
  const renameMut = useSessionRename();
  const [title, setTitle] = useState(session.title ?? '');

  const submit = () => {
    const next = title.trim();
    renameMut.mutate({ id: session.id, title: next.length > 0 ? next : null });
    onClose();
  };

  return (
    <Modal
      open
      title="Rename session"
      okText="Rename"
      onOk={submit}
      onCancel={onClose}
      confirmLoading={renameMut.isPending}
      width={420}
    >
      <Input
        autoFocus
        placeholder="Session title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onPressEnter={submit}
      />
    </Modal>
  );
}

function NavRow({
  path,
  icon,
  glyph,
  label,
  hint,
  pathname,
  exact,
  badge,
  trailing,
}: {
  path: string;
  icon?: string;
  /** 16px stroke icon (DESIGN.md sidebar rule) — the team rows use these. */
  glyph?: NavIconKey;
  label: string;
  hint?: string | null;
  pathname: string;
  /** Numeric attention badge. 0 or absent renders nothing (§4.4/D25). */
  badge?: number;
  /** Right-aligned slot for anything richer than a count — the team Chat
   *  row's `via <mark> <coordinator>` hint. */
  trailing?: ReactNode;
  /** Default active-match is `pathname === path || pathname.startsWith(path + '/')`
   *  (so nested routes like `/goals/:goalId` still light up "Goals"). Pass
   *  `exact` for rows with no nested children of their own. */
  exact?: boolean;
}) {
  const active = exact ? pathname === path : pathname === path || pathname.startsWith(`${path}/`);
  return (
    <Link
      to={path}
      className={`sidebar-nav-item${active ? ' active' : ''}`}
      title={badge && badge > 0 ? `${label} — ${badge} needs you` : label}
    >
      {glyph ? <NavIcon icon={glyph} /> : icon ? <span className="nav-icon">{icon}</span> : null}
      <span className="sidebar-nav-label">{label}</span>
      {/* A count paired with the row's own title text — never colour alone
          (§4.11), and the title is what a screen reader announces. */}
      {badge && badge > 0 ? <span className="sidebar-nav-badge">{badge}</span> : null}
      {hint ? <span className="sidebar-nav-hint">{hint}</span> : null}
      {trailing}
    </Link>
  );
}

function SessionRow({
  session,
  teamId,
  active,
  onContextMenu,
}: {
  session: RecentSessionRow;
  /** Keeps a session opened from a team column under the team prefix. */
  teamId: string | null;
  active: boolean;
  onContextMenu?: (e: React.MouseEvent, session: RecentSessionRow) => void;
}) {
  const label = session.title ?? 'Untitled session';
  const time = formatRelativeTime(session.updatedAt);
  return (
    <Link
      to={sessionOpenPath(session.id, session.personalityId, teamId)}
      className={`sidebar-session-row${active ? ' active' : ''}`}
      data-p={session.personalityId ?? undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.(e, session);
      }}
    >
      <span className="sidebar-session-name">{label}</span>
      <span className="sidebar-session-time">{time}</span>
    </Link>
  );
}

function formatRelativeTime(iso: string): string {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}
