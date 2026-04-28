import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { staticRoutes } from '../../routes/static';

// Verifies the SPA static handler. Real files in a tmp dir, real Hono
// router. This is the unit boundary for the route — auth/CSRF wiring is
// covered separately in auth-and-rpc.test.ts.

describe('staticRoutes', () => {
  let dist: string;
  let app: ReturnType<typeof staticRoutes>;

  beforeEach(async () => {
    dist = await mkdtemp(join(tmpdir(), 'ethos-static-'));
    await mkdir(join(dist, 'assets'), { recursive: true });
    await writeFile(join(dist, 'index.html'), '<!doctype html><div id="root"></div>', 'utf-8');
    await writeFile(join(dist, 'assets', 'app.js'), 'console.log(1);', 'utf-8');
    await writeFile(join(dist, 'assets', 'app.css'), 'body{color:red}', 'utf-8');
    app = staticRoutes({ dist });
  });

  afterEach(async () => {
    await rm(dist, { recursive: true, force: true });
  });

  it('serves index.html with no-cache and the html content type', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('<div id="root"></div>');
  });

  it('serves hashed assets with long-cache and the right content type', async () => {
    const js = await app.request('/assets/app.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('application/javascript');
    expect(js.headers.get('cache-control')).toMatch(/max-age=31536000/);

    const css = await app.request('/assets/app.css');
    expect(css.headers.get('content-type')).toContain('text/css');
  });

  it('falls back to index.html for unmatched non-API paths (SPA routing)', async () => {
    const res = await app.request('/chat/some/deep/route');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<div id="root"></div>');
  });

  it('rejects path-traversal attempts', async () => {
    // The traversal target lives outside `dist`; the handler should fall
    // back to index.html instead of resolving the parent directory.
    const res = await app.request('/../../etc/passwd');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('returns 503 with an actionable message when index.html is missing', async () => {
    await rm(join(dist, 'index.html'), { force: true });
    const res = await app.request('/');
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/build/i);
  });
});
