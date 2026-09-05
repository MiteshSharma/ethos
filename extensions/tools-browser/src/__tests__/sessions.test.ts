// Ch.7 — exercise the policy-fingerprint invariant on findActiveSession
// + getOrCreateSession's cache-hit path. We poke fake sessions into the
// exported `sessions` map (using the exported makeMapKey + policyFingerprint
// helpers so the test exercises the real key derivation) and assert the
// lookup behavior the security design depends on.

import type { Browser, BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserTakeoverRegistry } from '../index';
import {
  acquireAgentLease,
  acquireProfileLock,
  activeLeaseCount,
  type BrowserSession,
  claimTakeoverLease,
  cleanupOnExit,
  findActiveSession,
  getOrCreateSession,
  getOrCreateSessionWithRoute,
  makeMapKey,
  policyFingerprint,
  profileLockCount,
  relaunchSessionWithRoute,
  sessions,
  sweepIdleSessions,
  takeoverRefusalResult,
} from '../sessions';

// A fake Chromium so the launch paths (ephemeral + persistent) are exercisable
// without a real browser. Only the calls sessions.ts makes are modelled.
const pw = vi.hoisted(() => {
  interface FakeContext {
    closed: boolean;
    close: () => Promise<void>;
    route: () => Promise<void>;
    pages: () => unknown[];
    newPage: () => Promise<unknown>;
  }
  const contexts: FakeContext[] = [];
  const persistentDirs: string[] = [];
  // One-shot failure injection: a launch that never comes up, and a context
  // that refuses `route()`. Both are the paths a relaunch can die on.
  const state = { failNextLaunch: false, failNextRoute: false };

  function makeContext(): FakeContext {
    const ctx: FakeContext = {
      closed: false,
      close: async () => {
        ctx.closed = true;
      },
      route: async () => {
        if (!state.failNextRoute) return;
        state.failNextRoute = false;
        throw new Error('route install failed');
      },
      pages: () => [],
      newPage: async () => ({ on: () => {} }),
    };
    contexts.push(ctx);
    return ctx;
  }
  function failLaunchIfArmed(): void {
    if (!state.failNextLaunch) return;
    state.failNextLaunch = false;
    throw new Error('chromium failed to start');
  }
  const chromium = {
    launch: async () => {
      failLaunchIfArmed();
      return {
        newContext: async () => makeContext(),
        close: async () => {},
      };
    },
    launchPersistentContext: async (dir: string) => {
      failLaunchIfArmed();
      persistentDirs.push(dir);
      return makeContext();
    },
  };
  return { chromium, contexts, persistentDirs, state };
});

vi.mock('playwright', () => ({ chromium: pw.chromium }));

/** A context that records its own close, so teardown paths are observable. */
function recordingContext(): { context: BrowserContext; closed: () => boolean } {
  let closed = false;
  const context = {
    close: async () => {
      closed = true;
    },
  } as unknown as BrowserContext;
  return { context, closed: () => closed };
}

function fakeSession(fp: string, over: Partial<BrowserSession> = {}): BrowserSession {
  const { context } = recordingContext();
  const session: BrowserSession = {
    browser: {} as Browser,
    context,
    page: {} as Page,
    refs: new Map(),
    lastUrl: '',
    policyFingerprint: fp,
    consoleLogs: [],
    tier: 'stock',
    pendingWarnings: [],
    lastActiveAt: Date.now(),
    close: async () => {
      await session.context.close();
    },
    ...over,
  };
  return session;
}

afterEach(() => {
  vi.useRealTimers();
  sessions.clear();
  pw.contexts.length = 0;
  pw.persistentDirs.length = 0;
  pw.state.failNextLaunch = false;
  pw.state.failNextRoute = false;
});

