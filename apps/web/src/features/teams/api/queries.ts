import type { TeamSummary } from '@ethosagent/web-contracts';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { rpc } from '../../../rpc';
import { independentIds, type MembershipIndex, membershipIndex } from '../lib/membership';
import { teamKeys } from './keys';

// Team queries for the third altitude (plan/phases/teams-as-a-scope.md T1).
// Both poll at 5s like `useKanbanList` so an `ethos team start` — or a new
// manifest under ~/.ethos/teams/ — shows up without a reload.

export function useTeamsList(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: teamKeys.list(),
    queryFn: () => rpc.teams.list(),
    refetchInterval: 5_000,
    ...options,
  });
}

export function useTeam(teamId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: teamKeys.get(teamId),
    queryFn: () => rpc.teams.get({ team: teamId }),
    refetchInterval: 5_000,
    enabled: teamId.length > 0,
    ...options,
  });
}

export interface TeamMembership {
  teams: TeamSummary[];
  /** personalityId → the teams whose manifests list it (D3). */
  byPersonality: MembershipIndex;
  /**
   * The ids in `allPersonalityIds` that are in no team. While the list is
   * still loading, or if it failed, EVERY id is returned — the Library
   * roster must never render empty because `teams.list` is slow or down
   * (§10: "when the roster is still loading, render today's full list").
   */
  independentIds: (allPersonalityIds: readonly string[]) => string[];
}

export function useTeamMembership(): TeamMembership {
  const query = useTeamsList();
  const teams = query.data?.items;
  return useMemo(() => {
    const list = teams ?? [];
    const byPersonality = membershipIndex(list);
    return {
      teams: list,
      byPersonality,
      independentIds: (allIds) => (teams ? independentIds(byPersonality, allIds) : [...allIds]),
    };
  }, [teams]);
}
