// The registry the screencast takeover socket looks sessions up in
// (`apps/web-api/src/browser/takeover-socket.ts`, plan B3).
//
// The property under test is IDENTITY: the socket must be handed the session
// object `browser_request_takeover` locked, never a fresh lookup by policy.
// `findActiveSession(sessionId, policy)` is keyed by (sessionId, network
// policy) and a policy change tears a session down and builds a replacement,
// so a re-lookup can answer with a DIFFERENT browser than the human is
// driving — pixels from one window, clicks into another.

import type { BrowserContext, CDPSession, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { createBrowserTakeoverRegistry } from '../index';
import {
  type BrowserSession,
  findActiveSession,
  makeMapKey,
  policyFingerprint,
  sessions,
} from '../sessions';

function fakePage(url: string): Page {
  return { url: () => url, isClosed: () => false } as unknown as Page;
}

/** A context that records the page `newCDPSession` was asked for. */
function fakeContext(): { context: BrowserContext; cdpFor: () => Page | null } {
  let asked: Page | null = null;
  const context = {
    newCDPSession: async (page: Page) => {
      asked = page;
      return {} as CDPSession;
    },
  } as unknown as BrowserContext;
  return { context, cdpFor: () => asked };
}

function insert(
  sessionId: string,
  policy: Record<string, unknown>,
  over: Partial<BrowserSession> = {},
): BrowserSession {
  const { context } = fakeContext();
  const session: BrowserSession = {
    context,
    page: fakePage('https://example.com/'),
    refs: new Map(),
    lastUrl: '',
    policyFingerprint: policyFingerprint(policy),
    consoleLogs: [],
    tier: 'stock',
    pendingWarnings: [],
    lastActiveAt: Date.now(),
    close: async () => {},
    ...over,
  };
  sessions.set(makeMapKey(sessionId, policy), session);
  return session;
}

afterEach(() => {
  sessions.clear();
});

describe('createBrowserTakeoverRegistry', () => {
  it('resolves the very session object the takeover tool locked', () => {
    const session = insert('sess-1', {}, { takeover: {} });
    const target = createBrowserTakeoverRegistry().find('sess-1');
    expect(target).not.toBeNull();
    // Identity, not truthiness — a second session with an equal-looking page
    // would satisfy a shallow check and drive the wrong browser.
    expect(target?.page).toBe(session.page);
    expect(target?.takeover).toBe(session.takeover);
  });

  it('finds the locked session WITHOUT knowing its network policy', async () => {
    const policy = { allow: ['example.com'] };
    const session = insert('sess-1', policy, { takeover: {} });
    // The policy-keyed lookup every other browser tool uses misses it under a
    // different policy — this is exactly the re-lookup the registry must not do.
    expect(findActiveSession('sess-1', {})).toBeUndefined();
    expect(createBrowserTakeoverRegistry().find('sess-1')?.page).toBe(session.page);
  });

  it('reads through to the live session rather than snapshotting it', () => {
    const session = insert('sess-1', {}, { takeover: {} });
    const target = createBrowserTakeoverRegistry().find('sess-1');
    // An in-place relaunch (D5) swaps the page on the same session object.
    const replacement = fakePage('https://relaunched.example/');
    session.page = replacement;
    expect(target?.page).toBe(replacement);
    // And a released lock is visible, so the socket's `not_in_takeover`
    // refusal stays honest for the life of the lane.
    session.takeover = undefined;
    expect(target?.takeover).toBeUndefined();
  });

  it('reports no lock for a session nobody handed over', () => {
    insert('sess-1', {});
    expect(createBrowserTakeoverRegistry().find('sess-1')?.takeover).toBeUndefined();
  });

  it('returns null for a session this process has never seen', () => {
    insert('sess-1', {}, { takeover: {} });
    expect(createBrowserTakeoverRegistry().find('sess-2')).toBeNull();
  });

  it('does not confuse a session id that is a prefix of another', () => {
    insert('sess-10', {}, { takeover: {} });
    expect(createBrowserTakeoverRegistry().find('sess-1')).toBeNull();
  });

  it('opens the CDP session against the session current page', async () => {
    const { context, cdpFor } = fakeContext();
    const session = insert('sess-1', {}, { context, takeover: {} });
    const target = createBrowserTakeoverRegistry().find('sess-1');
    await target?.newCDPSession();
    expect(cdpFor()).toBe(session.page);
  });
});
