// T4 end-to-end through `browse_url` / `browser_navigate`: a bot wall is a
// SUCCESSFUL navigation, so the tool has to inspect what came back. Same
// seeding technique as timeouts.test.ts.
//
// Revert the `detectBlock` branch in index.ts / browser-actions.ts and
// "reports the block as a failure" fails (the wall's interstitial is returned
// as if it were the page). Revert the `pendingWarnings.splice(0)` drain and
// "surfaces a launch notice exactly once" fails.

import type { Tool } from '@ethosagent/types';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserTools } from '../index';
import { type BrowserSession, makeMapKey, policyFingerprint, sessions } from '../sessions';

vi.mock('../sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sessions')>()),
  isPlaywrightInstalled: () => true,
}));

interface PageResponse {
  status: number;
  headers: Record<string, string>;
}

interface Recorded {
  gotos: string[];
}

function fakePage(rec: Recorded, response: PageResponse | null, snapshot: string, title: string) {
  return {
    goto: async (url: string) => {
      rec.gotos.push(url);
      return response ? { status: () => response.status, headers: () => response.headers } : null;
    },
    waitForTimeout: async () => {},
    title: async () => title,
    url: () => 'https://93.184.216.34/',
    locator: () => ({ ariaSnapshot: async () => snapshot }),
  } as unknown as Page;
}

function seed(sessionId: string, page: Page, warnings: string[] = []): BrowserSession {
  const policy = {};
  const session: BrowserSession = {
    browser: {} as Browser,
    context: { route: async () => {} } as unknown as BrowserContext,
    page,
    refs: new Map(),
    lastUrl: '',
    policyFingerprint: policyFingerprint(policy),
    consoleLogs: [],
    tier: 'stock',
    pendingWarnings: [...warnings],
    lastActiveAt: Date.now(),
    close: async () => {},
  };
  sessions.set(makeMapKey(sessionId, policy), session);
  return session;
}

function toolCtx(sessionId: string) {
  return {
    sessionId,
    abortSignal: new AbortController().signal,
    networkPolicy: {},
    // biome-ignore lint/suspicious/noExplicitAny: the tools read only these fields
  } as any;
}

const tools = new Map(createBrowserTools().map((t) => [t.name, t]));
// A public IP literal keeps validateUrl/checkSsrf off the network.
const url = 'https://93.184.216.34/';

afterEach(() => {
  sessions.clear();
});

describe('browse_url — bot wall', () => {
  it('reports the block as a failure naming the vendor, and never retries', async () => {
    const rec: Recorded = { gotos: [] };
    seed(
      'blocked-cf',
      fakePage(
        rec,
        { status: 403, headers: { 'cf-mitigated': 'challenge' } },
        '- text "…"',
        'Just a moment...',
      ),
    );

    const result = await tools.get('browse_url')?.execute({ url }, toolCtx('blocked-cf'));
    expect(result?.ok).toBe(false);
    if (result?.ok !== false) return;
    expect(result.error).toContain('Cloudflare');
    // These tools were built with no clarify bridge, so no escalation tool is
    // registered and the hint must name none — see the describe block below.
    expect(result.error).not.toMatch(/browser_[a-z_]+/);
    // THE NO-SILENT-RETRY INVARIANT: one navigation, not two.
    expect(rec.gotos).toEqual([url]);
  });

  it('fires on a bare 503 with no vendor signature', async () => {
    const rec: Recorded = { gotos: [] };
    seed(
      'blocked-503',
      fakePage(rec, { status: 503, headers: {} }, '- text "busy"', 'Unavailable'),
    );
    const result = await tools.get('browse_url')?.execute({ url }, toolCtx('blocked-503'));
    expect(result?.ok).toBe(false);
    expect(rec.gotos).toHaveLength(1);
  });

  it('returns the page normally when nothing is blocking', async () => {
    const rec: Recorded = { gotos: [] };
    seed(
      'clean',
      fakePage(
        rec,
        { status: 200, headers: { server: 'cloudflare' } },
        '- button "Submit"',
        'Docs',
      ),
    );
    const result = await tools.get('browse_url')?.execute({ url }, toolCtx('clean'));
    expect(result?.ok).toBe(true);
    if (result?.ok !== true) return;
    expect(result.value).toContain('[Docs]');
    expect(result.value).not.toContain('Blocked by');
  });
});

