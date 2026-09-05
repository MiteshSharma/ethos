import type { KanbanBoardSnapshot, KanbanTaskStatus } from '@ethosagent/web-contracts';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { buildChildCounts, TaskTile, taskReasons } from '../kanban/KanbanBoard';
import { type DotTone, SeverityDot } from './SeverityDot';

// The Overview's middle column (plan/phases/teams-as-a-scope.md §4, D5):
// tickets grouped by what they need from you, most urgent first. The tiles
// are the existing Task tile — the one Card exemption reused, not a new one
// (DESIGN.md "Cards earn existence") — and every tile opens the board drawer.

const GROUPS: ReadonlyArray<{ status: KanbanTaskStatus; label: string; tone: DotTone | null }> = [
  { status: 'needs_revision', label: 'Needs revision', tone: 'warn' },
  { status: 'blocked', label: 'Blocked', tone: 'err' },
  { status: 'running', label: 'Running', tone: 'ok' },
  { status: 'ready', label: 'Ready', tone: null },
];

const NO_SELECTION: Set<string> = new Set();
const noop = () => undefined;

export function AttentionGroups({
  snapshot,
  teamId,
}: {
  snapshot: KanbanBoardSnapshot;
  teamId: string;
}) {
  const navigate = useNavigate();
  const childCounts = useMemo(() => buildChildCounts(snapshot), [snapshot]);
  const reasons = useMemo(() => taskReasons(snapshot.recentEvents), [snapshot.recentEvents]);
  const groups = GROUPS.map((g) => ({
    ...g,
    tasks: snapshot.tasks.filter((t) => t.status === g.status),
  })).filter((g) => g.tasks.length > 0);

  if (groups.length === 0) return <div className="team-empty">Nothing open.</div>;

  const open = (id: string) => navigate(`/t/${teamId}/board?task=${encodeURIComponent(id)}`);

  return (
    <>
      {groups.map((g) => (
        <div key={g.status} className="team-group" data-group={g.status}>
          <div className="team-group-h">
            {g.tone && <SeverityDot tone={g.tone} live={g.tone === 'ok'} />}
            {g.label}
            <span className="team-group-cnt">{g.tasks.length}</span>
          </div>
          {g.tasks.map((t) => (
            <TaskTile
              key={t.id}
              task={t}
              childCount={childCounts.get(t.id)}
              reason={reasons.get(t.id)}
              teamName={teamId}
              onSelect={open}
              selectMode={false}
              selected={NO_SELECTION}
              onToggleSelect={noop}
            />
          ))}
        </div>
      ))}
    </>
  );
}
