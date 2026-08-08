import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type PluginOption } from 'vite';

// Vite config for the web client. Two run modes:
//
//  • Dev   — `pnpm --filter @ethosagent/web dev` runs Vite at :5173 with the
//            `/rpc`, `/sse`, `/auth`, `/openapi`, `/documents` paths proxied
//            to the ethos-serve API on :3000. Cookies sent by the API stay
//            scoped to localhost so the proxy is transparent.
//  • Build — `pnpm --filter @ethosagent/web build` writes to `apps/web/dist/`.
//            `apps/web-api`'s static handler serves that directory in
//            production runs of `ethos serve`.
//
// The `@ethosagent/*` aliases mirror the root tsconfig so workspace imports
// resolve to source — same pattern the rest of the monorepo uses (no build
// step in dev).

const root = resolve(__dirname, '../..');

export default defineConfig({
  plugins: [react()] as PluginOption[],
  root: __dirname,
  resolve: {
    alias: {
      '@ethosagent/web-contracts': resolve(root, 'packages/web-contracts/src'),
      '@ethosagent/ui-components': resolve(root, 'packages/ui-components/src'),
    },
    // Vite's default order puts '.js' ahead of '.ts'/'.tsx'. Several workspace
    // packages still carry committed compiled mirrors next to their sources
    // (`packages/ui-components/src/*.js`), which silently shadowed the real
    // `.tsx` in every build — edits to the source were no-ops. TypeScript
    // first matches what esbuild/tsup already do, so one resolution order
    // holds across bundlers. Same class of bug as f7e920f.
    extensions: ['.mts', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/rpc': 'http://localhost:3000',
      '/sse': {
        target: 'http://localhost:3000',
        changeOrigin: false,
        // SSE keeps the connection open; turn off buffering so events flush.
        ws: false,
      },
      '/auth': 'http://localhost:3000',
      '/openapi': 'http://localhost:3000',
      // OAuth callback — proxy to the API server so the server-side handler
      // runs regardless of whether the DCR redirect_uri points to :5173 or :3000.
      '/oauth': 'http://localhost:3000',
      // Documents download streams bytes over a plain <a download> navigation
      // authenticated by the `SameSite=Strict` `ethos_auth` cookie. It MUST be
      // proxied: an absolute :3000 href from :5173 is cross-site and the
      // browser silently drops the cookie, so the download 401s.
      '/documents': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
