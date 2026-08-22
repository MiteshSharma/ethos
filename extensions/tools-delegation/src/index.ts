import { randomBytes, randomUUID } from 'node:crypto';
import {
  AgentMesh,
  appendMeshJournal,
  defaultRegistryPath,
  type MeshEntry,
} from '@ethosagent/agent-mesh';
import type { AgentLoop } from '@ethosagent/core';
import type {
  BackgroundJob,
  BackgroundJobEvent,
  JobRunnerRegistry,
  JobStore,
  Storage,
  Tool,
  ToolContext,
  ToolResult,
} from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Depth tracking — stored in ToolContext.agentId as "depth:<n>"
// ---------------------------------------------------------------------------

const MAX_SPAWN_DEPTH = 3;
const MAX_ROUTE_RETRIES = 2;

// Summary-mode result cap. Much lower than the 20k full-mode cap so the parent
// re-ingests only a bounded digest of the child's work.
const SUMMARY_RESULT_CAP = 2_000;

// Instruction appended to the child prompt in summary mode. The child is asked
// to end its final message with a `## Summary` section; the parent extracts and
// returns only that section.
const SUMMARY_INSTRUCTION =
  '\n\n---\n' +
  'When you finish, end your final message with a section:\n\n' +
  '## Summary\n' +
  '<a concise summary of what you did and the key result, under ~1500 chars>\n\n' +
  'The caller will read ONLY this Summary section.';

/**
 * Extracts the content of a `## Summary` section from the child's final text.
 * Heading match is case-tolerant and accepts any markdown heading level. The
 * section runs from the heading to the next heading (or end of text). Returns
 * `undefined` when no summary heading is present.
 */
