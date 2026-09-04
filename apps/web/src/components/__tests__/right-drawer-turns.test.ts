// @vitest-environment jsdom
//
// The drawer is the trail's second renderer (feedback & activity contract §4).
// It is on its OWN SSE subscription, so what it must not get wrong is the
// grouping: two turns of tool calls are two groups with their own headers, in
// the order they happened — not one flat list. The rows themselves are covered
// in `chat/__tests__/trail.test.ts`; this file drives the real component
// against state the real reducer built, so the two cannot drift.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, type DrawerStreamState, emptyDrawerState } from '../../lib/drawer-reducer';

let drawerState: DrawerStreamState = emptyDrawerState('s1');

vi.mock('../../hooks/useDrawerStream', () => ({
  useDrawerStream: () => drawerState,
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }));

const { RightDrawer } = await import('../RightDrawer');

const RUN_START = {
  type: 'run_start' as const,
  provider: 'anthropic',
  model: 'claude',
  source: 'personality' as const,
};
const NOW = 1_700_000_000_000;

/** Two turns, one tool call each — the shape the grouping has to survive. */
function twoTurns(): DrawerStreamState {
  let state = emptyDrawerState('s1');
  state = applyEvent(state, RUN_START, NOW);
  state = applyEvent(
    state,
    { type: 'tool_start', toolCallId: 'c1', toolName: 'read_file', args: { path: '/etc/hosts' } },
    NOW,
  );
  state = applyEvent(
    state,
    { type: 'tool_end', toolCallId: 'c1', toolName: 'read_file', ok: true, durationMs: 1_200 },
    NOW,
  );
  state = applyEvent(state, { type: 'done', text: 'hi', turnCount: 1 }, NOW);
  state = applyEvent(state, RUN_START, NOW);
  state = applyEvent(
    state,
    { type: 'tool_start', toolCallId: 'c2', toolName: 'bash', args: { command: 'ls' } },
    NOW,
  );
  return state;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  drawerState = emptyDrawerState('s1');
});

function render() {
  act(() => {
    root.render(createElement(RightDrawer, { open: true, onClose: () => {} }));
  });
}

describe('RightDrawer — Tool stream grouped by turn', () => {
  it('draws one header per turn, newest first', () => {
    drawerState = twoTurns();
    render();
    const headers = Array.from(container.querySelectorAll('.drawer-turn-header')).map(
      (el) => el.textContent,
    );
    expect(headers).toEqual(['just now · turn 2', 'just now · turn 1']);
  });

  it('puts each turn’s rows under its own header', () => {
    drawerState = twoTurns();
    render();
    const groups = Array.from(container.querySelectorAll('.drawer-turn')).map((group) =>
      Array.from(group.querySelectorAll('.activity-row-subject')).map((el) => el.textContent),
    );
    expect(groups).toEqual([['bash'], ['read_file']]);
  });

  it('gives every row a deterministic id derived from its turn', () => {
    drawerState = twoTurns();
    render();
    expect(container.querySelector('#trail-row-turn-1-c1')).not.toBeNull();
    expect(container.querySelector('#trail-row-turn-2-c2')).not.toBeNull();
  });

  it('reads the finished call as ✓ ok with its duration', () => {
    drawerState = twoTurns();
    render();
    const row = container.querySelector('#trail-row-turn-1-c1');
    expect(row?.textContent).toContain('✓ ok');
    expect(row?.textContent).toContain('1.2s');
  });

  it('keeps the quiet empty state until a turn has actions', () => {
    drawerState = applyEvent(emptyDrawerState('s1'), RUN_START, NOW);
    render();
    expect(container.textContent).toContain('Quiet for now.');
    expect(container.querySelector('.drawer-turn-header')).toBeNull();
  });

  it('keeps the no-session empty state', () => {
    drawerState = emptyDrawerState(null);
    render();
    expect(container.textContent).toContain('No active session.');
  });
});
