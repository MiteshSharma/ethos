import type { TeamSummary } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { switcherRows, teamStatusLine } from '../scopeSwitcher';

// The breadcrumb's scope switcher (teams-as-a-scope D2/§2) — row order and
// the per-team status line, without a DOM.

function team(over: Partial<TeamSummary> & { name: string }): TeamSummary {
  return {
    description: '',
    dispatchMode: 'coordinator',
    health: 'running',
    memberCount: 0,
    runningCount: 0,
    boardModifiedAt: null,
    coordinator: null,
    members: [],
    channels: [],
    startedAt: null,
    ...over,
  };
}

const member = (personalityId: string, status: TeamSummary['members'][number]['status']) => ({
  personalityId,
  role: 'member' as const,
  tier: null,
  status,
  capabilities: [],
});

describe('teamStatusLine', () => {
  it('counts running members when the team is up', () => {
    const t = team({
      name: 'marketing',
      members: [member('a', 'running'), member('b', 'stopped'), member('c', 'running')],
    });
    expect(teamStatusLine(t)).toBe('coordinator · 2 working');
  });

  it('says stopped for a stopped team, whatever the members report', () => {
    const t = team({
      name: 'dev',
      dispatchMode: 'broadcast',
      health: 'stopped',
      members: [member('a', 'running')],
    });
    expect(teamStatusLine(t)).toBe('broadcast · stopped');
  });
});

describe('switcherRows', () => {
  it('is Independent, every team in order, then New team', () => {
    const rows = switcherRows([team({ name: 'marketing' }), team({ name: 'dev' })], 3);
    expect(rows.map((r) => (r.kind === 'team' ? r.team.name : r.kind))).toEqual([
      'independent',
      'marketing',
      'dev',
      'new',
    ]);
    expect(rows[0]).toEqual({ kind: 'independent', count: 3 });
  });

  it('with no teams is Independent + New team only (§11)', () => {
    expect(switcherRows([], 0).map((r) => r.kind)).toEqual(['independent', 'new']);
  });
});
