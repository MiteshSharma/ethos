import { Link, useLocation } from 'react-router-dom';

// Grouped nav per the IA in plan/phases/26-web-ui.md ("Information
// architecture"). v0 only lights up Talk-group items; the rest are stubs
// rendered as disabled rows so the structure is visible from day one
// (the "control plane lives here too" promise) while tabs land later.

interface NavItem {
  key: string;
  label: string;
  icon?: string;
  disabled?: boolean;
  hint?: string;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Talk',
    items: [
      { key: '/chat', label: 'Chat' },
      { key: '/sessions', label: 'Sessions' },
    ],
  },
  {
    title: 'Agent',
    items: [
      { key: '/personalities', label: 'Personalities', disabled: true, hint: 'v1' },
      { key: '/skills', label: 'Skills' },
      { key: '/memory', label: 'Memory', disabled: true, hint: 'v1' },
    ],
  },
  {
    title: 'Ops',
    items: [
      { key: '/cron', label: 'Cron' },
      { key: '/communications', label: 'Communications', disabled: true, hint: 'v1' },
      { key: '/mesh', label: 'Mesh' },
    ],
  },
  {
    title: 'System',
    items: [
      { key: '/plugins', label: 'Plugins', disabled: true, hint: 'v1' },
      { key: '/settings', label: 'Settings', disabled: true, hint: 'v1' },
    ],
  },
];

export interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const { pathname } = useLocation();
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

      {NAV_GROUPS.map((group) => (
        <div key={group.title}>
          <div className="sidebar-nav-section">{group.title}</div>
          <div className="sidebar-nav">
            {group.items.map((item) => (
              <NavRow
                key={item.key}
                item={item}
                active={pathname === item.key || pathname.startsWith(`${item.key}/`)}
                collapsed={collapsed}
              />
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

function NavRow({
  item,
  active,
  collapsed,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
}) {
  const className = `sidebar-nav-item${active ? ' active' : ''}`;
  const title = collapsed ? item.label : undefined;
  if (item.disabled) {
    return (
      <span
        className={className}
        title={title ?? `${item.label} — ships in ${item.hint}`}
        style={{ opacity: 0.5, cursor: 'not-allowed' }}
        aria-disabled="true"
      >
        <span className="sidebar-nav-label">{item.label}</span>
        {!collapsed && item.hint ? (
          <span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.7 }}>{item.hint}</span>
        ) : null}
      </span>
    );
  }
  return (
    <Link to={item.key} className={className} title={title}>
      <span className="sidebar-nav-label">{item.label}</span>
    </Link>
  );
}

function EthosMark() {
  // Placeholder mark — replaced by the generative deterministic SVG when
  // 26.W2 wires per-personality marks (plan: "Personality avatar:
  // generative deterministic SVG mark").
  return (
    <svg aria-hidden="true" width="22" height="22" viewBox="0 0 22 22" style={{ flexShrink: 0 }}>
      <rect x="1" y="1" width="20" height="20" rx="6" fill="#4A9EFF" />
      <path
        d="M7 11.5l3 3 5-6"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
