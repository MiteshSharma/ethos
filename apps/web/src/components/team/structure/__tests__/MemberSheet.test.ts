// @vitest-environment jsdom
//
// The member side sheet (teams-as-a-scope §6): the "same session either
// way" box appears for the coordinator only, the current ticket links into
// the board, lifetime comes from memberStats, and the ledger is filtered to
// the member.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOARD,
  installDomShims,
  LEDGER,
  PERSONALITIES,
  TEAM,
} from '../../../../pages/team/__tests__/fixtures';

installDomShims();

const ledger = vi.fn();
vi.mock('../../../../rpc', () => ({
  rpc: { teams: { ledger: (...args: unknown[]) => ledger(...args) } },
}));

const { MemberSheet } = await import('../MemberSheet');

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(personalityId: string): Promise<void> {
  const member = TEAM.members.find((m) => m.personalityId === personalityId);
  if (!member) throw new Error(`no member ${personalityId}`);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          null,
          createElement(MemberSheet, {
            team: TEAM,
            member,
            personality: PERSONALITIES.items.find((p) => p.id === personalityId),
            missing: !PERSONALITIES.items.some((p) => p.id === personalityId),
            tasks: BOARD.tasks,
            memberStats: BOARD.memberStats,
          }),
        ),
      ),
    );
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
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

describe('MemberSheet', () => {
  it('shows the coordinator box for the coordinator only, with Chat as the door', async () => {
    await mount('cmo');
    const note = container.querySelector('[data-testid="coordinator-note"]');
    expect(note?.textContent).toContain('Chatting with marketing means chatting with cmo');
    expect(container.textContent).toContain('Chat');
    expect(container.textContent).not.toContain('Enter workspace');
    expect(container.textContent).toContain('personality:cmo + team:marketing');
    expect(container.textContent).toContain('teams/marketing/**');
    expect(container.textContent).toContain('ranking, approval');
  });

  it('links the running ticket into the board and reads lifetime from memberStats', async () => {
    await mount('reddit-scout');
    expect(container.querySelector('[data-testid="coordinator-note"]')).toBeNull();
    expect(container.textContent).toContain('Enter workspace');
    const link = [...container.querySelectorAll<HTMLAnchorElement>('a.team-idlink')].find((a) =>
      a.textContent?.includes('#41aaaaaa'),
    );
    expect(link?.getAttribute('href')).toBe('/t/marketing/board?task=41aaaaaa-0000');
    expect(container.textContent).toContain('12 of 14 completed');
    expect(container.textContent).not.toMatch(/\$/);
    expect(ledger).toHaveBeenCalledWith({
      team: 'marketing',
      personalityId: 'reddit-scout',
      limit: 20,
    });
    expect(container.querySelector('.team-ev')?.textContent).toContain('Dispatch tick');
  });

  it('says so when the personality directory is missing', async () => {
    await mount('x-scout');
    expect(container.textContent).toContain('personality not found');
  });
});
