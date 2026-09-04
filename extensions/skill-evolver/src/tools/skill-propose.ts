import { join } from 'node:path';
import type { Storage, Tool, ToolContext, ToolResult } from '@ethosagent/types';

/**
 * `targetFile` is an LLM tool argument that ends up in three places a loose
 * value would damage: the pending FILENAME (`<id>.md`), the generated
 * frontmatter (`name:` and `target_file:`, unquoted YAML), and the operator's
 * apply-command notice. A path-separator check alone let through spaces, `;`,
 * `$(…)`, quotes and newlines. Same class as `analyze.ts`'s filename guard,
 * with the extension optional because the id builder strips a trailing `.md`.
 */
const TARGET_FILE_RE = /^[a-zA-Z0-9_-]+(\.md)?$/;

interface SkillProposeArgs {
  content: string;
  reason: string;
  targetFile?: string;
}

export function createSkillProposeTool(opts: {
  storage: Storage;
  pendingDir: string;
  now?: () => number;
  onProposed?: (skillId: string) => void;
  toolset?: string;
}): Tool<SkillProposeArgs> {
  const now = opts.now ?? (() => Date.now());

  return {
    name: 'skill_propose',
    description:
      'Propose a new skill or a rewrite of an existing skill. The proposal goes to a human review queue.',
    toolset: opts.toolset ?? 'skill_evolution',
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Full markdown body of the proposed skill' },
        reason: {
          type: 'string',
          description: 'One sentence explaining why this skill is worth proposing',
        },
        targetFile: {
          type: 'string',
          description: 'Existing skill filename to rewrite. Omit for a new skill.',
        },
      },
      required: ['content', 'reason'],
    },
    async execute(args: SkillProposeArgs, _ctx: ToolContext): Promise<ToolResult> {
      if (args.targetFile && !TARGET_FILE_RE.test(args.targetFile)) {
        return {
          ok: false,
          error:
            'Invalid targetFile: use a plain skill filename (letters, digits, `_`, `-`, optional `.md`)',
          code: 'input_invalid',
        };
      }

      const ts = now();
      const suffix = Math.random().toString(36).slice(2, 8);
      const id = args.targetFile
        ? `rewrite-${args.targetFile.replace(/\.md$/, '')}-${ts}`
        : `new-${ts}-${suffix}`;
      const filename = `${id}.md`;

      const header = [
        '---',
        `name: ${id}`,
        `description: "${args.reason.replace(/["\\]/g, '\\$&').replace(/\n/g, ' ')}"`,
        'ethos:',
        '  evolution:',
        '    auto_proposed: true',
        ...(args.targetFile ? [`    target_file: ${args.targetFile}`] : []),
        '---',
        '',
      ].join('\n');

      await opts.storage.mkdir(opts.pendingDir);
      await opts.storage.write(join(opts.pendingDir, filename), header + args.content);
      opts.onProposed?.(id);
      return { ok: true, value: `Skill candidate "${id}" written to pending queue for review.` };
    },
  };
}
