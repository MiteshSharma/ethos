// @vitest-environment jsdom
//
// The Structure pane (teams-as-a-scope §6, D7) driven through the real page
// under a MemoryRouter: every node for a four-member team, selection from
// `?node=`, a double-click on a member entering its workspace, and the live
// edge labels.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOARD,
  installDomShims,
  LEDGER,
  PERSONALITIES,
  TEAM,
} from '../../../../pages/team/__tests__/fixtures';

installDomShims();

const teamsGet = vi.fn();
const getBoard = vi.fn();
const personalitiesList = vi.fn();
const ledger = vi.fn();

vi.mock('../../../../rpc', () => ({
  rpc: {
    teams: {
      get: (...args: unknown[]) => teamsGet(...args),
      ledger: (...args: unknown[]) => ledger(...args),
    },
    kanban: { getBoard: (...args: unknown[]) => getBoard(...args) },
    personalities: { list: (...args: unknown[]) => personalitiesList(...args) },
  },
}));

const { TeamStructure } = await import('../../../../pages/team/TeamStructure');

function Probe() {
  const { pathname, search } = useLocation();
  return createElement('div', { id: 'probe' }, `${pathname}${search}`);
}

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(url: string): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          { initialEntries: [url] },
          createElement(Probe),
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: '/t/:teamId/structure',
              element: createElement(TeamStructure),
            }),
            createElement(Route, { path: '*', element: null }),
          ),
        ),
      ),
    );
  });
  await flush();
}

function node(id: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(`button[data-node="${id}"]`);
  if (!el) throw new Error(`No node "${id}". Saw: ${container.innerHTML.slice(0, 400)}`);
  return el;
}

beforeEach(() => {
  vi.clearAllMocks();
  teamsGet.mockResolvedValue(TEAM);
  getBoard.mockResolvedValue({ board: BOARD });
  personalitiesList.mockResolvedValue(PERSONALITIES);
  ledger.mockResolvedValue({ items: LEDGER });
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

describe('TeamStructure canvas', () => {
  it('renders every agent and system node for a four-member team with a channel', async () => {
    await mount('/t/marketing/structure');
    for (const id of [
      'cmo',
      'reddit-scout',
      'linkedin-scout',
      'x-scout',
      'board',
      'memory',
      'channel',
    ]) {
      expect(node(id)).toBeTruthy();
    }
    expect(container.querySelectorAll('button[data-node]')).toHaveLength(7);
    // Agent nodes carry the cross-highlight hook (D12); system nodes do not.
    expect(node('cmo').dataset.p).toBe('cmo');
    expect(node('board').dataset.p).toBeUndefined();
    // Nodes sit at the layout's coordinates.
    expect(node('cmo').style.left).not.toBe('');
    expect(container.querySelector('.team-canvas-hint')?.textContent).toContain('double-click');
  });

  it('selects the coordinator by default and honours ?node=', async () => {
    await mount('/t/marketing/structure');
    expect(node('cmo').classList.contains('team-node-sel')).toBe(true);
    expect(container.querySelector('[data-testid="coordinator-note"]')).toBeTruthy();

    await act(async () => {
      node('x-scout').click();
    });
    await flush();
    expect(node('x-scout').classList.contains('team-node-sel')).toBe(true);
    expect(node('cmo').classList.contains('team-node-sel')).toBe(false);
    expect(container.querySelector('#probe')?.textContent).toBe(
      '/t/marketing/structure?node=x-scout',
    );
  });

  it('opens a system sheet from ?node=memory', async () => {
    await mount('/t/marketing/structure?node=memory');
    expect(node('memory').classList.contains('team-node-sel')).toBe(true);
    const side = container.querySelector('.team-side');
    expect(side?.textContent).toContain('Team memory');
    expect(side?.textContent).toContain('onboarding.md');
  });

  it('double-clicking a member enters its workspace chat', async () => {
    await mount('/t/marketing/structure');
    await act(async () => {
      node('reddit-scout').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await flush();
    expect(container.querySelector('#probe')?.textContent).toBe('/t/marketing/p/reddit-scout/chat');
  });

  it('labels dispatch edges with the live ticket, blocked and offline states', async () => {
    await mount('/t/marketing/structure');
    const label = (id: string) =>
      container.querySelector(`[data-edge-label="${id}"] text`)?.textContent ?? '';
    expect(label('reddit-scout')).toMatch(/^#41aaaaaa · /);
    expect(label('x-scout')).toBe('offline');
    expect(label('linkedin-scout')).toBe('idle');
    const svgText = container.querySelector('svg')?.textContent ?? '';
    expect(svgText).toContain('team_memory_* · 2 topics');
    expect(svgText).toContain('board.db · coordinator');
    expect(svgText).toContain('slack:marketing → cmo');
  });

  it('marks a member whose personality directory is missing', async () => {
    await mount('/t/marketing/structure');
    expect(node('x-scout').classList.contains('team-node-missing')).toBe(true);
    expect(node('reddit-scout').classList.contains('team-node-missing')).toBe(false);
    expect(node('reddit-scout').textContent).toContain('claude-sonnet-4-6');
  });
});