describe('findActiveSession — policy-fingerprint invariant', () => {
  const sid = 'unit-test-session';

  it('returns undefined when no session exists', () => {
    expect(findActiveSession(sid, {})).toBeUndefined();
  });

  it('returns the session when both map key AND fingerprint match', () => {
    const policy = { allow: ['api.github.com'] };
    sessions.set(makeMapKey(sid, policy), fakeSession(policyFingerprint(policy)));
    const found = findActiveSession(sid, policy);
    expect(found).toBeDefined();
    expect(found?.policyFingerprint).toBe(policyFingerprint(policy));
  });

  it('rejects a session inserted at the right map key with a STALE fingerprint', () => {
    // The exact attack shape Codex flagged: a writer constructed the map
    // key correctly but stamped the wrong fingerprint on the session.
    // The map-key check passes; the explicit fingerprint comparison must
    // reject. Without that comparison, the test would return the stale
    // session.
    const policy = { allow: ['api.github.com'] };
    sessions.set(makeMapKey(sid, policy), fakeSession('definitely-wrong-fingerprint'));
    expect(findActiveSession(sid, policy)).toBeUndefined();
  });

  it('rejects when the policy itself differs from the inserted one', () => {
    const insertedPolicy = { allow: ['a.com'] };
    const lookupPolicy = { allow: ['b.com'] };
    sessions.set(makeMapKey(sid, insertedPolicy), fakeSession(policyFingerprint(insertedPolicy)));
    expect(findActiveSession(sid, lookupPolicy)).toBeUndefined();
  });
});

describe('policyFingerprint — order-independence', () => {
  it('returns the same hash for differently-ordered allow lists', () => {
    expect(policyFingerprint({ allow: ['a.com', 'b.com'] })).toBe(
      policyFingerprint({ allow: ['b.com', 'a.com'] }),
    );
  });

  it('differs across allow vs deny content', () => {
    expect(policyFingerprint({ allow: ['a.com'] })).not.toBe(
      policyFingerprint({ deny: ['a.com'] }),
    );
  });

  it('differs across allow_private_urls toggle', () => {
    expect(policyFingerprint({ allow_private_urls: true })).not.toBe(
      policyFingerprint({ allow_private_urls: false }),
    );
  });
});

describe('D5 — per-session state and in-place relaunch', () => {
  it('keeps the policy-only key across a tier switch', async () => {
    const policy = { allow: ['example.com'] };
    const session = await getOrCreateSession('tier-switch', policy);
    expect(session.tier).toBe('stock');

    await relaunchSessionWithRoute(session, policy, {
      tier: 'stealth',
      proxy: { server: 'http://proxy:8080' },
    });

    // The key is (sessionId, policy) and nothing else — the lookup that every
    // navigating tool uses must still find the same session.
    const found = findActiveSession('tier-switch', policy);
    expect(found).toBe(session);
    expect(found?.tier).toBe('stealth');
    expect(found?.proxyKey).toBe('http://proxy:8080');
    expect(sessions.size).toBe(1);
  });

  it('relaunches in place — same object, new context, old context closed', async () => {
    const session = await getOrCreateSession('relaunch-in-place', {});
    const before = session.context;
    session.lastUrl = 'https://example.com/';
    session.refs.set('@e1', { ref: '@e1', role: 'button', name: 'Submit' });

    const returned = await relaunchSessionWithRoute(session, {}, { tier: 'stealth' });

    expect(returned).toBe(session);
    expect(session.context).not.toBe(before);
    expect(pw.contexts[0]?.closed).toBe(true);
    expect(pw.contexts[1]?.closed).toBe(false);
    // Page-scoped state belongs to the context that just went away.
    expect(session.lastUrl).toBe('');
    expect(session.refs.size).toBe(0);
  });

  it('close() closes the context of a persistent (browser-less) session', async () => {
    const session = await getOrCreateSession(
      'persistent-close',
      {},
      {
        profile: { key: 'profile-close', dir: '/tmp/ethos-test-profile-close' },
      },
    );
    expect(session.browser).toBeUndefined();
    expect(session.profileKey).toBe('profile-close');
    expect(pw.persistentDirs).toEqual(['/tmp/ethos-test-profile-close']);

    await session.close();
    expect(pw.contexts[0]?.closed).toBe(true);
  });
});

