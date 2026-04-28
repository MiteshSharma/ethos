import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Hono } from 'hono';

// Static handler for the bundled `apps/web/dist/` SPA. We don't use
// `@hono/node-server`'s `serveStatic` because it requires CWD-relative
// paths (`Absolute paths are not supported.`), and `ethos serve` can be
// launched from anywhere. ~30 lines is cheaper than a fragile CWD dance.
//
// Two responsibilities:
//   • Serve any built file that exists under `dist/` with the right
//     Content-Type.
//   • SPA fallback — for non-API GETs that don't match a file, serve
//     `index.html`. React Router handles the route in the browser.
//
// API + auth + SSE routes are mounted BEFORE this on the Hono app, so
// the static handler only ever sees requests they didn't match.

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export interface StaticRoutesOptions {
  /** Absolute path to the built SPA output (typically `apps/web/dist`). */
  dist: string;
}

export function staticRoutes(opts: StaticRoutesOptions) {
  const app = new Hono();
  // Resolve once at construction so symlinks + relative inputs canonicalise
  // to a stable directory. Path-traversal defense further down keys off
  // this canonical root.
  const root = resolve(opts.dist);

  app.get('/*', async (c) => {
    const requestPath = decodeURIComponent(new URL(c.req.url).pathname);

    // 1. Try the literal asset path.
    const assetResponse = await tryServe(root, requestPath);
    if (assetResponse) return assetResponse;

    // 2. SPA fallback — anything else maps to index.html so client routing
    //    handles deep links.
    const indexResponse = await tryServe(root, '/index.html');
    if (indexResponse) return indexResponse;

    return c.text('Web build missing. Run `pnpm --filter @ethosagent/web build`.', 503);
  });

  return app;
}

async function tryServe(root: string, requestPath: string): Promise<Response | null> {
  // Reject path-traversal attempts before resolving — `resolve` would
  // happily climb out of `root` if we let `..` segments through.
  const safeRel = normalize(requestPath).replace(/^[\\/]+/, '');
  if (safeRel.includes(`..${sep}`) || safeRel === '..') return null;

  const filePath = join(root, safeRel || 'index.html');
  if (!filePath.startsWith(`${root}${sep}`) && filePath !== root) return null;

  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(filePath);
  } catch {
    return null;
  }
  if (!stats.isFile()) return null;

  const body = await readFile(filePath);
  // `body` is a Node Buffer — coerce to a fresh ArrayBuffer slice so the
  // Web Response constructor accepts it without DOM-lib type friction.
  const ab = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  const headers = new Headers({
    'content-type': MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'content-length': String(stats.size),
    // index.html should always re-fetch so SPA users see fresh shell on
    // deploy. Hashed assets get long cache.
    'cache-control': filePath.endsWith('index.html')
      ? 'no-cache'
      : 'public, max-age=31536000, immutable',
  });
  return new Response(ab, { headers });
}
