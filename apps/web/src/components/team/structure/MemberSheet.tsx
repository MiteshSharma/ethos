import type {
  KanbanMemberStats,
  KanbanTask,
  LedgerEvent,
  Personality,
  TeamDetail,
  TeamMemberSummary,
} from '@ethosagent/web-contracts';
import { useQuery } from '@tanstack/react-query';
import { Button } from 'antd';
import { Link, useNavigate } from 'react-router-dom';
import { teamAccents } from '../../../features/teams/lib/membership';
import { formatClock, memberPresence, shortTaskId } from '../../../lib/teamPresence';
import { rpc } from '../../../rpc';
import { PersonalityMark } from '../../ui/PersonalityMark';
import { TeamRing } from '../../ui/TeamRing';
import { modelLabel } from './helpers';

// The member side sheet (plan/phases/teams-as-a-scope.md §6): identity, the
// coordinator's "same session either way" note, a character-sheet summary,
// what the member is doing right now, the supervisor ledger filtered to it,
// and the two doors — Chat / Enter workspace and Identity.
//
// The character summary reads `personalities.list` (already loaded for the
// canvas) rather than `personalities.characterSheet`: description, toolset,
// capabilities and fs_reach are all on the list item, so a per-member
// Markdown render would be a second request for the same facts.

export interface MemberSheetProps {
  team: TeamDetail;
  member: TeamMemberSummary;
  personality: Personality | undefined;
  /** `personalities.list` has loaded and this id is not in it. */
  missing: boolean;
  tasks: readonly KanbanTask[];
  memberStats: readonly KanbanMemberStats[];
}

const TOOLSET_PREVIEW = 5;

function toolsetSummary(toolset: string[] | null | undefined): string {
  if (!toolset || toolset.length === 0) return '—';
  const head = toolset.slice(0, TOOLSET_PREVIEW).join(', ');
  return toolset.length > TOOLSET_PREVIEW ? `${head} · +${toolset.length - TOOLSET_PREVIEW}` : head;
}

function fsReachSummary(personality: Personality | undefined): string | null {
  const reach = personality?.fs_reach;
  if (!reach) return null;
  const parts = [...(reach.workdir ?? []), ...(reach.write ?? []), ...(reach.read ?? [])];
  return parts.length > 0 ? [...new Set(parts)].join(', ') : null;
}

export function LedgerRows({ items, teamId }: { items: readonly LedgerEvent[]; teamId: string }) {
  return (
    <div className="team-feed">
      {items.map((ev) => (
        <div className="team-ev" key={ev.id} data-p={ev.personalityId ?? undefined}>
          <span className="team-ev-time">{formatClock(ev.at)}</span>
          <span className="team-ev-dot">
            <span className={`team-dot team-dot-${ev.severity}`} />
          </span>
          <span>
            <span className="team-ev-head">{ev.headline}</span>
            {ev.taskId ? (
              <>
                {' '}
                <Link className="team-idlink" to={`/t/${teamId}/board?task=${ev.taskId}`}>
                  #{shortTaskId(ev.taskId)}
                </Link>
              </>
            ) : null}
            {ev.detail ? <span className="team-ev-why">{ev.detail}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

export function MemberSheet({
  team,
  member,
  personality,
  missing,
  tasks,
  memberStats,
}: MemberSheetProps) {
  const navigate = useNavigate();
  const id = member.personalityId;
  const isCoordinator = team.coordinator === id;
  const presence = memberPresence(member, [...tasks], team.coordinator);
  const ticket = presence.ticketId ? tasks.find((t) => t.id === presence.ticketId) : undefined;
  const stats = memberStats.find((s) => s.memberId === id);
  const lifetimeTotal = stats
    ? stats.ticketsCompleted + stats.ticketsFailed + stats.ticketsOrphaned
    : 0;
  const model = modelLabel(personality);
  const fsReach = fsReachSummary(personality);
  const capabilities =
    member.capabilities.length > 0 ? member.capabilities : (personality?.capabilities ?? []);

  const ledger = useQuery({
    queryKey: ['teams', 'ledger', team.name, id],
    queryFn: () => rpc.teams.ledger({ team: team.name, personalityId: id, limit: 20 }),
    refetchInterval: 5_000,
  });

  const workspace = `/t/${team.name}/p/${id}`;

  return (
    <div className="team-side" data-p={id}>
      <div className="team-side-head">
        <PersonalityMark personalityId={id} size={36} />
        <span style={{ minWidth: 0 }}>
          <span className="team-side-name">{personality?.name ?? id}</span>
          <span className="team-side-sub">
            {[member.role, member.tier ?? 'no tier', model ?? '—'].join(' · ')}
          </span>
        </span>
      </div>

      {missing ? <div className="team-side-missing">personality not found</div> : null}

      {isCoordinator ? (
        <div className="team-side-note" data-testid="coordinator-note">
          <TeamRing accents={teamAccents(team)} size={16} title={team.name} />
          <span>
            Chatting with <b>{team.name}</b> means chatting with {id}. Same session either way.
          </span>
        </div>
      ) : null}

      <div className="team-sec">Character sheet</div>
      <div className="team-kv">
        <b>Purpose</b>
        <span>{personality?.description ?? '—'}</span>
        <b>Capabilities</b>
        <span>{capabilities.length > 0 ? capabilities.join(', ') : '—'}</span>
        <b>Toolset</b>
        <span>{toolsetSummary(personality?.toolset)}</span>
        <b>Memory scope</b>
        <span className="team-mono">
          personality:{id} + team:{team.name}
        </span>
        {fsReach ? (
          <>
            <b>fs_reach</b>
            <span className="team-mono">{fsReach}</span>
          </>
        ) : null}
      </div>

      <div className="team-sec">Right now</div>
      <div className="team-kv">
        <b>State</b>
        <span className="team-kv-inline">
          <span
            className={`team-dot team-dot-${presence.state}${presence.live ? ' team-dot-live' : ''}`}
          />
          {presence.text}
        </span>
        {ticket ? (
          <>
            <b>Ticket</b>
            <span>
              <Link className="team-idlink" to={`/t/${team.name}/board?task=${ticket.id}`}>
                #{shortTaskId(ticket.id)}
              </Link>{' '}
              {ticket.title}
            </span>
          </>
        ) : null}
        <b>Lifetime</b>
        <span>
          {stats ? `${stats.ticketsCompleted} of ${lifetimeTotal} completed` : 'no tickets yet'}
        </span>
      </div>

      <div className="team-sec">Supervisor on {id}</div>
      {ledger.data && ledger.data.items.length > 0 ? (
        <LedgerRows items={ledger.data.items} teamId={team.name} />
      ) : (
        <div className="team-side-para">
          {ledger.isPending ? 'Loading…' : `Nothing in the ledger about ${id} yet.`}
        </div>
      )}

      <div className="team-btns">
        <Button type="primary" size="small" onClick={() => navigate(`${workspace}/chat`)}>
          {isCoordinator ? 'Chat' : 'Enter workspace'}
        </Button>
        <Button size="small" onClick={() => navigate(`${workspace}/identity`)}>
          Identity
        </Button>
      </div>
    </div>
  );
}
