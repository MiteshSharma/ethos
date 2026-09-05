import type { TeamMemberSummary } from '@ethosagent/web-contracts';
import { PersonalityMark } from '../ui/PersonalityMark';

// The drawer's inline member picker (plan/phases/teams-as-a-scope.md §5,
// D11; prototype `.picker`): one row per manifest member — mark, id, tier
// chip right. Fed by `teams.get().members`, not `kanban.listAgents`, which
// needs the mesh. Choosing is the whole interaction; the parent owns the
// open/closed state and the mutation.

export function AssigneePicker({
  members,
  busy,
  onPick,
}: {
  members: TeamMemberSummary[];
  /** A pick is in flight — rows are disabled so a double-click can't assign twice. */
  busy: boolean;
  onPick: (personalityId: string) => void;
}) {
  return (
    <div className="team-picker" data-testid="assignee-picker">
      <div className="team-k team-picker-h">Assign to</div>
      {members.map((m) => (
        <button
          key={m.personalityId}
          type="button"
          className="team-picker-row"
          disabled={busy}
          onClick={() => onPick(m.personalityId)}
        >
          <PersonalityMark personalityId={m.personalityId} size={16} />
          <span className="team-picker-name">{m.personalityId}</span>
          <span className="team-tier">{m.tier ?? '—'}</span>
        </button>
      ))}
    </div>
  );
}
