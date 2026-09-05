import { useTeam } from '../../features/teams/api/queries';
import { humanDuration } from '../../lib/teamPresence';
import { SeverityDot } from './SeverityDot';

// The breadcrumb's supervisor line at the team altitude (prototype's right
// slot beside the Needs-you pill): `● supervisor running · up 6h 12m` with the
// live ok dot, or `● supervisor stopped` with the tertiary dot. Read off the
// same `teams.get` cache entry the panes poll every 5s, so the uptime ticks
// with the poll. Hidden until the team has answered.

export function SupervisorStatus({ teamId, now = Date.now() }: { teamId: string; now?: number }) {
  const team = useTeam(teamId).data;
  if (!team) return null;
  if (team.health !== 'running') {
    return (
      <span className="team-supervisor-status team-mono">
        <SeverityDot tone="dim" />
        supervisor stopped
      </span>
    );
  }
  const startedAt = team.startedAt ? Date.parse(team.startedAt) : Number.NaN;
  const uptime = Number.isFinite(startedAt) ? humanDuration(now - startedAt) : null;
  return (
    <span className="team-supervisor-status team-mono">
      <SeverityDot tone="ok" live />
      supervisor running{uptime ? ` · up ${uptime}` : ''}
    </span>
  );
}
