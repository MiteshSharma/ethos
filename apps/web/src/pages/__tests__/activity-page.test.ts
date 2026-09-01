// @vitest-environment jsdom
//
// Activity is wired, not pure: its correctness lives in what it asks the
// server for and how the two answers (durable `activity.history`, live
// `/sse/activity`) land in one list. The conversion/merge/grouping rules are
// covered without a renderer in `lib/__tests__/activityFeed.test.ts`; this
// file drives the real component in jsdom against a mocked RPC client and a
// mocked SSE source, because the defects it guards — a scope read from the
// wrong place, an effect that reconnects on every refetch, a tool call drawn
// twice — are all between the pieces rather than inside one.

import type { ActivityEvent } from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGroups, convertHistoryItem, MAX_GROUPS } from '../../lib/activityFeed';

/** The page's own history page size — the amount the visible cap grows by. */
const PAGE_SIZE = 50;

const activityHistory = vi.fn();
const sessionsList = vi.fn();
const contextAnatomy = vi.fn();
const subscribeToActivity = vi.fn();

/** What `useParams()` hands the page — the route's `:personalityId`, or none. */
let routeParams: { personalityId?: string } = {};
/** Push a frame at whatever the page subscribed with. */
let emit: ((event: ActivityEvent, seq: number) => void) | null = null;

vi.mock('react-router-dom', () => ({ useParams: () => routeParams }));

vi.mock('../../rpc', () => ({
  rpc: {
    activity: { history: (...args: unknown[]) => activityHistory(...args) },
    sessions: {
      list: (...args: unknown[]) => sessionsList(...args),
      contextAnatomy: (...args: unknown[]) => contextAnatomy(...args),
    },
  },
}));

vi.mock('../../sse', () => ({
  subscribeToActivity: (
    personalityId: string | null,
    opts: { sinceSeq?: number; onEvent: (e: ActivityEvent, seq: number) => void },
  ) => {
    subscribeToActivity(personalityId, opts);
    emit = opts.onEvent;
    return { close: () => undefined, lastSeq: 0 };
  },
}));

function toolSpan(over: Record<string, unknown> = {}) {
  return {
    id: 'span-1',
    kind: 'tool_call',
    name: 'read_file',
    sessionId: 'sess-a',
    personalityId: 'agent-a',
    startedAt: 1_000,
    endedAt: 1_120,
    status: 'ok',
    details: { tool_call_id: 'tc1' },
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;
let Activity: React.ComponentType;

/** Let react-query resolve its promises and React commit the result. A macro
 *  task, not a microtask drain — the query client schedules across both. */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Number.POSITIVE_INFINITY } },
  });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(Activity)));
  });
  await flush();
}

/** Tear the page down and mount it fresh, as navigating away and back does.
 *  A second `root.render` would keep the component instance (and its effects)
 *  alive, which is not what a remount tests. */
async function remount(): Promise<void> {
  await act(async () => root.unmount());
  container.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await mount();
}

