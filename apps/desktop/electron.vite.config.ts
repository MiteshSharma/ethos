import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

const ROOT = resolve(import.meta.dirname, '../..');

// Read workspace path aliases from the root tsconfig so that all @ethosagent/*
// imports are resolved as source files directly — bypassing package `exports`
// resolution entirely (which would fail because exports point to .ts files).
// This handles both direct and transitive @ethosagent/* imports.
const tsconfig = JSON.parse(readFileSync(resolve(ROOT, 'tsconfig.json'), 'utf-8')) as {
  compilerOptions?: { paths?: Record<string, string[]> };
};
const paths = tsconfig.compilerOptions?.paths ?? {};

// Tsconfig paths point to directories (e.g. ./packages/core/src) OR bare files
// (e.g. ./extensions/memory-markdown/src/compose for compose.ts). Probe both.
const resolveWorkspaceSrc = (dirPath: string): string => {
  const asIndex = resolve(ROOT, dirPath, 'index.ts');
  if (existsSync(asIndex)) return asIndex;
  const asFile = resolve(ROOT, `${dirPath}.ts`);
  if (existsSync(asFile)) return asFile;
  return asIndex; // fallback — build will surface the missing file clearly
};

const ethosSourceMap = new Map(
  Object.entries(paths)
    .filter(([key]) => key.startsWith('@ethosagent/'))
    .map(([key, [dirPath]]) => [key, resolveWorkspaceSrc(dirPath)]),
);

// electron-vite v5 auto-applies externalizeDepsPlugin (enforce: 'pre') which
// wins over any user plugin. Setting build.externalizeDeps: false disables it
// entirely, letting us own all externalization decisions in one plugin.
const bundleWorkspacePackages = {
  name: 'bundle-workspace-packages',
  enforce: 'pre' as const,
  // electron-vite's main-config preset injects `external: ['electron', ...]`
  // via its config() hook, and Vite's mergeConfig CONCATENATES that array with
  // ours rather than replacing it. A bare `'electron'` string in `external`
  // short-circuits rollup's resolution — our resolveId('electron') never fires,
  // so the createRequire shim below is bypassed and a raw `import … from
  // "electron"` (which Electron's ESM linker chokes on) lands in the bundle.
  // Strip the literal once the config is resolved so the shim takes effect.
  // electron/* subpaths and node builtins stay external (handled in resolveId).
  configResolved(config: { build: { rollupOptions: { external?: unknown } } }) {
    const ext = config.build.rollupOptions.external;
    if (Array.isArray(ext)) {
      config.build.rollupOptions.external = ext.filter((e) => e !== 'electron');
    }
  },
  resolveId(id: string) {
    // Bundle @ethosagent/* workspace packages: resolve to their TS source file
    const src = ethosSourceMap.get(id);
    if (src !== undefined) return { id: src, external: false };

    // Native modules resolve to CJS — load via runtime createRequire shims
    // (static ESM import of a CJS module crashes Electron's ESM linker).
    if (id === 'argon2') return '\0req:argon2';

    // Node built-ins stay external.
    if (id.startsWith('node:')) return false;

    // electron subpaths (e.g. electron/main) stay external — MUST come before
    // the bare-electron check below.
    if (id.startsWith('electron/')) return false;

    // Bare `electron` resolves to CJS — load via a createRequire shim.
    if (id === 'electron') return '\0electron-require-shim';

    // Everything else (npm packages, relative/absolute paths): let Vite bundle them.
    // Workspace packages pull in transitive npm deps (gray-matter, yaml, zod, etc.)
    // that pnpm doesn't hoist to root node_modules, so they must be bundled rather
    // than left as runtime externals that Electron can't find.
    return null;
  },
  load(id: string): string | undefined {
    if (id === '\0electron-require-shim') {
      return `import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
export default electron;
export const app = electron.app;
export const BrowserWindow = electron.BrowserWindow;
export const ipcMain = electron.ipcMain;
export const contextBridge = electron.contextBridge;
export const ipcRenderer = electron.ipcRenderer;
export const safeStorage = electron.safeStorage;
export const globalShortcut = electron.globalShortcut;
export const Notification = electron.Notification;
export const session = electron.session;
export const nativeTheme = electron.nativeTheme;
export const systemPreferences = electron.systemPreferences;
export const shell = electron.shell;
export const dialog = electron.dialog;
export const screen = electron.screen;
export const Tray = electron.Tray;
export const nativeImage = electron.nativeImage;
export const Menu = electron.Menu;
`;
    }
    if (id.startsWith('\0req:')) {
      const name = id.slice('\0req:'.length);
      return `import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const mod = require('${name}');
export default mod.default ?? mod;
`;
    }
    return undefined;
  },
};

export default defineConfig({
  main: {
    plugins: [bundleWorkspacePackages],
    define: {
      // __dirname is unavailable in ESM bundles. import.meta.dirname is the
      // ESM equivalent (Node 21.2+). Applied to both app source and bundled
      // CJS packages that reference __dirname at module scope.
      __dirname: 'import.meta.dirname',
      __filename: 'import.meta.filename',
    },
    build: {
      externalizeDeps: false,
      outDir: 'dist/main',
      lib: {
        entry: 'src/main/index.ts',
      },
      rollupOptions: {
        // Native modules are NOT externalized: listing them here would
        // short-circuit rollup's resolution (exactly like the bare 'electron'
        // string that configResolved strips above), bypassing the createRequire
        // shims in resolveId/load. Leave external to the electron-vite preset
        // (node builtins + electron/* subpaths); the shims own the rest.
        external: [],
      },
    },
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: {
          index: 'src/main/preload.ts',
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
        },
      },
    },
  },
});