describe('D4 — per-personality profile isolation', () => {
  // The profile DIRECTORY has always been per-personality. The cache in front
  // of it was not: the session key is (sessionId, policy), so switching
  // personality inside one conversation was handed the previous
  // personality's persistent context — its cookies, its logged-in state.

  it('does not hand personality B the context personality A opened', async () => {
    const sid = 'personality-switch';
    const a = await getOrCreateSession(sid, {}, { profile: { key: 'iso-a', dir: '/d/iso-a' } });
    expect(a.profileKey).toBe('iso-a');
    const aContext = a.context;

    const b = await getOrCreateSession(sid, {}, { profile: { key: 'iso-b', dir: '/d/iso-b' } });

    // Identity, not a field: B cannot read a cookie from a context it never
    // touched. Same object → same cookie jar, whatever the fields say.
    expect(b).not.toBe(a);
    expect(b.context).not.toBe(aContext);
    // And the directory actually opened is B's own — not a second handle on
    // the one holding A's login.
    expect(pw.persistentDirs).toEqual(['/d/iso-a', '/d/iso-b']);
    expect(b.profileKey).toBe('iso-b');
    // A's browser is gone, so nothing is left holding A's profile mutex.
    expect(pw.contexts[0]?.closed).toBe(true);
    expect(pw.contexts[1]?.closed).toBe(false);
    expect(sessions.size).toBe(1);

    const freed = await acquireProfileLock('iso-a', 50);
    expect(freed).not.toBeNull();
    freed?.();
    await b.close();
  });

  it('CONTROL — the same personality twice reuses one context and one launch', async () => {
    const profile = { key: 'iso-same', dir: '/d/iso-same' };
    const first = await getOrCreateSession('same-personality', {}, { profile });
    const second = await getOrCreateSession('same-personality', {}, { profile });

    expect(second).toBe(first);
    expect(pw.persistentDirs).toEqual(['/d/iso-same']);
    expect(pw.contexts).toHaveLength(1);
    await first.close();
  });

  it('CONTROL — an ephemeral fallback is still reused by the SAME personality', async () => {
    // The fallback session has no `profileKey` at all, so a reuse check
    // written against that field would relaunch this personality's browser on
    // every single call. The check is on the profile REQUESTED.
    const profile = { key: 'iso-busy', dir: '/d/iso-busy' };
    const holder = await acquireProfileLock('iso-busy');
    expect(holder).not.toBeNull();

    vi.useFakeTimers();
    const pending = getOrCreateSession('fallback-reuse', {}, { profile });
    await vi.advanceTimersByTimeAsync(15_000);
    const first = await pending;
    vi.useRealTimers();
    expect(first.profileKey).toBeUndefined();
    expect(first.requestedProfileKey).toBe('iso-busy');

    const second = await getOrCreateSession('fallback-reuse', {}, { profile });
    expect(second).toBe(first);
    expect(pw.contexts).toHaveLength(1);
    holder?.();
    await first.close();
  });

  it('B1 — a personality switch does NOT close a session a human is holding', async () => {
    const sid = 'personality-switch-locked';
    const a = await getOrCreateSession(
      sid,
      {},
      { profile: { key: 'iso-locked-a', dir: '/d/iso-locked-a' } },
    );
    a.takeover = { requestId: 'req-1' };

    const returned = await getOrCreateSession(
      sid,
      {},
      { profile: { key: 'iso-locked-b', dir: '/d/iso-locked-b' } },
    );

    // Destroying the window someone is typing into is worse than refusing
    // them the browser — the same trade the policy-change teardown makes.
    expect(returned).toBe(a);
    expect(pw.contexts[0]?.closed).toBe(false);
    expect(pw.persistentDirs).toEqual(['/d/iso-locked-a']);
    expect(acquireAgentLease(sid, returned)).toBeNull();
    a.takeover = undefined;
    await a.close();
  });
});

describe('one published session per sessionId', () => {
  // The creation mutex used to be keyed by (sessionId, policy) while teardown,
  // `claimTakeoverLease` and the takeover registry all assume one session per
  // sessionId. Two concurrent creations under different policies therefore
  // both missed the map, both launched, and both published.

  it('serialises two concurrent creations under DIFFERENT policies into one session', async () => {
    const sid = 'one-per-id';
    const [first, second] = await Promise.all([
      getOrCreateSession(sid, { allow: ['a.example.com'] }),
      getOrCreateSession(sid, { allow: ['b.example.com'] }),
    ]);

    const live = [...sessions.entries()].filter(([k]) => k.startsWith(`${sid}::`));
    expect(live).toHaveLength(1);
    const published = live[0]?.[1];
    expect(published).toBeDefined();
    if (!published) return;
    // Exactly one of the two callers holds the surviving session; the other's
    // browser was closed rather than left running with nothing pointing at it.
    expect([first, second].filter((s) => s === published)).toHaveLength(1);
    expect(pw.contexts.filter((c) => !c.closed)).toHaveLength(1);

    // The screencast resolves THAT browser — with two entries under one id the
    // registry answers with whichever the map iterated first.
    expect(createBrowserTakeoverRegistry().find(sid)?.page).toBe(published.page);

    // ...and the one sessionId-keyed lease governs it: nothing else under
    // this id can be handed to the agent while a takeover holds it, and
    // releasing it frees exactly that one.
    const lease = claimTakeoverLease(sid);
    expect(activeLeaseCount(sid)).toBe(1);
    expect(acquireAgentLease(sid, published)).toBeNull();
    lease.release();
    expect(activeLeaseCount(sid)).toBe(0);
    expect(acquireAgentLease(sid, published)).not.toBeNull();
  });
});

