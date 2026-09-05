// @vitest-environment jsdom
//
// The team Channels pane (teams-as-a-scope §8): a manifest channel joined
// with the gateway's bot list by botKey, and the empty state when nothing
// is bound.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDomShims, TEAM } from './fixtures';

installDomShims();

const teamsGet = vi.fn();
const botsListTelegram = vi.fn();
const botsListSlack = vi.fn();
const botsListWhatsApp = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: {
    teams: { get: (...args: unknown[]) => teamsGet(...args) },
    platforms: {
      botsListTelegram: (...args: unknown[]) => botsListTelegram(...args),
      botsListSlack: (...args: unknown[]) => botsListSlack(...args),
      botsListWhatsApp: (...args: unknown[]) => botsListWhatsApp(...args),
    },
  },
}));

const { TeamChannels } = await import('../TeamChannels');

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
          { initialEntries: ['/t/marketing/channels'] },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: '/t/:teamId/channels',
              element: createElement(TeamChannels),
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
  botsListTelegram.mockResolvedValue({ bots: [] });
  botsListSlack.mockResolvedValue({
    bots: [
      {
        botKey: 'slack:marketing',
        botTokenConfigured: true,
        appTokenConfigured: true,
        signingSecretConfigured: true,
        bind: { type: 'team', name: 'marketing' },
      },
    ],
  });
  botsListWhatsApp.mockRejectedValue(new Error('whatsapp not configured'));
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

describe('TeamChannels', () => {
  it('renders one row per manifest channel with the bot status and the coordinator', async () => {
    await mount();
    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(1);
    const cells = [...(rows[0]?.querySelectorAll('td') ?? [])].map((td) => td.textContent?.trim());
    expect(cells).toEqual(['slack', 'slack:marketing', 'team', 'cmo', 'configured']);
    expect(rows[0]?.querySelector('.team-dot-ok')).toBeTruthy();
    expect(container.querySelector('a[href="/communications"]')?.textContent).toContain(
      'Bind channel',
    );
  });

  it('shows a dash when the config has no bot for the botKey', async () => {
    botsListSlack.mockResolvedValue({ bots: [] });
    await mount();
    const cells = [...container.querySelectorAll('tbody td')].map((td) => td.textContent?.trim());
    expect(cells[4]).toBe('—');
  });

  it('shows the empty state when no channel is bound', async () => {
    teamsGet.mockResolvedValue({ ...TEAM, channels: [] });
    await mount();
    expect(container.querySelector('table')).toBeNull();
    expect(container.textContent).toContain('No channel is bound to this team.');
  });
});
