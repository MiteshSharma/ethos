// @vitest-environment jsdom
//
// teams-as-a-scope T2 — the Board pane (§5) in jsdom against a mocked RPC
// client: the selected task lives in the URL, so `?task=` opens the drawer,
// clicking a tile writes it, and Close clears it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  boardSnapshot,
  click,
  flush,
  installDomStubs,
  type Mounted,
  mountPage,
  TASKS,
  teamDetail,
} from './harness';

installDomStubs();

const teamsGet = vi.fn();
const kanbanGetBoard = vi.fn();
const kanbanGetTask = vi.fn();
const kanbanListAgents = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: {
    teams: { get: (...args: unknown[]) => teamsGet(...args) },
    kanban: {
      getBoard: (...args: unknown[]) => kanbanGetBoard(...args),
      getTask: (...args: unknown[]) => kanbanGetTask(...args),
      listAgents: (...args: unknown[]) => kanbanListAgents(...args),
    },
  },
}));

const { TeamBoard } = await import('../TeamBoard');

let mounted: Mounted | null = null;

async function mount(path: string): Promise<HTMLDivElement> {
  mounted = await mountPage(TeamBoard, '/t/:teamId/board', path);
  await flush();
  return mounted.container;
}

const search = (c: HTMLDivElement) =>
  c.querySelector('[data-testid="location"]')?.getAttribute('data-search');

beforeEach(() => {
  teamsGet.mockResolvedValue(teamDetail());
  kanbanGetBoard.mockResolvedValue({ board: boardSnapshot() });
  kanbanGetTask.mockImplementation(({ taskId }: { taskId: string }) =>
    Promise.resolve({ task: TASKS.find((t) => t.id === taskId), comments: [], runs: [] }),
  );
  kanbanListAgents.mockResolvedValue({ agents: [] });
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('TeamBoard', () => {
  it('renders the header counts and every status column with its tiles', async () => {
    const c = await mount('/t/marketing/board');
    expect(c.querySelector('.team-sec-cnt')?.textContent).toBe('5 open · stale after 30m');
    expect(c.querySelectorAll('.team-cols .cc-column')).toHaveLength(7);
    expect(c.querySelectorAll('.cc-task')).toHaveLength(TASKS.length);
    expect(c.querySelector('.cc-task[data-task="t-blk-001"]')?.getAttribute('data-p')).toBe('cmo');
    expect(c.querySelector('.team-drawer')).toBeNull();
    expect(c.querySelector('.team-split')?.classList.contains('team-split-open')).toBe(false);
  });

  it('renders plain column headers — mono label, state dot, count — not the status chip', async () => {
    const c = await mount('/t/marketing/board');
    const headers = [...c.querySelectorAll('.team-cols .cc-column-header')];
    expect(headers.every((h) => h.classList.contains('cc-column-header-plain'))).toBe(true);
    expect(c.querySelector('.team-cols .cc-column-header .cc-status-chip')).toBeNull();
    expect(headers.map((h) => h.querySelector('.cc-column-name')?.textContent)).toEqual([
      'todo',
      'ready',
      'running',
      'blocked',
      'revision',
      'failed',
      'done',
    ]);
    expect(headers.map((h) => h.querySelector('.cc-column-count')?.textContent)).toEqual([
      '1',
      '1',
      '1',
      '1',
      '1',
      '0',
      '2',
    ]);
    const dot = (i: number) => headers[i]?.querySelector('.team-dot')?.className ?? null;
    expect(dot(0)).toBeNull();
    expect(dot(2)).toBe('team-dot team-dot-ok team-dot-live');
    expect(dot(3)).toBe('team-dot team-dot-err');
    expect(dot(4)).toBe('team-dot team-dot-warn');
    expect(dot(6)).toBeNull();
    // The empty `failed` column still says so.
    expect(headers[5]?.parentElement?.querySelector('.cc-column-empty')?.textContent).toBe(
      'No tasks here yet',
    );
  });

  it('?task=<id> opens the inline drawer on that task', async () => {
    const c = await mount('/t/marketing/board?task=t-run-001');
    const drawer = c.querySelector('.team-drawer');
    expect(drawer?.getAttribute('data-task')).toBe('t-run-001');
    expect(drawer?.querySelector('.team-drawer-title')?.textContent).toBe(
      '#t-run-00 Sweep r/marketing',
    );
    expect(c.querySelector('.team-split')?.classList.contains('team-split-open')).toBe(true);
    expect(kanbanGetTask).toHaveBeenCalledWith({ team: 'marketing', taskId: 't-run-001' });
  });

  it('clicking a tile writes ?task=, Close clears it', async () => {
    const c = await mount('/t/marketing/board');
    await click(c.querySelector('.cc-task[data-task="t-rev-001"]'));
    await flush();
    expect(search(c)).toBe('?task=t-rev-001');
    expect(c.querySelector('.team-drawer')?.getAttribute('data-task')).toBe('t-rev-001');

    await click(c.querySelector('.team-drawer .team-sec-more'));
    await flush();
    expect(search(c)).toBe('');
    expect(c.querySelector('.team-drawer')).toBeNull();
  });
});
