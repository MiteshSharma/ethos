// B1/B2 — `browser_request_takeover`.
//
// The lock (`session.takeover`) is the thing under test. While it is set the
// idle sweeper skips the session and every other browser tool refuses, so a
// lock leaked on ANY exit path wedges browsing for the rest of the process.
// Each of the four outcomes therefore gets its own test, and each asserts the
// LOCK, not just the returned result.
//
// Revert the `finally` in browser-takeover.ts and the timeout / cancel / abort
// / closed-session cases fail. Revert the `takeoverRefusal` guards and
// "other browser tools refuse while locked" fails. Revert the `bringToFront`
// branch and the headed test fails.

import type { ClarifyRequestInput } from '@ethosagent/core';
import { ClarifyBridge, ClarifyTimedOutNoDefaultError, FileClarifyStore } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  ClarifyResponse,
  ClarifySurfaceType,
  PendingClarify,
  Tool,
  ToolContext,
} from '@ethosagent/types';
import type { BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserTakeoverTool } from '../browser-takeover';
import { createBrowserTools } from '../index';
import {
  type BrowserSession,
  makeMapKey,
  onTakeoverSettled,
  policyFingerprint,
  sessions,
} from '../sessions';

vi.mock('../sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sessions')>()),
  isPlaywrightInstalled: () => true,
}));

interface FakePage {
  bringToFrontCalls: number;
  closed: boolean;
  page: Page;
}

function fakePage(url = 'https://example.com/login'): FakePage {
  const state = { bringToFrontCalls: 0, closed: false };
  const page = {
    url: () => url,
    isClosed: () => state.closed,
    bringToFront: async () => {
      state.bringToFrontCalls += 1;
    },
    screenshot: async () => Buffer.from('jpeg-bytes'),
    viewportSize: () => ({ width: 1280, height: 720 }),
  } as unknown as Page;
  return {
    get bringToFrontCalls() {
      return state.bringToFrontCalls;
    },
    get closed() {
      return state.closed;
    },
    set closed(v: boolean) {
      state.closed = v;
    },
    page,
  };
}

