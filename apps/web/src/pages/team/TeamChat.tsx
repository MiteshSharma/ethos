import { ConfigProvider } from 'antd';
import { Link, useParams } from 'react-router-dom';
import { useTeam } from '../../features/teams/api/queries';
import { teamAccents } from '../../features/teams/lib/membership';
import { accentVars, personalityAccent, personalityTheme } from '../../lib/theme';
import { buildTeamPath } from '../../lib/workspaceRoutes';
import { Chat } from '../Chat';

// The team's Chat pane (plan/phases/teams-as-a-scope.md D4, §8 "Chat"): the
// existing chat page rendered for the coordinator, inside team chrome. The
// coordinator's sessions ARE the team's — one session list, two doors — and
// web-api already runs every turn for a team member on that team's loop, so
// this page only has to open the right chat and say whose it is.
//
// Team chrome is neutral, but this pane carries the COORDINATOR's accent
// (DESIGN.md "Team chrome is neutral"): it is the coordinator's surface, so
// it gets the same `<ConfigProvider>` + `--accent` swap a workspace gets.

export function TeamChat() {
  const { teamId = '' } = useParams<{ teamId: string }>();
  const teamQuery = useTeam(teamId);
  const team = teamQuery.data;
  if (!team) return null;

  const coordinator = team.coordinator;
  if (!coordinator) {
    return (
      <div className="team-chat-no-coordinator">
        <p className="team-chat-no-coordinator-text">
          This team has no coordinator, so it has no chat. Talk to a member from{' '}
          <Link to={buildTeamPath(teamId, 'structure')}>Structure</Link>.
        </p>
      </div>
    );
  }

  return (
    <ConfigProvider theme={personalityTheme(coordinator)}>
      <div className="workspace-accent-scope" style={accentVars(personalityAccent(coordinator))}>
        <Chat
          key={`${teamId}:${coordinator}`}
          personalityId={coordinator}
          teamContext={{
            teamId,
            teamName: team.name,
            accents: teamAccents(team),
            coordinatorId: coordinator,
          }}
        />
      </div>
    </ConfigProvider>
  );
}
