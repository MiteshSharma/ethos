import { useQueryClient } from '@tanstack/react-query';
import { ConfigProvider } from 'antd';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { AltitudeRail } from './components/AltitudeRail';
import { CommandPalette } from './components/CommandPalette';
import { MobileTabBar } from './components/MobileTabBar';
import { NewAgentDialog } from './components/NewAgentDialog';
import { PersonalityPickerModal } from './components/PersonalityPickerModal';
import { RightDrawer } from './components/RightDrawer';
import { ScopeNav } from './components/ScopeNav';
import { StageHeader } from './components/StageHeader';
import { StatusBar } from './components/StatusBar';
import {
  LegacyTeamRedirect,
  TeamHomeRedirect,
  TeamMemberRedirect,
  TeamScopeGuard,
} from './components/TeamRouteGuards';
import { NeedsYouPill } from './components/team/NeedsYouPill';
import { SupervisorStatus } from './components/team/SupervisorStatus';
import { useConfig, useOnboardingState } from './features/config/api/queries';
import { useGoalDetail } from './features/goals/api/queries';
import { useSessionGet } from './features/sessions/api/queries';
import { useCrossHighlight } from './hooks/useCrossHighlight';
import { useNewSessionModal } from './hooks/useNewSessionModal';
import { usePushEventToasts } from './hooks/usePushEventToasts';
import { useRunStream } from './hooks/useRunStream';
import { useSessionTitleSync } from './hooks/useSessionTitleSync';
import { bridge, isDesktop } from './lib/desktop';
import {
  clearLastTeamId,
  getLastPersonalityId,
  setLastPersonalityId,
  setLastTeamId,
} from './lib/lastPersonality';
import { runsNeedingYou } from './lib/pi-run-reducer';
import {
  extractTeamId,
  extractWorkspacePersonalityId,
  TEAM_PANES,
  type TeamPaneKey,
} from './lib/scopeNav';
import { accentVars, personalityAccent, personalityTheme } from './lib/theme';
import {
  buildIdentityRedirectPath,
  buildWorkspaceRedirectPath,
  isChatPathname,
  resolveChatRedirectPath,
  resolveFallbackPersonalityId,
  resolveGoalRedirectPath,
  sessionOpenPath,
} from './lib/workspaceRoutes';
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
import { RecipeDetail } from './pages/RecipeDetail';
import { Recipes } from './pages/Recipes';
import { Sessions } from './pages/Sessions';
import { SetupWhatsApp } from './pages/SetupWhatsApp';
import { SigningIn } from './pages/SigningIn';
import { Skills } from './pages/Skills';
import { SettingsPaneRoute } from './pages/settings/SettingsPaneRoute';
import { SettingsShell } from './pages/settings/SettingsShell';
import { Tasks } from './pages/Tasks';
import { TeamCreate } from './pages/TeamCreate';
import { Teams } from './pages/Teams';
import { TeamActivity } from './pages/team/TeamActivity';
import { TeamBoard } from './pages/team/TeamBoard';
import { TeamChannels } from './pages/team/TeamChannels';
import { TeamChat } from './pages/team/TeamChat';
import { TeamDocuments } from './pages/team/TeamDocuments';
import { TeamMemory } from './pages/team/TeamMemory';
import { TeamOverview } from './pages/team/TeamOverview';
import { TeamSettings } from './pages/team/TeamSettings';
import { TeamStructure } from './pages/team/TeamStructure';
import { rpc } from './rpc';

// Top-level route map. v0 ships only Talk-group routes (Chat + Sessions)
// plus the onboarding flow and the signing-in placeholder. v0.5 adds the
// right-side activity drawer and the surfaces it observes (Skills, Mesh
// — landing alongside this commit). Lab / System groups arrive in v1.

