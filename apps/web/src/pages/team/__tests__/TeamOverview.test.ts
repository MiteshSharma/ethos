// @vitest-environment jsdom
//
// teams-as-a-scope T2 — the Overview pane (§4) driven in jsdom against a
// mocked RPC client. What it guards is between the pieces: the strip reads
// the right fields, member rows carry the cross-highlight key, attention
// groups come out in urgency order, the ledger deep-links, and the stopped
// team gets its explanation and command before the historical rows.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  boardSnapshot,
  flush,
  installDomStubs,
  LEDGER,
  type Mounted,
  mountPage,
  teamDetail,
} from './harness';

installDomStubs();

const teamsGet = vi.fn();
const teamsLedger = vi.fn();
const kanbanGetBoard = vi.fn();
const kanbanListAgents = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: {
    teams: {
      get: (...args: unknown[]) => teamsGet(...args),
      ledger: (...args: unknown[]) => teamsLedger(...args),
    },
    kanban: {
      getBoard: (...args: unknown[]) => kanbanGetBoard(...args),
      listAgents: (...args: unknown[]) => kanbanListAgents(...args),
    },
  },
}));

const { TeamOverview } = await import('../TeamOverview');

let mounted: Mounted | null = null;

async function mount(): Promise<HTMLDivElement> {
  mounted = await mountPage(TeamOverview, '/t/:teamId/overview', '/t/marketing/overview');
  await flush();
  return mounted.container;
}

