import type {
  BlockKind,
  KanbanStore,
  Task,
  TaskComment,
  TaskEvent,
  TaskRun,
  TaskStatus,
  WorkspaceMode,
} from '@ethosagent/kanban-store';
import type { HookRegistry, LLMProvider, Tool, ToolContext, ToolResult } from '@ethosagent/types';

export { type PostmortemHandlerOptions, registerPostmortemHandler } from './postmortem';
export {
  createKanbanRoleGateHook,
  type KanbanRoleGateOptions,
  type TeamRole,
} from './role-gate';
export { type CompletionVerifierOptions, createCompletionVerifier } from './verifier';

// Rules block — appended to every tool description so the LLM remembers when
// to reach for kanban vs the ephemeral `todo_*` toolset.
const RULES = [
  '',
  'WHEN TO USE',
  '- Work that must survive a process restart or be visible across sessions',
  '- Cross-personality coordination (Plan B layers governance on these primitives)',
  '- Anything you would want a durable audit trail of: runs, completions, blockers',
  '',
  'WHEN NOT TO USE',
  '- Short-lived this-turn step lists → reach for `todo_*` instead',
  '- Throwaway scratch notes',
  '',
  'STATUSES',
  '- todo → ready → running → done',
  '- blocked (called out explicitly via kanban_block; unblock with kanban_unblock)',
  '- needs_revision (a before_ticket_complete verifier rejected the completion, OR kanban_block was called ' +
    'with the same `kind` too many times in a row; re-claim to retry)',
  '- archived (soft-delete; preserves audit trail)',
].join('\n');

const MAX_RESULT_CHARS = 20_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResult(value: unknown): ToolResult {
  return { ok: true, value: JSON.stringify(value, null, 2) };
}

type ErrorCode = Extract<ToolResult, { ok: false }>['code'];

function errorResult(error: string, code: ErrorCode): ToolResult {
  return { ok: false, error, code };
}

function actorOf(ctx: ToolContext): string {
  return ctx.personalityId ?? 'system';
}

const STATUS_VALUES: TaskStatus[] = [
  'todo',
  'ready',
  'running',
  'blocked',
  'done',
  'archived',
  'scheduled',
  'failed',
  'needs_revision',
];
const WORKSPACE_MODES: WorkspaceMode[] = ['scratch', 'worktree', 'dir'];
const BLOCK_KINDS: BlockKind[] = ['dependency', 'needs_input', 'capability', 'transient'];

function isStatus(s: unknown): s is TaskStatus {
  return typeof s === 'string' && (STATUS_VALUES as string[]).includes(s);
}

function isWorkspaceMode(s: unknown): s is WorkspaceMode {
  return typeof s === 'string' && (WORKSPACE_MODES as string[]).includes(s);
}

function isBlockKind(s: unknown): s is BlockKind {
  return typeof s === 'string' && (BLOCK_KINDS as string[]).includes(s);
}

function summariseTask(t: Task) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    assignee: t.assignee,
    priority: t.priority,
    current_run_id: t.currentRunId,
    retry_count: t.retryCount,
    max_retries: t.maxRetries,
    updated_at: t.updatedAt,
  };
}

function fullTask(t: Task) {
  return {
    id: t.id,
    title: t.title,
    body: t.body,
    status: t.status,
    assignee: t.assignee,
    priority: t.priority,
    workspace_mode: t.workspaceMode,
    workspace_path: t.workspacePath,
    scheduled_for: t.scheduledFor,
    current_run_id: t.currentRunId,
    retry_count: t.retryCount,
    max_retries: t.maxRetries,
    acceptance_criteria: t.acceptanceCriteria,
    block_kind: t.blockKind,
    block_recurrence_count: t.blockRecurrenceCount,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  };
}

function shapeRun(r: TaskRun) {
  return {
    id: r.id,
    started_at: r.startedAt,
    ended_at: r.endedAt,
    outcome: r.outcome,
    summary: r.summary,
    last_heartbeat_at: r.lastHeartbeatAt,
    completed_by: r.completedBy,
  };
}

function shapeComment(c: TaskComment) {
  return {
    id: c.id,
    author: c.author,
    body: c.body,
    created_at: c.createdAt,
  };
}

function shapeEvent(e: TaskEvent) {
  return {
    kind: e.kind,
    actor: e.actor,
    data: e.data,
    created_at: e.createdAt,
  };
}

// Translate a thrown Error from the store into a ToolResult. Cycle / no-open-run /
// not-found cases get the appropriate code; anything else falls through to execution_failed.
function storeError(err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  if (/^cycle:/.test(msg)) return errorResult(msg, 'execution_failed');
  if (/no open run:/.test(msg)) return errorResult(msg, 'execution_failed');
  if (/not found/.test(msg)) return errorResult(msg, 'input_invalid');
  return errorResult(msg, 'execution_failed');
}

// ---------------------------------------------------------------------------
// kanban_create
// ---------------------------------------------------------------------------

interface CreateArgs {
  title: string;
  body?: string;
  assignee?: string | null;
  priority?: number;
  parents?: string[];
  workspace_mode?: WorkspaceMode;
  scheduled_for?: number | null;
  idempotency_key?: string | null;
  max_retries?: number | null;
  acceptance_criteria?: string | null;
}