function extractSummarySection(text: string): string | undefined {
  const lines = text.split('\n');
  const headingIdx = lines.findIndex((line) => /^#{1,6}\s+summary\s*$/i.test(line.trim()));
  if (headingIdx === -1) return undefined;
  const rest = lines.slice(headingIdx + 1);
  const nextHeadingRel = rest.findIndex((line) => /^#{1,6}\s+/.test(line.trim()));
  const sectionLines = nextHeadingRel === -1 ? rest : rest.slice(0, nextHeadingRel);
  return sectionLines.join('\n').trim();
}

/** Truncates text to `cap` chars, appending a marker while staying within `cap`. */
function capText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const marker = '\n[truncated]';
  return text.slice(0, cap - marker.length) + marker;
}

function getDepth(ctx: ToolContext): number {
  const raw = ctx.agentId ?? '';
  const match = raw.match(/^depth:(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function childAgentId(depth: number): string {
  return `depth:${depth}`;
}

/**
 * Splits a `ToolContext.origin` ("<platform>:<chatId>") on the FIRST `:` only —
 * chatIds can theoretically contain `:`. Returns `{}` when `s` is falsy or has
 * no colon.
 */
function splitFirstColon(s: string | undefined): { platform?: string; chatId?: string } {
  if (!s) return {};
  const idx = s.indexOf(':');
  if (idx === -1) return {};
  return { platform: s.slice(0, idx), chatId: s.slice(idx + 1) };
}

// ---------------------------------------------------------------------------
// Personality delegation guard
// ---------------------------------------------------------------------------

/**
 * Checks whether the caller's personality is allowed to delegate to the
 * target personality. Default policy: same-personality-only. A caller can
 * always delegate to its own personality (or omit the target, which inherits
 * the caller's personality). Cross-personality delegation is rejected.
 */
function assertCanDelegateTo(
  callerPersonality: string | undefined,
  targetPersonality: string | undefined,
): string | undefined {
  // No target specified or no caller personality → no restriction.
  if (!targetPersonality || !callerPersonality) return undefined;
  // Same personality → allowed.
  if (targetPersonality === callerPersonality) return undefined;
  // Cross-personality delegation blocked.
  return (
    `Cannot delegate to personality "${targetPersonality}": ` +
    `caller is running as "${callerPersonality}". ` +
    'Sub-agents must run under the same personality as the caller.'
  );
}

// ---------------------------------------------------------------------------
// Run a sub-agent and collect its full text output
// ---------------------------------------------------------------------------

async function runSubAgent(
  loop: AgentLoop,
  prompt: string,
  opts: {
    personalityId?: string;
    sessionKey: string;
    depth: number;
    abortSignal?: AbortSignal;
  },
): Promise<string> {
  let output = '';

  for await (const event of loop.run(prompt, {
    sessionKey: opts.sessionKey,
    personalityId: opts.personalityId,
    abortSignal: opts.abortSignal,
    agentId: childAgentId(opts.depth),
  })) {
    if (event.type === 'text_delta') output += event.text;
    if (event.type === 'error') throw new Error(event.error);
    if (event.type === 'done') break;
  }

  return output.trim();
}

// ---------------------------------------------------------------------------
// Background sub-agents — detached spawn-and-continue delegation
// ---------------------------------------------------------------------------

/**
 * Dependencies the tool layer needs to spawn and inspect background jobs.
 * Injected at wiring time; when absent the background surface degrades to
 * `not_available`. `nudge` is `executor.nudge` passed structurally so this
 * package never imports the job-runner.
 */
export interface BackgroundToolDeps {
  store: JobStore; // durable job persistence
  nudge: () => void; // executor.nudge — structural, do NOT import job-runner
  owner: string; // stamped on created jobs
  defaultMaxCostUsd: number; // used when max_cost_usd arg is omitted
  maxJobsPerRoot: number; // spawn-time concurrency cap
  maxJobsPerPersonality: number;
  staleMs: number; // for heartbeat-freshness reporting in task_status/logs
  /**
   * The bot this loop answers as. STATIC — the gateway builds one AgentLoop per
   * bot, so the key is a property of the loop, not of the turn. Without it a
   * `delegate_task` job carries a NULL `origin_bot_key` and is invisible to the
   * gateway's `botKey ∈ this.bots` ownership filter, i.e. its completion can
   * never be announced. Absent for surfaces with no bot identity (CLI, web).
   */
  originBotKey?: string;
  /**
   * Resolve the thread a live turn originated in. Per-TURN (unlike `originBotKey`),
   * so it is a lookup rather than a value: `ToolContext` carries no thread and
   * the gateway is the one component that knows `sessionKey → thread`. Absent
   * outside the gateway; a job then delivers to the channel root.
   */
  resolveOriginThreadId?: (sessionKey: string) => string | undefined;
  /**
   * Runners this deployment can execute a job on, beyond the default. Used only
   * to VALIDATE the `runner` arg at the tool boundary — the executor does its
   * own lookup. Absent means only the default runner exists here.
   */
  runners?: JobRunnerRegistry;
}

/** The runner a background job runs on when `runner` is omitted. */
const DEFAULT_RUNNER = 'ethos';

const LABEL_RE = /^[a-z0-9-]{1,32}$/;

const TERMINAL_STATUSES: ReadonlySet<BackgroundJob['status']> = new Set([
  'done',
  'failed',
  'aborted',
  'stale',
  'expired',
]);

const NOT_AVAILABLE: ToolResult = {
  ok: false,
  code: 'not_available',
  error: 'Background jobs are not enabled in this deployment',
};

// Uniform "not found" for both a missing job and a job scoped to another
// session — never leak another session's job existence.
const JOB_NOT_FOUND: ToolResult = { ok: false, code: 'input_invalid', error: 'job not found' };

/** A job is visible iff its root matches the caller's root (exact, never prefix). */
async function fetchScopedJob(
  store: JobStore,
  id: string,
  ctx: ToolContext,
): Promise<BackgroundJob | null> {
  const job = await store.get(id);
  if (!job) return null;
  if (job.rootSessionKey !== (ctx.rootSessionKey ?? ctx.sessionKey)) return null;
  return job;
}

function summarizeJob(job: BackgroundJob, staleMs: number): Record<string, unknown> {
  const now = Date.now();
  const summary: Record<string, unknown> = {
    id: job.id,
    status: job.status,
    label: job.label,
    personality: job.personalityId,
    spendUsd: job.spendUsd,
    ageMs: now - job.createdAt,
    owner: job.owner,
  };
  if (job.status === 'running') {
    const hbAge = job.heartbeatAt !== undefined ? now - job.heartbeatAt : undefined;
    summary.heartbeatAgeMs = hbAge;
    if (hbAge !== undefined && hbAge > staleMs) {
      summary.heartbeat = 'heartbeat stale — owner may be gone';
    }
  }
  return summary;
}

function compactJob(job: BackgroundJob): Record<string, unknown> {
  return {
    id: job.id,
    status: job.status,
    label: job.label,
    spendUsd: job.spendUsd,
    ageMs: Date.now() - job.createdAt,
  };
}

function relAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function formatEvent(e: BackgroundJobEvent): string {
  const p = e.payload;
  switch (e.eventType) {
    case 'queued':
      return 'queued';
    case 'claimed':
      return `claimed by ${String(p.owner ?? 'unknown')}`;
    case 'running':
      return 'started running';
    case 'tool_headline':
      return `ran ${String(p.toolName ?? '')}${p.arg ? ` — ${String(p.arg)}` : ''}`;
    case 'tool_end': {
      const verdict = p.ok === false ? `failed${p.error ? `: ${String(p.error)}` : ''}` : 'ok';
      const ms = typeof p.durationMs === 'number' ? ` in ${p.durationMs}ms` : '';
      return `${String(p.toolName ?? '')} ${verdict}${ms}`;
    }
    case 'text': {
      if (p.truncated === true) return 'output truncated — the rest is not recorded';
      // One event renders as one LINE, so the chunk is collapsed and capped
      // here. The full text stays in the store; this tool is a tail, not a
      // transcript reader.
      const collapsed = String(p.text ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      const shown = collapsed.length > 300 ? `${collapsed.slice(0, 297)}...` : collapsed;
      return `output: ${shown}`;
    }
    case 'artifact_change':
      return `${String(p.change ?? 'changed')} ${String(p.path ?? '')} (+${String(p.added ?? 0)} −${String(p.removed ?? 0)})`;
    case 'runner_log': {
      // One event renders as one LINE, same collapsing/capping convention the
      // 'text' case above uses — this row can hold up to LOG_BATCH_LINES
      // buffered lines, so it is joined and capped, not printed verbatim.
      const entries = Array.isArray(p.lines) ? (p.lines as Record<string, unknown>[]) : [];
      const rendered = entries
        .map((l) => `[${String(l.stream ?? '?')}] ${String(l.line ?? '')}`)
        .join(' | ')
        .replace(/\s+/g, ' ')
        .trim();
      const shown = rendered.length > 300 ? `${rendered.slice(0, 297)}...` : rendered;
      const droppedNote =
        typeof p.dropped === 'number' && p.dropped > 0 ? ` (+${p.dropped} dropped)` : '';
      return shown ? `log: ${shown}${droppedNote}` : 'log: (empty)';
    }
    case 'spend':
      return `spend $${String(p.spendUsd ?? p.usd ?? '')}`;
    case 'cancel_requested':
      return 'cancel requested';
    case 'recovered':
      return 'recovered (was falsely marked stale)';
    case 'done':
    case 'failed':
    case 'aborted':
    case 'stale':
    case 'expired':
      return `→ ${e.eventType}`;
    default:
      return e.eventType;
  }
}

// ---------------------------------------------------------------------------
// delegate_task — spawns a single child agent
// ---------------------------------------------------------------------------

export function createDelegateTaskTool(loop: AgentLoop, background?: BackgroundToolDeps): Tool {
  return {
    name: 'delegate_task',
    description:
      'Spawn a sub-agent to handle a specific task and return its output. ' +
      'The sub-agent runs with its own session and optionally a different personality. ' +
      'Use when a task is clearly separable and benefits from a fresh context or specialist personality. ' +
      `Maximum spawn depth: ${MAX_SPAWN_DEPTH}.`,
    toolset: 'delegation',
    maxResultChars: 20_000,
    capabilities: {
      network: { allowedHosts: ['*'] }, // agent-supplied URL — bounded by personality.network.allow
    },
    schema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The task prompt for the sub-agent to complete',
        },
        personality: {
          type: 'string',
          description:
            'Personality for the sub-agent (e.g. "researcher", "reviewer"). Defaults to current personality.',
        },
        label: {
          type: 'string',
          description: 'Optional label to identify this sub-task in the result',
        },
        return_mode: {
          type: 'string',
          enum: ['full', 'summary'],
          description:
            "How much of the sub-agent's output to return. " +
            "'full' (default) returns the complete output (≤20,000 chars). " +
            `'summary' asks the sub-agent to end with a ## Summary section and returns only that (≤${SUMMARY_RESULT_CAP} chars).`,
        },
        background: {
          type: 'boolean',
          description:
            'Run detached: returns a job id immediately instead of blocking. Poll with task_status/task_result.',
        },
        max_cost_usd: {
          type: ['number', 'null'],
          description:
            'Per-job USD spend cap; the job aborts on breach. Omit for the deployment default; pass null to explicitly run uncapped.',
        },
        runner: {
          type: 'string',
          description:
            "Which worker runs the job. Only valid with background: true. Defaults to 'ethos' (an ordinary Ethos sub-agent). " +
            'Any other name must be registered in this deployment — an unregistered name is refused, never silently downgraded.',
        },
      },
      required: ['prompt'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const rawArgs = (args ?? {}) as Record<string, unknown>;
      const {
        prompt,
        personality,
        label,
        return_mode = 'full',
        background: runInBackground,
        runner,
      } = args as {
        prompt: string;
        personality?: string;
        label?: string;
        return_mode?: 'full' | 'summary';
        background?: boolean;
        runner?: string;
      };

      // `runner` selects a background worker; there is nothing to select on the
      // blocking path. Refusing beats ignoring — a silently dropped runner runs
      // the task on a harness the caller did not ask for.
      if (runner !== undefined && runInBackground !== true) {
        return {
          ok: false,
          code: 'input_invalid',
          error: 'runner is only valid with background: true',
        };
      }

      // ---- Background (detached) path -------------------------------------
      // Same up-front validation as the blocking path, then hand off to the
      // JobStore. When background deps are not wired, degrade to not_available.
      if (runInBackground === true) {
        if (!prompt) return { ok: false, error: 'prompt is required', code: 'input_invalid' };

        // Cross-personality delegation is blocked here just like the blocking
        // path; background jobs always run as the caller's personality.
        const delegationError = assertCanDelegateTo(ctx.personalityId, personality);
        if (delegationError) {
          return { ok: false, error: delegationError, code: 'input_invalid' };
        }

        const bgDepth = getDepth(ctx);
        if (bgDepth >= MAX_SPAWN_DEPTH) {
          return {
            ok: false,
            error: `Maximum spawn depth (${MAX_SPAWN_DEPTH}) reached. Cannot delegate further.`,
            code: 'execution_failed',
          };
        }

        if (!background) return NOT_AVAILABLE;

        // Runner selection. Omitted means the default; anything else must be a
        // runner this deployment actually resolved. No silent fallback: a job
        // asked for on a harness we do not have is refused, not re-routed.
        const jobRunner = runner ?? DEFAULT_RUNNER;
        if (jobRunner !== DEFAULT_RUNNER && !background.runners?.get(jobRunner)) {
          return {
            ok: false,
            code: 'not_available',
            error: `runner '${jobRunner}' is not registered in this deployment`,
          };
        }

        // Slug-restrict the label so the derived child session key is
        // unspoofable — a label cannot smuggle a `:` segment separator.
        if (label !== undefined && !LABEL_RE.test(label)) {
          return { ok: false, code: 'input_invalid', error: 'label must match [a-z0-9-]{1,32}' };
        }
        const jobLabel = label ?? 'task';

        // Spawn-time concurrency caps.
        const root = ctx.rootSessionKey ?? ctx.sessionKey;
        if ((await background.store.countActiveByRoot(root)) >= background.maxJobsPerRoot) {
          return {
            ok: false,
            code: 'execution_failed',
            error: `too many active background jobs for this session (max ${background.maxJobsPerRoot})`,
          };
        }
        if (
          ctx.personalityId &&
          (await background.store.countActiveByPersonality(ctx.personalityId)) >=
            background.maxJobsPerPersonality
        ) {
          return {
            ok: false,
            code: 'execution_failed',
            error: `too many active background jobs for this personality (max ${background.maxJobsPerPersonality})`,
          };
        }

        // Resolve the cost cap: distinguish explicit null (uncapped opt-out)
        // from an absent arg (deployment default).
        let maxCostUsd: number | undefined;
        if ('max_cost_usd' in rawArgs && rawArgs.max_cost_usd === null) {
          maxCostUsd = undefined;
        } else if (typeof rawArgs.max_cost_usd === 'number') {
          maxCostUsd = rawArgs.max_cost_usd;
        } else {
          maxCostUsd = background.defaultMaxCostUsd;
        }

        // The store mints the job id (UUID); the child session key uses an
        // independent random suffix — the two are decoupled, which is fine.
        const childSessionKey = `${ctx.sessionKey}:job:${jobLabel}:${randomBytes(4).toString('hex')}`;

        // Resolve the origin lane so the gateway can deliver this job's
        // completion — including after a restart, where the only surviving
        // record of "where does this belong" is these four columns.
        // Platform + chat come from ctx.origin ("<platform>:<chatId>"); botKey
        // is a static property of this loop; the thread is a per-turn lookup
        // the gateway answers (ToolContext carries no thread).
        const { platform: originPlatform, chatId: originChatId } = splitFirstColon(ctx.origin);
        const originBotKey = originPlatform ? background.originBotKey : undefined;
        const originThreadId = originPlatform
          ? background.resolveOriginThreadId?.(ctx.sessionKey)
          : undefined;
        const job = await background.store.create({
          owner: background.owner,
          parentSessionKey: ctx.sessionKey,
          rootSessionKey: root,
          childSessionKey,
          ...(ctx.personalityId ? { personalityId: ctx.personalityId } : {}),
          depth: bgDepth + 1,
          label: jobLabel,
          prompt,
          runner: jobRunner,
          ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
          ...(originPlatform ? { originPlatform } : {}),
          ...(originBotKey ? { originBotKey } : {}),
          ...(originChatId ? { originChatId } : {}),
          ...(originThreadId ? { originThreadId } : {}),
        });

        background.nudge();

        return {
          ok: true,
          value: JSON.stringify({ jobId: job.id, childSessionKey, status: 'queued' }),
        };
      }

      if (!prompt) return { ok: false, error: 'prompt is required', code: 'input_invalid' };

      if (return_mode !== 'full' && return_mode !== 'summary') {
        return {
          ok: false,
          error: "return_mode must be 'full' or 'summary'",
          code: 'input_invalid',
        };
      }

      // Personality privilege escalation guard: sub-agents can only run
      // under the caller's current personality.
      const delegationError = assertCanDelegateTo(ctx.personalityId, personality);
      if (delegationError) {
        return { ok: false, error: delegationError, code: 'input_invalid' };
      }

      const depth = getDepth(ctx);
      if (depth >= MAX_SPAWN_DEPTH) {
        return {
          ok: false,
          error: `Maximum spawn depth (${MAX_SPAWN_DEPTH}) reached. Cannot delegate further.`,
          code: 'execution_failed',
        };
      }

      // The child's personality is caller-selectable, and a session's
      // personality is bound at creation and immutable thereafter (turn-setup
      // refuses a mismatch with `personality_locked`). Two same-turn fan-out
      // calls without a label would otherwise derive the identical key and the
      // second would be refused — so the RESOLVED personality is part of the
      // key. Resolved once, used for both the key and the child run, so the two
      // can never diverge. An empty segment means "no personality in play"; a
      // personality id is never empty, so it cannot alias a real one.
      const childPersonalityId = personality ?? ctx.personalityId;
      const sessionKey = `${ctx.sessionKey}:sub:${label ?? 'task'}:${childPersonalityId ?? ''}:${ctx.currentTurn}`;
      const childPrompt = return_mode === 'summary' ? prompt + SUMMARY_INSTRUCTION : prompt;

      try {
        const output = await runSubAgent(loop, childPrompt, {
          personalityId: childPersonalityId,
          sessionKey,
          depth: depth + 1,
          abortSignal: ctx.abortSignal,
        });

        const header = label ? `[${label}]\n\n` : '';
        if (return_mode === 'summary') {
          const summaryBody = extractSummarySection(output) ?? output;
          return { ok: true, value: capText(`${header}${summaryBody}`, SUMMARY_RESULT_CAP) };
        }
        return { ok: true, value: `${header}${output}` };
      } catch (err) {
        return {
          ok: false,
          error: `Sub-agent failed: ${err instanceof Error ? err.message : String(err)}`,
          code: 'execution_failed',
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// mixture_of_agents — runs N sub-agents in parallel, synthesises results
// ---------------------------------------------------------------------------

export function createMixtureOfAgentsTool(loop: AgentLoop): Tool {
  return {
    name: 'mixture_of_agents',
    description:
      'Run multiple sub-agents in parallel, each with a different prompt or personality, ' +
      'then synthesise their outputs into a final answer. ' +
      'Use for tasks that benefit from diverse perspectives or parallel research. ' +
      `Maximum ${MAX_SPAWN_DEPTH} total spawn depth. Maximum 5 agents per call.`,
    toolset: 'delegation',
    maxResultChars: 40_000,
    outputIsUntrusted: true,
    capabilities: {
      network: { allowedHosts: ['*'] }, // agent-supplied URL — bounded by personality.network.allow
    },
    schema: {
      type: 'object',
      properties: {
        agents: {
          type: 'array',
          description: 'List of sub-agents to run in parallel (max 5)',
          items: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'Task prompt for this agent' },
              personality: { type: 'string', description: 'Personality for this agent' },
              label: { type: 'string', description: 'Label to identify this agent in the result' },
            },
            required: ['prompt'],
          },
        },
        synthesis_prompt: {
          type: 'string',
          description:
            "Optional prompt to synthesise the agents' outputs into a final answer. " +
            'If omitted, outputs are concatenated with labels.',
        },
      },
      required: ['agents'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { agents, synthesis_prompt } = args as {
        agents: Array<{ prompt: string; personality?: string; label?: string }>;
        synthesis_prompt?: string;
      };

      if (!agents?.length) {
        return {
          ok: false,
          error: 'agents array is required and must not be empty',
          code: 'input_invalid',
        };
      }

      if (agents.length > 5) {
        return {
          ok: false,
          error: 'Maximum 5 agents per mixture_of_agents call',
          code: 'input_invalid',
        };
      }

      // Personality privilege escalation guard: every sub-agent must run
      // under the caller's current personality.
      for (const agent of agents) {
        const delegationError = assertCanDelegateTo(ctx.personalityId, agent.personality);
        if (delegationError) {
          return { ok: false, error: delegationError, code: 'input_invalid' };
        }
      }

      const depth = getDepth(ctx);
      if (depth >= MAX_SPAWN_DEPTH) {
        return {
          ok: false,
          error: `Maximum spawn depth (${MAX_SPAWN_DEPTH}) reached.`,
          code: 'execution_failed',
        };
      }

      // Run all agents in parallel
      const results = await Promise.allSettled(
        agents.map(async (agent, i) => {
          const label = agent.label ?? `Agent ${i + 1}`;
          const sessionKey = `${ctx.sessionKey}:moa:${label}:${ctx.currentTurn}`;
          const output = await runSubAgent(loop, agent.prompt, {
            personalityId: agent.personality ?? ctx.personalityId,
            sessionKey,
            depth: depth + 1,
            abortSignal: ctx.abortSignal,
          });
          return { label, output };
        }),
      );

      // Collect outputs
      const outputs: Array<{ label: string; output: string }> = [];
      const errors: string[] = [];

      for (const result of results) {
        if (result.status === 'fulfilled') {
          outputs.push(result.value);
        } else {
          errors.push(String(result.reason));
        }
      }

      if (outputs.length === 0) {
        return {
          ok: false,
          error: `All agents failed:\n${errors.join('\n')}`,
          code: 'execution_failed',
        };
      }

      // Format agent outputs
      const combined = outputs.map((o) => `## ${o.label}\n\n${o.output}`).join('\n\n---\n\n');

      // If synthesis prompt provided, run a final synthesis pass
      if (synthesis_prompt) {
        const synthesisInput =
          `${synthesis_prompt}\n\n` +
          `Here are the outputs from ${outputs.length} agents:\n\n${combined}`;

        const sessionKey = `${ctx.sessionKey}:moa:synthesis:${ctx.currentTurn}`;

        try {
          const synthesis = await runSubAgent(loop, synthesisInput, {
            sessionKey,
            depth: depth + 1,
            abortSignal: ctx.abortSignal,
          });

          return {
            ok: true,
            value: `## Agent Outputs\n\n${combined}\n\n---\n\n## Synthesis\n\n${synthesis}`,
          };
        } catch {
          // Synthesis failed — return raw outputs
          return { ok: true, value: combined };
        }
      }

      return { ok: true, value: combined };
    },
  };
}

// ---------------------------------------------------------------------------
// Mesh routing — HTTP JSON-RPC calls to registered peer agents
// ---------------------------------------------------------------------------

type FetchImpl = (url: string | URL, init?: RequestInit) => Promise<Response>;

async function callMeshAgent(
  host: string,
  port: number,
  prompt: string,
  personalityId: string | undefined,
  signal: AbortSignal | undefined,
  fetchImpl: FetchImpl,
): Promise<string> {
  const base = `http://${host}:${port}/rpc`;

  // Create a fresh session on the remote agent
  const sessionRes = await fetchImpl(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'new_session',
      params: personalityId ? { personalityId } : {},
    }),
    signal,
  });
  const sessionData = (await sessionRes.json()) as { result?: { sessionKey?: string } };
  const sessionKey = sessionData.result?.sessionKey ?? `acp:${Date.now()}`;

  // Send the prompt and wait for the full result
  const promptRes = await fetchImpl(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'prompt',
      params: personalityId
        ? { sessionKey, text: prompt, personalityId }
        : { sessionKey, text: prompt },
    }),
    signal,
  });
  const promptData = (await promptRes.json()) as {
    result?: { text?: string };
    error?: { message?: string };
  };
  if (promptData.error) throw new Error(promptData.error.message ?? 'Remote agent error');
  return promptData.result?.text ?? '';
}

