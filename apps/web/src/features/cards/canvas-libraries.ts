import type { CanvasLibrary } from '@ethosagent/web-contracts';

// The versioned library allowlist, resolved to source text the Canvas document
// inlines. Local bundles only — the guest CSP is `default-src 'none'`, so a
// CDN URL would not load even if someone added one, and that is the point.
//
// Each entry is a dynamic import of a `?raw` asset: the bytes land in their
// own chunk and are fetched the first time a Canvas actually asks for that
// library, never on app start.

const LOADERS: Record<CanvasLibrary, () => Promise<string>> = {
  'echarts@1': () => import('echarts/dist/echarts.min.js?raw').then((m) => m.default),
};

/** True when the server-side allowlist and this bundle agree on a name. */
export function isSupportedCanvasLibrary(name: string): name is CanvasLibrary {
  return Object.hasOwn(LOADERS, name);
}

/**
 * Source text for each requested library, in request order. Rejects on the
 * first unknown name — the server validates the allowlist, so reaching here
 * with one means the client is older than the agent and the caller should
 * render the unknown-card fallback rather than a half-built document.
 */
export async function loadCanvasLibraries(names: readonly string[]): Promise<string[]> {
  return Promise.all(
    names.map((name) => {
      if (!isSupportedCanvasLibrary(name)) {
        throw new Error(`Unsupported Canvas library: ${name}`);
      }
      return LOADERS[name]();
    }),
  );
}
