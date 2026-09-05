import { Drawer } from 'antd';
import { type ReactNode, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useConfig } from '../features/config/api/queries';
import { extractTeamId, extractWorkspacePersonalityId, TEAM_PANES } from '../lib/scopeNav';
import { buildTeamPath } from '../lib/workspaceRoutes';
import { NavIcon } from './ui/NavIcon';

// Bottom tab bar shown at <768px. Per the plan's responsive contract:
// "Mobile triage-only — read + approve + triage, not full functionality."
// Four primary destinations + a "More" sheet that lists everything else.
//
// Editing surfaces (personalities create wizard, cron scheduling
// modal, etc.) are still reachable from "More" but they aren't
// expected to be ergonomic on a phone — the plan accepts that. The
// goal of this surface is so a user on their phone can:
//   • read an in-progress chat
//   • approve a tool call
//   • see what a cron job did
//   • check mesh status
// not run a full personality wizard.
//
// teams-as-a-scope T1 (§10): at the team altitude the four tabs are
// Chat · Overview · Board · Structure, and "More" lists the remaining team
// panes ahead of the machine-wide list. Everywhere else is unchanged.

interface PrimaryItem {
  path: string;
  label: string;
  icon: ReactNode;
}

const PRIMARY: ReadonlyArray<PrimaryItem> = [
  { path: '/chat', label: 'Chat', icon: '💬' },
  { path: '/sessions', label: 'Sessions', icon: '🗂️' },
  { path: '/cron', label: 'Cron', icon: '⏱' },
  { path: '/mesh', label: 'Mesh', icon: '🕸️' },
];

// The first four team panes, in `TEAM_PANES` order, are the tabs; the rest
// go under More.
const TEAM_PRIMARY_COUNT = 4;

interface MoreLink {
  path: string;
  label: string;
}

// P5 (plan/phases/personality-first-ui.md) — the audit found this list
// (alongside CommandPalette's "Pages" group, see `paletteDestinations.ts`)
// omitted Dashboards, Teams, Kanban, Admin, and MCP from the post-refactor
// route table. Goals and Tasks stay out: they're workspace-only (no bare
// `/goals` page to link to on this triage-only surface — resolving a
// fallback personality here would be new logic, not a stale-link fix).
const MORE_LINKS: ReadonlyArray<MoreLink> = [
  { path: '/activity', label: 'Activity' },
  { path: '/personalities', label: 'Personalities' },
  { path: '/skills', label: 'Skills' },
  { path: '/mcp', label: 'MCP Servers' },
  { path: '/memory', label: 'Memory' },
  { path: '/documents', label: 'Documents' },
  { path: '/communications', label: 'Communications' },
  { path: '/batch', label: 'Batch' },
  { path: '/eval', label: 'Eval' },
  { path: '/plugins', label: 'Plugins' },
  { path: '/dashboards', label: 'Dashboards' },
  { path: '/teams', label: 'Teams' },
  { path: '/kanban', label: 'Kanban' },
  { path: '/settings', label: 'Settings' },
];

export function MobileTabBar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [moreOpen, setMoreOpen] = useState(false);
  const { data: config } = useConfig();

  const teamId = extractTeamId(pathname);
  const teamAltitude = teamId !== null && extractWorkspacePersonalityId(pathname) === null;

  const primary: ReadonlyArray<PrimaryItem> = teamAltitude
    ? TEAM_PANES.slice(0, TEAM_PRIMARY_COUNT).map((p) => ({
        path: buildTeamPath(teamId, p.key),
        label: p.label,
        icon: <NavIcon icon={p.key} />,
      }))
    : PRIMARY;

  const globalLinks = config?.adminEnabled
    ? [...MORE_LINKS, { path: '/admin', label: 'Admin' }]
    : MORE_LINKS;
  const moreLinks: ReadonlyArray<MoreLink> = teamAltitude
    ? [
        ...TEAM_PANES.slice(TEAM_PRIMARY_COUNT).map((p) => ({
          path: buildTeamPath(teamId, p.key),
          label: p.label,
        })),
        ...globalLinks,
      ]
    : globalLinks;

  const moreActive = !primary.some((p) => pathname === p.path || pathname.startsWith(`${p.path}/`));

  return (
    <>
      <nav className="mobile-tabbar" aria-label="Primary navigation (mobile)">
        {primary.map((item) => {
          const active = pathname === item.path || pathname.startsWith(`${item.path}/`);
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`mobile-tabbar-item${active ? ' active' : ''}`}
            >
              <span className="mobile-tabbar-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span className="mobile-tabbar-label">{item.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          className={`mobile-tabbar-item${moreActive ? ' active' : ''}`}
          onClick={() => setMoreOpen(true)}
          aria-label="More tabs"
        >
          <span className="mobile-tabbar-icon" aria-hidden="true">
            ☰
          </span>
          <span className="mobile-tabbar-label">More</span>
        </button>
      </nav>

      <Drawer
        open={moreOpen}
        placement="bottom"
        onClose={() => setMoreOpen(false)}
        height="auto"
        title="All tabs"
      >
        <ul className="mobile-more-list">
          {moreLinks.map((link) => (
            <li key={link.path}>
              <button
                type="button"
                className="mobile-more-link"
                onClick={() => {
                  navigate(link.path);
                  setMoreOpen(false);
                }}
              >
                {link.label}
              </button>
            </li>
          ))}
        </ul>
      </Drawer>
    </>
  );
}
