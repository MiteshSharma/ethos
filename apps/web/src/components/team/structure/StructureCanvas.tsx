import type { KanbanTask, Personality, TeamDetail } from '@ethosagent/web-contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  humanDuration,
  type MemberPresence,
  memberPresence,
  shortTaskId,
} from '../../../lib/teamPresence';
import {
  layoutTeamStructure,
  MIN_CANVAS_HEIGHT,
  MIN_CANVAS_WIDTH,
  type TeamStructureLayout,
} from '../../../lib/teamStructure';
import { formatRelative } from '../../kanban/KanbanBoard';
import { modelLabel, openCount, primaryChannel, trustMode } from './helpers';
import { StructureNode } from './StructureNode';

// The Structure canvas (plan/phases/teams-as-a-scope.md §6, D7): one SVG of
// orthogonal edges and their live labels, then absolutely positioned node
// buttons on top. Layout is `layoutTeamStructure` — a pure function of the
// member list and the container size, fed by a ResizeObserver; the SVG is
// rendered at the layout's own size inside a scrolling container, so a wide
// member row scrolls rather than overlaps. No drag, no graph library.

export interface StructureCanvasProps {
  team: TeamDetail;
  tasks: readonly KanbanTask[];
  /** `personalities.list` items — for the model line and the missing-directory border. */
  personalities: readonly Personality[] | undefined;
  selectedId: string;
  onSelect: (id: string) => void;
  /** Double-click on an agent node. */
  onEnter: (personalityId: string) => void;
}

/** The compact edge label: `#41 · 12m ago`, `#38 · blocked`, `offline`, `idle`. */
export function edgeLabel(presence: MemberPresence, task: KanbanTask | undefined): string {
  if (presence.ticketId) {
    const tail = presence.state === 'err' ? 'blocked' : task ? formatRelative(task.updatedAt) : '';
    return tail
      ? `#${shortTaskId(presence.ticketId)} · ${tail}`
      : `#${shortTaskId(presence.ticketId)}`;
  }
  if (presence.state === 'dim') return 'offline';
  return presence.text.split(' · ')[0] ?? presence.text;
}

function useContainerSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ width: MIN_CANVAS_WIDTH, height: MIN_CANVAS_HEIGHT });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const rect = el.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

