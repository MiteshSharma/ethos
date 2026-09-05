import type { KanbanTask, TeamDetail } from '@ethosagent/web-contracts';
import { capitalize } from '../../lib/scopeNav';
import { boardCounts, humanDuration } from '../../lib/teamPresence';
import { SeverityDot } from './SeverityDot';

// The Overview's status line (plan/phases/teams-as-a-scope.md §4): five
// cells, no borders between them, one rule beneath. Everything is read off
// `teams.get` and the board — nothing here is stored for the UI.

export function StatusStrip({
  team,
  tasks,
  now = Date.now(),
}: {
  team: TeamDetail;
  tasks: KanbanTask[];
  /** Injectable clock for the uptime cell. */
  now?: number;
}) {
  const counts = boardCounts(tasks);
  const startedAt = team.startedAt ? Date.parse(team.startedAt) : Number.NaN;
  const uptime = Number.isFinite(startedAt) ? humanDuration(now - startedAt) : null;
  const channel = team.channels[0] ?? null;

  return (
    <div className="team-strip">
      <div>
        <div className="team-k">Supervisor</div>
        <div className="team-strip-v" data-cell="supervisor">
          {team.health === 'running' ? (
            <>
              <SeverityDot tone="ok" live />
              Running
              {uptime && <span className="team-mono">up {uptime}</span>}
            </>
          ) : team.health === 'stale' ? (
            <>
              <SeverityDot tone="warn" />
              Stale
            </>
          ) : (
            <>
              <SeverityDot tone="dim" />
              Stopped
            </>
          )}
        </div>
      </div>
      <div>
        <div className="team-k">Dispatch</div>
        <div className="team-strip-v" data-cell="dispatch">
          {capitalize(team.dispatchMode)}
          <span className="team-mono">
            {team.coordinator ? `via ${team.coordinator} · ` : ''}poll{' '}
            {humanDuration(team.kanban.pollMs)}
          </span>
        </div>
      </div>
      <div>
        <div className="team-k">Board</div>
        <div className="team-strip-v" data-cell="board">
          {counts.running} running
          <span className="team-mono">
            · {counts.blocked} blocked · {counts.needsRevision} revision · {counts.done} done
          </span>
        </div>
      </div>
      <div>
        <div className="team-k">Trust</div>
        <div className="team-strip-v" data-cell="trust">
          {capitalize(team.trustPolicy?.mode ?? 'flat')}
          <span className="team-mono">· stale after {humanDuration(team.kanban.staleMs)}</span>
        </div>
      </div>
      <div>
        <div className="team-k">Channel</div>
        <div className="team-strip-v" data-cell="channel">
          {channel ? (
            <>
              {capitalize(channel.platform)} {channel.botKey}
              {team.coordinator && <span className="team-mono">→ {team.coordinator}</span>}
            </>
          ) : (
            <span className="team-strip-none">None bound</span>
          )}
        </div>
      </div>
    </div>
  );
}
