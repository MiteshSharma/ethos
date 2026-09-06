// The takeover flag is not a lock — the per-session lease is.
//
// `session.takeover` is read ONCE at each tool's entry, and every browser tool
// then awaits: a goto, a click, an LLM call, a snapshot. A takeover starting in
// that window used to find the agent still driving the page it had just handed
// to a human, and a navigation failure or an abort could call `closeSession`
// and destroy the browser while the human was using it. Both are races by
// construction, so these tests do not assert that the flag is checked — they
// drive the interleaving and assert on WHAT REACHED THE PAGE.
//
// Revert-proofs:
//   - Drop `acquireAgentLease` from browse_url (restore the bare flag check)
//     and "an in-flight navigation finishes before the human is handed the
//     browser" fails: `handover` lands in the middle of the navigation's own
//     page calls.
//   - Drop `if (s.takeover) continue;` from `closeSession` and both
//     "cannot close a session the human is holding" tests fail.
//   - Drop the `leaseHeldByOthers` check from `closeSession` and "cannot close
//     a session a sibling agent operation is holding" fails; drop the
//     `ownLease` argument instead and "a failing navigation still closes the
//     browser it just failed on" fails.
//   - Drop the `state.exclusive` check in `acquireAgentLease` and "the lease
//     alone refuses" fails.
//   - Drop `lease.release()` from the takeover's `finally` and "releases
//     everything it took" fails.

import type { ClarifyBridge, ClarifyRequestInput } from '@ethosagent/core';
import type { ClarifyResponse, Tool, ToolContext } from '@ethosagent/types';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserTools } from '../index';
import {
  acquireAgentLease,
  activeLeaseCount,
  type BrowserSession,
  claimTakeoverLease,
  closeSession,
  makeMapKey,
  policyFingerprint,
  sessions,
} from '../sessions';

vi.mock('../sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sessions')>()),
  isPlaywrightInstalled: () => true,
}));

// A fake Chromium, so the CREATION path (deadlock tests) runs without a
// browser. Its pages are complete enough for a whole browse_url call.
const pw = vi.hoisted(() => {
  function makePage() {
    return {
      on: () => {},
      goto: async () => null,
      isClosed: () => false,
      title: async () => 'Created',
      url: () => 'https://93.184.216.34/',
      waitForTimeout: async () => {},
      locator: () => ({ ariaSnapshot: async () => '- text "created"' }),
    };
  }
  function makeContext() {
    return {
      close: async () => {},
      route: async () => {},
      pages: () => [],
      newPage: async () => makePage(),
    };
  }
  return {
    chromium: {
      launch: async () => ({ newContext: async () => makeContext(), close: async () => {} }),
      launchPersistentContext: async () => makeContext(),
    },
  };
});

vi.mock('playwright', () => ({ chromium: pw.chromium }));

// A public IP literal keeps validateUrl / checkSsrf off the network.
const URL_UNDER_TEST = 'https://93.184.216.34/';

function deferred<T>() {
  let settle: (value: T) => void = () => {};
  let fail: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
}

/** Let queued microtasks and timers run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A page that writes every call it receives into a shared timeline, and whose
 * navigation the test settles by hand. The timeline is the evidence: the
 * takeover's own `handover` mark goes into the SAME array, so "did the agent
 * touch the page after the human got it" is an index comparison.
 */
function fakePage(
  timeline: string[],
  navigation: Promise<null>,
  snapshotGate: Promise<void> = Promise.resolve(),
): Page {
  return {
    goto: async () => {
      timeline.push('goto');
      return await navigation;
    },
    title: async () => {
      timeline.push('title');
      return 'Example';
    },
    url: () => URL_UNDER_TEST,
    isClosed: () => false,
    bringToFront: async () => {
      timeline.push('bringToFront');
    },
    screenshot: async () => {
      timeline.push('screenshot');
      return Buffer.from('jpeg');
    },
    viewportSize: () => ({ width: 1280, height: 720 }),
    waitForTimeout: async () => {},
    locator: () => ({
      ariaSnapshot: async () => {
        timeline.push('ariaSnapshot');
        await snapshotGate;
        return '- text "hello"';
      },
    }),
  } as unknown as Page;
}

