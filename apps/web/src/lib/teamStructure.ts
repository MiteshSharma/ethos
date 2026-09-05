// Pure layout for the team Structure canvas (plan/phases/teams-as-a-scope.md
// §6, D7). Three rows — coordinator on top, members across the middle, the
// shared things (board, team memory, bound channel) along the bottom — with
// orthogonal SVG paths between them. A function of member count and
// container size only; no graph library, no drag. The reference is
// `structure()` in `plan/prototypes/teams-as-a-scope/ethos-team-scope.html`.
//
// The canvas may come back WIDER than it was given: every node must fit on
// its row without overlap, so past a handful of members the returned `width`
// grows and the container scrolls horizontally. Height is only ever clamped
// to the minimum.

export type TeamStructureNodeKind = 'coordinator' | 'member' | 'board' | 'memory' | 'channel';

export interface TeamStructureNode {
  /** The personality id for agents; `board` / `memory` / `channel` for system nodes. */
  id: string;
  kind: TeamStructureNodeKind;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TeamStructureEdge {
  /** Node ids. */
  from: string;
  to: string;
  /** Solid `dispatch` (hub → member) or dashed `shared` (a shared resource). */
  kind: 'dispatch' | 'shared';
  /** SVG path `d` — `M … L … L … L …`, axis-aligned segments only. */
  path: string;
  /** Where a dispatch edge's live label (ticket · age / idle / offline) sits. */
  labelAt?: { x: number; y: number };
}

export interface TeamStructureLayout {
  /** Actual canvas size — at least the minimum, and wide enough for every member. */
  width: number;
  height: number;
  nodes: TeamStructureNode[];
  edges: TeamStructureEdge[];
}

export interface TeamStructureInput {
  width: number;
  height: number;
  /** `null` for a broadcast / undeclared self-routing team — the board becomes the hub. */
  coordinatorId: string | null;
  /** Non-coordinator members, manifest order. */
  memberIds: string[];
  hasChannel: boolean;
}

export const MIN_CANVAS_WIDTH = 720;
export const MIN_CANVAS_HEIGHT = 480;
const AGENT_W = 200;
const NODE_H = 84;
const SYSTEM_W = 180;
// Breathing room between adjacent member nodes when the row has to widen.
const MEMBER_GAP = 16;
// The horizontal margin is 6% of the width on each side, so the member row
// spans 88% of it.
const MARGIN_RATIO = 0.06;

function orthogonal(points: ReadonlyArray<readonly [number, number]>): string {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ');
}

export function layoutTeamStructure(input: TeamStructureInput): TeamStructureLayout {
  const { coordinatorId, memberIds, hasChannel } = input;
  const n = memberIds.length;
  const membersWidth = n * AGENT_W + Math.max(0, n - 1) * MEMBER_GAP;
  const width = Math.max(
    MIN_CANVAS_WIDTH,
    Math.round(input.width),
    Math.ceil(membersWidth / (1 - 2 * MARGIN_RATIO)),
  );
  const height = Math.max(MIN_CANVAS_HEIGHT, Math.round(input.height));

  const margin = Math.round(width * MARGIN_RATIO);
  const hubX = width / 2 - AGENT_W / 2;
  const hubY = Math.round(height * 0.06);
  const memberY = Math.round(height * 0.4);
  const systemY = Math.round(height * 0.74);
  const step = n > 1 ? (width - 2 * margin - AGENT_W) / (n - 1) : 0;
  const memberX = (i: number) => (n > 1 ? Math.round(margin + i * step) : hubX);

  const hubCenterX = width / 2;
  const hubBottom = hubY + NODE_H;
  const hubSideY = hubY + 40;
  const memoryX = width / 2 - SYSTEM_W / 2;
  const channelX = width - margin - SYSTEM_W;
  const dispatchMidY = Math.round((hubBottom + memberY) / 2);
  const sharedMidY = Math.round((memberY + NODE_H + systemY) / 2);

  const nodes: TeamStructureNode[] = [];
  const edges: TeamStructureEdge[] = [];

  // The hub: the coordinator when there is one, else the board takes its slot
  // (a broadcast or self-routing team has no one on top).
  const hubId = coordinatorId ?? 'board';
  nodes.push({
    id: hubId,
    kind: coordinatorId ? 'coordinator' : 'board',
    x: hubX,
    y: hubY,
    w: AGENT_W,
    h: NODE_H,
  });

  memberIds.forEach((id, i) => {
    const x = memberX(i);
    const cx = x + AGENT_W / 2;
    nodes.push({ id, kind: 'member', x, y: memberY, w: AGENT_W, h: NODE_H });
    edges.push({
      from: hubId,
      to: id,
      kind: 'dispatch',
      path: orthogonal([
        [hubCenterX, hubBottom],
        [hubCenterX, dispatchMidY],
        [cx, dispatchMidY],
        [cx, memberY],
      ]),
      labelAt: { x: cx, y: dispatchMidY + 22 },
    });
    edges.push({
      from: id,
      to: 'memory',
      kind: 'shared',
      path: orthogonal([
        [cx, memberY + NODE_H],
        [cx, sharedMidY],
        [hubCenterX, sharedMidY],
        [hubCenterX, systemY],
      ]),
    });
  });

  if (coordinatorId) {
    const boardCenterX = margin + SYSTEM_W / 2;
    nodes.push({ id: 'board', kind: 'board', x: margin, y: systemY, w: SYSTEM_W, h: NODE_H });
    edges.push({
      from: coordinatorId,
      to: 'board',
      kind: 'shared',
      path: orthogonal([
        [hubX, hubSideY],
        [boardCenterX, hubSideY],
        [boardCenterX, systemY],
      ]),
    });
  }

  nodes.push({ id: 'memory', kind: 'memory', x: memoryX, y: systemY, w: SYSTEM_W, h: NODE_H });

  if (hasChannel) {
    const channelCenterX = channelX + SYSTEM_W / 2;
    nodes.push({ id: 'channel', kind: 'channel', x: channelX, y: systemY, w: SYSTEM_W, h: NODE_H });
    edges.push({
      from: hubId,
      to: 'channel',
      kind: 'shared',
      path: orthogonal([
        [hubX + AGENT_W, hubSideY],
        [channelCenterX, hubSideY],
        [channelCenterX, systemY],
      ]),
    });
  }

  return { width, height, nodes, edges };
}
