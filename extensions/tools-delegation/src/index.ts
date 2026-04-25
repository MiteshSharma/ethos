import type { AgentLoop } from '@ethosagent/core';
import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Depth tracking — stored in ToolContext.agentId as "depth:<n>"
// ---------------------------------------------------------------------------

const MAX_SPAWN_DEPTH = 3;

function getDepth(ctx: ToolContext): number {
  const raw = ctx.agentId ?? '';
  const match = raw.match(/^depth:(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function childAgentId(depth: number): string {
  return `depth:${depth}`;
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
    // Pass depth in the agentId slot so child tools can read it
    // (RunOptions doesn't expose agentId directly — we rely on the
    //  toolContext.agentId set by the registry which reads from ctx)
  })) {
    if (event.type === 'text_delta') output += event.text;
    if (event.type === 'error') throw new Error(event.error);
    if (event.type === 'done') break;
  }

  return output.trim();
}

// ---------------------------------------------------------------------------
// delegate_task — spawns a single child agent
// ---------------------------------------------------------------------------

export function createDelegateTaskTool(loop: AgentLoop): Tool {
  return {
    name: 'delegate_task',
    description:
      'Spawn a sub-agent to handle a specific task and return its output. ' +
      'The sub-agent runs with its own session and optionally a different personality. ' +
      'Use when a task is clearly separable and benefits from a fresh context or specialist personality. ' +
      `Maximum spawn depth: ${MAX_SPAWN_DEPTH}.`,
    toolset: 'delegation',
    maxResultChars: 20_000,
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
      },
      required: ['prompt'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { prompt, personality, label } = args as {
        prompt: string;
        personality?: string;
        label?: string;
      };

      if (!prompt) return { ok: false, error: 'prompt is required', code: 'input_invalid' };

      const depth = getDepth(ctx);
      if (depth >= MAX_SPAWN_DEPTH) {
        return {
          ok: false,
          error: `Maximum spawn depth (${MAX_SPAWN_DEPTH}) reached. Cannot delegate further.`,
          code: 'execution_failed',
        };
      }

      const sessionKey = `${ctx.sessionKey}:sub:${label ?? 'task'}:${ctx.currentTurn}`;

      try {
        const output = await runSubAgent(loop, prompt, {
          personalityId: personality,
          sessionKey,
          depth: depth + 1,
          abortSignal: ctx.abortSignal,
        });

        const header = label ? `[${label}]\n\n` : '';
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
            personalityId: agent.personality,
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
// Factory
// ---------------------------------------------------------------------------

export function createDelegationTools(loop: AgentLoop): Tool[] {
  return [createDelegateTaskTool(loop), createMixtureOfAgentsTool(loop)];
}
