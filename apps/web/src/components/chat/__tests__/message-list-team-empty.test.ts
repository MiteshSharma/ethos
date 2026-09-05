// @vitest-environment jsdom
//
// The team Chat pane's empty state (plan/phases/teams-as-a-scope.md §8): the
// team's ring and name, who answers, and four team-shaped pills that pre-fill
// the composer exactly as the per-personality ones do.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageList } from '../MessageList';

vi.mock('../../../features/renderers/resolver', () => ({
  useFenceResolver: () => () => null,
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const TEAM_PILLS = [
  'Who is on what right now?',
  'What needs me?',
  'What did we decide this week?',
  "Give me today's summary",
];

describe('MessageList — team empty state', () => {
  it('shows the ring, the team, who answers, and the four team pills', async () => {
    const onSuggestPrompt = vi.fn();
    await act(async () => {
      root.render(
        createElement(MessageList, {
          messages: [],
          currentTurn: null,
          personalityId: 'cmo',
          onSuggestPrompt,
          teamContext: {
            teamName: 'Marketing',
            accents: ['#4A9EFF', '#7C5CFF'],
            coordinatorName: 'Cmo',
          },
        }),
      );
    });

    const empty = container.querySelector('.team-chat-empty');
    expect(empty).not.toBeNull();
    expect(empty?.querySelector('svg[role="img"]')?.getAttribute('aria-label')).toBe('Marketing');
    expect(empty?.querySelector('.empty-state-name')?.textContent).toBe('Marketing');
    expect(empty?.querySelector('.empty-state-model')?.textContent).toBe(
      'Cmo answers for the team',
    );
    expect(empty?.querySelector('.empty-state-tagline')?.textContent).toBe('Ready.');

    const pills = [...(empty?.querySelectorAll('.empty-state-pill') ?? [])];
    expect(pills.map((p) => p.textContent)).toEqual(TEAM_PILLS);
    // No per-personality pill leaks in, and there is no "Try voice" here.
    expect(container.textContent).not.toContain('Explore a topic');

    await act(async () => {
      pills[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSuggestPrompt).toHaveBeenCalledWith('What needs me?');
  });

  it('keeps the personality empty state when there is no team context', async () => {
    await act(async () => {
      root.render(
        createElement(MessageList, { messages: [], currentTurn: null, personalityId: 'cmo' }),
      );
    });
    expect(container.querySelector('.team-chat-empty')).toBeNull();
    expect(container.textContent).toContain('Explore a topic');
  });
});