function seed(
  sessionId: string,
  page: Page,
  over: Partial<BrowserSession> = {},
): { session: BrowserSession; closed: () => boolean } {
  let closed = false;
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
    pendingWarnings: [],
    lastActiveAt: Date.now(),
    close: async () => {
      closed = true;
    },
    ...over,
  };
  sessions.set(makeMapKey(sessionId, policy), session);
  return { session, closed: () => closed };
}

function toolCtx(sessionId: string, abortSignal?: AbortSignal): ToolContext {
  return {
    sessionId,
    sessionKey: `cli:${sessionId}`,
    platform: 'cli',
    workingDir: '/tmp',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: abortSignal ?? new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 10_000,
    networkPolicy: {},
  };
}

interface Deferred {
  resolve: (response: ClarifyResponse) => void;
  reject: (error: Error) => void;
}

/**
 * A bridge that marks the timeline the moment the human is handed the browser
 * and then stays pending until the test settles it. `bridge.request` being
 * called IS "the exclusive lease is taken" as anyone outside can observe it.
 */
function makeBridge(timeline: string[]): { bridge: ClarifyBridge; settle: () => Deferred } {
  let deferredResponse: Deferred | undefined;
  const bridge = {
    request: (input: ClarifyRequestInput) => {
      timeline.push('handover');
      input.onRequestId?.('r1');
      return new Promise<ClarifyResponse>((resolve, reject) => {
        deferredResponse = { resolve, reject };
        input.abortSignal?.addEventListener('abort', () =>
          resolve({ requestId: 'r1', answer: '', source: 'cancel' }),
        );
      });
    },
  } as unknown as ClarifyBridge;
  return {
    bridge,
    settle: () => {
      if (!deferredResponse) throw new Error('bridge.request was never called');
      return deferredResponse;
    },
  };
}

function toolMap(bridge: ClarifyBridge): Map<string, Tool> {
  return new Map(
    createBrowserTools({ clarifyBridge: bridge }).map((t): [string, Tool] => [t.name, t]),
  );
}

function tool(tools: Map<string, Tool>, name: string): Tool {
  const found = tools.get(name);
  if (!found) throw new Error(`tool ${name} is not registered`);
  return found;
}

afterEach(() => {
  sessions.clear();
});