function createKanbanCreate(store: KanbanStore): Tool {
  return {
    name: 'kanban_create',
    description:
      'Create a new durable task. Returns { task_id, status }. ' +
      'idempotency_key turns the call into a lookup-by-key on retry: if a task already exists ' +
      'with that key, the existing task is returned and the rest of this call (title, body, parents, ' +
      'etc.) is IGNORED. Only reuse a key when you mean "give me back the same task" — never to ' +
      'update fields.\n' +
      RULES,
    toolset: 'kanban',
    maxResultChars: MAX_RESULT_CHARS,
    capabilities: {},
    schema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        assignee: { type: 'string', description: 'Personality id or "human:<name>"' },
        priority: { type: 'integer', description: 'Higher = more urgent (default 0)' },
        parents: { type: 'array', items: { type: 'string' } },
        workspace_mode: { type: 'string', enum: WORKSPACE_MODES },
        scheduled_for: { type: 'integer', description: 'Epoch ms; sets status=scheduled' },
        idempotency_key: { type: 'string' },
        max_retries: {
          type: ['integer', 'null'],
          description:
            'Retry budget. Omit (or null) for unlimited retries. When set, the task is ' +
            'moved to status=failed once it has been re-claimed more than this many times.',
        },
        acceptance_criteria: {
          type: 'string',
          description:
            'Optional. What "done" means for this task — checked by a before_ticket_complete ' +
            'verifier hook when one is registered. No behavioural impact when absent.',
        },
      },
    },
    async execute(rawArgs, ctx) {
      const args = (rawArgs ?? {}) as Partial<CreateArgs>;
      if (typeof args.title !== 'string' || args.title.length === 0) {
        return errorResult('title must be a non-empty string', 'input_invalid');
      }
      const titleErr = tooLong('title', args.title, MAX_TITLE_CHARS);
      if (titleErr) return titleErr;
      if (args.body !== undefined) {
        if (typeof args.body !== 'string')
          return errorResult('body must be a string', 'input_invalid');
        const bodyErr = tooLong('body', args.body, MAX_BODY_CHARS);
        if (bodyErr) return bodyErr;
      }
      if (
        args.priority !== undefined &&
        (typeof args.priority !== 'number' || !Number.isFinite(args.priority))
      ) {
        return errorResult('priority must be a finite number', 'input_invalid');
      }
      if (
        args.parents !== undefined &&
        (!Array.isArray(args.parents) || args.parents.some((p) => typeof p !== 'string'))
      ) {
        return errorResult('parents must be an array of task id strings', 'input_invalid');
      }
      if (
        args.scheduled_for !== undefined &&
        args.scheduled_for !== null &&
        (typeof args.scheduled_for !== 'number' || !Number.isFinite(args.scheduled_for))
      ) {
        return errorResult('scheduled_for must be a finite number or null', 'input_invalid');
      }
      if (args.idempotency_key !== undefined) {
        if (typeof args.idempotency_key !== 'string') {
          return errorResult('idempotency_key must be a string', 'input_invalid');
        }
        const ikErr = tooLong('idempotency_key', args.idempotency_key, MAX_IDEMPOTENCY_KEY_CHARS);
        if (ikErr) return ikErr;
      }
      if (args.assignee !== undefined && args.assignee !== null) {
        if (typeof args.assignee !== 'string') {
          return errorResult('assignee must be a string or null', 'input_invalid');
        }
        const aErr = tooLong('assignee', args.assignee, MAX_ASSIGNEE_CHARS);
        if (aErr) return aErr;
      }
      if (args.workspace_mode !== undefined && !isWorkspaceMode(args.workspace_mode)) {
        return errorResult(
          `workspace_mode must be one of ${WORKSPACE_MODES.join(', ')}`,
          'input_invalid',
        );
      }
      if (
        args.max_retries !== undefined &&
        args.max_retries !== null &&
        (!Number.isInteger(args.max_retries) || args.max_retries < 0)
      ) {
        return errorResult('max_retries must be a non-negative integer or null', 'input_invalid');
      }
      if (args.acceptance_criteria !== undefined && args.acceptance_criteria !== null) {
        if (typeof args.acceptance_criteria !== 'string') {
          return errorResult('acceptance_criteria must be a string', 'input_invalid');
        }
        const acErr = tooLong('acceptance_criteria', args.acceptance_criteria, MAX_BODY_CHARS);
        if (acErr) return acErr;
      }
      try {
        const task = store.createTask({
          title: args.title,
          ...(args.body !== undefined ? { body: args.body } : {}),
          ...(args.assignee !== undefined ? { assignee: args.assignee } : {}),
          ...(args.priority !== undefined ? { priority: args.priority } : {}),
          ...(args.parents !== undefined ? { parents: args.parents } : {}),
          ...(args.workspace_mode !== undefined ? { workspaceMode: args.workspace_mode } : {}),
          ...(args.scheduled_for !== undefined ? { scheduledFor: args.scheduled_for } : {}),
          ...(args.idempotency_key !== undefined ? { idempotencyKey: args.idempotency_key } : {}),
          ...(args.max_retries !== undefined ? { maxRetries: args.max_retries } : {}),
          ...(args.acceptance_criteria !== undefined
            ? { acceptanceCriteria: args.acceptance_criteria }
            : {}),
          actor: actorOf(ctx),
        });
        return jsonResult({ task_id: task.id, status: task.status });
      } catch (err) {
        return storeError(err);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// kanban_create_goal — sugar around kanban_create for the goal-as-parent-task pattern
// ---------------------------------------------------------------------------

interface CreateGoalArgs {
  title: string;
  description?: string;
  priority?: number;
  idempotency_key?: string;
}

function createKanbanCreateGoal(store: KanbanStore): Tool {
  return {
    name: 'kanban_create_goal',
    description:
      'Create a top-level GOAL. A goal is a kanban task with no assignee — the goal itself is never executed; its children are. Use this when the human gives you a multi-part objective, then call `kanban_create` once per child sub-task with `parents=[goal_id]` and `assignee=<specialist>`. Returns { task_id, status }.\n' +
      RULES,
    toolset: 'kanban',
    maxResultChars: MAX_RESULT_CHARS,
    capabilities: {},
    schema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        description: { type: 'string', description: 'Full goal body (rendered in the board UI)' },
        priority: { type: 'integer' },
        idempotency_key: { type: 'string' },
      },
    },
    async execute(rawArgs, ctx) {
      const args = (rawArgs ?? {}) as Partial<CreateGoalArgs>;
      if (typeof args.title !== 'string' || args.title.length === 0) {
        return errorResult('title must be a non-empty string', 'input_invalid');
      }
      const titleErr = tooLong('title', args.title, MAX_TITLE_CHARS);
      if (titleErr) return titleErr;
      if (args.description !== undefined) {
        if (typeof args.description !== 'string') {
          return errorResult('description must be a string', 'input_invalid');
        }
        const dErr = tooLong('description', args.description, MAX_BODY_CHARS);
        if (dErr) return dErr;
      }
      if (
        args.priority !== undefined &&
        (typeof args.priority !== 'number' || !Number.isFinite(args.priority))
      ) {
        return errorResult('priority must be a finite number', 'input_invalid');
      }
      if (args.idempotency_key !== undefined) {
        if (typeof args.idempotency_key !== 'string') {
          return errorResult('idempotency_key must be a string', 'input_invalid');
        }
        const ikErr = tooLong('idempotency_key', args.idempotency_key, MAX_IDEMPOTENCY_KEY_CHARS);
        if (ikErr) return ikErr;
      }
      try {
        const task = store.createTask({
          title: args.title,
          ...(args.description !== undefined ? { body: args.description } : {}),
          ...(args.priority !== undefined ? { priority: args.priority } : {}),
          ...(args.idempotency_key !== undefined ? { idempotencyKey: args.idempotency_key } : {}),
          // assignee stays null — that's what makes this a goal vs a regular task.
          assignee: null,
          actor: actorOf(ctx),
        });
        return jsonResult({ task_id: task.id, status: task.status });
      } catch (err) {
        return storeError(err);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// kanban_create_swarm — atomic root/blackboard + N workers + optional
// verifier + optional synthesizer DAG (Lane A Phase 5)
// ---------------------------------------------------------------------------

interface CreateSwarmWorkerArg {
  personality: string;
  prompt: string;
}

interface CreateSwarmArgs {
  goal: string;
  workers: CreateSwarmWorkerArg[];
  verifier_personality?: string;
  synthesizer_personality?: string;
}

function createKanbanCreateSwarm(store: KanbanStore): Tool {
  return {
    name: 'kanban_create_swarm',
    description:
      'Create a whole swarm DAG in one atomic call: a root/blackboard task (immediately done, ' +
      'body = goal) + one worker task per entry in `workers` (parents=[root]) + an optional ' +
      'verifier task (parents=every worker) + an optional synthesizer task (parents=[verifier], ' +
      'or every worker if no verifier was given). All-or-nothing — a failure partway through ' +
      'creates nothing. Omit verifier_personality/synthesizer_personality to skip that tier. ' +
      'Returns { root_id, worker_ids, verifier_id, synthesizer_id }.\n' +
      RULES,
    toolset: 'kanban',
    maxResultChars: MAX_RESULT_CHARS,
    capabilities: {},
    schema: {
      type: 'object',
      required: ['goal', 'workers'],
      properties: {
        goal: {
          type: 'string',
          description: 'Shared context for the swarm — becomes the root/blackboard task body.',
        },
        workers: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['personality', 'prompt'],
            properties: {
              personality: {
                type: 'string',
                description: 'Personality id (or "human:<name>") this worker task is assigned to.',
              },
              prompt: { type: 'string', description: "This worker's task body." },
            },
          },
        },
        verifier_personality: {
          type: 'string',
          description:
            'Optional. Personality id assigned to verify all worker outputs once every worker ' +
            'is done. Omit to skip the verifier tier.',
        },
        synthesizer_personality: {
          type: 'string',
          description:
            'Optional. Personality id assigned to synthesize the final result once the ' +
            'verifier (or, if omitted, every worker) is done. Omit to skip the synthesizer tier.',
        },
      },
    },
    async execute(rawArgs, ctx) {
      const args = (rawArgs ?? {}) as Partial<CreateSwarmArgs>;
      if (typeof args.goal !== 'string' || args.goal.length === 0) {
        return errorResult('goal must be a non-empty string', 'input_invalid');
      }
      const goalErr = tooLong('goal', args.goal, MAX_BODY_CHARS);
      if (goalErr) return goalErr;

      if (!Array.isArray(args.workers) || args.workers.length === 0) {
        return errorResult('workers must be a non-empty array', 'input_invalid');
      }
      if (args.workers.length > MAX_SWARM_WORKERS) {
        return errorResult(
          `workers must have at most ${MAX_SWARM_WORKERS} entries`,
          'input_invalid',
        );
      }
      const workers: CreateSwarmWorkerArg[] = [];
      for (const raw of args.workers) {
        if (typeof raw !== 'object' || raw === null) {
          return errorResult(
            'each worker must be an object with personality and prompt',
            'input_invalid',
          );
        }
        const w = raw as Partial<CreateSwarmWorkerArg>;
        if (typeof w.personality !== 'string' || w.personality.length === 0) {
          return errorResult('each worker.personality must be a non-empty string', 'input_invalid');
        }
        const personalityErr = tooLong('worker.personality', w.personality, MAX_ASSIGNEE_CHARS);
        if (personalityErr) return personalityErr;
        if (typeof w.prompt !== 'string' || w.prompt.length === 0) {
          return errorResult('each worker.prompt must be a non-empty string', 'input_invalid');
        }
        const promptErr = tooLong('worker.prompt', w.prompt, MAX_BODY_CHARS);
        if (promptErr) return promptErr;
        workers.push({ personality: w.personality, prompt: w.prompt });
      }

      let verifierPersonality: string | undefined;
      if (args.verifier_personality !== undefined) {
        if (
          typeof args.verifier_personality !== 'string' ||
          args.verifier_personality.length === 0
        ) {
          return errorResult('verifier_personality must be a non-empty string', 'input_invalid');
        }
        const verifierErr = tooLong(
          'verifier_personality',
          args.verifier_personality,
          MAX_ASSIGNEE_CHARS,
        );
        if (verifierErr) return verifierErr;
        verifierPersonality = args.verifier_personality;
      }

      let synthesizerPersonality: string | undefined;
      if (args.synthesizer_personality !== undefined) {
        if (
          typeof args.synthesizer_personality !== 'string' ||
          args.synthesizer_personality.length === 0
        ) {
          return errorResult('synthesizer_personality must be a non-empty string', 'input_invalid');
        }
        const synthesizerErr = tooLong(
          'synthesizer_personality',
          args.synthesizer_personality,
          MAX_ASSIGNEE_CHARS,
        );
        if (synthesizerErr) return synthesizerErr;
        synthesizerPersonality = args.synthesizer_personality;
      }

      try {
        const result = store.createSwarm(
          {
            goal: args.goal,
            workers,
            ...(verifierPersonality !== undefined ? { verifierPersonality } : {}),
            ...(synthesizerPersonality !== undefined ? { synthesizerPersonality } : {}),
          },
          actorOf(ctx),
        );
        return jsonResult({
          root_id: result.rootId,
          worker_ids: result.workerIds,
          verifier_id: result.verifierId,
          synthesizer_id: result.synthesizerId,
        });
      } catch (err) {
        return storeError(err);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// kanban_decompose — auxiliary-LLM goal-to-children fan-out (Lane A Phase 2)
// ---------------------------------------------------------------------------

const DECOMPOSE_CHILDREN_DEFAULT = 5;
const DECOMPOSE_CHILDREN_CAP = 10;
const MAX_INSTRUCTIONS_CHARS = 4_000;

const DECOMPOSE_SYSTEM_PROMPT =
  'You break a parent task into concrete, assignable child sub-tasks. ' +
  "Given the parent task's title and body, propose child tasks that together accomplish it. " +
  'Output ONLY a JSON array, no prose, no markdown code fences. Each element must be an object: ' +
  '{"title": string, "body": string (optional), "assignee": string or null (optional)}. ' +
  '"assignee" is a personality id this child should be assigned to — use null if no specific ' +
  'assignee is clear. Keep titles short and imperative; body should carry enough context for the ' +
  'assignee to start work independently, with no access to this conversation.';

interface ProposedChild {
  title: string;
  body?: string;
  assignee?: string | null;
}

function buildDecomposePrompt(task: Task, maxChildren: number, instructions?: string): string {
  const lines = [
    `Parent task title: ${task.title}`,
    task.body ? `Parent task body:\n${task.body}` : 'Parent task body: (none)',
  ];
  if (instructions) lines.push(`Extra instructions: ${instructions}`);
  lines.push(`Propose at most ${maxChildren} child tasks, as a JSON array.`);
  return lines.join('\n\n');
}

// Defensive parse: the auxiliary model is a free-text LLM, not a structured-
// output call. Strip an optional ```/```json fence, JSON.parse, and validate
// shape field-by-field. Any deviation returns null — the caller turns that
// into a tool error rather than guessing at a partial shape.
function parseDecomposeResponse(raw: string): ProposedChild[] | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? raw).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  const children: ProposedChild[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) return null;
    const obj = item as Record<string, unknown>;
    if (typeof obj.title !== 'string' || obj.title.length === 0) return null;
    const child: ProposedChild = { title: obj.title };
    if (obj.body !== undefined) {
      if (typeof obj.body !== 'string') return null;
      child.body = obj.body;
    }
    if (obj.assignee !== undefined) {
      if (obj.assignee !== null && typeof obj.assignee !== 'string') return null;
      child.assignee = obj.assignee;
    }
    children.push(child);
  }
  return children;
}

function createKanbanDecompose(store: KanbanStore, decomposerProvider?: LLMProvider): Tool {
  return {
    name: 'kanban_decompose',
    description:
      'Ask the auxiliary kanban_decomposer model to propose child sub-tasks for a parent task, then ' +
      'create each proposed child with parents=[task_id]. Requires an `auxiliary.kanban_decomposer` ' +
      'model configured in wiring — without one this returns a clear execution_failed error. ' +
      'NOT one atomic transaction: if the auxiliary LLM call fails (or returns an unparseable ' +
      'response), no children are created. If the LLM call succeeds but an individual child create ' +
      'fails partway through, this returns a partial-success result — children_created lists what ' +
      'was actually made, failed_child names the one that errored, and not_attempted lists the rest. ' +
      'Use kanban_archive to clean up unwanted children, or retry.\n' +
      RULES,
    toolset: 'kanban',
    maxResultChars: MAX_RESULT_CHARS,
    capabilities: {},
    schema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string', description: 'Parent task to decompose into children.' },
        max_children: {
          type: 'integer',
          description: `How many child tasks to propose (default ${DECOMPOSE_CHILDREN_DEFAULT}, capped at ${DECOMPOSE_CHILDREN_CAP}).`,
        },
        instructions: {
          type: 'string',
          description:
            'Optional extra guidance for the decomposer model (constraints, preferred assignees, etc).',
        },
      },
    },
    async execute(rawArgs, ctx) {
      const args = (rawArgs ?? {}) as {
        task_id?: unknown;
        max_children?: unknown;
        instructions?: unknown;
      };
      if (typeof args.task_id !== 'string') {
        return errorResult('task_id must be a string', 'input_invalid');
      }
      const taskId = args.task_id;
      if (
        args.max_children !== undefined &&
        (typeof args.max_children !== 'number' ||
          !Number.isInteger(args.max_children) ||
          args.max_children < 1)
      ) {
        return errorResult('max_children must be a positive integer', 'input_invalid');
      }
      if (args.instructions !== undefined) {
        if (typeof args.instructions !== 'string') {
          return errorResult('instructions must be a string', 'input_invalid');
        }
        const iErr = tooLong('instructions', args.instructions, MAX_INSTRUCTIONS_CHARS);
        if (iErr) return iErr;
      }
      if (!decomposerProvider) {
        return errorResult(
          'no auxiliary.kanban_decomposer model configured; kanban_decompose is unavailable',
          'execution_failed',
        );
      }
      const task = store.getTask(taskId);
      if (!task) return errorResult(`task not found: ${taskId}`, 'input_invalid');

      const maxChildren = Math.min(
        typeof args.max_children === 'number' ? args.max_children : DECOMPOSE_CHILDREN_DEFAULT,
        DECOMPOSE_CHILDREN_CAP,
      );
      const instructions = typeof args.instructions === 'string' ? args.instructions : undefined;

      let raw = '';
      try {
        for await (const chunk of decomposerProvider.complete(
          [{ role: 'user', content: buildDecomposePrompt(task, maxChildren, instructions) }],
          [],
          { system: DECOMPOSE_SYSTEM_PROMPT, maxTokens: 2_000, temperature: 0.2 },
        )) {
          if (chunk.type === 'text_delta') raw += chunk.text;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`auxiliary decomposer call failed: ${msg}`, 'execution_failed');
      }

      const proposed = parseDecomposeResponse(raw);
      if (!proposed) {
        return errorResult(
          'auxiliary decomposer returned an unparseable or empty response; no children created',
          'execution_failed',
        );
      }
      const children = proposed.slice(0, maxChildren);

      // Per-child creation is NOT wrapped in one transaction (contrast the
      // atomic swarm primitive elsewhere in this plan): a failure partway
      // through returns everything created so far instead of silently losing
      // it or rolling back tasks that other agents may already see.
      const created: { task_id: string; title: string }[] = [];
      let failedChild: { title: string; error: string } | undefined;
      let notAttempted: { title: string }[] = [];
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (!child) continue;
        try {
          const childTask = store.createTask({
            title: child.title,
            ...(child.body !== undefined ? { body: child.body } : {}),
            assignee: child.assignee ?? null,
            parents: [taskId],
            actor: actorOf(ctx),
          });
          created.push({ task_id: childTask.id, title: childTask.title });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          failedChild = { title: child.title, error: msg };
          notAttempted = children.slice(i + 1).map((c) => ({ title: c.title }));
          break;
        }
      }

      return jsonResult({
        task_id: taskId,
        children_created: created,
        ...(failedChild
          ? { partial_failure: true, failed_child: failedChild, not_attempted: notAttempted }
          : {}),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// kanban_list
// ---------------------------------------------------------------------------

interface ListArgs {
  assignee?: string;
  status?: TaskStatus;
  parent_id?: string;
  q?: string;
  limit?: number;
}

const LIST_DEFAULT_LIMIT = 100;
const LIST_MAX_LIMIT = 1000;

// Caps on free-text inputs. The agent is the caller; without these the LLM can
// dump arbitrary multi-MB strings into the durable store and FTS index.
const MAX_TITLE_CHARS = 500;
const MAX_BODY_CHARS = 64_000;
const MAX_COMMENT_CHARS = 16_000;
const MAX_SUMMARY_CHARS = 16_000;
const MAX_REASON_CHARS = 4_000;
const MAX_IDEMPOTENCY_KEY_CHARS = 200;
const MAX_ASSIGNEE_CHARS = 200;
const MAX_SWARM_WORKERS = 20;

function tooLong(field: string, value: string, cap: number): ToolResult | null {
  if (value.length > cap) {
    return errorResult(`${field} too long (${value.length} > ${cap} chars)`, 'input_invalid');
  }
  return null;
}

function createKanbanList(store: KanbanStore): Tool {
  return {
    name: 'kanban_list',
    description:
      `List tasks (default ${LIST_DEFAULT_LIMIT}, hard max ${LIST_MAX_LIMIT}). Filters (assignee, status, parent_id, q) AND together. q is an FTS5 query over title+body+comments.\n` +
      RULES,
    toolset: 'kanban',
    maxResultChars: MAX_RESULT_CHARS,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        assignee: { type: 'string' },
        status: { type: 'string', enum: STATUS_VALUES },
        parent_id: { type: 'string' },
        q: { type: 'string' },
        limit: {
          type: 'integer',
          description: `Max rows to return. Default ${LIST_DEFAULT_LIMIT}, capped at ${LIST_MAX_LIMIT}.`,
        },
      },
    },
    async execute(rawArgs) {
      const args = (rawArgs ?? {}) as Partial<ListArgs>;
      if (args.status !== undefined && !isStatus(args.status)) {
        return errorResult(`status must be one of ${STATUS_VALUES.join(', ')}`, 'input_invalid');
      }
      if (args.assignee !== undefined && typeof args.assignee !== 'string') {
        return errorResult('assignee must be a string', 'input_invalid');
      }
      if (args.parent_id !== undefined && typeof args.parent_id !== 'string') {
        return errorResult('parent_id must be a string', 'input_invalid');
      }
      if (args.q !== undefined) {
        if (typeof args.q !== 'string') {
          return errorResult('q must be a string', 'input_invalid');
        }
        if (args.q.length === 0) {
          return errorResult(
            'q must be non-empty (empty FTS phrase is not a useful query)',
            'input_invalid',
          );
        }
      }
      if (
        args.limit !== undefined &&
        (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1)
      ) {
        return errorResult('limit must be a positive integer', 'input_invalid');
      }
      const requestedLimit = typeof args.limit === 'number' ? args.limit : LIST_DEFAULT_LIMIT;
      const limit = Math.min(Math.max(1, requestedLimit), LIST_MAX_LIMIT);
      const tasks = store.listTasks({
        ...(args.assignee !== undefined ? { assignee: args.assignee } : {}),
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.parent_id !== undefined ? { parentId: args.parent_id } : {}),
        ...(args.q !== undefined ? { q: args.q } : {}),
        limit,
      });
      return jsonResult(tasks.map(summariseTask));
    },
  };
}

// ---------------------------------------------------------------------------
// kanban_show
// ---------------------------------------------------------------------------

function createKanbanShow(store: KanbanStore): Tool {
  return {
    name: 'kanban_show',
    description:
      'Full view of one task: comments, last 10 runs, last 20 events. Use before deciding next action on a long-lived task.\n' +
      RULES,
    toolset: 'kanban',
    maxResultChars: MAX_RESULT_CHARS,
    capabilities: {},
    schema: {
      type: 'object',
      required: ['task_id'],
      properties: { task_id: { type: 'string' } },
    },
    async execute(rawArgs) {
      const args = (rawArgs ?? {}) as { task_id?: unknown };
      if (typeof args.task_id !== 'string') {
        return errorResult('task_id must be a string', 'input_invalid');
      }
      const task = store.getTask(args.task_id);
      if (!task) return errorResult(`task not found: ${args.task_id}`, 'input_invalid');

      const allRuns = store.listRuns(task.id);
      const allEvents = store.listEvents(task.id);
      return jsonResult({
        task: fullTask(task),
        comments: store.listComments(task.id).map(shapeComment),
        runs: allRuns.slice(-10).map(shapeRun),
        events: allEvents.slice(-20).map(shapeEvent),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// kanban_update_status
// ---------------------------------------------------------------------------

function createKanbanUpdateStatus(store: KanbanStore): Tool {
  return {
    name: 'kanban_update_status',
    description:
      'Set a task to a new status. Setting status="running" auto-opens a task run; use kanban_complete / kanban_block to close it.\n' +
      RULES,
    toolset: 'kanban',
    maxResultChars: MAX_RESULT_CHARS,
    capabilities: {},
    schema: {
      type: 'object',
      required: ['task_id', 'status'],
      properties: {
        task_id: { type: 'string' },
        status: { type: 'string', enum: STATUS_VALUES },
        reason: { type: 'string' },
      },
    },
    async execute(rawArgs, ctx) {
      const args = (rawArgs ?? {}) as { task_id?: unknown; status?: unknown; reason?: unknown };
      if (typeof args.task_id !== 'string') {
        return errorResult('task_id must be a string', 'input_invalid');
      }
      if (!isStatus(args.status)) {
        return errorResult(`status must be one of ${STATUS_VALUES.join(', ')}`, 'input_invalid');
      }
      try {
        const reason = typeof args.reason === 'string' ? args.reason : undefined;
        const t = store.updateStatus(args.task_id, args.status, reason, actorOf(ctx));
        return jsonResult(fullTask(t));
      } catch (err) {
        return storeError(err);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// kanban_comment
// ---------------------------------------------------------------------------

function createKanbanComment(store: KanbanStore): Tool {
  return {
    name: 'kanban_comment',
    description: `Append a comment to a task. Append-only; edits happen by adding new comments.\n${RULES}`,
    toolset: 'kanban',
    maxResultChars: MAX_RESULT_CHARS,
    capabilities: {},
    schema: {
      type: 'object',
      required: ['task_id', 'body'],
      properties: {
        task_id: { type: 'string' },
        body: { type: 'string' },
      },
    },
    async execute(rawArgs, ctx) {
      const args = (rawArgs ?? {}) as { task_id?: unknown; body?: unknown };
      if (typeof args.task_id !== 'string') {
        return errorResult('task_id must be a string', 'input_invalid');
      }
      if (typeof args.body !== 'string' || args.body.length === 0) {
        return errorResult('body must be a non-empty string', 'input_invalid');
      }
      const bodyErr = tooLong('body', args.body, MAX_COMMENT_CHARS);
      if (bodyErr) return bodyErr;
      try {
        const c = store.addComment(args.task_id, actorOf(ctx), args.body);
        return jsonResult({ comment_id: c.id });
      } catch (err) {
        // Unknown task_id triggers a SQLite FOREIGN KEY constraint failure.
        const msg = err instanceof Error ? err.message : String(err);
        if (/FOREIGN KEY/i.test(msg)) {
          return errorResult(`task not found: ${args.task_id}`, 'input_invalid');
        }
        return storeError(err);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// kanban_complete / kanban_block / kanban_unblock
// ---------------------------------------------------------------------------

function createKanbanComplete(
  store: KanbanStore,
  hooks?: HookRegistry,
  autonomyTierOf?: AutonomyTierOf,
  personalityLookup?: PersonalityLookup,
): Tool {
  return {
    name: 'kanban_complete',
    description: `End the open run with outcome=completed, set status=done.\n${RULES}`,
    toolset: 'kanban',
    maxResultChars: MAX_RESULT_CHARS,
    capabilities: {},
    schema: {
      type: 'object',
      required: ['task_id', 'summary'],
      properties: {
        task_id: { type: 'string' },
        summary: { type: 'string' },
      },
    },
    async execute(rawArgs, ctx) {
      const args = (rawArgs ?? {}) as { task_id?: unknown; summary?: unknown };
      if (typeof args.task_id !== 'string') {
        return errorResult('task_id must be a string', 'input_invalid');
      }
      if (typeof args.summary !== 'string') {
        return errorResult('summary must be a string', 'input_invalid');
      }
      const summaryErr = tooLong('summary', args.summary, MAX_SUMMARY_CHARS);
      if (summaryErr) return summaryErr;
      const taskId = args.task_id;
      const summary = args.summary;
      try {
        // before_ticket_complete is a claiming hook: the first handler to return
        // { handled: true } rejects the running -> done transition. The architectural
        // interpretation is that the kanban_complete tool — where the transition
        // originates — fires the hook, not the supervisor process. With no hooks
        // wired (or no handler registered), fireClaiming returns { handled: false }
        // and completion proceeds: the plan's opt-in "default no-op".
        if (hooks !== undefined) {
          const task = store.getTask(taskId);
          // Guard the hook path to a running task so it acts on exactly the
          // states store.completeRun would: that path throws `no open run` for
          // a non-running task, and wiring a verifier must not widen that.
          if (task?.status !== 'running') {
            return errorResult(`no open run: ${taskId}`, 'execution_failed');
          }
          const assigneeInfo =
            task.assignee && autonomyTierOf ? autonomyTierOf(task.assignee) : undefined;
          const verdict = await hooks.fireClaiming('before_ticket_complete', {
            taskId,
            summary,
            ...(task?.acceptanceCriteria != null
              ? { acceptanceCriteria: task.acceptanceCriteria }
              : {}),
            ...(assigneeInfo ? { autonomyTier: assigneeInfo.tier } : {}),
          });
          if (verdict.handled) {
            const reason = verdict.reason ?? 'completion rejected';
            const t = store.updateStatus(taskId, 'needs_revision', reason, actorOf(ctx));
            await hooks.fireVoid('after_ticket_revision', {
              taskId,
              summary,
              ...(task?.acceptanceCriteria != null
                ? { acceptanceCriteria: task.acceptanceCriteria }
                : {}),
              reason,
              assignee: task.assignee ?? actorOf(ctx),
              ...(assigneeInfo
                ? { autonomyTier: assigneeInfo.tier, successRatio: assigneeInfo.ratio }
                : {}),
            });
            return jsonResult(fullTask(t));
          }
        }
        const actor = actorOf(ctx);
        const personalityId = ctx.personalityId;
        let completedBy: { id: string; name: string } | undefined;
        if (personalityId) {
          const info = personalityLookup?.(personalityId);
          completedBy = { id: personalityId, name: info?.name ?? personalityId };
        }
        const t = store.completeRun(taskId, summary, actor, completedBy);
        return jsonResult(fullTask(t));
      } catch (err) {
        return storeError(err);
      }
    },
  };
}

function createKanbanBlock(store: KanbanStore): Tool {
  return {
    name: 'kanban_block',
    description:
      'End the open run with outcome=blocked, set status=blocked. Reason is recorded as a comment for context. ' +
      'Optional `kind` categorizes why (dependency/needs_input/capability/transient) — repeated blocks with the ' +
      'same `kind` in a row (no successful completion in between) auto-route the task to needs_revision instead ' +
      'of looping forever.\n' +
      RULES,
    toolset: 'kanban',
    maxResultChars: MAX_RESULT_CHARS,
    capabilities: {},
    schema: {
      type: 'object',
      required: ['task_id', 'reason'],
      properties: {
        task_id: { type: 'string' },
        reason: { type: 'string' },
        kind: {
          type: 'string',
          enum: BLOCK_KINDS,
          description:
            'Why the task is blocked. "dependency" (waiting on another task — unblocking stays a manual ' +
            'kanban_unblock call, not auto-routed) does not get auto-unblocked when its parent completes.',
        },
      },
    },
    async execute(rawArgs, ctx) {
      const args = (rawArgs ?? {}) as { task_id?: unknown; reason?: unknown; kind?: unknown };
      if (typeof args.task_id !== 'string') {
        return errorResult('task_id must be a string', 'input_invalid');
      }
      if (typeof args.reason !== 'string') {
        return errorResult('reason must be a string', 'input_invalid');
      }
      const reasonErr = tooLong('reason', args.reason, MAX_REASON_CHARS);
      if (reasonErr) return reasonErr;
      if (args.kind !== undefined && !isBlockKind(args.kind)) {
        return errorResult(`kind must be one of: ${BLOCK_KINDS.join(', ')}`, 'input_invalid');
      }
      try {
        // blockRun atomically records the reason as both run.summary and a comment,
        // and (when kind is set) tracks the unblock-loop breaker.
        const t = store.blockRun(args.task_id, args.reason, actorOf(ctx), args.kind);
        return jsonResult(fullTask(t));
      } catch (err) {
        return storeError(err);
      }
    },
  };
}

function createKanbanUnblock(store: KanbanStore): Tool {
  return {
    name: 'kanban_unblock',
    description:
      'Flip a blocked task to ready (if all parents are done/archived) or todo (if any parent is still pending).\n' +
      RULES,
    toolset: 'kanban',
    maxResultChars: MAX_RESULT_CHARS,
    capabilities: {},
    schema: {
      type: 'object',
      required: ['task_id'],
      properties: { task_id: { type: 'string' } },
    },
    async execute(rawArgs, ctx) {
      const args = (rawArgs ?? {}) as { task_id?: unknown };
      if (typeof args.task_id !== 'string') {
        return errorResult('task_id must be a string', 'input_invalid');
      }
      const task = store.getTask(args.task_id);
      if (!task) return errorResult(`task not found: ${args.task_id}`, 'input_invalid');
      if (task.status !== 'blocked') {
        return errorResult(
          `task ${args.task_id} is not blocked (status=${task.status}); use kanban_update_status to change other statuses`,
          'execution_failed',
        );
      }
      // Only `done` parents satisfy a dependency. Archived means the parent was
      // soft-deleted/abandoned, not completed, so its child stays waiting.
      const parents = store.getParents(args.task_id);
      const allParentsDone = parents.every((p) => p.status === 'done');
      const next: TaskStatus = allParentsDone ? 'ready' : 'todo';
      try {
        const t = store.updateStatus(args.task_id, next, undefined, actorOf(ctx));
        return jsonResult(fullTask(t));
      } catch (err) {
        return storeError(err);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// kanban_heartbeat / kanban_link / kanban_assign / kanban_archive
// ---------------------------------------------------------------------------

function createKanbanHeartbeat(store: KanbanStore): Tool {
  return {
    name: 'kanban_heartbeat',
    description: `Bump last_heartbeat_at on the open run + write a heartbeat audit event.\n${RULES}`,
    toolset: 'kanban',
    maxResultChars: MAX_RESULT_CHARS,
    capabilities: {},
    schema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
        note: { type: 'string' },
      },
    },
    async execute(rawArgs, ctx) {
      const args = (rawArgs ?? {}) as { task_id?: unknown; note?: unknown };
      if (typeof args.task_id !== 'string') {
        return errorResult('task_id must be a string', 'input_invalid');
      }
      try {
        const note = typeof args.note === 'string' ? args.note : undefined;
        store.heartbeatRun(args.task_id, note, actorOf(ctx));
        return jsonResult({ ok: true });
      } catch (err) {
        return storeError(err);
      }
    },
  };
}

function createKanbanLink(store: KanbanStore): Tool {
  return {
    name: 'kanban_link',
    description:
      'Add a parent → child edge. Rejected with a cycle error if it would close one. Use to express "X must finish before Y".\n' +
      RULES,
    toolset: 'kanban',
    maxResultChars: MAX_RESULT_CHARS,
    capabilities: {},
    schema: {
      type: 'object',
      required: ['parent_id', 'child_id'],
      properties: {
        parent_id: { type: 'string' },
        child_id: { type: 'string' },
      },
    },
    async execute(rawArgs, ctx) {
      const args = (rawArgs ?? {}) as { parent_id?: unknown; child_id?: unknown };
      if (typeof args.parent_id !== 'string' || typeof args.child_id !== 'string') {
        return errorResult('parent_id and child_id must be strings', 'input_invalid');
      }
      try {
        store.link(args.parent_id, args.child_id, actorOf(ctx));
        return jsonResult({ ok: true });
      } catch (err) {
        return storeError(err);
      }
    },
  };
}

function createKanbanAssign(store: KanbanStore): Tool {
  return {
    name: 'kanban_assign',
    description: `Set the assignee (personality id or "human:<name>"). Pass null to unassign.\n${RULES}`,
    toolset: 'kanban',
    maxResultChars: MAX_RESULT_CHARS,
    capabilities: {},
    schema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
        assignee: { type: ['string', 'null'] },
      },
    },
    async execute(rawArgs, ctx) {
      const args = (rawArgs ?? {}) as { task_id?: unknown; assignee?: unknown };
      if (typeof args.task_id !== 'string') {
        return errorResult('task_id must be a string', 'input_invalid');
      }
      // Omitted or explicit null both mean "unassign". Anything non-string-and-non-null is invalid.
      let assignee: string | null;
      if (args.assignee === undefined || args.assignee === null) {
        assignee = null;
      } else if (typeof args.assignee === 'string') {
        assignee = args.assignee;
      } else {
        return errorResult('assignee must be a string or null (or omitted)', 'input_invalid');
      }
      try {
        const t = store.assign(args.task_id, assignee, actorOf(ctx));
        return jsonResult(fullTask(t));
      } catch (err) {
        return storeError(err);
      }
    },
  };
}

function createKanbanArchive(store: KanbanStore): Tool {
  return {
    name: 'kanban_archive',
    description:
      'Soft-delete the task by setting status=archived. The audit trail is preserved; use this instead of deletion.\n' +
      RULES,
    toolset: 'kanban',
    maxResultChars: MAX_RESULT_CHARS,
    capabilities: {},
    schema: {
      type: 'object',
      required: ['task_id'],
      properties: { task_id: { type: 'string' } },
    },
    async execute(rawArgs, ctx) {
      const args = (rawArgs ?? {}) as { task_id?: unknown };
      if (typeof args.task_id !== 'string') {
        return errorResult('task_id must be a string', 'input_invalid');
      }
      try {
        const t = store.archive(args.task_id, actorOf(ctx));
        return jsonResult(fullTask(t));
      } catch (err) {
        return storeError(err);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface AutonomyInfo {
  tier: 'probationary' | 'standard' | 'trusted';
  ratio: number;
}

export type AutonomyTierOf = (assignee: string) => AutonomyInfo | undefined;

export type PersonalityLookup = (id: string) => { name: string } | undefined;

export function createKanbanTools(opts: {
  store: KanbanStore;
  hooks?: HookRegistry;
  autonomyTierOf?: AutonomyTierOf;
  personalityLookup?: PersonalityLookup;
  /** Lane A Phase 2 — auxiliary model backing `kanban_decompose`. Absent means
   *  the tool still registers but returns a tool error when called. */
  decomposerProvider?: LLMProvider;
}): Tool[] {
  const { store, hooks } = opts;
  return [
    createKanbanCreate(store),
    createKanbanCreateGoal(store),
    createKanbanCreateSwarm(store),
    createKanbanDecompose(store, opts.decomposerProvider),
    createKanbanList(store),
    createKanbanShow(store),
    createKanbanUpdateStatus(store),
    createKanbanComment(store),
    createKanbanComplete(store, hooks, opts.autonomyTierOf, opts.personalityLookup),
    createKanbanBlock(store),
    createKanbanUnblock(store),
    createKanbanHeartbeat(store),
    createKanbanLink(store),
    createKanbanAssign(store),
    createKanbanArchive(store),
  ];
}
