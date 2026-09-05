import type { LedgerEvent } from '@ethosagent/web-contracts';
import { Link } from 'react-router-dom';
import { formatClock, shortTaskId } from '../../lib/teamPresence';
import { SeverityDot } from './SeverityDot';

// The supervisor ledger as rows (plan/phases/teams-as-a-scope.md §7):
// `HH:MM:SS` | severity dot | headline `#id` + the reason beneath. The `#id`
// deep-links to the board drawer; `data-p` carries the member for the
// cross-highlight (D12).

export function LedgerFeed({
  items,
  teamId,
  emptyText,
}: {
  items: LedgerEvent[];
  teamId: string;
  emptyText: string;
}) {
  if (items.length === 0) return <div className="team-empty">{emptyText}</div>;
  return (
    <div className="team-feed">
      {items.map((e) => (
        <div key={e.id} className="team-ev" data-p={e.personalityId ?? undefined}>
          <span className="team-ev-t">{formatClock(e.at)}</span>
          <SeverityDot tone={e.severity} />
          <span className="team-ev-body">
            <span className="team-ev-h">{e.headline}</span>
            {e.taskId && (
              <>
                {' '}
                <Link
                  className="team-idlink"
                  to={`/t/${teamId}/board?task=${encodeURIComponent(e.taskId)}`}
                  title={e.taskTitle ?? e.taskId}
                >
                  #{shortTaskId(e.taskId)}
                </Link>
              </>
            )}
            {e.detail && <span className="team-ev-why">{e.detail}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}
