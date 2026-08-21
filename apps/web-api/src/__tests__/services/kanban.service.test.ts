import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KanbanStore } from '@ethosagent/kanban-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KanbanService } from '../../services/kanban.service';

// Drive the service against a real on-disk teams directory so we exercise the
// manifest read, runtime probe, and SQLite open paths the way the live server
// would. No HTTP — that's covered by the routes test layer.

describe('KanbanService', () => {
  let dir: string;
  let service: KanbanService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kanban-svc-'));
    service = new KanbanService({ teamsDir: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeManifest(name: string, content: string): void {
    writeFileSync(join(dir, `${name}.yaml`), content);
  }

  function openBoard(name: string): KanbanStore {
    mkdirSync(join(dir, name), { recursive: true });
    return new KanbanStore(join(dir, name, 'board.db'));
  }

  // ---------------------------------------------------------------------------
  // list
  // ---------------------------------------------------------------------------

  it('list returns the global board even when no teams exist', async () => {
    const { teams } = await service.list();
    expect(teams).toHaveLength(1);
    expect(teams[0]?.name).toBe('global');
    expect(teams[0]?.boardModifiedAt).toBeNull();
  });

  it('list returns parsed teams from manifests on disk', async () => {
    writeManifest(
      'analytics',
      `
name: analytics
description: Quarterly analytics roadmap
domain_capabilities: [analytics]
coordinator: coordinator
members:
  - personality: coordinator
    role: coordinator
  - personality: data-engineer
    role: member
`,
    );

    const { teams } = await service.list();
    expect(teams).toHaveLength(2);
    expect(teams[0]?.name).toBe('global');
    const analytics = teams[1];
    expect(analytics?.name).toBe('analytics');
    expect(analytics?.dispatchMode).toBe('coordinator');
    expect(analytics?.memberCount).toBe(2);
    expect(analytics?.health).toBe('stopped'); // no runtime file
    expect(analytics?.boardModifiedAt).toBeNull();
  });

  it('list skips malformed manifests instead of throwing', async () => {
    writeManifest(
      'good',
      `
name: good
description: ok
domain_capabilities: [x]
members:
  - personality: alpha
`,
    );
    writeManifest('bad', 'this: is: not: valid: yaml:::');

    const { teams } = await service.list();
    expect(teams.map((t) => t.name)).toEqual(['global', 'good']);
  });

  it('list reports boardModifiedAt when a board.db exists', async () => {
    writeManifest(
      'analytics',
      `
name: analytics
description: x
domain_capabilities: [x]
members:
  - personality: alpha
`,
    );
    const store = openBoard('analytics');
    store.createTask({ title: 'first' });
    store.close();

    const { teams } = await service.list();
    // teams[0] is the global board; the analytics board with board.db is teams[1].
    const analytics = teams.find((t) => t.name === 'analytics');
    expect(analytics?.boardModifiedAt).not.toBeNull();
    // ISO-8601 sanity check.
    expect(() => new Date(analytics?.boardModifiedAt ?? '')).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // getBoard
  // ---------------------------------------------------------------------------

  it('getBoard returns the team summary + tasks + links + recent events', async () => {
    writeManifest(
      'analytics',
      `
name: analytics
description: x
domain_capabilities: [x]
coordinator: coordinator
members:
  - personality: coordinator
    role: coordinator
  - personality: engineer
    role: member
`,
    );
    const store = openBoard('analytics');
    const goal = store.createTask({ title: 'Q3 roadmap', actor: 'coordinator' });
    const child = store.createTask({
      title: 'do the thing',
      assignee: 'engineer',
      parents: [goal.id],
      actor: 'coordinator',
    });
    store.updateStatus(child.id, 'running', undefined, 'engineer');
    store.close();

    const { board } = await service.getBoard('analytics');
    expect(board.team.name).toBe('analytics');
    expect(board.tasks.map((t) => t.id).sort()).toEqual([goal.id, child.id].sort());
    // The link writeback came through createTask({parents}).
    expect(board.links).toEqual([{ parentId: goal.id, childId: child.id }]);
    // Audit trail surfaces.
    const kinds = board.recentEvents.map((e) => e.kind);
    expect(kinds).toContain('created');
    expect(kinds).toContain('linked');
    expect(kinds).toContain('status_changed');
    expect(kinds).toContain('run_started');
  });

  it('getBoard threads retryCount and maxRetries into the ticket response shape', async () => {
    writeManifest(
      'analytics',
      `
name: analytics
description: x
domain_capabilities: [x]
members:
  - personality: engineer
`,
    );
    const store = openBoard('analytics');
    // A task with a retry budget that has been re-claimed once.
    const task = store.createTask({ title: 'flaky task', maxRetries: 3, assignee: 'engineer' });
    store.updateStatus(task.id, 'running', undefined, 'engineer');
    store.blockRun(task.id, 'stalled', 'engineer');
    store.updateStatus(task.id, 'running', undefined, 'engineer'); // re-claim -> retryCount 1
    // A plain task with no budget configured.
    const plain = store.createTask({ title: 'plain task' });
    store.close();

    const { board } = await service.getBoard('analytics');
    const wire = board.tasks.find((t) => t.id === task.id);
    expect(wire?.retryCount).toBe(1);
    expect(wire?.maxRetries).toBe(3);
    const wirePlain = board.tasks.find((t) => t.id === plain.id);
    expect(wirePlain?.retryCount).toBe(0);
    expect(wirePlain?.maxRetries).toBeNull();
  });

  it('getBoard threads per-member stats into the board snapshot', async () => {
    writeManifest(
      'analytics',
      `
name: analytics
description: x
domain_capabilities: [x]
members:
  - personality: engineer
`,
    );
    // Open the board WITH a teamId so terminal transitions record member stats.
    mkdirSync(join(dir, 'analytics'), { recursive: true });
    const store = new KanbanStore(join(dir, 'analytics', 'board.db'), { teamId: 'analytics' });
    const done = store.createTask({ title: 'done task', assignee: 'engineer' });
    store.updateStatus(done.id, 'running', undefined, 'engineer');
    store.completeRun(done.id, 'ok', 'engineer');
    const failed = store.createTask({ title: 'failed task', assignee: 'engineer' });
    store.updateStatus(failed.id, 'running', undefined, 'engineer');
    store.updateStatus(failed.id, 'needs_revision', 'nope', 'reviewer');
    store.close();

    const { board } = await service.getBoard('analytics');
    expect(board.memberStats).toHaveLength(1);
    const stat = board.memberStats[0];
    expect(stat).toMatchObject({
      teamId: 'analytics',
      memberId: 'engineer',
      ticketsCompleted: 1,
      ticketsFailed: 1,
      ticketsOrphaned: 0,
    });
  });

  it('getBoard returns an empty snapshot when no board.db exists yet', async () => {
    writeManifest(
      'analytics',
      `
name: analytics
description: x
domain_capabilities: [x]
members:
  - personality: alpha
`,
    );
    const { board } = await service.getBoard('analytics');
    expect(board.tasks).toEqual([]);
    expect(board.links).toEqual([]);
    expect(board.recentEvents).toEqual([]);
    expect(board.memberStats).toEqual([]);
  });

  it('getBoard rejects unknown teams', async () => {
    await expect(service.getBoard('does-not-exist')).rejects.toThrow(/team not found/);
  });

  // ---------------------------------------------------------------------------
  // getEventsSince
  // ---------------------------------------------------------------------------

  it('getEventsSince returns only events after the given id, ascending', async () => {
    writeManifest(
      'analytics',
      `
name: analytics
description: x
domain_capabilities: [x]
members:
  - personality: alpha
`,
    );
    const store = openBoard('analytics');
    const task = store.createTask({ title: 'first' }); // 'created' event
    store.updateStatus(task.id, 'running', undefined, 'alpha'); // 'status_changed' event
    store.close();

    const all = await service.getEventsSince('analytics', 0);
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.map((e) => e.id)).toEqual([...all.map((e) => e.id)].sort((a, b) => a - b));

    const firstId = all[0]?.id ?? 0;
    const rest = await service.getEventsSince('analytics', firstId);
    expect(rest.map((e) => e.id)).toEqual(all.slice(1).map((e) => e.id));
  });

  it('getEventsSince returns an empty array when no board.db exists yet', async () => {
    writeManifest(
      'analytics',
      `
name: analytics
description: x
domain_capabilities: [x]
members:
  - personality: alpha
`,
    );
    await expect(service.getEventsSince('analytics', 0)).resolves.toEqual([]);
  });

  it('getEventsSince rejects path-traversal team names', async () => {
    await expect(service.getEventsSince('..', 0)).rejects.toThrow(/invalid team name/);
  });

  // ---------------------------------------------------------------------------
  // updateStatus — path-traversal guard
  // ---------------------------------------------------------------------------

  it('rejects path-traversal team names on getBoard and updateStatus', async () => {
    await expect(service.getBoard('..')).rejects.toThrow(/invalid team name/);
    await expect(service.getBoard('foo/bar')).rejects.toThrow(/invalid team name/);
    await expect(
      service.updateStatus({ team: '..', taskId: 't_x', status: 'done', actor: 'human:test' }),
    ).rejects.toThrow(/invalid team name/);
  });

  it('rejects path-traversal team names on bulkUpdateStatus and bulkAssign', async () => {
    await expect(
      service.bulkUpdateStatus({
        team: '..',
        taskIds: ['t_x'],
        status: 'done',
        actor: 'human:test',
      }),
    ).rejects.toThrow(/invalid team name/);
    await expect(
      service.bulkAssign({
        team: '..',
        taskIds: ['t_x'],
        assignee: 'engineer',
        actor: 'human:test',
      }),
    ).rejects.toThrow(/invalid team name/);
  });

  it('updateStatus writes through the store and tags the actor', async () => {
    writeManifest(
      'analytics',
      `
name: analytics
description: x
domain_capabilities: [x]
members:
  - personality: alpha
`,
    );
    const store = openBoard('analytics');
    const t = store.createTask({ title: 'work' });
    store.close();

    const { task } = await service.updateStatus({
      team: 'analytics',
      taskId: t.id,
      status: 'done',
      reason: 'closed via UI',
      actor: 'human:control-center',
    });
    expect(task.status).toBe('done');

    // Re-open and confirm the audit event records the human actor.
    const reread = new KanbanStore(join(dir, 'analytics', 'board.db'));
    const events = reread.listEvents(t.id);
    const statusChange = events.find((e) => e.kind === 'status_changed');
    expect(statusChange?.actor).toBe('human:control-center');
    reread.close();
  });

  it('updateStatus to a terminal state records member stats (teamId wired through write path)', async () => {
    writeManifest(
      'analytics',
      `
name: analytics
description: x
domain_capabilities: [x]
members:
  - personality: engineer
`,
    );
    // Open WITHOUT a teamId here — only the seed data goes in. The stat write
    // must come from KanbanService.updateStatus opening the board with teamId.
    const store = openBoard('analytics');
    const t = store.createTask({ title: 'flaky work', assignee: 'engineer' });
    store.updateStatus(t.id, 'running', undefined, 'engineer');
    store.close();

    await service.updateStatus({
      team: 'analytics',
      taskId: t.id,
      status: 'needs_revision',
      reason: 'rejected via UI',
      actor: 'human:control-center',
    });

    // Re-open with the teamId and confirm the human-driven transition was
    // counted in the per-member stats ledger.
    const reread = new KanbanStore(join(dir, 'analytics', 'board.db'), { teamId: 'analytics' });
    const stats = reread.getMemberStats();
    reread.close();
    const engineerStat = stats.get('engineer');
    expect(engineerStat).toMatchObject({
      teamId: 'analytics',
      memberId: 'engineer',
      ticketsFailed: 1,
    });
  });

  // ---------------------------------------------------------------------------
  // bulkUpdateStatus / bulkAssign
  // ---------------------------------------------------------------------------

  it('bulkUpdateStatus writes through the store and tags the actor', async () => {
    writeManifest(
      'analytics',
      `
name: analytics
description: x
domain_capabilities: [x]
members:
  - personality: alpha
`,
    );
    const store = openBoard('analytics');
    const a = store.createTask({ title: 'a' });
    const b = store.createTask({ title: 'b' });
    store.close();

    const { tasks } = await service.bulkUpdateStatus({
      team: 'analytics',
      taskIds: [a.id, b.id],
      status: 'done',
      actor: 'human:control-center',
    });
    expect(tasks.map((t) => t.status)).toEqual(['done', 'done']);

    const reread = new KanbanStore(join(dir, 'analytics', 'board.db'));
    for (const id of [a.id, b.id]) {
      const events = reread.listEvents(id);
      const statusChange = events.find((e) => e.kind === 'status_changed');
      expect(statusChange?.actor).toBe('human:control-center');
    }
    reread.close();
  });

  it('bulkAssign writes through the store and tags the actor', async () => {
    writeManifest(
      'analytics',
      `
name: analytics
description: x
domain_capabilities: [x]
members:
  - personality: alpha
`,
    );
    const store = openBoard('analytics');
    const a = store.createTask({ title: 'a' });
    const b = store.createTask({ title: 'b' });
    store.close();

    const { tasks } = await service.bulkAssign({
      team: 'analytics',
      taskIds: [a.id, b.id],
      assignee: 'reviewer',
      actor: 'human:control-center',
    });
    expect(tasks.map((t) => t.assignee)).toEqual(['reviewer', 'reviewer']);

    const reread = new KanbanStore(join(dir, 'analytics', 'board.db'));
    for (const id of [a.id, b.id]) {
      const events = reread.listEvents(id);
      const assigned = events.find((e) => e.kind === 'assigned');
      expect(assigned?.actor).toBe('human:control-center');
    }
    reread.close();
  });
});
