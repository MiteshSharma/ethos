import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { CommandPalette } from './components/CommandPalette';
import { MobileTabBar } from './components/MobileTabBar';
import { PersonalityPickerModal } from './components/PersonalityPickerModal';
import { RightDrawer } from './components/RightDrawer';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { useConfig, useOnboardingState } from './features/config/api/queries';
import { useNewSessionModal } from './hooks/useNewSessionModal';
import { usePushEventToasts } from './hooks/usePushEventToasts';
import { useSessionTitleSync } from './hooks/useSessionTitleSync';
import { bridge, isDesktop } from './lib/desktop';
import { Activity } from './pages/Activity';
import { Admin } from './pages/Admin';
import { Batch } from './pages/Batch';
import { Chat } from './pages/Chat';
import { Communications } from './pages/Communications';
import { CreateDashboardFlow } from './pages/CreateDashboardFlow';
import { Cron } from './pages/Cron';
import { Dashboards } from './pages/Dashboards';
import { DashboardView } from './pages/DashboardView';
import { Documents } from './pages/Documents';
import { Eval } from './pages/Eval';
import { GoalDetail } from './pages/GoalDetail';
import { Goals } from './pages/Goals';
import { Kanban } from './pages/Kanban';
import { Mcp } from './pages/Mcp';
import { Memory } from './pages/Memory';
import { Mesh } from './pages/Mesh';
import { OAuthCallback } from './pages/OAuthCallback';
import { Onboarding } from './pages/Onboarding';
import { Personalities } from './pages/Personalities';
import { PersonalityCreate } from './pages/PersonalityCreate';
import { PersonalityDetail } from './pages/PersonalityDetail';
import { PluginPage } from './pages/PluginPage';
import { Plugins } from './pages/Plugins';
import { Sessions } from './pages/Sessions';
import { SetupWhatsApp } from './pages/SetupWhatsApp';
import { SigningIn } from './pages/SigningIn';
import { Skills } from './pages/Skills';
import { SettingsPaneRoute } from './pages/settings/SettingsPaneRoute';
import { SettingsShell } from './pages/settings/SettingsShell';
import { Tasks } from './pages/Tasks';
import { TeamControlCenter } from './pages/TeamControlCenter';
import { TeamCreate } from './pages/TeamCreate';
import { Teams } from './pages/Teams';
import { reinitializeClient } from './rpc';

// Top-level route map. v0 ships only Talk-group routes (Chat + Sessions)
// plus the onboarding flow and the signing-in placeholder. v0.5 adds the
// right-side activity drawer and the surfaces it observes (Skills, Mesh
// — landing alongside this commit). Lab / System groups arrive in v1.

const DRAWER_BREAKPOINT = 1280; // px — plan IA: drawer "default visible ≥1280px"
const COMPACT_BREAKPOINT = 1280; // px — sidebar auto-collapses below this

function initialCollapsed(): boolean {
  return typeof window !== 'undefined' && window.innerWidth < COMPACT_BREAKPOINT;
}

