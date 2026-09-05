// @vitest-environment jsdom
//
// teams-as-a-scope T4 — the breadcrumb's Needs-you pill (D11): hidden at
// zero, counts `needs_revision` + `blocked`, and deep-links the Board on the
// first of them.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boardSnapshot, flush, installDomStubs, task } from '../../../pages/team/__tests__/harness';

installDomStubs();

const getBoard = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: { kanban: { getBoard: (...args: unknown[]) => getBoard(...args) } },
}));

const { NeedsYouPill } = await import('../NeedsYouPill');

let container: HTMLDivElement;
let root: Root;

async function mount(): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Number.POSITIVE_INFINITY } },
  });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MemoryRouter, null, createElement(NeedsYouPill, { teamId: 'marketing' })),
      ),
    );
  });
  await flush();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('NeedsYouPill', () => {
  it('renders nothing when no ticket needs the operator', async () => {
    getBoard.mockResolvedValue({
      board: boardSnapshot({ tasks: [task('t-run-001', 'Sweep', 'running', 'reddit-scout')] }),
    });
    await mount();
    expect(getBoard).toHaveBeenCalledWith({ team: 'marketing' });
    expect(container.querySelector('.team-needs-pill')).toBeNull();
  });

  it('counts needs_revision + blocked and links the board to the first', async () => {
    getBoard.mockResolvedValue({ board: boardSnapshot() });
    await mount();
    const pill = container.querySelector('a.team-needs-pill');
    expect(pill?.textContent).toBe('2 need you');
    expect(pill?.getAttribute('href')).toBe('/t/marketing/board?task=t-rev-001');
  });

  it('reads singular at one', async () => {
    getBoard.mockResolvedValue({
      board: boardSnapshot({ tasks: [task('t-blk-009', 'Draft', 'blocked', 'cmo')] }),
    });
    await mount();
    const pill = container.querySelector('a.team-needs-pill');
    expect(pill?.textContent).toBe('1 needs you');
    expect(pill?.getAttribute('href')).toBe('/t/marketing/board?task=t-blk-009');
  });
});