describe('a failed relaunch (M3/M4)', () => {
  it('drops the session rather than leaving a poisoned one in the map', async () => {
    const policy = { allow: ['example.com'] };
    const session = await getOrCreateSessionWithRoute('relaunch-fail', policy);
    expect(findActiveSession('relaunch-fail', policy)).toBe(session);

    pw.state.failNextLaunch = true;
    await expect(relaunchSessionWithRoute(session, policy, { tier: 'stealth' })).rejects.toThrow(
      'chromium failed to start',
    );

    // The old backend is closed, so a session still pointing at it is not
    // healthy — and must not be handed out as if it were.
    expect(pw.contexts[0]?.closed).toBe(true);
    expect(findActiveSession('relaunch-fail', policy)).toBeUndefined();
    expect(sessions.size).toBe(0);

    // The next call builds a clean, live one.
    const next = await getOrCreateSessionWithRoute('relaunch-fail', policy);
    expect(next).not.toBe(session);
    expect(pw.contexts[1]?.closed).toBe(false);
  });

  it('never publishes a replacement context that failed to take the SSRF guard', async () => {
    const session = await getOrCreateSessionWithRoute('guard-fail', {});
    const before = session.context;

    pw.state.failNextRoute = true;
    await expect(relaunchSessionWithRoute(session, {}, { tier: 'stealth' })).rejects.toThrow(
      'route install failed',
    );

    // Launch and guard both happen BEFORE a single field is swapped, so an
    // unguarded context is never reachable through the session.
    expect(session.context).toBe(before);
    // ...and the replacement is closed rather than left running.
    expect(pw.contexts[1]?.closed).toBe(true);
    expect(sessions.size).toBe(0);
  });

  it('FRESH LAUNCH — never leaves an unguarded session published', async () => {
    // The relaunch path above drops the replacement when the guard throws.
    // The fresh-launch path publishes the session BEFORE installing the
    // guard, so the same throw used to leave an unguarded context in the map
    // — reachable through `findActiveSession` and the takeover registry, with
    // no SSRF guard for the life of that session.
    const policy = { allow: ['example.com'] };
    const profile = { key: 'fresh-guard-profile', dir: '/d/fresh-guard' };

    pw.state.failNextRoute = true;
    await expect(
      getOrCreateSessionWithRoute('fresh-guard-fail', policy, { profile }),
    ).rejects.toThrow('route install failed');

    // Nothing published, nothing reachable, backend closed.
    expect(sessions.size).toBe(0);
    expect(findActiveSession('fresh-guard-fail', policy)).toBeUndefined();
    expect(pw.contexts[0]?.closed).toBe(true);

    // ...and the profile mutex it took is back, so the next session for this
    // personality is logged in rather than falling back ephemeral forever.
    const freed = await acquireProfileLock('fresh-guard-profile', 50);
    expect(freed).not.toBeNull();
    freed?.();

    // The next call builds a clean, guarded one.
    const next = await getOrCreateSessionWithRoute('fresh-guard-fail', policy);
    expect(pw.contexts[1]?.closed).toBe(false);
    sessions.clear();
    await next.close();
  });

  it('exports the guarded relaunch and nothing raw beside it', async () => {
    const mod = await import('../sessions');
    expect(Object.keys(mod)).not.toContain('relaunchSession');
    expect(typeof mod.relaunchSessionWithRoute).toBe('function');
    // The guard module exports the guard only — there is no second, unguarded
    // relaunch anywhere for a future caller to pick by mistake.
    expect(Object.keys(await import('../session-route'))).toEqual(['installRouteGuard']);
  });
});

