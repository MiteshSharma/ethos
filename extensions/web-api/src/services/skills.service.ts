import { EthosError } from '@ethosagent/types';
import type { Skill } from '@ethosagent/web-contracts';
import type { SkillsRepository } from '../repositories/skills.repository';

// Skills library service. Composes a single repository — the file
// operations on `~/.ethos/skills/` and its `.pending/` sibling. The
// approval queue is *read* through this service (so the Library panel
// can show the pending count) but mutations on it live in EvolverService
// (`pendingApprove` / `pendingReject`) per the plan's namespace split.

export interface SkillsServiceOptions {
  repo: SkillsRepository;
}

export class SkillsService {
  constructor(private readonly opts: SkillsServiceOptions) {}

  async list(): Promise<{ skills: Skill[]; pendingCount: number }> {
    const [skills, pending] = await Promise.all([
      this.opts.repo.listSkills(),
      this.opts.repo.listPending(),
    ]);
    return { skills, pendingCount: pending.length };
  }

  async get(id: string): Promise<{ skill: Skill }> {
    const skill = await this.opts.repo.getSkill(id);
    if (!skill) throw notFound(id);
    return { skill };
  }

  async create(input: { id: string; body: string }): Promise<{ skill: Skill }> {
    const skill = await this.opts.repo.createSkill(input.id, input.body);
    return { skill };
  }

  async update(input: { id: string; body: string }): Promise<{ skill: Skill }> {
    const skill = await this.opts.repo.updateSkill(input.id, input.body);
    return { skill };
  }

  async delete(id: string): Promise<void> {
    await this.opts.repo.deleteSkill(id);
  }
}

function notFound(id: string): EthosError {
  return new EthosError({
    code: 'SKILL_NOT_FOUND',
    cause: `Skill "${id}" not found.`,
    action: 'Use skills.list to see what is currently installed.',
  });
}
