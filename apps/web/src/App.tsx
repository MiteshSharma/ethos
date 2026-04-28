import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { RightDrawer } from './components/RightDrawer';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { Chat } from './pages/Chat';
import { Cron } from './pages/Cron';
import { Mesh } from './pages/Mesh';
import { Onboarding } from './pages/Onboarding';
import { Sessions } from './pages/Sessions';
import { SigningIn } from './pages/SigningIn';
import { Skills } from './pages/Skills';
import { rpc } from './rpc';

// Top-level route map. v0 ships only Talk-group routes (Chat + Sessions)
// plus the onboarding flow and the signing-in placeholder. v0.5 adds the
// right-side activity drawer and the surfaces it observes (Skills, Mesh
// — landing alongside this commit). Lab / System groups arrive in v1.

const DRAWER_BREAKPOINT = 1280; // px — plan IA: drawer "default visible ≥1280px"

export function App() {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(() =>
    typeof window === 'undefined' ? false : window.innerWidth >= DRAWER_BREAKPOINT,
  );
  useOnboardingRedirect();

  // Global keyboard shortcut for the drawer: ⌘. / Ctrl-. — same chord
  // VS Code uses for the inline action menu. Ignored when typing in an
  // input/textarea/contenteditable so chat composers stay responsive.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== '.') return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
      setDrawerOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const shellClass = ['app-shell', collapsed ? 'collapsed' : '', drawerOpen ? 'drawer-open' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={shellClass}>
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} />
      <TopBar drawerOpen={drawerOpen} onToggleDrawer={() => setDrawerOpen((v) => !v)} />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Navigate to="/chat" replace />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/sessions" element={<Sessions />} />
          <Route path="/cron" element={<Cron />} />
          <Route path="/skills" element={<Skills />} />
          <Route path="/mesh" element={<Mesh />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/signing-in" element={<SigningIn />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Routes>
      </main>
      <RightDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </div>
  );
}

/**
 * Auto-redirect first-run users into the onboarding flow. Reads
 * `rpc.onboarding.state` and, when the server reports any non-`done`
 * step, navigates the user there. The mutation that completes onboarding
 * invalidates this query, so once the user picks a personality the next
 * render of this hook lets them stay wherever they are.
 *
 * Skip the redirect when:
 *   • The query is loading — we don't yet know if onboarding is needed.
 *   • The user is already on /onboarding.
 *   • The user is on /signing-in (auth handshake placeholder).
 */
function useOnboardingRedirect(): void {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { data, isLoading } = useQuery({
    queryKey: ['onboarding', 'state'],
    queryFn: () => rpc.onboarding.state(),
  });

  useEffect(() => {
    if (isLoading || !data) return;
    if (data.step === 'done') return;
    if (pathname === '/onboarding' || pathname === '/signing-in') return;
    navigate('/onboarding', { replace: true });
  }, [data, isLoading, pathname, navigate]);
}