describe('per-profile mutex (D4)', () => {
  it('makes a second waiter time out, then hands the lock over on release', async () => {
    const first = await acquireProfileLock('mutex-basic', 20);
    expect(first).not.toBeNull();

    const second = await acquireProfileLock('mutex-basic', 20);
    expect(second).toBeNull();

    first?.();
    const third = await acquireProfileLock('mutex-basic', 200);
    expect(third).not.toBeNull();
    third?.();
  });

  it('leaves no entry behind once the last holder releases', async () => {
    // Without the cleanup, every personality id ever asked for keeps a
    // settled promise in the lock map for the life of the process.
    expect(profileLockCount('mutex-drain')).toBe(0);
    const held = await acquireProfileLock('mutex-drain', 50);
    expect(held).not.toBeNull();
    expect(profileLockCount('mutex-drain')).toBe(1);

    held?.();
    expect(profileLockCount('mutex-drain')).toBe(0);
  });

  it('keeps the lock when a waiter has replaced the tail mid-release', async () => {
    // The identity check is the whole fix: a release that deletes
    // unconditionally would start the NEXT acquirer from a resolved promise
    // and hand it a lock the waiter is holding.
    const first = await acquireProfileLock('mutex-waiter', 1_000);
    expect(first).not.toBeNull();

    const queued = acquireProfileLock('mutex-waiter', 1_000);
    first?.();
    const second = await queued;
    expect(second).not.toBeNull();

    // The waiter really holds it — a third acquirer times out rather than
    // walking in behind a deleted entry.
    expect(await acquireProfileLock('mutex-waiter', 20)).toBeNull();
    expect(profileLockCount('mutex-waiter')).toBe(1);
    second?.();
  });

  it('falls back to an ephemeral context with a warning when the profile is busy', async () => {
    const profile = { key: 'mutex-fallback', dir: '/tmp/ethos-test-profile-busy' };
    const held = await getOrCreateSession('holder', {}, { profile });
    expect(held.profileKey).toBe('mutex-fallback');
    expect(held.profileWarning).toBeUndefined();

    vi.useFakeTimers();
    const pending = getOrCreateSession('second', {}, { profile });
    await vi.advanceTimersByTimeAsync(15_000);
    const second = await pending;

    expect(second.profileKey).toBeUndefined();
    expect(second.browser).toBeDefined();
    expect(second.profileWarning).toContain('not logged in');
    // Only the holder got a persistent context.
    expect(pw.persistentDirs).toEqual(['/tmp/ethos-test-profile-busy']);
  });
});

describe('per-key creation mutex', () => {
  // Two browser tools firing in one parallel batch both miss the map. Without
  // the mutex both launch: the loser waits out the 15s profile lock, falls
  // back to an ephemeral context, and OVERWRITES the persistent session in the
  // map. The displaced browser is unreachable, its profile lock is never
  // released, and every session after it falls back logged-out.
  it('launches ONE browser for two parallel calls and publishes one session', async () => {
    const profile = { key: 'race-profile', dir: '/tmp/ethos-test-race-profile' };
    const [first, second] = await Promise.all([
      getOrCreateSession('race', {}, { profile }),
      getOrCreateSession('race', {}, { profile }),
    ]);

    expect(second).toBe(first);
    expect(pw.persistentDirs).toEqual(['/tmp/ethos-test-race-profile']);
    expect(pw.contexts).toHaveLength(1);
    expect(sessions.get(makeMapKey('race', {}))).toBe(first);

    sessions.delete(makeMapKey('race', {}));
    await first.close();

    // Nothing leaked: the one profile lock taken was released by the one
    // session that held it, so the next session can have it.
    const next = await acquireProfileLock('race-profile', 50);
    expect(next).not.toBeNull();
    next?.();
  });

  it('never lets the ephemeral fallback displace the published persistent session', async () => {
    const profile = { key: 'race-fallback', dir: '/tmp/ethos-test-race-fallback' };
    const [a, b] = await Promise.all([
      getOrCreateSession('race-2', {}, { profile }),
      getOrCreateSession('race-2', {}, { profile }),
    ]);

    // The published session is the PERSISTENT one — profile attached, no
    // "not logged in" fallback warning, and no ephemeral browser handle.
    const published = sessions.get(makeMapKey('race-2', {}));
    expect(published).toBe(a);
    expect(published).toBe(b);
    expect(published?.profileKey).toBe('race-fallback');
    expect(published?.profileWarning).toBeUndefined();
    expect(published?.browser).toBeUndefined();

    sessions.delete(makeMapKey('race-2', {}));
    await a.close();
  });
});