/**
 * Spawn a DETACHED background job on a mesh peer via the `spawn` JSON-RPC method.
 * Returns the remote job id. Throws on a JSON-RPC error, a missing jobId, or a
 * transport failure — the caller decides whether to try the next candidate.
 */
async function spawnOnMeshPeer(
  host: string,
  port: number,
  prompt: string,
  personalityId: string | undefined,
  signal: AbortSignal | undefined,
  fetchImpl: FetchImpl,
): Promise<string> {
  const res = await fetchImpl(`http://${host}:${port}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'spawn',
      params: { text: prompt, ...(personalityId ? { personalityId } : {}) },
    }),
    signal,
  });
  const data = (await res.json()) as {
    result?: { jobId?: string; status?: string };
    error?: { message?: string };
  };
  if (data.error) throw new Error(data.error.message ?? 'remote spawn error');
  const jobId = data.result?.jobId;
  if (!jobId) throw new Error('remote spawn returned no jobId');
  return jobId;
}

function personalityFromAgentId(agentId: string): string {
  const idx = agentId.indexOf(':');
  return idx > 0 ? agentId.slice(0, idx) : agentId;
}

function selectCandidates(entries: MeshEntry[], capability: string): MeshEntry[] {
  return entries
    .filter((e) => e.capabilities.includes(capability))
    .sort((a, b) =>
      a.activeSessions !== b.activeSessions
        ? a.activeSessions - b.activeSessions
        : a.registeredAt - b.registeredAt,
    );
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

interface RoutedCall {
  ok: boolean;
  agent?: MeshEntry;
  text?: string;
  attempts: number;
  errors: string[];
}

async function routeWithFailover(params: {
  entries: MeshEntry[];
  capability: string;
  prompt: string;
  retries?: number;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  personalityId?: string;
  fetchImpl: FetchImpl;
}): Promise<RoutedCall> {
  const candidates = selectCandidates(params.entries, params.capability);
  if (candidates.length === 0)
    return { ok: false, attempts: 0, errors: ['no matching candidates'] };

  const maxAttempts = Math.min(candidates.length, (params.retries ?? MAX_ROUTE_RETRIES) + 1);
  const errors: string[] = [];

  for (let i = 0; i < maxAttempts; i++) {
    const agent = candidates[i];
    if (!agent) break;
    try {
      const signal = withTimeout(params.abortSignal, params.timeoutMs);
      const text = await callMeshAgent(
        agent.host,
        agent.port,
        params.prompt,
        params.personalityId,
        signal,
        params.fetchImpl,
      );
      return { ok: true, agent, text, attempts: i + 1, errors };
    } catch (err) {
      errors.push(`${agent.agentId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { ok: false, attempts: maxAttempts, errors };
}

export function createListTeamTool(storage: Storage, registryPath = defaultRegistryPath()): Tool {
  return {
    name: 'list_team',
    description:
      'List live mesh peers with personality, capabilities, and load. ' +
      'Use before dispatch planning to decide which specialist should handle each task.',
    toolset: 'delegation',
    maxResultChars: 20_000,
    capabilities: {
      network: { allowedHosts: ['*'] }, // agent-supplied URL — bounded by personality.network.allow
    },
    schema: {
      type: 'object',
      properties: {
        include_self: {
          type: 'boolean',
          description: 'Include current process in output (default false).',
        },
      },
    },
    async execute(args): Promise<ToolResult> {
      const { include_self = false } = (args ?? {}) as { include_self?: boolean };
      const mesh = new AgentMesh(registryPath, { storage });
      const peers = await mesh.list();

      const filtered = include_self ? peers : peers.filter((p) => p.pid !== process.pid);
      const roster = filtered.map((p) => ({
        agentId: p.agentId,
        personality: personalityFromAgentId(p.agentId),
        capabilities: p.capabilities,
        host: p.host,
        port: p.port,
        activeSessions: p.activeSessions,
        model: p.model,
      }));

      return { ok: true, value: JSON.stringify(roster, null, 2) };
    },
  };
}

export function createRouteToAgentTool(
  storage: Storage,
  registryPath = defaultRegistryPath(),
  background?: BackgroundToolDeps,
): Tool {
  return {
    name: 'route_to_agent',
    description:
      'Route a task to the best available mesh agent advertising a given capability. ' +
      "Agents register via `ethos serve`; routing is scoped to the caller's mesh. " +
      "Returns the remote agent's full response. " +
      'Does not fall back to local execution if no matching agent is found.',
    toolset: 'delegation',
    maxResultChars: 20_000,
    outputIsUntrusted: true,
    capabilities: {
      network: { allowedHosts: ['*'] }, // agent-supplied URL — bounded by personality.network.allow
    },
    schema: {
      type: 'object',
      properties: {
        capability: {
          type: 'string',
          description: 'Capability label to match (e.g. "code", "review", "research")',
        },
        prompt: {
          type: 'string',
          description: 'Task prompt for the remote agent',
        },
        timeout_s: {
          type: 'number',
          description: 'Per-attempt timeout in seconds (default: 60)',
        },
        retries: {
          type: 'number',
          description: 'Retry count across alternate peers (default: 2, max: 5)',
        },
        background: {
          type: 'boolean',
          description:
            'Run the remote task detached: spawn it on the peer and return a job id immediately (poll with task_status). ',
        },
      },
      required: ['capability', 'prompt'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const {
        capability,
        prompt,
        timeout_s,
        retries,
        background: runInBackground,
      } = args as {
        capability: string;
        prompt: string;
        timeout_s?: number;
        retries?: number;
        background?: boolean;
      };
      if (!capability) return { ok: false, error: 'capability is required', code: 'input_invalid' };
      if (!prompt) return { ok: false, error: 'prompt is required', code: 'input_invalid' };

      const fetchFn = ctx.scopedFetch?.fetch.bind(ctx.scopedFetch);
      if (!fetchFn)
        return {
          ok: false,
          error: 'Network capability not configured',
          code: 'not_available' as const,
        };

      const mesh = new AgentMesh(registryPath, { storage });
      const peers = await mesh.list();
      const timeoutMs = Math.max(1, timeout_s ?? 60) * 1000;

      // ---- Background (detached) path — spawn on a peer, track via a proxy row.
      if (runInBackground === true) {
        if (!background) return NOT_AVAILABLE;

        const candidates = selectCandidates(peers, capability);
        if (candidates.length === 0) {
          appendMeshJournal({
            ts: new Date().toISOString(),
            event: 'route_to_agent_bg_failed',
            capability,
            errors: ['no matching candidates'],
          });
          return {
            ok: false,
            code: 'execution_failed',
            error: `no agent available for capability: ${capability}`,
          };
        }

        const errs: string[] = [];
        for (const agent of candidates) {
          try {
            const signal = withTimeout(ctx.abortSignal, timeoutMs);
            const remoteJobId = await spawnOnMeshPeer(
              agent.host,
              agent.port,
              prompt,
              ctx.personalityId,
              signal,
              fetchFn,
            );

            // Local proxy row: unique owner → the local executor (a different
            // owner) never claims it, but the reconciler's listRunningRemote()
            // picks it up.
            const proxyOwner = `mesh-proxy:${randomUUID()}`;
            const remotePeer = `${agent.host}:${agent.port}`;
            const created = await background.store.create({
              owner: proxyOwner,
              parentSessionKey: ctx.sessionKey,
              rootSessionKey: ctx.rootSessionKey ?? ctx.sessionKey,
              childSessionKey: `${ctx.sessionKey}:mesh:${String(remoteJobId).slice(0, 8)}`,
              depth: getDepth(ctx) + 1,
              prompt,
              remotePeer,
              remoteJobId: String(remoteJobId),
              ...(ctx.personalityId ? { personalityId: ctx.personalityId } : {}),
            });
            // Transition to running so it isn't expired as a stale queued row and
            // so the reconciler picks it up. The unique owner guarantees
            // claimNextQueued grabs exactly this proxy.
            await background.store.claimNextQueued(proxyOwner);

            appendMeshJournal({
              ts: new Date().toISOString(),
              event: 'route_to_agent_bg',
              capability,
              callee: agent.agentId,
              jobId: created.id,
              remoteJobId: String(remoteJobId),
            });

            return {
              ok: true,
              value: JSON.stringify({
                jobId: created.id,
                remotePeer,
                remoteJobId: String(remoteJobId),
                status: 'running',
              }),
            };
          } catch (err) {
            errs.push(`${agent.agentId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        appendMeshJournal({
          ts: new Date().toISOString(),
          event: 'route_to_agent_bg_failed',
          capability,
          errors: errs,
        });
        return {
          ok: false,
          code: 'execution_failed',
          error: `no peer accepted the background spawn: ${errs.join('; ')}`,
        };
      }

      const retryCount = Math.min(Math.max(0, retries ?? MAX_ROUTE_RETRIES), 5);

      const routed = await routeWithFailover({
        entries: peers,
        capability,
        prompt,
        retries: retryCount,
        timeoutMs,
        abortSignal: ctx.abortSignal,
        fetchImpl: fetchFn,
      });

      if (!routed.ok || !routed.agent || routed.text === undefined) {
        appendMeshJournal({
          ts: new Date().toISOString(),
          event: 'route_to_agent_failed',
          capability,
          attempts: routed.attempts,
          errors: routed.errors,
        });
        return {
          ok: false,
          error:
            routed.errors.length > 0
              ? `no successful agent for capability: ${capability}; attempts=${routed.attempts}; ${routed.errors.join('; ')}`
              : `no agent available for capability: ${capability}`,
          code: 'execution_failed',
        };
      }

      appendMeshJournal({
        ts: new Date().toISOString(),
        event: 'route_to_agent',
        capability,
        callee: routed.agent.agentId,
        attempts: routed.attempts,
      });

      return { ok: true, value: `[${routed.agent.agentId}]\n\n${routed.text}` };
    },
  };
}

export function createDispatchTeamTool(
  storage: Storage,
  registryPath = defaultRegistryPath(),
): Tool {
  return {
    name: 'dispatch_team',
    description:
      'Dispatch multiple capability-scoped tasks across mesh peers in parallel. ' +
      'Each task picks the best available specialist and retries alternate peers on failure.',
    toolset: 'delegation',
    maxResultChars: 60_000,
    outputIsUntrusted: true,
    capabilities: {
      network: { allowedHosts: ['*'] }, // agent-supplied URL — bounded by personality.network.allow
    },
    schema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'Parallel tasks to dispatch',
          items: {
            type: 'object',
            properties: {
              capability: { type: 'string' },
              prompt: { type: 'string' },
              timeout_s: { type: 'number' },
              retries: { type: 'number' },
            },
            required: ['capability', 'prompt'],
          },
        },
      },
      required: ['tasks'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { tasks } = args as {
        tasks: Array<{ capability: string; prompt: string; timeout_s?: number; retries?: number }>;
      };
      if (!tasks || tasks.length === 0) {
        return {
          ok: false,
          error: 'tasks is required and must not be empty',
          code: 'input_invalid',
        };
      }
      if (tasks.length > 12) {
        return {
          ok: false,
          error: 'Maximum 12 tasks per dispatch_team call',
          code: 'input_invalid',
        };
      }

      const fetchFn = ctx.scopedFetch?.fetch.bind(ctx.scopedFetch);
      if (!fetchFn)
        return {
          ok: false,
          error: 'Network capability not configured',
          code: 'not_available' as const,
        };

      const mesh = new AgentMesh(registryPath, { storage });
      const peers = await mesh.list();

      const results = await Promise.all(
        tasks.map(async (task, i) => {
          const timeoutMs = Math.max(1, task.timeout_s ?? 60) * 1000;
          const retryCount = Math.min(Math.max(0, task.retries ?? MAX_ROUTE_RETRIES), 5);
          const routed = await routeWithFailover({
            entries: peers,
            capability: task.capability,
            prompt: task.prompt,
            retries: retryCount,
            timeoutMs,
            abortSignal: ctx.abortSignal,
            fetchImpl: fetchFn,
          });

          if (!routed.ok || !routed.agent || routed.text === undefined) {
            return {
              task: i,
              capability: task.capability,
              ok: false,
              attempts: routed.attempts,
              error:
                routed.errors.length > 0
                  ? routed.errors.join('; ')
                  : `no agent available for capability: ${task.capability}`,
            };
          }
          return {
            task: i,
            capability: task.capability,
            ok: true,
            attempts: routed.attempts,
            agentId: routed.agent.agentId,
            text: routed.text,
          };
        }),
      );

      appendMeshJournal({
        ts: new Date().toISOString(),
        event: 'dispatch_team',
        taskCount: tasks.length,
        okCount: results.filter((r) => r.ok).length,
        failCount: results.filter((r) => !r.ok).length,
      });

      return { ok: true, value: JSON.stringify(results, null, 2) };
    },
  };
}

export function createBroadcastToAgentsTool(
  storage: Storage,
  registryPath = defaultRegistryPath(),
): Tool {
  return {
    name: 'broadcast_to_agents',
    description:
      'Send a prompt to all live agents in the mesh and return their combined responses. ' +
      'Useful for getting multiple perspectives or running parallel reviews.',
    toolset: 'delegation',
    maxResultChars: 60_000,
    outputIsUntrusted: true,
    capabilities: {
      network: { allowedHosts: ['*'] }, // agent-supplied URL — bounded by personality.network.allow
    },
    schema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Prompt to send to every live mesh agent',
        },
      },
      required: ['prompt'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { prompt } = args as { prompt: string };
      if (!prompt) return { ok: false, error: 'prompt is required', code: 'input_invalid' };

      const fetchFn = ctx.scopedFetch?.fetch.bind(ctx.scopedFetch);
      if (!fetchFn)
        return {
          ok: false,
          error: 'Network capability not configured',
          code: 'not_available' as const,
        };

      const mesh = new AgentMesh(registryPath, { storage });
      const agents = await mesh.list();
      if (agents.length === 0) {
        return { ok: false, error: 'no live agents in mesh', code: 'execution_failed' };
      }

      const results = await Promise.allSettled(
        agents.map(async (agent) => {
          const text = await callMeshAgent(
            agent.host,
            agent.port,
            prompt,
            undefined,
            ctx.abortSignal,
            fetchFn,
          );
          return { agentId: agent.agentId, text };
        }),
      );

      const outputs: string[] = [];
      const errors: string[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') {
          outputs.push(`## ${r.value.agentId}\n\n${r.value.text}`);
        } else {
          errors.push(String(r.reason));
        }
      }

      if (outputs.length === 0) {
        return {
          ok: false,
          error: `All agents failed:\n${errors.join('\n')}`,
          code: 'execution_failed',
        };
      }

      const combined = outputs.join('\n\n---\n\n');
      const suffix =
        errors.length > 0
          ? `\n\n---\n\n*${errors.length} agent(s) failed: ${errors.join('; ')}*`
          : '';
      return { ok: true, value: combined + suffix };
    },
  };
}

// ---------------------------------------------------------------------------
// task_status / task_result / task_cancel / task_logs — background job surface
//
// Registered ALWAYS so personality toolset gating composes. When `background`
// is undefined the deployment has no background executor and every call
// degrades to `not_available`.
// ---------------------------------------------------------------------------

export function createTaskStatusTool(background?: BackgroundToolDeps): Tool {
  return {
    name: 'task_status',
    description:
      'Inspect background jobs spawned from this session. Pass an id for one job, ' +
      'or omit it to list all jobs for this session.',
    toolset: 'delegation',
    maxResultChars: 4_000,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Job id to inspect. Omit to list all jobs for this session.',
        },
      },
    },
    async execute(args, ctx): Promise<ToolResult> {
      if (!background) return NOT_AVAILABLE;
      const { id } = (args ?? {}) as { id?: string };
      if (id) {
        const job = await fetchScopedJob(background.store, id, ctx);
        if (!job) return JOB_NOT_FOUND;
        return { ok: true, value: JSON.stringify(summarizeJob(job, background.staleMs)) };
      }
      const root = ctx.rootSessionKey ?? ctx.sessionKey;
      const jobs = await background.store.listByRoot(root);
      return { ok: true, value: JSON.stringify(jobs.map(compactJob)) };
    },
  };
}

export function createTaskResultTool(background?: BackgroundToolDeps): Tool {
  return {
    name: 'task_result',
    description:
      "Fetch a background job's result. Terminal jobs return the summary (done) or error; " +
      'jobs still running return a progress line, not an error.',
    toolset: 'delegation',
    maxResultChars: 4_000,
    outputIsUntrusted: true,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Job id.' },
      },
      required: ['id'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      if (!background) return NOT_AVAILABLE;
      const { id } = (args ?? {}) as { id?: string };
      if (!id) return { ok: false, code: 'input_invalid', error: 'id is required' };
      const job = await fetchScopedJob(background.store, id, ctx);
      if (!job) return JOB_NOT_FOUND;

      if (job.status === 'done') {
        return { ok: true, value: job.summary ?? '(no summary)' };
      }
      if (TERMINAL_STATUSES.has(job.status)) {
        return { ok: true, value: job.error ?? `job ${job.status}` };
      }
      // Non-terminal is not an error — report progress.
      return {
        ok: true,
        value: `still ${job.status}; spent $${job.spendUsd.toFixed(4)} so far`,
      };
    },
  };
}

export function createTaskCancelTool(background?: BackgroundToolDeps): Tool {
  return {
    name: 'task_cancel',
    description:
      'Request cancellation of a background job. The owning executor honors it within a ' +
      'bounded window; any process may request.',
    toolset: 'delegation',
    maxResultChars: 4_000,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Job id.' },
      },
      required: ['id'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      if (!background) return NOT_AVAILABLE;
      const { id } = (args ?? {}) as { id?: string };
      if (!id) return { ok: false, code: 'input_invalid', error: 'id is required' };
      const job = await fetchScopedJob(background.store, id, ctx);
      if (!job) return JOB_NOT_FOUND;
      await background.store.requestCancel(id);
      return { ok: true, value: 'cancel requested; the job will stop shortly' };
    },
  };
}

