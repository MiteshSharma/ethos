// Item 11 — the configured `browser.navigationTimeoutMs` /
// `browser.commandTimeoutMs` must reach the Playwright calls, not just parse.
//
// We poke a fake session into the exported `sessions` map (the same technique
// sessions.test.ts uses) whose `page` records the options every Playwright
// call receives, then drive the real tools through `createBrowserTools`.

import type { Browser, BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserTools } from '../index';
import { type BrowserSession, makeMapKey, policyFingerprint, sessions } from '../sessions';
import { DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_NAVIGATION_TIMEOUT_MS } from '../timeouts';

// The navigation tools refuse before touching a page when Playwright's browser
// binaries are absent, which is the state in CI. Everything else in the module
// — including the `sessions` map these tests seed — stays real.
vi.mock('../sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sessions')>()),
  isPlaywrightInstalled: () => true,
}));

interface Recorded {
  gotoTimeouts: number[];
  goBackTimeouts: number[];
  clickTimeouts: number[];
}

function fakePage(rec: Recorded) {
  const locator = {
    first: () => locator,
    click: async (opts: { timeout: number }) => {
      rec.clickTimeouts.push(opts.timeout);
    },
    fill: async () => {},
    press: async () => {},
    ariaSnapshot: async () => '- button "Submit"',
  };
  return {
    goto: async (_url: string, opts: { timeout: number }) => {
      rec.gotoTimeouts.push(opts.timeout);
    },
    goBack: async (opts: { timeout: number }) => {
      rec.goBackTimeouts.push(opts.timeout);
    },
    waitForTimeout: async () => {},
    title: async () => 'Fake',
    url: () => 'https://93.184.216.34/',
    locator: () => locator,
    getByRole: () => locator,
    getByText: () => locator,
    screenshot: async () => Buffer.from(''),
    mouse: { click: async () => {} },
  } as unknown as Page;
}

/** A session that satisfies both the map key and the fingerprint invariant. */
function seedSession(sessionId: string, rec: Recorded): BrowserSession {
  const policy = {};
  const session: BrowserSession = {
    browser: {} as Browser,
    // `getOrCreateSessionWithRoute` installs a context-level route on first use.
    context: { route: async () => {} } as unknown as BrowserContext,
    page: fakePage(rec),
    refs: new Map([['@e1', { ref: '@e1', role: 'button', name: 'Submit' }]]),
    lastUrl: '',
    policyFingerprint: policyFingerprint(policy),
    consoleLogs: [],
  };
  sessions.set(makeMapKey(sessionId, policy), session);
  return session;
}

function toolCtx(sessionId: string) {
  return {
    sessionId,
    abortSignal: new AbortController().signal,
    networkPolicy: {},
    // biome-ignore lint/suspicious/noExplicitAny: the tools read only the four fields above
  } as any;
}

function toolsByName(opts?: { navigationTimeoutMs?: number; commandTimeoutMs?: number }) {
  return new Map(createBrowserTools(opts).map((t) => [t.name, t]));
}

afterEach(() => {
  sessions.clear();
});

describe('browser timeout threading', () => {
  // A public IP literal keeps `validateUrl`/`checkSsrf` off the network: an IP
  // literal is never resolved, and 93.184.216.34 is not private.
  const url = 'https://93.184.216.34/';

  it('passes the configured navigation timeout to page.goto', async () => {
    const rec: Recorded = { gotoTimeouts: [], goBackTimeouts: [], clickTimeouts: [] };
    seedSession('nav-configured', rec);
    const tools = toolsByName({ navigationTimeoutMs: 7_000 });
    const result = await tools.get('browse_url')?.execute({ url }, toolCtx('nav-configured'));
    expect(result?.ok).toBe(true);
    expect(rec.gotoTimeouts).toEqual([7_000]);
  });

  it('falls back to the 30s literal when navigation timeout is unset', async () => {
    const rec: Recorded = { gotoTimeouts: [], goBackTimeouts: [], clickTimeouts: [] };
    seedSession('nav-default', rec);
    const tools = toolsByName();
    await tools.get('browse_url')?.execute({ url }, toolCtx('nav-default'));
    expect(rec.gotoTimeouts).toEqual([DEFAULT_NAVIGATION_TIMEOUT_MS]);
  });

  it('passes the configured navigation timeout to browser_navigate too', async () => {
    const rec: Recorded = { gotoTimeouts: [], goBackTimeouts: [], clickTimeouts: [] };
    seedSession('nav-tool', rec);
    const tools = toolsByName({ navigationTimeoutMs: 12_000 });
    await tools.get('browser_navigate')?.execute({ url }, toolCtx('nav-tool'));
    expect(rec.gotoTimeouts).toEqual([12_000]);
  });

  it('passes the configured command timeout to every click call site', async () => {
    const rec: Recorded = { gotoTimeouts: [], goBackTimeouts: [], clickTimeouts: [] };
    seedSession('cmd-configured', rec);
    const tools = toolsByName({ commandTimeoutMs: 2_500 });
    const ctx = toolCtx('cmd-configured');

    await tools.get('browser_click')?.execute({ element_ref: '@e1' }, ctx);
    await tools.get('browser_type')?.execute({ element_ref: '@e1', text: 'hi' }, ctx);
    await tools.get('browser_vision_click')?.execute({ description: 'Submit' }, ctx);
    await tools.get('browser_vision_type')?.execute({ description: 'Submit', text: 'hi' }, ctx);

    expect(rec.clickTimeouts).toEqual([2_500, 2_500, 2_500, 2_500]);
  });

  // `goBack` is navigation, not a command — it reads `navigationTimeoutMs`,
  // the same budget `goto` reads, which is what the public config documents.
  it('passes the configured navigation timeout to page.goBack', async () => {
    const rec: Recorded = { gotoTimeouts: [], goBackTimeouts: [], clickTimeouts: [] };
    seedSession('back-configured', rec);
    const tools = toolsByName({ navigationTimeoutMs: 9_000, commandTimeoutMs: 3_000 });
    await tools.get('browser_back')?.execute({}, toolCtx('back-configured'));
    expect(rec.goBackTimeouts).toEqual([9_000]);
  });

  it('falls back to the 10s literal when command timeout is unset', async () => {
    const rec: Recorded = { gotoTimeouts: [], goBackTimeouts: [], clickTimeouts: [] };
    seedSession('cmd-default', rec);
    const tools = toolsByName();
    const ctx = toolCtx('cmd-default');
    await tools.get('browser_click')?.execute({ element_ref: '@e1' }, ctx);
    await tools.get('browser_back')?.execute({}, ctx);
    expect(rec.clickTimeouts).toEqual([DEFAULT_COMMAND_TIMEOUT_MS]);
    expect(rec.goBackTimeouts).toEqual([DEFAULT_NAVIGATION_TIMEOUT_MS]);
  });
});