function seed(sessionId: string, page: Page, over: Partial<BrowserSession> = {}): BrowserSession {
  const policy = {};
  const session: BrowserSession = {
    context: { route: async () => {} } as unknown as BrowserContext,
    page,
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

function toolCtx(
  sessionId: string,
  abortSignal?: AbortSignal,
  platform: ToolContext['platform'] = 'cli',
): ToolContext {
  return {
    sessionId,
    sessionKey: `cli:${sessionId}`,
    platform,
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
  resolve: (r: ClarifyResponse) => void;
  reject: (e: Error) => void;
}

/**
 * A bridge whose `request()` stays pending until the test settles it — the
 * only way to observe the lock WHILE it is held. Mirrors the real bridge's
 * abort behaviour: an aborted turn resolves the request as `cancel`.
 */
function makeBridge(): {
  bridge: ClarifyBridge;
  captured: ClarifyRequestInput[];
  settle: () => Deferred;
} {
  const captured: ClarifyRequestInput[] = [];
  let deferred: Deferred | undefined;
  const bridge = {
    request: (input: ClarifyRequestInput) => {
      captured.push(input);
      // The real bridge hands the minted id over before it awaits anything —
      // that is what lets the tool bind its lock to THIS request.
      input.onRequestId?.('r1');
      return new Promise<ClarifyResponse>((resolve, reject) => {
        deferred = { resolve, reject };
        input.abortSignal?.addEventListener('abort', () =>
          resolve({ requestId: 'r1', answer: '', source: 'cancel' }),
        );
      });
    },
  } as unknown as ClarifyBridge;
  return {
    bridge,
    captured,
    settle: () => {
      if (!deferred) throw new Error('bridge.request was never called');
      return deferred;
    },
  };
}

afterEach(() => {
  sessions.clear();
});

describe('browser_request_takeover — lock lifecycle', () => {
  it('RESOLVE: the user hands back → handed_back, lock cleared', async () => {
    const p = fakePage();
    const session = seed('lock-resolve', p.page);
    const { bridge, settle } = makeBridge();
    const tool = createBrowserTakeoverTool(bridge);

    const pending = tool.execute({ reason: 'log in' }, toolCtx('lock-resolve'));
    expect(session.takeover).toBeDefined();

    settle().resolve({ requestId: 'r1', answer: 'handed back', source: 'user' });
    const result = await pending;

    expect(session.takeover).toBeUndefined();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.value)).toEqual({
      handed_back: true,
      outcome: 'user',
      url: 'https://example.com/login',
    });
  });

  it('REJECT (timeout, no default): execution_failed, lock cleared', async () => {
    const p = fakePage();
    const session = seed('lock-timeout', p.page);
    const { bridge, settle } = makeBridge();
    const tool = createBrowserTakeoverTool(bridge);

    const pending = tool.execute({ reason: 'log in', timeout_s: 30 }, toolCtx('lock-timeout'));
    expect(session.takeover).toBeDefined();
    settle().reject(new ClarifyTimedOutNoDefaultError());
    const result = await pending;

    expect(session.takeover).toBeUndefined();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('execution_failed');
    expect(result.error).toContain('30s');
  });

  it('CANCEL: the takeover is cancelled → handed_back false, lock cleared', async () => {
    const p = fakePage();
    const session = seed('lock-cancel', p.page);
    const { bridge, settle } = makeBridge();
    const tool = createBrowserTakeoverTool(bridge);

    const pending = tool.execute({ reason: 'log in' }, toolCtx('lock-cancel'));
    expect(session.takeover).toBeDefined();
    settle().resolve({ requestId: 'r1', answer: '', source: 'cancel' });
    const result = await pending;

    expect(session.takeover).toBeUndefined();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.value)).toMatchObject({ handed_back: false, outcome: 'cancel' });
  });

  it('ABORT: the turn aborts mid-takeover → lock cleared', async () => {
    const p = fakePage();
    const session = seed('lock-abort', p.page);
    const { bridge } = makeBridge();
    const tool = createBrowserTakeoverTool(bridge);
    const controller = new AbortController();

    const pending = tool.execute({ reason: 'log in' }, toolCtx('lock-abort', controller.signal));
    expect(session.takeover).toBeDefined();
    controller.abort();
    const result = await pending;

    expect(session.takeover).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it('the session is closed during the takeover → execution_failed, lock cleared', async () => {
    const p = fakePage();
    const session = seed('lock-closed', p.page);
    const { bridge, settle } = makeBridge();
    const tool = createBrowserTakeoverTool(bridge);

    const pending = tool.execute({ reason: 'log in' }, toolCtx('lock-closed'));
    p.closed = true;
    settle().resolve({ requestId: 'r1', answer: 'handed back', source: 'user' });
    const result = await pending;

    expect(session.takeover).toBeUndefined();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('execution_failed');
    expect(result.error).toContain('closed');
  });
});

describe('browser_request_takeover — the lock names the request it belongs to', () => {
  it('stamps the minted request id onto the lock WHILE the takeover is live', async () => {
    // The screencast lane refuses any client that does not present this exact
    // id, so it has to be on the lock while the agent is parked — not handed
    // over when `request()` resolves, which is when the lock is released.
    const p = fakePage();
    const session = seed('bind-id', p.page);
    const { bridge, settle } = makeBridge();
    const tool = createBrowserTakeoverTool(bridge);

    const pending = tool.execute({ reason: 'log in' }, toolCtx('bind-id'));
    expect(session.takeover?.requestId).toBe('r1');

    settle().resolve({ requestId: 'r1', answer: 'handed back', source: 'user' });
    await pending;
    expect(session.takeover).toBeUndefined();
  });

  it('tells watchers the takeover settled — on the hand-back path AND the cancel path', async () => {
    // The screencast lane holds a CDP session for as long as the lock is set.
    // Clearing the lock silently would leave a human driving a browser the
    // agent has resumed, so every exit announces itself.
    const seen: Array<[string, string]> = [];
    const off = onTakeoverSettled((sessionId, requestId) => {
      seen.push([sessionId, requestId]);
    });
    try {
      const handed = makeBridge();
      const p1 = fakePage();
      seed('settle-user', p1.page);
      const first = createBrowserTakeoverTool(handed.bridge).execute(
        { reason: 'log in' },
        toolCtx('settle-user'),
      );
      expect(seen).toEqual([]);
      handed.settle().resolve({ requestId: 'r1', answer: 'handed back', source: 'user' });
      await first;

      const cancelled = makeBridge();
      const p2 = fakePage();
      seed('settle-cancel', p2.page);
      const second = createBrowserTakeoverTool(cancelled.bridge).execute(
        { reason: 'log in' },
        toolCtx('settle-cancel'),
      );
      cancelled.settle().resolve({ requestId: 'r1', answer: '', source: 'cancel' });
      await second;

      expect(seen).toEqual([
        ['settle-user', 'r1'],
        ['settle-cancel', 'r1'],
      ]);
    } finally {
      off();
    }
  });

  it('a listener that throws does not fail the tool call', async () => {
    const off = onTakeoverSettled(() => {
      throw new Error('a viewer teardown blew up');
    });
    try {
      const p = fakePage();
      seed('settle-throws', p.page);
      const { bridge, settle } = makeBridge();
      const pending = createBrowserTakeoverTool(bridge).execute(
        { reason: 'log in' },
        toolCtx('settle-throws'),
      );
      settle().resolve({ requestId: 'r1', answer: 'handed back', source: 'user' });
      const result = await pending;
      expect(result.ok).toBe(true);
    } finally {
      off();
    }
  });
});

describe('browser_request_takeover — the request it sends', () => {
  it('carries kind + meta (url, sessionId) so surfaces draw the panel', async () => {
    const p = fakePage();
    seed('meta', p.page);
    const { bridge, captured, settle } = makeBridge();
    const tool = createBrowserTakeoverTool(bridge);

    const pending = tool.execute({ reason: 'solve the captcha' }, toolCtx('meta'));
    settle().resolve({ requestId: 'r1', answer: 'handed back', source: 'user' });
    await pending;

    expect(captured[0]?.kind).toBe('browser_takeover');
    expect(captured[0]?.meta).toEqual({ url: 'https://example.com/login', sessionId: 'meta' });
    // The tool never supplies a default — a takeover nobody performed must
    // reject, not resolve as if it had happened.
    expect(captured[0]?.default).toBeUndefined();
  });

  it('refuses without a reason, and never takes the lock', async () => {
    const p = fakePage();
    const session = seed('no-reason', p.page);
    const { bridge } = makeBridge();
    const result = await createBrowserTakeoverTool(bridge).execute(
      { reason: '  ' },
      toolCtx('no-reason'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('input_invalid');
    expect(session.takeover).toBeUndefined();
  });

  it('refuses when there is no browser session at all', async () => {
    const { bridge } = makeBridge();
    const result = await createBrowserTakeoverTool(bridge).execute(
      { reason: 'log in' },
      toolCtx('nothing-here'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('execution_failed');
  });
});

describe('browser_request_takeover — B2 bringToFront', () => {
  it('raises the window for a HEADED session', async () => {
    const p = fakePage();
    seed('headed', p.page, { headed: true });
    const { bridge, settle } = makeBridge();
    const pending = createBrowserTakeoverTool(bridge).execute(
      { reason: 'log in' },
      toolCtx('headed'),
    );
    await vi.waitFor(() => expect(p.bringToFrontCalls).toBe(1));
    settle().resolve({ requestId: 'r1', answer: 'handed back', source: 'user' });
    await pending;
  });

  it('does NOT for a headless session — there is no window to raise', async () => {
    const p = fakePage();
    seed('headless', p.page, { headed: false });
    const { bridge, settle } = makeBridge();
    const pending = createBrowserTakeoverTool(bridge).execute(
      { reason: 'log in' },
      toolCtx('headless'),
    );
    settle().resolve({ requestId: 'r1', answer: 'handed back', source: 'user' });
    await pending;
    expect(p.bringToFrontCalls).toBe(0);
  });
});

describe('other browser tools while the lock is held', () => {
  it('refuse with not_available, and work again once it clears', async () => {
    const p = fakePage();
    seed('busy', p.page);
    const { bridge, settle } = makeBridge();
    const tools = new Map(
      createBrowserTools({ clarifyBridge: bridge }).map((t): [string, Tool] => [t.name, t]),
    );

    const shot = tools.get('browser_screenshot');
    const takeover = tools.get('browser_request_takeover');
    expect(shot).toBeDefined();
    expect(takeover).toBeDefined();
    if (!shot || !takeover) return;

    // Before: the tool works.
    expect((await shot.execute({}, toolCtx('busy'))).ok).toBe(true);

    const pending = takeover.execute({ reason: 'log in' }, toolCtx('busy'));
    const during = await shot.execute({}, toolCtx('busy'));
    expect(during.ok).toBe(false);
    if (during.ok) return;
    expect(during.code).toBe('not_available');

    settle().resolve({ requestId: 'r1', answer: 'handed back', source: 'user' });
    await pending;

    // After: the browser is the agent's again.
    expect((await shot.execute({}, toolCtx('busy'))).ok).toBe(true);
  });

  it('a second takeover on the same session is refused', async () => {
    const p = fakePage();
    seed('double', p.page);
    const { bridge, settle } = makeBridge();
    const tool = createBrowserTakeoverTool(bridge);

    const pending = tool.execute({ reason: 'log in' }, toolCtx('double'));
    const second = await tool.execute({ reason: 'log in again' }, toolCtx('double'));
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('not_available');

    settle().resolve({ requestId: 'r1', answer: 'handed back', source: 'user' });
    await pending;
  });
});

// ---------------------------------------------------------------------------
// The takeover answer gate, driven through a REAL ClarifyBridge.
// ---------------------------------------------------------------------------
//
// Every test above settles a STUB bridge directly, which is exactly how the
// hole survived: nothing here ever asked whether a channel could produce that
// `source: 'user'` in the first place. It could — a takeover carries no
// `options`, and no options was the free-form shape on Telegram, WhatsApp and
// Discord alike — so anyone typing anything made this tool report
// `handed_back: true` for a login that had not happened.
//
// Revert `acceptsUserAnswer` in `ClarifyBridge.respond()` and the first test
// below fails. Revert the `finally` in `browser-takeover.ts` and the other two
// fail on the lock.
describe('browser_request_takeover — a channel cannot hand the browser back', () => {
  function realBridge(surfaceType: ClarifySurfaceType) {
    const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
    const bridge = new ClarifyBridge(store, { reconcilePollMs: 0 });
    const presented: PendingClarify[] = [];
    bridge.registerPresenter(surfaceType, (row) => {
      presented.push(row);
    });
    return { bridge, store, presented };
  }

  async function untilPresented(presented: PendingClarify[]): Promise<PendingClarify> {
    while (presented.length === 0) await new Promise((r) => setImmediate(r));
    const row = presented[0];
    if (!row) throw new Error('nothing was presented');
    return row;
  }

  it('refuses a telegram answer, and still reports the outcome honestly on cancel', async () => {
    const p = fakePage();
    const session = seed('gate-telegram', p.page);
    const { bridge, store, presented } = realBridge('telegram');
    const tool = createBrowserTakeoverTool(bridge);

    const pending = tool.execute(
      { reason: 'log in' },
      toolCtx('gate-telegram', undefined, 'telegram'),
    );
    const row = await untilPresented(presented);
    expect(session.takeover).toBeDefined();

    // What a group participant typing "ok" produces.
    await bridge.respond({ requestId: row.requestId, answer: 'ok', source: 'user' });

    // Still parked: the lock is held and no result has been produced.
    expect(session.takeover).toBeDefined();
    expect((await store.get(row.requestId))?.answer).toBeUndefined();

    // Cancel is the release path a channel keeps, and it clears the lock.
    await bridge.respond({ requestId: row.requestId, answer: '', source: 'cancel' });
    const result = await pending;
    expect(session.takeover).toBeUndefined();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.value)).toMatchObject({ handed_back: false, outcome: 'cancel' });
  });

  it('still times out a takeover nobody may answer, and clears the lock', async () => {
    const p = fakePage();
    const session = seed('gate-timeout', p.page);
    const { bridge, presented } = realBridge('whatsapp');
    const tool = createBrowserTakeoverTool(bridge);

    const pending = tool.execute(
      { reason: 'log in', timeout_s: 1 },
      toolCtx('gate-timeout', undefined, 'whatsapp'),
    );
    const row = await untilPresented(presented);
    await bridge.respond({ requestId: row.requestId, answer: 'done', source: 'user' });

    const result = await pending;
    expect(session.takeover).toBeUndefined();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('execution_failed');
  });

  it('still hands back from a surface that can actually reach the browser', async () => {
    const p = fakePage();
    const session = seed('gate-web', p.page);
    const { bridge, presented } = realBridge('web');
    const tool = createBrowserTakeoverTool(bridge);

    const pending = tool.execute({ reason: 'log in' }, toolCtx('gate-web', undefined, 'web'));
    const row = await untilPresented(presented);
    await bridge.respond({ requestId: row.requestId, answer: 'handed back', source: 'user' });

    const result = await pending;
    expect(session.takeover).toBeUndefined();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.value)).toMatchObject({ handed_back: true, outcome: 'user' });
  });
});
