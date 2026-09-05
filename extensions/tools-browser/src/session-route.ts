// ---------------------------------------------------------------------------
// The browser's SSRF route guard
// ---------------------------------------------------------------------------
//
// Imports NOTHING from `sessions.ts` — the dependency runs the other way, so
// `sessions.ts` can install the guard on a replacement context BEFORE it
// publishes it onto a live BrowserSession.

import { lookup } from 'node:dns/promises';
import { type NetworkPolicy, validateUrl } from '@ethosagent/safety-network';
import type { BrowserContext } from 'playwright';

async function resolveHost(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true });
  return records.map((r) => r.address);
}

// Tracks which CONTEXTS have had their route installed.
//
// Keyed on the BrowserContext, NOT on the BrowserSession: `route()` handlers
// live on the context, and D5's in-place relaunch swaps a session's context
// while keeping the session object identical. A session-keyed memo would
// therefore report "already installed" for a brand-new, unguarded context and
// silently drop the SSRF guard for the rest of that session's life. Keying on
// the thing the handler actually attaches to makes that unrepresentable — and
// is why this function takes a context rather than a session.
const installedRoutes = new WeakSet<BrowserContext>();

// Schemes the browser route allows through without policy validation.
// Default-deny: anything not on this list is aborted.
const BROWSER_ALLOWED_NON_HTTP_PREFIXES = ['about:'];

export async function installRouteGuard(
  context: BrowserContext,
  policy: NetworkPolicy,
): Promise<void> {
  if (installedRoutes.has(context)) return;
  await context.route('**/*', async (route) => {
    const reqUrl = route.request().url();
    const isHttp = reqUrl.startsWith('http://') || reqUrl.startsWith('https://');
    if (!isHttp) {
      const allowed = BROWSER_ALLOWED_NON_HTTP_PREFIXES.some((p) => reqUrl.startsWith(p));
      if (allowed) {
        await route.continue();
        return;
      }
      await route.abort('failed');
      return;
    }
    const check = await validateUrl(reqUrl, policy, resolveHost);
    if (!check.ok) {
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  installedRoutes.add(context);
}
