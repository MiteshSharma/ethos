import { DefaultHookRegistry } from '@ethosagent/core';
import { KanbanStore } from '@ethosagent/kanban-store';
import type {
  CompletionChunk,
  LLMProvider,
  Message,
  TicketBlockedPayload,
  TicketCompletedPayload,
  TicketUpdatedPayload,
  Tool,
  ToolContext,
} from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKanbanTools } from '../index';

// Minimal LLMProvider stub for kanban_decompose — yields a fixed response
// text as a single text_delta chunk, or throws if `throwsMessage` is set.
function stubDecomposerProvider(opts: {
  responseText?: string;
  throwsMessage?: string;
}): LLMProvider {
  return {
    name: 'stub',
    model: 'stub-model',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    complete(_messages: Message[]): AsyncIterable<CompletionChunk> {
      return (async function* () {
        if (opts.throwsMessage) throw new Error(opts.throwsMessage);
        yield { type: 'text_delta', text: opts.responseText ?? '' } as CompletionChunk;
      })();
    },
    async countTokens() {
      return 0;
    },
  };
}

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

  it('exposes 15 tools in the kanban toolset with the right maxResultChars', () => {
    const names = Object.keys(tools).sort();
    expect(names).toEqual([
      'kanban_archive',
      'kanban_assign',
      'kanban_block',
      'kanban_comment',
      'kanban_complete',
      'kanban_create',
      'kanban_create_goal',
      'kanban_create_swarm',
      'kanban_decompose',
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

  // The verifier fails closed on a `check:` line that does not parse, so a
  // prose line that happens to start "check:" rejects the completion. The
  // reservation has to be stated where the author writes the criteria — the
  // serialized schema is the string the model actually receives.
  it('kanban_create tells the author that "check:" is a reserved line prefix', () => {
    const schema = JSON.stringify((tools.kanban_create as Tool).schema);
    expect(schema).toContain('is a RESERVED line prefix');
    expect(schema).toContain('never read as prose');
    expect(schema).toContain('put ordinary prose on its own line');
    expect(schema).toContain('check: file_exists <path>');
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
  // kanban_create_swarm
  // ---------------------------------------------------------------------------

  it('kanban_create_swarm creates a done root + workers + verifier + synthesizer, wired parent to child', async () => {
    const out = await call<{
      root_id: string;
      worker_ids: string[];
      verifier_id: string | null;
      synthesizer_id: string | null;
    }>(
      tools.kanban_create_swarm as Tool,
      {
        goal: 'Research and report on X',
        workers: [
          { personality: 'researcher-a', prompt: 'Look into angle A' },
          { personality: 'researcher-b', prompt: 'Look into angle B' },
        ],
        verifier_personality: 'verifier',
        synthesizer_personality: 'synthesizer',
      },
      makeCtx(),
    );

    expect(out.worker_ids).toHaveLength(2);
    expect(out.verifier_id).not.toBeNull();
    expect(out.synthesizer_id).not.toBeNull();

    const root = store.getTask(out.root_id);
    expect(root?.status).toBe('done');
    expect(root?.assignee).toBeNull();
    expect(root?.body).toBe('Research and report on X');

    for (const workerId of out.worker_ids) {
      const parents = store.getParents(workerId);
      expect(parents.map((p) => p.id)).toEqual([out.root_id]);
    }

    const verifierId = out.verifier_id as string;
    expect(store.getTask(verifierId)?.assignee).toBe('verifier');
    expect(
      store
        .getParents(verifierId)
        .map((p) => p.id)
        .sort(),
    ).toEqual([...out.worker_ids].sort());

    const synthesizerId = out.synthesizer_id as string;
    expect(store.getTask(synthesizerId)?.assignee).toBe('synthesizer');
    expect(store.getParents(synthesizerId).map((p) => p.id)).toEqual([verifierId]);
  });

  it('kanban_create_swarm skips the verifier tier when verifier_personality is omitted, chaining the synthesizer directly off the workers', async () => {
    const out = await call<{
      root_id: string;
      worker_ids: string[];
      verifier_id: string | null;
      synthesizer_id: string | null;
    }>(
      tools.kanban_create_swarm as Tool,
      {
        goal: 'goal',
        workers: [{ personality: 'w1', prompt: 'do work' }],
        synthesizer_personality: 'synthesizer',
      },
      makeCtx(),
    );

    expect(out.verifier_id).toBeNull();
    expect(out.synthesizer_id).not.toBeNull();
    const synthesizerId = out.synthesizer_id as string;
    expect(store.getParents(synthesizerId).map((p) => p.id)).toEqual(out.worker_ids);
  });

  it('kanban_create_swarm skips both verifier and synthesizer tiers when both are omitted', async () => {
    const out = await call<{
      root_id: string;
      worker_ids: string[];
      verifier_id: string | null;
      synthesizer_id: string | null;
    }>(
      tools.kanban_create_swarm as Tool,
      { goal: 'goal', workers: [{ personality: 'w1', prompt: 'do work' }] },
      makeCtx(),
    );

    expect(out.verifier_id).toBeNull();
    expect(out.synthesizer_id).toBeNull();
    expect(store.listTasks()).toHaveLength(2); // root + 1 worker
  });

  it('kanban_create_swarm rejects a missing goal', async () => {
    const result = await (tools.kanban_create_swarm as Tool).execute(
      { workers: [{ personality: 'w1', prompt: 'p' }] },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('kanban_create_swarm rejects an empty workers array', async () => {
    const result = await (tools.kanban_create_swarm as Tool).execute(
      { goal: 'goal', workers: [] },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('kanban_create_swarm rejects a worker missing personality or prompt', async () => {
    const result = await (tools.kanban_create_swarm as Tool).execute(
      { goal: 'goal', workers: [{ personality: 'w1' }] },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('kanban_create_swarm rejects more than the max worker count', async () => {
    const workers = Array.from({ length: 21 }, (_, i) => ({
      personality: `w${i}`,
      prompt: 'p',
    }));
    const result = await (tools.kanban_create_swarm as Tool).execute(
      { goal: 'goal', workers },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('kanban_create_swarm rolls back the whole graph when a failure hits partway through construction — no orphan root/worker tasks survive', async () => {
    const originalCreateTask = store.createTask.bind(store);
    let calls = 0;
    vi.spyOn(store, 'createTask').mockImplementation((createArgs) => {
      calls += 1;
      // Let the root and first worker through, then blow up on the second worker —
      // exactly the "partway through graph construction" case the plan calls for.
      if (calls === 3) throw new Error('boom');
      return originalCreateTask(createArgs);
    });

    const result = await (tools.kanban_create_swarm as Tool).execute(
      {
        goal: 'goal',
        workers: [
          { personality: 'w1', prompt: 'p1' },
          { personality: 'w2', prompt: 'p2' },
        ],
        verifier_personality: 'verifier',
      },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/boom/);
    // The root and first worker were created inside the same transaction as
    // the failing second worker — all of it must have rolled back together.
    expect(store.listTasks()).toHaveLength(0);

    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // kanban_decompose
  // ---------------------------------------------------------------------------

  it('kanban_decompose returns execution_failed when no decomposer provider is configured', async () => {
    // The default `tools` fixture (beforeEach) has no decomposerProvider wired.
    const goal = await call<{ task_id: string }>(
      tools.kanban_create_goal as Tool,
      { title: 'Goal' },
      makeCtx(),
    );
    const result = await (tools.kanban_decompose as Tool).execute(
      { task_id: goal.task_id },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toMatch(/no auxiliary\.kanban_decomposer model configured/);
    }
  });

  it('kanban_decompose rejects missing task_id', async () => {
    const provider = stubDecomposerProvider({ responseText: '[]' });
    const decomposeTools = toolsByName(createKanbanTools({ store, decomposerProvider: provider }));
    const result = await (decomposeTools.kanban_decompose as Tool).execute({}, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('kanban_decompose returns input_invalid for an unknown task_id', async () => {
    const provider = stubDecomposerProvider({ responseText: '[]' });
    const decomposeTools = toolsByName(createKanbanTools({ store, decomposerProvider: provider }));
    const result = await (decomposeTools.kanban_decompose as Tool).execute(
      { task_id: 'nope' },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('kanban_decompose creates a child per proposed task, parented to the goal', async () => {
    const provider = stubDecomposerProvider({
      responseText: JSON.stringify([
        { title: 'child A', body: 'do A', assignee: 'engineer' },
        { title: 'child B' },
      ]),
    });
    const decomposeTools = toolsByName(createKanbanTools({ store, decomposerProvider: provider }));
    const goal = await call<{ task_id: string }>(
      decomposeTools.kanban_create_goal as Tool,
      { title: 'Goal' },
      makeCtx(),
    );

    const out = await call<{
      task_id: string;
      children_created: { task_id: string; title: string }[];
    }>(decomposeTools.kanban_decompose as Tool, { task_id: goal.task_id }, makeCtx());

    expect(out.children_created).toHaveLength(2);
    expect(out.children_created.map((c) => c.title)).toEqual(['child A', 'child B']);
    const childA = store.getTask(out.children_created[0]?.task_id ?? '');
    expect(childA?.body).toBe('do A');
    expect(childA?.assignee).toBe('engineer');
    expect(store.getParents(out.children_created[0]?.task_id ?? '').map((p) => p.id)).toEqual([
      goal.task_id,
    ]);
    const childB = store.getTask(out.children_created[1]?.task_id ?? '');
    expect(childB?.assignee).toBeNull();
  });

  it('kanban_decompose strips a ```json fence around the response', async () => {
    const provider = stubDecomposerProvider({
      responseText: '```json\n[{"title": "fenced child"}]\n```',
    });
    const decomposeTools = toolsByName(createKanbanTools({ store, decomposerProvider: provider }));
    const goal = await call<{ task_id: string }>(
      decomposeTools.kanban_create_goal as Tool,
      { title: 'Goal' },
      makeCtx(),
    );
    const out = await call<{ children_created: { title: string }[] }>(
      decomposeTools.kanban_decompose as Tool,
      { task_id: goal.task_id },
      makeCtx(),
    );
    expect(out.children_created.map((c) => c.title)).toEqual(['fenced child']);
  });

  it('kanban_decompose returns execution_failed with no children created when the LLM call throws', async () => {
    const provider = stubDecomposerProvider({ throwsMessage: 'provider unreachable' });
    const decomposeTools = toolsByName(createKanbanTools({ store, decomposerProvider: provider }));
    const goal = await call<{ task_id: string }>(
      decomposeTools.kanban_create_goal as Tool,
      { title: 'Goal' },
      makeCtx(),
    );
    const result = await (decomposeTools.kanban_decompose as Tool).execute(
      { task_id: goal.task_id },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toMatch(/provider unreachable/);
    }
    expect(store.listTasks({ parentId: goal.task_id })).toHaveLength(0);
  });

  it('kanban_decompose returns execution_failed when the response is not valid JSON', async () => {
    const provider = stubDecomposerProvider({ responseText: 'not json at all' });
    const decomposeTools = toolsByName(createKanbanTools({ store, decomposerProvider: provider }));
    const goal = await call<{ task_id: string }>(
      decomposeTools.kanban_create_goal as Tool,
      { title: 'Goal' },
      makeCtx(),
    );
    const result = await (decomposeTools.kanban_decompose as Tool).execute(
      { task_id: goal.task_id },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('execution_failed');
    expect(store.listTasks({ parentId: goal.task_id })).toHaveLength(0);
  });

  it('kanban_decompose returns a partial-success result when a per-child create fails partway through', async () => {
    const provider = stubDecomposerProvider({
      responseText: JSON.stringify([
        { title: 'child A' },
        { title: 'child B' },
        { title: 'child C' },
      ]),
    });
    const decomposeTools = toolsByName(createKanbanTools({ store, decomposerProvider: provider }));
    const goal = await call<{ task_id: string }>(
      decomposeTools.kanban_create_goal as Tool,
      { title: 'Goal' },
      makeCtx(),
    );

    const originalCreateTask = store.createTask.bind(store);
    let calls = 0;
    vi.spyOn(store, 'createTask').mockImplementation((args) => {
      calls += 1;
      if (calls === 2) throw new Error('boom');
      return originalCreateTask(args);
    });

    const out = await call<{
      task_id: string;
      children_created: { task_id: string; title: string }[];
      partial_failure?: boolean;
      failed_child?: { title: string; error: string };
      not_attempted?: { title: string }[];
    }>(decomposeTools.kanban_decompose as Tool, { task_id: goal.task_id }, makeCtx());

    expect(out.children_created).toHaveLength(1);
    expect(out.children_created[0]?.title).toBe('child A');
    expect(out.partial_failure).toBe(true);
    expect(out.failed_child?.title).toBe('child B');
    expect(out.failed_child?.error).toMatch(/boom/);
    expect(out.not_attempted).toEqual([{ title: 'child C' }]);

    vi.restoreAllMocks();
  });

  it("kanban_decompose applies kanban_create's length caps to a proposed child and stops at the first oversized one", async () => {
    // MAX_TITLE_CHARS is 500 (not exported); one char over trips the same
    // `tooLong` check kanban_create runs on its own args.
    const oversizedTitle = 'x'.repeat(501);
    const provider = stubDecomposerProvider({
      responseText: JSON.stringify([
        { title: 'child A' },
        { title: oversizedTitle },
        { title: 'child C' },
      ]),
    });
    const decomposeTools = toolsByName(createKanbanTools({ store, decomposerProvider: provider }));
    const goal = await call<{ task_id: string }>(
      decomposeTools.kanban_create_goal as Tool,
      { title: 'Goal' },
      makeCtx(),
    );

    const out = await call<{
      task_id: string;
      children_created: { task_id: string; title: string }[];
      partial_failure?: boolean;
      failed_child?: { title: string; error: string };
      not_attempted?: { title: string }[];
    }>(decomposeTools.kanban_decompose as Tool, { task_id: goal.task_id }, makeCtx());

    expect(out.children_created).toHaveLength(1);
    expect(out.children_created[0]?.title).toBe('child A');
    expect(out.partial_failure).toBe(true);
    expect(out.failed_child?.title).toBe(oversizedTitle);
    expect(out.failed_child?.error).toMatch(/title too long/);
    expect(out.not_attempted).toEqual([{ title: 'child C' }]);

    // The oversized child never reached the store — same "stop at first
    // failure" semantic as a store.createTask throw, so nothing after it was
    // attempted either.
    expect(store.listTasks({ parentId: goal.task_id })).toHaveLength(1);
  });

  it('kanban_decompose caps max_children at 10 and rejects a non-positive-integer', async () => {
    const provider = stubDecomposerProvider({
      responseText: JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ title: `child ${i}` }))),
    });
    const decomposeTools = toolsByName(createKanbanTools({ store, decomposerProvider: provider }));
    const goal = await call<{ task_id: string }>(
      decomposeTools.kanban_create_goal as Tool,
      { title: 'Goal' },
      makeCtx(),
    );
    const out = await call<{ children_created: unknown[] }>(
      decomposeTools.kanban_decompose as Tool,
      { task_id: goal.task_id, max_children: 999 },
      makeCtx(),
    );
    expect(out.children_created).toHaveLength(10);

    const badResult = await (decomposeTools.kanban_decompose as Tool).execute(
      { task_id: goal.task_id, max_children: 0 },
      makeCtx(),
    );
    expect(badResult.ok).toBe(false);
    if (!badResult.ok) expect(badResult.code).toBe('input_invalid');
  });

  it('kanban_decompose rejects an over-long instructions string', async () => {
    const provider = stubDecomposerProvider({ responseText: '[]' });
    const decomposeTools = toolsByName(createKanbanTools({ store, decomposerProvider: provider }));
    const goal = await call<{ task_id: string }>(
      decomposeTools.kanban_create_goal as Tool,
      { title: 'Goal' },
      makeCtx(),
    );
    const result = await (decomposeTools.kanban_decompose as Tool).execute(
      { task_id: goal.task_id, instructions: 'a'.repeat(4_001) },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
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

// ---------------------------------------------------------------------------
// ticket_blocked / ticket_completed / ticket_updated — Lane B lifecycle hooks
// (kanban-hooks-notify-parity)
// ---------------------------------------------------------------------------

describe('kanban tools Lane B lifecycle hooks', () => {
  let store: KanbanStore;

  beforeEach(() => {
    store = new KanbanStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('kanban_block fires ticket_blocked with kind when supplied', async () => {
    const hooks = new DefaultHookRegistry();
    const blocked: TicketBlockedPayload[] = [];
    hooks.registerVoid('ticket_blocked', async (payload) => {
      blocked.push(payload);
    });
    const tools = toolsByName(createKanbanTools({ store, hooks }));

    const t = store.createTask({ title: 'x' });
    store.updateStatus(t.id, 'running');

    await call(
      tools.kanban_block as Tool,
      { task_id: t.id, reason: 'waiting on API key', kind: 'needs_input' },
      makeCtx('engineer'),
    );

    expect(blocked).toEqual([{ taskId: t.id, reason: 'waiting on API key', kind: 'needs_input' }]);
  });

  it('kanban_block fires ticket_blocked without a kind key when none is supplied', async () => {
    const hooks = new DefaultHookRegistry();
    const blocked: TicketBlockedPayload[] = [];
    hooks.registerVoid('ticket_blocked', async (payload) => {
      blocked.push(payload);
    });
    const tools = toolsByName(createKanbanTools({ store, hooks }));

    const t = store.createTask({ title: 'x' });
    store.updateStatus(t.id, 'running');

    await call(tools.kanban_block as Tool, { task_id: t.id, reason: 'stuck' }, makeCtx('engineer'));

    expect(blocked).toEqual([{ taskId: t.id, reason: 'stuck' }]);
    expect(blocked[0]).not.toHaveProperty('kind');
  });

  it('kanban_complete fires ticket_completed with { taskId, summary } on the successful path', async () => {
    const hooks = new DefaultHookRegistry();
    const completed: TicketCompletedPayload[] = [];
    hooks.registerVoid('ticket_completed', async (payload) => {
      completed.push(payload);
    });
    const tools = toolsByName(createKanbanTools({ store, hooks }));

    const t = store.createTask({ title: 'x' });
    store.updateStatus(t.id, 'running');

    await call(
      tools.kanban_complete as Tool,
      { task_id: t.id, summary: 'shipped it' },
      makeCtx('engineer'),
    );

    expect(completed).toEqual([{ taskId: t.id, summary: 'shipped it' }]);
  });

  it('kanban_complete does NOT fire ticket_completed when before_ticket_complete rejects the completion', async () => {
    const hooks = new DefaultHookRegistry();
    hooks.registerClaiming('before_ticket_complete', async () => ({
      handled: true,
      reason: 'not good enough',
    }));
    const completed: TicketCompletedPayload[] = [];
    hooks.registerVoid('ticket_completed', async (payload) => {
      completed.push(payload);
    });
    const tools = toolsByName(createKanbanTools({ store, hooks }));

    const t = store.createTask({ title: 'x' });
    store.updateStatus(t.id, 'running');

    const out = await call<{ status: string }>(
      tools.kanban_complete as Tool,
      { task_id: t.id, summary: 'shipped it' },
      makeCtx('engineer'),
    );

    expect(out.status).toBe('needs_revision');
    expect(completed).toEqual([]);
  });

  it('kanban_assign fires ticket_updated with { taskId, changedFields: ["assignee"] }', async () => {
    const hooks = new DefaultHookRegistry();
    const updated: TicketUpdatedPayload[] = [];
    hooks.registerVoid('ticket_updated', async (payload) => {
      updated.push(payload);
    });
    const tools = toolsByName(createKanbanTools({ store, hooks }));

    const t = store.createTask({ title: 'x' });

    await call(
      tools.kanban_assign as Tool,
      { task_id: t.id, assignee: 'researcher' },
      makeCtx('engineer'),
    );

    expect(updated).toEqual([{ taskId: t.id, changedFields: ['assignee'] }]);
  });
});
