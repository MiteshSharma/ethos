import { assertSafeId, type Tool, type ToolResult } from '@ethosagent/types';

export interface SkillEntry {
  name: string;
  description: string;
  kind?: string;
}

/** One entry of the `.pending` review queue. Mirrors `PendingSkillRecord`. */
export interface PendingSkillSummary {
  id: string;
  name: string;
  description: string | null;
  body: string;
  proposedAt: string;
}

/**
 * The pending-queue slice of `SkillsLibrary` (`@ethosagent/skills`), declared
 * structurally so this package keeps its single `@ethosagent/types` dependency.
 * The composition root passes the real library in — these tools and the web
 * Skills/Evolver tab therefore drive the exact same methods, not a second path.
 */
export interface PendingSkillsPort {
  listPending(): Promise<PendingSkillSummary[]>;
  approvePending(id: string): Promise<void>;
  rejectPending(id: string): Promise<void>;
}

export interface SkillsToolsOptions {
  listSkills: (personalityId?: string) => SkillEntry[];
  getSkillContent: (name: string, personalityId?: string) => string | null;
  pending: PendingSkillsPort;
}

/**
 * `SkillsLibrary` validates every id it joins into a path. Mirror that guard
 * here so a bad id becomes a typed tool error instead of a thrown
 * `IdValidationError` — and so `skills_pending_view`, which reads the queue
 * rather than calling a validating library method, is guarded too.
 */
function isSafeSkillId(id: string): boolean {
  try {
    assertSafeId(id, 'skillId');
    return true;
  } catch {
    return false;
  }
}

