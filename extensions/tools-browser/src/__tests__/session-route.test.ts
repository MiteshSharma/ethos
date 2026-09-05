// The SSRF route guard lives on the BrowserContext, but D5 relaunches a
// session IN PLACE — same BrowserSession object, brand-new context. These
// tests pin the consequence: the replacement context must get its own guard.
//
// Revert `installedRoutes` in session-route.ts to `WeakSet<BrowserSession>`
// (its shape before this change) and "reinstalls the SSRF guard on the
// replacement context after an in-place relaunch" fails — the new context
// carries no handler at all, so a private-IP request sails straight through.

import { afterEach, describe, expect, it, vi } from 'vitest';

const pw = vi.hoisted(() => {
  type Handler = (route: unknown) => Promise<void>;
  interface FakeContext {
    handlers: Handler[];
    closed: boolean;
    route: (pattern: string, h: Handler) => Promise<void>;
    close: () => Promise<void>;
    pages: () => unknown[];
    newPage: () => Promise<unknown>;
  }
  const contexts: FakeContext[] = [];
  interface LaunchArgs {
    proxy?: { server: string; username?: string; password?: string };
    headless?: boolean;
  }
  const launches: LaunchArgs[] = [];

  const makePage = () => ({ on: () => {} });
  function makeContext(): FakeContext {
    const ctx: FakeContext = {
      handlers: [],
      closed: false,
      route: async (_pattern, h) => {
        ctx.handlers.push(h);
      },
      close: async () => {
        ctx.closed = true;
      },
      pages: () => [],
      newPage: async () => makePage(),
    };
    contexts.push(ctx);
    return ctx;
  }
  const chromium = {
    launch: async (opts: LaunchArgs = {}) => {
      launches.push(opts);
      const browser = {
        closed: false,
        newContext: async () => makeContext(),
        close: async () => {
          browser.closed = true;
        },
      };
      return browser;
    },
    launchPersistentContext: async () => makeContext(),
  };
  return { chromium, contexts, launches };
});

vi.mock('playwright', () => ({ chromium: pw.chromium }));

const { getOrCreateSessionWithRoute, relaunchSessionWithRoute, sessions } = await import(
  '../sessions'
);

/** Drives an installed route handler and reports what it did. */
async function driveHandler(
  handler: (route: unknown) => Promise<void>,
  url: string,
): Promise<{ aborted?: string; continued: boolean }> {
  const result: { aborted?: string; continued: boolean } = { continued: false };
  await handler({
    request: () => ({ url: () => url }),
    abort: async (reason: string) => {
      result.aborted = reason;
    },
    continue: async () => {
      result.continued = true;
    },
  });
  return result;
}

afterEach(async () => {
  sessions.clear();
  pw.contexts.length = 0;
  pw.launches.length = 0;
});

describe('SSRF route guard across an in-place relaunch (D5)', () => {
  it('installs the guard on a fresh session', async () => {
    const session = await getOrCreateSessionWithRoute('route-fresh', {});
    expect(pw.contexts).toHaveLength(1);
    const handler = pw.contexts[0]?.handlers[0];
    expect(handler).toBeDefined();
    if (!handler) return;
    expect(await driveHandler(handler, 'http://127.0.0.1/')).toEqual({
      aborted: 'failed',
      continued: false,
    });
    await session.close();
  });

  it('reinstalls the SSRF guard on the replacement context after an in-place relaunch', async () => {
    const session = await getOrCreateSessionWithRoute('route-relaunch', {});
    const first = pw.contexts[0];
    expect(first?.handlers).toHaveLength(1);

    // D5: same session object, new context.
    await relaunchSessionWithRoute(session, {}, { tier: 'stealth' });
    expect(pw.contexts).toHaveLength(2);
    const second = pw.contexts[1];
    expect(second).not.toBe(first);
    expect(first?.closed).toBe(true);

    // THE REGRESSION: with the memo keyed on the session object this array is
    // empty, and a private-IP navigation is no longer aborted.
    const handler = second?.handlers[0];
    expect(handler).toBeDefined();
    if (!handler) return;
    expect(await driveHandler(handler, 'http://127.0.0.1/')).toEqual({
      aborted: 'failed',
      continued: false,
    });
  });

  it('does not reinstall the guard twice on the same context', async () => {
    await getOrCreateSessionWithRoute('route-idempotent', {});
    await getOrCreateSessionWithRoute('route-idempotent', {});
    expect(pw.contexts).toHaveLength(1);
    expect(pw.contexts[0]?.handlers).toHaveLength(1);
  });

  it('still allows a public URL through after a relaunch', async () => {
    const session = await getOrCreateSessionWithRoute('route-public', {});
    await relaunchSessionWithRoute(session, {}, {});
    const handler = pw.contexts[1]?.handlers[0];
    expect(handler).toBeDefined();
    if (!handler) return;
    // A public IP literal — never resolved, never private.
    expect(await driveHandler(handler, 'https://93.184.216.34/')).toEqual({ continued: true });
  });
});