describe('persistent profiles (D4)', () => {
  // The point of a profile: the login survives. Two sequential sessions for
  // the same personality must be handed the SAME user-data directory —
  // `launchPersistentContext` reopens it, cookies and all. A per-session
  // directory would log the agent out on every `/new`.
  it('reuses one directory across sessions, so a login persists', async () => {
    const profile = { key: 'scout', dir: '/data/browser-profiles/scout' };

    const first = await getOrCreateSession('profile-a', {}, { profile });
    expect(first.profileKey).toBe('scout');
    expect(first.profileWarning).toBeUndefined();
    // Released here — the mutex is held for a session's lifetime, not a call.
    sessions.delete(makeMapKey('profile-a', {}));
    await first.close();

    const second = await getOrCreateSession('profile-b', {}, { profile });
    expect(second.profileKey).toBe('scout');
    expect(pw.persistentDirs).toEqual([
      '/data/browser-profiles/scout',
      '/data/browser-profiles/scout',
    ]);

    sessions.delete(makeMapKey('profile-b', {}));
    await second.close();
  });

  it('keeps different personalities in different directories', async () => {
    const a = await getOrCreateSession(
      'p-scout',
      {},
      { profile: { key: 'scout', dir: '/d/scout' } },
    );
    const b = await getOrCreateSession(
      'p-archivist',
      {},
      { profile: { key: 'archivist', dir: '/d/archivist' } },
    );
    expect(pw.persistentDirs).toEqual(['/d/scout', '/d/archivist']);
    sessions.clear();
    await a.close();
    await b.close();
  });

  it('carries a no-display launch warning into pendingWarnings', async () => {
    const session = await getOrCreateSession(
      'warn-launch',
      {},
      { launchWarning: 'no display — running headless' },
    );
    expect(session.pendingWarnings).toEqual(['no display — running headless']);
    sessions.clear();
    await session.close();
  });
});

describe('idle sweeper', () => {
  it('closes an idle session and drops it from the map', async () => {
    const session = fakeSession(policyFingerprint({}), { lastActiveAt: Date.now() - 60_000 });
    sessions.set(makeMapKey('idle', {}), session);

    expect(await sweepIdleSessions(1_000)).toBe(1);
    expect(sessions.size).toBe(0);
  });

  it('SKIPS a session with takeover set — a human is driving that browser', async () => {
    const idle = fakeSession(policyFingerprint({}), { lastActiveAt: Date.now() - 60_000 });
    const locked = fakeSession(policyFingerprint({}), {
      lastActiveAt: Date.now() - 60_000,
      takeover: { requestId: 'req-1' },
    });
    let lockedClosed = false;
    locked.close = async () => {
      lockedClosed = true;
    };
    sessions.set(makeMapKey('idle', {}), idle);
    sessions.set(makeMapKey('under-takeover', {}), locked);

    expect(await sweepIdleSessions(1_000)).toBe(1);
    expect(sessions.get(makeMapKey('under-takeover', {}))).toBe(locked);
    expect(lockedClosed).toBe(false);
  });

  it('SKIPS a session an agent lease is held on, then reaps it after the release', async () => {
    // `lastActiveAt` is stamped when a tool FINDS the session, not while its
    // operation runs. At the allowed 60s minimum idle window that is every
    // navigation, screenshot and vision call longer than a minute — the sweep
    // closes the browser out from under an operation still using it.
    const sid = 'leased';
    const session = fakeSession(policyFingerprint({}), { lastActiveAt: Date.now() - 60_000 });
    let closed = false;
    session.close = async () => {
      closed = true;
    };
    sessions.set(makeMapKey(sid, {}), session);

    const release = acquireAgentLease(sid, session);
    expect(release).not.toBeNull();

    // Stale by the clock, but an operation is in flight.
    expect(await sweepIdleSessions(1_000)).toBe(0);
    expect(sessions.get(makeMapKey(sid, {}))).toBe(session);
    expect(closed).toBe(false);

    release?.();

    // The lease DEFERRED the reap, it did not refresh the clock: the very
    // next sweep collects the session normally.
    expect(await sweepIdleSessions(1_000)).toBe(1);
    expect(sessions.size).toBe(0);
    expect(closed).toBe(true);
  });

  it('leaves a recently active session alone', async () => {
    sessions.set(makeMapKey('fresh', {}), fakeSession(policyFingerprint({})));
    expect(await sweepIdleSessions(600_000)).toBe(0);
    expect(sessions.size).toBe(1);
  });

  it('findActiveSession refreshes the idle clock', async () => {
    const policy = {};
    const session = fakeSession(policyFingerprint(policy), { lastActiveAt: Date.now() - 60_000 });
    sessions.set(makeMapKey('touched', policy), session);

    expect(findActiveSession('touched', policy)).toBe(session);
    expect(await sweepIdleSessions(1_000)).toBe(0);
  });
});