describe('an agent operation already in flight when a takeover begins', () => {
  it('finishes its page work BEFORE the human is handed the browser', async () => {
    const timeline: string[] = [];
    const navigation = deferred<null>();
    seed('inflight', fakePage(timeline, navigation.promise));
    const { bridge, settle } = makeBridge(timeline);
    const tools = toolMap(bridge);

    // The navigation is parked inside `page.goto`, holding the shared lease.
    const navigating = tool(tools, 'browse_url').execute(
      { url: URL_UNDER_TEST },
      toolCtx('inflight'),
    );
    await vi.waitFor(() => expect(timeline).toEqual(['goto']));

    // The takeover starts NOW — after the navigation passed its takeover check.
    const takingOver = tool(tools, 'browser_request_takeover').execute(
      { reason: 'log in' },
      toolCtx('inflight'),
    );
    await flush();

    // It has NOT reached the human: the drain is waiting on the navigation.
    expect(timeline).toEqual(['goto']);

    navigation.settle(null);
    const navResult = await navigating;
    expect(navResult.ok).toBe(true);

    await vi.waitFor(() => expect(timeline).toContain('handover'));

    // The evidence: every page call the navigation made is BEFORE the handover.
    // Without the lease the takeover proceeds immediately and `handover` lands
    // between `goto` and `title` — the agent snapshotting a page a human owns.
    expect(timeline).toEqual(['goto', 'title', 'ariaSnapshot', 'handover']);

    settle().resolve({ requestId: 'r1', answer: 'done', source: 'user' });
    await takingOver;
    expect(activeLeaseCount('inflight')).toBe(0);
  });

  it('a vision click parked mid-resolution finishes before the handover', async () => {
    // The widest check-then-act window in the package: `browser_vision_click`
    // reads the page, then asks an LLM where to click, then clicks. A takeover
    // landing anywhere in there used to find the agent still driving.
    const timeline: string[] = [];
    const resolving = deferred<void>();
    seed('vision', fakePage(timeline, Promise.resolve(null), resolving.promise));
    const { bridge, settle } = makeBridge(timeline);
    const tools = toolMap(bridge);

    const clicking = tool(tools, 'browser_vision_click').execute(
      { description: 'the login button' },
      toolCtx('vision'),
    );
    await vi.waitFor(() => expect(timeline).toEqual(['ariaSnapshot']));

    const takingOver = tool(tools, 'browser_request_takeover').execute(
      { reason: 'log in' },
      toolCtx('vision'),
    );
    await flush();
    expect(timeline).toEqual(['ariaSnapshot']);

    resolving.settle();
    expect((await clicking).ok).toBe(true);

    await vi.waitFor(() => expect(timeline).toContain('handover'));
    expect(timeline).toEqual(['ariaSnapshot', 'handover']);

    settle().resolve({ requestId: 'r1', answer: 'done', source: 'user' });
    await takingOver;
    expect(activeLeaseCount('vision')).toBe(0);
  });

  it('a navigation that FAILS still drains before the handover, and cannot close the session', async () => {
    const timeline: string[] = [];
    const navigation = deferred<null>();
    const { session, closed } = seed('failing', fakePage(timeline, navigation.promise));
    const { bridge, settle } = makeBridge(timeline);
    const tools = toolMap(bridge);

    const navigating = tool(tools, 'browse_url').execute(
      { url: URL_UNDER_TEST },
      toolCtx('failing'),
    );
    await vi.waitFor(() => expect(timeline).toEqual(['goto']));

    const takingOver = tool(tools, 'browser_request_takeover').execute(
      { reason: 'log in' },
      toolCtx('failing'),
    );
    await flush();
    expect(timeline).toEqual(['goto']);

    // The failure path: `catch` → `closeSession`. That is the call that used to
    // destroy the browser out from under the person about to use it.
    navigation.fail(new Error('net::ERR_CONNECTION_RESET'));
    const navResult = await navigating;
    expect(navResult.ok).toBe(false);

    // The human's browser survived its cleanup, and is still the one in the map.
    expect(closed()).toBe(false);
    expect(sessions.get(makeMapKey('failing', {}))).toBe(session);

    await vi.waitFor(() => expect(timeline).toContain('handover'));
    expect(timeline).toEqual(['goto', 'handover']);

    settle().resolve({ requestId: 'r1', answer: 'done', source: 'user' });
    await takingOver;

    // ...and the skip is scoped to the lock: once it clears, close works again.
    await closeSession('failing');
    expect(closed()).toBe(true);
    expect(activeLeaseCount('failing')).toBe(0);
  });

  it("an ABORTED turn's close handler cannot close the session either", async () => {
    const timeline: string[] = [];
    const navigation = deferred<null>();
    const { closed } = seed('aborting', fakePage(timeline, navigation.promise));
    const { bridge, settle } = makeBridge(timeline);
    const tools = toolMap(bridge);
    const controller = new AbortController();

    const navigating = tool(tools, 'browse_url').execute(
      { url: URL_UNDER_TEST },
      toolCtx('aborting', controller.signal),
    );
    await vi.waitFor(() => expect(timeline).toEqual(['goto']));

    const takingOver = tool(tools, 'browser_request_takeover').execute(
      { reason: 'log in' },
      toolCtx('aborting'),
    );
    await flush();

    // `browse_url` registers an abort listener that calls closeSession without
    // awaiting it — scheduled long before the lock existed, fired after it did.
    controller.abort();
    await flush();
    expect(closed()).toBe(false);

    navigation.settle(null);
    await navigating;
    await vi.waitFor(() => expect(timeline).toContain('handover'));
    expect(closed()).toBe(false);

    settle().resolve({ requestId: 'r1', answer: 'done', source: 'user' });
    await takingOver;
  });
});