// ---------------------------------------------------------------------------
// A4 — the SSRF guard under a proxy
// ---------------------------------------------------------------------------
//
// The plan's version of this test exercises a FRESH proxied session, which
// proves nothing: a fresh session installs its guard on the way in, proxy or
// no proxy. The path that can actually lose the guard is the D5 in-place
// relaunch — which is exactly the call `browser_stealth_session` makes when it
// escalates a blocked page onto the proxy. So the test that matters is a
// RELAUNCH ONTO A PROXY, asserting both that the proxy really took (otherwise
// it is a no-proxy relaunch wearing a proxy's name) and that a private-IP
// request on the replacement context is still aborted.
//
// DNS CAVEAT — the guard is not, and cannot be, complete under a proxy.
// `validateUrl` resolves hostnames with this process's resolver
// (`node:dns.lookup`), but a proxied navigation never resolves anything
// locally: Chromium sends `CONNECT host:port` and the PROXY does the lookup,
// in the proxy's network, on the proxy's resolver. A name that answers with a
// public address here can answer with 10.x inside the proxy's LAN, and the
// guard has no way to see it. The literal-IP case below (and every deny-list
// rule on a literal) still holds because there is nothing to resolve. Deploy a
// proxy you trust not to be an SSRF pivot; the browser guard is not that
// control. The same DNS-rebinding window exists without a proxy — check and
// fetch are two separate lookups — the proxy widens it to a whole second
// resolver.
describe('A4 — SSRF guard survives a relaunch onto a proxy', () => {
  it('aborts a private-IP request on the replacement PROXIED context', async () => {
    const session = await getOrCreateSessionWithRoute('route-proxy', {});
    expect(pw.launches).toHaveLength(1);
    expect(pw.launches[0]?.proxy).toBeUndefined();

    const proxy = { server: 'http://proxy.example.com:3128', username: 'ethos' };
    await relaunchSessionWithRoute(session, {}, { proxy, headless: true });

    // Non-vacuity, part 1: the relaunch really is proxied.
    expect(pw.launches).toHaveLength(2);
    expect(pw.launches[1]?.proxy).toEqual(proxy);
    expect(session.proxyKey).toBe('http://proxy.example.com:3128');

    // Non-vacuity, part 2: it is the REPLACEMENT context under test, and the
    // first one is gone.
    expect(pw.contexts).toHaveLength(2);
    expect(pw.contexts[0]?.closed).toBe(true);

    const handler = pw.contexts[1]?.handlers[0];
    expect(handler).toBeDefined();
    if (!handler) return;
    expect(await driveHandler(handler, 'http://127.0.0.1/')).toEqual({
      aborted: 'failed',
      continued: false,
    });
    expect(await driveHandler(handler, 'http://169.254.169.254/latest/meta-data/')).toEqual({
      aborted: 'failed',
      continued: false,
    });
    // A public literal still passes, so the guard is not simply refusing all.
    expect(await driveHandler(handler, 'https://93.184.216.34/')).toEqual({ continued: true });
  });
});
