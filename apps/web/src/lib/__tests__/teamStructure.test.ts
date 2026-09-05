import { describe, expect, it } from 'vitest';
import {
  layoutTeamStructure,
  MIN_CANVAS_HEIGHT,
  MIN_CANVAS_WIDTH,
  type TeamStructureLayout,
  type TeamStructureNode,
} from '../teamStructure';

// plan/phases/teams-as-a-scope.md §6 — the Structure canvas layout is a pure
// function of member count and container size. Invariants checked over the
// whole grid of shapes: no two nodes overlap, every node is inside the
// canvas, every edge starts and ends ON a node's boundary, and the same
// input always yields the same output (resize recomputation is pure).

const members = (n: number) => Array.from({ length: n }, (_, i) => `member-${i + 1}`);

function pathPoints(path: string): Array<[number, number]> {
  return path
    .split(/\s*[ML]/)
    .filter(Boolean)
    .map((pair) => {
      const [x, y] = pair.trim().split(/\s+/).map(Number);
      return [x ?? Number.NaN, y ?? Number.NaN];
    });
}

function onBoundary(node: TeamStructureNode, [x, y]: [number, number]): boolean {
  const withinX = x >= node.x && x <= node.x + node.w;
  const withinY = y >= node.y && y <= node.y + node.h;
  const onVerticalEdge = (x === node.x || x === node.x + node.w) && withinY;
  const onHorizontalEdge = (y === node.y || y === node.y + node.h) && withinX;
  return onVerticalEdge || onHorizontalEdge;
}

function overlaps(a: TeamStructureNode, b: TeamStructureNode): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function nodeById(layout: TeamStructureLayout, id: string): TeamStructureNode {
  const node = layout.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
}

function assertInvariants(layout: TeamStructureLayout) {
  for (const a of layout.nodes) {
    expect(a.x).toBeGreaterThanOrEqual(0);
    expect(a.y).toBeGreaterThanOrEqual(0);
    expect(a.x + a.w).toBeLessThanOrEqual(layout.width);
    expect(a.y + a.h).toBeLessThanOrEqual(layout.height);
    for (const b of layout.nodes) {
      if (a !== b) expect(overlaps(a, b)).toBe(false);
    }
  }
  for (const edge of layout.edges) {
    const points = pathPoints(edge.path);
    const first = points[0];
    const last = points[points.length - 1];
    if (!first || !last) throw new Error(`empty path ${edge.path}`);
    expect(onBoundary(nodeById(layout, edge.from), first)).toBe(true);
    expect(onBoundary(nodeById(layout, edge.to), last)).toBe(true);
    // Orthogonal: consecutive points share an x or a y.
    for (let i = 1; i < points.length; i++) {
      const p = points[i - 1];
      const q = points[i];
      if (!p || !q) throw new Error('missing point');
      expect(p[0] === q[0] || p[1] === q[1]).toBe(true);
    }
  }
}

describe('layoutTeamStructure — invariants over every shape', () => {
  const sizes = [
    { width: 720, height: 480 },
    { width: 900, height: 560 },
    { width: 1280, height: 720 },
  ];
  for (const count of [0, 1, 3, 8]) {
    for (const coordinatorId of ['cmo', null]) {
      for (const hasChannel of [true, false]) {
        for (const size of sizes) {
          it(`${count} members, coordinator=${coordinatorId ?? 'none'}, channel=${hasChannel}, ${size.width}×${size.height}`, () => {
            assertInvariants(
              layoutTeamStructure({
                ...size,
                coordinatorId,
                memberIds: members(count),
                hasChannel,
              }),
            );
          });
        }
      }
    }
  }
});