describe('closeSession and the SHARED lease', () => {
  // `closeSession` honoured `session.takeover` but not the lease, while
  // `sweepIdleSessions` — the other reaper, four lines away — checked both and
  // said why. Its callers are async cleanup paths, so one browser tool failing
  // could destroy the browser a SIBLING tool was mid-navigation on. Not a
  // takeover bypass (the flag is set synchronously); the same invariant, half
  // applied.

  it('cannot close a session a sibling agent operation is holding', async () => {
    const { session, closed } = seed('shared', fakePage([], Promise.resolve(null)));
    // `browser_click`, say, is inside `page.click` on this session.
    const sibling = acquireAgentLease('shared', session);
    expect(sibling).not.toBeNull();

    // ...and `browse_url` fails on the same session and tidies up after itself.
    await closeSession('shared');

    expect(closed()).toBe(false);
    expect(sessions.get(makeMapKey('shared', {}))).toBe(session);

    // The skip DEFERS, it does not exempt: once the sibling releases, the same
    // call closes it.
    sibling?.();
    await closeSession('shared');
    expect(closed()).toBe(true);
  });

  it('closes a session nobody is holding', async () => {
    // The control. Without it every assertion above is satisfied by a
    // `closeSession` that has stopped closing anything.
    const { closed } = seed('free', fakePage([], Promise.resolve(null)));

    await closeSession('free');

    expect(closed()).toBe(true);
    expect(activeLeaseCount('free')).toBe(0);
  });

  it('lets a caller close the browser it is itself holding', async () => {
    // Cleanup runs INSIDE the caller's own lease on purpose (releasing first
    // would let a takeover's exclusive lease land mid-teardown), so without
    // `ownLease` the check above would turn every cleanup path into a no-op.
    const { session, closed } = seed('own', fakePage([], Promise.resolve(null)));
    const own = acquireAgentLease('own', session);

    await closeSession('own', own);

    expect(closed()).toBe(true);
    own?.();
  });

  it('a failing navigation still closes the browser it just failed on', async () => {
    // The same thing through the real caller, so the test above cannot pass
    // while production forgets to pass its lease.
    const timeline: string[] = [];
    const navigation = deferred<null>();
    const { closed } = seed('failing-alone', fakePage(timeline, navigation.promise));
    const tools = toolMap(makeBridge(timeline).bridge);

    const navigating = tool(tools, 'browse_url').execute(
      { url: URL_UNDER_TEST },
      toolCtx('failing-alone'),
    );
    await vi.waitFor(() => expect(timeline).toEqual(['goto']));
    navigation.fail(new Error('net::ERR_CONNECTION_RESET'));

    expect((await navigating).ok).toBe(false);
    expect(closed()).toBe(true);
    expect(activeLeaseCount('failing-alone')).toBe(0);
  });
});

describe('a tool that starts DURING a takeover', () => {
  it('is refused in the existing words, and works again once it settles', async () => {
    const timeline: string[] = [];
    seed('during', fakePage(timeline, Promise.resolve(null)));
    const { bridge, settle } = makeBridge(timeline);
    const tools = toolMap(bridge);

    const takingOver = tool(tools, 'browser_request_takeover').execute(
      { reason: 'log in' },
      toolCtx('during'),
    );
    await vi.waitFor(() => expect(timeline).toContain('handover'));

    const during = await tool(tools, 'browser_screenshot').execute({}, toolCtx('during'));
    expect(during).toEqual({
      ok: false,
      error:
        'A human has taken over this browser session — the agent cannot drive it until they hand it back.',
      code: 'not_available',
    });
    // Nothing of the refused call reached the page.
    expect(timeline).toEqual(['handover']);

    settle().resolve({ requestId: 'r1', answer: 'done', source: 'user' });
    await takingOver;

    const after = await tool(tools, 'browser_screenshot').execute({}, toolCtx('during'));
    expect(after.ok).toBe(true);
    expect(timeline).toEqual(['handover', 'screenshot']);
    expect(activeLeaseCount('during')).toBe(0);
  });

  it('the lease alone refuses — the flag is not what does the refusing', () => {
    // No `session.takeover` anywhere: this is the exclusive lease on its own,
    // which is what covers the window between the flag being read and the page
    // being touched.
    const timeline: string[] = [];
    const { session } = seed('lease-only', fakePage(timeline, Promise.resolve(null)));
    const lease = claimTakeoverLease('lease-only');

    expect(session.takeover).toBeUndefined();
    expect(acquireAgentLease('lease-only', session)).toBeNull();

    lease.release();
    const release = acquireAgentLease('lease-only', session);
    expect(release).not.toBeNull();
    release?.();
    expect(activeLeaseCount('lease-only')).toBe(0);
  });
});