export function App() {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(() =>
    typeof window === 'undefined' ? false : window.innerWidth >= DRAWER_BREAKPOINT,
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  useDesktopBootstrap();
  useDesktopNavigation();
  useDesktopOAuthCallback();
  useDesktopThemeSync();
  useOnboardingRedirect();
  usePushEventToasts();
  useSessionTitleSync();
  const { data: config } = useConfig();
  const { open: newSessionOpen, closeNewSessionModal } = useNewSessionModal();
  const { pathname } = useLocation();
  const isChat = pathname === '/chat';

  // Auto-collapse sidebar / hide drawer when crossing the compact
  // breakpoint. We don't *force* state on every resize tick — just
  // when crossing — so a user who manually expanded mid-session
  // keeps their preference until the next breakpoint flip.
  useEffect(() => {
    let lastNarrow = initialCollapsed();
    const onResize = () => {
      if (typeof window === 'undefined') return;
      const narrow = window.innerWidth < COMPACT_BREAKPOINT;
      if (narrow !== lastNarrow) {
        lastNarrow = narrow;
        setCollapsed(narrow);
        if (narrow) setDrawerOpen(false);
        else setDrawerOpen(true);
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

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
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Navigate to="/chat" replace />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/sessions" element={<Sessions />} />
          <Route path="/cron" element={<Cron />} />
          <Route path="/skills" element={<Skills />} />
          <Route path="/mesh" element={<Mesh />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/teams" element={<Teams />} />
          <Route path="/teams/create" element={<TeamCreate />} />
          <Route path="/teams/:name" element={<TeamControlCenter />} />
          {/* The shell is the layout route: it owns the one <Form>, and the
              panes mount inside it through its <Outlet/>. Every child renders
              SettingsPaneRoute, which resolves the URL to a real
              category/section and redirects (replace) when it has to. */}
          <Route path="/settings" element={<SettingsShell />}>
            <Route index element={<SettingsPaneRoute />} />
            <Route path=":category" element={<SettingsPaneRoute />} />
            <Route path=":category/:section" element={<SettingsPaneRoute />} />
          </Route>
          <Route path="/memory" element={<Memory />} />
          <Route path="/documents" element={<Documents />} />
          <Route path="/plugins" element={<Plugins />} />
          <Route path="/mcp" element={<Mcp />} />
          <Route path="/plugins/:pluginId" element={<PluginPage />} />
          <Route path="/communications" element={<Communications />} />
          <Route path="/personalities" element={<Personalities />} />
          <Route path="/personalities/:id" element={<PersonalityDetail />} />
          <Route path="/personality/create" element={<PersonalityCreate />} />
          <Route path="/batch" element={<Batch />} />
          <Route path="/eval" element={<Eval />} />
          <Route path="/goals" element={<Goals />} />
          <Route path="/goals/:id" element={<GoalDetail />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/dashboards" element={<Dashboards />} />
          <Route path="/dashboards/create" element={<CreateDashboardFlow />} />
          <Route path="/dashboards/:id" element={<DashboardView />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/kanban" element={<Kanban />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/setup/provider" element={<Onboarding startAtStep="provider" />} />
          <Route path="/setup/providers" element={<Onboarding startAtStep="multi-provider" />} />
          <Route path="/setup/auth" element={<Onboarding startAtStep="auth" />} />
          <Route path="/setup/keys" element={<Onboarding startAtStep="key-rotation" />} />
          <Route path="/setup/model" element={<Onboarding startAtStep="model" />} />
          <Route path="/setup/memory" element={<Onboarding startAtStep="memory" />} />
          <Route path="/setup/personality" element={<Onboarding startAtStep="personality" />} />
          <Route path="/setup/messaging" element={<Onboarding startAtStep="messaging" />} />
          <Route path="/setup/whatsapp/:botId" element={<SetupWhatsApp />} />
          <Route path="/signing-in" element={<SigningIn />} />
          <Route path="/oauth/callback" element={<OAuthCallback />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Routes>
      </main>
      <StatusBar drawerOpen={drawerOpen} onToggleDrawer={() => setDrawerOpen((v) => !v)} />
      {isChat && (
        <RightDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          debugPanelEnabled={config?.debugPanelEnabled ?? false}
        />
      )}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onToggleDrawer={toggleDrawer}
      />
      <PersonalityPickerModal open={newSessionOpen} onClose={closeNewSessionModal} />
      <MobileTabBar />
    </div>
  );
}

/**
 * On desktop, read the Electron bridge connection config on mount.
 * When mode is 'remote', point the SDK client at the remote URL.
 * Bearer-token injection is handled at the network layer by
 * Electron's session.defaultSession.webRequest.onBeforeSendHeaders.
 */
function useDesktopBootstrap(): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!isDesktop || !bridge) return;
    bridge.connection.get().then((conn) => {
      if (conn.mode === 'remote' && conn.url) {
        reinitializeClient(conn.url);
      }
    });
    bridge.plugin.onOAuthComplete(() => {
      qc.invalidateQueries({ queryKey: ['plugins'] });
    });
  }, [qc]);
}

function useDesktopNavigation(): void {
  const navigate = useNavigate();
  useEffect(() => {
    if (!isDesktop || !bridge) return;
    return bridge.navigate.onSession((sessionId) => {
      navigate(`/chat?session=${sessionId}`);
    });
  }, [navigate]);
}

function useDesktopOAuthCallback(): void {
  const navigate = useNavigate();
  useEffect(() => {
    if (!isDesktop || !bridge) return;
    return bridge.oauth.onCallback((data) => {
      navigate(`/oauth/callback?code=${data.code}&state=${data.state}`);
    });
  }, [navigate]);
}

function useDesktopThemeSync(): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!isDesktop || !bridge) return;
    return bridge.theme.onChange(() => {
      qc.invalidateQueries({ queryKey: ['config'] });
    });
  }, [qc]);
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
  const { data, isLoading } = useOnboardingState();

  useEffect(() => {
    if (isLoading || !data) return;
    if (data.step === 'done') return;
    if (
      pathname === '/onboarding' ||
      pathname.startsWith('/setup') ||
      pathname === '/signing-in' ||
      pathname === '/oauth/callback'
    )
      return;
    navigate('/onboarding', { replace: true });
  }, [data, isLoading, pathname, navigate]);
}