// The workspace route table — ONE list rendered under both prefixes
// (`/p/:personalityId/…` and, teams-as-a-scope T1 D6, `/t/:teamId/p/
// :personalityId/…`), so a member's workspace inside a team is the same
// twelve pages by construction, never a hand-copied second list.
const WORKSPACE_ROUTES: ReadonlyArray<{ path: string; element: ReactNode }> = [
  { path: 'chat', element: <ChatRoute /> },
  { path: 'sessions', element: <Sessions /> },
  { path: 'memory', element: <Memory /> },
  { path: 'documents', element: <Documents /> },
  { path: 'schedule', element: <Cron /> },
  { path: 'goals', element: <Goals /> },
  { path: 'goals/:goalId', element: <GoalDetail /> },
  { path: 'tasks', element: <Tasks /> },
  { path: 'skills', element: <Skills /> },
  { path: 'mcp', element: <Mcp /> },
  { path: 'plugins', element: <Plugins /> },
  { path: 'activity', element: <Activity /> },
  { path: 'identity', element: <PersonalityDetail /> },
];

// T1 placeholders for the team panes (`/t/:teamId/<pane>`), keyed by
// `TEAM_PANES` so the route table and the column can't disagree; T2/T3
// swap the bodies.
const TEAM_PANE_ELEMENTS: Record<TeamPaneKey, ReactNode> = {
  chat: <TeamChat />,
  overview: <TeamOverview />,
  board: <TeamBoard />,
  structure: <TeamStructure />,
  documents: <TeamDocuments />,
  memory: <TeamMemory />,
  activity: <TeamActivity />,
  channels: <TeamChannels />,
  settings: <TeamSettings />,
};

const DRAWER_BREAKPOINT = 1280; // px — plan IA: drawer "default visible ≥1280px"
// P1b's AltitudeRail + ScopeNav have no collapsed mode of their own — the
// responsive collapse of the 216px column at this same breakpoint (rail
// remains as personality switcher) is explicit P6 scope in the plan, not
// this phase. The old Sidebar's collapse toggle is dropped along with it.