describe('layoutTeamStructure — positions', () => {
  const base = { width: 1000, height: 600, hasChannel: true };

  it('puts the coordinator centred at 6% of the height', () => {
    const layout = layoutTeamStructure({ ...base, coordinatorId: 'cmo', memberIds: members(3) });
    expect(nodeById(layout, 'cmo')).toMatchObject({
      kind: 'coordinator',
      x: 400,
      y: 36,
      w: 200,
      h: 84,
    });
  });

  it('spreads members evenly across [6%, 94% − 200] at 40% of the height', () => {
    const layout = layoutTeamStructure({ ...base, coordinatorId: 'cmo', memberIds: members(3) });
    const xs = members(3).map((id) => nodeById(layout, id).x);
    expect(xs).toEqual([60, 400, 740]);
    for (const id of members(3)) expect(nodeById(layout, id).y).toBe(240);
  });

  it('centres a single member under the coordinator', () => {
    const layout = layoutTeamStructure({ ...base, coordinatorId: 'cmo', memberIds: members(1) });
    expect(nodeById(layout, 'member-1').x).toBe(nodeById(layout, 'cmo').x);
  });

  it('lays system nodes along 74% of the height: board left, memory centre, channel right', () => {
    const layout = layoutTeamStructure({ ...base, coordinatorId: 'cmo', memberIds: members(3) });
    expect(nodeById(layout, 'board')).toMatchObject({ x: 60, y: 444, w: 180 });
    expect(nodeById(layout, 'memory')).toMatchObject({ x: 410, y: 444, w: 180 });
    expect(nodeById(layout, 'channel')).toMatchObject({ x: 760, y: 444, w: 180 });
  });

  it('omits the channel node and edge when no channel is bound', () => {
    const layout = layoutTeamStructure({
      ...base,
      hasChannel: false,
      coordinatorId: 'cmo',
      memberIds: members(3),
    });
    expect(layout.nodes.find((n) => n.id === 'channel')).toBeUndefined();
    expect(layout.edges.find((e) => e.to === 'channel')).toBeUndefined();
  });

  it('without a coordinator the board takes the hub slot and members hang from it', () => {
    const layout = layoutTeamStructure({ ...base, coordinatorId: null, memberIds: members(3) });
    expect(nodeById(layout, 'board')).toMatchObject({ kind: 'board', x: 400, y: 36, w: 200 });
    expect(layout.nodes.filter((n) => n.kind === 'coordinator')).toEqual([]);
    expect(layout.nodes.filter((n) => n.kind === 'board')).toHaveLength(1);
    const dispatch = layout.edges.filter((e) => e.kind === 'dispatch');
    expect(dispatch.map((e) => e.from)).toEqual(['board', 'board', 'board']);
    expect(layout.edges.find((e) => e.to === 'channel')?.from).toBe('board');
  });

  it('clamps the canvas to the 720×480 minimum', () => {
    const layout = layoutTeamStructure({
      width: 300,
      height: 200,
      hasChannel: false,
      coordinatorId: 'cmo',
      memberIds: members(1),
    });
    expect(layout.width).toBe(MIN_CANVAS_WIDTH);
    expect(layout.height).toBe(MIN_CANVAS_HEIGHT);
  });

  it('widens the canvas so eight members fit on one row; height is untouched', () => {
    const layout = layoutTeamStructure({
      width: 1280,
      height: 720,
      hasChannel: true,
      coordinatorId: 'cmo',
      memberIds: members(8),
    });
    expect(layout.width).toBeGreaterThan(1280);
    expect(layout.height).toBe(720);
  });

  it('is pure — the same input yields the same layout on recomputation', () => {
    const input = { ...base, coordinatorId: 'cmo', memberIds: members(3) };
    expect(layoutTeamStructure(input)).toEqual(layoutTeamStructure(input));
  });
});

describe('layoutTeamStructure — edges', () => {
  const layout = layoutTeamStructure({
    width: 1000,
    height: 600,
    hasChannel: true,
    coordinatorId: 'cmo',
    memberIds: members(2),
  });

  it('routes dispatch edges from the hub bottom via the midpoint y to the member top', () => {
    const edge = layout.edges.find((e) => e.kind === 'dispatch' && e.to === 'member-1');
    expect(edge?.path).toBe('M500 120 L500 180 L160 180 L160 240');
    expect(edge?.labelAt).toEqual({ x: 160, y: 202 });
  });

  it('routes member → memory dashed edges via the lower midpoint', () => {
    const edge = layout.edges.find((e) => e.from === 'member-1' && e.to === 'memory');
    expect(edge?.kind).toBe('shared');
    expect(edge?.path).toBe('M160 324 L160 384 L500 384 L500 444');
  });

  it('routes coordinator ↔ board and ↔ channel from the coordinator sides at top + 40', () => {
    expect(layout.edges.find((e) => e.to === 'board')?.path).toBe('M400 76 L150 76 L150 444');
    expect(layout.edges.find((e) => e.to === 'channel')?.path).toBe('M600 76 L850 76 L850 444');
  });

  it('only dispatch edges carry a label anchor', () => {
    for (const edge of layout.edges) {
      expect(edge.labelAt !== undefined).toBe(edge.kind === 'dispatch');
    }
  });
});