function invalidId(id: string): ToolResult {
  return {
    ok: false,
    code: 'input_invalid',
    error: `Invalid pending skill id "${id}". Use skills_pending_list to get exact ids.`,
    field: 'id',
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createSkillsTools(opts: SkillsToolsOptions): Tool[] {
  const skillsListTool: Tool = {
    name: 'skills_list',
    description:
      'List all available skills the current personality has access to. Returns name, description, and kind for each.',
    toolset: 'skills',
    maxResultChars: 10_000,
    capabilities: {},
    schema: { type: 'object', properties: {}, required: [] },
    async execute(_, ctx): Promise<ToolResult> {
      const skills = opts.listSkills(ctx.personalityId);
      if (skills.length === 0) {
        return { ok: true, value: 'No skills available for this personality.' };
      }
      const formatted = skills
        .map((s) => `- **${s.name}**${s.kind ? ` [${s.kind}]` : ''}: ${s.description}`)
        .join('\n');
      return { ok: true, value: `${skills.length} skills available:\n\n${formatted}` };
    },
  };

  const skillViewTool: Tool = {
    name: 'skill_view',
    description:
      'View the full content of a skill by name. Use skills_list first to discover available skills.',
    toolset: 'skills',
    maxResultChars: 30_000,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the skill to view' },
      },
      required: ['name'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { name } = args as { name: string };
      if (!name) return { ok: false, error: 'name is required', code: 'input_invalid' };

      const content = opts.getSkillContent(name, ctx.personalityId);
      if (content === null) {
        return {
          ok: false,
          error: `Skill "${name}" not found or not accessible.`,
          code: 'not_available',
        };
      }
      return { ok: true, value: content };
    },
  };

  // ---------------------------------------------------------------------------
  // Pending-queue review, from chat — the same approve/reject the web Skills
  // tab drives, so the user never has to leave the conversation to triage what
  // the agent proposed.
  // ---------------------------------------------------------------------------

  const pendingListTool: Tool = {
    name: 'skills_pending_list',
    description:
      'List proposed skills waiting for the user to approve or reject. Returns id, name, description, and when each was proposed. An empty queue is a normal result, not an error.',
    toolset: 'skills',
    maxResultChars: 10_000,
    capabilities: {},
    schema: { type: 'object', properties: {}, required: [] },
    async execute(): Promise<ToolResult> {
      const items = await opts.pending.listPending();
      if (items.length === 0) {
        return { ok: true, value: 'No proposed skills are waiting for review.' };
      }
      const formatted = items
        .map(
          (p) =>
            `- **${p.name}** (id: \`${p.id}\`, proposed ${p.proposedAt})\n  ${p.description ?? 'No description.'}`,
        )
        .join('\n');
      return {
        ok: true,
        value: `${items.length} proposed skill(s) awaiting review:\n\n${formatted}\n\nUse skills_pending_view to read one in full, then skills_pending_approve or skills_pending_reject with its id.`,
      };
    },
  };

  const pendingViewTool: Tool = {
    name: 'skills_pending_view',
    description:
      'Show the full body of one proposed skill so the user can judge it before approving or rejecting. Use skills_pending_list first to get the id.',
    toolset: 'skills',
    maxResultChars: 30_000,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Id of the proposed skill, exactly as returned by skills_pending_list',
        },
      },
      required: ['id'],
    },
    async execute(args): Promise<ToolResult> {
      const { id } = args as { id: string };
      if (!id) return { ok: false, error: 'id is required', code: 'input_invalid', field: 'id' };
      if (!isSafeSkillId(id)) return invalidId(id);

      const match = (await opts.pending.listPending()).find((p) => p.id === id);
      if (!match) {
        return {
          ok: false,
          error: `No proposed skill with id "${id}" is waiting for review.`,
          code: 'not_available',
        };
      }
      const header = [
        `# ${match.name}`,
        `Id: ${match.id}`,
        `Proposed: ${match.proposedAt}`,
        ...(match.description ? [`Description: ${match.description}`] : []),
      ].join('\n');
      return { ok: true, value: `${header}\n\n---\n\n${match.body}` };
    },
  };

  const pendingApproveTool: Tool = {
    name: 'skills_pending_approve',
    description:
      'Approve one proposed skill by id, moving it out of the review queue and into the live skill library. Call this only when the user has explicitly asked for that specific skill to be approved — never on your own initiative, since you are also what proposes skills. The id is shown to the user in the confirmation prompt on surfaces that have one (web, desktop, Slack); in the CLI and TUI there is no approval prompt and this runs immediately.',
    toolset: 'skills',
    maxResultChars: 2_000,
    requiresApproval: true,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description:
            'Id of the proposed skill to approve, exactly as returned by skills_pending_list',
        },
      },
      required: ['id'],
    },
    async execute(args): Promise<ToolResult> {
      const { id } = args as { id: string };
      if (!id) return { ok: false, error: 'id is required', code: 'input_invalid', field: 'id' };
      if (!isSafeSkillId(id)) return invalidId(id);

      try {
        await opts.pending.approvePending(id);
      } catch (err) {
        return { ok: false, error: messageOf(err), code: 'not_available' };
      }
      return { ok: true, value: `Approved proposed skill "${id}". It is now a live skill.` };
    },
  };

  const pendingRejectTool: Tool = {
    name: 'skills_pending_reject',
    description:
      'Reject one proposed skill by id, discarding it from the review queue. Call this only when the user has explicitly asked for that specific skill to be rejected. The id is shown to the user in the confirmation prompt on surfaces that have one (web, desktop, Slack); in the CLI and TUI there is no approval prompt and this runs immediately.',
    toolset: 'skills',
    maxResultChars: 2_000,
    requiresApproval: true,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description:
            'Id of the proposed skill to reject, exactly as returned by skills_pending_list',
        },
      },
      required: ['id'],
    },
    async execute(args): Promise<ToolResult> {
      const { id } = args as { id: string };
      if (!id) return { ok: false, error: 'id is required', code: 'input_invalid', field: 'id' };
      if (!isSafeSkillId(id)) return invalidId(id);

      try {
        await opts.pending.rejectPending(id);
      } catch (err) {
        return { ok: false, error: messageOf(err), code: 'not_available' };
      }
      return { ok: true, value: `Rejected proposed skill "${id}". It has been discarded.` };
    },
  };

  return [
    skillsListTool,
    skillViewTool,
    pendingListTool,
    pendingViewTool,
    pendingApproveTool,
    pendingRejectTool,
  ];
}
