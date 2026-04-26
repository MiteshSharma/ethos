import { defineConfig } from 'tsup';

// Bundle internal @ethosagent/* workspace deps INTO the cli (so users don't need
// every extension as a separate npm install). Two exceptions are kept external:
// @ethosagent/core and @ethosagent/types are published separately for plugin
// authors and remain real deps in package.json — npm installs them.
//
// Every other npm dep (anthropic, openai, ink, react, better-sqlite3, etc.) is
// listed in package.json `dependencies` / `optionalDependencies` and resolved
// from node_modules at runtime — bundling them would explode the dist size and
// break native modules.
//
// External strategy: externalize everything-not-@ethosagent, then noExternal
// the workspace internals to override.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  splitting: false,
  // #!/usr/bin/env node makes dist/index.js directly executable.
  banner: {
    js: '#!/usr/bin/env node',
  },
  // Externalize every bare module except internal @ethosagent/* workspace deps.
  external: [
    /^[a-z]/, // bare modules: ink, react, openai, croner, ws, ...
    /^@(?!ethosagent\/)/, // scoped modules outside our org: @slack/bolt, @anthropic-ai/sdk, ...
    '@ethosagent/core', // public — plugin authors install separately
    '@ethosagent/types', // public — plugin authors install separately
  ],
  noExternal: [/^@ethosagent\/(?!core$|types$)/],
  dts: false,
  sourcemap: false,
  minify: false,
});
