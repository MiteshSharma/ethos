// @vitest-environment jsdom
//
// teams-as-a-scope T1 — the chrome's team branch, driven in jsdom against a
// mocked RPC client (same approach as `pages/__tests__/Mcp.test.ts`): the
// contextual column (§3), the breadcrumb's scope switcher (§2), and the
// rail's two rosters (§1/§10). What these guard is between the pieces — the
// right rows in the right order off `teams.list`, the `via` hint gone when
// the coordinator is, the back row only inside a member's workspace, the
// Library rail showing only independent agents.

import type { Personality, TeamSummary } from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewSessionModalProvider } from '../../hooks/useNewSessionModal';

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
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const teamsList = vi.fn();
const teamsGet = vi.fn();
const kanbanGetBoard = vi.fn();
const documentsList = vi.fn();
const sessionsList = vi.fn();
const personalitiesList = vi.fn();
const configGet = vi.fn();

vi.mock('../../rpc', () => ({
  rpc: {
    teams: {
      list: (...args: unknown[]) => teamsList(...args),
      get: (...args: unknown[]) => teamsGet(...args),
    },
    kanban: { getBoard: (...args: unknown[]) => kanbanGetBoard(...args) },
    documents: { list: (...args: unknown[]) => documentsList(...args) },
    sessions: { list: (...args: unknown[]) => sessionsList(...args) },
    personalities: {
      list: (...args: unknown[]) => personalitiesList(...args),
      skillsList: () => Promise.resolve({ skills: [] }),
    },
    skills: { list: () => Promise.resolve({ skills: [] }) },
    plugins: { list: () => Promise.resolve({ plugins: [], mcpServers: [] }) },
    config: { get: (...args: unknown[]) => configGet(...args) },
  },
}));

const { ScopeNav } = await import('../ScopeNav');
const { StageHeader } = await import('../StageHeader');
const { AltitudeRail } = await import('../AltitudeRail');
const { SupervisorStatus } = await import('../team/SupervisorStatus');

/** Where the router is now — `data-pathname` / `data-search` on a probe. */
function LocationProbe() {
  const { pathname, search } = useLocation();
  return createElement('span', {
    'data-testid': 'location',
    'data-pathname': pathname,
    'data-search': search,
  });
}
const probe = () => container.querySelector('[data-testid="location"]');

function team(name: string, members: string[], coordinator: string | null): TeamSummary {
  return {
    name,
    description: '',
    dispatchMode: 'coordinator',
    health: 'running',
    memberCount: members.length,
    runningCount: members.length,
    boardModifiedAt: null,
    coordinator,
    members: members.map((personalityId) => ({
      personalityId,
      role: personalityId === coordinator ? 'coordinator' : 'member',
      tier: null,
      status: 'running',
      capabilities: [],
    })),
    channels: [{ platform: 'slack', botKey: 'slack:marketing' }],
    startedAt: null,
  };
}

const MARKETING = team('marketing', ['reddit-scout', 'cmo'], 'cmo');
const DEV = team('dev', ['engineer'], null);

function personality(id: string, name: string): Personality {
  return {
    id,
    name,
    description: null,
    model: null,
    toolset: [],
    system: false,
    builtin: false,
  } as unknown as Personality;
}

const PERSONALITIES = [
  personality('researcher', 'Researcher'),
  personality('reddit-scout', 'Reddit Scout'),
  personality('cmo', 'CMO'),
  personality('engineer', 'Engineer'),
];

const SESSIONS = [
  {
    id: 's-cmo',
    title: 'rank opportunities',
    key: 'web:1',
    personalityId: 'cmo',
    updatedAt: new Date().toISOString(),
    pinned: false,
  },
  {
    id: 's-res',
    title: 'literature sweep',
    key: 'web:2',
    personalityId: 'researcher',
    updatedAt: new Date().toISOString(),
    pinned: false,
  },
];

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount<P extends object>(component: React.ComponentType<P>, path: string, props: P) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Number.POSITIVE_INFINITY } },
  });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          { initialEntries: [path] },
          createElement(
            NewSessionModalProvider,
            null,
            createElement(component, props),
            createElement(LocationProbe),
          ),
        ),
      ),
    );
  });
  await flush();
}

