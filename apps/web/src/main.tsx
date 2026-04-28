import './styles.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { baseTheme } from './lib/theme';

// Boot order mirrors the praxis stack pivot (plan/phases/26-web-ui.md "Stack
// pivot 2026-04-26"):
//   QueryClientProvider → ConfigProvider → BrowserRouter → AntApp → App
// AntApp gives us imperative `message` / `notification` / `Modal` outlets
// from anywhere in the tree without a separate `<App.useApp />` plumb.
//
// Theme tokens live in `lib/theme.ts` so the chat surface can wrap its
// subtree in a per-personality variant (`personalityTheme(id)`) without
// re-declaring the base palette.

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

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfigProvider theme={baseTheme}>
        <AntApp>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </AntApp>
      </ConfigProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
