import { Alert, Button, Spin, Typography } from 'antd';
import { useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { taskReasons } from '../../components/kanban/KanbanBoard';
import { AttentionGroups } from '../../components/team/AttentionGroups';
import { LedgerFeed } from '../../components/team/LedgerFeed';
import { MemberRow } from '../../components/team/MemberRow';
import { StatusStrip } from '../../components/team/StatusStrip';
import { NavIcon } from '../../components/ui/NavIcon';
import { useKanbanBoard } from '../../features/kanban/api/queries';
import { useTeam } from '../../features/teams/api/queries';
import { useTeamLedger } from '../../hooks/useTeamLedger';
import { buildTeamPath } from '../../lib/workspaceRoutes';

// The team's home (plan/phases/teams-as-a-scope.md D5, §4): the status line,
// then Members · Board-attention-first · Supervisor ledger, three full-height
// columns that each scroll on their own. Everything is read off `teams.get`,
// `kanban.getBoard` (SSE-invalidated) and `teams.ledger`; nothing is stored
// for the UI. Pixel reference: plan/prototypes/teams-as-a-scope/
// ethos-team-scope.html `overview()`.

const LEDGER_LIMIT = 50;

export function TeamOverview() {
  const { teamId = '' } = useParams<{ teamId: string }>();
  const navigate = useNavigate();
  const teamQuery = useTeam(teamId);
  const boardQuery = useKanbanBoard(teamId);
  const ledgerQuery = useTeamLedger(teamId, LEDGER_LIMIT, boardQuery.dataUpdatedAt);

  const board = boardQuery.data?.board ?? null;
  const reasons = useMemo(() => taskReasons(board?.recentEvents ?? []), [board]);

  if (teamQuery.isLoading || boardQuery.isLoading) {
    return (
      <div className="team-body team-body-center">
        <Spin />
      </div>
    );
  }
  const error = teamQuery.error ?? boardQuery.error;
  if (error) {
    return (
      <div className="team-body">
        <Alert type="error" message={error.message} />
      </div>
    );
  }
  const team = teamQuery.data;
  if (!team || !board) return null;

  const stopped = team.health !== 'running';
  const hasBoard = team.boardModifiedAt !== null;
  const ledger = ledgerQuery.data?.items ?? [];

  return (
    <div className="team-body">
      <StatusStrip team={team} tasks={board.tasks} />
      <div className="team-ov">
        <div className="team-colv">
          <div className="team-sec">
            Members <span className="team-sec-cnt">{team.members.length}</span>
            <Link className="team-sec-more" to={buildTeamPath(teamId, 'structure')}>
              Structure →
            </Link>
          </div>
          <div className="team-rows">
            {team.members.map((m) => (
              <MemberRow
                key={m.personalityId}
                teamId={teamId}
                member={m}
                tasks={board.tasks}
                coordinator={team.coordinator}
                reasons={reasons}
              />
            ))}
          </div>
          <div className="team-sec" style={{ marginTop: 14 }}>
            Memory <span className="team-sec-cnt">{team.memoryTopics.length} topics</span>
            <Link className="team-sec-more" to={buildTeamPath(teamId, 'memory')}>
              Open →
            </Link>
          </div>
          <div className="team-chips">
            {team.memoryTopics.map((topic) => (
              <Link
                key={topic}
                className="team-chip"
                to={`${buildTeamPath(teamId, 'memory')}?topic=${encodeURIComponent(topic)}`}
              >
                {topic}
              </Link>
            ))}
          </div>
          {team.coordinator && (
            <div className="team-colv-foot">
              <Button
                className="team-message-btn"
                icon={<NavIcon icon="chat" />}
                onClick={() => navigate(buildTeamPath(teamId, 'chat'))}
              >
                Message {team.name} <span className="team-mono">via {team.coordinator}</span>
              </Button>
            </div>
          )}
        </div>

        <div className="team-colv">
          <div className="team-sec">
            Board · attention first
            <Link className="team-sec-more" to={buildTeamPath(teamId, 'board')}>
              Open board →
            </Link>
          </div>
          <div className="team-scroll">
            {hasBoard ? (
              <AttentionGroups snapshot={board} teamId={teamId} />
            ) : (
              <div className="team-empty">
                <span>
                  No board yet — it is created on first{' '}
                  <Typography.Text code>ethos team start</Typography.Text>
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="team-colv">
          <div className="team-sec">
            Supervisor ledger
            <Link className="team-sec-more" to={buildTeamPath(teamId, 'activity')}>
              All activity →
            </Link>
          </div>
          <div className="team-scroll">
            {stopped && (
              <div className="team-empty team-ledger-stopped">
                <span>
                  The supervisor is stopped, so nothing is being dispatched, verified or reclaimed.
                  The last entries are below.
                </span>
                <Typography.Text code copyable>
                  ethos team start {team.name}
                </Typography.Text>
              </div>
            )}
            <LedgerFeed items={ledger} teamId={teamId} emptyText="Nothing yet." />
          </div>
        </div>
      </div>
    </div>
  );
}
