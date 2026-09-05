import './styles.css';
import './styles/team-panes.css';
import './styles/team-structure.css';
import './styles/team-chat.css';
import { tokensToAntd, tokensToCssVariables } from '@ethosagent/design-tokens/antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider, type ThemeConfig } from 'antd';
import React, { useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { useConfigRetryFalse } from './features/config/api/queries';
import { NewSessionModalProvider } from './hooks/useNewSessionModal';
import {
  applyReducedMotion,
  REDUCED_MOTION_STYLESHEET,
  watchReducedMotion,
} from './lib/reduced-motion';
import { resolveTokensForSkin } from './lib/skin-tokens';
import { QuickChat } from './pages/QuickChat';

// Boot order: QueryClientProvider → Root → ConfigProvider → ...
//
// Root reads `config.skin` (from ~/.ethos/config.yaml via rpc.config.get)
// and computes the Antd ThemeConfig from the resolved tokens. When the
// user picks a different skin in the Settings page, the mutation
// invalidates ['config'] which re-runs the query and re-renders this
// component — the new theme flows into Antd ConfigProvider without a
// full reload.

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Single-user local app — refetch-on-focus thrashes against an idle
      // tab. Tabs that need fresh data invalidate explicitly via mutation
      // `onSuccess`.
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: 1,
    },
  },
});

function Root() {
  // Config may not exist yet (first-time onboarding). Fall back to default
  // skin so the shell still renders.
  const configQuery = useConfigRetryFalse();
  const skinName = configQuery.data?.skin ?? 'paper';

  const resolvedTokens = useMemo(() => resolveTokensForSkin(skinName), [skinName]);

  // prefers-reduced-motion — DESIGN.md line 139 says every transition
  // and animation must freeze under `reduce`. Track the OS preference,
  // collapse Antd motionDuration tokens to 0s, and inject a global stop-
  // animation stylesheet. Mid-session OS toggles take effect via the
  // matchMedia change listener.
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => watchReducedMotion(setReduceMotion), []);

  const antdTheme: ThemeConfig = useMemo(() => {
    // tokensToAntd picks darkAlgorithm vs defaultAlgorithm from the skin's
    // bgBase luminance — paper flips to light, default/mono stay on dark.
    const base = tokensToAntd(resolvedTokens);
    return reduceMotion ? applyReducedMotion(base) : base;
  }, [resolvedTokens, reduceMotion]);

  // Root CSS variables (surface colors + layout dimensions). Re-emitted on
  // every skin change so the static rules in styles.css (`var(--ethos-bg)`,
  // `var(--layout-sidebar-expanded)`, …) follow the active skin without a
  // reload. Replaces the hardcoded `--ethos-bg: #0f0f0f` and friends that
  // used to be baked into the stylesheet's `:root`.
  useEffect(() => {
    const id = 'ethos-skin-tokens';
    let el = document.getElementById(id) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      document.head.appendChild(el);
    }
    el.textContent = tokensToCssVariables(resolvedTokens);
  }, [resolvedTokens]);

  // Global reduce-motion stylesheet — covers CSS-driven animations
  // (thinking dots, streaming cursor, drawer slide-ins) that don't read
  // from Antd tokens. Inserted only while the preference is active so
  // turning it off restores normal motion immediately.
  useEffect(() => {
    const id = 'ethos-reduced-motion';
    let el = document.getElementById(id) as HTMLStyleElement | null;
    if (!reduceMotion) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      document.head.appendChild(el);
    }
    el.textContent = REDUCED_MOTION_STYLESHEET;
  }, [reduceMotion]);

  const isQuickChat =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('mode') === 'quickchat';

  if (isQuickChat) {
    return (
      <ConfigProvider theme={antdTheme}>
        <AntApp>
          <QuickChat />
        </AntApp>
      </ConfigProvider>
    );
  }

  return (
    <ConfigProvider theme={antdTheme}>
      <AntApp>
        <BrowserRouter>
          <NewSessionModalProvider>
            <App />
          </NewSessionModalProvider>
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  </React.StrictMode>,
);
