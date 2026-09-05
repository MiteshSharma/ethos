// @vitest-environment jsdom
//
// teams-as-a-scope T2 — the Activity pane (§8): board activity beside the
// supervisor ledger, two columns; a member's row carries its mark and
// `data-p`, a non-agent actor's carries a neutral dot.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  boardSnapshot,
  EVENTS,
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

vi.mock('../../../rpc', () => ({
  rpc: {
    teams: {
      get: (...args: unknown[]) => teamsGet(...args),
      ledger: (...args: unknown[]) => teamsLedger(...args),
    },
    kanban: { getBoard: (...args: unknown[]) => kanbanGetBoard(...args) },
  },
}));

const { TeamActivity } = await import('../TeamActivity');

let mounted: Mounted | null = null;

beforeEach(() => {
  teamsGet.mockResolvedValue(teamDetail());
  teamsLedger.mockResolvedValue({ items: LEDGER });
  kanbanGetBoard.mockResolvedValue({ board: boardSnapshot() });
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('TeamActivity', () => {
  it('renders the two columns: board activity newest-first, and the 200-row ledger', async () => {
    mounted = await mountPage(TeamActivity, '/t/:teamId/activity', '/t/marketing/activity');
    await flush();
    const c = mounted.container;
    const cols = [...c.querySelectorAll('.team-ov-2 > .team-colv')];
    expect(cols).toHaveLength(2);
    expect(cols[0]?.querySelector('.team-sec')?.textContent).toContain('Activity');
    expect(cols[1]?.querySelector('.team-sec')?.textContent).toBe('Supervisor ledger');

    const activity = [...(cols[0]?.querySelectorAll('.team-ev') ?? [])];
    expect(activity).toHaveLength(EVENTS.length);
    // Snapshot is oldest → newest; the feed is newest first.
    expect(activity[0]?.querySelector('.team-idlink')?.textContent).toBe('#t-rev-00');
    expect(activity[0]?.getAttribute('data-p')).toBe('reddit-scout');
    expect(activity[0]?.querySelector('svg[role="img"]')).not.toBeNull();
    expect(activity[0]?.textContent).toContain('running → needs_revision');
    expect(activity[0]?.textContent).toContain('Rank the angles');
    // The dispatcher is not a member: neutral dot, no cross-highlight key.
    const dispatcher = activity[2];
    expect(dispatcher?.getAttribute('data-p')).toBeNull();
    expect(dispatcher?.querySelector('.team-dot-info')).not.toBeNull();
    expect(dispatcher?.querySelector('svg')).toBeNull();

    expect(teamsLedger).toHaveBeenCalledWith({ team: 'marketing', limit: 200 });
    expect(cols[1]?.querySelectorAll('.team-ev')).toHaveLength(LEDGER.length);
  });
});