/** Expand every collapsed group so its rows are in the DOM. */
async function expandAll(): Promise<void> {
  const headers = [...container.querySelectorAll('.activity-group-header')];
  for (const header of headers) {
    await act(async () => {
      header.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }
}

beforeEach(async () => {
  routeParams = {};
  emit = null;
  activityHistory
    .mockReset()
    .mockResolvedValue({ items: [], nextBefore: null, nextBeforeId: null });
  sessionsList.mockReset().mockResolvedValue({ items: [], nextCursor: null });
  contextAnatomy.mockReset().mockResolvedValue({ anatomy: null });
  subscribeToActivity.mockReset();

  // React only flushes async `act(...)` work when it knows it is under test.
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // Antd reads matchMedia during responsive setup; jsdom ships none.
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  // Module-level resume cursor — each case needs its own copy.
  vi.resetModules();
  ({ Activity } = await import('../Activity'));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('Activity — durable history seed', () => {
  it('renders history with no live event ever arriving', async () => {
    activityHistory.mockResolvedValue({
      items: [
        // The turn opens the group, so it must sort before its own spans.
        {
          ...toolSpan(),
          id: 'trace-1',
          kind: 'turn',
          name: 'turn',
          startedAt: 900,
          endedAt: 1_900,
          details: null,
        },
        toolSpan(),
      ],
      nextBefore: null,
      nextBeforeId: null,
    });

    await mount();
    await expandAll();

    expect(container.textContent).toContain('Tool completed: read_file');
    expect(container.textContent).toContain('Turn completed');
    // The feed is populated purely from the durable read.
    expect(emit).not.toBeNull();
    expect(container.querySelectorAll('.activity-subevent')).toHaveLength(2);
  });

  it('shows the empty state when the store has nothing', async () => {
    await mount();
    expect(container.querySelectorAll('.activity-group')).toHaveLength(0);
    expect(container.textContent).toContain('No activity yet');
  });

  it('offers "load older" only when the page had more behind it', async () => {
    activityHistory.mockResolvedValue({
      items: [toolSpan()],
      nextBefore: null,
      nextBeforeId: null,
    });
    await mount();
    expect(container.textContent).not.toContain('Load older');

    activityHistory
      .mockReset()
      .mockResolvedValueOnce({ items: [toolSpan()], nextBefore: 900, nextBeforeId: 'span-1' });
    vi.resetModules();
    ({ Activity } = await import('../Activity'));
    await mount();
    expect(container.textContent).toContain('Load older');
  });

  it('shows what "load older" fetched even when the timeline is already capped', () => {
    // `buildGroups` caps the rendered list. A page fetched past that cap used
    // to be sliced straight off the end — the button did real work the user
    // never saw. The cap has to grow with each page.
    const turn = (i: number) => ({
      id: `trace-${i}`,
      kind: 'turn' as const,
      name: 'turn',
      sessionId: 'sess-a',
      personalityId: 'agent-a',
      startedAt: 10_000 + i,
      endedAt: 10_000 + i,
      status: 'ok',
      details: null,
    });
    const first = Array.from({ length: MAX_GROUPS }, (_, i) => turn(i + 1));
    const older = [turn(0)];

    const capped = buildGroups([...first, ...older].map(convertHistoryItem), MAX_GROUPS);
    expect(capped).toHaveLength(MAX_GROUPS);
    expect(capped.some((g) => g.id.includes('trace-0'))).toBe(false);

    const grown = buildGroups([...first, ...older].map(convertHistoryItem), MAX_GROUPS + PAGE_SIZE);
    expect(grown).toHaveLength(MAX_GROUPS + 1);
    expect(grown.some((g) => g.id.includes('trace-0'))).toBe(true);
  });

  it('grows the visible cap on every "load older"', async () => {
    const turn = (i: number) => ({
      id: `trace-${i}`,
      kind: 'turn',
      name: 'turn',
      sessionId: 'sess-a',
      personalityId: 'agent-a',
      startedAt: 10_000 + i,
      endedAt: 10_000 + i,
      status: 'ok',
      details: null,
    });
    activityHistory.mockResolvedValueOnce({
      items: Array.from({ length: MAX_GROUPS }, (_, i) => turn(i + 1)),
      nextBefore: 10_001,
      nextBeforeId: 'trace-1',
    });
    activityHistory.mockResolvedValueOnce({
      items: [turn(0)],
      nextBefore: null,
      nextBeforeId: null,
    });

    await mount();
    expect(container.querySelectorAll('.activity-group')).toHaveLength(MAX_GROUPS);

    const button = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Load older'),
    );
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    // The older page is on screen, not silently sliced off the end.
    expect(container.querySelectorAll('.activity-group')).toHaveLength(MAX_GROUPS + 1);
  });

  it('pages backwards with the returned cursor', async () => {
    activityHistory.mockResolvedValueOnce({
      items: [toolSpan()],
      nextBefore: 900,
      nextBeforeId: 'span-1',
    });
    activityHistory.mockResolvedValueOnce({
      items: [toolSpan({ id: 'span-0', details: { tool_call_id: 'tc0' }, startedAt: 500 })],
      nextBefore: null,
      nextBeforeId: null,
    });
    await mount();

    const button = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Load older'),
    );
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(activityHistory).toHaveBeenLastCalledWith({
      limit: 50,
      before: 900,
      beforeId: 'span-1',
    });
    await expandAll();
    expect(container.querySelectorAll('.activity-subevent')).toHaveLength(2);
  });
});

describe('Activity — scope comes from the route', () => {
  it('asks for and subscribes to one agent at /p/:personalityId/activity', async () => {
    routeParams = { personalityId: 'agent-a' };
    await mount();

    expect(activityHistory).toHaveBeenCalledWith({ personalityId: 'agent-a', limit: 50 });
    expect(sessionsList).toHaveBeenCalledWith({ personalityId: 'agent-a', limit: 50 });
    expect(subscribeToActivity.mock.calls[0]?.[0]).toBe('agent-a');
  });

  it('asks for every agent at the bare /activity', async () => {
    await mount();

    expect(activityHistory).toHaveBeenCalledWith({ limit: 50 });
    expect(sessionsList).toHaveBeenCalledWith({ limit: 50 });
    expect(subscribeToActivity.mock.calls[0]?.[0]).toBeNull();
  });

  it('opens exactly one live connection and keeps it across re-renders', async () => {
    sessionsList.mockResolvedValue({
      items: [{ id: 'sess-a', title: 'first' }],
      nextCursor: null,
    });
    await mount();
    expect(subscribeToActivity).toHaveBeenCalledTimes(1);

    // The old page listed the `sessions.list` result array in the subscription
    // effect's dependencies, so any re-render that re-derived it tore the
    // EventSource down and reopened it — losing every event in the gap. Drive
    // re-renders (filter chips, a live frame, an expand) and the connection
    // must survive all of them.
    const chips = [...container.querySelectorAll('.activity-filter-chip')];
    for (const chip of chips) {
      await act(async () => {
        chip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    }
    await act(async () => {
      emit?.(
        {
          sessionId: 'sess-a',
          personalityId: 'agent-a',
          event: { type: 'notification', message: 'hi' },
        },
        3,
      );
    });
    await flush();

    expect(subscribeToActivity).toHaveBeenCalledTimes(1);
  });
});

describe('Activity — live stream', () => {
  it('renders a row for a live event', async () => {
    await mount();

    await act(async () => {
      emit?.(
        {
          sessionId: 'sess-a',
          personalityId: 'agent-a',
          event: { type: 'memory.captured', summary: 'user prefers pnpm' },
        },
        1,
      );
    });
    await expandAll();

    expect(container.textContent).toContain('Remembered: user prefers pnpm');
  });

  it('draws a tool call present in BOTH history and the live stream once', async () => {
    activityHistory.mockResolvedValue({
      items: [toolSpan()],
      nextBefore: null,
      nextBeforeId: null,
    });
    await mount();

    await act(async () => {
      emit?.(
        {
          sessionId: 'sess-a',
          personalityId: 'agent-a',
          event: { type: 'tool_start', toolCallId: 'tc1', toolName: 'read_file', args: {} },
        },
        1,
      );
      emit?.(
        {
          sessionId: 'sess-a',
          personalityId: 'agent-a',
          event: {
            type: 'tool_end',
            toolCallId: 'tc1',
            toolName: 'read_file',
            ok: true,
            durationMs: 120,
          },
        },
        2,
      );
    });
    await expandAll();

    expect(container.querySelectorAll('.activity-group')).toHaveLength(1);
    expect(container.querySelectorAll('.activity-subevent')).toHaveLength(1);
  });

  it('resumes a remount of the SAME scope from the last seen seq', async () => {
    routeParams = { personalityId: 'agent-a' };
    await mount();
    expect(subscribeToActivity.mock.calls[0]?.[1]?.sinceSeq).toBe(0);

    await act(async () => {
      emit?.(
        {
          sessionId: 'sess-a',
          personalityId: 'agent-a',
          event: { type: 'notification', message: 'hi' },
        },
        7,
      );
    });

    await remount();

    expect(subscribeToActivity).toHaveBeenCalledTimes(2);
    expect(subscribeToActivity.mock.calls[1]?.[1]?.sinceSeq).toBe(7);
  });

  it("never resumes one scope from another scope's cursor", async () => {
    // The server filters in this order: `SessionStreamBuffer.replay` drops
    // everything at or below `sinceSeq`, and only THEN does `subscribeActivity`
    // apply the personality filter. So a seq agent-a advanced past may still
    // hold agent-b frames this client has never been handed — carrying one
    // cursor across scopes skips them for good, and the live-only event types
    // are not in `activity.history` to recover from.
    routeParams = { personalityId: 'agent-a' };
    await mount();

    await act(async () => {
      emit?.(
        {
          sessionId: 'sess-a',
          personalityId: 'agent-a',
          event: { type: 'notification', message: 'from a' },
        },
        9,
      );
    });

    routeParams = { personalityId: 'agent-b' };
    await remount();
    expect(subscribeToActivity.mock.calls[1]?.[0]).toBe('agent-b');
    expect(subscribeToActivity.mock.calls[1]?.[1]?.sinceSeq).toBe(0);

    await act(async () => {
      emit?.(
        {
          sessionId: 'sess-b',
          personalityId: 'agent-b',
          event: { type: 'notification', message: 'from b' },
        },
        11,
      );
    });

    // Back to agent-a: its own cursor, not agent-b's.
    routeParams = { personalityId: 'agent-a' };
    await remount();
    expect(subscribeToActivity.mock.calls[2]?.[0]).toBe('agent-a');
    expect(subscribeToActivity.mock.calls[2]?.[1]?.sinceSeq).toBe(9);
  });
});
