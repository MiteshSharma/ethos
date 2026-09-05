// @vitest-environment jsdom
//
// The team Chat pane (plan/phases/teams-as-a-scope.md D4, §8 "Chat") is
// wiring, not rendering: it decides WHOSE chat opens and under WHICH accent.
// The chat page itself is mocked down to the bar it would draw, so the two
// promises under test — coordinator or nothing, and the coordinator's accent
// over neutral team chrome — are checked without a websocket or a loop.

import type { TeamDetail } from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { personalityAccent } from '../../lib/theme';

const teamsGet = vi.fn();
let routeParams: { teamId?: string } = {};

vi.mock('react-router-dom', () => ({
  useParams: () => routeParams,
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) =>
    createElement('a', { href: to, ...rest }, children),
}));

vi.mock('../../rpc', () => ({
  rpc: { teams: { get: (...args: unknown[]) => teamsGet(...args) } },
}));

// The chat page stands in for itself: it draws the bar it would draw with the
// props it received, so "renders the bar variant" is asserted against the real
// `PersonalityBar`, and nothing else the page owns is mounted.
vi.mock('../Chat', async () => {
  const { PersonalityBar } = await import('../../components/chat/PersonalityBar');
  return {
    Chat: (props: { personalityId: string; teamContext: unknown }) =>
      createElement(
        'div',
        { 'data-testid': 'chat', 'data-personality': props.personalityId },
        createElement(PersonalityBar, {
          personalityId: props.personalityId,
          model: 'claude-sonnet-4',
          onNewSession: () => undefined,
          // biome-ignore lint/suspicious/noExplicitAny: the stub relays whatever the page was given
          teamContext: props.teamContext as any,
        }),
      ),
  };
});

function team(over: Partial<TeamDetail> = {}): TeamDetail {
  return {
    name: 'marketing',
    description: 'Marketing',
    dispatchMode: 'coordinator',
    coordinator: 'cmo',
    members: [
      {
        personalityId: 'cmo',
        role: 'coordinator',
        tier: 'trusted',
        status: 'running',
        capabilities: [],
      },
      {
        personalityId: 'reddit-scout',
        role: 'member',
        tier: 'standard',
        status: 'running',
        capabilities: [],
      },
    ],
    channels: [],
    startedAt: null,
    manifestYaml: '',
    manifestPath: '',
    trustPolicy: null,
    kanban: { staleMs: 0, pollMs: 0, stalenessThresholdMs: 0 },
    memoryTopics: [],
    runtime: null,
    ...over,
  } as TeamDetail;
}

let container: HTMLDivElement;
let root: Root;
let TeamChat: React.ComponentType;

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
    root.render(createElement(QueryClientProvider, { client }, createElement(TeamChat)));
  });
  await flush();
}

beforeEach(async () => {
  routeParams = { teamId: 'marketing' };
  teamsGet.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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
  ({ TeamChat } = await import('../team/TeamChat'));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('TeamChat', () => {
  it('has no chat without a coordinator — points at Structure instead', async () => {
    teamsGet.mockResolvedValue(team({ coordinator: null, dispatchMode: 'broadcast' }));
    await mount();
    expect(container.querySelector('[data-testid="chat"]')).toBeNull();
    const empty = container.querySelector('.team-chat-no-coordinator');
    expect(empty?.textContent).toContain('This team has no coordinator, so it has no chat.');
    expect(empty?.querySelector('a')?.getAttribute('href')).toBe('/t/marketing/structure');
  });

  it("opens the coordinator's chat inside team chrome, under the coordinator's accent", async () => {
    teamsGet.mockResolvedValue(team());
    await mount();
    expect(teamsGet).toHaveBeenCalledWith({ team: 'marketing' });

    const chat = container.querySelector('[data-testid="chat"]');
    expect(chat?.getAttribute('data-personality')).toBe('cmo');

    // The accent swap a workspace gets (DESIGN.md: team chrome is neutral,
    // the team Chat pane carries the coordinator's accent).
    const scope = container.querySelector<HTMLElement>('.workspace-accent-scope');
    expect(scope).not.toBeNull();
    expect(scope?.style.getPropertyValue('--accent')).toBe(personalityAccent('cmo'));
    expect(scope?.contains(chat)).toBe(true);

    // The bar variant: ring + team, `=` group, workspace link.
    const bar = container.querySelector('.personality-bar');
    expect(bar?.querySelector('.team-chat-bar-team')?.textContent).toBe('marketing');
    expect(bar?.querySelector('.team-chat-bar-role')?.textContent).toBe(
      'coordinator · claude-sonnet-4',
    );
    expect(bar?.querySelector('.team-chat-bar-link')?.getAttribute('href')).toBe(
      '/t/marketing/p/cmo/chat',
    );
  });
});