export function createTaskLogsTool(background?: BackgroundToolDeps): Tool {
  return {
    name: 'task_logs',
    description:
      "Read a background job's recent audit events (works on running and terminal jobs).",
    toolset: 'delegation',
    maxResultChars: 8_000,
    outputIsUntrusted: true,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Job id.' },
        tail: {
          type: 'number',
          description: 'How many recent events to return (default 20, max 100).',
        },
      },
      required: ['id'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      if (!background) return NOT_AVAILABLE;
      const { id, tail } = (args ?? {}) as { id?: string; tail?: number };
      if (!id) return { ok: false, code: 'input_invalid', error: 'id is required' };
      const job = await fetchScopedJob(background.store, id, ctx);
      if (!job) return JOB_NOT_FOUND;

      const count = Math.min(Math.max(1, Math.floor(tail ?? 20)), 100);
      // The store does the tailing — reading the whole trail to throw all but
      // the last `count` rows away is the unbounded read this tool never needed.
      const events = await background.store.getEvents(id, { limit: count });
      const now = Date.now();
      const lines = events.map((e) => `${relAge(now - e.createdAt)} ${formatEvent(e)}`);
      return { ok: true, value: lines.join('\n') || '(no events)' };
    },
  };
}

export { MeshProxyReconciler, type MeshProxyReconcilerDeps } from './mesh-reconciler';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDelegationTools(
  loop: AgentLoop,
  storage: Storage,
  registryPath?: string,
  background?: BackgroundToolDeps,
): Tool[] {
  return [
    createDelegateTaskTool(loop, background),
    createMixtureOfAgentsTool(loop),
    createListTeamTool(storage, registryPath),
    createDispatchTeamTool(storage, registryPath),
    createRouteToAgentTool(storage, registryPath, background),
    createBroadcastToAgentsTool(storage, registryPath),
    createTaskStatusTool(background),
    createTaskResultTool(background),
    createTaskCancelTool(background),
    createTaskLogsTool(background),
  ];
}
