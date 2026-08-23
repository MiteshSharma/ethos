import { DefaultHookRegistry } from '@ethosagent/core';
import { KanbanStore } from '@ethosagent/kanban-store';
import type {
  DispatchTickPayload,
  TicketClaimedPayload,
  TicketStaleReclaimedPayload,
} from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DispatchCall,
  Dispatcher,
  type SpawnDispatchCall,
  type SupervisorState,
} from '../dispatcher';

// In-memory supervisor stand-in. Production uses the real `Map<personality, MemberState>`
// from `runSupervisor`; tests build this directly.
function makeSupervisor(
  members: Record<string, { port: number; status: 'running' | 'starting' | 'failed' }>,
): SupervisorState {
  return {
    portOf: (p) => members[p]?.port ?? null,
    statusOf: (p) => members[p]?.status ?? null,
  };
}

describe('Dispatcher.tick()', () => {
  let board: KanbanStore;

  beforeEach(() => {
    board = new KanbanStore(':memory:');
  });

  afterEach(() => {
    board.close();
  });

  // ---------------------------------------------------------------------------
  // Dispatch path
  // ---------------------------------------------------------------------------

  it('claims ready tasks with running assignees and POSTs to their port', async () => {
    const sup = makeSupervisor({
      engineer: { port: 3001, status: 'running' },
      researcher: { port: 3002, status: 'running' },
    });

    const t1 = board.createTask({ title: 'fix bug', assignee: 'engineer' });
    const t2 = board.createTask({ title: 'market scan', assignee: 'researcher' });
    board.updateStatus(t1.id, 'ready');
    board.updateStatus(t2.id, 'ready');

    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({ board, supervisor: sup, dispatch });

    await dispatcher.tick();

    // Both tasks claimed (open run) — status flipped to running.
    expect(board.getTask(t1.id)?.status).toBe('running');
    expect(board.getTask(t2.id)?.status).toBe('running');

    // Wait for the fire-and-forget dispatch to land before asserting calls.
    await new Promise((r) => setImmediate(r));
    expect(dispatch).toHaveBeenCalledTimes(2);
    const calls = dispatch.mock.calls.map(([args]) => ({
      port: args.port,
      personalityId: args.personalityId,
    }));
    expect(calls).toContainEqual({ port: 3001, personalityId: 'engineer' });
    expect(calls).toContainEqual({ port: 3002, personalityId: 'researcher' });
  });

  it('skips ready tasks whose assignee is not running', async () => {
    const sup = makeSupervisor({ engineer: { port: 3001, status: 'failed' } });
    const t = board.createTask({ title: 'x', assignee: 'engineer' });
    board.updateStatus(t.id, 'ready');

    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({ board, supervisor: sup, dispatch });

    await dispatcher.tick();
    expect(dispatch).not.toHaveBeenCalled();
    expect(board.getTask(t.id)?.status).toBe('ready'); // unchanged
  });

  it('skips ready tasks with no known port for the assignee', async () => {
    const sup = makeSupervisor({});
    const t = board.createTask({ title: 'x', assignee: 'engineer' });
    board.updateStatus(t.id, 'ready');

    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({ board, supervisor: sup, dispatch });

    await dispatcher.tick();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('fails a task that exhausts its retry budget on re-claim instead of dispatching it', async () => {
    const sup = makeSupervisor({ engineer: { port: 3001, status: 'running' } });
    // maxRetries=0: the task gets one claim, and any re-claim fails it.
    const t = board.createTask({ title: 'impossible', assignee: 'engineer', maxRetries: 0 });

    // Simulate a first run that ended badly, leaving the task ready to be re-claimed.
    board.updateStatus(t.id, 'ready');
    board.updateStatus(t.id, 'running', 'first attempt');
    board.blockRun(t.id, 'failed');
    board.updateStatus(t.id, 'ready');

    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({ board, supervisor: sup, dispatch });

    await dispatcher.tick();

    // The dispatcher's claim re-claimed the task past budget — updateStatus
    // landed it in 'failed', so nothing was dispatched.
    expect(board.getTask(t.id)?.status).toBe('failed');
    await new Promise((r) => setImmediate(r));
    expect(dispatch).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Promotion path — parents-done unlocks children
  // ---------------------------------------------------------------------------

  it('real-work parent gates the child until done, then the dispatcher claims it', async () => {
    const sup = makeSupervisor({
      engineer: { port: 3001, status: 'running' },
      researcher: { port: 3002, status: 'running' },
    });
    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({ board, supervisor: sup, dispatch });

    // Real-work parent (has an assignee) — its completion gates the child.
    const parent = board.createTask({ title: 'parent', assignee: 'researcher' });
    board.updateStatus(parent.id, 'ready');
    const child = board.createTask({
      title: 'work',
      parents: [parent.id],
      assignee: 'engineer',
    });

    // Tick #1: parent dispatches (researcher gets it), child stays in todo.
    await dispatcher.tick();
    expect(board.getTask(child.id)?.status).toBe('todo');

    // Coordinator marks the parent done out of band (simulating a completion).
    board.completeRun(parent.id, 'parent done');

    // Tick #2: promoteReady moves child to ready; then dispatch fires.
    await dispatcher.tick();
    await new Promise((r) => setImmediate(r));
    expect(board.getTask(child.id)?.status).toBe('running');
    // dispatch fired twice: once for the parent, once for the child.
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('rolls a goal up to done once every child completes', async () => {
    const sup = makeSupervisor({});
    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({ board, supervisor: sup, dispatch });

    const goal = board.createTask({ title: 'Q3 roadmap' });
    const c1 = board.createTask({ title: 'a', assignee: 'engineer', parents: [goal.id] });
    const c2 = board.createTask({ title: 'b', assignee: 'researcher', parents: [goal.id] });

    // Children complete out-of-band (the dispatcher would normally do it via
    // callMeshAgent → assignee → kanban_complete, but we shortcut here).
    board.updateStatus(c1.id, 'running');
    board.completeRun(c1.id, 'done a');
    board.updateStatus(c2.id, 'running');
    board.completeRun(c2.id, 'done b');

    // One tick: promoteReady moves the goal todo→ready; rollup sees all
    // children done and finishes it. Both steps run inside the same tick.
    await dispatcher.tick();

    expect(board.getTask(goal.id)?.status).toBe('done');
  });

  it('goal-as-parent (no assignee) is transparent — child promotes immediately', async () => {
    const sup = makeSupervisor({ engineer: { port: 3001, status: 'running' } });
    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({ board, supervisor: sup, dispatch });

    // Goal pattern: assignee=null. Goals organize work, they don't gate it.
    // Without this rule, the coordinator's create_goal → create(parents=[goal])
    // flow deadlocks because nothing closes the goal.
    const goal = board.createTask({ title: 'Q3 roadmap' });
    const child = board.createTask({
      title: 'sub-task',
      parents: [goal.id],
      assignee: 'engineer',
    });

    await dispatcher.tick();
    await new Promise((r) => setImmediate(r));
    expect(board.getTask(child.id)?.status).toBe('running');
    expect(dispatch).toHaveBeenCalledTimes(1);
    // The goal itself is promoted (no blockers of its own) but never dispatched:
    // `findReadyToDispatch` filters on assignee IS NOT NULL so the empty-assignee
    // goal stays in `ready` indefinitely, acting as a milestone marker.
    expect(board.getTask(goal.id)?.status).toBe('ready');
  });

  // ---------------------------------------------------------------------------
  // Reclaim path — stale heartbeat → blocked
  // ---------------------------------------------------------------------------

  it('marks a task blocked when its open run hasnt heartbeat in staleMs', async () => {
    const sup = makeSupervisor({ engineer: { port: 3001, status: 'running' } });
    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({
      board,
      supervisor: sup,
      dispatch,
      staleMs: 100,
    });

    const t = board.createTask({ title: 'long', assignee: 'engineer' });
    board.updateStatus(t.id, 'running'); // opens a run

    // Backdate the run's heartbeat so it looks stale.
    const runId = board.getTask(t.id)?.currentRunId;
    expect(runId).toBeTruthy();
    (
      board as unknown as {
        db: { prepare: (s: string) => { run: (a: number, b: string) => void } };
      }
    ).db
      .prepare('UPDATE task_runs SET last_heartbeat_at = ? WHERE id = ?')
      .run(Date.now() - 500, runId as string);

    await dispatcher.tick();

    expect(board.getTask(t.id)?.status).toBe('blocked');
  });

  // ---------------------------------------------------------------------------
  // Dispatch failure → blocked
  // ---------------------------------------------------------------------------

  it('marks a task blocked when the HTTP dispatch fails', async () => {
    const sup = makeSupervisor({ engineer: { port: 3001, status: 'running' } });
    const dispatch = vi.fn<DispatchCall>(async () => {
      throw new Error('connection refused');
    });
    const errors: Array<{ msg: string; id: string }> = [];
    const dispatcher = new Dispatcher({
      board,
      supervisor: sup,
      dispatch,
      onError: (err, id) => errors.push({ msg: err.message, id }),
    });

    const t = board.createTask({ title: 'x', assignee: 'engineer' });
    board.updateStatus(t.id, 'ready');

    await dispatcher.tick();
    // dispatcher fires-and-forgets; let the promise settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(board.getTask(t.id)?.status).toBe('blocked');
    expect(errors).toEqual([{ msg: 'connection refused', id: t.id }]);
  });

  // ---------------------------------------------------------------------------
  // Staleness in orphan adoption — stuck `running` tasks get reclaimed
  // ---------------------------------------------------------------------------

  // Backdate a task's updated_at to simulate the passage of time past the
  // staleness threshold without actually sleeping.
  function backdateUpdatedAt(taskId: string, ms: number): void {
    (
      board as unknown as {
        db: { prepare: (s: string) => { run: (a: number, b: string) => void } };
      }
    ).db
      .prepare('UPDATE tasks SET updated_at = ? WHERE id = ?')
      .run(Date.now() - ms, taskId);
  }

  it('reclaims a running task whose updated_at is past the staleness threshold with reason orphan_stale', async () => {
    const sup = makeSupervisor({ engineer: { port: 3001, status: 'running' } });
    const t = board.createTask({ title: 'stuck', assignee: 'engineer' });
    board.updateStatus(t.id, 'ready');
    board.updateStatus(t.id, 'running', 'dispatched', 'dispatcher');
    // Push updated_at well past the 1s threshold this dispatcher uses.
    backdateUpdatedAt(t.id, 5_000);

    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({
      board,
      supervisor: sup,
      dispatch,
      stalenessThresholdMs: 1_000,
    });

    await dispatcher.tick();

    const events = board.listEvents(t.id);
    const reclaim = events.find(
      (e) => e.kind === 'status_changed' && e.data.reason === 'orphan_stale',
    );
    expect(reclaim).toBeDefined();
    // Reclaimed → ready → re-dispatched within the same tick → running again.
    expect(board.getTask(t.id)?.status).toBe('running');
    await new Promise((r) => setImmediate(r));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('does NOT reclaim a running task whose updated_at is recent', async () => {
    const sup = makeSupervisor({ engineer: { port: 3001, status: 'running' } });
    const t = board.createTask({ title: 'healthy', assignee: 'engineer' });
    board.updateStatus(t.id, 'ready');
    board.updateStatus(t.id, 'running', 'dispatched', 'dispatcher');
    // updated_at is fresh (just set by updateStatus) — not stale.

    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({
      board,
      supervisor: sup,
      dispatch,
      stalenessThresholdMs: 60_000,
    });

    await dispatcher.tick();

    const events = board.listEvents(t.id);
    const reclaim = events.find(
      (e) => e.kind === 'status_changed' && e.data.reason === 'orphan_stale',
    );
    expect(reclaim).toBeUndefined();
    expect(board.getTask(t.id)?.status).toBe('running');
  });

  it('reclaims a running task whose assignee is no longer active with reason orphan_no_owner', async () => {
    // Assignee exists but its process has failed — supervisor.statusOf is not 'running'.
    const sup = makeSupervisor({ engineer: { port: 3001, status: 'failed' } });
    const t = board.createTask({ title: 'abandoned', assignee: 'engineer' });
    board.updateStatus(t.id, 'ready');
    board.updateStatus(t.id, 'running', 'dispatched', 'dispatcher');
    // updated_at is fresh — this is the no-owner path, not the staleness path.

    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({
      board,
      supervisor: sup,
      dispatch,
      stalenessThresholdMs: 60_000,
    });

    await dispatcher.tick();

    const events = board.listEvents(t.id);
    const reclaim = events.find(
      (e) => e.kind === 'status_changed' && e.data.reason === 'orphan_no_owner',
    );
    expect(reclaim).toBeDefined();
    // Owner is gone, so the same-tick dispatch can't re-claim it — stays ready.
    expect(board.getTask(t.id)?.status).toBe('ready');
    await new Promise((r) => setImmediate(r));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not reclaim a running task that is still in-flight from a prior tick', async () => {
    const sup = makeSupervisor({ engineer: { port: 3001, status: 'running' } });
    const t = board.createTask({ title: 'in-flight', assignee: 'engineer' });
    board.updateStatus(t.id, 'ready');

    // A slow dispatch keeps the task in `inflight` across ticks.
    let release: () => void = () => {};
    const dispatch = vi.fn<DispatchCall>(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('ok');
        }),
    );
    const dispatcher = new Dispatcher({
      board,
      supervisor: sup,
      dispatch,
      stalenessThresholdMs: 1_000,
    });

    await dispatcher.tick(); // claims + dispatches; task is now inflight + running
    backdateUpdatedAt(t.id, 5_000); // make it look stale
    await dispatcher.tick(); // should NOT reclaim — still inflight

    const events = board.listEvents(t.id);
    const reclaim = events.find(
      (e) => e.kind === 'status_changed' && e.data.reason === 'orphan_stale',
    );
    expect(reclaim).toBeUndefined();
    expect(board.getTask(t.id)?.status).toBe('running');

    release();
    await new Promise((r) => setImmediate(r));
  });

  // ---------------------------------------------------------------------------
  // dispatch_prefer_reliable — success-ratio tie-breaker
  // ---------------------------------------------------------------------------

  describe('dispatch_prefer_reliable', () => {
    let teamBoard: KanbanStore;

    beforeEach(() => {
      teamBoard = new KanbanStore(':memory:', { teamId: 'team-a' });
    });

    afterEach(() => {
      teamBoard.close();
    });

    // Give `member` a track record by running and completing/failing throwaway
    // tasks on the board. This drives the real `team_member_stats` counters.
    function seedRecord(member: string, completed: number, failed: number): void {
      for (let i = 0; i < completed; i++) {
        const t = teamBoard.createTask({ title: `done ${member} ${i}`, assignee: member });
        teamBoard.updateStatus(t.id, 'running', undefined, member);
        teamBoard.completeRun(t.id, 'ok', member);
      }
      for (let i = 0; i < failed; i++) {
        const t = teamBoard.createTask({ title: `fail ${member} ${i}`, assignee: member });
        teamBoard.updateStatus(t.id, 'running', undefined, member);
        teamBoard.updateStatus(t.id, 'needs_revision', 'nope', 'reviewer');
      }
    }

    it('dispatches the higher-success assignee first when both are ready at equal priority', async () => {
      const sup = makeSupervisor({
        reliable: { port: 3001, status: 'running' },
        flaky: { port: 3002, status: 'running' },
      });
      seedRecord('reliable', 4, 0); // 100% success
      seedRecord('flaky', 1, 3); // 25% success

      // Two fresh ready tasks at the same (default) priority — `created_at ASC`
      // would dispatch `flakyTask` first, but the reliability tie-breaker flips it.
      const flakyTask = teamBoard.createTask({ title: 'flaky work', assignee: 'flaky' });
      const reliableTask = teamBoard.createTask({ title: 'reliable work', assignee: 'reliable' });
      teamBoard.updateStatus(flakyTask.id, 'ready');
      teamBoard.updateStatus(reliableTask.id, 'ready');

      const dispatch = vi.fn<DispatchCall>(async () => 'ok');
      const dispatcher = new Dispatcher({
        board: teamBoard,
        supervisor: sup,
        dispatch,
        preferReliable: true,
      });

      await dispatcher.tick();
      await new Promise((r) => setImmediate(r));

      expect(dispatch).toHaveBeenCalledTimes(2);
      const order = dispatch.mock.calls.map(([args]) => args.personalityId);
      expect(order).toEqual(['reliable', 'flaky']);
    });

    it('does NOT exclude the lower-success member when it is the only one available', async () => {
      const sup = makeSupervisor({ flaky: { port: 3002, status: 'running' } });
      seedRecord('flaky', 0, 4); // 0% success — still must be dispatched

      const t = teamBoard.createTask({ title: 'only option', assignee: 'flaky' });
      teamBoard.updateStatus(t.id, 'ready');

      const dispatch = vi.fn<DispatchCall>(async () => 'ok');
      const dispatcher = new Dispatcher({
        board: teamBoard,
        supervisor: sup,
        dispatch,
        preferReliable: true,
      });

      await dispatcher.tick();
      await new Promise((r) => setImmediate(r));

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls[0]?.[0].personalityId).toBe('flaky');
      expect(teamBoard.getTask(t.id)?.status).toBe('running');
    });

    it('priority still dominates the reliability tie-breaker', async () => {
      const sup = makeSupervisor({
        reliable: { port: 3001, status: 'running' },
        flaky: { port: 3002, status: 'running' },
      });
      seedRecord('reliable', 4, 0);
      seedRecord('flaky', 1, 3);

      // The flaky member's task has higher priority — it must still go first.
      const flakyTask = teamBoard.createTask({
        title: 'urgent flaky',
        assignee: 'flaky',
        priority: 10,
      });
      const reliableTask = teamBoard.createTask({ title: 'normal reliable', assignee: 'reliable' });
      teamBoard.updateStatus(flakyTask.id, 'ready');
      teamBoard.updateStatus(reliableTask.id, 'ready');

      const dispatch = vi.fn<DispatchCall>(async () => 'ok');
      const dispatcher = new Dispatcher({
        board: teamBoard,
        supervisor: sup,
        dispatch,
        preferReliable: true,
      });

      await dispatcher.tick();
      await new Promise((r) => setImmediate(r));

      const order = dispatch.mock.calls.map(([args]) => args.personalityId);
      expect(order).toEqual(['flaky', 'reliable']);
    });

    it('cold-start: a member with no record sorts after a proven perfect member but ahead of an imperfect one', async () => {
      const sup = makeSupervisor({
        perfect: { port: 3001, status: 'running' },
        newbie: { port: 3002, status: 'running' },
        imperfect: { port: 3003, status: 'running' },
      });
      seedRecord('perfect', 5, 0); // 100%
      seedRecord('imperfect', 8, 2); // 80%
      // `newbie` has no record at all.

      // Created imperfect → newbie → perfect, so created_at order is the reverse
      // of the reliability order we expect.
      const imperfectTask = teamBoard.createTask({ title: 'i', assignee: 'imperfect' });
      const newbieTask = teamBoard.createTask({ title: 'n', assignee: 'newbie' });
      const perfectTask = teamBoard.createTask({ title: 'p', assignee: 'perfect' });
      teamBoard.updateStatus(imperfectTask.id, 'ready');
      teamBoard.updateStatus(newbieTask.id, 'ready');
      teamBoard.updateStatus(perfectTask.id, 'ready');

      const dispatch = vi.fn<DispatchCall>(async () => 'ok');
      const dispatcher = new Dispatcher({
        board: teamBoard,
        supervisor: sup,
        dispatch,
        preferReliable: true,
      });

      await dispatcher.tick();
      await new Promise((r) => setImmediate(r));

      const order = dispatch.mock.calls.map(([args]) => args.personalityId);
      expect(order).toEqual(['perfect', 'newbie', 'imperfect']);
    });

    it('leaves dispatch order untouched when the flag is off (default)', async () => {
      const sup = makeSupervisor({
        reliable: { port: 3001, status: 'running' },
        flaky: { port: 3002, status: 'running' },
      });
      seedRecord('reliable', 4, 0);
      seedRecord('flaky', 1, 3);

      // flakyTask created first → `created_at ASC` dispatches it first with no flag.
      const flakyTask = teamBoard.createTask({ title: 'flaky work', assignee: 'flaky' });
      const reliableTask = teamBoard.createTask({ title: 'reliable work', assignee: 'reliable' });
      teamBoard.updateStatus(flakyTask.id, 'ready');
      teamBoard.updateStatus(reliableTask.id, 'ready');

      const dispatch = vi.fn<DispatchCall>(async () => 'ok');
      const dispatcher = new Dispatcher({ board: teamBoard, supervisor: sup, dispatch });

      await dispatcher.tick();
      await new Promise((r) => setImmediate(r));

      const order = dispatch.mock.calls.map(([args]) => args.personalityId);
      expect(order).toEqual(['flaky', 'reliable']);
    });
  });

  // ---------------------------------------------------------------------------
  // dispatchAsBackgroundJob — opt-in durable spawn path
  // ---------------------------------------------------------------------------

  describe('dispatchAsBackgroundJob', () => {
    it('uses the spawn transport (not the blocking dispatch) and does not mark the task done', async () => {
      const sup = makeSupervisor({ engineer: { port: 3001, status: 'running' } });
      const t = board.createTask({ title: 'background work', assignee: 'engineer' });
      board.updateStatus(t.id, 'ready');

      const dispatch = vi.fn<DispatchCall>(async () => 'ok');
      const spawnDispatch = vi.fn<SpawnDispatchCall>(async () => ({ jobId: 'job-123' }));
      const dispatcher = new Dispatcher({
        board,
        supervisor: sup,
        dispatch,
        spawnDispatch,
        dispatchAsBackgroundJob: true,
      });

      await dispatcher.tick();
      await new Promise((r) => setImmediate(r));

      // Spawn transport was used; the blocking prompt transport was NOT.
      expect(spawnDispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).not.toHaveBeenCalled();
      const call = spawnDispatch.mock.calls[0]?.[0];
      expect(call?.port).toBe(3001);
      expect(call?.personalityId).toBe('engineer');

      // The task was claimed (running) and NOT prematurely completed — the
      // kanban board still owns its state; the worker will close it out of band.
      expect(board.getTask(t.id)?.status).toBe('running');
    });

    it('returns without awaiting a full run — resolves even while the peer job is still executing', async () => {
      const sup = makeSupervisor({ engineer: { port: 3001, status: 'running' } });
      const t = board.createTask({ title: 'long background work', assignee: 'engineer' });
      board.updateStatus(t.id, 'ready');

      // A blocking transport that never resolves — if the dispatcher awaited a
      // full run, the task would hang here. The spawn path must not touch it.
      const dispatch = vi.fn<DispatchCall>(() => new Promise<string>(() => {}));
      const spawnDispatch = vi.fn<SpawnDispatchCall>(async () => ({ jobId: 'job-xyz' }));
      const dispatcher = new Dispatcher({
        board,
        supervisor: sup,
        dispatch,
        spawnDispatch,
        dispatchAsBackgroundJob: true,
      });

      await dispatcher.tick();
      await new Promise((r) => setImmediate(r));

      expect(spawnDispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).not.toHaveBeenCalled();
      // Task stays running, tracked by kanban; nothing forced it to done/blocked.
      expect(board.getTask(t.id)?.status).toBe('running');
    });

    it('blocks the run when the spawn transport fails', async () => {
      const sup = makeSupervisor({ engineer: { port: 3001, status: 'running' } });
      const t = board.createTask({ title: 'unreachable peer', assignee: 'engineer' });
      board.updateStatus(t.id, 'ready');

      const errors: Array<{ msg: string; id: string }> = [];
      const spawnDispatch = vi.fn<SpawnDispatchCall>(async () => {
        throw new Error('connection refused');
      });
      const dispatcher = new Dispatcher({
        board,
        supervisor: sup,
        spawnDispatch,
        dispatchAsBackgroundJob: true,
        onError: (err, id) => errors.push({ msg: err.message, id }),
      });

      await dispatcher.tick();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      expect(board.getTask(t.id)?.status).toBe('blocked');
      expect(errors).toEqual([{ msg: 'connection refused', id: t.id }]);
    });

    it('uses the blocking dispatch path unchanged when the option is off (default)', async () => {
      const sup = makeSupervisor({ engineer: { port: 3001, status: 'running' } });
      const t = board.createTask({ title: 'normal work', assignee: 'engineer' });
      board.updateStatus(t.id, 'ready');

      const dispatch = vi.fn<DispatchCall>(async () => 'ok');
      const spawnDispatch = vi.fn<SpawnDispatchCall>(async () => ({ jobId: 'job-999' }));
      // dispatchAsBackgroundJob omitted → default false.
      const dispatcher = new Dispatcher({ board, supervisor: sup, dispatch, spawnDispatch });

      await dispatcher.tick();
      await new Promise((r) => setImmediate(r));

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(spawnDispatch).not.toHaveBeenCalled();
      expect(board.getTask(t.id)?.status).toBe('running');
    });
  });

  // ---------------------------------------------------------------------------
  // Lane B (kanban-hooks-notify-parity) — dispatcher-fired lifecycle hooks
  // ---------------------------------------------------------------------------

  describe('Dispatcher hooks (Lane B)', () => {
    it('fires ticket_claimed with { taskId, assignee, runId } matching the claimed task', async () => {
      const sup = makeSupervisor({ engineer: { port: 3001, status: 'running' } });
      const hooks = new DefaultHookRegistry();
      const claimed: TicketClaimedPayload[] = [];
      hooks.registerVoid('ticket_claimed', async (payload) => {
        claimed.push(payload);
      });

      const t = board.createTask({ title: 'fix bug', assignee: 'engineer' });
      board.updateStatus(t.id, 'ready');

      const dispatch = vi.fn<DispatchCall>(async () => 'ok');
      const dispatcher = new Dispatcher({ board, supervisor: sup, dispatch, hooks });

      await dispatcher.tick();
      await new Promise((r) => setImmediate(r));

      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toEqual({
        taskId: t.id,
        assignee: 'engineer',
        runId: board.getTask(t.id)?.currentRunId,
      });
    });

    it('fires ticket_stale_reclaimed with reason orphan_stale, capturing the pre-reclaim assignee', async () => {
      const sup = makeSupervisor({ engineer: { port: 3001, status: 'running' } });
      const hooks = new DefaultHookRegistry();
      const reclaimed: TicketStaleReclaimedPayload[] = [];
      hooks.registerVoid('ticket_stale_reclaimed', async (payload) => {
        reclaimed.push(payload);
      });

      const t = board.createTask({ title: 'stuck', assignee: 'engineer' });
      board.updateStatus(t.id, 'ready');
      board.updateStatus(t.id, 'running', 'dispatched', 'dispatcher');
      backdateUpdatedAt(t.id, 5_000);

      const dispatch = vi.fn<DispatchCall>(async () => 'ok');
      const dispatcher = new Dispatcher({
        board,
        supervisor: sup,
        dispatch,
        stalenessThresholdMs: 1_000,
        hooks,
      });

      await dispatcher.tick();
      await new Promise((r) => setImmediate(r));

      expect(reclaimed).toEqual([
        { taskId: t.id, previousAssignee: 'engineer', reason: 'orphan_stale' },
      ]);
    });

    it('fires ticket_stale_reclaimed with reason orphan_no_owner when the assignee is no longer active', async () => {
      const sup = makeSupervisor({ engineer: { port: 3001, status: 'failed' } });
      const hooks = new DefaultHookRegistry();
      const reclaimed: TicketStaleReclaimedPayload[] = [];
      hooks.registerVoid('ticket_stale_reclaimed', async (payload) => {
        reclaimed.push(payload);
      });

      const t = board.createTask({ title: 'abandoned', assignee: 'engineer' });
      board.updateStatus(t.id, 'ready');
      board.updateStatus(t.id, 'running', 'dispatched', 'dispatcher');

      const dispatch = vi.fn<DispatchCall>(async () => 'ok');
      const dispatcher = new Dispatcher({
        board,
        supervisor: sup,
        dispatch,
        stalenessThresholdMs: 60_000,
        hooks,
      });

      await dispatcher.tick();
      await new Promise((r) => setImmediate(r));

      expect(reclaimed).toEqual([
        { taskId: t.id, previousAssignee: 'engineer', reason: 'orphan_no_owner' },
      ]);
    });

    describe('dispatch_tick gating (D9)', () => {
      it('fires dispatch_tick exactly once with the right counts on a claim-only tick', async () => {
        const sup = makeSupervisor({ engineer: { port: 3001, status: 'running' } });
        const hooks = new DefaultHookRegistry();
        const ticks: DispatchTickPayload[] = [];
        hooks.registerVoid('dispatch_tick', async (payload) => {
          ticks.push(payload);
        });

        const t = board.createTask({ title: 'fix bug', assignee: 'engineer' });
        board.updateStatus(t.id, 'ready');

        const dispatch = vi.fn<DispatchCall>(async () => 'ok');
        const dispatcher = new Dispatcher({ board, supervisor: sup, dispatch, hooks });

        await dispatcher.tick();
        await new Promise((r) => setImmediate(r));

        expect(ticks).toHaveLength(1);
        expect(ticks[0]).toEqual({ claimedCount: 1, reclaimedCount: 0 });
      });

      it('fires dispatch_tick exactly once with the right counts on a reclaim-only tick', async () => {
        // orphan_no_owner: the assignee's process is down, so the reclaimed task
        // can't be re-dispatched within the same tick — reclaim-only.
        const sup = makeSupervisor({ engineer: { port: 3001, status: 'failed' } });
        const hooks = new DefaultHookRegistry();
        const ticks: DispatchTickPayload[] = [];
        hooks.registerVoid('dispatch_tick', async (payload) => {
          ticks.push(payload);
        });

        const t = board.createTask({ title: 'abandoned', assignee: 'engineer' });
        board.updateStatus(t.id, 'ready');
        board.updateStatus(t.id, 'running', 'dispatched', 'dispatcher');

        const dispatch = vi.fn<DispatchCall>(async () => 'ok');
        const dispatcher = new Dispatcher({
          board,
          supervisor: sup,
          dispatch,
          stalenessThresholdMs: 60_000,
          hooks,
        });

        await dispatcher.tick();
        await new Promise((r) => setImmediate(r));

        expect(ticks).toHaveLength(1);
        expect(ticks[0]).toEqual({ claimedCount: 0, reclaimedCount: 1 });
      });

      it('fires dispatch_tick zero times on a fully idle tick', async () => {
        const sup = makeSupervisor({});
        const hooks = new DefaultHookRegistry();
        const ticks: DispatchTickPayload[] = [];
        hooks.registerVoid('dispatch_tick', async (payload) => {
          ticks.push(payload);
        });

        const dispatch = vi.fn<DispatchCall>(async () => 'ok');
        const dispatcher = new Dispatcher({ board, supervisor: sup, dispatch, hooks });

        await dispatcher.tick();
        await new Promise((r) => setImmediate(r));

        expect(ticks).toHaveLength(0);
      });
    });

    it('a throwing ticket_claimed handler does not stop tick() from resolving, and the task still ends up claimed', async () => {
      const sup = makeSupervisor({ engineer: { port: 3001, status: 'running' } });
      const hooks = new DefaultHookRegistry();
      hooks.registerVoid('ticket_claimed', async () => {
        throw new Error('boom');
      });

      const t = board.createTask({ title: 'fix bug', assignee: 'engineer' });
      board.updateStatus(t.id, 'ready');

      const dispatch = vi.fn<DispatchCall>(async () => 'ok');
      const dispatcher = new Dispatcher({ board, supervisor: sup, dispatch, hooks });

      await expect(dispatcher.tick()).resolves.toBeUndefined();
      await new Promise((r) => setImmediate(r));

      expect(board.getTask(t.id)?.status).toBe('running');
    });
  });
});