export function App() {
  const [drawerOpen, setDrawerOpen] = useState(() =>
    typeof window === 'undefined' ? false : window.innerWidth >= DRAWER_BREAKPOINT,
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Rail `+`'s "Quick create" and the palette's "New agent" action open the
  // SAME `NewAgentDialog` instance (P5 item 1 + item 3) — lifted here rather
  // than owned by AltitudeRail, same reason `paletteOpen`/`drawerOpen` live
  // at this level: both entry points are direct children of this shell.
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
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
  const isChat = isChatPathname(pathname);
  const workspacePersonalityId = extractWorkspacePersonalityId(pathname);
  const teamId = extractTeamId(pathname);

  // teams-as-a-scope T4 (D12): one delegated hover handler on the shell
  // root lights up every `data-p` carrier of the hovered member, across
  // panes. Only inside a team — at the Library the attribute is inert.
  const shellRef = useRef<HTMLDivElement>(null);
  useCrossHighlight(shellRef, teamId !== null);

  // Remember the last personality workspace the user was inside — the `/`
  // and `/chat` fallback chain's second link (P1a), after `?session=` and
  // before the config default.
  useEffect(() => {
    if (workspacePersonalityId) setLastPersonalityId(workspacePersonalityId);
  }, [workspacePersonalityId]);

  // And the last team scope (teams-as-a-scope T1) — set on every
  // `/t/:teamId/…` route, cleared the moment the user is back at Independent.
  useEffect(() => {
    if (teamId) setLastTeamId(teamId);
    else clearLastTeamId();
  }, [teamId]);

  // Hide the activity drawer when crossing below the breakpoint it needs
  // grid space at. We don't *force* it open/closed on every resize tick —
  // just when crossing — so a user who manually toggled it mid-session
  // keeps their preference until the next breakpoint flip.
  useEffect(() => {
    let lastNarrow = typeof window !== 'undefined' && window.innerWidth < DRAWER_BREAKPOINT;
    const onResize = () => {
      if (typeof window === 'undefined') return;
      const narrow = window.innerWidth < DRAWER_BREAKPOINT;
      if (narrow !== lastNarrow) {
        lastNarrow = narrow;
        setDrawerOpen(!narrow);
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

  // One shell-level subscription feeds all three delegated-run surfaces — the
  // drawer Runs pane, the status pill and the Tasks nav badge (§4.3/§4.4/D25).
  // Subscribing in each of them would open three connections to the same
  // session for one digest.
  const runs = useRunStream();
  const runStream = {
    runs: runs.runs,
    clarifyQueue: runs.clarifyQueue,
    needsYou: runsNeedingYou(runs.runs).length,
  };

  // The drawer column is reserved only where `RightDrawer` is mounted (chat
  // routes, below) — every other route (Library, team panes) keeps the full
  // stage width instead of a blank right third.
  const shellClass = ['app-shell', isChat && drawerOpen ? 'drawer-open' : '']
    .filter(Boolean)
    .join(' ');

  // Per DESIGN.md's P0 amendment: global chrome (the rail) stays neutral
  // forever; the contextual column and the stage carry the active scope's
  // accent. The lift target used to be the chat tab (Chat.tsx's own
  // `<ConfigProvider>` + `accentVars`) — it now wraps ScopeNav + StageHeader
  // + the routed stage together, whenever a `/p/:personalityId/*` route is
  // active. `display: contents` keeps the wrapper out of the `.app-shell`
  // grid — ScopeNav and `.app-main` still get their own named grid areas.
  const scopeAndStage = (
    <>
      <ScopeNav needsYouCount={runStream.needsYou} />
      {/* T4 (D11): the Needs-you pill lives at the TEAM altitude only — a
          member's workspace inside the team keeps the plain breadcrumb. */}
      <StageHeader
        needsYouSlot={
          teamId && !workspacePersonalityId ? (
            <>
              <NeedsYouPill teamId={teamId} />
              <SupervisorStatus teamId={teamId} />
            </>
          ) : undefined
        }
      />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<ChatRedirect />} />

          {/* Workspace routes (P1a) — personality-scoped URLs for the eleven
              pages below, plus Chat. These are new addresses for the same
              page bodies; StatusBar/MobileTabBar are unchanged. (Sidebar
              rendered this chrome at P1a time — P1b replaces it with
              AltitudeRail + ScopeNav, see the shell's return below.) */}
          {WORKSPACE_ROUTES.map((r) => (
            <Route
              key={`p:${r.path}`}
              path={`/p/:personalityId/${r.path}`}
              element={<TeamMemberRedirect>{r.element}</TeamMemberRedirect>}
            />
          ))}

          {/* The team altitude (teams-as-a-scope T1, §1): a bare `/t/:teamId`
              lands on Overview (D5); each pane; and a member's workspace
              under the team prefix — the SAME elements as above (D6). Every
              `/t/` route is guarded: an unknown team bounces to `/teams`, a
              non-member to the team's overview, each with a toast. */}
          <Route path="/t/:teamId" element={<TeamHomeRedirect />} />
          {TEAM_PANES.map((pane) => (
            <Route
              key={`t:${pane.key}`}
              path={`/t/:teamId/${pane.key}`}
              element={<TeamScopeGuard>{TEAM_PANE_ELEMENTS[pane.key]}</TeamScopeGuard>}
            />
          ))}
          {WORKSPACE_ROUTES.map((r) => (
            <Route
              key={`t:p:${r.path}`}
              path={`/t/:teamId/p/:personalityId/${r.path}`}
              element={<TeamScopeGuard>{r.element}</TeamScopeGuard>}
            />
          ))}

          {/* Old URLs — permanent redirects to the workspace routes above. */}
          <Route path="/chat" element={<ChatRedirect />} />
          <Route path="/sessions" element={<WorkspaceRedirect suffix="sessions" />} />
          <Route path="/cron" element={<WorkspaceRedirect suffix="schedule" />} />
          {/* /skills, /mcp, /plugins keep serving their bare global-list URL
              as the Library twin address — that decision was made in P1a/P2
              and P3 (dual-altitude twins) doesn't move it, only fills in the
              twin's content (attach/detach, "Used by" marks). Redirecting it
              away would break the only page that currently answers "all
              skills" with no replacement. The workspace-scoped route above
              renders the same component as an additional path, not a
              replacement. */}
          <Route path="/skills" element={<Skills />} />
          {/* Library Advanced's "System cron" destination (P2): the SAME
              <Cron/> component, rendered with no `:personalityId` so it
              lists `source === 'system'` jobs — the old bare `/cron` above
              always redirects into a workspace and can't be reused for
              this, since P1a already claimed it as a legacy bookmark
              redirect (Route map: old `/cron` → workspace `/schedule`). */}
          <Route path="/library/cron" element={<Cron />} />
          {/* P3's remaining Library twins. Sessions and Tasks had no
              existing bare-URL twin the way Skills/MCP/Plugins did (P1a
              claimed `/sessions` and `/tasks` as workspace-redirect legacy
              bookmarks — Route map above), so both get a `/library/…`
              address instead: the SAME component, rendered with no
              `:personalityId`, same pattern as `/library/cron`. */}
          <Route path="/library/sessions" element={<Sessions />} />
          <Route path="/library/tasks" element={<Tasks />} />
          <Route path="/mesh" element={<Mesh />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/teams" element={<Teams />} />
          <Route path="/teams/create" element={<TeamCreate />} />
          {/* The pre-T1 Control Center address — permanent redirect into the
              team's Board pane. */}
          <Route path="/teams/:name" element={<LegacyTeamRedirect />} />
          {/* The shell is the layout route: it owns the one <Form>, and the
              panes mount inside it through its <Outlet/>. Every child renders
              SettingsPaneRoute, which resolves the URL to a real
              category/section and redirects (replace) when it has to. */}
          <Route path="/settings" element={<SettingsShell />}>
            <Route index element={<SettingsPaneRoute />} />
            <Route path=":category" element={<SettingsPaneRoute />} />
            <Route path=":category/:section" element={<SettingsPaneRoute />} />
          </Route>
          <Route path="/memory" element={<WorkspaceRedirect suffix="memory" />} />
          <Route path="/documents" element={<WorkspaceRedirect suffix="documents" />} />
          <Route path="/plugins" element={<Plugins />} />
          <Route path="/mcp" element={<Mcp />} />
          <Route path="/plugins/:pluginId" element={<PluginPage />} />
          <Route path="/communications" element={<Communications />} />
          {/* Recipes — a Library-altitude catalog (plan/phases/recipes-gallery.md
              §5/D1). The detail route carries the whole install walk (detail →
              needs-you → confirm → post-install) because preflight is stateless:
              a reload loses nothing, so the steps need no addresses of their own. */}
          <Route path="/recipes" element={<Recipes />} />
          <Route path="/recipes/:id" element={<RecipeDetail />} />
          <Route path="/personalities" element={<Personalities />} />
          <Route path="/personalities/:id" element={<IdentityRedirect />} />
          <Route path="/personality/create" element={<PersonalityCreate />} />
          <Route path="/batch" element={<Batch />} />
          <Route path="/eval" element={<Eval />} />
          <Route path="/goals" element={<WorkspaceRedirect suffix="goals" />} />
          <Route path="/goals/:id" element={<GoalRedirect />} />
          <Route path="/tasks" element={<WorkspaceRedirect suffix="tasks" />} />
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
    </>
  );

  return (
    <div ref={shellRef} className={shellClass}>
      <AltitudeRail onOpenQuickCreate={() => setQuickCreateOpen(true)} />
      {workspacePersonalityId ? (
        <ConfigProvider theme={personalityTheme(workspacePersonalityId)}>
          <div
            className="workspace-accent-scope"
            style={accentVars(personalityAccent(workspacePersonalityId))}
          >
            {scopeAndStage}
          </div>
        </ConfigProvider>
      ) : (
        scopeAndStage
      )}
      <StatusBar
        drawerOpen={drawerOpen}
        onToggleDrawer={() => setDrawerOpen((v) => !v)}
        runs={runStream.runs}
      />
      {isChat && (
        <RightDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          debugPanelEnabled={config?.debugPanelEnabled ?? false}
          runs={runStream.runs}
          clarifyQueue={runStream.clarifyQueue}
        />
      )}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onToggleDrawer={toggleDrawer}
        onOpenQuickCreateAgent={() => setQuickCreateOpen(true)}
      />
      <PersonalityPickerModal open={newSessionOpen} onClose={closeNewSessionModal} />
      {quickCreateOpen ? <NewAgentDialog onClose={() => setQuickCreateOpen(false)} /> : null}
      <MobileTabBar />
    </div>
  );
}

/**
 * On desktop, subscribe to the Electron bridge's plugin OAuth completions.
 *
 * The renderer does not need to know whether the backend is local or remote:
 * in remote mode the desktop window navigates to the remote server, which
 * serves this SPA itself, so `window.location.origin` is already the right API
 * base in both modes and no request is ever cross-origin.
 */
function useDesktopBootstrap(): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!isDesktop || !bridge) return;
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
      // The Electron menu only hands us a session id — fetch its personality
      // so we can land directly on the new workspace URL instead of bouncing
      // through the `/chat?session=` redirect. If the lookup fails, that
      // redirect is still a correct fallback.
      rpc.sessions
        .get({ id: sessionId })
        .then((result) => {
          navigate(sessionOpenPath(sessionId, result.session.personalityId));
        })
        .catch(() => {
          navigate(sessionOpenPath(sessionId, null));
        });
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

/**
 * Forces `<Chat/>` to fully remount whenever the workspace route's
 * `:personalityId` changes (P2, plan/phases/personality-first-ui.md).
 * Without this, React Router reuses the same `<Chat/>` instance across
 * `/p/engineer/chat` → `/p/researcher/chat` — same component type, same
 * position in the tree, only the param differs — so none of its
 * session/voice/attachment state resets on its own. Keying on the id is the
 * standard React fix for "this subtree is tied to an id; give it a fresh
 * instance when the id changes" (see AltitudeRail / `sessionOpenPath` /
 * redirects — every path that lands here can change the id without
 * unmounting the route).
 */
function ChatRoute() {
  const { personalityId, teamId } = useParams<{ personalityId: string; teamId?: string }>();
  return <Chat key={`${teamId ?? ''}:${personalityId}`} />;
}

// --- P1a permanent redirects — plan/phases/personality-first-ui.md ---------
//
// Every route below renders instead of a page body: it resolves a target
// `/p/:personalityId/…` URL and hands off via `<Navigate replace>`, the same
// pattern `/` → `/chat` already used. The resolution itself is the pure,
// unit-tested logic in `lib/workspaceRoutes.ts`; these components only wire
// hooks to it.

/** `/` and `/chat`, with or without `?session=`. */
function ChatRedirect() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get('session');
  const sessionQuery = useSessionGet(sessionId);
  const { data: config } = useConfig();

  const target = resolveChatRedirectPath({
    sessionId,
    sessionLoading: sessionQuery.isLoading,
    sessionPersonalityId: sessionQuery.data?.session.personalityId,
    fallbackPersonalityId: resolveFallbackPersonalityId(
      getLastPersonalityId(),
      config?.personality,
    ),
    search: location.search,
  });

  if (!target) return null;
  return <Navigate to={target} replace />;
}

/** The flat old routes with no personality context of their own:
 * `/sessions`, `/memory`, `/documents`, `/cron` (→ `schedule`), `/goals`,
 * `/tasks`. */
function WorkspaceRedirect({ suffix }: { suffix: string }) {
  const location = useLocation();
  const { data: config } = useConfig();
  const fallbackPersonalityId = resolveFallbackPersonalityId(
    getLastPersonalityId(),
    config?.personality,
  );
  return (
    <Navigate
      to={buildWorkspaceRedirectPath(fallbackPersonalityId, suffix, location.search)}
      replace
    />
  );
}

/** `/goals/:id` → `/p/:personalityId/goals/:goalId`. */
function GoalRedirect() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const { data: config } = useConfig();
  const goalId = id ?? '';
  const goalQuery = useGoalDetail(goalId);

  const target = resolveGoalRedirectPath({
    goalId,
    goalLoading: goalQuery.isLoading,
    goalPersonalityId: goalQuery.data?.goal.personalityId,
    fallbackPersonalityId: resolveFallbackPersonalityId(
      getLastPersonalityId(),
      config?.personality,
    ),
    search: location.search,
  });

  if (!target) return null;
  return <Navigate to={target} replace />;
}

/** `/personalities/:id` → `/p/:personalityId/identity`. */
function IdentityRedirect() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  return <Navigate to={buildIdentityRedirectPath(id ?? '', location.search)} replace />;
}
