import type { SkillRecord, SkillsLibrary } from '@ethosagent/skills';
import { EthosError } from '@ethosagent/types';
import type { Skill } from '@ethosagent/web-contracts';

// Skills library service. Calls into @ethosagent/skills' SkillsLibrary
// directly — wire-shape mapping happens here. The pending-queue mutations
// (approve/reject) live on EvolverService per the plan's namespace split.

export interface SkillsServiceOptions {
  library: SkillsLibrary;
}

export class SkillsService {
  constructor(private readonly opts: SkillsServiceOptions) {}

  async list(): Promise<{ skills: Skill[]; pendingCount: number }> {
    const [skills, pending] = await Promise.all([
      this.opts.library.listSkills(),
      this.opts.library.listPending(),
    ]);
    return { skills: skills.map(toWire), pendingCount: pending.length };
  }

  async get(id: string): Promise<{ skill: Skill }> {
    const skill = await this.opts.library.getSkill(id);
    if (!skill) throw notFound(id);
    return { skill: toWire(skill) };
  }

  async create(input: { id: string; body: string }): Promise<{ skill: Skill }> {
    const skill = await this.opts.library.createSkill(input.id, input.body);
    return { skill: toWire(skill) };
  }

  async update(input: { id: string; body: string }): Promise<{ skill: Skill }> {
    const skill = await this.opts.library.updateSkill(input.id, input.body);
    return { skill: toWire(skill) };
  }

  async delete(id: string): Promise<void> {
    await this.opts.library.deleteSkill(id);
  }
}

function toWire(record: SkillRecord): Skill {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    frontmatter: record.frontmatter,
    body: record.body,
    modifiedAt: record.modifiedAt,
  };
}

function notFound(id: string): EthosError {
  return new EthosError({
    code: 'SKILL_NOT_FOUND',
    cause: `Skill "${id}" not found.`,
    action: 'Use skills.list to see what is currently installed.',
  });
}
