import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Vite config for the web client. Two run modes:
//
//  • Dev   — `pnpm --filter @ethosagent/web dev` runs Vite at :5173 with the
//            `/rpc`, `/sse`, `/auth`, `/openapi` paths proxied to the
//            ethos-serve API on :3000. Cookies sent by the API stay scoped
//            to localhost so the proxy is transparent.
//  • Build — `pnpm --filter @ethosagent/web build` writes to `apps/web/dist/`.
//            `extensions/web-api`'s static handler serves that directory in
//            production runs of `ethos serve --web-experimental`.
//
// The `@ethosagent/*` aliases mirror the root tsconfig so workspace imports
// resolve to source — same pattern the rest of the monorepo uses (no build
// step in dev).

const root = resolve(__dirname, '../..');

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  resolve: {
    alias: {
      '@ethosagent/web-contracts': resolve(root, 'packages/web-contracts/src'),
    },
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
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
