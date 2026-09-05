import type { MemberPresence } from '../../../lib/teamPresence';
import { shortTaskId } from '../../../lib/teamPresence';
import type { TeamStructureNode } from '../../../lib/teamStructure';
import { NavIcon, type NavIconKey } from '../../ui/NavIcon';
import { PersonalityMark } from '../../ui/PersonalityMark';

// One node on the Structure canvas (plan/phases/teams-as-a-scope.md §6, D7).
// Agent nodes are 200×84: mark + name + tier chip, `role · model`, then the
// live state line. System nodes (board, memory, channel) are 180 wide with a
// dashed border: icon + label + mono subtitle. Both are `<button>`s so Enter /
// Space select them; the canvas owns the click / double-click handlers.
// A bordered container from primitives, not a `Card` (DESIGN.md).

export interface AgentNodeProps {
  kind: 'agent';
  node: TeamStructureNode;
  name: string;
  role: 'coordinator' | 'member';
  tier: string | null;
  /** Null when `personalities.list` has not loaded; omitted from the line then. */
  model: string | null;
  /** The personality directory is missing — dashed error border (§6). */
  missing: boolean;
  presence: MemberPresence;
  /** Title of the ticket in `presence.ticketId`, when the board has it. */
  ticketTitle: string | null;
}

export interface SystemNodeProps {
  kind: 'system';
  node: TeamStructureNode;
  icon: NavIconKey;
  label: string;
  subtitle: string;
}

export type StructureNodeProps = (AgentNodeProps | SystemNodeProps) & {
  selected: boolean;
  onSelect: (id: string) => void;
  onEnter?: (id: string) => void;
};

const TITLE_CHARS = 24;

function truncate(title: string): string {
  return title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS)}…` : title;
}

export function StructureNode(props: StructureNodeProps) {
  const { node, selected, onSelect, onEnter } = props;
  const style = { left: node.x, top: node.y };
  const base = `team-node${selected ? ' team-node-sel' : ''}`;

  if (props.kind === 'system') {
    return (
      <button
        type="button"
        className={`${base} team-node-sys`}
        style={style}
        data-node={node.id}
        aria-pressed={selected}
        onClick={() => onSelect(node.id)}
      >
        <div className="team-node-head">
          <NavIcon icon={props.icon} />
          <span className="team-node-name">{props.label}</span>
        </div>
        <div className="team-node-meta" title={props.subtitle}>
          {props.subtitle}
        </div>
      </button>
    );
  }

  const { presence, ticketTitle } = props;
  const meta = [
    props.role,
    ...(props.role === 'coordinator' ? ['fronts the team'] : []),
    ...(props.model ? [props.model] : []),
  ].join(' · ');
  const dot = `team-dot team-dot-${presence.state}${presence.live ? ' team-dot-live' : ''}`;

  return (
    <button
      type="button"
      className={`${base}${props.missing ? ' team-node-missing' : ''}`}
      style={style}
      data-node={node.id}
      data-p={node.id}
      aria-pressed={selected}
      onClick={() => onSelect(node.id)}
      onDoubleClick={onEnter ? () => onEnter(node.id) : undefined}
    >
      <div className="team-node-head">
        <PersonalityMark personalityId={node.id} size={20} />
        <span className="team-node-name">{props.name}</span>
        {props.tier ? <span className="team-tier">{props.tier}</span> : null}
      </div>
      <div className="team-node-meta" title={meta}>
        {meta}
      </div>
      <div className="team-node-cur">
        <span className={dot} />
        {presence.ticketId ? (
          <span className="team-node-cur-text">
            <span className="team-node-id">#{shortTaskId(presence.ticketId)}</span>{' '}
            {ticketTitle ? truncate(ticketTitle) : presence.state === 'err' ? 'blocked' : ''}
          </span>
        ) : (
          <span className="team-node-cur-text">{presence.text}</span>
        )}
      </div>
    </button>
  );
}
