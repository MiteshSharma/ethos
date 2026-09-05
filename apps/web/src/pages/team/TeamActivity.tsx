import { Alert, Spin } from 'antd';
import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { describeEvent } from '../../components/kanban/KanbanBoard';
import { LedgerFeed } from '../../components/team/LedgerFeed';
import { SeverityDot } from '../../components/team/SeverityDot';
import { PersonalityMark } from '../../components/ui/PersonalityMark';
import { useKanbanBoard } from '../../features/kanban/api/queries';
import { useTeam } from '../../features/teams/api/queries';
import { useTeamLedger } from '../../hooks/useTeamLedger';
import { formatClock, shortTaskId } from '../../lib/teamPresence';

// Activity (plan/phases/teams-as-a-scope.md §8): the board's recent events
// beside the supervisor ledger, two full-height columns. A member's row
// carries its mark (and `data-p`, D12); the dispatcher's and an operator's
// carry a neutral dot — actors that are not agents get no identity.

const LEDGER_LIMIT = 200;

export function TeamActivity() {
  const { teamId = '' } = useParams<{ teamId: string }>();
  const teamQuery = useTeam(teamId);
  const boardQuery = useKanbanBoard(teamId);
  const ledgerQuery = useTeamLedger(teamId, LEDGER_LIMIT, boardQuery.dataUpdatedAt);

  const board = boardQuery.data?.board ?? null;
  const members = useMemo(
    () => new Set((teamQuery.data?.members ?? []).map((m) => m.personalityId)),
    [teamQuery.data],
  );
  const titles = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of board?.tasks ?? []) m.set(t.id, t.title);
    return m;
  }, [board]);
  // The snapshot is oldest → newest; the feed reads newest first.
  const events = useMemo(() => [...(board?.recentEvents ?? [])].reverse(), [board]);

  if (boardQuery.isLoading) {
    return (
      <div className="team-body team-body-center">
        <Spin />
      </div>
    );
  }
  if (boardQuery.error) {
    return (
      <div className="team-body">
        <Alert type="error" message={boardQuery.error.message} />
      </div>
    );
  }
  if (!board) return null;

  return (
    <div className="team-body">
      <div className="team-ov team-ov-2">
        <div className="team-colv">
          <div className="team-sec">
            Activity <span className="team-sec-cnt">recent</span>
          </div>
          <div className="team-scroll">
            {events.length === 0 ? (
              <div className="team-empty">No activity yet.</div>
            ) : (
              <div className="team-feed">
                {events.map((e) => {
                  const isMember = members.has(e.actor);
                  return (
                    <div
                      key={`${e.taskId}:${e.id}`}
                      className="team-ev"
                      data-p={isMember ? e.actor : undefined}
                    >
                      <span className="team-ev-t">{formatClock(e.createdAt)}</span>
                      {isMember ? (
                        <PersonalityMark personalityId={e.actor} size={14} />
                      ) : (
                        <SeverityDot tone="info" />
                      )}
                      <span className="team-ev-body">
                        <span className="team-ev-who">{e.actor}</span> {describeEvent(e)}{' '}
                        <Link
                          className="team-idlink"
                          to={`/t/${teamId}/board?task=${encodeURIComponent(e.taskId)}`}
                        >
                          #{shortTaskId(e.taskId)}
                        </Link>{' '}
                        {titles.get(e.taskId) ?? ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <div className="team-colv">
          <div className="team-sec">Supervisor ledger</div>
          <div className="team-scroll">
            <LedgerFeed
              items={ledgerQuery.data?.items ?? []}
              teamId={teamId}
              emptyText="Nothing yet."
            />
          </div>
        </div>
      </div>
    </div>
  );
}
