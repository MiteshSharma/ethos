import type { TeamSummary } from '@ethosagent/web-contracts';

// Pure rows for the breadcrumb's scope switcher (plan/phases/
// teams-as-a-scope.md D2/§2): Independent, then every team, then New team.
// Kept out of `StageHeader.tsx` so the menu's contents and the status line
// are unit-testable without a DOM — same split as `scopeNav.ts`.

export type SwitcherRow =
  | { kind: 'independent'; count: number }
  | { kind: 'team'; team: TeamSummary; status: string }
  | { kind: 'new' };

/** `<dispatch> · <N working | stopped>` — a stopped team still lists (§2). */
export function teamStatusLine(team: Pick<TeamSummary, 'dispatchMode' | 'health' | 'members'>) {
  if (team.health === 'stopped') return `${team.dispatchMode} · stopped`;
  const working = team.members.filter((m) => m.status === 'running').length;
  return `${team.dispatchMode} · ${working} working`;
}

export function switcherRows(teams: readonly TeamSummary[], independentCount: number) {
  const rows: SwitcherRow[] = [{ kind: 'independent', count: independentCount }];
  for (const team of teams) rows.push({ kind: 'team', team, status: teamStatusLine(team) });
  rows.push({ kind: 'new' });
  return rows;
}
