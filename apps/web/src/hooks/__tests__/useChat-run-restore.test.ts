// @vitest-environment jsdom
import type { SseEvent } from '@ethosagent/web-contracts';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantTurn, ChatState } from '../../lib/chat-reducer';

// The ONE wiring test in apps/web, and it is here on purpose.
//
// pi-delegation D9 rules web state is tested as reducers, not components — and
// that is exactly what let the run card ship broken: `chat-reducer`'s
// `run.update` case is correct in isolation, `MessageBubble`'s `run` case is
// correct in isolation, and the card still never appeared in a live browser,
// because the digest that plants the anchor is live-only and a page that
// mounts mid-run receives none of it. No pure-reducer test can catch "the hook
// never got the event": the missing piece is between the pieces.
//
// So this file drives the real `useChat` against a mocked SSE source and a
// mocked RPC client, in jsdom, and asserts the state a mid-run mount ends up
// in. It renders no component tree beyond a harness that returns null — this
// is a HOOK test, not the component-test suite D9 declined.

const sessionsGet = vi.fn();
const tasksList = vi.fn();
/** Push an event to whatever `useChat` subscribed with. */
let emit: ((event: SseEvent) => void) | null = null;

vi.mock('../../rpc', () => ({
  rpc: {
    sessions: { get: (...args: unknown[]) => sessionsGet(...args) },
    tasks: { list: (...args: unknown[]) => tasksList(...args) },
  },
}));

vi.mock('../../sse', () => ({
  subscribeToSession: (_id: string, opts: { onEvent: (event: SseEvent) => void }) => {
    emit = opts.onEvent;
    return { close: () => undefined, lastSeq: 0 };
  },
}));

const { useChat } = await import('../useChat');

const SESSION_ID = 'sess-1';
const SESSION_KEY = 'web:sess-1';

function sessionResponse(messages: unknown[]) {
  return {
    session: { id: SESSION_ID, key: SESSION_KEY },
    messages,
    cards: [],
  };
}

/** One `tasks.list` row. Only the fields the restore path reads are real. */
function jobRow(over: Record<string, unknown>) {
  return {
    id: 'job-1',
    status: 'running',
    label: 'task',
    personalityId: null,
    spendUsd: 0.25,
    maxCostUsd: 2,
    depth: 1,
    createdAt: 1_000,
    startedAt: 2_000,
    finishedAt: null,
    heartbeatAt: null,
    owner: 'host',
    rootSessionKey: SESSION_KEY,
    parentSessionKey: SESSION_KEY,
    runner: 'pi',
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;
let latest: ChatState | null = null;

function Harness() {
  latest = useChat({ initialSessionId: SESSION_ID, personalityId: 'test' }).state;
  return null;
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(Harness));
  });
}

/** Every run anchor in the transcript, live turn included. */
function anchors(state: ChatState): Array<{ jobId: string; runner: string }> {
  const turns: AssistantTurn[] = [
    ...state.messages.filter((m): m is AssistantTurn => m.role === 'assistant'),
    ...(state.currentTurn ? [state.currentTurn] : []),
  ];
  return turns.flatMap((t) =>
    t.blocks.flatMap((b) => (b.kind === 'run' ? [{ jobId: b.jobId, runner: b.runner }] : [])),
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  emit = null;
  sessionsGet.mockReset();
  tasksList.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('useChat — rediscovering a run the page was not connected for', () => {
  it('anchors an already-running delegated job on mount, with no run.update at all', async () => {
    sessionsGet.mockResolvedValue(
      sessionResponse([
        { id: 'm1', role: 'user', content: 'delegate this', timestamp: 1 },
        { id: 'm2', role: 'assistant', content: 'on it', timestamp: 2 },
      ]),
    );
    tasksList.mockResolvedValue([jobRow({})]);

    await mount();

    // This is the whole bug: not one `run.update` was delivered, because the
    // run's digests were published before this page existed.
    expect(emit).not.toBeNull();

    const state = latest;
    expect(state).not.toBeNull();
    if (!state) return;
    expect(tasksList).toHaveBeenCalledWith({ rootSessionKey: SESSION_KEY });
    expect(anchors(state)).toEqual([{ jobId: 'job-1', runner: 'pi' }]);
    expect(state.runs.byId['job-1']?.status).toBe('running');
    expect(state.runs.byId['job-1']?.spendUsd).toBe(0.25);
  });

  it('does not anchor a run that already finished — its hand-back is in history', async () => {
    sessionsGet.mockResolvedValue(sessionResponse([]));
    tasksList.mockResolvedValue([jobRow({ status: 'done', finishedAt: 9_000 })]);

    await mount();

    const state = latest;
    if (!state) throw new Error('not mounted');
    expect(anchors(state)).toEqual([]);
    expect(state.runs.order).toEqual([]);
  });

  it('a later live digest updates the restored run instead of anchoring it twice', async () => {
    sessionsGet.mockResolvedValue(
      sessionResponse([{ id: 'm1', role: 'assistant', content: 'on it', timestamp: 2 }]),
    );
    tasksList.mockResolvedValue([jobRow({})]);

    await mount();
    expect(anchors(latest as ChatState)).toHaveLength(1);

    await act(async () => {
      emit?.({
        type: 'run.update',
        jobId: 'job-1',
        runner: 'pi',
        status: 'blocked',
        now: 'waiting on you',
        elapsedMs: 42_000,
        spendUsd: 0.4,
        toolCount: 7,
      });
    });

    const state = latest;
    if (!state) throw new Error('not mounted');
    expect(anchors(state)).toEqual([{ jobId: 'job-1', runner: 'pi' }]);
    expect(state.runs.byId['job-1']?.status).toBe('blocked');
    expect(state.runs.byId['job-1']?.toolCount).toBe(7);
  });

  it('still anchors a run whose first digest arrives live, with nothing to restore', async () => {
    sessionsGet.mockResolvedValue(sessionResponse([]));
    tasksList.mockResolvedValue([]);

    await mount();

    await act(async () => {
      emit?.({
        type: 'run.update',
        jobId: 'job-2',
        runner: 'pi',
        status: 'queued',
        now: '',
        elapsedMs: 0,
        spendUsd: 0,
        toolCount: 0,
      });
    });

    const state = latest;
    if (!state) throw new Error('not mounted');
    expect(anchors(state)).toEqual([{ jobId: 'job-2', runner: 'pi' }]);
  });

  it('leaves the transcript alone when the catch-up read fails', async () => {
    sessionsGet.mockResolvedValue(
      sessionResponse([{ id: 'm1', role: 'assistant', content: 'on it', timestamp: 2 }]),
    );
    tasksList.mockRejectedValue(new Error('offline'));

    await mount();

    const state = latest;
    if (!state) throw new Error('not mounted');
    expect(anchors(state)).toEqual([]);
    expect(state.messages).toHaveLength(1);
  });
});
