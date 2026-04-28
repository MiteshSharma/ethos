import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { CommandPalette } from './components/CommandPalette';
import { RightDrawer } from './components/RightDrawer';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { usePushEventToasts } from './hooks/usePushEventToasts';
import { Chat } from './pages/Chat';
import { Cron } from './pages/Cron';
import { Memory } from './pages/Memory';
import { Mesh } from './pages/Mesh';
import { Onboarding } from './pages/Onboarding';
import { Sessions } from './pages/Sessions';
import { Settings } from './pages/Settings';
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  useOnboardingRedirect();
  usePushEventToasts();

  const toggleDrawer = useCallback(() => setDrawerOpen((v) => !v), []);

  // Global keyboard shortcuts:
  //   ⌘K / Ctrl-K — open the command palette (passes through even from
  //                 inside inputs so users can pivot mid-typing).
  //   ⌘. / Ctrl-. — toggle the activity drawer. Ignored while typing
  //                 in a composer so chat input stays responsive.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (mod && e.key === '.') {
        const target = e.target as HTMLElement | null;
        if (target?.closest('input, textarea, [contenteditable="true"]')) return;
        e.preventDefault();
        toggleDrawer();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleDrawer]);

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
          <Route path="/settings" element={<Settings />} />
          <Route path="/memory" element={<Memory />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/signing-in" element={<SigningIn />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Routes>
      </main>
      <RightDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onToggleDrawer={toggleDrawer}
      />
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