describe('no deadlock', () => {
  it('a session CREATION completes while another session holds an agent lease and a takeover drains', async () => {
    // The ordering under test: creation lock outside, lease strictly inside.
    // A takeover draining must never block a launch, and a launch must never
    // block a drain.
    const timeline: string[] = [];
    const navigation = deferred<null>();
    seed('holder', fakePage(timeline, navigation.promise));
    const { bridge, settle } = makeBridge(timeline);
    const tools = toolMap(bridge);

    const navigating = tool(tools, 'browse_url').execute(
      { url: URL_UNDER_TEST },
      toolCtx('holder'),
    );
    await vi.waitFor(() => expect(timeline).toEqual(['goto']));

    const takingOver = tool(tools, 'browser_request_takeover').execute(
      { reason: 'log in' },
      toolCtx('holder'),
    );
    await flush();

    // A different session with nothing in the map — this one has to LAUNCH,
    // taking the creation mutex, while the lease above is held and a drain is
    // parked on it.
    const created = await tool(tools, 'browse_url').execute(
      { url: URL_UNDER_TEST },
      toolCtx('needs-creation'),
    );
    expect(created.ok).toBe(true);

    navigation.settle(null);
    await navigating;
    await vi.waitFor(() => expect(timeline).toContain('handover'));
    settle().resolve({ requestId: 'r1', answer: 'done', source: 'user' });
    await takingOver;
    expect(activeLeaseCount('holder')).toBe(0);
    expect(activeLeaseCount('needs-creation')).toBe(0);
  });

  it('a takeover on a session that had to be created completes', async () => {
    const timeline: string[] = [];
    const { bridge, settle } = makeBridge(timeline);
    const tools = toolMap(bridge);

    const created = await tool(tools, 'browse_url').execute(
      { url: URL_UNDER_TEST },
      toolCtx('fresh'),
    );
    expect(created.ok).toBe(true);

    const takingOver = tool(tools, 'browser_request_takeover').execute(
      { reason: 'log in' },
      toolCtx('fresh'),
    );
    await vi.waitFor(() => expect(timeline).toContain('handover'));
    settle().resolve({ requestId: 'r1', answer: 'done', source: 'user' });
    expect((await takingOver).ok).toBe(true);
    expect(activeLeaseCount('fresh')).toBe(0);
  });

  it('a drain that never finishes gives up rather than parking the takeover forever', async () => {
    // A wedged tool call must not hold the session — and its flag — for the
    // life of the process. The bound is the whole reason the drain is raced.
    const timeline: string[] = [];
    const { session } = seed('wedged', fakePage(timeline, Promise.resolve(null)));
    const stuck = acquireAgentLease('wedged', session);
    expect(stuck).not.toBeNull();

    const lease = claimTakeoverLease('wedged', 5);
    expect(await lease.drain).toBe(false);
    lease.release();

    // Released on the way out, so the browser is the agent's again.
    stuck?.();
    const release = acquireAgentLease('wedged', session);
    expect(release).not.toBeNull();
    release?.();
    expect(activeLeaseCount('wedged')).toBe(0);
  });
});

describe('an abandoned takeover', () => {
  it('releases everything it took when the clarify times out', async () => {
    // Nobody ever presses Hand back. The clarify rejects on its own timeout and
    // the tool's `finally` frees the flag AND the lease — the same `finally`,
    // so they cannot drift.
    const timeline: string[] = [];
    const { session } = seed('abandoned', fakePage(timeline, Promise.resolve(null)));
    const { bridge, settle } = makeBridge(timeline);
    const tools = toolMap(bridge);

    const takingOver = tool(tools, 'browser_request_takeover').execute(
      { reason: 'log in', timeout_s: 1 },
      toolCtx('abandoned'),
    );
    await vi.waitFor(() => expect(timeline).toContain('handover'));

    settle().reject(new Error('nobody answered'));
    expect((await takingOver).ok).toBe(false);

    expect(session.takeover).toBeUndefined();
    expect(activeLeaseCount('abandoned')).toBe(0);
    const after = await tool(tools, 'browser_screenshot').execute({}, toolCtx('abandoned'));
    expect(after.ok).toBe(true);
  });
});
