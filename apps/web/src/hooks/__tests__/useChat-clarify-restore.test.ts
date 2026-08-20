// @vitest-environment jsdom
import type { SseEvent } from '@ethosagent/web-contracts';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatState } from '../../lib/chat-reducer';
import { questionForRun, resolvedForRun } from '../../lib/clarify-queue';

// The sibling of `useChat-run-restore.test.ts`, and here for the same reason
// its header gives: D9 tests web state as reducers, and a reducer that is
// correct in isolation is exactly what shipped a run card that never appeared.
//
// This one guards the other half of the same hole. Live browser testing of a
// real Pi run found the run card correctly re-anchored after a reload and
// correctly said `NOW paused — waiting on you`, with NOTHING between the meta
// row and the detail grid: the `ClarifyCard` §4.5 draws inside the card was
// absent, so the question that parked the run could not be read or answered
// from the web at all. `clarify.request` is a live-only push, `state.clarifyQueue`
// starts empty on every mount, and nothing seeded it — the same shape of bug,
// one state slice over.
//
// So: drive the real `useChat` against a mocked RPC client where a job is
// already parked on a question, and assert the question is discoverable having
// received no SSE event whatsoever.

const sessionsGet = vi.fn();
const tasksList = vi.fn();
const clarifyListPending = vi.fn();
/** Push an event to whatever `useChat` subscribed with. */
let emit: ((event: SseEvent) => void) | null = null;

vi.mock('../../rpc', () => ({
  rpc: {
    sessions: { get: (...args: unknown[]) => sessionsGet(...args) },
    tasks: { list: (...args: unknown[]) => tasksList(...args) },
    clarify: { listPending: (...args: unknown[]) => clarifyListPending(...args) },
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
const DEADLINE = '2026-08-20T12:00:00.000Z';

function sessionResponse(messages: unknown[]) {
  return { session: { id: SESSION_ID, key: SESSION_KEY }, messages, cards: [] };
}

/** One `tasks.list` row. Only the fields the restore path reads are real. */
function jobRow(over: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    status: 'blocked',
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

/** One `clarify.listPending` row. */
function clarifyRow(over: Record<string, unknown> = {}) {
  return {
    requestId: 'req-1',
    jobId: 'job-1',
    question: 'Push the branch to origin?',
    options: ['Allow', 'Deny'],
    defaultDeadlineAt: DEADLINE,
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

function state(): ChatState {
  if (!latest) throw new Error('not mounted');
  return latest;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  emit = null;
  sessionsGet.mockReset();
  tasksList.mockReset();
  clarifyListPending.mockReset();
  sessionsGet.mockResolvedValue(
    sessionResponse([{ id: 'm1', role: 'assistant', content: 'on it', timestamp: 2 }]),
  );
  tasksList.mockResolvedValue([jobRow()]);
  clarifyListPending.mockResolvedValue([clarifyRow()]);
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

describe('useChat — rediscovering the question a run is parked on', () => {
  it('surfaces the pending question on mount, with no clarify.request at all', async () => {
    await mount();

    // The whole bug: not one `clarify.request` was delivered, because the
    // question was asked before this page existed.
    expect(emit).not.toBeNull();

    expect(clarifyListPending).toHaveBeenCalledWith({ rootSessionKey: SESSION_KEY });
    const question = questionForRun(state().clarifyQueue, 'job-1');
    expect(question?.question).toBe('Push the branch to origin?');
    expect(question?.options).toEqual(['Allow', 'Deny']);
    expect(question?.defaultDeadlineAt).toBe(DEADLINE);
    // The card the question is drawn inside has to exist too, or it renders
    // nowhere — the two restores are one feature.
    expect(state().runs.byId['job-1']?.status).toBe('blocked');
  });

  it('does not float a restored run question as a standalone card', async () => {
    await mount();

    // §4.5 draws a run's question INSIDE its card; `pendingClarifies` is the
    // foreground-clarify modal queue and must stay empty.
    expect(state().pendingClarifies).toEqual([]);
  });

  it('collapses the restored question when it resolves live', async () => {
    await mount();
    expect(questionForRun(state().clarifyQueue, 'job-1')).toBeDefined();

    await act(async () => {
      emit?.({ type: 'clarify.resolved', requestId: 'req-1', source: 'user' });
    });

    expect(questionForRun(state().clarifyQueue, 'job-1')).toBeUndefined();
    expect(resolvedForRun(state().clarifyQueue, 'job-1')?.source).toBe('user');
  });

  it('does not double-list a question the live stream also delivers', async () => {
    await mount();

    await act(async () => {
      emit?.({
        type: 'clarify.request',
        requestId: 'req-1',
        question: 'Push the branch to origin?',
        options: ['Allow', 'Deny'],
        jobId: 'job-1',
        defaultDeadlineAt: DEADLINE,
      });
    });

    expect(state().clarifyQueue.pending).toHaveLength(1);
  });

  it('skips the read entirely when the session has no live run', async () => {
    tasksList.mockResolvedValue([]);

    await mount();

    expect(clarifyListPending).not.toHaveBeenCalled();
    expect(state().clarifyQueue.pending).toEqual([]);
  });

  it('leaves the restored run alone when the question read fails', async () => {
    clarifyListPending.mockRejectedValue(new Error('offline'));

    await mount();

    expect(state().runs.byId['job-1']?.status).toBe('blocked');
    expect(state().clarifyQueue.pending).toEqual([]);
  });
});
