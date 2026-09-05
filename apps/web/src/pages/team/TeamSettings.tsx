import { Button, Tooltip, Typography } from 'antd';
import { useParams } from 'react-router-dom';
import { useConfig } from '../../features/config/api/queries';
import { useTeam } from '../../features/teams/api/queries';
import { humanDuration } from '../../lib/teamPresence';

// The team's Settings pane (plan/phases/teams-as-a-scope.md §8, D13):
// the manifest as its source file, the runtime block, and the CLI commands
// for start / stop as copyable code. Editing lands with the manifest editor
// (T6); team start/stop from the web is out of v1, so the buttons that would
// change the team are disabled and say so.

export function TeamSettings() {
  const { teamId = '' } = useParams<{ teamId: string }>();
  const teamQuery = useTeam(teamId);
  const config = useConfig();
  const team = teamQuery.data;

  if (!team) {
    return (
      <div className="team-pane">
        <div className="team-empty">
          {teamQuery.isError ? `Could not load ${teamId}.` : 'Loading…'}
        </div>
      </div>
    );
  }

  const runtime = team.runtime;
  const supervisor =
    runtime && team.health !== 'stopped'
      ? `${team.health} · pid ${runtime.supervisorPid} · up ${humanDuration(
          Date.now() - new Date(runtime.startedAt).getTime(),
        )}`
      : 'stopped';
  const online = team.members.filter((m) => m.status === 'running').length;
  const guard = config.data?.teamSupervisorRestartLoopGuard;

  return (
    <div className="team-pane">
      <div className="team-sec">
        Manifest <span className="team-sec-cnt">{team.manifestPath}</span>
        <Tooltip
          title={`Editing lands with the manifest editor; edit the file at ${team.manifestPath}`}
        >
          <button type="button" className="team-sec-more">
            Edit
          </button>
        </Tooltip>
      </div>
      <pre className="team-md team-settings-manifest">{team.manifestYaml}</pre>

      <div className="team-sec">Runtime</div>
      <div className="team-kv team-settings-kv">
        <b>Supervisor</b>
        <span>{supervisor}</span>
        <b>Members online</b>
        <span>
          {online} of {team.members.length}
        </span>
        {guard ? (
          <>
            <b>Restart guard</b>
            <span>
              {guard.maxRestarts} restarts / {guard.windowSeconds}s
            </span>
          </>
        ) : null}
      </div>

      <div className="team-sec">Commands</div>
      <div className="team-settings-commands">
        <Typography.Text code copyable>
          {`ethos team start ${team.name}`}
        </Typography.Text>
        <Typography.Text code copyable>
          {`ethos team stop ${team.name}`}
        </Typography.Text>
      </div>

      <div className="team-settings-actions">
        <Tooltip title="coming later">
          <Button size="small" disabled>
            Add member
          </Button>
        </Tooltip>
        <Tooltip title="coming later">
          <Button size="small" disabled danger>
            Retire team
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}
