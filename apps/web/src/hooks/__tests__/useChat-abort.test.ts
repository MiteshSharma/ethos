// @vitest-environment jsdom
import type { SseEvent } from '@ethosagent/web-contracts';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TURN_ABORTED_EVENT, turnAbortedSessionId } from '../../lib/lastSession';
import type { UseChatResult } from '../useChat';

// Stop is dispatched locally BEFORE the abort RPC — immediate acknowledgement
// is the point of the feedback & activity contract. But `abort-turn` also sets
// the durable `abortedTurn` guard, which suppresses every turn-advancing event
// until the next submission. So the two halves of the optimism have to be
// tested where they actually meet, in the hook: the RPC resolving must leave
// the guard set, and the RPC REJECTING must lift it and tell the user — or the
// surface goes permanently blind while the server keeps executing tools.
//
// The reducer's own half is `chat-reducer.test.ts` ("a Stop the server never
// heard un-blinds the stream"); what only this file can catch is the hook
// swallowing the rejection.

const sessionsGet = vi.fn();
const tasksList = vi.fn();
const clarifyListPending = vi.fn();
const chatAbort = vi.fn();
const chatSend = vi.fn();
/** Push an event to whatever `useChat` subscribed with. */
let emit: ((event: SseEvent) => void) | null = null;

vi.mock('../../rpc', () => ({
  rpc: {
    sessions: { get: (...args: unknown[]) => sessionsGet(...args) },
    tasks: { list: (...args: unknown[]) => tasksList(...args) },
    clarify: { listPending: (...args: unknown[]) => clarifyListPending(...args) },
    chat: {
      abort: (...args: unknown[]) => chatAbort(...args),
      send: (...args: unknown[]) => chatSend(...args),
    },
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

let container: HTMLDivElement;
let root: Root;
let latest: UseChatResult | null = null;

function Harness() {
  latest = useChat({ initialSessionId: SESSION_ID, personalityId: 'test' });
  return null;
}

/** Mount, then run one tool call so there is a live turn to stop. */
async function mountWithRunningTool(): Promise<UseChatResult> {
  await act(async () => {
    root.render(createElement(Harness));
  });
  await act(async () => {
    emit?.({ type: 'tool_start', toolCallId: 'tc1', toolName: 'terminal', args: {} });
  });
  const hook = latest;
  if (!hook) throw new Error('not mounted');
  return hook;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  emit = null;
  sessionsGet.mockReset();
  tasksList.mockReset();
  clarifyListPending.mockReset();
  chatAbort.mockReset();
  chatSend.mockReset();
  chatSend.mockResolvedValue({ sessionId: SESSION_ID });
  sessionsGet.mockResolvedValue({
    session: { id: SESSION_ID, key: SESSION_KEY },
    messages: [],
    cards: [],
  });
  tasksList.mockResolvedValue([]);
  clarifyListPending.mockResolvedValue([]);
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

describe('useChat — Stop is only as good as the RPC behind it', () => {
  it('keeps the turn stopped and the stream suppressed when the server agrees', async () => {
    chatAbort.mockResolvedValue({ ok: true });
    await mountWithRunningTool();

    await act(async () => {
      await latest?.abortTurn();
    });
    expect(chatAbort).toHaveBeenCalledWith({ sessionId: SESSION_ID });
    expect(latest?.state.abortedTurn).toBe(true);
    expect(latest?.state.error).toBeNull();

    // Events already on the wire for the stopped turn stay suppressed.
    await act(async () => {
      emit?.({ type: 'text_delta', text: 'zombie' });
    });
    expect(latest?.state.currentTurn).toBeNull();
  });

  it('broadcasts the stop so the right drawer settles the same rows', async () => {
    // The drawer is on its own SSE subscription and Stop is never on the wire,
    // so without this broadcast it keeps drawing `running` rows for the calls
    // `abort-turn` just settled (contract §4). `useDrawerStream` listens.
    chatAbort.mockResolvedValue({ ok: true });
    await mountWithRunningTool();
    const seen: (string | null)[] = [];
    const listen = (event: Event) => seen.push(turnAbortedSessionId(event));
    window.addEventListener(TURN_ABORTED_EVENT, listen);

    await act(async () => {
      await latest?.abortTurn();
    });
    window.removeEventListener(TURN_ABORTED_EVENT, listen);

    expect(seen).toEqual([SESSION_ID]);
  });

  it('lifts the suppression and says Stop did not take when the RPC fails', async () => {
    chatAbort.mockRejectedValue(new Error('network unreachable'));
    await mountWithRunningTool();

    await act(async () => {
      await latest?.abortTurn();
    });

    // The guard is gone, so the turn the server is STILL running becomes
    // visible again instead of being dropped for the rest of the session.
    expect(latest?.state.abortedTurn).toBe(false);
    expect(latest?.state.error).toContain('Stop did not reach the server');
    expect(latest?.state.error).toContain('network unreachable');

    await act(async () => {
      emit?.({ type: 'text_delta', text: 'still going' });
    });
    expect(latest?.state.currentTurn?.blocks).toEqual([{ kind: 'text', content: 'still going' }]);
  });
});

// Stop is not the only way a turn ends early. Sending the next question over a
// live turn closes it too — `submit-user-message` runs the same `stopTurn`, and
// the footer reads `✗ stopped · N actions`. That path is no more on the wire
// than Stop is, so it owes the drawer the same signal (contract §4).
describe('useChat — a new question over a live turn', () => {
  /** Collect the sessions named by every turn-aborted broadcast in `fn`. */
  async function broadcastsDuring(fn: () => Promise<void>): Promise<(string | null)[]> {
    const seen: (string | null)[] = [];
    const listen = (event: Event) => seen.push(turnAbortedSessionId(event));
    window.addEventListener(TURN_ABORTED_EVENT, listen);
    await act(fn);
    window.removeEventListener(TURN_ABORTED_EVENT, listen);
    return seen;
  }

  it('broadcasts the interruption so the right drawer settles the same rows', async () => {
    await mountWithRunningTool();

    const seen = await broadcastsDuring(async () => {
      await latest?.sendMessage('actually, do this instead');
    });

    expect(seen).toEqual([SESSION_ID]);
    // Not a vacuous pass: the reducer really did close the interrupted turn.
    expect(latest?.state.stoppedTurnIds).toHaveLength(1);
  });

  it('says nothing when there is no turn in flight', async () => {
    // The signal means "a turn ended early". A plain send has nothing to end,
    // and firing anyway would settle rows in a drawer bound to some other
    // session's live turn.
    await act(async () => {
      root.render(createElement(Harness));
    });

    const seen = await broadcastsDuring(async () => {
      await latest?.sendMessage('first question');
    });

    expect(seen).toEqual([]);
    expect(latest?.state.stoppedTurnIds).toEqual([]);
  });
});