export function StructureCanvas({
  team,
  tasks,
  personalities,
  selectedId,
  onSelect,
  onEnter,
}: StructureCanvasProps) {
  const areaRef = useRef<HTMLDivElement>(null);
  const size = useContainerSize(areaRef);

  const coordinatorId = team.coordinator;
  const memberIds = useMemo(
    () => team.members.map((m) => m.personalityId).filter((id) => id !== coordinatorId),
    [team.members, coordinatorId],
  );
  const channel = primaryChannel(team);

  const layout: TeamStructureLayout = useMemo(
    () =>
      layoutTeamStructure({
        width: size.width,
        height: size.height,
        coordinatorId,
        memberIds,
        hasChannel: channel !== null,
      }),
    [size.width, size.height, coordinatorId, memberIds, channel],
  );

  const byId = useMemo(() => new Map(personalities?.map((p) => [p.id, p])), [personalities]);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const presence = useMemo(() => {
    const map = new Map<string, MemberPresence>();
    for (const m of team.members) {
      map.set(m.personalityId, memberPresence(m, [...tasks], coordinatorId));
    }
    return map;
  }, [team.members, tasks, coordinatorId]);

  const nodeById = new Map(layout.nodes.map((n) => [n.id, n]));
  const boardNode = nodeById.get('board');
  const memoryNode = nodeById.get('memory');
  const channelNode = nodeById.get('channel');
  const boardIsHub = coordinatorId === null;
  const topics = team.memoryTopics.length;

  return (
    <div className="team-canvas-area" ref={areaRef}>
      <div className="team-canvas-surface" style={{ width: layout.width, height: layout.height }}>
        <svg
          className="team-canvas-svg"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          aria-hidden="true"
        >
          <g>
            {layout.edges.map((e) => (
              <path
                key={`${e.from}->${e.to}`}
                d={e.path}
                className={`team-edge${e.kind === 'shared' ? ' team-edge-shared' : ''}`}
              />
            ))}
          </g>
          <g>
            {layout.edges.map((e) => {
              if (e.kind !== 'dispatch' || !e.labelAt) return null;
              const p = presence.get(e.to);
              if (!p) return null;
              const task = p.ticketId ? taskById.get(p.ticketId) : undefined;
              return (
                <g key={`label:${e.to}`} data-edge-label={e.to}>
                  <circle
                    cx={e.labelAt.x}
                    cy={e.labelAt.y}
                    r={3}
                    className={`team-edge-dot-${p.state}`}
                  />
                  <text x={e.labelAt.x + 8} y={e.labelAt.y + 4} className="team-edge-label">
                    {edgeLabel(p, task)}
                  </text>
                </g>
              );
            })}
            {memoryNode ? (
              <text
                x={memoryNode.x + memoryNode.w / 2 + 6}
                y={memoryNode.y - 14}
                className="team-edge-label"
              >
                {`team_memory_* · ${topics} ${topics === 1 ? 'topic' : 'topics'}`}
              </text>
            ) : null}
            {boardNode && !boardIsHub ? (
              <text x={boardNode.x + 96} y={boardNode.y - 10} className="team-edge-label">
                {`board.db · ${team.dispatchMode}`}
              </text>
            ) : null}
            {channelNode && channel ? (
              <text
                x={channelNode.x + channelNode.w / 2 - 6}
                y={channelNode.y - 10}
                textAnchor="end"
                className="team-edge-label"
              >
                {`${channel.botKey} → ${coordinatorId ?? 'board'}`}
              </text>
            ) : null}
          </g>
        </svg>

        {layout.nodes.map((node) => {
          if (node.kind === 'coordinator' || node.kind === 'member') {
            const member = team.members.find((m) => m.personalityId === node.id);
            const p = presence.get(node.id) ?? {
              state: 'dim' as const,
              live: false,
              text: 'offline',
              ticketId: null,
            };
            const personality = byId.get(node.id);
            const ticket = p.ticketId ? taskById.get(p.ticketId) : undefined;
            return (
              <StructureNode
                key={node.id}
                kind="agent"
                node={node}
                name={personality?.name ?? node.id}
                role={node.kind === 'coordinator' ? 'coordinator' : 'member'}
                tier={member?.tier ?? null}
                model={modelLabel(personality)}
                missing={personalities !== undefined && !personality}
                presence={p}
                ticketTitle={ticket?.title ?? null}
                selected={selectedId === node.id}
                onSelect={onSelect}
                onEnter={onEnter}
              />
            );
          }
          if (node.kind === 'board') {
            return (
              <StructureNode
                key={node.id}
                kind="system"
                node={node}
                icon="board"
                label="Board"
                subtitle={`${openCount(tasks)} open · stale after ${humanDuration(team.kanban.staleMs)} · ${trustMode(team)} trust`}
                selected={selectedId === node.id}
                onSelect={onSelect}
              />
            );
          }
          if (node.kind === 'memory') {
            return (
              <StructureNode
                key={node.id}
                kind="system"
                node={node}
                icon="memory"
                label="Team memory"
                subtitle={`teams/${team.name}/memory/ · ${topics} ${topics === 1 ? 'topic' : 'topics'}`}
                selected={selectedId === node.id}
                onSelect={onSelect}
              />
            );
          }
          return (
            <StructureNode
              key={node.id}
              kind="system"
              node={node}
              icon="channels"
              label="Channel"
              subtitle={`${channel?.platform ?? ''} ${channel?.botKey ?? ''} · bind: team · via ${coordinatorId ?? 'board'}`}
              selected={selectedId === node.id}
              onSelect={onSelect}
            />
          );
        })}
      </div>

      <div className="team-legend">
        <span>
          <i />
          dispatch
        </span>
        <span>
          <i className="team-legend-dashed" />
          shared
        </span>
      </div>
      <div className="team-canvas-hint">click a node · double-click a member to enter</div>
    </div>
  );
}