// The hint used to hardcode `browser_stealth_session`, a tool gated behind a
// feasibility spike that has not run — so it was never registered, in any
// build. Telling the model and the user to reach for a tool that does not
// exist costs a wasted turn and a wrong instruction. The name now comes from
// the caller, which passes one only for a tool it actually built.
describe('the block hint names only a tool that is registered', () => {
  const fakeBridge = { request: async () => ({ requestId: 'r', answer: '', source: 'user' }) };

  async function blockedError(built: Tool[], sessionId: string): Promise<string> {
    const map = new Map(built.map((t): [string, Tool] => [t.name, t]));
    seed(sessionId, fakePage({ gotos: [] }, { status: 403, headers: {} }, '- text "…"', 'Blocked'));
    const result = await map.get('browse_url')?.execute({ url }, toolCtx(sessionId));
    expect(result?.ok).toBe(false);
    return result?.ok === false ? result.error : '';
  }

  it('names browser_request_takeover when the takeover tool is registered', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: a stub standing in for ClarifyBridge
    const built = createBrowserTools({ clarifyBridge: fakeBridge as any });
    expect(built.map((t) => t.name)).toContain('browser_request_takeover');

    const error = await blockedError(built, 'hint-with-tool');
    expect(error).toContain('browser_request_takeover');
    // Whatever tool the hint names has to be one of the tools just built.
    for (const named of error.match(/browser_[a-z_]+/g) ?? []) {
      expect(built.map((t) => t.name)).toContain(named);
    }
  });

  it('names no tool at all when there is no bridge to register one', async () => {
    const built = createBrowserTools();
    expect(built.map((t) => t.name)).not.toContain('browser_request_takeover');

    const error = await blockedError(built, 'hint-without-tool');
    expect(error).not.toMatch(/browser_[a-z_]+/);
    // Still a next step — a walled page with no instruction is the worse end.
    expect(error).toContain('ask them to fetch it');
  });
});

describe('browser_navigate — the same detector', () => {
  it('reports a DataDome wall as a failure', async () => {
    const rec: Recorded = { gotos: [] };
    seed(
      'nav-dd',
      fakePage(
        rec,
        { status: 200, headers: {} },
        '- text "https://geo.captcha-delivery.com/"',
        'Verify',
      ),
    );
    const result = await tools.get('browser_navigate')?.execute({ url }, toolCtx('nav-dd'));
    expect(result?.ok).toBe(false);
    if (result?.ok !== false) return;
    expect(result.error).toContain('DataDome');
    expect(rec.gotos).toHaveLength(1);
  });
});

describe('launch notices', () => {
  it('surfaces a launch notice exactly once per session', async () => {
    const rec: Recorded = { gotos: [] };
    seed('warned', fakePage(rec, { status: 200, headers: {} }, '- text "hi"', 'Docs'), [
      'browser.headed: true, but this machine has no display — running headless.',
    ]);
    const ctx = toolCtx('warned');

    const first = await tools.get('browse_url')?.execute({ url }, ctx);
    expect(first?.ok).toBe(true);
    if (first?.ok !== true) return;
    expect(first.value).toContain('⚠ browser.headed: true');

    const second = await tools.get('browse_url')?.execute({ url }, ctx);
    expect(second?.ok).toBe(true);
    if (second?.ok !== true) return;
    expect(second.value).not.toContain('⚠');
  });

  it('still reports the notice when the same navigation is blocked', async () => {
    const rec: Recorded = { gotos: [] };
    seed(
      'warned-blocked',
      fakePage(rec, { status: 429, headers: {} }, '- text "slow down"', 'Too Many Requests'),
      [
        "Browser profile 'scout' is in use by another session — this second session is not logged in.",
      ],
    );
    const result = await tools.get('browse_url')?.execute({ url }, toolCtx('warned-blocked'));
    expect(result?.ok).toBe(false);
    if (result?.ok !== false) return;
    expect(result.error).toContain('is in use by another session');
    expect(result.error).toContain('no retry was attempted');
  });
});
