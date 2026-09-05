import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { MemberSheet } from '../../components/team/structure/MemberSheet';
import { StructureCanvas } from '../../components/team/structure/StructureCanvas';
import { SystemSheet } from '../../components/team/structure/SystemSheet';
import { usePersonalityList } from '../../features/personalities/api/queries';
import { useTeam } from '../../features/teams/api/queries';
import { rpc } from '../../rpc';

// The team's Structure pane (plan/phases/teams-as-a-scope.md §6, D7): the
// canvas on the left, a 340px side sheet on the right. Selection lives in
// the URL (`?node=<id>`) so a node can be linked; the default is the
// coordinator, or the board node when the team has none.

export function TeamStructure() {
  const { teamId = '' } = useParams<{ teamId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const teamQuery = useTeam(teamId);
  const boardQuery = useQuery({
    queryKey: ['kanban', 'board', teamId],
    queryFn: () => rpc.kanban.getBoard({ team: teamId }),
    enabled: teamId.length > 0,
    refetchInterval: 5_000,
  });
  const personalitiesQuery = usePersonalityList();

  const team = teamQuery.data;
  const tasks = useMemo(() => boardQuery.data?.board.tasks ?? [], [boardQuery.data]);
  const memberStats = boardQuery.data?.board.memberStats ?? [];
  const personalities = personalitiesQuery.data?.items;

  const requested = searchParams.get('node');
  const selectedId = requested ?? team?.coordinator ?? 'board';

  const select = useCallback(
    (id: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('node', id);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  const enter = useCallback(
    (personalityId: string) => navigate(`/t/${teamId}/p/${personalityId}/chat`),
    [navigate, teamId],
  );

  if (teamQuery.isError) {
    return (
      <div className="team-pane">
        <div className="team-empty">Could not load {teamId}.</div>
      </div>
    );
  }
  if (!team) {
    return (
      <div className="team-pane">
        <div className="team-empty">Loading…</div>
      </div>
    );
  }

  const member = team.members.find((m) => m.personalityId === selectedId);
  const systemKind =
    selectedId === 'board' || selectedId === 'memory' || selectedId === 'channel'
      ? selectedId
      : null;

  return (
    <div className="team-canvas">
      <StructureCanvas
        team={team}
        tasks={tasks}
        personalities={personalities}
        selectedId={selectedId}
        onSelect={select}
        onEnter={enter}
      />
      {member ? (
        <MemberSheet
          key={member.personalityId}
          team={team}
          member={member}
          personality={personalities?.find((p) => p.id === member.personalityId)}
          missing={
            personalities !== undefined && !personalities.some((p) => p.id === member.personalityId)
          }
          tasks={tasks}
          memberStats={memberStats}
        />
      ) : (
        <SystemSheet kind={systemKind ?? 'board'} team={team} />
      )}
    </div>
  );
}