beforeEach(() => {
  teamsGet.mockResolvedValue(teamDetail());
  teamsLedger.mockResolvedValue({ items: LEDGER });
  kanbanGetBoard.mockResolvedValue({ board: boardSnapshot() });
  kanbanListAgents.mockResolvedValue({ agents: [] });
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim();

describe('TeamOverview', () => {
  it('renders the five strip cells off teams.get and the board', async () => {
    const c = await mount();
    expect(teamsGet).toHaveBeenCalledWith({ team: 'marketing' });
    expect(kanbanGetBoard).toHaveBeenCalledWith({ team: 'marketing' });
    expect(text(c.querySelector('[data-cell="supervisor"]'))).toBe('Runningup 6h 12m');
    expect(c.querySelector('[data-cell="supervisor"] .team-dot-live')).not.toBeNull();
    expect(text(c.querySelector('[data-cell="dispatch"]'))).toBe('Coordinatorvia cmo · poll 1s');
    expect(text(c.querySelector('[data-cell="board"]'))).toBe(
      '1 running· 1 blocked · 1 revision · 2 done',
    );
    expect(text(c.querySelector('[data-cell="trust"]'))).toBe('Flat· stale after 30m');
    expect(text(c.querySelector('[data-cell="channel"]'))).toBe('Slack #marketing→ cmo');
  });

  it('renders one member row per manifest member, linked into the team workspace, with data-p', async () => {
    const c = await mount();
    const rows = [...c.querySelectorAll('.team-mrow')];
    expect(rows.map((r) => r.getAttribute('data-p'))).toEqual(['cmo', 'reddit-scout']);
    expect(rows.map((r) => r.getAttribute('href'))).toEqual([
      '/t/marketing/p/cmo/chat',
      '/t/marketing/p/reddit-scout/chat',
    ]);
    const cmo = rows[0];
    expect(cmo?.querySelector('.team-mrow-role')?.textContent).toBe('coordinator');
    expect(cmo?.querySelector('.team-tier')?.textContent).toBe('trusted');
    // cmo owns the blocked ticket → err state with the block reason from events.
    expect(text(cmo?.querySelector('.team-mrow-st') ?? null)).toBe(
      '#t-blk-00 blocked · waiting on legal',
    );
    expect(cmo?.querySelector('.team-dot-err')).not.toBeNull();
    const scout = rows[1];
    expect(scout?.querySelector('.team-tier')?.textContent).toBe('—');
    expect(text(scout?.querySelector('.team-mrow-st') ?? null)).toBe(
      '#t-run-00 Sweep r/marketing · 12m ago',
    );
    expect(scout?.querySelector('.team-dot-ok.team-dot-live')).not.toBeNull();
    expect(c.querySelector('.team-sec')?.textContent).toContain('Members 2');
  });

  it('shows the memory topics as chips linking into the Memory pane', async () => {
    const c = await mount();
    const chips = [...c.querySelectorAll('.team-chip')];
    expect(chips.map((a) => a.textContent)).toEqual(['onboarding', 'decisions']);
    expect(chips[0]?.getAttribute('href')).toBe('/t/marketing/memory?topic=onboarding');
  });

  it('groups the board attention-first, skipping empty groups, with the reason line', async () => {
    const c = await mount();
    const groups = [...c.querySelectorAll('.team-group')];
    expect(groups.map((g) => g.getAttribute('data-group'))).toEqual([
      'needs_revision',
      'blocked',
      'running',
      'ready',
    ]);
    expect(text(groups[0]?.querySelector('.team-group-h') ?? null)).toBe('Needs revision1');
    const rev = groups[0]?.querySelector('.cc-task');
    expect(rev?.getAttribute('data-task')).toBe('t-rev-001');
    expect(rev?.getAttribute('data-p')).toBe('reddit-scout');
    expect(rev?.querySelector('.cc-task-reason-needs_revision')?.textContent).toBe(
      'no citations for the top three',
    );
    expect(groups[1]?.querySelector('.cc-task-reason-blocked')?.textContent).toBe(
      'waiting on legal',
    );
    // todo and done never appear here.
    expect(c.querySelector('.cc-task[data-task="t-done-01"]')).toBeNull();
    expect(c.querySelector('.cc-task[data-task="t-todo-01"]')).toBeNull();
  });

  it('renders the ledger newest-first with #id links into the board drawer', async () => {
    const c = await mount();
    expect(teamsLedger).toHaveBeenCalledWith({ team: 'marketing', limit: 50 });
    const rows = [...c.querySelectorAll('.team-ev')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute('data-p')).toBe('reddit-scout');
    expect(rows[0]?.querySelector('.team-ev-h')?.textContent).toBe('Verifier rejected');
    expect(rows[0]?.querySelector('.team-idlink')?.getAttribute('href')).toBe(
      '/t/marketing/board?task=t-rev-001',
    );
    expect(rows[0]?.querySelector('.team-idlink')?.textContent).toBe('#t-rev-00');
    expect(rows[0]?.querySelector('.team-ev-why')?.textContent).toBe(
      'no citations for the top three · retry 1 of 3',
    );
    expect(rows[0]?.querySelector('.team-dot-warn')).not.toBeNull();
    expect(rows[0]?.querySelector('.team-ev-t')?.textContent).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(c.querySelector('.team-ledger-stopped')).toBeNull();
  });

  it('a stopped team explains the silence and shows the start command above the history', async () => {
    teamsGet.mockResolvedValue(
      teamDetail({
        health: 'stopped',
        startedAt: null,
        runningCount: 0,
        members: teamDetail().members.map((m) => ({ ...m, status: 'offline' as const })),
      }),
    );
    const c = await mount();
    expect(text(c.querySelector('[data-cell="supervisor"]'))).toBe('Stopped');
    const stopped = c.querySelector('.team-ledger-stopped');
    expect(stopped?.textContent).toContain('The supervisor is stopped');
    expect(stopped?.querySelector('code')?.textContent).toBe('ethos team start marketing');
    // The history still follows.
    expect(c.querySelectorAll('.team-ev')).toHaveLength(2);
    // Members are offline, dim.
    expect(c.querySelectorAll('.team-mrow .team-dot-dim')).toHaveLength(2);
    expect(text(c.querySelector('.team-mrow .team-mrow-st'))).toBe('offline · supervisor stopped');
  });

  it('shows the Message button only when the team has a coordinator', async () => {
    let c = await mount();
    const btn = c.querySelector('.team-message-btn');
    expect(text(btn)).toBe('Message marketing via cmo');
    await mounted?.unmount();
    mounted = null;

    teamsGet.mockResolvedValue(
      teamDetail({
        coordinator: null,
        dispatchMode: 'broadcast',
        members: teamDetail().members.map((m) => ({ ...m, role: 'member' as const })),
      }),
    );
    c = await mount();
    expect(c.querySelector('.team-message-btn')).toBeNull();
    expect(text(c.querySelector('[data-cell="dispatch"]'))).toBe('Broadcastpoll 1s');
  });

  it('a team without a board says so instead of an empty attention column', async () => {
    teamsGet.mockResolvedValue(teamDetail({ boardModifiedAt: null }));
    kanbanGetBoard.mockResolvedValue({
      board: boardSnapshot({ tasks: [], recentEvents: [] }),
    });
    const c = await mount();
    expect(c.querySelector('.team-group')).toBeNull();
    expect(text(c.querySelector('.team-empty'))).toContain('No board yet');
    expect(text(c.querySelector('[data-cell="board"]'))).toBe(
      '0 running· 0 blocked · 0 revision · 0 done',
    );
  });
});
