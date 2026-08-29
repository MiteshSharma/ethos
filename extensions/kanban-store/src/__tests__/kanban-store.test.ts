import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '@ethosagent/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KanbanStore } from '../index';

function makeStore() {
  return new KanbanStore(':memory:');
}

describe('KanbanStore', () => {
  let store: KanbanStore;

  beforeEach(() => {
    store = makeStore();
  });

  afterEach(() => {
    store.close();
  });

  it('opens an in-memory database and applies the schema', () => {
    // If migrations run cleanly, the store is usable. We probe by counting tasks.
    const tasks = store.listTasks();
    expect(tasks).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // createTask + getTask
  // ---------------------------------------------------------------------------

  it('creates a task with required fields and retrieves it by id', () => {
    const task = store.createTask({ title: 'fix the bug' });

    expect(task.id).toMatch(/^t_[0-9a-f]{16}$/);
    expect(task.title).toBe('fix the bug');
    expect(task.body).toBe('');
    expect(task.status).toBe('todo');
    expect(task.priority).toBe(0);
    expect(task.workspaceMode).toBe('scratch');
    expect(task.assignee).toBeNull();

    const found = store.getTask(task.id);
    expect(found?.id).toBe(task.id);
    expect(found?.title).toBe('fix the bug');
  });

  it('returns null for an unknown task id', () => {
    expect(store.getTask('t_nope')).toBeNull();
  });

  it('persists optional fields when supplied', () => {
    const task = store.createTask({
      title: 'refactor hasher',
      body: 'argon2id, parameter tuning',
      assignee: 'engineer',
      priority: 2,
      workspaceMode: 'worktree',
    });

    const found = store.getTask(task.id);
    expect(found?.body).toBe('argon2id, parameter tuning');
    expect(found?.assignee).toBe('engineer');
    expect(found?.priority).toBe(2);
    expect(found?.workspaceMode).toBe('worktree');
  });

  it('createTask is idempotent on idempotencyKey — same key returns the existing task', () => {
    const first = store.createTask({ title: 'one', idempotencyKey: 'caller-123' });
    const second = store.createTask({ title: 'one', idempotencyKey: 'caller-123' });

    expect(second.id).toBe(first.id);
    expect(store.listTasks()).toHaveLength(1);
  });

  it('createTask with null/undefined idempotencyKey always creates a new task', () => {
    store.createTask({ title: 'a' });
    store.createTask({ title: 'b' });
    expect(store.listTasks()).toHaveLength(2);
  });

  it('createTask with parents inserts task_links rows', () => {
    const parent = store.createTask({ title: 'parent' });
    const child = store.createTask({ title: 'child', parents: [parent.id] });

    const children = store.listTasks({ parentId: parent.id });
    expect(children).toHaveLength(1);
    expect(children[0]?.id).toBe(child.id);
  });

  // ---------------------------------------------------------------------------
  // listTasks filters
  // ---------------------------------------------------------------------------

  it('listTasks filters by status', () => {
    store.createTask({ title: 'a' }); // todo
    const b = store.createTask({ title: 'b' });
    store.updateStatus(b.id, 'done', 'done quickly');

    const todos = store.listTasks({ status: 'todo' });
    expect(todos).toHaveLength(1);
    expect(todos[0]?.title).toBe('a');
  });

  it('listTasks filters by assignee (null vs string)', () => {
    store.createTask({ title: 'unassigned' });
    store.createTask({ title: 'mine', assignee: 'engineer' });

    expect(store.listTasks({ assignee: 'engineer' })).toHaveLength(1);
    expect(store.listTasks({ assignee: 'engineer' })[0]?.title).toBe('mine');
  });

  it('listTasks honours limit', () => {
    for (let i = 0; i < 5; i++) store.createTask({ title: `t${i}` });
    expect(store.listTasks({ limit: 2 })).toHaveLength(2);
  });

  it('listTasks q filter does FTS5 phrase/token match over title+body+comments and ANDs with other filters', () => {
    const want = store.createTask({ title: 'rotate keys', body: 'kms rotation overdue' });
    const unrelated = store.createTask({ title: 'unrelated stuff' });
    const otherAssignee = store.createTask({ title: 'rotate certs', assignee: 'sre' });

    const hits = store.listTasks({ q: 'rotate' });
    const ids = hits.map((t) => t.id);
    expect(ids).toContain(want.id);
    expect(ids).toContain(otherAssignee.id);
    expect(ids).not.toContain(unrelated.id);

    // q AND assignee
    const sreHits = store.listTasks({ q: 'rotate', assignee: 'sre' });
    expect(sreHits.map((t) => t.id)).toEqual([otherAssignee.id]);
  });

  // ---------------------------------------------------------------------------
  // Run lifecycle
  // ---------------------------------------------------------------------------

  it('updateStatus(_, running) opens a task_run and sets current_run_id', () => {
    const task = store.createTask({ title: 'work' });
    const updated = store.updateStatus(task.id, 'running');

    expect(updated.status).toBe('running');
    expect(updated.currentRunId).toMatch(/^r_[0-9a-f]{16}$/);

    const runs = store.listRuns(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(updated.currentRunId);
    expect(runs[0]?.endedAt).toBeNull();
  });

  it('updateStatus does not open a second run if one is already open', () => {
    const task = store.createTask({ title: 'work' });
    store.updateStatus(task.id, 'running');
    store.updateStatus(task.id, 'running'); // no-op for run creation
    expect(store.listRuns(task.id)).toHaveLength(1);
  });

  it('completeRun ends the current run with outcome=completed + summary and sets status=done', () => {
    const task = store.createTask({ title: 'work' });
    store.updateStatus(task.id, 'running');
    const done = store.completeRun(task.id, 'shipped argon2id');

    expect(done.status).toBe('done');
    expect(done.currentRunId).toBeNull();

    const runs = store.listRuns(task.id);
    expect(runs[0]?.outcome).toBe('completed');
    expect(runs[0]?.summary).toBe('shipped argon2id');
    expect(runs[0]?.endedAt).not.toBeNull();
  });

  it('completeRun stamps completedBy on the run record', () => {
    const task = store.createTask({ title: 'stamped' });
    store.updateStatus(task.id, 'running');
    store.completeRun(task.id, 'shipped', 'system', { id: 'engineer', name: 'Engineer' });

    const runs = store.listRuns(task.id);
    expect(runs[0]?.completedBy).toEqual({ id: 'engineer', name: 'Engineer' });
  });

  it('completeRun without completedBy leaves completedBy null', () => {
    const task = store.createTask({ title: 'plain' });
    store.updateStatus(task.id, 'running');
    store.completeRun(task.id, 'shipped');

    const runs = store.listRuns(task.id);
    expect(runs[0]?.completedBy).toBeNull();
  });

  it('blockRun ends the current run with outcome=blocked + reason as comment and sets status=blocked', () => {
    const task = store.createTask({ title: 'work' });
    store.updateStatus(task.id, 'running');
    const blocked = store.blockRun(task.id, 'waiting on infra');

    expect(blocked.status).toBe('blocked');
    expect(blocked.currentRunId).toBeNull();

    const runs = store.listRuns(task.id);
    expect(runs[0]?.outcome).toBe('blocked');
    expect(runs[0]?.endedAt).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // blockRun: typed `kind` + unblock-loop breaker (kanban-hooks-notify-parity, Lane A Phase 1)
  // ---------------------------------------------------------------------------

  it('blockRun persists an optional kind on the task and starts its recurrence count at 1', () => {
    const task = store.createTask({ title: 'work' });
    store.updateStatus(task.id, 'running');
    const blocked = store.blockRun(task.id, 'waiting on infra', 'system', 'dependency');

    expect(blocked.status).toBe('blocked');
    expect(blocked.blockKind).toBe('dependency');
    expect(blocked.blockRecurrenceCount).toBe(1);
  });

  it('blockRun without a kind does not track recurrence (count stays 0, kind stays null)', () => {
    const task = store.createTask({ title: 'work' });
    store.updateStatus(task.id, 'running');
    const blocked = store.blockRun(task.id, 'waiting on infra');

    expect(blocked.blockKind).toBeNull();
    expect(blocked.blockRecurrenceCount).toBe(0);
  });

  it('a differently-kinded re-block resets the recurrence count to 1 instead of accumulating', () => {
    const task = store.createTask({ title: 'work' });
    store.updateStatus(task.id, 'running');
    store.blockRun(task.id, 'db is down', 'system', 'dependency');

    store.updateStatus(task.id, 'running');
    const reblocked = store.blockRun(task.id, 'need clarification', 'system', 'needs_input');

    expect(reblocked.status).toBe('blocked');
    expect(reblocked.blockKind).toBe('needs_input');
    expect(reblocked.blockRecurrenceCount).toBe(1);
  });

  it('completeRun clears blockKind/blockRecurrenceCount — the next block starts a fresh streak', () => {
    const task = store.createTask({ title: 'work' });
    store.updateStatus(task.id, 'running');
    store.blockRun(task.id, 'waiting on infra', 'system', 'dependency');

    store.updateStatus(task.id, 'running');
    const done = store.completeRun(task.id, 'unblocked and shipped');
    expect(done.blockKind).toBeNull();
    expect(done.blockRecurrenceCount).toBe(0);

    store.updateStatus(task.id, 'running');
    const reblocked = store.blockRun(task.id, 'again', 'system', 'dependency');
    expect(reblocked.status).toBe('blocked');
    expect(reblocked.blockRecurrenceCount).toBe(1);
  });

  it('routes to needs_revision after BLOCK_RECURRENCE_LIMIT (default 2) consecutive same-kind blocks', () => {
    const task = store.createTask({ title: 'flaky dependency' });

    // Block 1: re-claim (first claim, not a re-claim) then block with kind=dependency.
    store.updateStatus(task.id, 'running');
    const first = store.blockRun(task.id, 'waiting on service A', 'system', 'dependency');
    expect(first.status).toBe('blocked');
    expect(first.blockRecurrenceCount).toBe(1);

    // Re-claim (kanban_unblock would normally flip status back to todo/ready first;
    // updateStatus('running') models the re-claim directly, same as the retry-budget
    // tests above do).
    store.updateStatus(task.id, 'running');
    // Block 2: same kind again — this is the 2nd consecutive same-kind block, which
    // meets BLOCK_RECURRENCE_LIMIT (2), so the breaker fires instead of landing 'blocked'.
    const second = store.blockRun(task.id, 'still waiting on service A', 'system', 'dependency');

    expect(second.status).toBe('needs_revision');
    expect(second.blockKind).toBe('dependency');
    expect(second.blockRecurrenceCount).toBe(2);
    expect(second.currentRunId).toBeNull();

    // The transition is auditable via task_events, same as the retry-budget breaker.
    const events = store.listEvents(task.id);
    const statusEvents = events.filter((e) => e.kind === 'status_changed');
    const last = statusEvents[statusEvents.length - 1];
    expect(last?.data.to).toBe('needs_revision');
    expect(last?.data.reason).toBe('block_recurrence_limit');
  });

  it('a custom blockRecurrenceLimit is honored (limit=1 breaches on the very first block)', () => {
    const strict = new KanbanStore(':memory:', { blockRecurrenceLimit: 1 });
    try {
      const task = strict.createTask({ title: 'no second chances' });
      strict.updateStatus(task.id, 'running');
      const blocked = strict.blockRun(task.id, 'nope', 'system', 'capability');

      expect(blocked.status).toBe('needs_revision');
      expect(blocked.blockRecurrenceCount).toBe(1);
    } finally {
      strict.close();
    }
  });

  it('needs_revision from the block-recurrence breaker credits the assignee ticketsFailed stat', () => {
    const teamStore = new KanbanStore(':memory:', { teamId: 'team-a', blockRecurrenceLimit: 1 });
    try {
      const task = teamStore.createTask({ title: 'work', assignee: 'engineer' });
      teamStore.updateStatus(task.id, 'running', undefined, 'engineer');
      teamStore.blockRun(task.id, 'nope', 'engineer', 'transient');

      expect(teamStore.getMemberStats().get('engineer')?.ticketsFailed).toBe(1);
    } finally {
      teamStore.close();
    }
  });

  it('heartbeatRun bumps last_heartbeat_at on the current run', async () => {
    const task = store.createTask({ title: 'long' });
    store.updateStatus(task.id, 'running');
    const before = store.listRuns(task.id)[0]?.lastHeartbeatAt ?? 0;

    await new Promise((r) => setTimeout(r, 5));
    store.heartbeatRun(task.id);

    const after = store.listRuns(task.id)[0]?.lastHeartbeatAt ?? 0;
    expect(after).toBeGreaterThan(before);
  });

  it('completeRun on a task with no open run throws — does not corrupt audit trail', () => {
    const task = store.createTask({ title: 't' });
    expect(() => store.completeRun(task.id, 'wat')).toThrowError(/no open run/i);

    // Status unchanged, no spurious run_completed event
    expect(store.getTask(task.id)?.status).toBe('todo');
    const kinds = store.listEvents(task.id).map((e) => e.kind);
    expect(kinds).not.toContain('run_completed');
  });

  it('blockRun on a task with no open run throws', () => {
    const task = store.createTask({ title: 't' });
    expect(() => store.blockRun(task.id, 'wat')).toThrowError(/no open run/i);
    expect(store.getTask(task.id)?.status).toBe('todo');
  });

  it('heartbeatRun on a task with no open run throws and does not emit a heartbeat event', () => {
    const task = store.createTask({ title: 't' });
    expect(() => store.heartbeatRun(task.id)).toThrowError(/no open run/i);
    const kinds = store.listEvents(task.id).map((e) => e.kind);
    expect(kinds).not.toContain('heartbeat');
  });

  it('updateStatus transitioning out of running auto-cancels the open run (avoids divergent state)', () => {
    const task = store.createTask({ title: 'work' });
    store.updateStatus(task.id, 'running');
    const updated = store.updateStatus(task.id, 'done'); // bypassing completeRun

    expect(updated.status).toBe('done');
    expect(updated.currentRunId).toBeNull();
    const run = store.listRuns(task.id)[0];
    expect(run?.endedAt).not.toBeNull();
    expect(run?.outcome).toBe('cancelled');
  });

  it('archive on a running task also closes the open run', () => {
    const task = store.createTask({ title: 'work' });
    store.updateStatus(task.id, 'running');
    const archived = store.archive(task.id);

    expect(archived.status).toBe('archived');
    expect(archived.currentRunId).toBeNull();
    expect(store.listRuns(task.id)[0]?.outcome).toBe('cancelled');
  });

  // ---------------------------------------------------------------------------
  // Comments
  // ---------------------------------------------------------------------------

  it('addComment appends a comment and lists them in order', () => {
    const task = store.createTask({ title: 't' });
    store.addComment(task.id, 'engineer', 'first');
    store.addComment(task.id, 'engineer', 'second');

    const comments = store.listComments(task.id);
    expect(comments).toHaveLength(2);
    expect(comments[0]?.body).toBe('first');
    expect(comments[1]?.body).toBe('second');
    expect(comments[0]?.id).toMatch(/^c_[0-9a-f]{16}$/);
  });

  // ---------------------------------------------------------------------------
  // Assign / archive / unblock
  // ---------------------------------------------------------------------------

  it('assign sets the assignee and persists', () => {
    const task = store.createTask({ title: 't' });
    const updated = store.assign(task.id, 'reviewer');
    expect(updated.assignee).toBe('reviewer');
    expect(store.getTask(task.id)?.assignee).toBe('reviewer');
  });

  it('archive sets status=archived', () => {
    const task = store.createTask({ title: 't' });
    const archived = store.archive(task.id);
    expect(archived.status).toBe('archived');
  });

  // ---------------------------------------------------------------------------
  // bulkUpdateStatus / bulkAssign
  // ---------------------------------------------------------------------------

  it('bulkUpdateStatus transitions every task in the batch', () => {
    const a = store.createTask({ title: 'a' });
    const b = store.createTask({ title: 'b' });
    const c = store.createTask({ title: 'c' });

    store.bulkUpdateStatus([a.id, b.id, c.id], 'done', 'tester');

    expect(store.getTask(a.id)?.status).toBe('done');
    expect(store.getTask(b.id)?.status).toBe('done');
    expect(store.getTask(c.id)?.status).toBe('done');
  });

  it('bulkUpdateStatus rolls back the whole batch if any task id is invalid', () => {
    const a = store.createTask({ title: 'a' });
    const b = store.createTask({ title: 'b' });
    const c = store.createTask({ title: 'c' });

    // Invalid id sits in the middle so a and b would already be written if
    // this weren't wrapped in one transaction.
    expect(() => store.bulkUpdateStatus([a.id, b.id, 't_nope', c.id], 'done', 'tester')).toThrow();

    expect(store.getTask(a.id)?.status).toBe('todo');
    expect(store.getTask(b.id)?.status).toBe('todo');
    expect(store.getTask(c.id)?.status).toBe('todo');
  });

  it('bulkAssign sets the assignee on every task in the batch', () => {
    const a = store.createTask({ title: 'a' });
    const b = store.createTask({ title: 'b' });
    const c = store.createTask({ title: 'c' });

    store.bulkAssign([a.id, b.id, c.id], 'reviewer', 'tester');

    expect(store.getTask(a.id)?.assignee).toBe('reviewer');
    expect(store.getTask(b.id)?.assignee).toBe('reviewer');
    expect(store.getTask(c.id)?.assignee).toBe('reviewer');
  });

  it('bulkAssign rolls back the whole batch if any task id is invalid', () => {
    const a = store.createTask({ title: 'a' });
    const b = store.createTask({ title: 'b' });
    const c = store.createTask({ title: 'c' });

    expect(() => store.bulkAssign([a.id, b.id, 't_nope', c.id], 'reviewer', 'tester')).toThrow();

    expect(store.getTask(a.id)?.assignee).toBeNull();
    expect(store.getTask(b.id)?.assignee).toBeNull();
    expect(store.getTask(c.id)?.assignee).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Link + cycle prevention
  // ---------------------------------------------------------------------------

  it('link creates a parent/child edge that listTasks({parentId}) can find', () => {
    const a = store.createTask({ title: 'a' });
    const b = store.createTask({ title: 'b' });
    store.link(a.id, b.id);

    const children = store.listTasks({ parentId: a.id });
    expect(children.map((t) => t.id)).toEqual([b.id]);
  });

  it('link throws "not found" for an unknown parent_id', () => {
    const a = store.createTask({ title: 'a' });
    expect(() => store.link('t_nonexistent_____', a.id)).toThrowError(/not found/i);
  });

  it('link throws "not found" for an unknown child_id', () => {
    const a = store.createTask({ title: 'a' });
    expect(() => store.link(a.id, 't_nonexistent_____')).toThrowError(/not found/i);
  });

  it('link is idempotent: linking the same edge twice does not emit a duplicate event', () => {
    const a = store.createTask({ title: 'a' });
    const b = store.createTask({ title: 'b' });
    store.link(a.id, b.id);
    const before = store.listEvents(a.id).filter((e) => e.kind === 'linked').length;
    store.link(a.id, b.id);
    const after = store.listEvents(a.id).filter((e) => e.kind === 'linked').length;
    expect(after).toBe(before);
  });

  it('link rejects a direct cycle (a -> a)', () => {
    const a = store.createTask({ title: 'a' });
    expect(() => store.link(a.id, a.id)).toThrowError(/cycle/i);
  });

  it('link rejects an indirect cycle (a -> b -> c, then c -> a)', () => {
    const a = store.createTask({ title: 'a' });
    const b = store.createTask({ title: 'b' });
    const c = store.createTask({ title: 'c' });
    store.link(a.id, b.id);
    store.link(b.id, c.id);
    expect(() => store.link(c.id, a.id)).toThrowError(/cycle/i);
  });

  // ---------------------------------------------------------------------------
  // FTS5 search
  // ---------------------------------------------------------------------------

  it('searchFts finds tasks by FTS5 query over title or body', () => {
    const target = store.createTask({ title: 'fix flaky integration test', body: 'vitest hang' });
    store.createTask({ title: 'rotate keys' });

    const hits = store.searchFts('flaky');
    expect(hits.map((t) => t.id)).toContain(target.id);
    expect(hits.map((t) => t.id)).not.toContain(
      store.listTasks().find((t) => t.title === 'rotate keys')?.id,
    );
  });

  it('searchFts finds tasks via comment body', () => {
    const target = store.createTask({ title: 'login bug' });
    store.addComment(target.id, 'engineer', 'reproduced with safari + private mode');
    store.createTask({ title: 'cache warm' });

    const hits = store.searchFts('safari');
    expect(hits.map((t) => t.id)).toEqual([target.id]);
  });

  // ---------------------------------------------------------------------------
  // Audit trail (task_events)
  // ---------------------------------------------------------------------------

  it('every mutation inserts a task_events row with the expected kind', () => {
    const task = store.createTask({ title: 'audit me', actor: 'engineer' });

    store.updateStatus(task.id, 'running', undefined);
    store.heartbeatRun(task.id);
    store.addComment(task.id, 'engineer', 'progress note');
    const child = store.createTask({ title: 'child', actor: 'engineer' });
    store.link(task.id, child.id);
    store.assign(task.id, 'reviewer');
    store.completeRun(task.id, 'shipped');
    store.archive(task.id);

    const events = store.listEvents(task.id);
    const kinds = events.map((e) => e.kind);

    // The exact ordering of run_started vs status_changed-on-running is an
    // implementation detail; assert the multiset of expected kinds is present.
    expect(kinds).toEqual(
      expect.arrayContaining([
        'created',
        'status_changed', // todo -> running, and running -> done, and done -> archived
        'run_started',
        'heartbeat',
        'commented',
        'linked',
        'assigned',
        'run_completed',
        'archived',
      ]),
    );
  });

  // ---------------------------------------------------------------------------
  // File-backed DB re-open
  // ---------------------------------------------------------------------------

  it('re-opens an existing on-disk database without re-migrating and preserves data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanban-reopen-'));
    const dbPath = join(dir, 'kanban.db');
    try {
      const s1 = new KanbanStore(dbPath);
      const created = s1.createTask({ title: 'persisted' });
      s1.close();

      const s2 = new KanbanStore(dbPath);
      const found = s2.getTask(created.id);
      expect(found?.title).toBe('persisted');
      // Schema still works for new inserts after re-open
      const fresh = s2.createTask({ title: 'after reopen' });
      expect(s2.listTasks()).toHaveLength(2);
      expect(fresh.id).not.toBe(created.id);
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Plan B dispatcher helpers
  // ---------------------------------------------------------------------------

  it('promoteReady gates on real-work parents (assignee set) and treats goal parents (assignee=null) as transparent', () => {
    const noParent = store.createTask({ title: 'standalone' });
    const realParent = store.createTask({ title: 'real-work', assignee: 'engineer' });
    const goalParent = store.createTask({ title: 'goal' }); // no assignee = goal
    const childOfReal = store.createTask({ title: 'child-real', parents: [realParent.id] });
    const childOfGoal = store.createTask({ title: 'child-goal', parents: [goalParent.id] });

    // Real-work parent not done → its child stays todo. Goal parent is
    // transparent → its child promotes immediately. Standalone has no parents.
    let promoted = store.promoteReady();
    expect(promoted).toContain(noParent.id);
    expect(promoted).toContain(childOfGoal.id);
    expect(promoted).not.toContain(childOfReal.id);

    // Finish the real-work parent → its child becomes eligible.
    store.updateStatus(realParent.id, 'running');
    store.completeRun(realParent.id, 'real parent done');
    promoted = store.promoteReady();
    expect(promoted).toContain(childOfReal.id);
  });

  it('promoteScheduled promotes scheduled tasks whose time has passed', () => {
    const past = store.createTask({ title: 'past', scheduledFor: 1 });
    const future = store.createTask({ title: 'future', scheduledFor: Date.now() + 60_000 });
    const promoted = store.promoteScheduled(Date.now());
    expect(promoted).toEqual([past.id]);
    expect(promoted).not.toContain(future.id);
    expect(store.getTask(past.id)?.status).toBe('ready');
    expect(store.getTask(future.id)?.status).toBe('scheduled');
  });

  it('findStalledRuns returns only runs whose last_heartbeat_at is older than cutoff', () => {
    const fresh = store.createTask({ title: 'fresh' });
    store.updateStatus(fresh.id, 'running');
    const stale = store.createTask({ title: 'stale' });
    store.updateStatus(stale.id, 'running');

    const now = Date.now();
    // Backdate the second run by 200ms via direct UPDATE (test-only shortcut).
    const staleRunId = store.getTask(stale.id)?.currentRunId;
    expect(staleRunId).toBeTruthy();
    // Pretend stale run hasn't heartbeated in 200ms
    (
      store as unknown as {
        db: { prepare: (s: string) => { run: (a: number, b: string) => void } };
      }
    ).db
      .prepare('UPDATE task_runs SET last_heartbeat_at = ? WHERE id = ?')
      .run(now - 200, staleRunId as string);

    const stalled = store.findStalledRuns(100, now);
    expect(stalled.map((r) => r.taskId)).toEqual([stale.id]);
  });

  // ---------------------------------------------------------------------------
  // createSwarm (Lane A Phase 5 — atomic swarm-graph primitive)
  // ---------------------------------------------------------------------------

  it('createSwarm creates a done root + N workers + verifier + synthesizer, wired parent to child', () => {
    const result = store.createSwarm({
      goal: 'Ship the swarm primitive',
      workers: [
        { personality: 'worker-a', prompt: 'do part A' },
        { personality: 'worker-b', prompt: 'do part B' },
      ],
      verifierPersonality: 'verifier',
      synthesizerPersonality: 'synthesizer',
    });

    const root = store.getTask(result.rootId);
    expect(root?.status).toBe('done');
    expect(root?.assignee).toBeNull();

    expect(result.workerIds).toHaveLength(2);
    for (const workerId of result.workerIds) {
      const worker = store.getTask(workerId);
      expect(worker?.status).toBe('todo');
      expect(store.getParents(workerId).map((p) => p.id)).toEqual([result.rootId]);
    }

    expect(result.verifierId).not.toBeNull();
    const verifierParents = store.getParents(result.verifierId as string).map((p) => p.id);
    expect(verifierParents.sort()).toEqual([...result.workerIds].sort());
    expect(store.getTask(result.verifierId as string)?.assignee).toBe('verifier');

    expect(result.synthesizerId).not.toBeNull();
    expect(store.getParents(result.synthesizerId as string).map((p) => p.id)).toEqual([
      result.verifierId,
    ]);
    expect(store.getTask(result.synthesizerId as string)?.assignee).toBe('synthesizer');
  });

  it('createSwarm omits verifier/synthesizer tasks when their personalities are omitted', () => {
    const result = store.createSwarm({
      goal: 'goal',
      workers: [{ personality: 'w1', prompt: 'p1' }],
    });

    expect(result.verifierId).toBeNull();
    expect(result.synthesizerId).toBeNull();
    expect(store.listTasks()).toHaveLength(2); // root + 1 worker
  });

  it('createSwarm rolls back the whole graph if a failure hits partway through construction', () => {
    const originalCreateTask = store.createTask.bind(store);
    let calls = 0;
    vi.spyOn(store, 'createTask').mockImplementation((args) => {
      calls += 1;
      // Root (1st call) and worker-a (2nd call) succeed; blow up on worker-b (3rd).
      if (calls === 3) throw new Error('boom');
      return originalCreateTask(args);
    });

    expect(() =>
      store.createSwarm({
        goal: 'goal',
        workers: [
          { personality: 'worker-a', prompt: 'p1' },
          { personality: 'worker-b', prompt: 'p2' },
        ],
        verifierPersonality: 'verifier',
      }),
    ).toThrow(/boom/);

    // Root and worker-a were created inside the same outer transaction as the
    // failing worker-b create — the whole graph must roll back together, not
    // just the call that threw.
    expect(store.listTasks()).toHaveLength(0);

    vi.restoreAllMocks();
  });

  it('createSwarm + promoteReady: workers promote to ready once the root task is done', () => {
    const result = store.createSwarm({
      goal: 'goal',
      workers: [
        { personality: 'worker-a', prompt: 'p1' },
        { personality: 'worker-b', prompt: 'p2' },
      ],
    });

    expect(store.getTask(result.rootId)?.status).toBe('done');
    for (const workerId of result.workerIds) {
      expect(store.getTask(workerId)?.status).toBe('todo');
    }

    const promoted = store.promoteReady();
    expect(promoted.sort()).toEqual([...result.workerIds].sort());
    for (const workerId of result.workerIds) {
      expect(store.getTask(workerId)?.status).toBe('ready');
    }
  });

  // ---------------------------------------------------------------------------
  // Goal rollup — assignee=null parents complete when all their children do
  // ---------------------------------------------------------------------------

  it('rollupCompletedGoals promotes a goal to done when every child is done', () => {
    const goal = store.createTask({ title: 'Q3 roadmap' });
    const c1 = store.createTask({ title: 'a', assignee: 'engineer', parents: [goal.id] });
    const c2 = store.createTask({ title: 'b', assignee: 'researcher', parents: [goal.id] });
    store.updateStatus(c1.id, 'running');
    store.completeRun(c1.id, 'done a');
    store.updateStatus(c2.id, 'running');
    store.completeRun(c2.id, 'done b');

    const completed = store.rollupCompletedGoals();
    expect(completed).toContain(goal.id);
    expect(store.getTask(goal.id)?.status).toBe('done');
  });

  it('rollupCompletedGoals leaves goals alone while any child is unfinished', () => {
    const goal = store.createTask({ title: 'wip' });
    const c1 = store.createTask({ title: 'a', assignee: 'engineer', parents: [goal.id] });
    store.createTask({ title: 'b', assignee: 'researcher', parents: [goal.id] });
    store.updateStatus(c1.id, 'running');
    store.completeRun(c1.id, 'half-done');

    const completed = store.rollupCompletedGoals();
    expect(completed).not.toContain(goal.id);
    expect(store.getTask(goal.id)?.status).not.toBe('done');
  });

  it('rollupCompletedGoals ignores goals with no children (nothing to roll up from)', () => {
    const empty = store.createTask({ title: 'placeholder goal' });
    expect(store.rollupCompletedGoals()).not.toContain(empty.id);
  });

  it('rollupCompletedGoals ignores goals whose every child was archived (refuses to silently swallow)', () => {
    const goal = store.createTask({ title: 'abandoned' });
    const c = store.createTask({ title: 'c', assignee: 'engineer', parents: [goal.id] });
    store.archive(c.id);

    expect(store.rollupCompletedGoals()).not.toContain(goal.id);
    expect(store.getTask(goal.id)?.status).not.toBe('done');
  });

  it('rollupCompletedGoals never touches real-work tasks (assignee set)', () => {
    const parent = store.createTask({ title: 'real-work parent', assignee: 'engineer' });
    const c = store.createTask({ title: 'c', assignee: 'researcher', parents: [parent.id] });
    store.updateStatus(c.id, 'running');
    store.completeRun(c.id, 'done c');

    expect(store.rollupCompletedGoals()).not.toContain(parent.id);
    // Parent stays at whatever status it was — rollup is a goal-only operation.
    expect(store.getTask(parent.id)?.status).not.toBe('done');
  });

  // ---------------------------------------------------------------------------
  // Orphan adoption — unassigned non-goal tickets get reassigned to coordinator
  // ---------------------------------------------------------------------------

  it('adoptOrphanTickets reassigns a leaf task with no assignee to the coordinator', () => {
    const orphan = store.createTask({ title: 'lost ticket' });
    const adopted = store.adoptOrphanTickets('coordinator', { gracePeriodMs: 0 });
    expect(adopted).toContain(orphan.id);
    expect(store.getTask(orphan.id)?.assignee).toBe('coordinator');
  });

  it('adoptOrphanTickets does NOT touch goals (assignee=null + has children)', () => {
    const goal = store.createTask({ title: 'Q3 roadmap' });
    store.createTask({ title: 'child', assignee: 'engineer', parents: [goal.id] });
    const adopted = store.adoptOrphanTickets('coordinator', { gracePeriodMs: 0 });
    expect(adopted).not.toContain(goal.id);
    expect(store.getTask(goal.id)?.assignee).toBeNull();
  });

  it('adoptOrphanTickets does NOT touch already-assigned tasks', () => {
    const assigned = store.createTask({ title: 'real work', assignee: 'engineer' });
    const adopted = store.adoptOrphanTickets('coordinator', { gracePeriodMs: 0 });
    expect(adopted).not.toContain(assigned.id);
    expect(store.getTask(assigned.id)?.assignee).toBe('engineer');
  });

  it('adoptOrphanTickets does NOT touch done or archived tasks (closed work)', () => {
    const done = store.createTask({ title: 'done leaf' });
    const archived = store.createTask({ title: 'archived leaf' });
    store.updateStatus(done.id, 'done');
    store.archive(archived.id);

    const adopted = store.adoptOrphanTickets('coordinator', { gracePeriodMs: 0 });
    expect(adopted).not.toContain(done.id);
    expect(adopted).not.toContain(archived.id);
  });

  it('adoptOrphanTickets honours gracePeriodMs — fresh orphans are protected from race', () => {
    // Without the grace window, kanban_create_goal would race the dispatcher:
    // the goal lives ~milliseconds without children before the coordinator
    // calls kanban_create on each child. A non-zero grace prevents premature
    // adoption during that window.
    const fresh = store.createTask({ title: 'goal in flight' });
    const adopted = store.adoptOrphanTickets('coordinator', { gracePeriodMs: 60_000 });
    expect(adopted).not.toContain(fresh.id);
    expect(store.getTask(fresh.id)?.assignee).toBeNull();
  });

  it('adoptOrphanTickets emits an `assigned` event so the coordinator sees the adoption', () => {
    const orphan = store.createTask({ title: 'lost ticket' });
    store.adoptOrphanTickets('coordinator', { gracePeriodMs: 0, actor: 'dispatcher' });
    const events = store.listEvents(orphan.id);
    const assigned = events.find((e) => e.kind === 'assigned');
    expect(assigned).toBeDefined();
    expect(assigned?.actor).toBe('dispatcher');
  });

  it('findReadyToDispatch returns ready tasks with an assignee and no open run, ordered by priority', () => {
    const t1 = store.createTask({ title: 'p2', assignee: 'engineer', priority: 2 });
    const t2 = store.createTask({ title: 'p9', assignee: 'researcher', priority: 9 });
    store.createTask({ title: 'unassigned' }); // no assignee
    const t4 = store.createTask({ title: 'in-prog', assignee: 'engineer' });
    store.updateStatus(t1.id, 'ready');
    store.updateStatus(t2.id, 'ready');
    store.updateStatus(t4.id, 'ready');
    store.updateStatus(t4.id, 'running'); // has a current_run_id now

    const out = store.findReadyToDispatch();
    expect(out.map((t) => t.id)).toEqual([t2.id, t1.id]); // priority 9 before 2
  });

  // ---------------------------------------------------------------------------
  // Staleness reclaim — stuck `running` tasks get put back to `ready`
  // ---------------------------------------------------------------------------

  it('heartbeatRun bumps tasks.updated_at so updated_at means "last activity"', async () => {
    const task = store.createTask({ title: 'long' });
    store.updateStatus(task.id, 'running');
    const before = store.getTask(task.id)?.updatedAt ?? 0;

    await new Promise((r) => setTimeout(r, 5));
    store.heartbeatRun(task.id);

    const after = store.getTask(task.id)?.updatedAt ?? 0;
    expect(after).toBeGreaterThan(before);
  });

  it('findStaleRunningTasks returns running tasks whose updated_at is older than the threshold', () => {
    const fresh = store.createTask({ title: 'fresh' });
    store.updateStatus(fresh.id, 'running');
    const stale = store.createTask({ title: 'stale' });
    store.updateStatus(stale.id, 'running');

    const now = Date.now();
    // Backdate the stale task's updated_at via direct UPDATE (test-only shortcut).
    (
      store as unknown as {
        db: { prepare: (s: string) => { run: (a: number, b: string) => void } };
      }
    ).db
      .prepare('UPDATE tasks SET updated_at = ? WHERE id = ?')
      .run(now - 200, stale.id);

    const out = store.findStaleRunningTasks(100, now);
    expect(out.map((t) => t.id)).toEqual([stale.id]);
  });

  it('findStaleRunningTasks ignores non-running tasks even if updated_at is old', () => {
    const ready = store.createTask({ title: 'old ready' });
    store.updateStatus(ready.id, 'ready');
    const now = Date.now();
    (
      store as unknown as {
        db: { prepare: (s: string) => { run: (a: number, b: string) => void } };
      }
    ).db
      .prepare('UPDATE tasks SET updated_at = ? WHERE id = ?')
      .run(now - 10_000, ready.id);

    expect(store.findStaleRunningTasks(100, now)).toEqual([]);
  });

  it('reclaimTask ends the open run (cancelled) and sets the task back to ready', () => {
    const task = store.createTask({ title: 'stuck' });
    store.updateStatus(task.id, 'running');

    const reclaimed = store.reclaimTask(task.id, 'orphan_stale');
    expect(reclaimed.status).toBe('ready');
    expect(reclaimed.currentRunId).toBeNull();

    const run = store.listRuns(task.id)[0];
    expect(run?.outcome).toBe('cancelled');
    expect(run?.endedAt).not.toBeNull();
  });

  it('reclaimTask records the reason in the status_changed audit event', () => {
    const task = store.createTask({ title: 'stuck' });
    store.updateStatus(task.id, 'running');

    store.reclaimTask(task.id, 'orphan_no_owner', 'dispatcher');
    const events = store.listEvents(task.id);
    const statusChange = events.find((e) => e.kind === 'status_changed' && e.data.to === 'ready');
    expect(statusChange).toBeDefined();
    expect(statusChange?.data.reason).toBe('orphan_no_owner');
    expect(statusChange?.actor).toBe('dispatcher');
  });

  it('reclaimTask on a task with no open run sets it to ready without throwing', () => {
    const task = store.createTask({ title: 'no run' });
    const reclaimed = store.reclaimTask(task.id, 'orphan_stale');
    expect(reclaimed.status).toBe('ready');
  });

  // ---------------------------------------------------------------------------
  // Cycle prevention — deterministic stress
  // ---------------------------------------------------------------------------

  it('no sequence of link() calls can produce a cycle (200 attempts)', () => {
    const ids = Array.from({ length: 30 }, (_, i) => store.createTask({ title: `n${i}` }).id);
    // Deterministic PRNG
    let seed = 0xc0ffee;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };

    let succeeded = 0;
    let rejected = 0;
    for (let i = 0; i < 200; i++) {
      const a = ids[next() % ids.length] as string;
      const b = ids[next() % ids.length] as string;
      try {
        store.link(a, b);
        succeeded++;
      } catch (e) {
        if ((e as Error).message.includes('cycle')) {
          rejected++;
        } else {
          throw e;
        }
      }
    }

    expect(succeeded + rejected).toBe(200);

    // Reachability check: traverse the child edges from each node and confirm
    // we never reach the starting node. This is necessary (and sufficient for
    // these small graphs) for the resulting edge set to be a DAG.
    for (const start of ids) {
      const visited = new Set<string>();
      const stack = [start];
      while (stack.length > 0) {
        const cur = stack.pop() as string;
        if (visited.has(cur)) continue;
        visited.add(cur);
        const children = store.listTasks({ parentId: cur });
        for (const c of children) {
          if (c.id === start) {
            throw new Error(`Cycle detected: ${start} reaches itself via ${cur}`);
          }
          stack.push(c.id);
        }
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Retry budgets
  // ---------------------------------------------------------------------------

  it('createTask defaults retryCount to 0 and maxRetries to null (unlimited)', () => {
    const task = store.createTask({ title: 'work' });
    expect(task.retryCount).toBe(0);
    expect(task.maxRetries).toBeNull();
  });

  it('createTask persists an explicit maxRetries', () => {
    const task = store.createTask({ title: 'work', maxRetries: 2 });
    expect(task.maxRetries).toBe(2);
    expect(store.getTask(task.id)?.maxRetries).toBe(2);
  });

  it('createTask rejects a negative or non-integer maxRetries', () => {
    expect(() => store.createTask({ title: 'work', maxRetries: -1 })).toThrow(/non-negative/);
    expect(() => store.createTask({ title: 'work', maxRetries: 1.5 })).toThrow(/non-negative/);
  });

  it('updateStatus increments retryCount on re-claim but not on the first claim', () => {
    const task = store.createTask({ title: 'work' });

    // First claim — no prior runs, so this is not a re-claim.
    const firstClaim = store.updateStatus(task.id, 'running', 'dispatched');
    expect(firstClaim.retryCount).toBe(0);
    store.blockRun(task.id, 'stalled');

    // Second claim — a prior run exists, so this counts as a re-claim.
    const reclaim = store.updateStatus(task.id, 'running', 'dispatched');
    expect(reclaim.retryCount).toBe(1);
  });

  it('updateStatus keeps re-claiming forever when maxRetries is null (unlimited)', () => {
    const task = store.createTask({ title: 'work' });
    for (let i = 0; i < 5; i++) {
      const claimed = store.updateStatus(task.id, 'running', 'dispatched');
      expect(claimed.status).toBe('running');
      store.blockRun(task.id, `stalled ${i}`);
    }
    expect(store.getTask(task.id)?.retryCount).toBe(4);
  });

  it('fails a task with maxRetries=2 on the re-claim that exceeds the budget, with the typed reason', () => {
    const task = store.createTask({ title: 'impossible', maxRetries: 2 });

    // Claim 1 (retryCount stays 0 — first claim, not a re-claim), fails.
    expect(store.updateStatus(task.id, 'running', 'dispatched').status).toBe('running');
    store.blockRun(task.id, 'failed attempt 1');

    // Claim 2 (re-claim -> retryCount 1, within budget), fails.
    expect(store.updateStatus(task.id, 'running', 'dispatched').status).toBe('running');
    store.blockRun(task.id, 'failed attempt 2');

    // Claim 3 (re-claim -> retryCount 2, 2 <= 2 still within budget), fails.
    expect(store.updateStatus(task.id, 'running', 'dispatched').status).toBe('running');
    store.blockRun(task.id, 'failed attempt 3');

    // Claim 4 (re-claim -> retryCount 3, 3 > 2): budget exhausted. updateStatus
    // itself lands the task in 'failed' instead of opening another run.
    const failed = store.updateStatus(task.id, 'running', 'dispatched');
    expect(failed.status).toBe('failed');
    expect(failed.currentRunId).toBeNull();
    expect(failed.retryCount).toBe(3);
    // No fourth run was opened — the budget guard fired before the run insert.
    expect(store.listRuns(task.id)).toHaveLength(3);

    // The transition emits status_changed with the typed reason.
    const events = store.listEvents(task.id);
    const statusEvents = events.filter((e) => e.kind === 'status_changed');
    const last = statusEvents[statusEvents.length - 1];
    expect(last?.data.to).toBe('failed');
    expect(last?.data.reason).toBe('retry_budget_exhausted');
  });

  it('a task with maxRetries=0 fails on its first re-claim', () => {
    const task = store.createTask({ title: 'one-shot', maxRetries: 0 });
    expect(store.updateStatus(task.id, 'running').status).toBe('running'); // first claim ok
    store.blockRun(task.id, 'failed once');
    // First re-claim: retryCount would go to 1 > 0 — fails immediately.
    expect(store.updateStatus(task.id, 'running').status).toBe('failed');
  });

  // ---------------------------------------------------------------------------
  // Schema migration v1 -> v2
  // ---------------------------------------------------------------------------

  it('migrates a v1 database to v2: data survives, new columns appear, failed becomes insertable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanban-mig-'));
    const dbPath = join(dir, 'board.db');
    try {
      // Hand-build the FULL v1 database: every table, index, and trigger that
      // shipped at user_version=1, populated with rows in each FK child table
      // (task_comments / task_links / task_runs / task_events). The riskiest
      // part of the migration is the tasks-table rebuild while those FKs point
      // at it, so the fixture must exercise that surface.
      const v1 = new Database(dbPath);
      v1.pragma('journal_mode = WAL');
      v1.pragma('foreign_keys = ON');
      v1.exec(`
        CREATE TABLE tasks (
          id              TEXT PRIMARY KEY,
          title           TEXT NOT NULL,
          body            TEXT NOT NULL DEFAULT '',
          assignee        TEXT,
          status          TEXT NOT NULL
                          CHECK (status IN ('todo','ready','running','blocked','done','archived','scheduled')),
          priority        INTEGER NOT NULL DEFAULT 0,
          workspace_mode  TEXT NOT NULL DEFAULT 'scratch'
                          CHECK (workspace_mode IN ('scratch','worktree','dir')),
          workspace_path  TEXT,
          scheduled_for   INTEGER,
          idempotency_key TEXT,
          current_run_id  TEXT,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX tasks_idem ON tasks(idempotency_key)
          WHERE idempotency_key IS NOT NULL;
        CREATE INDEX tasks_status_assignee ON tasks(status, assignee);
        CREATE INDEX tasks_scheduled ON tasks(scheduled_for)
          WHERE scheduled_for IS NOT NULL;

        CREATE TABLE task_comments (
          id         TEXT PRIMARY KEY,
          task_id    TEXT NOT NULL,
          author     TEXT NOT NULL,
          body       TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX task_comments_task ON task_comments(task_id, created_at);

        CREATE TABLE task_links (
          parent_id TEXT NOT NULL,
          child_id  TEXT NOT NULL,
          PRIMARY KEY (parent_id, child_id),
          FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE,
          FOREIGN KEY (child_id)  REFERENCES tasks(id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX task_links_child ON task_links(child_id);

        CREATE TABLE task_runs (
          id                TEXT PRIMARY KEY,
          task_id           TEXT NOT NULL,
          started_at        INTEGER NOT NULL,
          ended_at          INTEGER,
          outcome           TEXT CHECK (outcome IS NULL OR outcome IN ('completed','blocked','stalled','cancelled')),
          summary           TEXT,
          last_heartbeat_at INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX task_runs_task ON task_runs(task_id, started_at);
        CREATE UNIQUE INDEX task_runs_open_one ON task_runs(task_id)
          WHERE ended_at IS NULL;

        CREATE TABLE task_events (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id    TEXT NOT NULL,
          kind       TEXT NOT NULL
                     CHECK (kind IN ('created','status_changed','commented','assigned','linked','unlinked','run_started','run_completed','heartbeat','archived')),
          actor      TEXT NOT NULL,
          data_json  TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX task_events_task ON task_events(task_id, created_at);
        CREATE INDEX task_events_recent ON task_events(created_at);

        CREATE VIRTUAL TABLE task_fts USING fts5(
          task_id UNINDEXED, title, body, comments, tokenize = 'porter'
        );
        CREATE TRIGGER tasks_fts_ai AFTER INSERT ON tasks BEGIN
          INSERT INTO task_fts(task_id, title, body, comments)
          VALUES (new.id, new.title, new.body, '');
        END;
        CREATE TRIGGER tasks_fts_au AFTER UPDATE OF title, body ON tasks BEGIN
          UPDATE task_fts SET title = new.title, body = new.body
          WHERE task_id = new.id;
        END;
        CREATE TRIGGER tasks_fts_ad AFTER DELETE ON tasks BEGIN
          DELETE FROM task_fts WHERE task_id = old.id;
        END;
        CREATE TRIGGER comments_fts_ai AFTER INSERT ON task_comments BEGIN
          UPDATE task_fts
          SET comments = (
            SELECT COALESCE(GROUP_CONCAT(body, ' '), '')
            FROM task_comments WHERE task_id = new.task_id
          )
          WHERE task_id = new.task_id;
        END;

        INSERT INTO tasks (id, title, body, assignee, status, priority, workspace_mode,
                           current_run_id, created_at, updated_at)
          VALUES
            ('t_parent', 'legacy parent', 'pre-migration body', NULL, 'ready', 0, 'scratch', NULL, 900, 900),
            ('t_seed', 'legacy task', 'pre-migration body', 'engineer', 'running', 1, 'scratch', 'r_open', 1000, 1000);
        INSERT INTO task_links (parent_id, child_id) VALUES ('t_parent', 't_seed');
        INSERT INTO task_comments (id, task_id, author, body, created_at)
          VALUES ('c_1', 't_seed', 'engineer', 'a legacy comment', 1100);
        INSERT INTO task_runs (id, task_id, started_at, ended_at, outcome, summary, last_heartbeat_at)
          VALUES
            ('r_done', 't_seed', 1000, 1050, 'blocked', 'first attempt', 1050),
            ('r_open', 't_seed', 1200, NULL, NULL, NULL, 1200);
        INSERT INTO task_events (task_id, kind, actor, data_json, created_at)
          VALUES ('t_seed', 'created', 'engineer', '{}', 1000);
      `);
      v1.pragma('user_version = 1');
      v1.close();

      // Opening with the current code runs the v1 -> v2 migration.
      const store = new KanbanStore(dbPath);
      try {
        const seed = store.getTask('t_seed');
        expect(seed).not.toBeNull();
        expect(seed?.title).toBe('legacy task');
        expect(seed?.body).toBe('pre-migration body');
        expect(seed?.assignee).toBe('engineer');
        expect(seed?.priority).toBe(1);
        expect(seed?.status).toBe('running');
        expect(seed?.currentRunId).toBe('r_open');
        // New columns are present with their backfill defaults.
        expect(seed?.maxRetries).toBeNull();
        expect(seed?.retryCount).toBe(0);

        // FK child rows survive the tasks-table rebuild.
        expect(store.listComments('t_seed').map((c) => c.id)).toEqual(['c_1']);
        expect(store.listRuns('t_seed').map((r) => r.id)).toEqual(['r_done', 'r_open']);
        expect(store.getParents('t_seed').map((p) => p.id)).toEqual(['t_parent']);
        expect(store.listEvents('t_seed').map((e) => e.kind)).toContain('created');

        // The widened CHECK accepts the new 'failed' status: a re-claim past
        // budget on the post-migration schema lands the task in 'failed'.
        const failable = store.createTask({ title: 'will fail', maxRetries: 0 });
        store.updateStatus(failable.id, 'running');
        store.blockRun(failable.id, 'attempt 1');
        expect(store.updateStatus(failable.id, 'running').status).toBe('failed');

        // FTS triggers were rebuilt — search over title still works.
        expect(
          store
            .listTasks({ q: 'legacy' })
            .map((t) => t.id)
            .sort(),
        ).toEqual(['t_parent', 't_seed'].sort());
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls the v1->v2 migration back atomically when it fails — no half-migrated state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanban-mig-fail-'));
    const dbPath = join(dir, 'board.db');
    try {
      // A v1 DB with an orphan task_comments row (FK points at a missing task).
      // The migration's `foreign_key_check` catches it and throws — which must
      // roll the WHOLE transaction back: no new columns, user_version still 1.
      const v1 = new Database(dbPath);
      v1.pragma('journal_mode = WAL');
      // foreign_keys OFF so the orphan row can be inserted in the first place.
      v1.pragma('foreign_keys = OFF');
      v1.exec(`
        CREATE TABLE tasks (
          id              TEXT PRIMARY KEY,
          title           TEXT NOT NULL,
          body            TEXT NOT NULL DEFAULT '',
          assignee        TEXT,
          status          TEXT NOT NULL
                          CHECK (status IN ('todo','ready','running','blocked','done','archived','scheduled')),
          priority        INTEGER NOT NULL DEFAULT 0,
          workspace_mode  TEXT NOT NULL DEFAULT 'scratch'
                          CHECK (workspace_mode IN ('scratch','worktree','dir')),
          workspace_path  TEXT,
          scheduled_for   INTEGER,
          idempotency_key TEXT,
          current_run_id  TEXT,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE task_comments (
          id         TEXT PRIMARY KEY,
          task_id    TEXT NOT NULL,
          author     TEXT NOT NULL,
          body       TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        ) STRICT;
        CREATE VIRTUAL TABLE task_fts USING fts5(
          task_id UNINDEXED, title, body, comments, tokenize = 'porter'
        );
        INSERT INTO tasks (id, title, status, created_at, updated_at)
          VALUES ('t_ok', 'fine', 'todo', 1, 1);
        INSERT INTO task_comments (id, task_id, author, body, created_at)
          VALUES ('c_orphan', 't_missing', 'someone', 'dangling', 2);
      `);
      v1.pragma('user_version = 1');
      v1.close();

      // The migration must throw — and leave nothing behind.
      expect(() => new KanbanStore(dbPath)).toThrow(/foreign-key violation/);

      // Inspect the raw DB: still v1, no retry columns, original rows intact.
      const after = new Database(dbPath);
      try {
        const version = (after.pragma('user_version') as Array<{ user_version: number }>)[0]
          ?.user_version;
        expect(version).toBe(1);
        const cols = (after.pragma('table_info(tasks)') as Array<{ name: string }>).map(
          (c) => c.name,
        );
        expect(cols).not.toContain('max_retries');
        expect(cols).not.toContain('retry_count');
        const taskCount = (after.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number })
          .n;
        expect(taskCount).toBe(1);
      } finally {
        after.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to open a database whose user_version is newer than the code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanban-ver-'));
    const dbPath = join(dir, 'board.db');
    try {
      const future = new Database(dbPath);
      future.pragma('user_version = 7');
      future.close();
      expect(() => new KanbanStore(dbPath)).toThrow(/newer than code/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Schema migration v2 -> v3
  // ---------------------------------------------------------------------------

  // Hand-builds a full v2 database (the shape that shipped at user_version=2),
  // populated across every FK child table so the tasks-table rebuild surface is
  // exercised. Caller picks the path; nothing is set up beyond the raw schema.
  function buildV2Db(dbPath: string): void {
    const v2 = new Database(dbPath);
    v2.pragma('journal_mode = WAL');
    v2.pragma('foreign_keys = ON');
    v2.exec(`
      CREATE TABLE tasks (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        body            TEXT NOT NULL DEFAULT '',
        assignee        TEXT,
        status          TEXT NOT NULL
                        CHECK (status IN ('todo','ready','running','blocked','done','archived','scheduled','failed')),
        priority        INTEGER NOT NULL DEFAULT 0,
        workspace_mode  TEXT NOT NULL DEFAULT 'scratch'
                        CHECK (workspace_mode IN ('scratch','worktree','dir')),
        workspace_path  TEXT,
        scheduled_for   INTEGER,
        idempotency_key TEXT,
        current_run_id  TEXT,
        max_retries     INTEGER CHECK (max_retries IS NULL OR max_retries >= 0),
        retry_count     INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX tasks_idem ON tasks(idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX tasks_status_assignee ON tasks(status, assignee);
      CREATE INDEX tasks_scheduled ON tasks(scheduled_for)
        WHERE scheduled_for IS NOT NULL;

      CREATE TABLE task_comments (
        id         TEXT PRIMARY KEY,
        task_id    TEXT NOT NULL,
        author     TEXT NOT NULL,
        body       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX task_comments_task ON task_comments(task_id, created_at);

      CREATE TABLE task_links (
        parent_id TEXT NOT NULL,
        child_id  TEXT NOT NULL,
        PRIMARY KEY (parent_id, child_id),
        FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (child_id)  REFERENCES tasks(id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX task_links_child ON task_links(child_id);

      CREATE TABLE task_runs (
        id                TEXT PRIMARY KEY,
        task_id           TEXT NOT NULL,
        started_at        INTEGER NOT NULL,
        ended_at          INTEGER,
        outcome           TEXT CHECK (outcome IS NULL OR outcome IN ('completed','blocked','stalled','cancelled')),
        summary           TEXT,
        last_heartbeat_at INTEGER NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX task_runs_task ON task_runs(task_id, started_at);
      CREATE UNIQUE INDEX task_runs_open_one ON task_runs(task_id)
        WHERE ended_at IS NULL;

      CREATE TABLE task_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id    TEXT NOT NULL,
        kind       TEXT NOT NULL
                   CHECK (kind IN ('created','status_changed','commented','assigned','linked','unlinked','run_started','run_completed','heartbeat','archived')),
        actor      TEXT NOT NULL,
        data_json  TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX task_events_task ON task_events(task_id, created_at);
      CREATE INDEX task_events_recent ON task_events(created_at);

      CREATE VIRTUAL TABLE task_fts USING fts5(
        task_id UNINDEXED, title, body, comments, tokenize = 'porter'
      );
      CREATE TRIGGER tasks_fts_ai AFTER INSERT ON tasks BEGIN
        INSERT INTO task_fts(task_id, title, body, comments)
        VALUES (new.id, new.title, new.body, '');
      END;
      CREATE TRIGGER tasks_fts_au AFTER UPDATE OF title, body ON tasks BEGIN
        UPDATE task_fts SET title = new.title, body = new.body
        WHERE task_id = new.id;
      END;
      CREATE TRIGGER tasks_fts_ad AFTER DELETE ON tasks BEGIN
        DELETE FROM task_fts WHERE task_id = old.id;
      END;
      CREATE TRIGGER comments_fts_ai AFTER INSERT ON task_comments BEGIN
        UPDATE task_fts
        SET comments = (
          SELECT COALESCE(GROUP_CONCAT(body, ' '), '')
          FROM task_comments WHERE task_id = new.task_id
        )
        WHERE task_id = new.task_id;
      END;

      INSERT INTO tasks (id, title, body, assignee, status, priority, workspace_mode,
                         current_run_id, max_retries, retry_count, created_at, updated_at)
        VALUES
          ('t_parent', 'legacy parent', 'pre-migration body', NULL, 'ready', 0, 'scratch', NULL, NULL, 0, 900, 900),
          ('t_seed', 'legacy task', 'pre-migration body', 'engineer', 'running', 1, 'scratch', 'r_open', 5, 2, 1000, 1000);
      INSERT INTO task_links (parent_id, child_id) VALUES ('t_parent', 't_seed');
      INSERT INTO task_comments (id, task_id, author, body, created_at)
        VALUES ('c_1', 't_seed', 'engineer', 'a legacy comment', 1100);
      INSERT INTO task_runs (id, task_id, started_at, ended_at, outcome, summary, last_heartbeat_at)
        VALUES
          ('r_done', 't_seed', 1000, 1050, 'blocked', 'first attempt', 1050),
          ('r_open', 't_seed', 1200, NULL, NULL, NULL, 1200);
      INSERT INTO task_events (task_id, kind, actor, data_json, created_at)
        VALUES ('t_seed', 'created', 'engineer', '{}', 1000);
    `);
    v2.pragma('user_version = 2');
    v2.close();
  }

  it('migrates a v2 database to v3: data survives, acceptance_criteria appears, needs_revision becomes insertable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanban-mig23-'));
    const dbPath = join(dir, 'board.db');
    try {
      buildV2Db(dbPath);

      // Opening with the current code runs the v2 -> v3 migration.
      const store = new KanbanStore(dbPath);
      try {
        const seed = store.getTask('t_seed');
        expect(seed).not.toBeNull();
        expect(seed?.title).toBe('legacy task');
        expect(seed?.body).toBe('pre-migration body');
        expect(seed?.assignee).toBe('engineer');
        expect(seed?.priority).toBe(1);
        expect(seed?.status).toBe('running');
        expect(seed?.currentRunId).toBe('r_open');
        // v2 columns survive.
        expect(seed?.maxRetries).toBe(5);
        expect(seed?.retryCount).toBe(2);
        // The new v3 column is present, backfilled to null.
        expect(seed?.acceptanceCriteria).toBeNull();

        // FK child rows survive the tasks-table rebuild.
        expect(store.listComments('t_seed').map((c) => c.id)).toEqual(['c_1']);
        expect(store.listRuns('t_seed').map((r) => r.id)).toEqual(['r_done', 'r_open']);
        expect(store.getParents('t_seed').map((p) => p.id)).toEqual(['t_parent']);
        expect(store.listEvents('t_seed').map((e) => e.kind)).toContain('created');

        // The widened CHECK accepts the new 'needs_revision' status.
        const t = store.createTask({ title: 'will need revision' });
        expect(store.updateStatus(t.id, 'needs_revision', 'missing tests').status).toBe(
          'needs_revision',
        );

        // FTS triggers were rebuilt — search over title still works.
        expect(
          store
            .listTasks({ q: 'legacy' })
            .map((t) => t.id)
            .sort(),
        ).toEqual(['t_parent', 't_seed'].sort());
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates a v1 database through the stepwise v1->v2->v3 chain (columns + statuses)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanban-mig13-'));
    const dbPath = join(dir, 'board.db');
    try {
      // A minimal v1 database (no retry columns, narrow status CHECK).
      const v1 = new Database(dbPath);
      v1.pragma('journal_mode = WAL');
      v1.pragma('foreign_keys = ON');
      v1.exec(`
        CREATE TABLE tasks (
          id              TEXT PRIMARY KEY,
          title           TEXT NOT NULL,
          body            TEXT NOT NULL DEFAULT '',
          assignee        TEXT,
          status          TEXT NOT NULL
                          CHECK (status IN ('todo','ready','running','blocked','done','archived','scheduled')),
          priority        INTEGER NOT NULL DEFAULT 0,
          workspace_mode  TEXT NOT NULL DEFAULT 'scratch'
                          CHECK (workspace_mode IN ('scratch','worktree','dir')),
          workspace_path  TEXT,
          scheduled_for   INTEGER,
          idempotency_key TEXT,
          current_run_id  TEXT,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX tasks_idem ON tasks(idempotency_key)
          WHERE idempotency_key IS NOT NULL;
        CREATE INDEX tasks_status_assignee ON tasks(status, assignee);
        CREATE INDEX tasks_scheduled ON tasks(scheduled_for)
          WHERE scheduled_for IS NOT NULL;
        CREATE TABLE task_comments (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL,
          body TEXT NOT NULL, created_at INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX task_comments_task ON task_comments(task_id, created_at);
        CREATE TABLE task_links (
          parent_id TEXT NOT NULL, child_id TEXT NOT NULL,
          PRIMARY KEY (parent_id, child_id),
          FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE,
          FOREIGN KEY (child_id)  REFERENCES tasks(id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX task_links_child ON task_links(child_id);
        CREATE TABLE task_runs (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL, started_at INTEGER NOT NULL,
          ended_at INTEGER,
          outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed','blocked','stalled','cancelled')),
          summary TEXT, last_heartbeat_at INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX task_runs_task ON task_runs(task_id, started_at);
        CREATE UNIQUE INDEX task_runs_open_one ON task_runs(task_id)
          WHERE ended_at IS NULL;
        CREATE TABLE task_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
          kind TEXT NOT NULL
               CHECK (kind IN ('created','status_changed','commented','assigned','linked','unlinked','run_started','run_completed','heartbeat','archived')),
          actor TEXT NOT NULL, data_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX task_events_task ON task_events(task_id, created_at);
        CREATE INDEX task_events_recent ON task_events(created_at);
        CREATE VIRTUAL TABLE task_fts USING fts5(
          task_id UNINDEXED, title, body, comments, tokenize = 'porter'
        );
        CREATE TRIGGER tasks_fts_ai AFTER INSERT ON tasks BEGIN
          INSERT INTO task_fts(task_id, title, body, comments)
          VALUES (new.id, new.title, new.body, '');
        END;
        CREATE TRIGGER tasks_fts_au AFTER UPDATE OF title, body ON tasks BEGIN
          UPDATE task_fts SET title = new.title, body = new.body WHERE task_id = new.id;
        END;
        CREATE TRIGGER tasks_fts_ad AFTER DELETE ON tasks BEGIN
          DELETE FROM task_fts WHERE task_id = old.id;
        END;
        CREATE TRIGGER comments_fts_ai AFTER INSERT ON task_comments BEGIN
          UPDATE task_fts
          SET comments = (
            SELECT COALESCE(GROUP_CONCAT(body, ' '), '')
            FROM task_comments WHERE task_id = new.task_id
          )
          WHERE task_id = new.task_id;
        END;
        INSERT INTO tasks (id, title, body, status, priority, workspace_mode, created_at, updated_at)
          VALUES ('t_v1', 'v1 task', 'v1 body', 'ready', 0, 'scratch', 100, 100);
      `);
      v1.pragma('user_version = 1');
      v1.close();

      // Opening runs migrateV1ToV2 then migrateV2ToV3 in sequence.
      const store = new KanbanStore(dbPath);
      try {
        const t = store.getTask('t_v1');
        expect(t).not.toBeNull();
        expect(t?.title).toBe('v1 task');
        expect(t?.body).toBe('v1 body');
        // v2 columns present.
        expect(t?.maxRetries).toBeNull();
        expect(t?.retryCount).toBe(0);
        // v3 column present.
        expect(t?.acceptanceCriteria).toBeNull();
        // Both widened statuses are insertable.
        expect(store.updateStatus('t_v1', 'needs_revision', 'x').status).toBe('needs_revision');
      } finally {
        store.close();
      }

      // The stepwise chain runs v1->v2->v3 then the additive v3->v4 bump, so the
      // DB lands at the current code version (6). The dedicated v1->v4 test
      // asserts the full chain; here we just confirm the chain doesn't stall.
      const raw = new Database(dbPath);
      try {
        const version = (raw.pragma('user_version') as Array<{ user_version: number }>)[0]
          ?.user_version;
        expect(version).toBe(6);
      } finally {
        raw.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls the v2->v3 migration back atomically when it fails — no half-migrated state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanban-mig23-fail-'));
    const dbPath = join(dir, 'board.db');
    try {
      // Build a v2 DB, then inject an orphan task_comments row (FK points at a
      // missing task) with foreign_keys OFF. The migration's foreign_key_check
      // catches it and throws — rolling the WHOLE transaction back.
      buildV2Db(dbPath);
      const inject = new Database(dbPath);
      inject.pragma('foreign_keys = OFF');
      inject.exec(`
        INSERT INTO task_comments (id, task_id, author, body, created_at)
          VALUES ('c_orphan', 't_missing', 'someone', 'dangling', 2);
      `);
      inject.close();

      expect(() => new KanbanStore(dbPath)).toThrow(/foreign-key violation/);

      // Inspect the raw DB: still v2, no acceptance_criteria column, rows intact.
      const after = new Database(dbPath);
      try {
        const version = (after.pragma('user_version') as Array<{ user_version: number }>)[0]
          ?.user_version;
        expect(version).toBe(2);
        const cols = (after.pragma('table_info(tasks)') as Array<{ name: string }>).map(
          (c) => c.name,
        );
        expect(cols).not.toContain('acceptance_criteria');
        const taskCount = (after.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number })
          .n;
        expect(taskCount).toBe(2);
      } finally {
        after.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('createTask accepts acceptanceCriteria and round-trips it; defaults to null', () => {
    const withCriteria = store.createTask({
      title: 'has criteria',
      acceptanceCriteria: 'must contain DONE',
    });
    expect(withCriteria.acceptanceCriteria).toBe('must contain DONE');
    expect(store.getTask(withCriteria.id)?.acceptanceCriteria).toBe('must contain DONE');

    const without = store.createTask({ title: 'no criteria' });
    expect(without.acceptanceCriteria).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Phase 5 — team member stats
  // ---------------------------------------------------------------------------

  describe('team member stats', () => {
    function teamStore() {
      return new KanbanStore(':memory:', { teamId: 'team-a' });
    }

    it('increments tickets_completed when a claimed task reaches done', () => {
      const s = teamStore();
      try {
        const t = s.createTask({ title: 'ship it', assignee: 'engineer' });
        s.updateStatus(t.id, 'running', undefined, 'engineer');
        s.completeRun(t.id, 'done', 'engineer');
        const stats = s.getMemberStats();
        expect(stats.get('engineer')).toMatchObject({
          teamId: 'team-a',
          memberId: 'engineer',
          ticketsCompleted: 1,
          ticketsFailed: 0,
          ticketsOrphaned: 0,
        });
        expect(stats.get('engineer')?.lastUpdatedAt).toBeGreaterThan(0);
      } finally {
        s.close();
      }
    });

    it('increments tickets_failed when a claimed task reaches failed via budget exhaustion', () => {
      const s = teamStore();
      try {
        const t = s.createTask({ title: 'flaky', assignee: 'engineer', maxRetries: 0 });
        s.updateStatus(t.id, 'running', undefined, 'engineer');
        s.blockRun(t.id, 'attempt 1', 'engineer');
        // Re-claim past budget -> failed.
        expect(s.updateStatus(t.id, 'running', undefined, 'engineer').status).toBe('failed');
        expect(s.getMemberStats().get('engineer')).toMatchObject({
          ticketsCompleted: 0,
          ticketsFailed: 1,
          ticketsOrphaned: 0,
        });
      } finally {
        s.close();
      }
    });

    it('increments tickets_failed when a claimed task reaches needs_revision', () => {
      const s = teamStore();
      try {
        const t = s.createTask({ title: 'needs work', assignee: 'engineer' });
        s.updateStatus(t.id, 'running', undefined, 'engineer');
        s.updateStatus(t.id, 'needs_revision', 'missing tests', 'reviewer');
        expect(s.getMemberStats().get('engineer')).toMatchObject({
          ticketsCompleted: 0,
          ticketsFailed: 1,
          ticketsOrphaned: 0,
        });
      } finally {
        s.close();
      }
    });

    it('increments tickets_orphaned when a claimed task is reclaimed', () => {
      const s = teamStore();
      try {
        const t = s.createTask({ title: 'stuck', assignee: 'engineer' });
        s.updateStatus(t.id, 'running', undefined, 'engineer');
        s.reclaimTask(t.id, 'orphan_stale', 'dispatcher');
        expect(s.getMemberStats().get('engineer')).toMatchObject({
          ticketsCompleted: 0,
          ticketsFailed: 0,
          ticketsOrphaned: 1,
        });
      } finally {
        s.close();
      }
    });

    it('does NOT increment tickets_orphaned when a non-running task is reclaimed', () => {
      // `reclaimTask` flips any status to `ready`, but only a task that was
      // actually `running` is a real orphan. Reclaiming a `ready` task is a
      // re-queue and must not inflate the member's orphan tally.
      const s = teamStore();
      try {
        const t = s.createTask({ title: 'never ran', assignee: 'engineer' });
        s.updateStatus(t.id, 'ready', undefined, 'engineer');
        s.reclaimTask(t.id, 'orphan_stale', 'dispatcher');
        expect(s.getTask(t.id)?.status).toBe('ready');
        expect(s.getMemberStats().get('engineer')).toBeUndefined();
      } finally {
        s.close();
      }
    });

    it('accumulates stats across multiple terminal transitions per member', () => {
      const s = teamStore();
      try {
        for (let i = 0; i < 3; i++) {
          const t = s.createTask({ title: `done ${i}`, assignee: 'engineer' });
          s.updateStatus(t.id, 'running', undefined, 'engineer');
          s.completeRun(t.id, 'ok', 'engineer');
        }
        const failed = s.createTask({ title: 'fail', assignee: 'engineer' });
        s.updateStatus(failed.id, 'running', undefined, 'engineer');
        s.updateStatus(failed.id, 'needs_revision', 'nope', 'reviewer');

        const orphaned = s.createTask({ title: 'orphan', assignee: 'researcher' });
        s.updateStatus(orphaned.id, 'running', undefined, 'researcher');
        s.reclaimTask(orphaned.id, 'orphan_no_owner', 'dispatcher');

        const stats = s.getMemberStats();
        expect(stats.get('engineer')).toMatchObject({
          ticketsCompleted: 3,
          ticketsFailed: 1,
          ticketsOrphaned: 0,
        });
        expect(stats.get('researcher')).toMatchObject({
          ticketsCompleted: 0,
          ticketsFailed: 0,
          ticketsOrphaned: 1,
        });
      } finally {
        s.close();
      }
    });

    it('skips the stats update entirely when teamId is unset (solo board)', () => {
      // Default constructor — no teamId. Terminal transitions must not write rows.
      const t = store.createTask({ title: 'solo', assignee: 'engineer' });
      store.updateStatus(t.id, 'running', undefined, 'engineer');
      store.completeRun(t.id, 'done', 'engineer');
      expect(store.getMemberStats().size).toBe(0);
    });

    it('skips the stats update when a transitioning task has a null assignee', () => {
      const s = teamStore();
      try {
        // A goal-style task with no assignee that somehow lands in a terminal state.
        const t = s.createTask({ title: 'unassigned' });
        s.updateStatus(t.id, 'needs_revision', 'no owner', 'reviewer');
        expect(s.getMemberStats().size).toBe(0);
      } finally {
        s.close();
      }
    });

    it('does not double-count: a non-terminal status change writes no stats', () => {
      const s = teamStore();
      try {
        const t = s.createTask({ title: 'moving', assignee: 'engineer' });
        s.updateStatus(t.id, 'ready', undefined, 'engineer');
        s.updateStatus(t.id, 'running', undefined, 'engineer');
        s.updateStatus(t.id, 'blocked', 'paused', 'engineer');
        expect(s.getMemberStats().size).toBe(0);
      } finally {
        s.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Schema migration v3 -> v4 (team_member_stats — additive table)
  // ---------------------------------------------------------------------------

  it('refuses to open a database whose user_version is newer than v4', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanban-ver5-'));
    const dbPath = join(dir, 'board.db');
    try {
      const future = new Database(dbPath);
      future.pragma('user_version = 7');
      future.close();
      expect(() => new KanbanStore(dbPath)).toThrow(/newer than code/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a fresh database opens at user_version 4 with the team_member_stats table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanban-fresh4-'));
    const dbPath = join(dir, 'board.db');
    try {
      const store = new KanbanStore(dbPath, { teamId: 'team-a' });
      store.close();
      const raw = new Database(dbPath);
      try {
        const version = (raw.pragma('user_version') as Array<{ user_version: number }>)[0]
          ?.user_version;
        expect(version).toBe(6);
        const tables = (
          raw
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='team_member_stats'",
            )
            .all() as Array<{ name: string }>
        ).map((t) => t.name);
        expect(tables).toEqual(['team_member_stats']);
      } finally {
        raw.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates a v3 database to v4: data survives, team_member_stats becomes usable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanban-mig34-'));
    const dbPath = join(dir, 'board.db');
    try {
      // Build a v3 DB: same shape the current code creates, stamped at version 3
      // and missing the team_member_stats table.
      const v3 = new Database(dbPath);
      v3.pragma('journal_mode = WAL');
      v3.pragma('foreign_keys = ON');
      v3.exec(`
        CREATE TABLE tasks (
          id              TEXT PRIMARY KEY,
          title           TEXT NOT NULL,
          body            TEXT NOT NULL DEFAULT '',
          assignee        TEXT,
          status          TEXT NOT NULL
                          CHECK (status IN ('todo','ready','running','blocked','done','archived','scheduled','failed','needs_revision')),
          priority        INTEGER NOT NULL DEFAULT 0,
          workspace_mode  TEXT NOT NULL DEFAULT 'scratch'
                          CHECK (workspace_mode IN ('scratch','worktree','dir')),
          workspace_path  TEXT,
          scheduled_for   INTEGER,
          idempotency_key TEXT,
          current_run_id  TEXT,
          max_retries     INTEGER CHECK (max_retries IS NULL OR max_retries >= 0),
          retry_count     INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
          acceptance_criteria TEXT,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX tasks_idem ON tasks(idempotency_key)
          WHERE idempotency_key IS NOT NULL;
        CREATE INDEX tasks_status_assignee ON tasks(status, assignee);
        CREATE INDEX tasks_scheduled ON tasks(scheduled_for)
          WHERE scheduled_for IS NOT NULL;
        CREATE TABLE task_comments (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL,
          body TEXT NOT NULL, created_at INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX task_comments_task ON task_comments(task_id, created_at);
        CREATE TABLE task_links (
          parent_id TEXT NOT NULL, child_id TEXT NOT NULL,
          PRIMARY KEY (parent_id, child_id),
          FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE,
          FOREIGN KEY (child_id)  REFERENCES tasks(id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX task_links_child ON task_links(child_id);
        CREATE TABLE task_runs (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL, started_at INTEGER NOT NULL,
          ended_at INTEGER,
          outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed','blocked','stalled','cancelled')),
          summary TEXT, last_heartbeat_at INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX task_runs_task ON task_runs(task_id, started_at);
        CREATE UNIQUE INDEX task_runs_open_one ON task_runs(task_id)
          WHERE ended_at IS NULL;
        CREATE TABLE task_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
          kind TEXT NOT NULL
               CHECK (kind IN ('created','status_changed','commented','assigned','linked','unlinked','run_started','run_completed','heartbeat','archived')),
          actor TEXT NOT NULL, data_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX task_events_task ON task_events(task_id, created_at);
        CREATE INDEX task_events_recent ON task_events(created_at);
        CREATE VIRTUAL TABLE task_fts USING fts5(
          task_id UNINDEXED, title, body, comments, tokenize = 'porter'
        );
        CREATE TRIGGER tasks_fts_ai AFTER INSERT ON tasks BEGIN
          INSERT INTO task_fts(task_id, title, body, comments)
          VALUES (new.id, new.title, new.body, '');
        END;
        CREATE TRIGGER tasks_fts_au AFTER UPDATE OF title, body ON tasks BEGIN
          UPDATE task_fts SET title = new.title, body = new.body WHERE task_id = new.id;
        END;
        CREATE TRIGGER tasks_fts_ad AFTER DELETE ON tasks BEGIN
          DELETE FROM task_fts WHERE task_id = old.id;
        END;
        CREATE TRIGGER comments_fts_ai AFTER INSERT ON task_comments BEGIN
          UPDATE task_fts
          SET comments = (
            SELECT COALESCE(GROUP_CONCAT(body, ' '), '')
            FROM task_comments WHERE task_id = new.task_id
          )
          WHERE task_id = new.task_id;
        END;
        INSERT INTO tasks (id, title, body, status, priority, workspace_mode, assignee, created_at, updated_at)
          VALUES ('t_v3', 'v3 task', 'v3 body', 'ready', 0, 'scratch', 'engineer', 100, 100);
      `);
      v3.pragma('user_version = 3');
      v3.close();

      // Opening with the current code stamps v4 and creates team_member_stats.
      const store = new KanbanStore(dbPath, { teamId: 'team-a' });
      try {
        const t = store.getTask('t_v3');
        expect(t?.title).toBe('v3 task');
        expect(t?.body).toBe('v3 body');
        // The new table is usable: a terminal transition records a stat row.
        store.updateStatus('t_v3', 'running', undefined, 'engineer');
        store.completeRun('t_v3', 'ok', 'engineer');
        expect(store.getMemberStats().get('engineer')?.ticketsCompleted).toBe(1);
      } finally {
        store.close();
      }

      const raw = new Database(dbPath);
      try {
        const version = (raw.pragma('user_version') as Array<{ user_version: number }>)[0]
          ?.user_version;
        expect(version).toBe(6);
      } finally {
        raw.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates a v1 database all the way to v4 via the stepwise chain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanban-mig14-'));
    const dbPath = join(dir, 'board.db');
    try {
      const v1 = new Database(dbPath);
      v1.pragma('journal_mode = WAL');
      v1.pragma('foreign_keys = ON');
      v1.exec(`
        CREATE TABLE tasks (
          id              TEXT PRIMARY KEY,
          title           TEXT NOT NULL,
          body            TEXT NOT NULL DEFAULT '',
          assignee        TEXT,
          status          TEXT NOT NULL
                          CHECK (status IN ('todo','ready','running','blocked','done','archived','scheduled')),
          priority        INTEGER NOT NULL DEFAULT 0,
          workspace_mode  TEXT NOT NULL DEFAULT 'scratch'
                          CHECK (workspace_mode IN ('scratch','worktree','dir')),
          workspace_path  TEXT,
          scheduled_for   INTEGER,
          idempotency_key TEXT,
          current_run_id  TEXT,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX tasks_idem ON tasks(idempotency_key)
          WHERE idempotency_key IS NOT NULL;
        CREATE INDEX tasks_status_assignee ON tasks(status, assignee);
        CREATE INDEX tasks_scheduled ON tasks(scheduled_for)
          WHERE scheduled_for IS NOT NULL;
        CREATE TABLE task_comments (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL,
          body TEXT NOT NULL, created_at INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX task_comments_task ON task_comments(task_id, created_at);
        CREATE TABLE task_links (
          parent_id TEXT NOT NULL, child_id TEXT NOT NULL,
          PRIMARY KEY (parent_id, child_id),
          FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE,
          FOREIGN KEY (child_id)  REFERENCES tasks(id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX task_links_child ON task_links(child_id);
        CREATE TABLE task_runs (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL, started_at INTEGER NOT NULL,
          ended_at INTEGER,
          outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed','blocked','stalled','cancelled')),
          summary TEXT, last_heartbeat_at INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX task_runs_task ON task_runs(task_id, started_at);
        CREATE UNIQUE INDEX task_runs_open_one ON task_runs(task_id)
          WHERE ended_at IS NULL;
        CREATE TABLE task_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
          kind TEXT NOT NULL
               CHECK (kind IN ('created','status_changed','commented','assigned','linked','unlinked','run_started','run_completed','heartbeat','archived')),
          actor TEXT NOT NULL, data_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX task_events_task ON task_events(task_id, created_at);
        CREATE INDEX task_events_recent ON task_events(created_at);
        CREATE VIRTUAL TABLE task_fts USING fts5(
          task_id UNINDEXED, title, body, comments, tokenize = 'porter'
        );
        CREATE TRIGGER tasks_fts_ai AFTER INSERT ON tasks BEGIN
          INSERT INTO task_fts(task_id, title, body, comments)
          VALUES (new.id, new.title, new.body, '');
        END;
        CREATE TRIGGER tasks_fts_au AFTER UPDATE OF title, body ON tasks BEGIN
          UPDATE task_fts SET title = new.title, body = new.body WHERE task_id = new.id;
        END;
        CREATE TRIGGER tasks_fts_ad AFTER DELETE ON tasks BEGIN
          DELETE FROM task_fts WHERE task_id = old.id;
        END;
        CREATE TRIGGER comments_fts_ai AFTER INSERT ON task_comments BEGIN
          UPDATE task_fts
          SET comments = (
            SELECT COALESCE(GROUP_CONCAT(body, ' '), '')
            FROM task_comments WHERE task_id = new.task_id
          )
          WHERE task_id = new.task_id;
        END;
        INSERT INTO tasks (id, title, body, status, priority, workspace_mode, created_at, updated_at)
          VALUES ('t_v1', 'v1 task', 'v1 body', 'ready', 0, 'scratch', 100, 100);
      `);
      v1.pragma('user_version = 1');
      v1.close();

      const store = new KanbanStore(dbPath, { teamId: 'team-a' });
      try {
        const t = store.getTask('t_v1');
        expect(t?.title).toBe('v1 task');
        expect(t?.maxRetries).toBeNull();
        expect(t?.acceptanceCriteria).toBeNull();
      } finally {
        store.close();
      }

      const raw = new Database(dbPath);
      try {
        const version = (raw.pragma('user_version') as Array<{ user_version: number }>)[0]
          ?.user_version;
        expect(version).toBe(6);
      } finally {
        raw.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a fully-migrated v1->v4 DB is structurally identical to a fresh v4 DB', () => {
    // Frozen-schema gate: the stepwise migration chain must land on EXACTLY the
    // shape a fresh `KanbanStore` produces — same tables, columns, types, CHECK
    // constraints, indexes, FTS triggers, and user_version. A drift here means
    // a migration step diverged from SCHEMA.
    const dir = mkdtempSync(join(tmpdir(), 'kanban-converge-'));
    const migratedPath = join(dir, 'migrated.db');
    const freshPath = join(dir, 'fresh.db');
    try {
      // Build a v1-shaped DB, then open it with the current code to run the
      // full v1->v2->v3->v4 migration chain.
      const v1 = new Database(migratedPath);
      v1.pragma('journal_mode = WAL');
      v1.pragma('foreign_keys = ON');
      v1.exec(`
        CREATE TABLE tasks (
          id              TEXT PRIMARY KEY,
          title           TEXT NOT NULL,
          body            TEXT NOT NULL DEFAULT '',
          assignee        TEXT,
          status          TEXT NOT NULL
                          CHECK (status IN ('todo','ready','running','blocked','done','archived','scheduled')),
          priority        INTEGER NOT NULL DEFAULT 0,
          workspace_mode  TEXT NOT NULL DEFAULT 'scratch'
                          CHECK (workspace_mode IN ('scratch','worktree','dir')),
          workspace_path  TEXT,
          scheduled_for   INTEGER,
          idempotency_key TEXT,
          current_run_id  TEXT,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX tasks_idem ON tasks(idempotency_key)
          WHERE idempotency_key IS NOT NULL;
        CREATE INDEX tasks_status_assignee ON tasks(status, assignee);
        CREATE INDEX tasks_scheduled ON tasks(scheduled_for)
          WHERE scheduled_for IS NOT NULL;
        CREATE TABLE task_comments (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL,
          body TEXT NOT NULL, created_at INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX task_comments_task ON task_comments(task_id, created_at);
        CREATE TABLE task_links (
          parent_id TEXT NOT NULL, child_id TEXT NOT NULL,
          PRIMARY KEY (parent_id, child_id),
          FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE,
          FOREIGN KEY (child_id)  REFERENCES tasks(id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX task_links_child ON task_links(child_id);
        CREATE TABLE task_runs (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL, started_at INTEGER NOT NULL,
          ended_at INTEGER,
          outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed','blocked','stalled','cancelled')),
          summary TEXT, last_heartbeat_at INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX task_runs_task ON task_runs(task_id, started_at);
        CREATE UNIQUE INDEX task_runs_open_one ON task_runs(task_id)
          WHERE ended_at IS NULL;
        CREATE TABLE task_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
          kind TEXT NOT NULL
               CHECK (kind IN ('created','status_changed','commented','assigned','linked','unlinked','run_started','run_completed','heartbeat','archived')),
          actor TEXT NOT NULL, data_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX task_events_task ON task_events(task_id, created_at);
        CREATE INDEX task_events_recent ON task_events(created_at);
        CREATE VIRTUAL TABLE task_fts USING fts5(
          task_id UNINDEXED, title, body, comments, tokenize = 'porter'
        );
        CREATE TRIGGER tasks_fts_ai AFTER INSERT ON tasks BEGIN
          INSERT INTO task_fts(task_id, title, body, comments)
          VALUES (new.id, new.title, new.body, '');
        END;
        CREATE TRIGGER tasks_fts_au AFTER UPDATE OF title, body ON tasks BEGIN
          UPDATE task_fts SET title = new.title, body = new.body WHERE task_id = new.id;
        END;
        CREATE TRIGGER tasks_fts_ad AFTER DELETE ON tasks BEGIN
          DELETE FROM task_fts WHERE task_id = old.id;
        END;
        CREATE TRIGGER comments_fts_ai AFTER INSERT ON task_comments BEGIN
          UPDATE task_fts
          SET comments = (
            SELECT COALESCE(GROUP_CONCAT(body, ' '), '')
            FROM task_comments WHERE task_id = new.task_id
          )
          WHERE task_id = new.task_id;
        END;
      `);
      v1.pragma('user_version = 1');
      v1.close();

      new KanbanStore(migratedPath, { teamId: 'team-a' }).close();
      // A fresh DB built straight from SCHEMA at the current version.
      new KanbanStore(freshPath, { teamId: 'team-a' }).close();

      // Snapshot a DB's structure: every object's normalized SQL text, the
      // `tasks` column shape, and the schema version.
      const snapshot = (path: string) => {
        const db = new Database(path);
        try {
          const objects = (
            db
              .prepare(
                `SELECT type, name, sql FROM sqlite_master
                 WHERE name NOT LIKE 'sqlite_%'
                 ORDER BY type, name`,
              )
              .all() as Array<{ type: string; name: string; sql: string | null }>
          ).map((r) => ({
            type: r.type,
            name: r.name,
            // Normalize for false drift: collapse whitespace (indentation differs
            // between SCHEMA and the migration DDL), and strip double-quote
            // identifier quoting — SQLite emits `CREATE TABLE "tasks"` after a
            // table rebuild but `CREATE TABLE tasks` for a fresh create. String
            // literals in the DDL use single quotes, so dropping `"` is safe.
            sql: (r.sql ?? '').replace(/\s+/g, ' ').replace(/"/g, '').trim(),
          }));
          const tasksColumns = (
            db.pragma('table_info(tasks)') as Array<{
              name: string;
              type: string;
              notnull: number;
              dflt_value: unknown;
              pk: number;
            }>
          ).map((c) => ({
            name: c.name,
            type: c.type,
            notnull: c.notnull,
            dflt_value: c.dflt_value,
            pk: c.pk,
          }));
          const userVersion = (db.pragma('user_version') as Array<{ user_version: number }>)[0]
            ?.user_version;
          return { objects, tasksColumns, userVersion };
        } finally {
          db.close();
        }
      };

      const migrated = snapshot(migratedPath);
      const fresh = snapshot(freshPath);

      expect(migrated.userVersion).toBe(6);
      expect(migrated.userVersion).toBe(fresh.userVersion);
      // `tasks` columns + types (covers the v1->v2 max_retries / retry_count and
      // v2->v3 acceptance_criteria additions converging on the fresh shape).
      expect(migrated.tasksColumns).toEqual(fresh.tasksColumns);
      // Every table/index/trigger — including CHECK constraints embedded in the
      // table SQL and the FTS triggers — must match the fresh DB exactly.
      expect(migrated.objects).toEqual(fresh.objects);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stats survive a close/reopen of the same on-disk board', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanban-stats-persist-'));
    const dbPath = join(dir, 'board.db');
    try {
      const s1 = new KanbanStore(dbPath, { teamId: 'team-a' });
      const t = s1.createTask({ title: 'persist', assignee: 'engineer' });
      s1.updateStatus(t.id, 'running', undefined, 'engineer');
      s1.completeRun(t.id, 'ok', 'engineer');
      s1.close();

      const s2 = new KanbanStore(dbPath, { teamId: 'team-a' });
      try {
        expect(s2.getMemberStats().get('engineer')?.ticketsCompleted).toBe(1);
      } finally {
        s2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Host-pause tolerance — bumpActiveHeartbeats
//
// A suspended VM stops every agent's heartbeat without killing the work. The
// two gates (`findStalledRuns`, `findStaleRunningTasks`) are left exactly as
// they are; only the timestamps they compare get corrected, once, at the
// resume boundary.
// ---------------------------------------------------------------------------

describe('KanbanStore.bumpActiveHeartbeats', () => {
  const SIX_HOURS = 6 * 3_600_000;
  const CUTOFF_MS = 90_000;

  let store: KanbanStore;

  beforeEach(() => {
    store = makeStore();
  });

  afterEach(() => {
    store.close();
  });

  /** Test-only shortcut for backdating a liveness column, as elsewhere in this file. */
  function rawUpdate(sql: string, ...params: Array<number | string>): void {
    (
      store as unknown as {
        db: { prepare: (s: string) => { run: (...a: Array<number | string>) => void } };
      }
    ).db
      .prepare(sql)
      .run(...params);
  }

  it('WITHOUT a bump, a run alive across a 6h host pause reads as stalled AND its task as orphaned', () => {
    const task = store.createTask({ title: 'long migration', assignee: 'engineer' });
    store.updateStatus(task.id, 'running', undefined, 'engineer');
    const resumeNow = Date.now() + SIX_HOURS;

    expect(store.findStalledRuns(CUTOFF_MS, resumeNow).map((r) => r.taskId)).toEqual([task.id]);
    expect(store.findStaleRunningTasks(CUTOFF_MS, resumeNow).map((t) => t.id)).toEqual([task.id]);
  });

  it('bumping by the pause duration first clears both gates', () => {
    const task = store.createTask({ title: 'long migration', assignee: 'engineer' });
    store.updateStatus(task.id, 'running', undefined, 'engineer');
    const resumeNow = Date.now() + SIX_HOURS;

    // One open run + one running task.
    expect(store.bumpActiveHeartbeats(SIX_HOURS)).toBe(2);

    expect(store.findStalledRuns(CUTOFF_MS, resumeNow)).toEqual([]);
    expect(store.findStaleRunningTasks(CUTOFF_MS, resumeNow)).toEqual([]);
    expect(store.getTask(task.id)?.status).toBe('running');
  });

  it('an agent that genuinely went quiet BEFORE the pause is still caught after the bump', () => {
    const alive = store.createTask({ title: 'alive' });
    store.updateStatus(alive.id, 'running');
    const quiet = store.createTask({ title: 'quiet' });
    store.updateStatus(quiet.id, 'running');

    const now = Date.now();
    // `quiet` stopped heartbeating 10 minutes before the host was suspended.
    const quietRunId = store.getTask(quiet.id)?.currentRunId as string;
    rawUpdate('UPDATE task_runs SET last_heartbeat_at = ? WHERE id = ?', now - 600_000, quietRunId);
    rawUpdate('UPDATE tasks SET updated_at = ? WHERE id = ?', now - 600_000, quiet.id);

    // Both clocks move by the same amount, so the bump cannot blind either gate
    // to a stall that predates the pause.
    expect(store.bumpActiveHeartbeats(SIX_HOURS)).toBe(4);

    const resumeNow = now + SIX_HOURS;
    expect(store.findStalledRuns(CUTOFF_MS, resumeNow).map((r) => r.taskId)).toEqual([quiet.id]);
    expect(store.findStaleRunningTasks(CUTOFF_MS, resumeNow).map((t) => t.id)).toEqual([quiet.id]);
  });

  it('leaves ended runs and non-running tasks untouched', () => {
    const todo = store.createTask({ title: 'todo' });
    const done = store.createTask({ title: 'done' });
    store.updateStatus(done.id, 'running');
    store.completeRun(done.id, 'shipped');
    const blocked = store.createTask({ title: 'blocked' });
    store.updateStatus(blocked.id, 'running');
    store.blockRun(blocked.id, 'waiting on review');
    const running = store.createTask({ title: 'running' });
    store.updateStatus(running.id, 'running');

    const before = [todo, done, blocked].map((t) => ({
      id: t.id,
      updatedAt: store.getTask(t.id)?.updatedAt,
      runs: store.listRuns(t.id).map((r) => r.lastHeartbeatAt),
    }));

    // Only the one open run and the one running task.
    expect(store.bumpActiveHeartbeats(SIX_HOURS)).toBe(2);

    for (const snapshot of before) {
      expect(store.getTask(snapshot.id)?.updatedAt).toBe(snapshot.updatedAt);
      expect(store.listRuns(snapshot.id).map((r) => r.lastHeartbeatAt)).toEqual(snapshot.runs);
    }
    expect(store.listRuns(running.id)[0]?.lastHeartbeatAt).toBeGreaterThan(Date.now());
    expect(store.getTask(running.id)?.updatedAt).toBeGreaterThan(Date.now());
  });

  it('writes nothing for a zero, negative or non-finite pause', () => {
    const task = store.createTask({ title: 'running' });
    store.updateStatus(task.id, 'running');
    const updatedAt = store.getTask(task.id)?.updatedAt;
    const heartbeatAt = store.listRuns(task.id)[0]?.lastHeartbeatAt;

    for (const bogus of [0, -SIX_HOURS, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(store.bumpActiveHeartbeats(bogus)).toBe(0);
    }
    expect(store.getTask(task.id)?.updatedAt).toBe(updatedAt);
    expect(store.listRuns(task.id)[0]?.lastHeartbeatAt).toBe(heartbeatAt);
  });

  it('plan §3.1: the pause burns retry budget without the bump, and none with it', () => {
    // Today: the first post-resume sweep sees an orphan, reclaimTask cancels the
    // run, and the re-claim through updateStatus('running') increments
    // retry_count — real budget spent on time nobody was running.
    const burned = store.createTask({ title: 'burned', assignee: 'engineer', maxRetries: 1 });
    store.updateStatus(burned.id, 'running', undefined, 'engineer');
    const resumeNow = Date.now() + SIX_HOURS;

    expect(store.findStaleRunningTasks(CUTOFF_MS, resumeNow).map((t) => t.id)).toContain(burned.id);
    store.reclaimTask(burned.id, 'orphan_stale', 'dispatcher');
    store.updateStatus(burned.id, 'running', undefined, 'engineer');
    expect(store.getTask(burned.id)?.retryCount).toBe(1);

    // With the pause discounted, the gate does not fire at all — reclaimTask is
    // never called, so the budget is untouched.
    const spared = store.createTask({ title: 'spared', assignee: 'engineer', maxRetries: 1 });
    store.updateStatus(spared.id, 'running', undefined, 'engineer');
    store.bumpActiveHeartbeats(SIX_HOURS);

    expect(store.findStaleRunningTasks(CUTOFF_MS, resumeNow)).toEqual([]);
    expect(store.getTask(spared.id)?.retryCount).toBe(0);
  });
});
