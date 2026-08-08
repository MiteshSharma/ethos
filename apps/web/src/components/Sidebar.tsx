import { Input, Modal } from 'antd';
import { useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useConfig } from '../features/config/api/queries';
import { useSessionRename } from '../features/sessions/api/mutations';
import { useRecentSessions } from '../features/sessions/api/queries';
import { useNewSessionModal } from '../hooks/useNewSessionModal';
import { SessionContextMenu } from './SessionContextMenu';

export interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

const SIDEBAR_SESSION_LIMIT = 20;

type SidebarSession = {
  id: string;
  title: string | null;
  key: string;
  updatedAt: string;
  pinned: boolean;
};

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const activeSessionId = searchParams.get('session');
  const { openNewSessionModal } = useNewSessionModal();
  const [sessionSearch, setSessionSearch] = useState('');
  const [advancedMode, setAdvancedMode] = useState(() => {
    try {
      return localStorage.getItem('ethos:advancedMode') === 'true';
    } catch {
      return false;
    }
  });

  const toggleAdvancedMode = () => {
    setAdvancedMode((v) => {
      const next = !v;
      try {
        localStorage.setItem('ethos:advancedMode', String(next));
      } catch {}
      return next;
    });
  };

  const [menu, setMenu] = useState<{
    session: SidebarSession;
    position: { x: number; y: number };
  } | null>(null);
  const [renaming, setRenaming] = useState<SidebarSession | null>(null);

  const openContextMenu = (e: React.MouseEvent, session: SidebarSession) => {
    setMenu({ session, position: { x: e.clientX, y: e.clientY } });
  };

  const { data: sessionsData } = useRecentSessions(SIDEBAR_SESSION_LIMIT);
  const { data: config, error: configError, isLoading: configLoading } = useConfig();

  const sessions = sessionsData?.items ?? [];
  const pinned = useMemo(() => sessions.filter((s) => s.pinned), [sessions]);
  const unpinned = useMemo(() => sessions.filter((s) => !s.pinned), [sessions]);

  const filteredPinned = useMemo(
    () =>
      sessionSearch
        ? pinned.filter((s) =>
            (s.title ?? s.key).toLowerCase().includes(sessionSearch.toLowerCase()),
          )
        : pinned,
    [pinned, sessionSearch],
  );
  const filteredUnpinned = useMemo(
    () =>
      sessionSearch
        ? unpinned.filter((s) =>
            (s.title ?? s.key).toLowerCase().includes(sessionSearch.toLowerCase()),
          )
        : unpinned,
    [unpinned, sessionSearch],
  );

  const connectionState: 'connected' | 'connecting' | 'offline' = configLoading
    ? 'connecting'
    : configError
      ? 'offline'
      : 'connected';

  return (
    <nav className="sidebar" aria-label="Primary navigation">
      <button
        type="button"
        className="sidebar-header"
        onClick={onToggle}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-expanded={!collapsed}
        style={{ background: 'none', border: 'none', color: 'inherit', textAlign: 'left' }}
      >
        <EthosMark />
        <span className="sidebar-header-title">Ethos</span>
      </button>

      {!collapsed && (
        <>
          <button type="button" className="sidebar-new-btn" onClick={openNewSessionModal}>
            + New session
          </button>

          <div className="sidebar-section-label">Agent</div>
          <div className="sidebar-nav">
            <NavRow
              path="/personalities"
              icon="🎭"
              label="Personalities"
              active={pathname === '/personalities' || pathname.startsWith('/personalities/')}
            />
            <NavRow path="/skills" icon="⚡" label="Skills" active={pathname === '/skills'} />
            <NavRow
              path="/plugins"
              icon="🧩"
              label="Plugins"
              active={pathname === '/plugins' || pathname.startsWith('/plugins/')}
            />
            <NavRow path="/mcp" icon="🔌" label="MCP Servers" active={pathname === '/mcp'} />
            <NavRow path="/memory" icon="🧠" label="Memory" active={pathname === '/memory'} />
            <NavRow
              path="/documents"
              icon="📄"
              label="Documents"
              active={pathname === '/documents'}
            />
            <NavRow
              path="/communications"
              icon="📡"
              label="Platforms"
              active={pathname === '/communications'}
            />
            <NavRow
              path="/dashboards"
              icon="📊"
              label="Dashboards"
              active={pathname === '/dashboards' || pathname.startsWith('/dashboards/')}
            />
            <NavRow
              path="/goals"
              icon="🎯"
              label="Goals"
              active={pathname === '/goals' || pathname.startsWith('/goals/')}
            />
            <NavRow path="/tasks" icon="🧵" label="Tasks" active={pathname === '/tasks'} />
          </div>

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

            <Link to="/sessions" className="sidebar-view-all">
              View all sessions →
            </Link>
          </div>

          {advancedMode && (
            <>
              <div className="sidebar-section-label">LAB</div>
              <div className="sidebar-nav">
                <NavRow
                  path="/batch"
                  icon="📦"
                  label="Batch / Eval"
                  active={pathname === '/batch' || pathname === '/eval'}
                />
                <NavRow
                  path="/activity"
                  icon="📊"
                  label="Observability"
                  active={pathname === '/activity'}
                />
                <NavRow path="/mesh" icon="🕸️" label="Mesh" active={pathname === '/mesh'} />
                <NavRow
                  path="/teams"
                  icon="👥"
                  label="Teams"
                  active={pathname === '/teams' || pathname.startsWith('/teams/')}
                />
                <NavRow path="/kanban" icon="📋" label="Kanban" active={pathname === '/kanban'} />
                {config?.adminEnabled && (
                  <NavRow path="/admin" icon="🛡️" label="Admin" active={pathname === '/admin'} />
                )}
              </div>
            </>
          )}

          <div className="sidebar-footer">
            <NavRow path="/settings" icon="⚙️" label="Settings" active={pathname === '/settings'} />
            <button
              type="button"
              className="sidebar-advanced-toggle-btn"
              onClick={toggleAdvancedMode}
            >
              {advancedMode ? 'Simple' : 'Advanced'}
            </button>
            <span
              className={`sidebar-connected sb-dot sb-dot--${connectionState}`}
              aria-hidden="true"
            />
          </div>
        </>
      )}

      {collapsed && (
        <div className="sidebar-nav">
          <NavRow path="/chat" icon="💬" label="Chat" active={pathname === '/chat'} />
          <NavRow
            path="/personalities"
            icon="🎭"
            label="Personalities"
            active={pathname === '/personalities' || pathname.startsWith('/personalities/')}
          />
          <NavRow path="/skills" icon="⚡" label="Skills" active={pathname === '/skills'} />
          <NavRow
            path="/plugins"
            icon="🧩"
            label="Plugins"
            active={pathname === '/plugins' || pathname.startsWith('/plugins/')}
          />
          <NavRow path="/mcp" icon="🔌" label="MCP Servers" active={pathname === '/mcp'} />
          <NavRow path="/memory" icon="🧠" label="Memory" active={pathname === '/memory'} />
          <NavRow
            path="/documents"
            icon="📄"
            label="Documents"
            active={pathname === '/documents'}
          />
          <NavRow
            path="/communications"
            icon="📡"
            label="Platforms"
            active={pathname === '/communications'}
          />
          <NavRow path="/sessions" icon="📋" label="Sessions" active={pathname === '/sessions'} />
          <NavRow
            path="/goals"
            icon="🎯"
            label="Goals"
            active={pathname === '/goals' || pathname.startsWith('/goals/')}
          />
          <NavRow path="/tasks" icon="🧵" label="Tasks" active={pathname === '/tasks'} />
          {config?.adminEnabled && (
            <NavRow path="/admin" icon="🛡️" label="Admin" active={pathname === '/admin'} />
          )}
          <NavRow path="/settings" icon="⚙️" label="Settings" active={pathname === '/settings'} />
        </div>
      )}

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
  session: SidebarSession;
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
  active,
}: {
  path: string;
  icon?: string;
  label: string;
  hint?: string;
  active: boolean;
}) {
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
  session: SidebarSession;
  active: boolean;
  onContextMenu?: (e: React.MouseEvent, session: SidebarSession) => void;
}) {
  const label = session.title ?? 'Untitled session';
  const time = formatRelativeTime(session.updatedAt);
  return (
    <Link
      to={`/chat?session=${session.id}`}
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

function EthosMark() {
  return (
    <svg aria-hidden="true" width="22" height="22" viewBox="0 0 16 16" style={{ flexShrink: 0 }}>
      <circle cx="8" cy="8" r="7" fill="#4A9EFF" />
      <circle cx="8" cy="8" r="3" fill="var(--bg-base, #0F0F0F)" />
    </svg>
  );
}
