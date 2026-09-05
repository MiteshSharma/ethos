import type { KanbanTask, TeamMemberSummary } from '@ethosagent/web-contracts';
import { Link } from 'react-router-dom';
import { memberPresence, shortTaskId } from '../../lib/teamPresence';
import { buildWorkspaceChatPath } from '../../lib/workspaceRoutes';
import { PersonalityMark } from '../ui/PersonalityMark';
import { SeverityDot } from './SeverityDot';

// One member of the Overview's Members column (plan/phases/teams-as-a-scope.md
// §4): 26px mark, name (+ `coordinator` in mono), the live state line, tier
// chip right. The whole row opens the member's workspace inside the team
// (D6). `data-p` is the cross-highlight hook (D12; wired in T4).

export function MemberRow({
  teamId,
  member,
  tasks,
  coordinator,
  reasons,
}: {
  teamId: string;
  member: TeamMemberSummary;
  tasks: KanbanTask[];
  coordinator: string | null;
  reasons?: Map<string, string>;
}) {
  const presence = memberPresence(member, tasks, coordinator, reasons);
  const idPrefix = presence.ticketId ? `#${shortTaskId(presence.ticketId)}` : null;
  const rest =
    idPrefix && presence.text.startsWith(idPrefix)
      ? presence.text.slice(idPrefix.length)
      : presence.text;

  return (
    <Link
      to={buildWorkspaceChatPath(member.personalityId, teamId)}
      className="team-mrow"
      data-p={member.personalityId}
    >
      <PersonalityMark personalityId={member.personalityId} size={26} />
      <span className="team-mrow-main">
        <span className="team-mrow-nm">
          {member.personalityId}
          {member.role === 'coordinator' && <span className="team-mrow-role">coordinator</span>}
        </span>
        <span className="team-mrow-st">
          <SeverityDot tone={presence.state} live={presence.live} />
          <span className="team-mrow-txt" title={presence.text}>
            {idPrefix && <span className="team-mrow-id">{idPrefix}</span>}
            {rest}
          </span>
        </span>
      </span>
      <span className="team-tier">{member.tier ?? '—'}</span>
    </Link>
  );
}
