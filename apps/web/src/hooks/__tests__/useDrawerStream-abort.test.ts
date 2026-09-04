// @vitest-environment jsdom
import type { SseEvent } from '@ethosagent/web-contracts';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { broadcastTurnAborted } from '../../lib/lastSession';
import type { DrawerStreamState } from '../useDrawerStream';

// Stop never touches the wire, so the drawer's own SSE subscription cannot see
// it: it is a local `ChatAction` in `useChat`. Until the broadcast existed the
// drawer kept drawing `running` rows under a footer already reading
// `✗ stopped · N actions` — two renderers of one trail disagreeing about the
// same tool call (feedback-activity-contract §4).
//
// The reducer's half is `drawer-reducer.test.ts`; what only this file can catch
// is the hook never subscribing, or subscribing without the session guard.

/** Push an event to whatever `useDrawerStream` subscribed with. */
let emit: ((event: SseEvent) => void) | null = null;

vi.mock('../../sse', () => ({
  subscribeToSession: (_id: string, opts: { onEvent: (event: SseEvent) => void }) => {
    emit = opts.onEvent;
    return { close: () => undefined, lastSeq: 0 };
  },
}));

const { useDrawerStream } = await import('../useDrawerStream');

const SESSION_ID = 'sess-1';

let container: HTMLDivElement;
let root: Root;
let latest: DrawerStreamState | null = null;

function Harness() {
  latest = useDrawerStream();
  return null;
}

/** Mount on SESSION_ID with one tool call still running. */
async function mountWithRunningTool(): Promise<void> {
  await act(async () => {
    root.render(createElement(Harness));
  });
  await act(async () => {
    emit?.({ type: 'run_start', provider: 'anthropic', model: 'claude', source: 'personality' });
    emit?.({ type: 'tool_start', toolCallId: 'tc1', toolName: 'terminal', args: {} });
  });
}

function newestRow() {
  const turnId = latest?.turns[0]?.turnId;
  const entry = turnId === undefined ? undefined : latest?.trail[turnId]?.[0];
  return entry?.kind === 'action' ? entry : undefined;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  emit = null;
  latest = null;
  window.localStorage.setItem('ethos.lastSessionId', SESSION_ID);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  window.localStorage.clear();
});

describe('useDrawerStream — a local Stop reaches the drawer', () => {
  it('settles the open turn when the stop names this drawer’s session', async () => {
    await mountWithRunningTool();
    expect(newestRow()).toMatchObject({ status: 'running' });

    await act(async () => {
      broadcastTurnAborted(SESSION_ID);
    });

    expect(newestRow()).toMatchObject({ toolName: 'terminal', status: 'failed' });
    expect(latest?.turns[0]?.closed).toBe(true);
  });

  it('leaves the drawer untouched when the stop names another session', async () => {
    await mountWithRunningTool();
    const before = latest;

    await act(async () => {
      broadcastTurnAborted('some-other-session');
    });

    expect(latest).toBe(before); // referential equality — no churn
    expect(newestRow()).toMatchObject({ status: 'running' });
  });
});
