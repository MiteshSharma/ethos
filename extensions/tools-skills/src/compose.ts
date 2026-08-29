import type { Skill, Tool } from '@ethosagent/types';
import type { WiringContext } from '@ethosagent/wiring/types';
import { createSkillsTools, type PendingSkillsPort, type SkillEntry } from './index';

export interface SkillsToolsCompose {
  tools: Tool[];
}

export function compose(
  _ctx: WiringContext,
  deps: { skillPool: Map<string, Skill>; pendingSkills: PendingSkillsPort },
): SkillsToolsCompose {
  const { skillPool } = deps;
  const tools = createSkillsTools({
    pending: deps.pendingSkills,
    listSkills: (): SkillEntry[] => {
      return [...skillPool.values()].map((s) => ({
        name: s.name,
        description:
          ((s.rawFrontmatter as Record<string, unknown>)?.description as string) ??
          s.body.split('\n')[0]?.slice(0, 120) ??
          '',
        kind: s.dialect,
      }));
    },
    getSkillContent: (name: string): string | null => {
      for (const skill of skillPool.values()) {
        if (skill.name === name || skill.qualifiedName === name) return skill.body;
      }
      return null;
    },
  });
  return { tools };
}