beforeEach(() => {
  teamsList.mockResolvedValue({ items: [MARKETING, DEV] });
  teamsGet.mockResolvedValue({ ...MARKETING, memoryTopics: ['onboarding', 'decisions', 'angles'] });
  kanbanGetBoard.mockResolvedValue({
    board: {
      team: MARKETING,
      tasks: [{ status: 'needs_revision' }, { status: 'blocked' }, { status: 'done' }],
      links: [],
      recentEvents: [],
      memberStats: [],
    },
  });
  documentsList.mockResolvedValue({
    entries: ['brand', 'opportunities', 'state', 'outcomes.md'].map((name) => ({
      name,
      path: name,
      isDir: !name.includes('.'),
      isSymlink: false,
    })),
  });
  sessionsList.mockResolvedValue({ items: SESSIONS });
  personalitiesList.mockResolvedValue({ items: PERSONALITIES, defaultId: 'researcher' });
  configGet.mockResolvedValue({ adminEnabled: false, personality: 'researcher' });
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

const navLabels = () =>
  [...container.querySelectorAll('.sidebar-nav-item .sidebar-nav-label')].map(
    (el) => el.textContent,
  );

describe('ScopeNav — team branch (§3)', () => {
  it('renders the team identity, the rows in TEAM_PANES order, the via hint, counts and the badge', async () => {
    await mount(ScopeNav, '/t/marketing/overview', {});
    expect(container.querySelector('.scope-nav-identity-label')?.textContent).toBe('marketing');
    expect(container.querySelector('.scope-nav-identity-sub')?.textContent).toBe(
      'coordinator · 2 members',
    );
    expect(navLabels()).toEqual([
      'Chat',
      'Overview',
      'Board',
      'Structure',
      'Documents',
      'Memory',
      'Activity',
      'Channels',
      'Settings',
    ]);
    expect(container.querySelector('.sidebar-nav-via')?.textContent).toBe('via cmo');
    const rows = [...container.querySelectorAll('.sidebar-nav-item')];
    const byLabel = (label: string) =>
      rows.find((r) => r.querySelector('.sidebar-nav-label')?.textContent === label);
    expect(byLabel('Board')?.querySelector('.sidebar-nav-badge')?.textContent).toBe('2');
    expect(byLabel('Structure')?.querySelector('.sidebar-nav-hint')?.textContent).toBe('2');
    expect(byLabel('Memory')?.querySelector('.sidebar-nav-hint')?.textContent).toBe('3');
    expect(documentsList).toHaveBeenCalledWith({ team: 'marketing', root: '0' });
    expect(byLabel('Documents')?.querySelector('.sidebar-nav-hint')?.textContent).toBe('4');
    expect(byLabel('Documents')?.getAttribute('href')).toBe('/t/marketing/documents');
    expect(byLabel('Channels')?.querySelector('.sidebar-nav-hint')?.textContent).toBe('1');
    expect(byLabel('Overview')?.getAttribute('href')).toBe('/t/marketing/overview');
    expect(byLabel('Overview')?.classList.contains('active')).toBe(true);
    // Every row carries a 16px stroke icon, none an emoji.
    for (const r of rows) {
      expect(r.querySelector('svg')).not.toBeNull();
      expect(r.querySelector('.nav-icon')).toBeNull();
    }
    expect(container.querySelector('.scope-nav-back')).toBeNull();
  });

  it('hides the Chat row when the team has no coordinator', async () => {
    await mount(ScopeNav, '/t/dev/overview', {});
    expect(navLabels()[0]).toBe('Overview');
    expect(container.querySelector('.sidebar-nav-via')).toBeNull();
  });

  it('`+ New session` opens the team chat fresh, straight past the picker', async () => {
    await mount(ScopeNav, '/t/marketing/overview', {});
    const btn = container.querySelector<HTMLButtonElement>('.sidebar-new-btn');
    expect(btn?.textContent).toBe('+ New session');
    await act(async () => {
      btn?.click();
    });
    await flush();
    expect(probe()?.getAttribute('data-pathname')).toBe('/t/marketing/chat');
    expect(probe()?.getAttribute('data-search')).toBe('?new=1');
  });

  it('has no `+ New session` when the team has no coordinator', async () => {
    await mount(ScopeNav, '/t/dev/overview', {});
    expect(container.querySelector('.sidebar-new-btn')).toBeNull();
  });

  it('shows RECENT IN <TEAM>, filtered to members, opening under the team prefix', async () => {
    await mount(ScopeNav, '/t/marketing/overview', {});
    const label = [...container.querySelectorAll('.sidebar-section-label')].find((el) =>
      el.textContent?.startsWith('RECENT IN'),
    );
    expect(label?.textContent).toContain('RECENT IN MARKETING');
    const links = [...container.querySelectorAll('.sidebar-session-row')].map((a) =>
      a.getAttribute('href'),
    );
    expect(links).toEqual(['/t/marketing/p/cmo/chat?session=s-cmo']);
  });
});

describe('ScopeNav — a member workspace inside a team (D6)', () => {
  it('adds the back row and prefixes every workspace row with the team', async () => {
    await mount(ScopeNav, '/t/marketing/p/cmo/chat', {});
    const back = container.querySelector('.scope-nav-back');
    expect(back?.textContent).toBe('← marketing');
    expect(back?.getAttribute('href')).toBe('/t/marketing/overview');
    expect(container.querySelector('.scope-nav-identity-label')?.textContent).toBe('CMO');
    const hrefs = [...container.querySelectorAll('.sidebar-nav-item')].map((a) =>
      a.getAttribute('href'),
    );
    expect(hrefs[0]).toBe('/t/marketing/p/cmo/chat');
    expect(hrefs.every((h) => h?.startsWith('/t/marketing/p/cmo/'))).toBe(true);
    expect(hrefs).toHaveLength(12);
  });

  it('keeps the generic `+ New session` picker inside a member workspace', async () => {
    await mount(ScopeNav, '/t/marketing/p/cmo/chat', {});
    const btn = container.querySelector<HTMLButtonElement>('.sidebar-new-btn');
    expect(btn).not.toBeNull();
    await act(async () => {
      btn?.click();
    });
    await flush();
    // The picker opens; the router does not move.
    expect(probe()?.getAttribute('data-pathname')).toBe('/t/marketing/p/cmo/chat');
  });

  it('has no back row in an independent workspace', async () => {
    await mount(ScopeNav, '/p/researcher/chat', {});
    expect(container.querySelector('.scope-nav-back')).toBeNull();
    expect(container.querySelector('.sidebar-nav-item')?.getAttribute('href')).toBe(
      '/p/researcher/chat',
    );
  });
});

describe('StageHeader — the scope switcher (§2)', () => {
  it('reads Independent at the Library and opens Independent · teams · New team', async () => {
    await mount(StageHeader, '/personalities', {});
    const btn = container.querySelector<HTMLButtonElement>('.stage-header-scope-btn');
    expect(btn?.textContent).toContain('Independent');
    expect(container.querySelector('.stage-header-pane')?.textContent).toBe('Personalities');
    await act(async () => {
      btn?.click();
    });
    await flush();
    const menu = document.body.querySelector('.scope-switcher');
    expect(menu).not.toBeNull();
    const titles = [...(menu?.querySelectorAll('.ant-dropdown-menu-item-group-title') ?? [])].map(
      (el) => el.textContent,
    );
    expect(titles).toEqual(['SCOPE', 'TEAMS']);
    const rows = [...(menu?.querySelectorAll('.scope-switcher-row') ?? [])].map(
      (el) => el.textContent,
    );
    expect(rows[0]).toContain('Independent');
    expect(rows[0]).toContain('personalities in no team');
    // researcher is the one selectable agent in no team.
    expect(rows[0]).toContain('1');
    expect(rows[1]).toContain('marketing');
    expect(rows[1]).toContain('coordinator · 2 working');
    expect(rows[2]).toContain('dev');
    expect(rows[3]).toContain('New team');
    expect(
      menu?.querySelector('.scope-switcher-active .scope-switcher-row')?.textContent,
    ).toContain('Independent');
  });

  it('reads the team name inside a team and marks its row active; the pane is the last crumb', async () => {
    await mount(StageHeader, '/t/marketing/board', {});
    const btn = container.querySelector<HTMLButtonElement>('.stage-header-scope-btn');
    expect(btn?.textContent).toContain('marketing');
    expect(btn?.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('.stage-header-pane')?.textContent).toBe('Board');
    expect(container.querySelector('.stage-header-scope')).toBeNull();
    await act(async () => {
      btn?.click();
    });
    await flush();
    expect(
      document.body.querySelector('.scope-switcher-active .scope-switcher-row')?.textContent,
    ).toContain('marketing');
  });

  it('keeps the team as root and puts the member in the middle inside a team workspace', async () => {
    await mount(StageHeader, '/t/marketing/p/cmo/memory', {});
    expect(container.querySelector('.stage-header-scope-btn')?.textContent).toContain('marketing');
    const agent = container.querySelector('a.stage-header-scope');
    expect(agent?.textContent).toBe('CMO');
    expect(agent?.getAttribute('href')).toBe('/t/marketing/p/cmo/chat');
    expect(container.querySelector('.stage-header-pane')?.textContent).toBe('Memory');
  });

  it('reads Independent / <agent> / <pane> in an independent workspace', async () => {
    await mount(StageHeader, '/p/researcher/skills', {});
    expect(container.querySelector('.stage-header-scope-btn')?.textContent).toContain(
      'Independent',
    );
    expect(container.querySelector('a.stage-header-scope')?.textContent).toBe('Researcher');
    expect(container.querySelector('.stage-header-pane')?.textContent).toBe('Skills');
  });
});

describe('SupervisorStatus — the breadcrumb right slot at the team altitude', () => {
  it('reads `supervisor running · up <duration>` with the live ok dot', async () => {
    const now = Date.now();
    teamsGet.mockResolvedValue({
      ...MARKETING,
      startedAt: new Date(now - (6 * 3600 + 12 * 60) * 1000).toISOString(),
    });
    await mount(SupervisorStatus, '/t/marketing/board', { teamId: 'marketing', now });
    const el = container.querySelector('.team-supervisor-status');
    expect(el?.textContent).toBe('supervisor running · up 6h 12m');
    expect(el?.classList.contains('team-mono')).toBe(true);
    expect(el?.querySelector('.team-dot')?.className).toBe('team-dot team-dot-ok team-dot-live');
  });

  it('reads `supervisor stopped` with the tertiary dot when not running', async () => {
    teamsGet.mockResolvedValue({ ...MARKETING, health: 'stopped' });
    await mount(SupervisorStatus, '/t/marketing/board', { teamId: 'marketing' });
    const el = container.querySelector('.team-supervisor-status');
    expect(el?.textContent).toBe('supervisor stopped');
    expect(el?.querySelector('.team-dot')?.className).toBe('team-dot team-dot-dim');
  });
});

describe('AltitudeRail — rosters (§1, §10)', () => {
  const railLabels = () =>
    [...container.querySelectorAll('.altitude-rail a')].map((a) => a.getAttribute('aria-label'));

  it('shows only independent agents at the Library altitude', async () => {
    await mount(AltitudeRail, '/personalities', { onOpenQuickCreate: () => {} });
    expect(railLabels()).toEqual(['Library', 'Researcher']);
  });

  it('shows the full roster while teams.list has not answered', async () => {
    teamsList.mockReturnValue(new Promise(() => {}));
    await mount(AltitudeRail, '/personalities', { onOpenQuickCreate: () => {} });
    expect(railLabels()).toEqual(['Library', 'Researcher', 'Reddit Scout', 'CMO', 'Engineer']);
  });

  it('inside a team: ring home, coordinator first with the lead marker, + disabled', async () => {
    await mount(AltitudeRail, '/t/marketing/p/reddit-scout/memory', {
      onOpenQuickCreate: () => {},
    });
    expect(railLabels()).toEqual(['marketing home', 'CMO (coordinator)', 'Reddit Scout']);
    const links = [...container.querySelectorAll<HTMLAnchorElement>('.altitude-rail a')];
    expect(links[0]?.getAttribute('href')).toBe('/t/marketing/overview');
    expect(links[0]?.classList.contains('active')).toBe(false);
    expect(links[1]?.classList.contains('lead')).toBe(true);
    expect(links[1]?.getAttribute('href')).toBe('/t/marketing/p/cmo/memory');
    expect(links[2]?.classList.contains('active')).toBe(true);
    const plus = container.querySelector<HTMLButtonElement>('.altitude-rail-new-btn');
    expect(plus?.disabled).toBe(true);
  });

  it('marks the team home active on a team pane', async () => {
    await mount(AltitudeRail, '/t/marketing/overview', { onOpenQuickCreate: () => {} });
    expect(container.querySelector('.altitude-rail-team-btn')?.classList.contains('active')).toBe(
      true,
    );
  });
});
