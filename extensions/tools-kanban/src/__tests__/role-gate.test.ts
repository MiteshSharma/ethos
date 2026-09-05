import { KanbanStore } from '@ethosagent/kanban-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKanbanRoleGateHook } from '../role-gate';

describe('kanban role gate', () => {
  let store: KanbanStore;

  beforeEach(() => {
    store = new KanbanStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  // ---------------------------------------------------------------------------
  // Coordinator-only tools
  // ---------------------------------------------------------------------------

  it('rejects kanban_create from a member', async () => {
    const hook = createKanbanRoleGateHook({ role: 'member', personalityId: 'engineer', store });
    const result = await hook({
      sessionId: 's',
      toolCallId: 'tc',
      toolName: 'kanban_create',
      args: { title: 'x' },
    });
    expect(result.error).toMatch(/requires role=coordinator/);
  });

  it('allows kanban_create from a coordinator', async () => {
    const hook = createKanbanRoleGateHook({
      role: 'coordinator',
      personalityId: 'coordinator',
      store,
    });
    const result = await hook({
      sessionId: 's',
      toolCallId: 'tc',
      toolName: 'kanban_create',
      args: { title: 'x' },
    });
    expect(result.error).toBeUndefined();
  });

  it('coordinator-only set covers create_goal, create, assign, link, archive', async () => {
    const memberHook = createKanbanRoleGateHook({ role: 'member', personalityId: 'eng', store });
    for (const name of [
      'kanban_create_goal',
      'kanban_create',
      'kanban_assign',
      'kanban_link',
      'kanban_archive',
    ]) {
      const r = await memberHook({ sessionId: 's', toolCallId: 'tc', toolName: name, args: {} });
      expect(r.error, `${name} should require coordinator`).toMatch(/requires role=coordinator/);
    }
  });

  // ---------------------------------------------------------------------------
  // Assignee-only tools
  // ---------------------------------------------------------------------------

  it('rejects kanban_complete from a member who is not the assignee', async () => {
    const task = store.createTask({ title: 'work', assignee: 'engineer' });
    const hook = createKanbanRoleGateHook({ role: 'member', personalityId: 'researcher', store });
    const result = await hook({
      sessionId: 's',
      toolCallId: 'tc',
      toolName: 'kanban_complete',
      args: { task_id: task.id, summary: 'done' },
    });
    expect(result.error).toMatch(/requires you to be the assignee/);
  });

  it('allows kanban_complete from the assignee', async () => {
    const task = store.createTask({ title: 'work', assignee: 'engineer' });
    const hook = createKanbanRoleGateHook({ role: 'member', personalityId: 'engineer', store });
    const result = await hook({
      sessionId: 's',
      toolCallId: 'tc',
      toolName: 'kanban_complete',
      args: { task_id: task.id, summary: 'done' },
    });
    expect(result.error).toBeUndefined();
  });

  it('passes assignee-only checks through when the task does not exist (tool layer handles it)', async () => {
    const hook = createKanbanRoleGateHook({ role: 'member', personalityId: 'engineer', store });
    const result = await hook({
      sessionId: 's',
      toolCallId: 'tc',
      toolName: 'kanban_complete',
      args: { task_id: 't_nope', summary: 'done' },
    });
    expect(result.error).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Any-member tools
  // ---------------------------------------------------------------------------

  it('allows kanban_comment / kanban_show / kanban_list from any member', async () => {
    const task = store.createTask({ title: 'x' });
    const hook = createKanbanRoleGateHook({ role: 'member', personalityId: 'researcher', store });
    for (const name of ['kanban_comment', 'kanban_show', 'kanban_list']) {
      const r = await hook({
        sessionId: 's',
        toolCallId: 'tc',
        toolName: name,
        args: { task_id: task.id },
      });
      expect(r.error, `${name} should allow members`).toBeUndefined();
    }
  });

  it('rejects kanban_update_status from a non-assignee — closes the bypass-via-update_status hole', async () => {
    const task = store.createTask({ title: 'x', assignee: 'engineer' });
    const hook = createKanbanRoleGateHook({ role: 'member', personalityId: 'researcher', store });
    const result = await hook({
      sessionId: 's',
      toolCallId: 'tc',
      toolName: 'kanban_update_status',
      args: { task_id: task.id, status: 'done' },
    });
    expect(result.error).toMatch(/requires you to be the assignee/);
  });

  it('allows kanban_update_status from the assignee', async () => {
    const task = store.createTask({ title: 'x', assignee: 'engineer' });
    const hook = createKanbanRoleGateHook({ role: 'member', personalityId: 'engineer', store });
    const result = await hook({
      sessionId: 's',
      toolCallId: 'tc',
      toolName: 'kanban_update_status',
      args: { task_id: task.id, status: 'done' },
    });
    expect(result.error).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Coordinator orchestration tier
  // ---------------------------------------------------------------------------

  it('allows kanban_update_status from the coordinator on any task (orchestration)', async () => {
    // Task assigned to engineer; coordinator wires it as `blocked` to set up a
    // dependency. Without coordinator orchestration access this fails the
    // assignee check and the team cannot bootstrap a dependency graph.
    const task = store.createTask({ title: 'refactor', assignee: 'engineer' });
    const hook = createKanbanRoleGateHook({
      role: 'coordinator',
      personalityId: 'coordinator',
      store,
    });
    const result = await hook({
      sessionId: 's',
      toolCallId: 'tc',
      toolName: 'kanban_update_status',
      args: { task_id: task.id, status: 'blocked' },
    });
    expect(result.error).toBeUndefined();
  });

  it('still rejects first-person closer tools from the coordinator (semantic integrity)', async () => {
    // kanban_complete, kanban_block, kanban_unblock, kanban_heartbeat are
    // first-person — only the assignee can speak for their own task. The
    // coordinator orchestrates via kanban_update_status, not by impersonating
    // the assignee through closer tools.
    const task = store.createTask({ title: 'work', assignee: 'engineer' });
    const hook = createKanbanRoleGateHook({
      role: 'coordinator',
      personalityId: 'coordinator',
      store,
    });
    for (const name of ['kanban_complete', 'kanban_block', 'kanban_unblock', 'kanban_heartbeat']) {
      const r = await hook({
        sessionId: 's',
        toolCallId: 'tc',
        toolName: name,
        args: { task_id: task.id, summary: 'x' },
      });
      expect(r.error, `${name} should remain assignee-only even for the coordinator`).toMatch(
        /requires you to be the assignee/,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // Non-kanban tools
  // ---------------------------------------------------------------------------

  it('has no opinion on non-kanban tools', async () => {
    const hook = createKanbanRoleGateHook({ role: 'member', personalityId: 'engineer', store });
    const result = await hook({
      sessionId: 's',
      toolCallId: 'tc',
      toolName: 'web_search',
      args: { query: 'x' },
    });
    expect(result.error).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Per-turn caller resolution (teams-as-a-scope D4 — one shared loop per team)
  // ---------------------------------------------------------------------------

  describe('per-turn caller on a coordinator-built gate with coordinatorId', () => {
    const build = () =>
      createKanbanRoleGateHook({
        role: 'coordinator',
        personalityId: 'coordinator',
        coordinatorId: 'coordinator',
        store,
      });

    it('refuses kanban_assign on a member turn', async () => {
      const task = store.createTask({ title: 'x' });
      const result = await build()({
        sessionId: 's',
        toolCallId: 'tc',
        toolName: 'kanban_assign',
        args: { task_id: task.id, assignee: 'engineer' },
        personalityId: 'engineer',
      });
      expect(result.error).toMatch(/requires role=coordinator \(caller role=member\)/);
    });

    it("allows kanban_complete on a member turn for the member's own ticket", async () => {
      const task = store.createTask({ title: 'work', assignee: 'engineer' });
      const result = await build()({
        sessionId: 's',
        toolCallId: 'tc',
        toolName: 'kanban_complete',
        args: { task_id: task.id, summary: 'done' },
        personalityId: 'engineer',
      });
      expect(result.error).toBeUndefined();
    });

    it("refuses kanban_complete on a member turn for someone else's ticket", async () => {
      const task = store.createTask({ title: 'work', assignee: 'engineer' });
      const result = await build()({
        sessionId: 's',
        toolCallId: 'tc',
        toolName: 'kanban_complete',
        args: { task_id: task.id, summary: 'done' },
        personalityId: 'researcher',
      });
      expect(result.error).toMatch(/current assignee=engineer, you=researcher/);
    });

    it('leaves a coordinator turn unchanged', async () => {
      const task = store.createTask({ title: 'refactor', assignee: 'engineer' });
      const hook = build();
      const assign = await hook({
        sessionId: 's',
        toolCallId: 'tc',
        toolName: 'kanban_assign',
        args: { task_id: task.id, assignee: 'engineer' },
        personalityId: 'coordinator',
      });
      expect(assign.error).toBeUndefined();
      const status = await hook({
        sessionId: 's',
        toolCallId: 'tc',
        toolName: 'kanban_update_status',
        args: { task_id: task.id, status: 'blocked' },
        personalityId: 'coordinator',
      });
      expect(status.error).toBeUndefined();
      const complete = await hook({
        sessionId: 's',
        toolCallId: 'tc',
        toolName: 'kanban_complete',
        args: { task_id: task.id, summary: 'x' },
        personalityId: 'coordinator',
      });
      expect(complete.error).toMatch(/requires you to be the assignee/);
    });

    it('falls back to the constructed caller when the payload has no personalityId', async () => {
      const task = store.createTask({ title: 'work', assignee: 'engineer' });
      const hook = build();
      const assign = await hook({
        sessionId: 's',
        toolCallId: 'tc',
        toolName: 'kanban_assign',
        args: { task_id: task.id, assignee: 'engineer' },
      });
      expect(assign.error).toBeUndefined();
      const complete = await hook({
        sessionId: 's',
        toolCallId: 'tc',
        toolName: 'kanban_complete',
        args: { task_id: task.id, summary: 'x' },
      });
      expect(complete.error).toMatch(/you=coordinator/);
    });
  });

  it('without coordinatorId, a per-turn personalityId keeps the boot-time role', async () => {
    // Legacy `ethos serve --role member` process: the role is fixed at boot;
    // only the assignee identity follows the turn.
    const task = store.createTask({ title: 'work', assignee: 'engineer' });
    const hook = createKanbanRoleGateHook({ role: 'member', personalityId: 'researcher', store });
    const assign = await hook({
      sessionId: 's',
      toolCallId: 'tc',
      toolName: 'kanban_assign',
      args: { task_id: task.id, assignee: 'engineer' },
      personalityId: 'coordinator',
    });
    expect(assign.error).toMatch(/requires role=coordinator/);
    const complete = await hook({
      sessionId: 's',
      toolCallId: 'tc',
      toolName: 'kanban_complete',
      args: { task_id: task.id, summary: 'x' },
      personalityId: 'engineer',
    });
    expect(complete.error).toBeUndefined();
  });
});
