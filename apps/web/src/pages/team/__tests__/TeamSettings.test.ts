// @vitest-environment jsdom
//
// The team Settings pane (teams-as-a-scope §8, D13): the manifest source
// verbatim, the runtime block, the restart guard from config, and the two
// CLI commands as copyable code.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDomShims, TEAM } from './fixtures';

installDomShims();

const teamsGet = vi.fn();
const configGet = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: {
    teams: { get: (...args: unknown[]) => teamsGet(...args) },
    config: { get: (...args: unknown[]) => configGet(...args) },
  },
}));

const { TeamSettings } = await import('../TeamSettings');

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          { initialEntries: ['/t/marketing/settings'] },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: '/t/:teamId/settings',
              element: createElement(TeamSettings),
            }),
          ),
        ),
      ),
    );
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  teamsGet.mockResolvedValue(TEAM);
  configGet.mockResolvedValue({
    teamSupervisorRestartLoopGuard: { maxRestarts: 3, windowSeconds: 600 },
  });
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

describe('TeamSettings', () => {
  it('shows the manifest source, the runtime block and the start/stop commands', async () => {
    await mount();
    expect(container.querySelector('.team-settings-manifest')?.textContent).toBe(TEAM.manifestYaml);
    expect(container.textContent).toContain('~/.ethos/teams/marketing.yaml');
    expect(container.textContent).toMatch(/running · pid 48211 · up \d/);
    expect(container.textContent).toContain('3 of 4');
    expect(container.textContent).toContain('3 restarts / 600s');
    const codes = [...container.querySelectorAll('code')].map((c) => c.textContent);
    expect(codes).toEqual(['ethos team start marketing', 'ethos team stop marketing']);
    const disabled = [...container.querySelectorAll<HTMLButtonElement>('button[disabled]')].map(
      (b) => b.textContent?.trim(),
    );
    expect(disabled).toEqual(['Add member', 'Retire team']);
  });

  it('reads stopped when there is no runtime file', async () => {
    teamsGet.mockResolvedValue({ ...TEAM, health: 'stopped', runtime: null, startedAt: null });
    await mount();
    expect(container.textContent).toContain('stopped');
    expect(container.textContent).not.toContain('pid');
  });
});
