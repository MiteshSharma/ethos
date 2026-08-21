import { DefaultHookRegistry } from '@ethosagent/core';
import { KanbanStore } from '@ethosagent/kanban-store';
import type { Tool, ToolContext } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKanbanTools } from '../index';

// End-to-end tests at the tool boundary — same level the LLM hits.
// Verifies args parsing, store wiring, and ToolResult shape.

function makeCtx(personalityId?: string): ToolContext {
  return {
    sessionId: 'sess',
    sessionKey: 'cli:test',
    platform: 'test',
    workingDir: '/tmp',
    ...(personalityId !== undefined ? { personalityId } : {}),
    currentTurn: 0,
    messageCount: 0,
    abortSignal: new AbortController().signal,
    emit: () => undefined,
    resultBudgetChars: 80_000,
  };
}

function toolsByName(tools: Tool[]): Record<string, Tool> {
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

async function call<T = unknown>(tool: Tool, args: unknown, ctx: ToolContext): Promise<T> {
  const result = await tool.execute(args, ctx);
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return JSON.parse(result.value) as T;
}

describe('kanban tools', () => {
  let store: KanbanStore;
  let tools: Record<string, Tool>;

  beforeEach(() => {
    store = new KanbanStore(':memory:');
    tools = toolsByName(createKanbanTools({ store }));
  });

  afterEach(() => {
    store.close();
  });

  it('exposes 13 tools in the kanban toolset with the right maxResultChars', () => {
    const names = Object.keys(tools).sort();
    expect(names).toEqual([
      'kanban_archive',
      'kanban_assign',
      'kanban_block',
      'kanban_comment',
      'kanban_complete',
      'kanban_create',
      'kanban_create_goal',
      'kanban_heartbeat',
      'kanban_link',
      'kanban_list',
      'kanban_show',
      'kanban_unblock',
      'kanban_update_status',
    ]);
    for (const t of Object.values(tools)) {
      expect(t.toolset).toBe('kanban');
      expect(t.maxResultChars).toBe(20_000);
    }
  });

  // ---------------------------------------------------------------------------
  // kanban_create
  // ---------------------------------------------------------------------------

  it('kanban_create returns { task_id, status } and persists', async () => {
    const ctx = makeCtx();
    const out = await call<{ task_id: string; status: string }>(
      tools.kanban_create as Tool,
      { title: 'first' },
      ctx,
    );
    expect(out.task_id).toMatch(/^t_[0-9a-f]{16}$/);
    expect(out.status).toBe('todo');
    expect(store.getTask(out.task_id)?.title).toBe('first');
  });

  it('kanban_create rejects missing title with input_invalid', async () => {
    const result = await (tools.kanban_create as Tool).execute({}, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('kanban_create persists acceptance_criteria', async () => {
    const out = await call<{ task_id: string }>(
      tools.kanban_create as Tool,
      { title: 'verified task', acceptance_criteria: 'output must contain SHIPPED' },
      makeCtx(),
    );
    expect(store.getTask(out.task_id)?.acceptanceCriteria).toBe('output must contain SHIPPED');
  });

  it('kanban_create rejects a non-string acceptance_criteria', async () => {
    const result = await (tools.kanban_create as Tool).execute(
      { title: 'x', acceptance_criteria: 123 },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('kanban_create rejects an over-long acceptance_criteria', async () => {
    const result = await (tools.kanban_create as Tool).execute(
      { title: 'x', acceptance_criteria: 'a'.repeat(64_001) },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  // ---------------------------------------------------------------------------
  // kanban_create_goal
  // ---------------------------------------------------------------------------

  it('kanban_create_goal creates a task with assignee=null (the goal-as-parent-task pattern)', async () => {
    const out = await call<{ task_id: string; status: string }>(
      tools.kanban_create_goal as Tool,
      { title: 'Q3 Analytics Roadmap', description: 'top-level goal' },
      makeCtx('coordinator'),
    );
    expect(out.task_id).toMatch(/^t_[0-9a-f]{16}$/);
    const stored = store.getTask(out.task_id);
    expect(stored?.assignee).toBeNull();
    expect(stored?.title).toBe('Q3 Analytics Roadmap');
    expect(stored?.body).toBe('top-level goal');
  });

  it('kanban_create_goal rejects missing title', async () => {
    const result = await (tools.kanban_create_goal as Tool).execute({}, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('kanban_create threads ctx.personalityId as the actor in task_events', async () => {
    const ctx = makeCtx('engineer');
    const out = await call<{ task_id: string }>(tools.kanban_create as Tool, { title: 'x' }, ctx);
    const events = store.listEvents(out.task_id);
    expect(events[0]?.actor).toBe('engineer');
  });

  // ---------------------------------------------------------------------------
  // kanban_list
  // ---------------------------------------------------------------------------

  it('kanban_list returns tasks with status/assignee/q filtering', async () => {
    store.createTask({ title: 'rotate keys' });
    store.createTask({ title: 'unrelated' });
    const sre = store.createTask({ title: 'rotate certs', assignee: 'sre' });

    const filtered = await call<Array<{ id: string }>>(
      tools.kanban_list as Tool,
      { q: 'rotate', assignee: 'sre' },
      makeCtx(),
    );
    expect(filtered.map((t) => t.id)).toEqual([sre.id]);
  });

  // ---------------------------------------------------------------------------
  // kanban_show
  // ---------------------------------------------------------------------------

  it('kanban_show returns task + comments + last runs + last events', async () => {
    const task = store.createTask({ title: 't' });
    store.addComment(task.id, 'engineer', 'note one');
    store.updateStatus(task.id, 'running', undefined, 'engineer');
    store.completeRun(task.id, 'done it', 'engineer');

    const out = await call<{
      task: { id: string };
      comments: Array<{ body: string }>;
      runs: Array<{ outcome: string | null }>;
      events: Array<{ kind: string }>;
    }>(tools.kanban_show as Tool, { task_id: task.id }, makeCtx());

    expect(out.task.id).toBe(task.id);
    expect(out.comments.map((c) => c.body)).toEqual(['note one']);
    expect(out.runs[0]?.outcome).toBe('completed');
    expect(out.events.map((e) => e.kind)).toContain('run_completed');
  });

  it('kanban_show returns input_invalid for unknown task', async () => {
    const result = await (tools.kanban_show as Tool).execute({ task_id: 't_nope' }, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  // ---------------------------------------------------------------------------
  // kanban_update_status / kanban_comment
  // ---------------------------------------------------------------------------

  it('kanban_update_status flips status', async () => {
    const t = store.createTask({ title: 'x' });
    const out = await call<{ status: string }>(
      tools.kanban_update_status as Tool,
      { task_id: t.id, status: 'running' },
      makeCtx(),
    );
    expect(out.status).toBe('running');
  });

  it('kanban_update_status rejects unknown status', async () => {
    const t = store.createTask({ title: 'x' });
    const result = await (tools.kanban_update_status as Tool).execute(
      { task_id: t.id, status: 'banana' },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('kanban_comment returns input_invalid for unknown task_id (does not leak FK error)', async () => {
    const result = await (tools.kanban_comment as Tool).execute(
      { task_id: 't_nope', body: 'hi' },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('kanban_comment appends a comment', async () => {
    const t = store.createTask({ title: 'x' });
    const out = await call<{ comment_id: string }>(
      tools.kanban_comment as Tool,
      { task_id: t.id, body: 'hi' },
      makeCtx('engineer'),
    );
    expect(out.comment_id).toMatch(/^c_[0-9a-f]{16}$/);
    const comments = store.listComments(t.id);
    expect(comments[0]?.author).toBe('engineer');
    expect(comments[0]?.body).toBe('hi');
  });

  // ---------------------------------------------------------------------------
  // kanban_complete / kanban_block / kanban_unblock
  // ---------------------------------------------------------------------------

  it('kanban_complete ends the open run and sets status=done', async () => {
    const t = store.createTask({ title: 'x' });
    store.updateStatus(t.id, 'running');
    const out = await call<{ status: string }>(
      tools.kanban_complete as Tool,
      { task_id: t.id, summary: 'shipped' },
      makeCtx(),
    );
    expect(out.status).toBe('done');
  });

  it('kanban_complete on a task with no open run returns execution_failed', async () => {
    const t = store.createTask({ title: 'x' });
    const result = await (tools.kanban_complete as Tool).execute(
      { task_id: t.id, summary: 'shipped' },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('execution_failed');
  });

  it('kanban_block ends the open run with outcome=blocked', async () => {
    const t = store.createTask({ title: 'x' });
    store.updateStatus(t.id, 'running');
    const out = await call<{ status: string }>(
      tools.kanban_block as Tool,
      { task_id: t.id, reason: 'waiting on infra' },
      makeCtx(),
    );
    expect(out.status).toBe('blocked');
  });

  it('kanban_block accepts an optional kind and persists it on the task', async () => {
    const t = store.createTask({ title: 'x' });
    store.updateStatus(t.id, 'running');
    const out = await call<{ status: string; block_kind: string | null }>(
      tools.kanban_block as Tool,
      { task_id: t.id, reason: 'waiting on infra', kind: 'dependency' },
      makeCtx(),
    );
    expect(out.status).toBe('blocked');
    expect(out.block_kind).toBe('dependency');
  });

  it('kanban_block rejects an unrecognized kind', async () => {
    const t = store.createTask({ title: 'x' });
    store.updateStatus(t.id, 'running');
    const result = await (tools.kanban_block as Tool).execute(
      { task_id: t.id, reason: 'waiting on infra', kind: 'not_a_real_kind' },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('kanban_block routes to needs_revision after BLOCK_RECURRENCE_LIMIT same-kind blocks in a row', async () => {
    const t = store.createTask({ title: 'flaky dependency' });
    store.updateStatus(t.id, 'running');
    await call(
      tools.kanban_block as Tool,
      { task_id: t.id, reason: 'waiting on service A', kind: 'dependency' },
      makeCtx(),
    );

    // Re-claim, then block again with the same kind — the default
    // BLOCK_RECURRENCE_LIMIT (2) is met on this second consecutive block.
    store.updateStatus(t.id, 'running');
    const out = await call<{ status: string; block_recurrence_count: number }>(
      tools.kanban_block as Tool,
      { task_id: t.id, reason: 'still waiting on service A', kind: 'dependency' },
      makeCtx(),
    );

    expect(out.status).toBe('needs_revision');
    expect(out.block_recurrence_count).toBe(2);
  });

  it('kanban_unblock returns ready when all parents are done', async () => {
    const p = store.createTask({ title: 'parent' });
    const c = store.createTask({ title: 'child', parents: [p.id] });
    store.updateStatus(c.id, 'blocked');
    store.updateStatus(p.id, 'running');
    store.completeRun(p.id, 'parent done');

    const out = await call<{ status: string }>(
      tools.kanban_unblock as Tool,
      { task_id: c.id },
      makeCtx(),
    );
    expect(out.status).toBe('ready');
  });

  it('kanban_unblock returns input_invalid for unknown task', async () => {
    const result = await (tools.kanban_unblock as Tool).execute({ task_id: 't_nope' }, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('kanban_unblock refuses to operate on a non-blocked task', async () => {
    const t = store.createTask({ title: 'x' }); // status=todo
    const result = await (tools.kanban_unblock as Tool).execute({ task_id: t.id }, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('execution_failed');
  });

  it('kanban_unblock returns todo when at least one parent is still pending', async () => {
    const p = store.createTask({ title: 'parent' });
    const c = store.createTask({ title: 'child', parents: [p.id] });
    store.updateStatus(c.id, 'blocked');

    const out = await call<{ status: string }>(
      tools.kanban_unblock as Tool,
      { task_id: c.id },
      makeCtx(),
    );
    expect(out.status).toBe('todo');
  });

  // ---------------------------------------------------------------------------
  // kanban_heartbeat / kanban_link / kanban_assign / kanban_archive
  // ---------------------------------------------------------------------------

  it('kanban_heartbeat bumps the open run', async () => {
    const t = store.createTask({ title: 'x' });
    store.updateStatus(t.id, 'running');
    const result = await (tools.kanban_heartbeat as Tool).execute({ task_id: t.id }, makeCtx());
    expect(result.ok).toBe(true);
  });

  it('kanban_link creates an edge', async () => {
    const a = store.createTask({ title: 'a' });
    const b = store.createTask({ title: 'b' });
    const result = await (tools.kanban_link as Tool).execute(
      { parent_id: a.id, child_id: b.id },
      makeCtx(),
    );
    expect(result.ok).toBe(true);
  });

  it('kanban_link rejects a cycle with execution_failed', async () => {
    const a = store.createTask({ title: 'a' });
    const b = store.createTask({ title: 'b' });
    await (tools.kanban_link as Tool).execute({ parent_id: a.id, child_id: b.id }, makeCtx());
    const result = await (tools.kanban_link as Tool).execute(
      { parent_id: b.id, child_id: a.id },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('execution_failed');
  });

  it('kanban_assign sets the assignee', async () => {
    const t = store.createTask({ title: 'x' });
    const out = await call<{ assignee: string | null }>(
      tools.kanban_assign as Tool,
      { task_id: t.id, assignee: 'reviewer' },
      makeCtx(),
    );
    expect(out.assignee).toBe('reviewer');
  });

  it('kanban_archive flips status to archived', async () => {
    const t = store.createTask({ title: 'x' });
    const out = await call<{ status: string }>(
      tools.kanban_archive as Tool,
      { task_id: t.id },
      makeCtx(),
    );
    expect(out.status).toBe('archived');
  });

  it('kanban_complete stamps completedBy on the run record', async () => {
    const lookup = (id: string) => (id === 'engineer' ? { name: 'Engineer' } : undefined);
    const t2 = toolsByName(createKanbanTools({ store, personalityLookup: lookup }));
    const t = store.createTask({ title: 'x' });
    store.updateStatus(t.id, 'running');
    await call(
      t2.kanban_complete as Tool,
      { task_id: t.id, summary: 'shipped' },
      makeCtx('engineer'),
    );
    const runs = store.listRuns(t.id);
    const completedRun = runs.find((r) => r.outcome === 'completed');
    expect(completedRun?.completedBy).toEqual({ id: 'engineer', name: 'Engineer' });
  });

  it('kanban_complete stamps completedBy with id as fallback name when lookup returns undefined', async () => {
    const lookup = () => undefined;
    const t2 = toolsByName(createKanbanTools({ store, personalityLookup: lookup }));
    const t = store.createTask({ title: 'x' });
    store.updateStatus(t.id, 'running');
    await call(
      t2.kanban_complete as Tool,
      { task_id: t.id, summary: 'shipped' },
      makeCtx('unknown-bot'),
    );
    const runs = store.listRuns(t.id);
    const completedRun = runs.find((r) => r.outcome === 'completed');
    expect(completedRun?.completedBy).toEqual({ id: 'unknown-bot', name: 'unknown-bot' });
  });

  it('kanban_complete without personalityId does not stamp completedBy', async () => {
    const t = store.createTask({ title: 'x' });
    store.updateStatus(t.id, 'running');
    await call(tools.kanban_complete as Tool, { task_id: t.id, summary: 'shipped' }, makeCtx());
    const runs = store.listRuns(t.id);
    const completedRun = runs.find((r) => r.outcome === 'completed');
    expect(completedRun?.completedBy).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// before_ticket_complete hook — opt-in verification gate on kanban_complete
// ---------------------------------------------------------------------------

describe('kanban_complete before_ticket_complete hook', () => {
  let store: KanbanStore;

  beforeEach(() => {
    store = new KanbanStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('blocks completion and sets needs_revision when a verifier rejects', async () => {
    const hooks = new DefaultHookRegistry();
    // A verifier that rejects unless the summary contains a required substring.
    hooks.registerClaiming('before_ticket_complete', async (payload) => {
      if (payload.acceptanceCriteria && !payload.summary.includes(payload.acceptanceCriteria)) {
        return { handled: true, reason: `summary missing "${payload.acceptanceCriteria}"` };
      }
      return { handled: false };
    });
    const tools = toolsByName(createKanbanTools({ store, hooks }));

    const t = store.createTask({ title: 'verified task', acceptanceCriteria: 'SHIPPED' });
    store.updateStatus(t.id, 'running');

    const out = await call<{ status: string }>(
      tools.kanban_complete as Tool,
      { task_id: t.id, summary: 'did some work' },
      makeCtx('engineer'),
    );
    expect(out.status).toBe('needs_revision');

    // The rejection reason landed in the audit trail.
    const reasons = store
      .listEvents(t.id)
      .filter((e) => e.kind === 'status_changed')
      .map((e) => e.data.reason);
    expect(reasons).toContain('summary missing "SHIPPED"');
    // The run was auto-cancelled by the needs_revision transition (not completed).
    expect(store.listRuns(t.id).every((r) => r.outcome !== 'completed')).toBe(true);
  });

  it('proceeds to done when the verifier passes', async () => {
    const hooks = new DefaultHookRegistry();
    hooks.registerClaiming('before_ticket_complete', async (payload) => {
      if (payload.acceptanceCriteria && !payload.summary.includes(payload.acceptanceCriteria)) {
        return { handled: true, reason: 'rejected' };
      }
      return { handled: false };
    });
    const tools = toolsByName(createKanbanTools({ store, hooks }));

    const t = store.createTask({ title: 'verified task', acceptanceCriteria: 'SHIPPED' });
    store.updateStatus(t.id, 'running');

    const out = await call<{ status: string }>(
      tools.kanban_complete as Tool,
      { task_id: t.id, summary: 'work is SHIPPED' },
      makeCtx('engineer'),
    );
    expect(out.status).toBe('done');
  });

  it('does not act on a non-running task even when a verifier is wired', async () => {
    const hooks = new DefaultHookRegistry();
    let fired = false;
    hooks.registerClaiming('before_ticket_complete', async () => {
      fired = true;
      return { handled: true, reason: 'rejected' };
    });
    const tools = toolsByName(createKanbanTools({ store, hooks }));

    const t = store.createTask({ title: 'never started' }); // status=todo

    const result = await (tools.kanban_complete as Tool).execute(
      { task_id: t.id, summary: 'shipped' },
      makeCtx('engineer'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('execution_failed');
    // The verifier never ran, and the task was not transitioned.
    expect(fired).toBe(false);
    expect(store.getTask(t.id)?.status).toBe('todo');
  });

  it('completion proceeds unchanged when no verifier is registered (default no-op)', async () => {
    const tools = toolsByName(createKanbanTools({ store }));
    const t = store.createTask({ title: 'plain task' });
    store.updateStatus(t.id, 'running');

    const out = await call<{ status: string }>(
      tools.kanban_complete as Tool,
      { task_id: t.id, summary: 'anything goes' },
      makeCtx('engineer'),
    );
    expect(out.status).toBe('done');
  });

  it('completion proceeds when a HookRegistry is wired but has no verifier registered', async () => {
    const hooks = new DefaultHookRegistry();
    const tools = toolsByName(createKanbanTools({ store, hooks }));
    const t = store.createTask({ title: 'plain task' });
    store.updateStatus(t.id, 'running');

    const out = await call<{ status: string }>(
      tools.kanban_complete as Tool,
      { task_id: t.id, summary: 'anything goes' },
      makeCtx('engineer'),
    );
    expect(out.status).toBe('done');
  });
});
