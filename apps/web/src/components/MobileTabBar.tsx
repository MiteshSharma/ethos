import { Drawer } from 'antd';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

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

interface PrimaryItem {
  path: string;
  label: string;
  icon: string;
}

const PRIMARY: ReadonlyArray<PrimaryItem> = [
  { path: '/chat', label: 'Chat', icon: '💬' },
  { path: '/sessions', label: 'Sessions', icon: '🗂️' },
  { path: '/cron', label: 'Cron', icon: '⏱' },
  { path: '/mesh', label: 'Mesh', icon: '🕸️' },
];

interface MoreLink {
  path: string;
  label: string;
}

const MORE_LINKS: ReadonlyArray<MoreLink> = [
  { path: '/personalities', label: 'Personalities' },
  { path: '/skills', label: 'Skills' },
  { path: '/memory', label: 'Memory' },
  { path: '/communications', label: 'Communications' },
  { path: '/batch', label: 'Batch' },
  { path: '/eval', label: 'Eval' },
  { path: '/plugins', label: 'Plugins' },
  { path: '/settings', label: 'Settings' },
];

export function MobileTabBar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [moreOpen, setMoreOpen] = useState(false);

  const moreActive = !PRIMARY.some((p) => pathname === p.path || pathname.startsWith(`${p.path}/`));

  return (
    <>
      <nav className="mobile-tabbar" aria-label="Primary navigation (mobile)">
        {PRIMARY.map((item) => {
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
          {MORE_LINKS.map((link) => (
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
