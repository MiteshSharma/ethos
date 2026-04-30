import { dirname } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';
import { sanitize } from './prompt-injection-guard';
import { applySubstitutions } from './skill-compat';
import type { UniversalScanner } from './universal-scanner';

interface GetSkillArgs {
  name: string;
}

/**
 * Framework tool that loads a skill's full body on demand.
 * Registered alongside SkillsInjector so the LLM can fetch instructions
 * for any skill listed in the index without bloating the system prompt.
 *
 * Always included regardless of personality toolset (alwaysInclude: true).
 */
export class GetSkillTool implements Tool<GetSkillArgs> {
  readonly name = 'get_skill';
  readonly description =
    'Load the full instructions for a named skill. ' +
    'Skills are listed in the ## Available Skills section of the system prompt. ' +
    'Always call this before executing a skill to get the complete instructions.';
  readonly schema = {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Qualified skill name as shown in the Available Skills index, e.g. "ethos/summarize-doc".',
      },
    },
    required: ['name'],
    additionalProperties: false,
  };
  readonly alwaysInclude = true;

  constructor(private readonly scanner: UniversalScanner) {}

  async execute({ name }: GetSkillArgs, ctx: ToolContext): Promise<ToolResult> {
    const pool = await this.scanner.scan();
    const skill = pool.get(name);

    if (!skill) {
      const available = [...pool.keys()].slice(0, 8).join(', ');
      const suffix = pool.size > 8 ? ` … (${pool.size} total)` : '';
      return {
        ok: false,
        error: `Skill "${name}" not found in the available pool. Known names: ${available}${suffix}`,
        code: 'not_available',
      };
    }

    const body = applySubstitutions(skill.body, dirname(skill.filePath), ctx.sessionId);
    const content = sanitize(body.trim());
    return { ok: true, value: content || '(skill body is empty)' };
  }
}