describe('policy-change teardown vs. an active takeover (B1)', () => {
  const oldPolicy = { allow: ['old.example.com'] };
  const newPolicy = { allow: ['new.example.com'] };

  /** A session under `oldPolicy` whose close() is observable. */
  function seed(sid: string, over: Partial<BrowserSession> = {}) {
    const session = fakeSession(policyFingerprint(oldPolicy), over);
    let closed = false;
    session.close = async () => {
      closed = true;
    };
    sessions.set(makeMapKey(sid, oldPolicy), session);
    return { session, wasClosed: () => closed };
  }

  it('does NOT close a locked session when the network policy switches', async () => {
    const { session, wasClosed } = seed('locked-switch', { takeover: { requestId: 'req-1' } });

    const returned = await getOrCreateSession('locked-switch', newPolicy);

    // The human's browser survives, in the map, under its own key.
    expect(wasClosed()).toBe(false);
    expect(sessions.get(makeMapKey('locked-switch', oldPolicy))).toBe(session);
    // And no second browser was launched under the new policy.
    expect(sessions.get(makeMapKey('locked-switch', newPolicy))).toBeUndefined();
    expect(sessions.size).toBe(1);
    expect(pw.contexts).toHaveLength(0);
    // The locked session is handed back verbatim — its fingerprint is still
    // the OLD one, so nothing has been re-keyed under the new policy.
    expect(returned).toBe(session);
    expect(returned.policyFingerprint).toBe(policyFingerprint(oldPolicy));
  });

  it('CONTROL — the same switch WITHOUT a takeover still tears the session down', async () => {
    const { session, wasClosed } = seed('unlocked-switch');

    const returned = await getOrCreateSession('unlocked-switch', newPolicy);

    expect(wasClosed()).toBe(true);
    expect(sessions.get(makeMapKey('unlocked-switch', oldPolicy))).toBeUndefined();
    expect(returned).not.toBe(session);
    expect(returned.policyFingerprint).toBe(policyFingerprint(newPolicy));
    expect(sessions.get(makeMapKey('unlocked-switch', newPolicy))).toBe(returned);
    expect(sessions.size).toBe(1);
  });

  it('gives the caller the standard takeover refusal, not a silent policy switch', async () => {
    seed('locked-refusal', { takeover: {} });

    // Exactly what browse_url / browser_navigate do with the returned session:
    // the lease refuses to hand the agent the browser, in the standard words.
    const session = await getOrCreateSession('locked-refusal', newPolicy);
    expect(acquireAgentLease('locked-refusal', session)).toBeNull();

    expect(takeoverRefusalResult()).toEqual({
      ok: false,
      error:
        'A human has taken over this browser session — the agent cannot drive it until they hand it back.',
      code: 'not_available',
    });
  });

  it('CONTROL — an unlocked session yields no refusal, so the navigation proceeds', async () => {
    seed('unlocked-refusal');
    const session = await getOrCreateSession('unlocked-refusal', newPolicy);
    const release = acquireAgentLease('unlocked-refusal', session);
    expect(release).not.toBeNull();
    release?.();
  });
});

describe('cleanupOnExit', () => {
  it('awaits context.close() — a persistent profile flushes on context close', async () => {
    let contextClosed = false;
    const session = fakeSession(policyFingerprint({}), {
      browser: undefined,
      context: {
        close: async () => {
          contextClosed = true;
        },
      } as unknown as BrowserContext,
    });
    sessions.set(makeMapKey('exit', {}), session);

    await cleanupOnExit();

    expect(contextClosed).toBe(true);
    expect(sessions.size).toBe(0);
  });
});
