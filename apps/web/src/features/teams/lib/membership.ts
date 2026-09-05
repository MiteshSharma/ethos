import type { TeamSummary } from '@ethosagent/web-contracts';
import { personalityAccent } from '../../../lib/theme';

// Pure membership derivation for teams-as-a-scope T1 (D3): "independent"
// means *assigned to no team*, and membership is derived from the manifests
// `teams.list` reports — never stored on the personality. Kept free of hooks
// so the Library roster rule (rail, Personalities page) is unit-testable.

export type MembershipIndex = ReadonlyMap<string, TeamSummary[]>;

/** personalityId → every team whose manifest lists it, in `teams` order. A
 *  personality in two teams appears under both (D3). */
export function membershipIndex(teams: readonly TeamSummary[]): MembershipIndex {
  const index = new Map<string, TeamSummary[]>();
  for (const team of teams) {
    for (const member of team.members) {
      const list = index.get(member.personalityId);
      if (list) list.push(team);
      else index.set(member.personalityId, [team]);
    }
  }
  return index;
}

/** The ids in `allIds` that belong to no team, in their original order. */
export function independentIds(index: MembershipIndex, allIds: readonly string[]): string[] {
  return allIds.filter((id) => !index.has(id));
}

/** Member accents in manifest order — what `<TeamRing>` is built from (D10). */
export function teamAccents(team: Pick<TeamSummary, 'members'>): string[] {
  return team.members.map((m) => personalityAccent(m.personalityId));
}

/** Members in rail order: the coordinator first (with the lead marker),
 *  then the rest in manifest order. A team with no coordinator keeps
 *  manifest order untouched. */
export function railMembers(team: Pick<TeamSummary, 'members' | 'coordinator'>) {
  const lead = team.members.find((m) => m.personalityId === team.coordinator);
  if (!lead) return team.members;
  return [lead, ...team.members.filter((m) => m !== lead)];
}
