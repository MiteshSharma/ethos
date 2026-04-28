import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { Chat } from './pages/Chat';
import { Cron } from './pages/Cron';
import { Onboarding } from './pages/Onboarding';
import { Sessions } from './pages/Sessions';
import { SigningIn } from './pages/SigningIn';
import { rpc } from './rpc';

// Top-level route map. v0 ships only Talk-group routes (Chat + Sessions)
// plus the onboarding flow and the signing-in placeholder. Agent / Ops /
// Lab / System groups arrive in v0.5+ — sidebar already groups them so
// future tabs slot in without restructuring.

export function App() {
  const [collapsed, setCollapsed] = useState(false);
  useOnboardingRedirect();

  return (
    <div className={`app-shell${collapsed ? ' collapsed' : ''}`}>
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} />
      <TopBar />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Navigate to="/chat" replace />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/sessions" element={<Sessions />} />
          <Route path="/cron" element={<Cron />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/signing-in" element={<SigningIn />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Routes>
      </main>
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
