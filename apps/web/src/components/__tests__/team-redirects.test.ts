// @vitest-environment jsdom
//
// teams-as-a-scope T1 — the route guards in `TeamRouteGuards.tsx`, driven
// through a `MemoryRouter` with a probe that prints where it landed:
// `/teams/:name` → `/t/:name/board`; a member's `/p/:id/*` → `/t/<team>/p/
// :id/*`; an independent `/p/:id/*` stays; `/t/<unknown>` → `/teams`;
// `/t/:teamId/p/<non-member>` → the team's overview; `/t/:teamId` → overview.

import type { TeamSummary } from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

const teamsList = vi.fn();
vi.mock('../../rpc', () => ({
  rpc: { teams: { list: (...args: unknown[]) => teamsList(...args) } },
}));

const { LegacyTeamRedirect, TeamHomeRedirect, TeamMemberRedirect, TeamScopeGuard } = await import(
  '../TeamRouteGuards'
);

const MARKETING: TeamSummary = {
  name: 'marketing',
  description: '',
  dispatchMode: 'coordinator',
  health: 'running',
  memberCount: 1,
  runningCount: 1,
  boardModifiedAt: null,
  coordinator: 'cmo',
  members: [
    { personalityId: 'cmo', role: 'coordinator', tier: null, status: 'running', capabilities: [] },
  ],
  channels: [],
  startedAt: null,
};

function Probe() {
  const { pathname, search } = useLocation();
  return createElement('div', { id: 'probe' }, `${pathname}${search}`);
}

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountAt(path: string): Promise<string | null> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Number.POSITIVE_INFINITY } },
  });
  const guarded = (el: React.ReactElement) => createElement(TeamScopeGuard, null, el);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          AntApp,
          null,
          createElement(
            MemoryRouter,
            { initialEntries: [path] },
            createElement(
              Routes,
              null,
              createElement(Route, {
                path: '/p/:personalityId/:pane',
                element: createElement(TeamMemberRedirect, null, createElement(Probe)),
              }),
              createElement(Route, {
                path: '/t/:teamId',
                element: createElement(TeamHomeRedirect),
              }),
              createElement(Route, {
                path: '/t/:teamId/:pane',
                element: guarded(createElement(Probe)),
              }),
              createElement(Route, {
                path: '/t/:teamId/p/:personalityId/:pane',
                element: guarded(createElement(Probe)),
              }),
              createElement(Route, { path: '/teams', element: createElement(Probe) }),
              createElement(Route, {
                path: '/teams/:name',
                element: createElement(LegacyTeamRedirect),
              }),
            ),
          ),
        ),
      ),
    );
  });
  await flush();
  return container.querySelector('#probe')?.textContent ?? null;
}

beforeEach(() => {
  teamsList.mockResolvedValue({ items: [MARKETING] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('team route guards', () => {
  it('/teams/:name → /t/:name/board, keeping the query string', async () => {
    expect(await mountAt('/teams/marketing?x=1')).toBe('/t/marketing/board?x=1');
  });

  it('/t/:teamId → /t/:teamId/overview', async () => {
    expect(await mountAt('/t/marketing')).toBe('/t/marketing/overview');
  });

  it("a member's /p/ workspace redirects under the team prefix, pane and query intact", async () => {
    expect(await mountAt('/p/cmo/memory?session=s1')).toBe('/t/marketing/p/cmo/memory?session=s1');
  });

  it('an independent /p/ workspace passes through', async () => {
    expect(await mountAt('/p/researcher/memory')).toBe('/p/researcher/memory');
  });

  it('passes /p/ through when teams.list fails', async () => {
    teamsList.mockRejectedValue(new Error('down'));
    expect(await mountAt('/p/cmo/memory')).toBe('/p/cmo/memory');
  });

  it('renders nothing for /p/ until teams.list has answered', async () => {
    teamsList.mockReturnValue(new Promise(() => {}));
    expect(await mountAt('/p/cmo/memory')).toBeNull();
  });

  it('/t/<unknown>/… → /teams', async () => {
    expect(await mountAt('/t/nope/overview')).toBe('/teams');
  });

  it('/t/:teamId/p/<non-member>/… → the team overview', async () => {
    expect(await mountAt('/t/marketing/p/researcher/chat')).toBe('/t/marketing/overview');
  });

  it('a member workspace and a team pane pass through', async () => {
    expect(await mountAt('/t/marketing/p/cmo/chat')).toBe('/t/marketing/p/cmo/chat');
    await act(async () => root.unmount());
    root = createRoot(container);
    expect(await mountAt('/t/marketing/board')).toBe('/t/marketing/board');
  });
});
