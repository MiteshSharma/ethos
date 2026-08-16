import { useQuery } from '@tanstack/react-query';
import { Input, Modal } from 'antd';
import { useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useConfig } from '../features/config/api/queries';
import {
  usePersonalityList,
  usePersonalitySkillsList,
} from '../features/personalities/api/queries';
import { useSessionRename } from '../features/sessions/api/mutations';
import { useRecentSessions } from '../features/sessions/api/queries';
import { useNewSessionModal } from '../hooks/useNewSessionModal';
import {
  capitalize,
  extractWorkspacePersonalityId,
  filterRecentSessions,
  formatFraction,
  type RecentSessionRow,
} from '../lib/scopeNav';
import { sessionOpenPath } from '../lib/workspaceRoutes';
import { rpc } from '../rpc';
import { SessionContextMenu } from './SessionContextMenu';
import { PersonalityRingAvatar } from './ui/PersonalityRingAvatar';

// P1b — plan/phases/personality-first-ui.md. The 216px contextual column,
// replacing `Sidebar.tsx`'s rendered role (that file stays on disk,
// unrendered, until P6 deletes it alongside its now-unused CSS). Present at
// BOTH altitudes:
//
//   • Library  (personalityId === null) — identity line "Library", grouped
//     rows to the machine-wide destinations P1a already serves, an
//     `Advanced` disclosure (dashboards / batch / eval / admin / settings /
//     system cron).
//   • Workspace (personalityId set)     — identity line = agent name,
//     the eleven P1a workspace routes, `n / N` fractions on
//     Skills/MCP/Plugins only.
//
// The session block below is a lift, not a rebuild: same `useRecentSessions`
// hook, same context menu, same rename modal — but SCOPED to the active
// workspace's personality (P2, reversing P1b's original "unscoped at both
// altitudes" decision per explicit user direction — see `filterRecentSessions`
// in `lib/scopeNav.ts`). Only at the Library altitude does the full,
// cross-agent list still appear.

const SIDEBAR_SESSION_LIMIT = 20;

export function ScopeNav() {
  const { pathname } = useLocation();
  const personalityId = extractWorkspacePersonalityId(pathname);
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
    () => filterRecentSessions(sessions, sessionSearch, personalityId),
    [sessions, sessionSearch, personalityId],
  );

  const identityLabel = personalityId
    ? (activePersonality?.name ?? capitalize(personalityId))
    : 'Library';

  return (
    <nav className="scope-nav" aria-label="Contextual navigation">
      <div className="scope-nav-identity">
        {personalityId ? <PersonalityRingAvatar personalityId={personalityId} size={22} /> : null}
        <span className="scope-nav-identity-label">{identityLabel}</span>
      </div>

      <button type="button" className="sidebar-new-btn" onClick={openNewSessionModal}>
        + New session
      </button>

      {personalityId ? (
        <div className="sidebar-nav">
          <NavRow path={`/p/${personalityId}/chat`} icon="💬" label="Chat" pathname={pathname} />
          <NavRow
            path={`/p/${personalityId}/sessions`}
            icon="📋"
            label="Sessions"
            pathname={pathname}
          />
          <NavRow
            path={`/p/${personalityId}/memory`}
            icon="🧠"
            label="Memory"
            pathname={pathname}
          />
          <NavRow
            path={`/p/${personalityId}/documents`}
            icon="📄"
            label="Documents"
            pathname={pathname}
          />
          <NavRow
            path={`/p/${personalityId}/schedule`}
            icon="⏰"
            label="Schedule"
            pathname={pathname}
          />
          <NavRow
            path={`/p/${personalityId}/skills`}
            icon="⚡"
            label="Skills"
            hint={skillsFraction}
            pathname={pathname}
          />
          <NavRow
            path={`/p/${personalityId}/mcp`}
            icon="🔌"
            label="MCP Servers"
            hint={mcpFraction}
            pathname={pathname}
          />
          <NavRow
            path={`/p/${personalityId}/plugins`}
            icon="🧩"
            label="Plugins"
            hint={pluginsFraction}
            pathname={pathname}
          />
          <NavRow path={`/p/${personalityId}/goals`} icon="🎯" label="Goals" pathname={pathname} />
          <NavRow path={`/p/${personalityId}/tasks`} icon="🧵" label="Tasks" pathname={pathname} />
          <NavRow
            path={`/p/${personalityId}/identity`}
            icon="🪪"
            label="Identity"
            pathname={pathname}
          />
        </div>
      ) : (
        <>
          <div className="sidebar-nav">
            <NavRow path="/personalities" icon="🎭" label="Personalities" pathname={pathname} />
            <NavRow path="/skills" icon="⚡" label="All skills" pathname={pathname} exact />
            <NavRow path="/plugins" icon="🧩" label="All plugins" pathname={pathname} />
            <NavRow path="/mcp" icon="🔌" label="All servers" pathname={pathname} exact />
            <NavRow path="/library/tasks" icon="🧵" label="All tasks" pathname={pathname} exact />
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
                active={activeSessionId === s.id}
                onContextMenu={openContextMenu}
              />
            ))}
          </>
        )}

        <div className="sidebar-section-label">
          SESSIONS <span className="sidebar-session-count">{filteredUnpinned.length}</span>
        </div>
        {filteredUnpinned.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
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
  label,
  hint,
  pathname,
  exact,
}: {
  path: string;
  icon?: string;
  label: string;
  hint?: string | null;
  pathname: string;
  /** Default active-match is `pathname === path || pathname.startsWith(path + '/')`
   *  (so nested routes like `/goals/:goalId` still light up "Goals"). Pass
   *  `exact` for rows with no nested children of their own. */
  exact?: boolean;
}) {
  const active = exact ? pathname === path : pathname === path || pathname.startsWith(`${path}/`);
  return (
    <Link to={path} className={`sidebar-nav-item${active ? ' active' : ''}`} title={label}>
      {icon ? <span className="nav-icon">{icon}</span> : null}
      <span className="sidebar-nav-label">{label}</span>
      {hint ? <span className="sidebar-nav-hint">{hint}</span> : null}
    </Link>
  );
}

function SessionRow({
  session,
  active,
  onContextMenu,
}: {
  session: RecentSessionRow;
  active: boolean;
  onContextMenu?: (e: React.MouseEvent, session: RecentSessionRow) => void;
}) {
  const label = session.title ?? 'Untitled session';
  const time = formatRelativeTime(session.updatedAt);
  return (
    <Link
      to={sessionOpenPath(session.id, session.personalityId)}
      className={`sidebar-session-row${active ? ' active' : ''}`}
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
